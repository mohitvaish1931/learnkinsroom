const { test } = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, sanitizeFileName, normalizeRoomFileName, languageForFile } = require('../app/lib/utils');

test('escapeHtml escapes markup and quotes', () => {
  assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(escapeHtml(undefined), '');
});

test('sanitizeFileName strips paths and odd characters', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('my photo (1).png'), 'my_photo_1_.png');
  assert.equal(sanitizeFileName('..hidden'), 'hidden');
  assert.equal(sanitizeFileName(''), 'file');
});

test('normalizeRoomFileName keeps folders but rejects traversal', () => {
  assert.equal(normalizeRoomFileName(' src//app.js '), 'src/app.js');
  assert.equal(normalizeRoomFileName('a\\b.py'), 'a/b.py');
  assert.throws(() => normalizeRoomFileName('../x.js'), /cannot contain/);
  assert.throws(() => normalizeRoomFileName('   '), /required/);
});

test('languageForFile maps extensions to CodeMirror modes', () => {
  assert.equal(languageForFile('main.py'), 'python');
  assert.equal(languageForFile('index.html'), 'xml');
  assert.equal(languageForFile('lib.cpp'), 'text/x-c++src');
  assert.equal(languageForFile('app.ts'), 'javascript');
});
