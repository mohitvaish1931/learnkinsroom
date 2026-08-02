try {
  require('dotenv').config();
} catch (err) {
  console.warn('dotenv not found, skipping .env load.');
}

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { GoogleGenAI } = require('@google/genai');
const { marked } = require('marked');
const nodemailer = require('nodemailer');

const mailer = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: parseInt(process.env.MAIL_PORT) || 587,
  secure: process.env.MAIL_SECURE === 'true',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

const app = express();
const genai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

marked.setOptions({ breaks: true, gfm: true });

const localUsers = new Map();
const localRooms = new Map();
const localMessages = new Map();
let localRoomCounter = 1;

function getLocalUser(user) {
  const uid = user?.uid || 'local-user';
  if (!localUsers.has(uid)) {
    localUsers.set(uid, {
      uid,
      displayName: user?.name || user?.displayName || 'Learnkins Room Guest',
      photoURL: user?.picture || user?.photoURL || '',
      email: user?.email || 'guest@learnkinsroom.local',
      rooms: []
    });
  }
  return localUsers.get(uid);
}

function serializeRoom(room) {
  return { id: room.id, ...room };
}

function createLocalRoom({ name, description, githubRepo, createdBy }) {
  const roomId = `local-room-${localRoomCounter++}`;
  const room = {
    id: roomId,
    name: name || 'Learnkins Room',
    description: description || '',
    githubRepo: githubRepo || '',
    inviteCode: Math.random().toString(36).substring(2, 8).toUpperCase(),
    createdBy,
    createdAt: new Date().toISOString(),
    members: {
      [createdBy]: {
        role: 'admin',
        displayName: localUsers.get(createdBy)?.displayName || 'Learnkins Room Guest',
        photoURL: localUsers.get(createdBy)?.photoURL || '',
        joinedAt: new Date().toISOString()
      }
    }
  };
  localRooms.set(roomId, room);
  localMessages.set(roomId, []);
  return room;
}

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, './public')));

let db = null;
let bucket = null;
let firebaseReady = false;

const serviceAccountPath = path.join(__dirname, './service-account.json');
let serviceAccount = null;

if (fs.existsSync(serviceAccountPath)) {
  try {
    serviceAccount = require(serviceAccountPath);
  } catch (err) {
    console.warn('Could not load service-account.json:', err.message);
  }
}

function normalizePrivateKey(value) {
  if (!value) return '';

  let normalized = value.trim();

  if ((normalized.startsWith('"') && normalized.endsWith('"')) || (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1).trim();
  }

  normalized = normalized
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');

  return normalized;
}

function getFirebaseCertConfig() {
  const envPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
  const envClientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const envProjectId = process.env.FIREBASE_PROJECT_ID;
  const hasEnvCredentials = envPrivateKey && envClientEmail && envProjectId;

  if (serviceAccount && serviceAccount.private_key) {
    return {
      ...serviceAccount,
      client_email: envClientEmail || serviceAccount.client_email,
      project_id: envProjectId || serviceAccount.project_id,
      private_key: normalizePrivateKey(envPrivateKey && /BEGIN PRIVATE KEY/.test(envPrivateKey)
        ? envPrivateKey
        : serviceAccount.private_key)
    };
  }

  if (hasEnvCredentials) {
    return {
      type: 'service_account',
      project_id: envProjectId,
      client_email: envClientEmail,
      private_key: normalizePrivateKey(envPrivateKey)
    };
  }

  return null;
}

if (!admin.apps.length) {
  try {
    const firebaseCert = getFirebaseCertConfig();
    if (firebaseCert) {
      admin.initializeApp({
        credential: admin.credential.cert(firebaseCert),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_PROJECT_ID + '.appspot.com'
      });
      db = admin.firestore();
      bucket = admin.storage().bucket();
      firebaseReady = true;
    }
  } catch (err) {
    console.warn('Firebase Admin initialization failed. Continuing in local compatibility mode:', err.message);
  }
}

if (!firebaseReady) {
  console.warn('Firebase Admin is not configured. API routes that need Firestore will return a 503 response until credentials are added.');
}

