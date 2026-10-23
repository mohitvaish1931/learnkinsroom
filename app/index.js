try {
  require('dotenv').config();
} catch (err) {
  console.warn('dotenv not found, skipping .env load.');
}

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { GoogleGenAI } = require('@google/genai');
const { marked } = require('marked');
const nodemailer = require('nodemailer');
const github = require('./lib/github');
const { HttpError, escapeHtml, sanitizeFileName, normalizeRoomFileName, languageForFile, handle } = require('./lib/utils');

const mailEnabled = Boolean(process.env.MAIL_HOST && process.env.MAIL_USER);
const mailer = mailEnabled
  ? nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: parseInt(process.env.MAIL_PORT) || 587,
    secure: process.env.MAIL_SECURE === 'true',
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS
    }
  })
  : null;

const app = express();
const genai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

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
    inviteCode: genInviteCode(),
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
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${firebaseCert.project_id}.appspot.com`
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

const AI_ROUTES = ['/ai/chat', '/ai/private/stream', '/ai/private', '/ai/snippet-verdict'];

app.use('/api', (req, res, next) => {
  if (req.path === '/config' || req.path === '/health') return next();
  if (!firebaseReady && !AI_ROUTES.includes(req.path)) {
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
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase is not configured on the server' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized — invalid token' });
  }
};

// Routes below this have no in-memory fallback, so they need Firestore.
const needsDb = (req, res, next) => {
  if (!firebaseReady) return res.status(503).json({ error: 'This feature needs Firebase to be configured' });
  next();
};

const needsAI = (req, res, next) => {
  if (!genai) return res.status(503).json({ error: 'AI is not configured — set GEMINI_API_KEY on the server' });
  next();
};

function genInviteCode() {
  return crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
}

// Loads a room and verifies the caller belongs to it with one of `roles`.
async function loadRoom(roomId, uid, roles = null) {
  const ref = db.collection('rooms').doc(roomId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Room not found');
  const data = snap.data();
  const role = data.members?.[uid]?.role;
  if (!role) throw new HttpError(403, 'Not a member');
  if (roles && !roles.includes(role)) {
    throw new HttpError(403, roles.length === 1 && roles[0] === 'admin' ? 'Admin only' : 'Your role cannot do this');
  }
  return { ref, data, role };
}

const CAN_EDIT = ['admin', 'member'];

function displayNameOf(user) {
  return user.name || user.email?.split('@')[0] || 'Someone';
}

async function postSystemMessage(roomId, text, extra = {}) {
  await db.collection('rooms').doc(roomId).collection('messages').add({
    uid: 'system',
    displayName: 'Learnkins Room',
    photoURL: '',
    text,
    isSystem: true,
    deleted: false,
    edited: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    ...extra
  });
}

// ── EMAIL ─────────────────────────────────────────
async function sendPREmail({ adminEmail, submitterName, fileName, type, roomName, roomId, appUrl }) {
  const actionLabel = type === 'create' ? 'New file' : 'Edit to existing file';
  const reviewUrl = `${appUrl}/chat/?room=${encodeURIComponent(roomId)}`;

  const html = `
    <div style="font-family:monospace;max-width:520px;margin:0 auto;background:#0f0f14;color:#e2e8f0;padding:32px;border-radius:12px;">
      <h2 style="color:#a78bfa;margin-top:0;">New Pull Request — ${escapeHtml(roomName)}</h2>
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:8px 0;color:#94a3b8;width:140px;">Submitted by</td>
          <td style="padding:8px 0;">${escapeHtml(submitterName)}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#94a3b8;">File</td>
          <td style="padding:8px 0;">${escapeHtml(fileName)}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#94a3b8;">Type</td>
          <td style="padding:8px 0;">${actionLabel}</td>
        </tr>
      </table>
      <a href="${escapeHtml(reviewUrl)}"
         style="display:inline-block;margin-top:24px;padding:10px 20px;
                background:#7c3aed;color:#fff;text-decoration:none;
                border-radius:8px;font-size:14px;">
        Review in Learnkins Room
      </a>
      <p style="margin-top:24px;font-size:12px;color:#475569;">
        You are receiving this because you are an admin of "${escapeHtml(roomName)}".
      </p>
    </div>`;

  await mailer.sendMail({
    from: process.env.MAIL_FROM,
    to: adminEmail,
    subject: `[Learnkins Room] New PR from ${submitterName} — ${fileName}`,
    html
  });
}

async function notifyAdmins({ roomData, roomId, submitterName, fileName, type, appUrl }) {
  if (!mailEnabled) return;
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
        submitterName,
        fileName,
        type,
        roomName: roomData.name,
        roomId,
        appUrl
      }))
  );
}

function appUrlFor(req) {
  return process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
}

// ── GITHUB SYNC ───────────────────────────────────
// The token lives in a server-only collection; Firestore rules deny all client access.
async function getGithubConfig(roomId, roomData) {
  const repo = github.parseRepo(roomData.githubRepo);
  const secretSnap = await db.collection('roomSecrets').doc(roomId).get();
  const roomToken = secretSnap.exists ? secretSnap.data().githubToken : null;
  const token = roomToken || process.env.GITHUB_TOKEN || null;
  return {
    repo,
    token,
    tokenSource: roomToken ? 'room' : (process.env.GITHUB_TOKEN ? 'server' : null),
    branch: roomData.githubBranch || 'main',
    basePath: roomData.githubBasePath || '',
    autoPush: roomData.githubAutoPush === true
  };
}

// Pushes changes and reports the outcome in chat. Never throws: a failed push
// must not undo an approved PR.
async function syncToGithub({ roomId, roomData, files = [], deletions = [], message, actor, force = false }) {
  try {
    const cfg = await getGithubConfig(roomId, roomData);
    if (!cfg.repo || !cfg.token || (!cfg.autoPush && !force)) return { status: 'skipped' };

    const result = await github.commitFiles({
      token: cfg.token,
      owner: cfg.repo.owner,
      repo: cfg.repo.repo,
      branch: cfg.branch,
      files: files.map(f => ({ path: github.buildRepoPath(cfg.basePath, f.fileName), content: f.content })),
      deletions: deletions.map(name => github.buildRepoPath(cfg.basePath, name)),
      message,
      author: actor?.email ? { name: actor.name || actor.email, email: actor.email } : null
    });

    const shortSha = result.commitSha.slice(0, 7);
    await postSystemMessage(roomId,
      `Pushed to GitHub \`${cfg.repo.owner}/${cfg.repo.repo}@${cfg.branch}\` — commit \`${shortSha}\`: ${message.split('\n')[0]}`,
      { github: { commitUrl: result.commitUrl, sha: result.commitSha } });
    return { status: 'pushed', commitUrl: result.commitUrl, sha: result.commitSha };
  } catch (err) {
    console.error('GitHub push failed:', err.message);
    await postSystemMessage(roomId, `GitHub push failed: ${err.message}`, { github: { error: true } }).catch(() => { });
    return { status: 'failed', error: err.message };
  }
}

