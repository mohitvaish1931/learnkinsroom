// Boots the server with a throwaway service-account key to check that the
// Admin SDK initialises and rejects bad ID tokens (no network needed).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_PROJECT_ID = 'learnkins-test';
process.env.FIREBASE_CLIENT_EMAIL = 'svc@learnkins-test.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n');
delete process.env.GEMINI_API_KEY;
const app = require('../app/index.js');

let server, base;
before(() => new Promise(r => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }));
after(() => server.close());

test('Firebase Admin initialises from env credentials', async () => {
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.firebaseReady, true);
});

test('protected routes reject missing and invalid ID tokens', async () => {
  assert.equal((await fetch(base + '/api/rooms')).status, 401);
  const res = await fetch(base + '/api/rooms', { headers: { Authorization: 'Bearer not-a-real-jwt' } });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /invalid token/);
});
