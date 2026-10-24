// Line-based diff (Myers' O(ND) algorithm) for reviewing pull requests.

function splitLines(text) {
  if (!text) return [];
  const lines = String(text).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Returns [{ type: 'same' | 'add' | 'del', text, oldNo?, newNo? }].
export function diffLines(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length, m = b.length, max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace = [];

  outer:
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[max + k - 1] < v[max + k + 1])) ? v[max + k + 1] : v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[max + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  // Walk the trace backwards to recover the edit script.
  const ops = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && vd[max + k - 1] < vd[max + k + 1])) ? k + 1 : k - 1;
    const prevX = vd[max + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push({ type: 'same', text: a[--x], oldNo: x + 1, newNo: --y + 1 });
    if (d === 0) break;
    if (x === prevX) ops.push({ type: 'add', text: b[--y], newNo: y + 1 });
    else ops.push({ type: 'del', text: a[--x], oldNo: x + 1 });
  }
  return ops.reverse();
}

export function diffStats(ops) {
  return {
    added: ops.filter(o => o.type === 'add').length,
    removed: ops.filter(o => o.type === 'del').length
  };
}

// Unified-diff text (with context) — compact enough to send to the AI reviewer.
export function unifiedDiff(ops, context = 3) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op.type === 'same') return;
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = true;
  });
  const out = [];
  let skipping = false;
  ops.forEach((op, i) => {
    if (!keep[i]) { if (!skipping) { out.push('@@ … @@'); skipping = true; } return; }
    skipping = false;
    out.push((op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' ') + op.text);
  });
  return out.join('\n');
}
