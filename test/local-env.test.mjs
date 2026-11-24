// What agents and the desktop get from the machine they run on: the login shell's PATH, text read over
// SSH, and names that are not ASCII.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { mergePath, parseShellEnv, resolveShellEnv, shellEnvCommand } from '../app/main/shell-env.mjs';
import { runSsh } from '../app/main/remote-setup.mjs';
import { safeFileName } from '../app/main/session-manager.mjs';
import { closestModel } from '../app/main/builtin-providers.mjs';
import { displayBlocks, findBlocks } from '../app/renderer/src/transcript.js';

const MARK = '__IRIS_SHELL_ENV__';

test('the login shell is asked for its PATH; a profile may print around the answer', () => {
  assert.deepEqual(shellEnvCommand('/bin/zsh').args.slice(0, 1), ['-ilc']);
  assert.deepEqual(parseShellEnv(`Last login…\n${MARK}/opt/homebrew/bin:/usr/bin:relative${MARK}zh_CN.UTF-8${MARK}\nbye`), { path: ['/opt/homebrew/bin', '/usr/bin'], lang: 'zh_CN.UTF-8' });
  assert.equal(parseShellEnv('no markers at all'), null);
  assert.equal(parseShellEnv(`${MARK}${MARK}${MARK}`), null, 'an empty PATH is no answer');
  assert.equal(mergePath(['/opt/homebrew/bin', '/usr/bin'], '/usr/bin:/bin'), ['/opt/homebrew/bin', '/usr/bin', '/bin'].join(delimiter));
});

test('agents get the shell PATH ahead of the app PATH, and still start when the shell cannot be asked', async () => {
  const env = { HOME: '/Users/x', SHELL: '/bin/zsh', PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' };
  let seen;
  const answering = (file, args, options, done) => { seen = { file, args, options }; done(null, `${MARK}/opt/homebrew/bin:/usr/bin${MARK}${MARK}`); return { stdin: { end() {} } }; };
  assert.deepEqual(await resolveShellEnv({ env, run: answering }), { PATH: '/opt/homebrew/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8' });
  assert.equal(seen.file, '/bin/zsh');
  assert.equal(seen.options.env.ELECTRON_RUN_AS_NODE, undefined, 'the profile does not run with this app\'s variables');
  const hanging = (file, args, options, done) => { done(Object.assign(new Error('timed out'), { killed: true }), ''); return {}; };
  assert.deepEqual(await resolveShellEnv({ env, run: hanging }), { LANG: 'en_US.UTF-8' });
  assert.deepEqual(await resolveShellEnv({ env: { ...env, LANG: 'ja_JP.UTF-8' }, run: () => { throw new Error('no such shell'); } }), {});
});

test('text read over SSH keeps characters that arrive split across chunks', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-fake-ssh-'));
  const text = '中文历史记录'.repeat(20000); // 360 KB: several pipe chunks, none a multiple of three bytes
  writeFileSync(join(dir, 'payload.txt'), text);
  writeFileSync(join(dir, 'ssh'), `#!/bin/sh\ncat ${JSON.stringify(join(dir, 'payload.txt'))}\n`);
  chmodSync(join(dir, 'ssh'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${saved}`;
  t.after(() => { process.env.PATH = saved; });
  const out = await runSsh({ host: 'fixture', label: 'fixture' }, 'true');
  assert.equal(out.includes('�'), false);
  assert.equal(out, text);
});

test('attachments keep names in any script, within a file name\'s limits', () => {
  assert.equal(safeFileName('需求文档.pdf'), '需求文档.pdf');
  assert.equal(safeFileName('Q3 report (final)/v2:draft.txt'), 'Q3_report_final_v2_draft.txt');
  assert.equal(safeFileName('..'), 'file');
  assert.equal(safeFileName(''), 'file');
  const long = safeFileName('文'.repeat(200) + '.pdf');
  assert.ok(Buffer.byteLength(long) <= 200 && long.endsWith('.pdf'));
});

test('a model the catalog does not know takes its limits from the closest one it does', () => {
  const catalog = [{ id: 'deepseek-chat', contextWindow: 128000 }, { id: 'deepseek-reasoner', contextWindow: 256000 }];
  assert.equal(closestModel('deepseek-reasoner-v2', catalog).id, 'deepseek-reasoner');
  assert.equal(closestModel('qwen-max', catalog), null, 'an unrelated name has no sibling');
  assert.equal(closestModel('d', catalog), null);
});

test('find in conversation searches folded steps and rows that are not rendered', () => {
  const tools = { c1: { status: 'done', result: { content: [{ type: 'text', text: 'src/auth.ts:42: function verifyToken()' }] } } };
  const t = { live: null, loaded: true, tools, messages: [
    { role: 'user', content: [{ type: 'text', text: '看一下登录逻辑' }], timestamp: 1, __entryId: 'u1' },
    { role: 'assistant', __entryId: 'a1', timestamp: 2, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'grep -rn verifyToken src' } }] },
    { role: 'toolResult', __entryId: 'r1', toolCallId: 'c1', toolName: 'bash', content: tools.c1.result.content, timestamp: 3 },
    { role: 'assistant', __entryId: 'a2', timestamp: 4, stopReason: 'stop', content: [{ type: 'text', text: 'The bug is in refreshSession.' }] },
  ] };
  const blocks = displayBlocks(t);
  assert.deepEqual(findBlocks(blocks, tools, 'AUTH.ts'), ['work:c1'], 'a tool result inside a folded step');
  assert.deepEqual(findBlocks(blocks, tools, '登录'), ['uentry:u1']);
  assert.deepEqual(findBlocks(blocks, tools, 'refreshsession'), ['tentry:a2-0']);
  assert.deepEqual(findBlocks(blocks, tools, 'nowhere'), []);
  assert.deepEqual(findBlocks(blocks, tools, '   '), []);
});