app.use('/api', (req, res, next) => {
  if (req.path === '/config' || req.path === '/health') return next();
  if (!firebaseReady && !['/ai/chat', '/ai/private/stream', '/ai/private', '/ai/snippet-verdict'].includes(req.path)) {
    if (req.headers.authorization?.startsWith('Bearer local-')) return next();
    return res.status(503).json({
      error: 'Local compatibility mode: Firebase is not configured. Add credentials to enable full backend functionality.'
    });
  }
  next();
});

const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized — no token' });
  if (token.startsWith('local-')) {
    req.user = getLocalUser({ uid: 'local-user', name: 'Learnkins Room Guest', email: 'guest@learnkinsroom.local' });
    return next();
  }
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized — invalid token' });
  }
};

const optionalAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (token) {
    if (token.startsWith('local-')) {
      req.user = getLocalUser({ uid: 'local-user', name: 'Learnkins Room Guest', email: 'guest@learnkinsroom.local' });
    } else {
      try { req.user = await admin.auth().verifyIdToken(token); } catch { }
    }
  }
  next();
};

function genInviteCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function sendPREmail({ adminEmail, adminName, submitterName, fileName, type, roomName, prId, roomId }) {
  const actionLabel = type === 'create' ? 'New file' : 'Edit to existing file';
  const reviewUrl = `${process.env.APP_URL}/chat/?room=${roomId}`;

  const html = `
    <div style="font-family:monospace;max-width:520px;margin:0 auto;background:#0f0f14;color:#e2e8f0;padding:32px;border-radius:12px;">
      <h2 style="color:#a78bfa;margin-top:0;">New Pull Request — ${roomName}</h2>
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:8px 0;color:#94a3b8;width:140px;">Submitted by</td>
          <td style="padding:8px 0;">${submitterName}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#94a3b8;">File</td>
          <td style="padding:8px 0;">${fileName}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#94a3b8;">Type</td>
          <td style="padding:8px 0;">${actionLabel}</td>
        </tr>
      </table>
      <a href="${reviewUrl}"
         style="display:inline-block;margin-top:24px;padding:10px 20px;
                background:#7c3aed;color:#fff;text-decoration:none;
                border-radius:8px;font-size:14px;">
        Review in Learnkins Room
      </a>
      <p style="margin-top:24px;font-size:12px;color:#475569;">
        You are receiving this because you are an admin of "${roomName}".
      </p>
    </div>`;

  await mailer.sendMail({
    from: process.env.MAIL_FROM,
    to: adminEmail,
    subject: `[Learnkins Room] New PR from ${submitterName} — ${fileName}`,
    html
  });
}

async function notifyAdmins({ roomId, submitterName, fileName, type, prId }) {
  const roomSnap = await db.collection('rooms').doc(roomId).get();
  const roomData = roomSnap.data();
  const adminUids = Object.entries(roomData.members || {})
    .filter(([_, m]) => m.role === 'admin').map(([uid]) => uid);
  const adminSnaps = await Promise.all(
    adminUids.map(uid => db.collection('users').doc(uid).get())
  );
  await Promise.all(
    adminSnaps
      .filter(s => s.exists && s.data().email)
      .map(s => sendPREmail({
        adminEmail: s.data().email,
        adminName: s.data().displayName || '',
        submitterName,
        fileName,
        type,
        roomName: roomData.name,
        prId,
        roomId
      }))
  );
}

// ── CONFIG ────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', firebaseReady, geminiReady: Boolean(genai), port: process.env.PORT || 3000 });
});

app.get('/api/config', (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY || 'demo-api-key',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'learnkins-room.firebaseapp.com',
    projectId: process.env.FIREBASE_PROJECT_ID || 'learnkins-room-local',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'learnkins-room-local.appspot.com',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '000000000000',
    appId: process.env.FIREBASE_APP_ID || '1:000000000000:web:demo',
    localMode: !firebaseReady
  });
});

