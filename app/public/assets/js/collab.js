// Real-time collaborative editing over Firestore.
//
// Each shared document is a Yjs CRDT, so concurrent edits from any number of
// people merge without conflicts. Firestore is only the transport:
//
//   rooms/{roomId}/collab/{docKey}                    { state }  compacted Yjs state
//   rooms/{roomId}/collab/{docKey}/updates/{id}       { u, by }  incremental updates
//   rooms/{roomId}/collab/{docKey}/awareness/{uid}    { a }      cursor + name + colour
//
// Yjs updates are idempotent and commutative, so applying one twice or out of
// order is harmless — that is what makes compaction and late joiners safe.

import { Y, awarenessProtocol, CodemirrorBinding } from '../vendor/collab.bundle.js';
import {
  collection, doc, addDoc, setDoc, deleteDoc, onSnapshot, query, orderBy,
  runTransaction, serverTimestamp, writeBatch, Bytes
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

const FLUSH_MS = 120;          // batch keystrokes into one Firestore write
const AWARENESS_MS = 150;      // cursor broadcast throttle
const COMPACT_AFTER = 150;     // fold update docs into the snapshot past this many

const PALETTE = ['#f87171', '#fb923c', '#facc15', '#4ade80', '#2dd4bf', '#60a5fa', '#a78bfa', '#f472b6'];

export function colorFor(uid) {
  let h = 0;
  for (const c of String(uid)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const toBytes = u8 => Bytes.fromUint8Array(u8);
const fromBytes = b => (b instanceof Bytes ? b.toUint8Array() : new Uint8Array(b));

export class FirestoreYProvider {
  constructor(db, roomId, docKey, { uid, name, readOnly = false }) {
    this.db = db;
    this.uid = uid;
    this.readOnly = readOnly;
    this.rootRef = doc(db, 'rooms', roomId, 'collab', docKey);
    this.updatesCol = collection(this.rootRef, 'updates');
    this.awarenessCol = collection(this.rootRef, 'awareness');

    this.ydoc = new Y.Doc();
    this.ytext = this.ydoc.getText('code');
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);
    this.awareness.setLocalStateField('user', { name, color: colorFor(uid), uid });

    this.pending = [];
    this.seenUpdateIds = new Set();
    this.flushTimer = null;
    this.awarenessTimer = null;
    this.compacting = false;
    this.unsubs = [];
    this.binding = null;
    this.undoManager = null;
    this.destroyed = false;
    this.listeners = new Set();

    this._onDocUpdate = (update, origin) => {
      if (origin === 'remote' || this.readOnly) return;
      this.pending.push(update);
      clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
    };
    this._onAwareness = ({ added, updated, removed }, origin) => {
      if (origin === 'remote') return;
      const mine = [...added, ...updated, ...removed].includes(this.ydoc.clientID);
      if (!mine || this.awarenessTimer) return;
      this.awarenessTimer = setTimeout(() => {
        this.awarenessTimer = null;
        this.publishAwareness();
      }, AWARENESS_MS);
    };
    this._onAwarenessChange = () => this.emit();
  }

  // Loads (or seeds) the shared state, then starts streaming updates.
  async connect(initialContent = '') {
    const rootRef = this.rootRef;
    const state = await runTransaction(this.db, async tx => {
      const snap = await tx.get(rootRef);
      if (snap.exists() && snap.data().state) return fromBytes(snap.data().state);
      // Seed inside the transaction so two people opening a fresh file at once
      // can't both insert the initial text (which would duplicate it).
      const seed = new Y.Doc();
      seed.getText('code').insert(0, initialContent || '');
      const seeded = Y.encodeStateAsUpdate(seed);
      seed.destroy();
      if (!this.readOnly) tx.set(rootRef, { state: toBytes(seeded), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      return seeded;
    });
    if (this.destroyed) return;
    Y.applyUpdate(this.ydoc, state, 'remote');

    // Someone may compact (fold updates into the snapshot and delete them)
    // between our snapshot read and our updates listener attaching; following the
    // snapshot as well guarantees those updates still reach us.
    this.unsubs.push(onSnapshot(rootRef, snap => {
      const s = snap.data()?.state;
      if (s && !snap.metadata.hasPendingWrites) Y.applyUpdate(this.ydoc, fromBytes(s), 'remote');
    }, err => console.warn('collab snapshot listener:', err.message)));

    await new Promise((resolve, reject) => {
      let first = true;
      const unsub = onSnapshot(query(this.updatesCol, orderBy('createdAt')), snap => {
        snap.docChanges().forEach(change => {
          if (change.type !== 'added') return;
          this.seenUpdateIds.add(change.doc.id);
          if (change.doc.metadata.hasPendingWrites) return; // our own write
          const u = change.doc.data().u;
          if (u) Y.applyUpdate(this.ydoc, fromBytes(u), 'remote');
        });
        if (first) { first = false; resolve(); }
        if (this.seenUpdateIds.size > COMPACT_AFTER) this.compact();
      }, err => { if (first) reject(err); else console.warn('collab updates listener:', err.message); });
      this.unsubs.push(unsub);
    });

    this.unsubs.push(onSnapshot(this.awarenessCol, snap => {
      snap.docChanges().forEach(change => {
        if (change.doc.id === this.uid) return;
        const data = change.doc.data();
        if (change.type === 'removed') {
          if (data.clientID != null) awarenessProtocol.removeAwarenessStates(this.awareness, [data.clientID], 'remote');
        } else if (data.a) {
          try { awarenessProtocol.applyAwarenessUpdate(this.awareness, fromBytes(data.a), 'remote'); } catch { }
        }
      });
    }, err => console.warn('collab awareness listener:', err.message)));

    this.ydoc.on('update', this._onDocUpdate);
    this.awareness.on('update', this._onAwareness);
    this.awareness.on('change', this._onAwarenessChange);
    this.publishAwareness();
  }

  async flush() {
    clearTimeout(this.flushTimer);
    if (!this.pending.length || this.readOnly) return;
    const merged = Y.mergeUpdates(this.pending);
    this.pending = [];
    try {
      await addDoc(this.updatesCol, { u: toBytes(merged), by: this.uid, createdAt: serverTimestamp() });
    } catch (err) {
      // Put it back so the next flush retries; Yjs makes re-sending safe.
      this.pending.unshift(merged);
      console.warn('collab flush failed:', err.message);
    }
  }

  publishAwareness() {
    if (this.destroyed) return;
    const a = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.ydoc.clientID]);
    setDoc(doc(this.awarenessCol, this.uid), {
      a: toBytes(a), clientID: this.ydoc.clientID, updatedAt: serverTimestamp()
    }).catch(err => console.warn('awareness publish failed:', err.message));
  }

  // Folds seen update docs into the snapshot and deletes them. The merge runs in
  // a transaction against the stored snapshot, so concurrent compactions can't
  // drop each other's updates.
  async compact() {
    if (this.compacting || this.readOnly || this.destroyed) return;
    this.compacting = true;
    const ids = [...this.seenUpdateIds];
    try {
      const mine = Y.encodeStateAsUpdate(this.ydoc);
      const rootRef = this.rootRef;
      await runTransaction(this.db, async tx => {
        const snap = await tx.get(rootRef);
        const parts = [mine];
        if (snap.exists() && snap.data().state) parts.push(fromBytes(snap.data().state));
        tx.set(rootRef, { state: toBytes(Y.mergeUpdates(parts)), updatedAt: serverTimestamp() }, { merge: true });
      });
      for (let i = 0; i < ids.length; i += 400) {
        const batch = writeBatch(this.db);
        ids.slice(i, i + 400).forEach(id => batch.delete(doc(this.updatesCol, id)));
        await batch.commit();
      }
      ids.forEach(id => this.seenUpdateIds.delete(id));
    } catch (err) {
      console.warn('collab compaction skipped:', err.message);
    } finally {
      this.compacting = false;
    }
  }

  bind(cm) {
    this.cm = cm;
    this.undoManager = new Y.UndoManager(this.ytext);
    const before = cm.state.keyMaps.length;
    this.binding = new CodemirrorBinding(this.ytext, cm, this.awareness, { yUndoManager: this.undoManager });
    // The binding installs an undo/redo keymap it never removes; remember it so
    // switching files doesn't leave Ctrl+Z wired to a destroyed undo manager.
    this.keyMap = cm.state.keyMaps.length > before ? cm.state.keyMaps[0] : null;
    return this.binding;
  }

  unbind() {
    if (!this.binding) return;
    // Remote carets/selections are editor marks; clear them with the binding.
    this.binding._cursors?.forEach(({ caret, sel }) => { caret?.clear(); sel.forEach(m => m.clear()); });
    this.binding.destroy();
    if (this.keyMap) this.cm.removeKeyMap(this.keyMap);
    this.binding = null;
    this.keyMap = null;
  }

  getText() { return this.ytext.toString(); }

  // Replaces the whole document (e.g. "reset to committed version").
  replaceText(text) {
    this.ydoc.transact(() => {
      this.ytext.delete(0, this.ytext.length);
      this.ytext.insert(0, text);
    });
  }

  // Other people currently in this document.
  peers() {
    const out = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.ydoc.clientID || !state.user) return;
      out.push({ clientId, ...state.user });
    });
    return out;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach(fn => { try { fn(this); } catch { } }); }

  async destroy() {
    if (this.destroyed) return;
    await this.flush();
    this.destroyed = true;
    clearTimeout(this.awarenessTimer);
    this.unsubs.forEach(u => u());
    this.unsubs = [];
    this.unbind();
    this.undoManager?.destroy();
    this.ydoc.off('update', this._onDocUpdate);
    this.awareness.off('update', this._onAwareness);
    this.awareness.off('change', this._onAwarenessChange);
    this.awareness.destroy();
    this.ydoc.destroy();
    this.listeners.clear();
    deleteDoc(doc(this.awarenessCol, this.uid)).catch(() => { });
  }
}
