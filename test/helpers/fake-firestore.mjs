// A small in-memory stand-in for the Firestore web SDK — just the calls the
// browser modules use. Snapshot delivery is asynchronous (with jitter) to mimic
// network latency, but ordered per listener like the real SDK.

const store = new Map();          // path -> data
const listeners = new Set();
let txLock = Promise.resolve();
let writeChain = Promise.resolve();

// Writes from one client reach the server in order, as with the real SDK.
function queued(fn) {
  const run = writeChain.then(() => new Promise(r => setTimeout(r, Math.random() * 3))).then(fn);
  writeChain = run.catch(() => { });
  return run;
}

export async function resetStore() { await writeChain; store.clear(); listeners.clear(); }
export function dump(prefix = '') {
  return [...store.keys()].filter(k => k.startsWith(prefix));
}

export class Bytes {
  constructor(u8) { this._u8 = new Uint8Array(u8); }
  static fromUint8Array(u8) { return new Bytes(u8); }
  toUint8Array() { return new Uint8Array(this._u8); }
}

const SERVER_TS = Symbol('serverTimestamp');

// Behaves like a Firestore Timestamp, and compares like a number for sorting.
class FakeTimestamp {
  constructor(ms) { this.ms = ms; }
  toMillis() { return this.ms; }
  toDate() { return new Date(this.ms); }
  valueOf() { return this.ms; }
}
let lastTs = 0;
const nextTimestamp = () => new FakeTimestamp(lastTs = Math.max(Date.now(), lastTs + 1));
export const serverTimestamp = () => SERVER_TS;

function join(base, segs) { return [base, ...segs].filter(Boolean).join('/'); }
function basePath(x) { return x && x.path ? x.path : ''; }

export function doc(parent, ...segs) {
  if (parent.kind === 'col' && segs.length === 1) return { kind: 'doc', path: `${parent.path}/${segs[0]}`, id: segs[0] };
  const path = join(basePath(parent), segs);
  return { kind: 'doc', path, id: path.split('/').pop() };
}
export function collection(parent, ...segs) {
  return { kind: 'col', path: join(basePath(parent), segs) };
}
export const getFirestore = () => ({ fake: true });
export const orderBy = (field, dir = 'asc') => ({ type: 'orderBy', field, dir });
export const startAfter = snap => ({ type: 'startAfter', snap });
export const where = (field, op, value) => ({ type: 'where', field, op, value });
export const limit = n => ({ type: 'limit', n });
export function query(col, ...constraints) { return { kind: 'query', path: col.path, constraints }; }

function resolveData(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) out[k] = v === SERVER_TS ? nextTimestamp() : v;
  return out;
}

function snapDoc(path, data) {
  return { id: path.split('/').pop(), ref: { kind: 'doc', path }, data: () => data && { ...data }, exists: () => data !== undefined, metadata: { hasPendingWrites: false } };
}

function inCollection(colPath, docPath) {
  return docPath.startsWith(colPath + '/') && !docPath.slice(colPath.length + 1).includes('/');
}

function matches(q, data) {
  return (q.constraints || []).every(c => {
    if (c.type !== 'where') return true;
    if (c.op === '==') return data[c.field] === c.value;
    return true;
  });
}

function runQuery(q) {
  let docs = [...store.entries()].filter(([p, d]) => inCollection(q.path, p) && matches(q, d));
  const ob = (q.constraints || []).find(c => c.type === 'orderBy');
  if (ob) {
    const sign = ob.dir === 'desc' ? -1 : 1;
    docs.sort((a, b) => sign * ((a[1][ob.field] ?? 0) - (b[1][ob.field] ?? 0)) || a[0].localeCompare(b[0]));
  }
  const lim = (q.constraints || []).find(c => c.type === 'limit');
  if (lim) docs = docs.slice(0, lim.n);
  return docs.map(([p, d]) => snapDoc(p, d));
}

