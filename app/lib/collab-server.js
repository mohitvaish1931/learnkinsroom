// Server-side edits to a live (Yjs) document, so changes made outside the
// editor — e.g. a GitHub import — show up in every open editor immediately.

const Y = require('yjs');

/**
 * Replaces the text of the collab document at `collabRef`
 * (rooms/{roomId}/collab/{docKey}) by appending one Yjs update.
 * Returns false when there is no live document yet (it will be seeded from the
 * committed file on next open) or the text is already identical.
 */
async function replaceLiveText(collabRef, text, serverTimestamp) {
  const root = await collabRef.get();
  if (!root.exists || !root.data().state) return false;

  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, new Uint8Array(root.data().state));
    const updates = await collabRef.collection('updates').get();
    updates.docs.forEach(d => {
      const u = d.data().u;
      if (u) Y.applyUpdate(ydoc, new Uint8Array(u));
    });

    const ytext = ydoc.getText('code');
    if (ytext.toString() === text) return false;

    const before = Y.encodeStateVector(ydoc);
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, text);
    });
    const update = Y.encodeStateAsUpdate(ydoc, before);
    await collabRef.collection('updates').add({ u: Buffer.from(update), by: 'server', createdAt: serverTimestamp() });
    return true;
  } finally {
    ydoc.destroy();
  }
}

module.exports = { replaceLiveText };
