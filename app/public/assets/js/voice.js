// Room voice chat: a WebRTC audio mesh with Firestore as the signalling channel.
//
//   rooms/{roomId}/voice/{uid}          participant: { name, photo, session, muted, heartbeat }
//   rooms/{roomId}/voiceSignals/{id}    { from, to, fromSession, toSession, kind, payload }
//
// Every pair of participants holds one RTCPeerConnection and negotiates with the
// "perfect negotiation" pattern, so it doesn't matter who connects first. A
// mesh suits small teams (roughly up to 6–8 people); set TURN_* on the server
// for users behind strict NATs.

import {
  collection, doc, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot, query, where, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

const HEARTBEAT_MS = 10000;
const STALE_MS = 35000;
const CANDIDATE_BATCH_MS = 150;

const newSession = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

export class VoiceRoom {
  constructor({ db, roomId, user, iceServers, onChange = () => { }, onError = () => { } }) {
    this.db = db;
    this.roomId = roomId;
    this.user = user;
    this.iceServers = iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
    this.onChange = onChange;
    this.onError = onError;

    this.voiceCol = collection(db, 'rooms', roomId, 'voice');
    this.signalCol = collection(db, 'rooms', roomId, 'voiceSignals');

    this.joined = false;
    this.muted = false;
    this.deafened = false;
    this.session = null;
    this.localStream = null;
    this.participants = new Map(); // uid -> participant doc
    this.peers = new Map();        // uid -> peer state
    this.speaking = new Set();
    this.screenStream = null;      // our own screen share, if any
    this.unsubs = [];
    this.heartbeat = null;
    this.audioCtx = null;
    this.meterTimer = null;
    this.meters = new Map();       // uid -> analyser
  }

  get state() {
    const now = Date.now();
    const list = [...this.participants.values()]
      .filter(p => p.uid === this.user.uid || now - p.lastSeen < STALE_MS)
      .map(p => ({
        ...p,
        speaking: this.speaking.has(p.uid),
        screen: p.uid === this.user.uid ? this.screenStream : (p.sharing ? this.peers.get(p.uid)?.screen || null : null),
        connection: p.uid === this.user.uid ? 'self' : (this.peers.get(p.uid)?.pc.connectionState || 'new')
      }));
    return { joined: this.joined, muted: this.muted, deafened: this.deafened, sharing: Boolean(this.screenStream), participants: list };
  }

  emit() { try { this.onChange(this.state); } catch { } }

  // Watch who's in voice even before joining, so the sidebar can show it.
  watch() {
    if (this.watchUnsub) return;
    this.watchUnsub = onSnapshot(this.voiceCol, snap => {
      const seen = new Set();
      snap.docs.forEach(d => {
        const data = d.data();
        seen.add(d.id);
        const hb = data.heartbeat?.toMillis ? data.heartbeat.toMillis() : null;
        const prev = this.participants.get(d.id);
        // Measure freshness by when *we* saw the heartbeat move, so clock skew
        // between this machine and the server doesn't matter. A participant seen
        // for the first time is judged by its server timestamp.
        const lastSeen = !prev ? Math.min(Date.now(), hb ?? Date.now())
          : (hb !== prev.hb ? Date.now() : prev.lastSeen);
        this.participants.set(d.id, { uid: d.id, ...data, hb, lastSeen });
      });
      [...this.participants.keys()].forEach(uid => { if (!seen.has(uid)) this.participants.delete(uid); });
      if (this.joined) this.reconcilePeers();
      this.emit();
    }, err => this.onError(err));
  }

  async join() {
    if (this.joined) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not support microphone access');
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    this.session = newSession();
    this.joined = true;
    this.muted = false;
    this.watch();

    await setDoc(doc(this.voiceCol, this.user.uid), {
      name: this.user.name,
      photo: this.user.photo || '',
      session: this.session,
      muted: false,
      sharing: false,
      joinedAt: serverTimestamp(),
      heartbeat: serverTimestamp()
    });

    this.heartbeat = setInterval(() => {
      updateDoc(doc(this.voiceCol, this.user.uid), { heartbeat: serverTimestamp() }).catch(() => { });
      this.reconcilePeers();
      this.emit();
    }, HEARTBEAT_MS);

    this.unsubs.push(onSnapshot(
      query(this.signalCol, where('to', '==', this.user.uid)),
      snap => {
        const fresh = snap.docChanges()
          .filter(c => c.type === 'added')
          .map(c => ({ id: c.doc.id, ref: c.doc.ref, ...c.doc.data() }))
          .sort((a, b) => (a.ts || 0) - (b.ts || 0) || (a.seq || 0) - (b.seq || 0));
        fresh.forEach(sig => {
          deleteDoc(sig.ref).catch(() => { });
          if (sig.toSession === this.session) this.handleSignal(sig).catch(err => console.warn('voice signal:', err));
        });
      },
      err => this.onError(err)
    ));

    this.startMeters();
    this.addMeter(this.user.uid, this.localStream);
    this.reconcilePeers();
    this.emit();

    this._unload = () => this.leave();
    window.addEventListener('pagehide', this._unload);
  }

  async leave() {
    if (!this.joined) return;
    this.joined = false;
    this.stopScreenShare({ silent: true });
    clearInterval(this.heartbeat);
    this.unsubs.forEach(u => u());
    this.unsubs = [];
    this.peers.forEach((_, uid) => this.closePeer(uid));
    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;
    this.stopMeters();
    window.removeEventListener('pagehide', this._unload);
    await deleteDoc(doc(this.voiceCol, this.user.uid)).catch(() => { });
    this.emit();
  }

  destroy() {
    this.leave();
    this.watchUnsub?.();
    this.watchUnsub = null;
  }

  toggleMute() {
    if (!this.joined) return;
    this.muted = !this.muted;
    this.localStream?.getAudioTracks().forEach(t => { t.enabled = !this.muted; });
    updateDoc(doc(this.voiceCol, this.user.uid), { muted: this.muted }).catch(() => { });
    this.emit();
  }

  toggleDeafen() {
    if (!this.joined) return;
    this.deafened = !this.deafened;
    this.peers.forEach(p => { p.audio.muted = this.deafened; });
    this.emit();
  }

  // ── screen sharing ────────────────────────────
  // The screen is an extra video track on the existing connections; adding or
  // removing it triggers renegotiation through the same perfect-negotiation path.
  async startScreenShare() {
    if (!this.joined || this.screenStream) return;
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen sharing is not supported in this browser');
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    const track = stream.getVideoTracks()[0];
    // The picker is async: the user may have left the call (or started another share) meanwhile.
    if (!track || !this.joined || this.screenStream) { stream.getTracks().forEach(t => t.stop()); return; }
    track.contentHint = 'detail'; // favour sharp text (code) over smooth motion
    track.onended = () => this.stopScreenShare(); // browser's own "Stop sharing" button
    this.screenStream = stream;
    this.peers.forEach(peer => { peer.screenSender = peer.pc.addTrack(track, stream); });
    updateDoc(doc(this.voiceCol, this.user.uid), { sharing: true }).catch(() => { });
    this.emit();
  }

  stopScreenShare({ silent = false } = {}) {
    if (!this.screenStream) return;
    const stream = this.screenStream;
    this.screenStream = null;
    this.peers.forEach(peer => {
      if (peer.screenSender && peer.pc.signalingState !== 'closed') {
        try { peer.pc.removeTrack(peer.screenSender); } catch { }
      }
      peer.screenSender = null;
    });
    stream.getTracks().forEach(t => t.stop());
    if (!silent) updateDoc(doc(this.voiceCol, this.user.uid), { sharing: false }).catch(() => { });
    this.emit();
  }

  // Opens connections to fresh participants and drops ones that left or rejoined.
  reconcilePeers() {
    if (!this.joined) return;
    const now = Date.now();
    this.participants.forEach((p, uid) => {
      if (uid === this.user.uid) return;
      const fresh = now - p.lastSeen < STALE_MS;
      const peer = this.peers.get(uid);
      if (!fresh) { if (peer) this.closePeer(uid); return; }
      if (peer && peer.remoteSession !== p.session) this.closePeer(uid);
      if (!this.peers.has(uid)) this.createPeer(uid, p.session);
    });
    this.peers.forEach((_, uid) => { if (!this.participants.has(uid)) this.closePeer(uid); });
  }

  createPeer(uid, remoteSession) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const audio = new Audio();
    audio.autoplay = true;
    audio.muted = this.deafened;

    const peer = {
      pc, audio, remoteSession,
      polite: this.user.uid > uid,     // deterministic tie-break for offer glare
      makingOffer: false,
      ignoreOffer: false,
      pendingCandidates: [],
      screen: null,
      screenSender: null,
      outCandidates: [],
      candidateTimer: null,
      seq: 0
    };
    this.peers.set(uid, peer);

    this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));
    const screenTrack = this.screenStream?.getVideoTracks()[0];
    if (screenTrack) peer.screenSender = pc.addTrack(screenTrack, this.screenStream);

    pc.ontrack = ({ track, streams }) => {
      if (track.kind === 'video') {
        const stream = streams[0] || new MediaStream([track]);
        peer.screen = stream;
        const clear = () => { if (peer.screen === stream) { peer.screen = null; this.emit(); } };
        stream.onremovetrack = clear;
        track.onended = clear;
        this.emit();
        return;
      }
      const stream = streams[0];
      if (!stream || audio.srcObject === stream) return;
      audio.srcObject = stream;
      audio.play().catch(() => { });
      this.addMeter(uid, stream);
    };

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      peer.outCandidates.push(candidate.toJSON());
      if (!peer.candidateTimer) {
        peer.candidateTimer = setTimeout(() => {
          const batch = peer.outCandidates.splice(0);
          peer.candidateTimer = null;
          this.send(uid, 'candidates', batch);
        }, CANDIDATE_BATCH_MS);
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        await this.send(uid, 'description', pc.localDescription.toJSON());
      } catch (err) {
        console.warn('voice negotiation:', err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
      this.emit();
    };

    return peer;
  }

  closePeer(uid) {
    const peer = this.peers.get(uid);
    if (!peer) return;
    clearTimeout(peer.candidateTimer);
    peer.pc.close();
    peer.audio.srcObject = null;
    this.peers.delete(uid);
    this.removeMeter(uid);
  }

  async send(to, kind, payload) {
    const peer = this.peers.get(to);
    if (!peer) return;
    await addDoc(this.signalCol, {
      from: this.user.uid,
      to,
      fromSession: this.session,
      toSession: peer.remoteSession,
      kind,
      payload: JSON.stringify(payload),
      ts: Date.now(),
      seq: peer.seq++,
      createdAt: serverTimestamp()
    }).catch(err => console.warn('voice send:', err.message));
  }

  async handleSignal(sig) {
    let peer = this.peers.get(sig.from);
    const known = this.participants.get(sig.from);
    // A signal can beat the participant snapshot; trust its session in that case.
    if (!peer || peer.remoteSession !== sig.fromSession) {
      if (known && known.session !== sig.fromSession) return; // from an old session
      if (peer) this.closePeer(sig.from);
      peer = this.createPeer(sig.from, sig.fromSession);
    }
    const { pc } = peer;
    const payload = JSON.parse(sig.payload);

    if (sig.kind === 'description') {
      const offerCollision = payload.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(payload);
      for (const c of peer.pendingCandidates.splice(0)) await pc.addIceCandidate(c).catch(() => { });
      if (payload.type === 'offer') {
        await pc.setLocalDescription();
        await this.send(sig.from, 'description', pc.localDescription.toJSON());
      }
    } else if (sig.kind === 'candidates') {
      for (const c of payload) {
        if (!pc.remoteDescription) { peer.pendingCandidates.push(c); continue; }
        try { await pc.addIceCandidate(c); } catch (err) { if (!peer.ignoreOffer) console.warn('ice:', err.message); }
      }
    }
  }

  // ── speaking indicators ───────────────────────
  startMeters() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.audioCtx = new Ctx();
    const buf = new Uint8Array(256);
    this.meterTimer = setInterval(() => {
      let changed = false;
      this.meters.forEach((analyser, uid) => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
        const level = Math.sqrt(sum / buf.length);
        const muted = uid === this.user.uid ? this.muted : this.participants.get(uid)?.muted;
        const talking = level > 0.04 && !muted;
        if (talking !== this.speaking.has(uid)) {
          talking ? this.speaking.add(uid) : this.speaking.delete(uid);
          changed = true;
        }
      });
      if (changed) this.emit();
    }, 120);
  }

  addMeter(uid, stream) {
    if (!this.audioCtx) return;
    try {
      this.removeMeter(uid);
      const src = this.audioCtx.createMediaStreamSource(stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      this.meters.set(uid, analyser);
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => { });
    } catch { }
  }

  removeMeter(uid) {
    this.meters.delete(uid);
    this.speaking.delete(uid);
  }

  stopMeters() {
    clearInterval(this.meterTimer);
    this.meters.clear();
    this.speaking.clear();
    this.audioCtx?.close().catch(() => { });
    this.audioCtx = null;
  }
}
