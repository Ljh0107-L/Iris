import assert from 'node:assert/strict';
import test from 'node:test';
import { headingSlug, normalizeFilePath, relativeSessionPath, resolveMarkdownReference } from '../app/renderer/src/file-paths.js';

test('Markdown references resolve from the document, decode once and strip URL suffixes before decoding', () => {
  const doc = '/project/report/draft-zh.md';
  assert.deepEqual(resolveMarkdownReference('figures/wrf-call-tree.svg', doc), { kind: 'file', path: '/project/report/figures/wrf-call-tree.svg', fragment: '' });
  assert.deepEqual(resolveMarkdownReference('../a%20%E5%9B%BE%23%25.svg?raw=1#view', doc), { kind: 'file', path: '/project/a 图#%.svg', fragment: 'view' });
  assert.equal(resolveMarkdownReference('figures/100%25.svg', doc).path, '/project/report/figures/100%.svg');
  assert.equal(resolveMarkdownReference('figures/literal%2520.svg', doc).path, '/project/report/figures/literal%20.svg');
  assert.equal(resolveMarkdownReference('/absolute/image.png', doc).path, '/absolute/image.png');
  assert.equal(resolveMarkdownReference('~/image.png', doc).path, '~/image.png');
  assert.equal(resolveMarkdownReference('../figures/a.svg', 'report/nested/readme.md').path, 'report/figures/a.svg');
  assert.equal(resolveMarkdownReference('note.md').path, 'note.md');
  assert.equal(resolveMarkdownReference('bad%ZZ.png', doc).path, '/project/report/bad%ZZ.png');
});

test('literal file-tree/tool paths keep percent and hash characters and deduplicate dot paths', () => {
  assert.equal(relativeSessionPath('/project', '/project/./report/../100%20#test.md'), '100%20#test.md');
  assert.equal(relativeSessionPath('/project', 'new\nline.md'), 'new\nline.md');
  assert.equal(relativeSessionPath('/project/', '/project/file.md'), 'file.md');
  assert.equal(relativeSessionPath('/project', '/project-two/file.md'), '/project-two/file.md');
  assert.equal(relativeSessionPath('/project', 'file:///project/100%2520%23test.md'), '100%20#test.md');
  assert.equal(relativeSessionPath('/project', 'file://other-host/project/file.md'), null);
  assert.equal(normalizeFilePath('../../file.md'), '../../file.md');
  assert.equal(normalizeFilePath('/../../file.md'), '/file.md');
});

test('anchors, external destinations and unsafe schemes are classified explicitly', () => {
  assert.deepEqual(resolveMarkdownReference('#%E6%A0%87%E9%A2%98'), { kind: 'anchor', fragment: '标题' });
  assert.deepEqual(resolveMarkdownReference('//example.com/a.png'), { kind: 'external', url: 'https://example.com/a.png' });
  assert.equal(resolveMarkdownReference('https://example.com/a.png').kind, 'external');
  assert.equal(resolveMarkdownReference('mailto:user@example.com').kind, 'external');
  assert.equal(resolveMarkdownReference('data:image/svg+xml;base64,PHN2Zy8+').kind, 'image');
  for (const src of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:foo', 'file://evil/a', 'a%00.png', 'a\\b.svg', '']) {
    assert.equal(resolveMarkdownReference(src).kind, 'blocked', src);
  }
  assert.equal(headingSlug('Preview details'), 'preview-details');
  assert.equal(headingSlug('第一部分 · 拆解 WRF'), '第一部分--拆解-wrf');
});


test('links to a line of a file: file:///…#L12 as Antigravity writes them, path:12 as Codex does', () => {
  assert.deepEqual(resolveMarkdownReference('file:///home/me/app/notes.txt#L2'), { kind: 'file', path: '/home/me/app/notes.txt', fragment: 'L2', line: 2 });
  assert.equal(resolveMarkdownReference('file:///home/me/app/a.js#L12-L20').line, 12);
  assert.deepEqual(resolveMarkdownReference('/home/me/app/src/app.ts:12'), { kind: 'file', path: '/home/me/app/src/app.ts', fragment: '', line: 12 });
  assert.deepEqual(resolveMarkdownReference('src/app.ts:12:3', '/home/me/app/README.md'), { kind: 'file', path: '/home/me/app/src/app.ts', fragment: '', line: 12 });
  // A bare name with a line is a file, not a URL scheme; a real scheme is still refused.
  assert.deepEqual(resolveMarkdownReference('app.ts:7'), { kind: 'file', path: 'app.ts', fragment: '', line: 7 });
  assert.equal(resolveMarkdownReference('javascript:alert(1)').kind, 'blocked');
  assert.equal(resolveMarkdownReference('vscode://file/x:12').kind, 'blocked');
  // No line: nothing is added.
  assert.deepEqual(resolveMarkdownReference('file:///home/me/site/index.html'), { kind: 'file', path: '/home/me/site/index.html', fragment: '' });
});
