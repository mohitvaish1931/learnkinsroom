// Route-level checks that run without Firebase credentials.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

for (const k of ['FIREBASE_PRIVATE_KEY', 'FIREBASE_CLIENT_EMAIL', 'GEMINI_API_KEY']) delete process.env[k];
const app = require('../app/index.js');

let server, base;
before(() => new Promise(r => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }));
after(() => server.close());

const call = async (method, path, { body, token } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('health and config are public', async () => {
  const health = await call('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.firebaseReady, false);
  const config = await call('GET', '/api/config');
  assert.equal(config.body.localMode, true);
});

test('routes needing Firestore answer 503 instead of crashing', async () => {
  for (const [m, p] of [['GET', '/api/rooms'], ['GET', '/api/rooms/x/files'], ['POST', '/api/rooms/x/prs/y/review'], ['GET', '/api/invite/ABC']]) {
    const r = await call(m, p, { token: 'real-looking-token' });
    assert.equal(r.status, 503, `${m} ${p}`);
  }
});

test('AI routes require auth and a configured key', async () => {
  assert.equal((await call('POST', '/api/ai/chat', { body: { prompt: 'hi' } })).status, 401);
  const r = await call('POST', '/api/ai/chat', { body: { prompt: 'hi' }, token: 'local-dev' });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /GEMINI_API_KEY/);
});

test('local mode still supports creating and listing rooms', async () => {
  const created = await call('POST', '/api/rooms/create', { body: { name: 'Local room' }, token: 'local-dev' });
  assert.equal(created.status, 200);
  const rooms = await call('GET', '/api/rooms', { token: 'local-dev' });
  assert.ok(rooms.body.some(r => r.id === created.body.roomId));
});

test('room creation validates the GitHub repo URL', async () => {
  const r = await call('POST', '/api/rooms/create', { body: { name: 'x', githubRepo: 'javascript:alert(1)' }, token: 'local-dev' });
  assert.equal(r.status, 400);
});

test('unknown API paths are JSON 404s, pages fall back to the SPA', async () => {
  const r = await call('GET', '/api/does-not-exist', { token: 'local-dev' });
  assert.equal(r.status, 404);
  const page = await fetch(base + '/some/page');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /html/);
});
