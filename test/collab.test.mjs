import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/loader.mjs', import.meta.url);
globalThis.window = globalThis.window || {}; // vendor bundle reads window.CodeMirror

const { FirestoreYProvider } = await import('../app/public/assets/js/collab.js');
const fake = await import('./helpers/fake-firestore.mjs');

const db = { name: 'fake' };
const wait = ms => new Promise(r => setTimeout(r, ms));

async function eventually(check, timeout = 3000) {
  const start = Date.now();
  for (;;) {
    try { return check(); } catch (err) {
      if (Date.now() - start > timeout) throw err;
      await wait(20);
    }
  }
}

const open = [];
function provider(uid, key = 'file-1') {
  const p = new FirestoreYProvider(db, 'room1', key, { uid, name: uid });
  open.push(p);
  return p;
}

beforeEach(async () => {
  await Promise.all(open.splice(0).map(p => p.destroy()));
  await fake.resetStore();
});
after(async () => { await Promise.all(open.splice(0).map(p => p.destroy())); });

test('two people opening a fresh file at once do not duplicate the seed text', async () => {
  const a = provider('alice');
  const b = provider('bob');
  await Promise.all([a.connect('hello world'), b.connect('hello world')]);
  assert.equal(a.getText(), 'hello world');
  assert.equal(b.getText(), 'hello world');
});

test('concurrent edits converge on every client', async () => {
  const a = provider('alice');
  const b = provider('bob');
  await a.connect('base');
  await b.connect('ignored because doc exists');
  assert.equal(b.getText(), 'base');

  a.ytext.insert(0, 'A-');
  b.ytext.insert(b.ytext.length, '-B');
  a.ytext.insert(2, 'x');
  await Promise.all([a.flush(), b.flush()]);

  await eventually(() => {
    assert.equal(a.getText(), b.getText());
    assert.equal(a.getText(), 'A-xbase-B');
  });
});

test('late joiner sees everything after compaction removed update docs', async () => {
  const a = provider('alice');
  await a.connect('');
  for (let i = 0; i < 40; i++) {
    a.ytext.insert(a.ytext.length, String(i % 10));
    await a.flush();
  }
  await eventually(() => assert.ok(fake.dump('rooms/room1/collab/file-1/updates/').length >= 40));
  await eventually(() => assert.equal(a.seenUpdateIds.size, 40));
  await a.compact();
  assert.equal(fake.dump('rooms/room1/collab/file-1/updates/').length, 0);

  a.ytext.insert(0, '>');
  await a.flush();

  const c = provider('carol');
  await c.connect('should not be used');
  await eventually(() => assert.equal(c.getText(), a.getText()));
  assert.ok(c.getText().startsWith('>0123456789'));
});

test('a compaction racing a new joiner does not lose edits', async () => {
  const a = provider('alice');
  await a.connect('');
  for (let i = 0; i < 20; i++) { a.ytext.insert(a.ytext.length, 'x'); await a.flush(); }
  await eventually(() => assert.equal(a.seenUpdateIds.size, 20));

  const c = provider('carol');
  await Promise.all([c.connect(''), a.compact()]);
  await eventually(() => assert.equal(c.getText(), 'x'.repeat(20)));
});

test('awareness shares who is in the document', async () => {
  const a = provider('alice');
  const b = provider('bob');
  await a.connect('');
  await b.connect('');
  await eventually(() => {
    assert.deepEqual(a.peers().map(p => p.name), ['bob']);
    assert.deepEqual(b.peers().map(p => p.name), ['alice']);
  });
  await b.destroy();
  await eventually(() => assert.equal(a.peers().length, 0));
});

test('replaceText swaps the whole document for everyone', async () => {
  const a = provider('alice');
  const b = provider('bob');
  await a.connect('old');
  await b.connect('');
  a.replaceText('new content');
  await a.flush();
  await eventually(() => assert.equal(b.getText(), 'new content'));
});
