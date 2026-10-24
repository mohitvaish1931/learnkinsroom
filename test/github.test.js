const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRepo, buildRepoPath, commitFiles, testAccess } = require('../app/lib/github');

test('parseRepo accepts the common formats', () => {
  assert.deepEqual(parseRepo('https://github.com/acme/demo'), { owner: 'acme', repo: 'demo' });
  assert.deepEqual(parseRepo('https://github.com/acme/demo.git'), { owner: 'acme', repo: 'demo' });
  assert.deepEqual(parseRepo('https://github.com/acme/demo/tree/main/src'), { owner: 'acme', repo: 'demo' });
  assert.deepEqual(parseRepo('git@github.com:acme/demo.git'), { owner: 'acme', repo: 'demo' });
  assert.deepEqual(parseRepo('acme/demo'), { owner: 'acme', repo: 'demo' });
  assert.equal(parseRepo('https://gitlab.com/acme/demo'), null);
  assert.equal(parseRepo('javascript:alert(1)'), null);
  assert.equal(parseRepo(''), null);
  assert.equal(parseRepo('acme/de mo'), null);
});

test('buildRepoPath joins folders and rejects traversal', () => {
  assert.equal(buildRepoPath('', 'app.js'), 'app.js');
  assert.equal(buildRepoPath('src/', '/lib/util.js'), 'src/lib/util.js');
  assert.equal(buildRepoPath('a\\b', 'c.js'), 'a/b/c.js');
  assert.throws(() => buildRepoPath('', '../secrets'), /Invalid file path/);
  assert.throws(() => buildRepoPath('', ''), /Invalid file path/);
});

// A tiny in-memory GitHub that understands the Git Data API calls we make.
function fakeGitHub({ empty = false, branches = { main: 'c0' }, defaultBranch = 'main', raceOnce = false } = {}) {
  const trees = { t0: [{ path: 'old.js', type: 'blob' }, { path: 'keep.js', type: 'blob' }] };
  const commits = { c0: { tree: 't0' } };
  const refs = empty ? {} : { ...branches };
  const calls = [];
  let n = 0;
  let raced = false;

  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const path = url.replace('https://api.github.com', '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push(`${method} ${path}`);
    const reply = (status, data) => ({ ok: status < 300, status, text: async () => JSON.stringify(data) });

    let m;
    if (method === 'GET' && path === '/repos/acme/demo') {
      return reply(200, { full_name: 'acme/demo', default_branch: defaultBranch, private: true, permissions: { push: true } });
    }
    if ((m = path.match(/^\/repos\/acme\/demo\/git\/ref\/heads\/(.+)$/)) && method === 'GET') {
      if (empty) return reply(409, { message: 'Git Repository is empty.' });
      return refs[m[1]] ? reply(200, { object: { sha: refs[m[1]] } }) : reply(404, { message: 'Not Found' });
    }
    if (path === '/repos/acme/demo/git/refs' && method === 'POST') {
      refs[body.ref.replace('refs/heads/', '')] = body.sha;
      return reply(201, {});
    }
    if ((m = path.match(/^\/repos\/acme\/demo\/git\/commits\/(.+)$/)) && method === 'GET') {
      return reply(200, { tree: { sha: commits[m[1]].tree } });
    }
    if ((m = path.match(/^\/repos\/acme\/demo\/git\/trees\/([^?]+)/)) && method === 'GET') {
      return reply(200, { tree: trees[m[1]] });
    }
    if (path === '/repos/acme/demo/git/trees' && method === 'POST') {
      if (body.tree.some(e => e.sha === null && !trees[body.base_tree].some(t => t.path === e.path))) {
        return reply(422, { message: 'tree.sha is not a valid blob' });
      }
      const id = `t${++n}`;
      trees[id] = body.tree;
      return reply(201, { sha: id });
    }
    if (path === '/repos/acme/demo/git/commits' && method === 'POST') {
      const id = `c${++n}`;
      commits[id] = { tree: body.tree, parents: body.parents, message: body.message, author: body.author };
      return reply(201, { sha: id, html_url: `https://github.com/acme/demo/commit/${id}` });
    }
    if ((m = path.match(/^\/repos\/acme\/demo\/git\/refs\/heads\/(.+)$/)) && method === 'PATCH') {
      if (raceOnce && !raced) {
        raced = true;
        refs[m[1]] = 'c0'; // someone else pushed; our parent is stale
        return reply(422, { message: 'Update is not a fast forward' });
      }
      refs[m[1]] = body.sha;
      return reply(200, {});
    }
    if ((m = path.match(/^\/repos\/acme\/demo\/contents\/(.+)$/)) && method === 'PUT') {
      const id = `c${++n}`;
      commits[id] = { tree: 't0' };
      refs[body.branch] = id;
      return reply(201, { commit: { sha: id } });
    }
    return reply(404, { message: `unhandled ${method} ${path}` });
  };
  return { fetchImpl, calls, refs, commits, trees };
}

