import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, diffStats, unifiedDiff } from '../app/public/assets/js/diff.js';

function rebuild(ops) {
  return {
    oldText: ops.filter(o => o.type !== 'add').map(o => o.text),
    newText: ops.filter(o => o.type !== 'del').map(o => o.text)
  };
}

test('identical text has no changes', () => {
  const ops = diffLines('a\nb\nc', 'a\nb\nc');
  assert.deepEqual(diffStats(ops), { added: 0, removed: 0 });
});

test('reports added, removed and changed lines', () => {
  const ops = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(diffStats(ops), { added: 2, removed: 1 });
  assert.deepEqual(ops.filter(o => o.type !== 'same').map(o => o.type + o.text), ['delb', 'addB', 'adde']);
});

test('handles empty sides', () => {
  assert.deepEqual(diffStats(diffLines('', 'x\ny')), { added: 2, removed: 0 });
  assert.deepEqual(diffStats(diffLines('x\ny', '')), { added: 0, removed: 2 });
  assert.deepEqual(diffLines('', ''), []);
});

test('the edit script always reproduces both inputs (random)', () => {
  const alphabet = ['a', 'b', 'c', 'd'];
  for (let i = 0; i < 300; i++) {
    const rand = () => Array.from({ length: Math.floor(Math.random() * 12) }, () => alphabet[Math.floor(Math.random() * 4)]);
    const a = rand(), b = rand();
    const ops = diffLines(a.join('\n'), b.join('\n'));
    const r = rebuild(ops);
    assert.deepEqual(r.oldText, a);
    assert.deepEqual(r.newText, b);
  }
});

test('unified diff marks lines and elides distant context', () => {
  const oldText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const newText = oldText.replace('line 10', 'line ten');
  const text = unifiedDiff(diffLines(oldText, newText), 1);
  assert.match(text, /-line 10\n\+line ten/);
  assert.match(text, /^@@ … @@/);
});