// Applies an approved PR to the room's files and returns what changed.
async function applyPR(roomRef, pr) {
  const filesRef = roomRef.collection('files');

  if (pr.type === 'create') {
    const clash = await filesRef.where('fileName', '==', pr.fileName).limit(1).get();
    if (!clash.empty) throw new HttpError(409, `A file named ${pr.fileName} already exists`);
    const fileRef = filesRef.doc();
    await fileRef.set({
      fileName: pr.fileName,
      language: pr.language || languageForFile(pr.fileName),
      content: pr.content || '',
      createdBy: pr.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { fileId: fileRef.id, files: [{ fileName: pr.fileName, content: pr.content || '' }], deletions: [] };
  }

  const fileRef = filesRef.doc(pr.fileId);
  const fileSnap = await fileRef.get();
  if (!fileSnap.exists) throw new HttpError(409, 'The file this PR edits was deleted');
  const oldName = fileSnap.data().fileName;
  const newName = pr.newFileName || oldName;

  if (newName !== oldName) {
    const clash = await filesRef.where('fileName', '==', newName).limit(1).get();
    if (!clash.empty) throw new HttpError(409, `A file named ${newName} already exists`);
  }

  await fileRef.update({
    fileName: newName,
    content: pr.content || '',
    language: pr.language || fileSnap.data().language || languageForFile(newName),
    lastEditBy: pr.uid,
    lastEditAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return {
    fileId: pr.fileId,
    files: [{ fileName: newName, content: pr.content || '' }],
    deletions: newName !== oldName ? [oldName] : []
  };
}

function commitMessageFor(pr, reviewer) {
  const verb = pr.type === 'create' ? 'Add' : (pr.newFileName && pr.newFileName !== pr.fileName ? 'Rename/update' : 'Update');
  const target = pr.newFileName && pr.newFileName !== pr.fileName ? `${pr.fileName} → ${pr.newFileName}` : pr.fileName;
  const lines = [`${verb} ${target}`, '', `Submitted by ${pr.name || 'a room member'} via Learnkins Room`];
  if (reviewer && reviewer !== pr.name) lines.push(`Approved by ${reviewer}`);
  if (pr.message) lines.push('', pr.message);
  return lines.join('\n');
}

// Marks a pending PR approved exactly once, applies it, then pushes.
async function mergePR({ roomId, roomRef, roomData, prRef, reviewer }) {
  const pr = await db.runTransaction(async tx => {
    const snap = await tx.get(prRef);
    if (!snap.exists) throw new HttpError(404, 'PR not found');
    if (snap.data().status !== 'pending') throw new HttpError(409, `PR is already ${snap.data().status}`);
    tx.update(prRef, {
      status: 'approved',
      reviewedBy: reviewer.uid,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return snap.data();
  });

  let applied;
  try {
    applied = await applyPR(roomRef, pr);
  } catch (err) {
    await prRef.update({ status: 'pending', reviewedBy: admin.firestore.FieldValue.delete(), reviewedAt: admin.firestore.FieldValue.delete() });
    throw err;
  }

  const githubResult = await syncToGithub({
    roomId,
    roomData,
    files: applied.files,
    deletions: applied.deletions,
    message: commitMessageFor(pr, displayNameOf(reviewer)),
    actor: { name: displayNameOf(reviewer), email: reviewer.email }
  });
  await prRef.update({ fileId: applied.fileId, github: githubResult });
  return { fileId: applied.fileId, github: githubResult };
}

// ── CONFIG ────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', firebaseReady, geminiReady: Boolean(genai), mailReady: mailEnabled, githubServerToken: Boolean(process.env.GITHUB_TOKEN) });
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

// ICE servers for voice. TURN credentials are only handed to signed-in users.
app.get('/api/rtc-config', verifyToken, (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map(s => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    });
  }
  res.json({ iceServers });
});

// ── AUTH ──────────────────────────────────────────
app.get('/api/auth/me', verifyToken, handle(async (req, res) => {
  if (!firebaseReady) {
    const profile = getLocalUser(req.user);
    return res.json({ uid: profile.uid, ...profile });
  }
  const snap = await db.collection('users').doc(req.user.uid).get();
  if (!snap.exists) return res.status(404).json({ error: 'User not found' });
  res.json({ uid: req.user.uid, ...snap.data() });
}));

app.post('/api/auth/profile', verifyToken, handle(async (req, res) => {
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
    email: req.user.email || email || '',
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  res.json({ success: true });
}));

// ── ROOMS ─────────────────────────────────────────
app.post('/api/rooms/create', verifyToken, handle(async (req, res) => {
  const { name, description, githubRepo } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Room name is required' });
  if (githubRepo && !github.parseRepo(githubRepo)) {
    return res.status(400).json({ error: 'GitHub repo must look like https://github.com/owner/repo' });
  }

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
    name: name.trim().slice(0, 80),
    description: (description || '').slice(0, 300),
    githubRepo: githubRepo || '',
    githubBranch: 'main',
    githubBasePath: '',
    githubAutoPush: false,
    inviteCode,
    createdBy: req.user.uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    members: {
      [req.user.uid]: {
        role: 'admin',
        displayName: displayNameOf(req.user),
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
}));

app.post('/api/rooms/join', verifyToken, handle(async (req, res) => {
  const { inviteCode } = req.body;
  if (!inviteCode) return res.status(400).json({ error: 'Invite code required' });
  const code = String(inviteCode).trim().toUpperCase();

  if (!firebaseReady) {
    const room = Array.from(localRooms.values()).find(r => r.inviteCode === code);
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
    .where('inviteCode', '==', code)
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
      displayName: displayNameOf(req.user),
      photoURL: req.user.picture || '',
      joinedAt: admin.firestore.FieldValue.serverTimestamp()
    }
  });

  await db.collection('users').doc(req.user.uid).set({
    rooms: admin.firestore.FieldValue.arrayUnion(roomDoc.id)
  }, { merge: true });

  await postSystemMessage(roomDoc.id, `${displayNameOf(req.user)} joined the room`).catch(() => { });

  res.json({ roomId: roomDoc.id, alreadyMember: false });
}));

app.get('/api/rooms', verifyToken, handle(async (req, res) => {
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
  res.json(roomSnaps
    .filter(s => s.exists && s.data().members?.[req.user.uid])
    .map(s => ({ id: s.id, ...s.data() })));
}));

app.get('/api/rooms/:roomId', verifyToken, handle(async (req, res) => {
  if (!firebaseReady) {
    const room = localRooms.get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!room.members?.[req.user.uid]) return res.status(403).json({ error: 'Not a member' });
    return res.json(serializeRoom(room));
  }
  const { ref, data } = await loadRoom(req.params.roomId, req.user.uid);
  res.json({ id: ref.id, ...data });
}));

app.patch('/api/rooms/:roomId', verifyToken, handle(async (req, res) => {
  const { name, description, githubRepo, githubBranch, githubBasePath, githubAutoPush, githubToken } = req.body;

  if (githubRepo && !github.parseRepo(githubRepo)) {
    return res.status(400).json({ error: 'GitHub repo must look like https://github.com/owner/repo' });
  }
  if (githubBranch !== undefined && githubBranch !== '' && !/^[\w./-]+$/.test(githubBranch)) {
    return res.status(400).json({ error: 'Invalid branch name' });
  }
  if (githubBasePath && String(githubBasePath).split('/').includes('..')) {
    return res.status(400).json({ error: 'Base path cannot contain ".."' });
  }

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

  const { ref } = await loadRoom(req.params.roomId, req.user.uid, ['admin']);
  await ref.update({
    ...(name !== undefined && name.trim() && { name: name.trim().slice(0, 80) }),
    ...(description !== undefined && { description: String(description).slice(0, 300) }),
    ...(githubRepo !== undefined && { githubRepo }),
    ...(githubBranch !== undefined && { githubBranch: githubBranch || 'main' }),
    ...(githubBasePath !== undefined && { githubBasePath: String(githubBasePath).replace(/^\/+|\/+$/g, '') }),
    ...(githubAutoPush !== undefined && { githubAutoPush: Boolean(githubAutoPush) }),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Write-only: an empty string clears the token, undefined leaves it alone.
  if (githubToken !== undefined) {
    const secretRef = db.collection('roomSecrets').doc(req.params.roomId);
    if (githubToken) await secretRef.set({ githubToken: String(githubToken).trim(), updatedBy: req.user.uid }, { merge: true });
    else await secretRef.delete();
  }
  res.json({ success: true });
}));

app.delete('/api/rooms/:roomId', verifyToken, handle(async (req, res) => {
  if (!firebaseReady) {
    const room = localRooms.get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.members?.[req.user.uid]?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    localRooms.delete(req.params.roomId);
    localMessages.delete(req.params.roomId);
    return res.json({ success: true });
  }
  const { ref, data } = await loadRoom(req.params.roomId, req.user.uid, ['admin']);
  await Promise.all(Object.keys(data.members || {}).map(uid =>
    db.collection('users').doc(uid).set({
      rooms: admin.firestore.FieldValue.arrayRemove(req.params.roomId)
    }, { merge: true })
  ));
  await db.collection('roomSecrets').doc(req.params.roomId).delete();
  await db.recursiveDelete(ref);
  res.json({ success: true });
}));

// ── MEMBERS ───────────────────────────────────────
app.patch('/api/rooms/:roomId/members/:uid/role', verifyToken, needsDb, handle(async (req, res) => {
  const { role } = req.body;
  if (!['admin', 'member', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Use admin | member | viewer' });
  }
  const { ref, data } = await loadRoom(req.params.roomId, req.user.uid, ['admin']);
  if (!data.members?.[req.params.uid]) return res.status(404).json({ error: 'Member not found' });
  const admins = Object.values(data.members).filter(m => m.role === 'admin').length;
  if (data.members[req.params.uid].role === 'admin' && role !== 'admin' && admins <= 1) {
    return res.status(400).json({ error: 'A room needs at least one admin' });
  }
  await ref.update({ [`members.${req.params.uid}.role`]: role });
  res.json({ success: true });
}));

app.delete('/api/rooms/:roomId/members/:uid', verifyToken, needsDb, handle(async (req, res) => {
  const { ref, data, role } = await loadRoom(req.params.roomId, req.user.uid);
  const isSelf = req.params.uid === req.user.uid;
  if (role !== 'admin' && !isSelf) return res.status(403).json({ error: 'Not allowed' });
  const target = data.members?.[req.params.uid];
  if (!target) return res.status(404).json({ error: 'Member not found' });
  const admins = Object.values(data.members).filter(m => m.role === 'admin').length;
  if (target.role === 'admin' && admins <= 1 && Object.keys(data.members).length > 1) {
    return res.status(400).json({ error: 'Promote another admin before the last admin leaves' });
  }
  await ref.update({ [`members.${req.params.uid}`]: admin.firestore.FieldValue.delete() });
  await db.collection('users').doc(req.params.uid).set({
    rooms: admin.firestore.FieldValue.arrayRemove(req.params.roomId)
  }, { merge: true });
  await ref.collection('voice').doc(req.params.uid).delete().catch(() => { });
  await postSystemMessage(req.params.roomId, isSelf
    ? `${target.displayName || 'A member'} left the room`
    : `${target.displayName || 'A member'} was removed from the room`).catch(() => { });
  res.json({ success: true });
}));

// ── MESSAGES ──────────────────────────────────────
app.get('/api/rooms/:roomId/messages', verifyToken, handle(async (req, res) => {
  const lim = Math.min(parseInt(req.query.limit) || 50, 200);
  const before = req.query.before;

  if (!firebaseReady) {
    const room = localRooms.get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!room.members?.[req.user.uid]) return res.status(403).json({ error: 'Not a member' });
    const msgs = (localMessages.get(req.params.roomId) || []).slice(-lim);
    return res.json(msgs);
  }

  const { ref } = await loadRoom(req.params.roomId, req.user.uid);
  let q = ref.collection('messages').orderBy('createdAt', 'desc').limit(lim);

  if (before) {
    const beforeSnap = await ref.collection('messages').doc(before).get();
    if (beforeSnap.exists) q = q.startAfter(beforeSnap);
  }

  const snap = await q.get();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse());
}));

app.delete('/api/rooms/:roomId/messages/:msgId', verifyToken, needsDb, handle(async (req, res) => {
  const { ref, role } = await loadRoom(req.params.roomId, req.user.uid);
  const msgRef = ref.collection('messages').doc(req.params.msgId);
  const snap = await msgRef.get();
  if (!snap.exists) return res.status(404).json({ error: 'Message not found' });
  if (role !== 'admin' && snap.data().uid !== req.user.uid) return res.status(403).json({ error: 'Not allowed' });

  await msgRef.update({ deleted: true, text: '', textHtml: '', attachment: admin.firestore.FieldValue.delete() });
  res.json({ success: true });
}));

// ── TYPING ────────────────────────────────────────
app.post('/api/rooms/:roomId/typing', verifyToken, needsDb, handle(async (req, res) => {
  const { ref } = await loadRoom(req.params.roomId, req.user.uid);
  await ref.collection('typing').doc(req.user.uid).set({
    name: displayNameOf(req.user),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  res.json({ success: true });
}));

app.delete('/api/rooms/:roomId/typing', verifyToken, needsDb, handle(async (req, res) => {
  await db.collection('rooms').doc(req.params.roomId)
    .collection('typing').doc(req.user.uid).delete();
  res.json({ success: true });
}));

// ── EDITOR STATE ──────────────────────────────────
app.get('/api/rooms/:roomId/editor', verifyToken, needsDb, handle(async (req, res) => {
  const { ref } = await loadRoom(req.params.roomId, req.user.uid);
  const snap = await ref.collection('editor').doc('state').get();
  res.json(snap.exists ? snap.data() : { content: '', language: 'javascript', fileName: 'untitled.js' });
}));

app.patch('/api/rooms/:roomId/editor', verifyToken, needsDb, handle(async (req, res) => {
  const { content, language, fileName } = req.body;
  const { ref } = await loadRoom(req.params.roomId, req.user.uid, CAN_EDIT);
  await ref.collection('editor').doc('state').set({
    content: content ?? '',
    language: language || 'javascript',
    fileName: fileName || 'untitled.js',
    lastEditedBy: req.user.uid,
    lastEditedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  res.json({ success: true });
}));

// ── FILES ─────────────────────────────────────────
app.get('/api/rooms/:roomId/files', verifyToken, needsDb, handle(async (req, res) => {
  const { ref } = await loadRoom(req.params.roomId, req.user.uid);
  const snap = await ref.collection('files').orderBy('createdAt', 'asc').get();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
}));

// Shared by create/edit: records a PR, auto-merges it for admins, otherwise emails admins.
async function submitPR(req, res, prFields) {
  const { roomId } = req.params;
  const room = await loadRoom(roomId, req.user.uid, CAN_EDIT);
  const prRef = room.ref.collection('prs').doc();

  await prRef.set({
    id: prRef.id,
    ...prFields,
    message: String(req.body.message || '').slice(0, 500),
    uid: req.user.uid,
    name: displayNameOf(req.user),
    photo: req.user.picture || '',
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  if (room.role === 'admin') {
    const merged = await mergePR({ roomId, roomRef: room.ref, roomData: room.data, prRef, reviewer: req.user });
    await prRef.update({ autoMerged: true });
    return res.json({ prId: prRef.id, status: 'approved', autoMerged: true, ...merged });
  }

  res.json({ prId: prRef.id, status: 'pending' });

  notifyAdmins({
    roomData: room.data,
    roomId,
    submitterName: displayNameOf(req.user),
    fileName: prFields.newFileName || prFields.fileName,
    type: prFields.type,
    appUrl: appUrlFor(req)
  }).catch(err => console.error('PR email failed:', err.message));
}

// Create file → PR
app.post('/api/rooms/:roomId/files', verifyToken, needsDb, handle(async (req, res) => {
  const { language, content } = req.body;
  const fileName = normalizeRoomFileName(req.body.fileName);

  const clash = await db.collection('rooms').doc(req.params.roomId).collection('files')
    .where('fileName', '==', fileName).limit(1).get();
  if (!clash.empty) return res.status(409).json({ error: `A file named ${fileName} already exists — open it to edit` });

  await submitPR(req, res, {
    type: 'create',
    fileName,
    language: language || languageForFile(fileName),
    content: content || ''
  });
}));

// Edit (and optionally rename) file → PR
app.patch('/api/rooms/:roomId/files/:fileId', verifyToken, needsDb, handle(async (req, res) => {
  const { content, language } = req.body;

  const fileSnap = await db.collection('rooms').doc(req.params.roomId)
    .collection('files').doc(req.params.fileId).get();
  if (!fileSnap.exists) return res.status(404).json({ error: 'File not found' });

  const fileName = fileSnap.data().fileName;
  const requestedName = req.body.fileName ? normalizeRoomFileName(req.body.fileName) : fileName;

  await submitPR(req, res, {
    type: 'edit',
    fileId: req.params.fileId,
    fileName,
    ...(requestedName !== fileName && { newFileName: requestedName }),
    language: language || fileSnap.data().language || 'javascript',
    previousContent: fileSnap.data().content || '',
    content: content || ''
  });
}));

// Delete file — admin only
app.delete('/api/rooms/:roomId/files/:fileId', verifyToken, needsDb, handle(async (req, res) => {
  const { ref, data } = await loadRoom(req.params.roomId, req.user.uid, ['admin']);
  const fileRef = ref.collection('files').doc(req.params.fileId);
  const fileSnap = await fileRef.get();
  if (!fileSnap.exists) return res.status(404).json({ error: 'File not found' });

  await fileRef.delete();
  // Drop the live-collaboration history for this file as well.
  await db.recursiveDelete(ref.collection('collab').doc(`file-${req.params.fileId}`));

  const githubResult = await syncToGithub({
    roomId: req.params.roomId,
    roomData: data,
    deletions: [fileSnap.data().fileName],
    message: `Delete ${fileSnap.data().fileName}\n\nDeleted by ${displayNameOf(req.user)} via Learnkins Room`,
    actor: { name: displayNameOf(req.user), email: req.user.email }
  });
  res.json({ success: true, github: githubResult });
}));

// ── PULL REQUESTS ─────────────────────────────────
app.get('/api/rooms/:roomId/prs', verifyToken, needsDb, handle(async (req, res) => {
  const { ref } = await loadRoom(req.params.roomId, req.user.uid);
  const snap = await ref.collection('prs').orderBy('createdAt', 'desc').limit(50).get();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
}));

app.post('/api/rooms/:roomId/prs/:prId/review', verifyToken, needsDb, handle(async (req, res) => {
  const { action } = req.body;
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action must be approve or reject' });
  }

  const room = await loadRoom(req.params.roomId, req.user.uid, ['admin']);
  const prRef = room.ref.collection('prs').doc(req.params.prId);

  if (action === 'reject') {
    const snap = await prRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'PR not found' });
    if (snap.data().status !== 'pending') return res.status(409).json({ error: `PR is already ${snap.data().status}` });
    await prRef.update({
      status: 'rejected',
      reviewedBy: req.user.uid,
      reviewNote: String(req.body.note || '').slice(0, 500),
      reviewedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return res.json({ success: true, status: 'rejected' });
  }

  const merged = await mergePR({ roomId: req.params.roomId, roomRef: room.ref, roomData: room.data, prRef, reviewer: req.user });
  res.json({ success: true, status: 'approved', ...merged });
}));

// ── GITHUB ────────────────────────────────────────
app.get('/api/rooms/:roomId/github', verifyToken, needsDb, handle(async (req, res) => {
  const { data } = await loadRoom(req.params.roomId, req.user.uid, ['admin']);
  const cfg = await getGithubConfig(req.params.roomId, data);
  res.json({
    repo: data.githubRepo || '',
    branch: cfg.branch,
    basePath: cfg.basePath,
    autoPush: cfg.autoPush,
    hasToken: Boolean(cfg.token),
    tokenSource: cfg.tokenSource
  });
}));

app.post('/api/rooms/:roomId/github/test', verifyToken, needsDb, handle(async (req, res) => {
  const { data } = await loadRoom(req.params.roomId, req.user.uid, ['admin']);
  const cfg = await getGithubConfig(req.params.roomId, data);
  if (!cfg.repo) throw new HttpError(400, 'Set a GitHub repository first');
  if (!cfg.token) throw new HttpError(400, 'Add a GitHub token first');
  try {
    const info = await github.testAccess({ token: cfg.token, owner: cfg.repo.owner, repo: cfg.repo.repo });
    if (!info.canPush) throw new HttpError(403, `Token can read ${info.fullName} but cannot push to it`);
    res.json({ ok: true, ...info });
  } catch (err) {
    throw new HttpError(err.status === 401 ? 400 : (err.status || 502), `GitHub: ${err.message}`);
  }
}));

// Pushes every room file to the repo in one commit, regardless of auto-push.
app.post('/api/rooms/:roomId/github/push', verifyToken, needsDb, handle(async (req, res) => {
  const { ref, data } = await loadRoom(req.params.roomId, req.user.uid, ['admin']);
  const cfg = await getGithubConfig(req.params.roomId, data);
  if (!cfg.repo) throw new HttpError(400, 'Set a GitHub repository first');
  if (!cfg.token) throw new HttpError(400, 'Add a GitHub token first');

  const filesSnap = await ref.collection('files').get();
  if (filesSnap.empty) throw new HttpError(400, 'No files to push yet');
  const files = filesSnap.docs.map(d => ({ fileName: d.data().fileName, content: d.data().content || '' }));

  const result = await syncToGithub({
    roomId: req.params.roomId,
    roomData: data,
    files,
    message: String(req.body.message || '').trim() || `Sync ${files.length} file(s) from Learnkins Room "${data.name}"`,
    actor: { name: displayNameOf(req.user), email: req.user.email },
    force: true
  });
  if (result.status === 'failed') throw new HttpError(502, result.error);
  res.json(result);
}));

// ── INVITES ───────────────────────────────────────
app.get('/api/invite/:code', needsDb, handle(async (req, res) => {
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
}));

app.post('/api/invite/:roomId/regenerate', verifyToken, needsDb, handle(async (req, res) => {
  const { ref } = await loadRoom(req.params.roomId, req.user.uid, ['admin']);
  const newCode = genInviteCode();
  await ref.update({ inviteCode: newCode });
  res.json({ inviteCode: newCode });
}));

// ── AI ────────────────────────────────────────────
// Attachments are only fetched from this project's own storage bucket, so the
// endpoint can't be used to make the server request arbitrary URLs.
function isOwnStorageUrl(url) {
  if (!bucket || typeof url !== 'string') return false;
  return url.startsWith(`https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/`);
}

async function fetchAttachmentInline(attachment) {
  if (!isOwnStorageUrl(attachment.url)) throw new HttpError(400, 'Attachment must be a file uploaded to this room');
  const fileRes = await fetch(attachment.url);
  if (!fileRes.ok) throw new HttpError(502, 'Could not read attachment');
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  if (buffer.length > 15 * 1024 * 1024) throw new HttpError(413, 'Attachment too large for AI (15MB max)');
  const fallback = attachment.type === 'pdf' ? 'application/pdf' : 'image/png';
  return { mimeType: fileRes.headers.get('content-type') || fallback, data: buffer.toString('base64') };
}

app.post('/api/ai/chat', verifyToken, needsAI, handle(async (req, res) => {
  const { prompt, context, attachment, roomId, replyTo } = req.body;
  if (!prompt && !attachment) return res.status(400).json({ error: 'Prompt required' });

  let room = null;
  let history = '';
  if (roomId && firebaseReady) {
    room = await loadRoom(roomId, req.user.uid);
    const recent = await room.ref.collection('messages').orderBy('createdAt', 'desc').limit(15).get();
    history = recent.docs.reverse()
      .map(d => d.data())
      .filter(m => !m.deleted && m.text)
      .map(m => `${m.displayName || 'Someone'}: ${m.text.slice(0, 500)}`)
      .join('\n');
  }

  const system = 'You are an AI coding assistant inside a team developer chat room. Keep answers concise and use markdown code blocks.';
  const parts = [];
  if (history) parts.push({ text: `Recent room conversation:\n${history}` });
  if (context) parts.push({ text: `Context:\n${String(context).slice(0, 20000)}` });

  if (attachment?.url && (attachment.type === 'image' || attachment.type === 'pdf')) {
    parts.push({ text: prompt || (attachment.type === 'pdf' ? 'Summarize this PDF.' : 'Describe this image.') });
    parts.push({ inlineData: await fetchAttachmentInline(attachment) });
  } else {
    parts.push({ text: `${displayNameOf(req.user)} asks: ${prompt || 'Describe the attachment.'}` });
  }

  const response = await genai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts }],
    config: { systemInstruction: system }
  });

  const raw = response.text || '_No response._';
  const html = marked.parse(raw);

  // Firestore rules only let users write messages as themselves, so the AI reply
  // is written with the Admin SDK.
  let posted = false;
  if (room) {
    await room.ref.collection('messages').add({
      uid: 'ai',
      displayName: 'AI Assistant',
      photoURL: '',
      text: raw,
      textHtml: html,
      isAI: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      deleted: false,
      edited: false,
      ...(replyTo?.id && {
        replyTo: {
          id: String(replyTo.id),
          uid: req.user.uid,
          name: displayNameOf(req.user),
          text: String(replyTo.text || '').slice(0, 60)
        }
      })
    });
    posted = true;
  }

  res.json({ reply: raw, replyHtml: html, posted });
}));

function toGeminiHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-10)
    .filter(msg => msg && typeof msg.text === 'string')
    .map(msg => ({
      role: msg.role === 'ai' ? 'model' : 'user',
      parts: [{ text: msg.text }]
    }));
}

const PRIVATE_SYSTEM = 'You are an expert coding assistant. Help with code generation, debugging, explanations, and code review. Always format code blocks with proper markdown (```language ... ```).';

app.post('/api/ai/private/stream', verifyToken, needsAI, async (req, res) => {
  const { prompt, history, context } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const contents = toGeminiHistory(history);
    const fullPrompt = context ? `${prompt}\n\nContext:\n${String(context).slice(0, 20000)}` : prompt;
    contents.push({ role: 'user', parts: [{ text: fullPrompt }] });

    const stream = await genai.models.generateContentStream({
      model: GEMINI_MODEL,
      contents,
      config: {
        systemInstruction: PRIVATE_SYSTEM,
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

app.post('/api/ai/private', verifyToken, needsAI, handle(async (req, res) => {
  const { prompt, history } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  const contents = toGeminiHistory(history);
  contents.push({ role: 'user', parts: [{ text: prompt }] });

  const response = await genai.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: { systemInstruction: PRIVATE_SYSTEM, temperature: 0.8, maxOutputTokens: 4096 }
  });

  const raw = response.text || '';
  res.json({ reply: raw, replyHtml: marked.parse(raw) });
}));

// Short review of a snippet, or of a PR when `diff` is given.
app.post('/api/ai/snippet-verdict', verifyToken, needsAI, handle(async (req, res) => {
  const { code, language, diff, fileName } = req.body;
  if (!code && !diff) return res.status(400).json({ error: 'Code required' });

  const prompt = diff
    ? `You are reviewing a pull request to ${fileName || 'a file'} (${language || 'code'}). In at most 6 short bullet points cover: bugs or regressions, security issues, code quality, and finish with a one-line verdict (approve / request changes).\n\n\`\`\`diff\n${String(diff).slice(0, 30000)}\n\`\`\``
    : `Analyze this ${language || 'code'} snippet in max 3 sentences. Cover: bugs or issues, code quality, one improvement suggestion.\n\n\`\`\`${language || ''}\n${String(code).slice(0, 30000)}\n\`\`\``;

  const response = await genai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: { temperature: 0.3, maxOutputTokens: 1024 }
  });

  const raw = response.text || '';
  res.json({ verdict: raw, verdictHtml: marked.parse(raw) });
}));

// ── FILE UPLOAD (Storage) ─────────────────────────
app.post('/api/rooms/:roomId/upload', verifyToken, needsDb, handle(async (req, res) => {
  const { fileName, contentType } = req.body;
  if (!fileName || !contentType) return res.status(400).json({ error: 'fileName and contentType required' });
  if (!/^(image\/[\w.+-]+|video\/[\w.+-]+|application\/pdf)$/.test(contentType)) {
    return res.status(400).json({ error: 'Only images, videos and PDFs can be uploaded' });
  }
  await loadRoom(req.params.roomId, req.user.uid);

  const filePath = `rooms/${req.params.roomId}/${req.user.uid}/${Date.now()}_${sanitizeFileName(fileName)}`;
  const file = bucket.file(filePath);

  // A Firebase download token makes the object readable by URL (for <img>, and
  // for the AI endpoint) without opening up the bucket's security rules.
  const downloadToken = crypto.randomUUID();
  const uploadHeaders = { 'x-goog-meta-firebasestoragedownloadtokens': downloadToken };
  const [signedUrl] = await file.getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + 15 * 60 * 1000,
    contentType,
    extensionHeaders: uploadHeaders
  });

  const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(filePath)}?alt=media&token=${downloadToken}`;

  res.json({ uploadUrl: signedUrl, uploadHeaders, publicUrl, filePath });
}));

app.delete('/api/rooms/:roomId/files-storage', verifyToken, needsDb, handle(async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  const { role } = await loadRoom(req.params.roomId, req.user.uid);
  const prefix = `rooms/${req.params.roomId}/`;
  if (!filePath.startsWith(prefix) || filePath.includes('..')) {
    return res.status(400).json({ error: 'File does not belong to this room' });
  }
  const ownerUid = filePath.slice(prefix.length).split('/')[0];
  if (role !== 'admin' && ownerUid !== req.user.uid) return res.status(403).json({ error: 'Not allowed' });
  await bucket.file(filePath).delete();
  res.json({ success: true });
}));

// ── SPA FALLBACK ──────────────────────────────────
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

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