test('commitFiles writes several files and deletions as one commit', async () => {
  const gh = fakeGitHub();
  const res = await commitFiles({
    token: 't', owner: 'acme', repo: 'demo', branch: 'main', fetchImpl: gh.fetchImpl,
    files: [{ path: 'a.js', content: 'A' }, { path: 'src/b.py', content: 'B' }],
    deletions: ['old.js', 'never-existed.js'],
    message: 'Sync', author: { name: 'Alice', email: 'a@x.dev' }
  });
  assert.equal(res.changed, 3);
  assert.equal(gh.refs.main, res.commitSha);
  const commit = gh.commits[res.commitSha];
  assert.deepEqual(commit.parents, ['c0']);
  assert.deepEqual(commit.author, { name: 'Alice', email: 'a@x.dev' });
  const tree = gh.trees[commit.tree];
  assert.deepEqual(tree.map(e => [e.path, e.sha === null ? 'deleted' : e.content]),
    [['a.js', 'A'], ['src/b.py', 'B'], ['old.js', 'deleted']]);
  assert.match(res.commitUrl, /github\.com\/acme\/demo\/commit\//);
});

test('commitFiles creates a missing branch from the default branch', async () => {
  const gh = fakeGitHub();
  const res = await commitFiles({ token: 't', owner: 'acme', repo: 'demo', branch: 'learnkins', fetchImpl: gh.fetchImpl, files: [{ path: 'x.js', content: 'x' }], message: 'm' });
  assert.ok(gh.calls.includes('POST /repos/acme/demo/git/refs'));
  assert.equal(gh.refs.learnkins, res.commitSha);
  assert.equal(gh.refs.main, 'c0');
});

test('commitFiles seeds an empty repository through the contents API', async () => {
  const gh = fakeGitHub({ empty: true });
  const res = await commitFiles({ token: 't', owner: 'acme', repo: 'demo', branch: 'main', fetchImpl: gh.fetchImpl, files: [{ path: 'first.js', content: '1' }], message: 'init' });
  assert.ok(gh.calls.some(c => c.startsWith('PUT /repos/acme/demo/contents/first.js')));
  assert.equal(res.changed, 1);
});

test('commitFiles rebuilds on top of a branch that moved', async () => {
  const gh = fakeGitHub({ raceOnce: true });
  const res = await commitFiles({ token: 't', owner: 'acme', repo: 'demo', branch: 'main', fetchImpl: gh.fetchImpl, files: [{ path: 'x.js', content: 'x' }], message: 'm' });
  assert.equal(gh.refs.main, res.commitSha);
  assert.equal(gh.calls.filter(c => c.startsWith('PATCH')).length, 2);
});

test('errors carry the GitHub status and message', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'Bad credentials' }) });
  await assert.rejects(testAccess({ token: 'bad', owner: 'acme', repo: 'demo', fetchImpl }), err => err.status === 401 && /Bad credentials/.test(err.message));
  await assert.rejects(commitFiles({ token: '', owner: 'a', repo: 'b', files: [{ path: 'x', content: '' }], message: 'm' }), /No GitHub token/);
});
