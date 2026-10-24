const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../app/lib/ratelimit');
const { encryptSecret, decryptSecret } = require('../app/lib/secrets');

test('rate limiter allows `limit` hits per window, then recovers', () => {
  let t = 0;
  const rl = createRateLimiter({ limit: 3, windowMs: 1000, now: () => t });
  assert.deepEqual([1, 2, 3, 4].map(() => rl.take('u').ok), [true, true, true, false]);
  assert.equal(rl.take('other').ok, true, 'keys are independent');
  assert.equal(rl.take('u').retryAfterSec, 1);
  t = 1000;
  assert.equal(rl.take('u').ok, true);
});

test('secrets round-trip when SECRETS_KEY is set', () => {
  const enc = encryptSecret('ghp_secret', 'k1');
  assert.match(enc, /^enc:v1:/);
  assert.ok(!enc.includes('ghp_secret'));
  assert.equal(decryptSecret(enc, 'k1'), 'ghp_secret');
  assert.notEqual(encryptSecret('ghp_secret', 'k1'), enc, 'random IV');
});

test('secrets pass through without a key, and tampering is detected', () => {
  assert.equal(encryptSecret('plain', ''), 'plain');
  assert.equal(decryptSecret('plain', 'k1'), 'plain');
  assert.equal(decryptSecret(undefined, 'k1'), null);
  const enc = encryptSecret('ghp_secret', 'k1');
  assert.throws(() => decryptSecret(enc, 'wrong-key'));
  assert.throws(() => decryptSecret(enc, ''), /SECRETS_KEY/);
});
