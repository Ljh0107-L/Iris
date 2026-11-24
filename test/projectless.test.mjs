// Pure regressions for No-folder conversations (Codex's projectless layout); also imported by e2e.mjs.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectlessNote } from '../agent/iris-bridge.js';
import { projectlessSlug } from '../app/main/session-manager.mjs';

assert.equal(projectlessSlug('Fix the login bug in the settings page please'), 'fix-the-login-bug-in-the');
assert.equal(projectlessSlug('画一个鹈鹕骑自行车的html'), '画一个鹈鹕骑自行车的html');
assert.equal(projectlessSlug('你好'), '你好');
assert.equal(projectlessSlug('帮我看一下这个仓库的登录逻辑有没有问题,顺便修一下'), '帮我看一下这个仓库的登录逻辑有没有问题-顺便修一');
assert.equal(projectlessSlug('!!!'), 'new-chat');
assert.equal(projectlessSlug('/goal Ship the release'), 'ship-the-release');

const root = mkdtempSync(join(tmpdir(), 'iris-projectless-'));
const thread = join(root, '2026-11-01', 'fix-the-bug');
mkdirSync(join(thread, 'work'), { recursive: true });
mkdirSync(join(thread, 'outputs'));
const saved = process.env.IRIS_PROJECTLESS;
try {
  delete process.env.IRIS_PROJECTLESS;
  assert.equal(projectlessNote(thread), null, 'only Pis the desktop marks as No folder');
  process.env.IRIS_PROJECTLESS = '1';
  const note = projectlessNote(thread);
  assert.ok(note.includes(join(thread, 'outputs')) && note.includes('work/'), 'deliverables go to outputs/, scratch to work/');
  assert.equal(projectlessNote(root), null, 'older No-folder conversations ran in the root itself');
  assert.equal(projectlessNote(join(root, 'Iris')), null, 'a folder the user picked inside the root is a project');
} finally {
  if (saved === undefined) delete process.env.IRIS_PROJECTLESS; else process.env.IRIS_PROJECTLESS = saved;
}
console.log('PASS  No folder: Codex-style names, projectless prompt section only for generated directories');
