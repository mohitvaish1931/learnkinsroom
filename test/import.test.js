const { test } = require('node:test');
const assert = require('node:assert/strict');
const Y = require('yjs');
const { listRepoFiles } = require('../app/lib/github');
const { replaceLiveText } = require('../app/lib/collab-server');

function repoFetch(files, { truncated = false } = {}) {
  const blobs = {};
  const tree = files.map((f, i) => {
    const sha = `b${i}`;
    blobs[sha] = Buffer.from(f.content, 'utf8');
    return { path: f.path, type: 'blob', sha, size: f.size ?? blobs[sha].length };
  });
  tree.push({ path: 'src', type: 'tree', sha: 'dir' });
  const calls = [];
  const fetchImpl = async url => {
    const path = url.replace('https://api.github.com', '');
    calls.push(path);
    const reply = (status, data) => ({ ok: status < 300, status, text: async () => JSON.stringify(data) });
    let m;
    if (path === '/repos/acme/demo/git/ref/heads/main') return reply(200, { object: { sha: 'c1' } });
    if (path.startsWith('/repos/acme/demo/git/ref/heads/')) return reply(404, { message: 'Not Found' });
    if (path === '/repos/acme/demo/git/commits/c1') return reply(200, { tree: { sha: 't1' } });
    if (path === '/repos/acme/demo/git/trees/t1?recursive=1') return reply(200, { tree, truncated });
    if ((m = path.match(/\/git\/blobs\/(\w+)$/))) return reply(200, { content: blobs[m[1]].toString('base64'), encoding: 'base64' });
    return reply(404, { message: 'unhandled ' + path });
  };
  return { fetchImpl, calls };
}

test('listRepoFiles keeps text files and skips binaries, deps and big files', async () => {
  const gh = repoFetch([
    { path: 'README.md', content: '# hi' },
    { path: 'src/app.js', content: 'console.log(1)' },
    { path: 'src/logo.png', content: 'PNG' },
    { path: 'node_modules/x/index.js', content: 'x' },
    { path: 'data.bin2', content: 'a\u0000b' },
    { path: 'huge.txt', content: 'x', size: 10_000_000 }
  ]);
  const r = await listRepoFiles({ token: 't', owner: 'acme', repo: 'demo', branch: 'main', fetchImpl: gh.fetchImpl });
  assert.equal(r.commitSha, 'c1');
  assert.deepEqual(r.files.map(f => [f.relPath, f.content]), [['README.md', '# hi'], ['src/app.js', 'console.log(1)']]);
  assert.deepEqual(r.skipped, { binary: 2, tooLarge: 1, ignoredDir: 1, overLimit: 0 });
  assert.ok(!gh.calls.some(c => c.includes('/blobs/b2')), 'binary by extension is never downloaded');
});

test('listRepoFiles honours the base folder and the file cap', async () => {
  const gh = repoFetch([
    { path: 'web/a.js', content: 'a' },
    { path: 'web/b.js', content: 'b' },
    { path: 'web/c.js', content: 'c' },
    { path: 'api/server.js', content: 's' }
  ]);
  const r = await listRepoFiles({ token: 't', owner: 'acme', repo: 'demo', branch: 'main', basePath: '/web/', maxFiles: 2, fetchImpl: gh.fetchImpl });
  assert.deepEqual(r.files.map(f => f.relPath), ['a.js', 'b.js']);
  assert.equal(r.skipped.overLimit, 1);
});

test('listRepoFiles explains a missing branch', async () => {
  const gh = repoFetch([]);
  await assert.rejects(listRepoFiles({ token: 't', owner: 'acme', repo: 'demo', branch: 'nope', fetchImpl: gh.fetchImpl }), /Branch "nope" not found/);
});

// Minimal stand-in for an Admin SDK DocumentReference with an `updates` subcollection.
function fakeCollabRef(state, updates = []) {
  const added = [];
  return {
    added,
    get: async () => ({ exists: state !== null, data: () => ({ state }) }),
    collection: () => ({
      get: async () => ({ docs: [...updates, ...added].map(u => ({ data: () => ({ u }) })) }),
      add: async doc => { added.push(doc.u); return {}; }
    })
  };
}

test('replaceLiveText appends one update that turns the live doc into the new text', async () => {
  const doc = new Y.Doc();
  doc.getText('code').insert(0, 'old text');
  const seed = Buffer.from(Y.encodeStateAsUpdate(doc));
  const sv = Y.encodeStateVector(doc);
  doc.getText('code').insert(8, ' + live edit');
  const liveEdit = Buffer.from(Y.encodeStateAsUpdate(doc, sv));

  const ref = fakeCollabRef(seed, [liveEdit]);
  assert.equal(await replaceLiveText(ref, 'imported', () => 'ts'), true);
  assert.equal(ref.added.length, 1);

  // A client that already had the live doc converges on the imported text.
  Y.applyUpdate(doc, new Uint8Array(ref.added[0]));
  assert.equal(doc.getText('code').toString(), 'imported');

  // Running again is a no-op.
  assert.equal(await replaceLiveText(ref, 'imported', () => 'ts'), false);
});

test('replaceLiveText does nothing when no live document exists', async () => {
  assert.equal(await replaceLiveText(fakeCollabRef(null), 'x', () => 'ts'), false);
});
