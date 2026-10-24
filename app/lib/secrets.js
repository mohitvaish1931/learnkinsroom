// Optional encryption at rest for per-room secrets (GitHub tokens).
// Set SECRETS_KEY to any long random string to enable it; values written
// before the key was set keep working and are re-encrypted on their next save.

const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function keyFrom(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encryptSecret(plain, secret = process.env.SECRETS_KEY) {
  if (!secret) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ct].map(b => b.toString('base64')).join(':');
}

function decryptSecret(stored, secret = process.env.SECRETS_KEY) {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) return stored || null;
  if (!secret) throw new Error('This secret is encrypted but SECRETS_KEY is not set on the server');
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':').map(s => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