// ── AUTH ──────────────────────────────────────────
app.get('/api/auth/me', verifyToken, async (req, res) => {
  try {
    if (!firebaseReady) {
      const profile = getLocalUser(req.user);
      return res.json({ uid: profile.uid, ...profile });
    }
    const snap = await db.collection('users').doc(req.user.uid).get();
    if (!snap.exists) return res.status(404).json({ error: 'User not found' });
    res.json({ uid: req.user.uid, ...snap.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/profile', verifyToken, async (req, res) => {
  try {
    const { displayName, photoURL, email } = req.body;
    if (!firebaseReady) {
      const profile = getLocalUser(req.user);
      profile.displayName = displayName || req.user.name || profile.displayName;
      profile.photoURL = photoURL || req.user.picture || profile.photoURL;
      profile.email = email || req.user.email || profile.email;
      return res.json({ success: true });
    }
    await db.collection('users').doc(req.user.uid).set({
      uid: req.user.uid,
      displayName: displayName || req.user.name || '',
      photoURL: photoURL || req.user.picture || '',
      email: email || req.user.email || '',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ROOMS ─────────────────────────────────────────
app.post('/api/rooms/create', verifyToken, async (req, res) => {
  try {
    const { name, description, githubRepo } = req.body;
    if (!name) return res.status(400).json({ error: 'Room name is required' });

    if (!firebaseReady) {
      const room = createLocalRoom({ name, description, githubRepo, createdBy: req.user.uid });
      const profile = getLocalUser(req.user);
      profile.rooms = profile.rooms.includes(room.id) ? profile.rooms : [...profile.rooms, room.id];
      return res.json({ roomId: room.id, inviteCode: room.inviteCode });
    }

    const inviteCode = genInviteCode();
    const roomRef = db.collection('rooms').doc();

    await roomRef.set({
      id: roomRef.id,
      name,
      description: description || '',
      githubRepo: githubRepo || '',
      inviteCode,
      createdBy: req.user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      members: {
        [req.user.uid]: {
          role: 'admin',
          displayName: req.user.name || '',
          photoURL: req.user.picture || '',
          joinedAt: admin.firestore.FieldValue.serverTimestamp()
        }
      }
    });

    await db.collection('users').doc(req.user.uid).set({
      uid: req.user.uid,
      rooms: admin.firestore.FieldValue.arrayUnion(roomRef.id)
    }, { merge: true });

    res.json({ roomId: roomRef.id, inviteCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rooms/join', verifyToken, async (req, res) => {
  try {
    const { inviteCode } = req.body;
    if (!inviteCode) return res.status(400).json({ error: 'Invite code required' });

    if (!firebaseReady) {
      const room = Array.from(localRooms.values()).find(r => r.inviteCode === inviteCode.toUpperCase());
      if (!room) return res.status(404).json({ error: 'Room not found — check invite code' });
      if (room.members?.[req.user.uid]) return res.json({ roomId: room.id, alreadyMember: true });
      room.members[req.user.uid] = {
        role: 'member',
        displayName: req.user.name || '',
        photoURL: req.user.picture || '',
        joinedAt: new Date().toISOString()
      };
      const profile = getLocalUser(req.user);
      profile.rooms = profile.rooms.includes(room.id) ? profile.rooms : [...profile.rooms, room.id];
      return res.json({ roomId: room.id, alreadyMember: false });
    }

    const snap = await db.collection('rooms')
      .where('inviteCode', '==', inviteCode.toUpperCase())
      .limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'Room not found — check invite code' });

    const roomDoc = snap.docs[0];
    const room = roomDoc.data();

    if (room.members?.[req.user.uid]) {
      return res.json({ roomId: roomDoc.id, alreadyMember: true });
    }

    await roomDoc.ref.update({
      [`members.${req.user.uid}`]: {
        role: 'member',
        displayName: req.user.name || '',
        photoURL: req.user.picture || '',
        joinedAt: admin.firestore.FieldValue.serverTimestamp()
      }
    });

    await db.collection('users').doc(req.user.uid).set({
      rooms: admin.firestore.FieldValue.arrayUnion(roomDoc.id)
    }, { merge: true });

    res.json({ roomId: roomDoc.id, alreadyMember: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rooms', verifyToken, async (req, res) => {
  try {
    if (!firebaseReady) {
      const profile = getLocalUser(req.user);
      const roomIds = profile.rooms || [];
      const rooms = roomIds.map(id => localRooms.get(id)).filter(Boolean).map(serializeRoom);
      return res.json(rooms);
    }

    const userRef = db.collection('users').doc(req.user.uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      await userRef.set({
        uid: req.user.uid,
        displayName: req.user.name || '',
        email: req.user.email || '',
        photoURL: req.user.picture || '',
        rooms: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.json([]);
    }

    const roomIds = userSnap.data()?.rooms || [];
    if (!roomIds.length) return res.json([]);

    const roomSnaps = await Promise.all(
      roomIds.map(id => db.collection('rooms').doc(id).get())
    );
    res.json(roomSnaps.filter(s => s.exists).map(s => ({ id: s.id, ...s.data() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rooms/:roomId', verifyToken, async (req, res) => {
  try {
    if (!firebaseReady) {
      const room = localRooms.get(req.params.roomId);
      if (!room) return res.status(404).json({ error: 'Room not found' });
      if (!room.members?.[req.user.uid]) return res.status(403).json({ error: 'Not a member' });
      return res.json(serializeRoom(room));
    }
    const snap = await db.collection('rooms').doc(req.params.roomId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Room not found' });
    const room = snap.data();
    if (!room.members?.[req.user.uid]) return res.status(403).json({ error: 'Not a member' });
    res.json({ id: snap.id, ...room });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/rooms/:roomId', verifyToken, async (req, res) => {
  try {
    const { name, description, githubRepo } = req.body;
    if (!firebaseReady) {
      const room = localRooms.get(req.params.roomId);
      if (!room) return res.status(404).json({ error: 'Room not found' });
      if (room.members?.[req.user.uid]?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
      if (name !== undefined) room.name = name;
      if (description !== undefined) room.description = description;
      if (githubRepo !== undefined) room.githubRepo = githubRepo;
      room.updatedAt = new Date().toISOString();
      return res.json({ success: true });
    }
    const snap = await db.collection('rooms').doc(req.params.roomId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Room not found' });
    if (snap.data().members?.[req.user.uid]?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    await snap.ref.update({
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(githubRepo !== undefined && { githubRepo }),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/rooms/:roomId', verifyToken, async (req, res) => {
  try {
    if (!firebaseReady) {
      const room = localRooms.get(req.params.roomId);
      if (!room) return res.status(404).json({ error: 'Room not found' });
      if (room.members?.[req.user.uid]?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
      localRooms.delete(req.params.roomId);
      localMessages.delete(req.params.roomId);
      return res.json({ success: true });
    }
    const snap = await db.collection('rooms').doc(req.params.roomId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Room not found' });
    if (snap.data().members?.[req.user.uid]?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    await snap.ref.delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MEMBERS ───────────────────────────────────────
app.patch('/api/rooms/:roomId/members/:uid/role', verifyToken, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['admin', 'member', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Use admin | member | viewer' });
    }
    const snap = await db.collection('rooms').doc(req.params.roomId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Room not found' });
    if (snap.data().members?.[req.user.uid]?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    await snap.ref.update({ [`members.${req.params.uid}.role`]: role });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/rooms/:roomId/members/:uid', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('rooms').doc(req.params.roomId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Room not found' });
    const isAdmin = snap.data().members?.[req.user.uid]?.role === 'admin';
    const isSelf = req.params.uid === req.user.uid;
    if (!isAdmin && !isSelf) return res.status(403).json({ error: 'Not allowed' });
    await snap.ref.update({ [`members.${req.params.uid}`]: admin.firestore.FieldValue.delete() });
    await db.collection('users').doc(req.params.uid).update({
      rooms: admin.firestore.FieldValue.arrayRemove(req.params.roomId)
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MESSAGES ──────────────────────────────────────
app.get('/api/rooms/:roomId/messages', verifyToken, async (req, res) => {
  try {
    const lim = parseInt(req.query.limit) || 50;
    const before = req.query.before;

    if (!firebaseReady) {
      const room = localRooms.get(req.params.roomId);
      if (!room) return res.status(404).json({ error: 'Room not found' });
      if (!room.members?.[req.user.uid]) return res.status(403).json({ error: 'Not a member' });
      const msgs = (localMessages.get(req.params.roomId) || []).slice(-lim).reverse();
      return res.json(msgs);
    }

    const roomSnap = await db.collection('rooms').doc(req.params.roomId).get();
    if (!roomSnap.exists) return res.status(404).json({ error: 'Room not found' });
    if (!roomSnap.data().members?.[req.user.uid]) return res.status(403).json({ error: 'Not a member' });

    let q = db.collection('rooms').doc(req.params.roomId)
      .collection('messages').orderBy('createdAt', 'desc').limit(lim);

    if (before) {
      const beforeSnap = await db.collection('rooms')
        .doc(req.params.roomId).collection('messages').doc(before).get();
      if (beforeSnap.exists) q = q.startAfter(beforeSnap);
    }

    const snap = await q.get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/rooms/:roomId/messages/:msgId', verifyToken, async (req, res) => {
  try {
    const msgRef = db.collection('rooms').doc(req.params.roomId)
      .collection('messages').doc(req.params.msgId);
    const snap = await msgRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Message not found' });

    const roomSnap = await db.collection('rooms').doc(req.params.roomId).get();
    const isAdmin = roomSnap.data()?.members?.[req.user.uid]?.role === 'admin';
    const isOwner = snap.data().uid === req.user.uid;
    if (!isAdmin && !isOwner) return res.status(403).json({ error: 'Not allowed' });

    await msgRef.update({ deleted: true, text: '', textHtml: '' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TYPING ────────────────────────────────────────
app.post('/api/rooms/:roomId/typing', verifyToken, async (req, res) => {
  try {
    await db.collection('rooms').doc(req.params.roomId)
      .collection('typing').doc(req.user.uid).set({
        name: req.user.name || 'Someone',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/rooms/:roomId/typing', verifyToken, async (req, res) => {
  try {
    await db.collection('rooms').doc(req.params.roomId)
      .collection('typing').doc(req.user.uid).delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── EDITOR STATE ──────────────────────────────────
app.get('/api/rooms/:roomId/editor', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('rooms').doc(req.params.roomId)
      .collection('editor').doc('state').get();
    res.json(snap.exists ? snap.data() : { content: '', language: 'javascript', fileName: 'untitled.js' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/rooms/:roomId/editor', verifyToken, async (req, res) => {
  try {
    const { content, language, fileName } = req.body;
    await db.collection('rooms').doc(req.params.roomId)
      .collection('editor').doc('state').set({
        content: content ?? '',
        language: language || 'javascript',
        fileName: fileName || 'untitled.js',
        lastEditedBy: req.user.uid,
        lastEditedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FILES ─────────────────────────────────────────
app.get('/api/rooms/:roomId/files', verifyToken, async (req, res) => {
  try {
    const roomSnap = await db.collection('rooms').doc(req.params.roomId).get();
    if (!roomSnap.exists) return res.status(404).json({ error: 'Room not found' });
    if (!roomSnap.data().members?.[req.user.uid]) return res.status(403).json({ error: 'Not a member' });
    const snap = await db.collection('rooms').doc(req.params.roomId)
      .collection('files').orderBy('createdAt', 'asc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create file → PR
app.post('/api/rooms/:roomId/files', verifyToken, async (req, res) => {
  try {
    const { fileName, language, content } = req.body;  // ← fileName from body
    if (!fileName) return res.status(400).json({ error: 'fileName required' });

    const trimmedName = fileName.trim();
    const ref = db.collection('rooms').doc(req.params.roomId).collection('prs').doc();

    await ref.set({
      id: ref.id,
      type: 'create',
      fileName: trimmedName,
      language: language || 'javascript',
      content: content || '',
      uid: req.user.uid,
      name: req.user.name || '',
      photo: req.user.picture || '',
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ prId: ref.id, status: 'pending' });

    // Email after response — non-blocking
    notifyAdmins({
      roomId: req.params.roomId,
      submitterName: req.user.name || 'Someone',
      fileName: trimmedName,           // ← always defined
      type: 'create',
      prId: ref.id
    }).catch(err => console.error('PR email failed:', err.message));

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit file → PR
app.patch('/api/rooms/:roomId/files/:fileId', verifyToken, async (req, res) => {
  try {
    const { content, language } = req.body;

    const fileSnap = await db.collection('rooms').doc(req.params.roomId)
      .collection('files').doc(req.params.fileId).get();
    if (!fileSnap.exists) return res.status(404).json({ error: 'File not found' });

    const fileName = fileSnap.data().fileName;         // ← pulled from Firestore first
    const fileLang = language || fileSnap.data().language || 'javascript';

    const ref = db.collection('rooms').doc(req.params.roomId).collection('prs').doc();

    await ref.set({
      id: ref.id,
      type: 'edit',
      fileId: req.params.fileId,
      fileName,                                         // ← always defined
      language: fileLang,
      content: content || '',
      uid: req.user.uid,
      name: req.user.name || '',
      photo: req.user.picture || '',
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ prId: ref.id, status: 'pending' });

    notifyAdmins({
      roomId: req.params.roomId,
      submitterName: req.user.name || 'Someone',
      fileName,                                         // ← from fileSnap
      type: 'edit',
      prId: ref.id
    }).catch(err => console.error('PR email failed:', err.message));

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete file — admin only
app.delete('/api/rooms/:roomId/files/:fileId', verifyToken, async (req, res) => {
  try {
    const roomSnap = await db.collection('rooms').doc(req.params.roomId).get();
    if (!roomSnap.exists) return res.status(404).json({ error: 'Room not found' });
    if (roomSnap.data().members?.[req.user.uid]?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    await db.collection('rooms').doc(req.params.roomId)
      .collection('files').doc(req.params.fileId).delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PULL REQUESTS ─────────────────────────────────
app.get('/api/rooms/:roomId/prs', verifyToken, async (req, res) => {
  try {
    const roomSnap = await db.collection('rooms').doc(req.params.roomId).get();
    if (!roomSnap.exists) return res.status(404).json({ error: 'Room not found' });
    if (!roomSnap.data().members?.[req.user.uid]) return res.status(403).json({ error: 'Not a member' });
    const snap = await db.collection('rooms').doc(req.params.roomId)
      .collection('prs').orderBy('createdAt', 'desc').limit(50).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rooms/:roomId/prs/:prId/review', verifyToken, async (req, res) => {
  try {
    const { action } = req.body;
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve or reject' });
    }

    const roomSnap = await db.collection('rooms').doc(req.params.roomId).get();
    if (!roomSnap.exists) return res.status(404).json({ error: 'Room not found' });
    if (roomSnap.data().members?.[req.user.uid]?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const prRef = db.collection('rooms').doc(req.params.roomId).collection('prs').doc(req.params.prId);
    const prSnap = await prRef.get();
    if (!prSnap.exists) return res.status(404).json({ error: 'PR not found' });

    const pr = prSnap.data();
    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    await prRef.update({
      status: newStatus,
      reviewedBy: req.user.uid,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    if (action === 'approve') {
      const filesRef = db.collection('rooms').doc(req.params.roomId).collection('files');
      if (pr.type === 'create') {
        await filesRef.doc().set({
          fileName: pr.fileName,
          language: pr.language || 'javascript',
          content: pr.content || '',
          createdBy: pr.uid,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else if (pr.type === 'edit') {
        await filesRef.doc(pr.fileId).update({
          content: pr.content || '',
          language: pr.language || 'javascript',
          lastEditBy: pr.uid,
          lastEditAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    res.json({ success: true, status: newStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── INVITES ───────────────────────────────────────
app.get('/api/invite/:code', optionalAuth, async (req, res) => {
  try {
    const snap = await db.collection('rooms')
      .where('inviteCode', '==', req.params.code.toUpperCase()).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'Invalid invite code' });
    const room = snap.docs[0].data();
    res.json({
      roomId: snap.docs[0].id,
      name: room.name,
      description: room.description || '',
      memberCount: Object.keys(room.members || {}).length,
      inviteCode: room.inviteCode
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/invite/:roomId/regenerate', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('rooms').doc(req.params.roomId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Room not found' });
    if (snap.data().members?.[req.user.uid]?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const newCode = genInviteCode();
    await snap.ref.update({ inviteCode: newCode });
    res.json({ inviteCode: newCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI ────────────────────────────────────────────
app.post('/api/ai/chat', verifyToken, async (req, res) => {
  try {
    const { prompt, context, attachment } = req.body;
    if (!prompt && !attachment) return res.status(400).json({ error: 'Prompt required' });

    let contents;

    if (attachment?.type === 'image' && attachment?.url) {
      // Fetch image and send as inline data to Gemini
      const imgRes = await fetch(attachment.url);
      const imgBuffer = await imgRes.arrayBuffer();
      const base64 = Buffer.from(imgBuffer).toString('base64');
      const mimeType = imgRes.headers.get('content-type') || 'image/png';

      contents = [{
        role: 'user',
        parts: [
          { text: prompt || 'Describe this image.' },
          { inlineData: { mimeType, data: base64 } }
        ]
      }];

    } else if (attachment?.type === 'pdf' && attachment?.url) {
      // For PDF — tell AI the URL and ask it to reason about it
      contents = [{
        role: 'user',
        parts: [{ text: `${prompt || 'Summarize this PDF.'}\n\nPDF file: ${attachment.url}\nFile name: ${attachment.name}` }]
      }];

    } else {
      const fullPrompt = context
        ? `You are an AI coding assistant in a developer chat room.\nContext:\n${context}\n\nUser asks: ${prompt}`
        : `You are an AI coding assistant in a developer chat room. Keep answers concise.\n\n${prompt}`;
      contents = fullPrompt;
    }

    const response = await genai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents
    });

    const raw = response.text;
    const html = marked.parse(raw);
    res.json({ reply: raw, replyHtml: html });
  } catch (err) {
    console.error('AI chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


app.post('/api/ai/private/stream', verifyToken, async (req, res) => {
  const { prompt, history } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const contents = [];
    if (Array.isArray(history)) {
      history.slice(-10).forEach(msg => {
        contents.push({
          role: msg.role === 'ai' ? 'model' : 'user',
          parts: [{ text: msg.text }]
        });
      });
    }
    contents.push({ role: 'user', parts: [{ text: prompt }] });

    const stream = await genai.models.generateContentStream({
      model: 'gemini-2.5-flash',
      contents,
      config: {
        systemInstruction: 'You are an expert coding assistant. Help with code generation, debugging, explanations, and code review. Always format code blocks with proper markdown (```language ... ```).',
        temperature: 0.8,
        maxOutputTokens: 4096
      }
    });

    let fullText = '';
    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        fullText += text;
        res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true, full: fullText, html: marked.parse(fullText) })}\n\n`);
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

app.post('/api/ai/private', verifyToken, async (req, res) => {
  try {
    const { prompt, history } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });

    const contents = [];
    if (Array.isArray(history)) {
      history.slice(-10).forEach(msg => {
        contents.push({
          role: msg.role === 'ai' ? 'model' : 'user',
          parts: [{ text: msg.text }]
        });
      });
    }
    contents.push({ role: 'user', parts: [{ text: prompt }] });

    const response = await genai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents,
      config: { systemInstruction: 'You are an expert coding assistant.', temperature: 0.8, maxOutputTokens: 4096 }
    });

    const raw = response.text;
    const html = marked.parse(raw);
    res.json({ reply: raw, replyHtml: html });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/snippet-verdict', verifyToken, async (req, res) => {
  try {
    const { code, language } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });

    const prompt = `Analyze this ${language || 'code'} snippet in max 3 sentences. Cover: bugs or issues, code quality, one improvement suggestion.\n\n\`\`\`${language || ''}\n${code}\n\`\`\``;

    const response = await genai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { temperature: 0.3, maxOutputTokens: 512 }
    });

    const raw = response.text;
    const html = marked.parse(raw);
    res.json({ verdict: raw, verdictHtml: html });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FILE UPLOAD (Storage) ─────────────────────────
app.post('/api/rooms/:roomId/upload', verifyToken, async (req, res) => {
  try {
    const { fileName, contentType } = req.body;
    if (!fileName || !contentType) return res.status(400).json({ error: 'fileName and contentType required' });

    const filePath = `rooms/${req.params.roomId}/${Date.now()}_${fileName}`;
    const file = bucket.file(filePath);
    const [signedUrl] = await file.getSignedUrl({
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000,
      contentType
    });

    const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(filePath)}?alt=media`;

    res.json({ uploadUrl: signedUrl, publicUrl, filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.delete('/api/rooms/:roomId/files-storage', verifyToken, async (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath required' });
    await bucket.file(filePath).delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DEBUG ─────────────────────────────────────────
app.get('/api/debug', async (req, res) => {
  try {
    await db.collection('_test').doc('ping').set({ ts: Date.now() });
    res.json({ status: 'OK', firestore: true, gemini: !!process.env.GEMINI_API_KEY, node: process.version });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SPA FALLBACK ──────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, './public/index.html'));
});

const PORT = Number(process.env.PORT) || 6969;
const startServer = (port) => {
  const normalizedPort = Number(port);
  const server = app.listen(normalizedPort, () => console.log(`\n  Learnkins Room → http://localhost:${normalizedPort}\n`));
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${normalizedPort} is busy. Trying ${normalizedPort + 1}...`);
      startServer(normalizedPort + 1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
};

if (require.main === module) {
  startServer(PORT);
}

module.exports = app;
