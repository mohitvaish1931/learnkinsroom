// AI route guards, with a dummy key so requests get past the "AI not configured" check.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

for (const k of ['FIREBASE_PRIVATE_KEY', 'FIREBASE_CLIENT_EMAIL']) delete process.env[k];
process.env.GEMINI_API_KEY = 'dummy-key-never-called';
process.env.AI_RATE_LIMIT = '5'; // local- tokens all map to one user: 2 used by the size test, 3 here
const app = require('../app/index.js');

let server, base;
before(() => new Promise(r => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }));
after(() => server.close());

const post = (path, body, token = 'local-dev') => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(body)
});

test('responses carry basic security headers', async () => {
  const res = await fetch(base + '/api/health');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('oversized prompts are rejected before reaching the model', async () => {
  const res = await post('/api/ai/private', { prompt: 'x'.repeat(9000) }, 'local-a');
  assert.equal(res.status, 413);
  const stream = await post('/api/ai/private/stream', { prompt: 'x'.repeat(9000) }, 'local-a');
  assert.equal(stream.status, 413);
});

test('AI requests are rate limited per user', async () => {
  // Missing code → 400 without calling the model, but still counts toward the limit.
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await post('/api/ai/snippet-verdict', {}, 'local-b')).status);
  assert.deepEqual(statuses, [400, 400, 400, 429]);
});
