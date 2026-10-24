// Minimal GitHub client for pushing room files to a repository.
// Uses the Git Data API so several file changes land as a single commit.

const API = 'https://api.github.com';

class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

// Accepts "owner/repo", "https://github.com/owner/repo(.git)(/...)" or "git@github.com:owner/repo.git".
function parseRepo(input) {
  if (!input || typeof input !== 'string') return null;
  let value = input.trim();

  const ssh = value.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (ssh) return validRepo(ssh[1], ssh[2]);

  if (/^https?:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null;
    const [owner, repo] = url.pathname.split('/').filter(Boolean);
    return validRepo(owner, repo?.replace(/\.git$/i, ''));
  }

  const parts = value.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  return validRepo(parts[0], parts[1].replace(/\.git$/i, ''));
}

function validRepo(owner, repo) {
  const ok = /^[A-Za-z0-9_.-]+$/;
  if (!owner || !repo || !ok.test(owner) || !ok.test(repo)) return null;
  return { owner, repo };
}

// Joins the room's base folder with a file name, rejecting traversal and absolute paths.
function buildRepoPath(basePath, fileName) {
  const segments = [basePath || '', fileName || '']
    .join('/')
    .replace(/\\/g, '/')
    .split('/')
    .filter(s => s && s !== '.');
  if (!segments.length || segments.some(s => s === '..')) {
    throw new GitHubError(`Invalid file path: ${fileName}`, 400);
  }
  return segments.join('/');
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function createClient({ token, fetchImpl = globalThis.fetch }) {
  if (!token) throw new GitHubError('No GitHub token configured for this room', 400);

  async function request(method, path, body) {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'learnkins-room',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
    if (!res.ok) {
      throw new GitHubError(data?.message || `GitHub API ${res.status}`, res.status);
    }
    return data;
  }

  return { request };
}

async function testAccess({ token, owner, repo, fetchImpl }) {
  const { request } = createClient({ token, fetchImpl });
  const info = await request('GET', `/repos/${owner}/${repo}`);
  return {
    fullName: info.full_name,
    defaultBranch: info.default_branch,
    private: info.private,
    canPush: Boolean(info.permissions?.push)
  };
}

// Resolves the head commit of `branch`, creating the branch from the default
// branch when it doesn't exist yet. Returns null for a repository with no commits.
async function resolveHead(request, owner, repo, branch) {
  try {
    const ref = await request('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodePath(branch)}`);
    return ref.object.sha;
  } catch (err) {
    if (err.status !== 404 && err.status !== 409) throw err;
  }

  const info = await request('GET', `/repos/${owner}/${repo}`);
  let baseSha;
  try {
    const base = await request('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodePath(info.default_branch)}`);
    baseSha = base.object.sha;
  } catch (err) {
    if (err.status === 404 || err.status === 409) return null; // empty repository
    throw err;
  }
  await request('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
  return baseSha;
}

// The Git Data API can't create the first commit of an empty repo, so seed it
// through the Contents API, which can.
async function seedEmptyRepo(request, owner, repo, branch, file, message) {
  const res = await request('PUT', `/repos/${owner}/${repo}/contents/${encodePath(file.path)}`, {
    message,
    content: Buffer.from(file.content ?? '', 'utf8').toString('base64'),
    branch
  });
  return res.commit.sha;
}

/**
 * Commits `files` (upserts) and `deletions` (paths) to `branch` as one commit.
 * Retries when the branch moved underneath us (another push landed first).
 */
async function commitFiles({ token, owner, repo, branch = 'main', files = [], deletions = [], message, author, fetchImpl }) {
  const { request } = createClient({ token, fetchImpl });
  if (!files.length && !deletions.length) throw new GitHubError('Nothing to commit', 400);

  for (let attempt = 0; attempt < 3; attempt++) {
    let headSha = await resolveHead(request, owner, repo, branch);
    let pending = files;

    if (!headSha) {
      if (!files.length) throw new GitHubError('Repository is empty — nothing to delete', 400);
      headSha = await seedEmptyRepo(request, owner, repo, branch, files[0], message);
      pending = files.slice(1);
      if (!pending.length && !deletions.length) {
        return { commitSha: headSha, commitUrl: `https://github.com/${owner}/${repo}/commit/${headSha}`, changed: 1 };
      }
    }

    const headCommit = await request('GET', `/repos/${owner}/${repo}/git/commits/${headSha}`);
    const baseTree = headCommit.tree.sha;

    // Deleting a path that isn't in the tree makes GitHub reject the whole tree,
    // so only delete what actually exists.
    let existingDeletions = [];
    if (deletions.length) {
      const tree = await request('GET', `/repos/${owner}/${repo}/git/trees/${baseTree}?recursive=1`);
      const paths = new Set((tree.tree || []).filter(e => e.type === 'blob').map(e => e.path));
      existingDeletions = deletions.filter(p => paths.has(p));
    }

    const entries = [
      ...pending.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: f.content ?? '' })),
      ...existingDeletions.map(path => ({ path, mode: '100644', type: 'blob', sha: null }))
    ];
    if (!entries.length) {
      return { commitSha: headSha, commitUrl: `https://github.com/${owner}/${repo}/commit/${headSha}`, changed: 0 };
    }

    const tree = await request('POST', `/repos/${owner}/${repo}/git/trees`, { base_tree: baseTree, tree: entries });
    const commit = await request('POST', `/repos/${owner}/${repo}/git/commits`, {
      message,
      tree: tree.sha,
      parents: [headSha],
      ...(author?.name && author?.email ? { author: { name: author.name, email: author.email } } : {})
    });

    try {
      await request('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodePath(branch)}`, { sha: commit.sha, force: false });
    } catch (err) {
      if (err.status === 422 && attempt < 2) continue; // not a fast-forward: rebuild on the new head
      throw err;
    }

    return {
      commitSha: commit.sha,
      commitUrl: commit.html_url || `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
      changed: entries.length
    };
  }
  throw new GitHubError('Branch kept moving while pushing — try again', 409);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.next', 'coverage', '__pycache__', '.venv', 'venv', 'target', 'out']);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|jar|war|class|exe|dll|so|dylib|o|a|bin|wasm|woff2?|ttf|otf|eot|mp3|mp4|m4a|mov|avi|mkv|wav|flac|ogg|webm|psd|sketch|fig|sqlite|db|pyc)$/i;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

/**
 * Reads the text files under `basePath` on `branch`. Skips binaries, dependency
 * folders and oversized files, and caps the total so a large repo can't flood a room.
 * Returns paths relative to `basePath`.
 */
async function listRepoFiles({ token, owner, repo, branch = 'main', basePath = '', fetchImpl, maxFiles = 150, maxFileBytes = 300 * 1024, maxTotalBytes = 3 * 1024 * 1024 }) {
  const { request } = createClient({ token, fetchImpl });
  let headSha;
  try {
    headSha = (await request('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodePath(branch)}`)).object.sha;
  } catch (err) {
    if (err.status === 404 || err.status === 409) throw new GitHubError(`Branch "${branch}" not found (or the repository is empty)`, 404);
    throw err;
  }
  const commit = await request('GET', `/repos/${owner}/${repo}/git/commits/${headSha}`);
  const tree = await request('GET', `/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`);

  const prefix = basePath ? basePath.replace(/^\/+|\/+$/g, '') + '/' : '';
  const skipped = { binary: 0, tooLarge: 0, ignoredDir: 0, overLimit: 0 };
  const candidates = [];
  let total = 0;

  for (const entry of (tree.tree || []).filter(e => e.type === 'blob').sort((a, b) => a.path.localeCompare(b.path))) {
    if (prefix && !entry.path.startsWith(prefix)) continue;
    const rel = entry.path.slice(prefix.length);
    if (rel.split('/').some(seg => SKIP_DIRS.has(seg))) { skipped.ignoredDir++; continue; }
    if (BINARY_EXT.test(rel)) { skipped.binary++; continue; }
    if ((entry.size || 0) > maxFileBytes) { skipped.tooLarge++; continue; }
    if (candidates.length >= maxFiles || total + (entry.size || 0) > maxTotalBytes) { skipped.overLimit++; continue; }
    total += entry.size || 0;
    candidates.push({ path: entry.path, relPath: rel, sha: entry.sha });
  }

  const blobs = await mapLimit(candidates, 8, c => request('GET', `/repos/${owner}/${repo}/git/blobs/${c.sha}`));
  const files = [];
  candidates.forEach((c, i) => {
    const buf = Buffer.from(blobs[i].content || '', blobs[i].encoding === 'base64' ? 'base64' : 'utf8');
    if (buf.includes(0)) { skipped.binary++; return; } // binary without a telltale extension
    files.push({ path: c.path, relPath: c.relPath, content: buf.toString('utf8') });
  });

  return { commitSha: headSha, files, skipped, truncated: Boolean(tree.truncated) };
}

module.exports = { parseRepo, buildRepoPath, testAccess, commitFiles, listRepoFiles, GitHubError };
