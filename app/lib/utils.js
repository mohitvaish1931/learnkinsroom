class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Keeps uploaded object names to a safe, readable subset.
function sanitizeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').slice(0, 120);
  return cleaned.replace(/^\.+/, '') || 'file';
}

// Room file names may contain folders ("src/app.js") but never traversal.
function normalizeRoomFileName(name) {
  const segments = String(name || '')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map(s => s.trim())
    .filter(s => s && s !== '.');
  if (!segments.length) throw new HttpError(400, 'fileName required');
  if (segments.some(s => s === '..')) throw new HttpError(400, 'fileName cannot contain ".."');
  const joined = segments.join('/');
  if (joined.length > 200) throw new HttpError(400, 'fileName too long');
  return joined;
}

function languageForFile(fileName) {
  const ext = String(fileName).split('.').pop().toLowerCase();
  return {
    py: 'python',
    html: 'xml', htm: 'xml', xml: 'xml',
    css: 'css',
    java: 'text/x-java',
    c: 'text/x-csrc', h: 'text/x-csrc',
    cpp: 'text/x-c++src', cc: 'text/x-c++src', hpp: 'text/x-c++src'
  }[ext] || 'javascript';
}

// Wraps an async route so thrown HttpErrors become JSON responses.
const handle = fn => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error(`${req.method} ${req.originalUrl}:`, err.message);
    if (!res.headersSent) res.status(status).json({ error: err.message || 'Internal error' });
  }
};

module.exports = { HttpError, escapeHtml, sanitizeFileName, normalizeRoomFileName, languageForFile, handle };
