// Runs editor code in the browser, isolated from the page:
//   JavaScript → a throwaway Web Worker (terminated on timeout, so infinite loops are safe)
//   Python     → Pyodide inside a Web Worker (loaded on first use)
//   HTML       → a sandboxed iframe preview (handled by the caller)

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/';

const JS_WORKER = `
const fmt = v => {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || v.message;
  try { return JSON.stringify(v, null, 2) ?? String(v); } catch { return String(v); }
};
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => postMessage({ type: 'out', level, text: args.map(fmt).join(' ') });
}
self.onmessage = async ({ data }) => {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const result = await new AsyncFunction(data.code)();
    if (result !== undefined) postMessage({ type: 'out', level: 'result', text: fmt(result) });
    postMessage({ type: 'done' });
  } catch (err) {
    postMessage({ type: 'out', level: 'error', text: err && err.stack ? err.stack : String(err) });
    postMessage({ type: 'done', error: true });
  }
};`;

const PY_WORKER = `
importScripts('${PYODIDE_URL}pyodide.js');
let ready = loadPyodide({ indexURL: '${PYODIDE_URL}' }).then(py => {
  py.setStdout({ batched: s => postMessage({ type: 'out', level: 'log', text: s }) });
  py.setStderr({ batched: s => postMessage({ type: 'out', level: 'error', text: s }) });
  return py;
});
self.onmessage = async ({ data }) => {
  try {
    const py = await ready;
    postMessage({ type: 'ready' });
    await py.loadPackagesFromImports(data.code);
    const result = await py.runPythonAsync(data.code);
    if (result !== undefined && result !== null) postMessage({ type: 'out', level: 'result', text: String(result) });
    postMessage({ type: 'done' });
  } catch (err) {
    postMessage({ type: 'out', level: 'error', text: String(err && err.message || err) });
    postMessage({ type: 'done', error: true });
  }
};`;

const workerFrom = source => new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));

let pyWorker = null;

export function runtimeFor(language, fileName = '') {
  if (language === 'python' || /\.py$/i.test(fileName)) return 'python';
  if (language === 'xml' || /\.html?$/i.test(fileName)) return 'html';
  if (language === 'javascript' && !/\.(json|ts|tsx|jsx)$/i.test(fileName)) return 'javascript';
  return null;
}

/**
 * Runs `code` and streams output through `onOutput({ level, text })`.
 * Resolves with { ok, timedOut, ms }.
 */
export function runCode({ code, runtime, onOutput, onStatus = () => { }, timeoutMs = 10000 }) {
  return new Promise(resolve => {
    const started = performance.now();
    let worker;
    if (runtime === 'javascript') {
      worker = workerFrom(JS_WORKER);
    } else if (runtime === 'python') {
      if (!pyWorker) { onStatus('Loading Python runtime (first run takes a few seconds)…'); pyWorker = workerFrom(PY_WORKER); }
      worker = pyWorker;
    } else {
      resolve({ ok: false, error: `Can't run ${runtime || 'this language'} in the browser` });
      return;
    }

    let timer = null;
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        worker.terminate();
        if (worker === pyWorker) pyWorker = null;
        onOutput({ level: 'error', text: `Stopped: exceeded ${timeoutMs / 1000}s time limit` });
        resolve({ ok: false, timedOut: true, ms: performance.now() - started });
      }, timeoutMs);
    };
    // Python's timeout starts once the runtime has loaded, not during the download.
    if (runtime === 'javascript') armTimeout();

    worker.onmessage = ({ data }) => {
      if (data.type === 'ready') { onStatus('Running…'); armTimeout(); return; }
      if (data.type === 'out') { onOutput({ level: data.level, text: data.text }); return; }
      if (data.type === 'done') {
        clearTimeout(timer);
        if (runtime === 'javascript') worker.terminate();
        resolve({ ok: !data.error, ms: performance.now() - started });
      }
    };
    worker.onerror = e => {
      clearTimeout(timer);
      onOutput({ level: 'error', text: e.message || 'Worker error' });
      if (runtime === 'javascript') worker.terminate();
      resolve({ ok: false, ms: performance.now() - started });
    };
    worker.postMessage({ code });
  });
}