function write(path, data) {
  const before = store.get(path);
  if (data === undefined) store.delete(path); else store.set(path, data);
  for (const l of listeners) l.notify(path, before, data);
}

export function onSnapshot(target, next, onError) {
  const isDoc = target.kind === 'doc';
  const q = isDoc ? null : (target.kind === 'col' ? { path: target.path, constraints: [] } : target);
  let chain = Promise.resolve();
  let active = true;
  const deliver = snapFactory => {
    chain = chain.then(() => new Promise(r => setTimeout(r, Math.random() * 4))).then(() => {
      if (active) next(snapFactory());
    }).catch(err => onError?.(err));
  };

  const listener = {
    notify(path, before, after) {
      if (isDoc) {
        if (path !== target.path) return;
        const data = after && { ...after };
        deliver(() => snapDoc(path, data));
        return;
      }
      if (!inCollection(q.path, path)) return;
      const wasIn = before !== undefined && matches(q, before);
      const isIn = after !== undefined && matches(q, after);
      if (!wasIn && !isIn) return;
      const type = !wasIn ? 'added' : !isIn ? 'removed' : 'modified';
      const changed = snapDoc(path, isIn ? { ...after } : { ...before });
      const docs = runQuery(q);
      deliver(() => ({ docs, size: docs.length, empty: !docs.length, docChanges: () => [{ type, doc: changed }] }));
    }
  };
  listeners.add(listener);

  if (isDoc) {
    const data = store.get(target.path);
    deliver(() => snapDoc(target.path, data && { ...data }));
  } else {
    const docs = runQuery(q);
    deliver(() => ({ docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map(d => ({ type: 'added', doc: d })) }));
  }
  return () => { active = false; listeners.delete(listener); };
}

export async function getDoc(ref) { return snapDoc(ref.path, store.get(ref.path)); }
export async function getDocs(q) {
  const docs = runQuery(q.kind === 'col' ? { path: q.path, constraints: [] } : q);
  return { docs, empty: !docs.length, size: docs.length };
}

export function addDoc(col, data) {
  const id = Math.random().toString(36).slice(2, 12);
  return queued(() => {
    write(`${col.path}/${id}`, resolveData(data));
    return { kind: 'doc', path: `${col.path}/${id}`, id };
  });
}
export function setDoc(ref, data, opts) {
  return queued(() => {
    const prev = opts?.merge ? store.get(ref.path) || {} : {};
    write(ref.path, { ...prev, ...resolveData(data) });
  });
}
export function updateDoc(ref, data) {
  return queued(() => {
    if (!store.has(ref.path)) throw new Error('not-found');
    write(ref.path, { ...store.get(ref.path), ...resolveData(data) });
  });
}
export function deleteDoc(ref) { return queued(() => write(ref.path, undefined)); }

export function writeBatch() {
  const ops = [];
  return {
    set(ref, data, opts) { ops.push(() => write(ref.path, { ...(opts?.merge ? store.get(ref.path) || {} : {}), ...resolveData(data) })); },
    delete(ref) { ops.push(() => write(ref.path, undefined)); },
    async commit() { ops.forEach(op => op()); }
  };
}

// Transactions are serialised, which gives the same isolation the real
// optimistic-retry implementation guarantees.
export function runTransaction(db, fn) {
  const run = txLock.then(async () => {
    await new Promise(r => setTimeout(r, Math.random() * 3));
    const ops = [];
    const tx = {
      get: async ref => snapDoc(ref.path, store.get(ref.path)),
      set: (ref, data, opts) => { ops.push(() => write(ref.path, { ...(opts?.merge ? store.get(ref.path) || {} : {}), ...resolveData(data) })); return tx; },
      update: (ref, data) => { ops.push(() => write(ref.path, { ...store.get(ref.path), ...resolveData(data) })); return tx; },
      delete: ref => { ops.push(() => write(ref.path, undefined)); return tx; }
    };
    const result = await fn(tx);
    ops.forEach(op => op());
    return result;
  });
  txLock = run.catch(() => { });
  return run;
}
