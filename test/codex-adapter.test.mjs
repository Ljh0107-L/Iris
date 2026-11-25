// The Codex adapter against a stand-in for `codex app-server`: the same JSON-RPC, no account, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter, account, editsOfDiff, shellCommand } from '../agent/iris-codex.mjs';
import { FAKE_CODEX as FAKE } from './fake-codex.mjs';


function fixture(t, { bypassPermissions = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'iris-codex-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'codex'), log = join(dir, 'calls.jsonl'), signedOut = join(dir, 'signed-out');
  writeFileSync(bin, FAKE); chmodSync(bin, 0o755); writeFileSync(log, ''); mkdirSync(join(dir, 'work'));
  const env = { ...process.env, FAKE_CODEX_LOG: log, FAKE_CODEX_SIGNED_OUT: signedOut };
  const calls = method => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(c => !method || c.method === method);
  const start = (sessionFile) => {
    const events = [], waiting = new Map(), watchers = new Set();
    const adapter = new CodexAdapter({ env, boot: { codex: { bin, cwd: join(dir, 'work'), sessionsDir: join(dir, 'sessions'), sessionFile, clientVersion: '1.0.0', bypassPermissions } },
      write: e => { if (e.type === 'response') { waiting.get(e.id)?.(e); return; } events.push(e); for (const w of [...watchers]) w(e); } });
    t.after(() => adapter.close());
    let n = 0;
    const rpc = (type, fields = {}) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); adapter.handle({ id, type, ...fields }); });
    const next = match => new Promise(resolve => { const found = events.find(match); if (found) return resolve(found); const w = e => { if (match(e)) { watchers.delete(w); resolve(e); } }; watchers.add(w); });
    return { adapter, events, rpc, next };
  };
  return { dir, bin, env, calls, signedOut, start };
}
const settled = e => e.type === 'agent_settled';
const lastReply = events => events.findLast(e => e.type === 'message_end' && e.message.role === 'assistant').message;

test('a conversation opens with the account, the models and their efforts, and a turn streams and is saved', { timeout: 20000 }, async t => {
  const f = fixture(t), a = f.start();
  const state = (await a.rpc('get_state')).data;
  assert.equal(state.engine, 'codex');
  assert.deepEqual(state.model, { provider: 'codex', id: 'gpt-a' });
  assert.deepEqual(state.cli.options.map(o => [o.id, o.currentValue, o.options.map(c => c.value)]), [['model', 'gpt-a', ['gpt-a', 'gpt-b']], ['effort', 'low', ['low', 'high']], ['speed', 'standard', ['standard', 'priority', 'ultrafast']]]);
  assert.deepEqual(state.cli.account, { signedIn: true, canSignIn: false, identity: 'dev@example.test', plan: 'pro', limits: [{ usedPercent: 12, windowMinutes: 300, resetsAt: 1900000000000 }, { usedPercent: 40, windowMinutes: 10080 }] });
  // Each model says what it has, so a model picked before a conversation exists shows the right menus.
  assert.deepEqual(state.cli.options[0].options.map(c => [c.value, c.sub.map(o => `${o.id}:${o.currentValue}`)]), [['gpt-a', ['effort:low', 'speed:standard']], ['gpt-b', []]]);
  assert.deepEqual(f.calls('thread/start')[0].params, { cwd: join(f.dir, 'work'), approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
  assert.equal((await a.rpc('cli_set_config', { configId: 'effort', value: 'high' })).success, true);
  assert.equal((await a.rpc('cli_set_config', { configId: 'effort', value: 'ultra' })).success, false, 'only what the model offers');
  assert.deepEqual((await a.rpc('prompt', { message: 'hello' })).data, { disposition: 'started' });
  await a.next(settled);
  const reply = lastReply(a.events);
  assert.deepEqual(reply.content, [{ type: 'thinking', thinking: 'thinking' }, { type: 'text', text: 'Hello there' }]);
  assert.equal(reply.stopReason, 'stop');
  assert.deepEqual([reply.usage.input, reply.usage.cacheRead, reply.usage.output, reply.usage.totalTokens], [30, 20, 10, 60], 'this turn only, not the thread total');
  assert.deepEqual([f.calls('turn/start')[0].params.effort, f.calls('turn/start')[0].params.serviceTier], ['high', null], 'standard speed unless chosen');
  // The speeds are the ones Codex lists for this account and model: chosen, the turn asks for that tier.
  assert.equal((await a.rpc('cli_set_config', { configId: 'speed', value: 'ultrafast' })).success, true);
  assert.equal((await a.rpc('cli_set_config', { configId: 'speed', value: 'warp' })).success, false);
  await a.rpc('prompt', { message: 'hello again' });
  await a.next(e => e.type === 'agent_settled' && a.events.filter(x => x.type === 'agent_settled').length === 2);
  assert.equal(f.calls('turn/start')[1].params.serviceTier, 'ultrafast');
  // A model without faster tiers offers no Speed at all, and the choice does not follow to it.
  const other = (await a.rpc('cli_set_config', { configId: 'model', value: 'gpt-b' })).data.cli.options;
  assert.deepEqual(other.map(o => o.id), ['model']);
  await a.rpc('cli_set_config', { configId: 'model', value: 'gpt-a' });
  await a.rpc('cli_set_config', { configId: 'speed', value: 'priority' });
  assert.deepEqual((await a.rpc('get_session_stats')).data.contextUsage, { tokens: 60, contextWindow: 400000, percent: 0.015 });
  assert.deepEqual((await a.rpc('get_messages')).data.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
  // /compact: Codex summarizes its own thread; the conversation marks where.
  assert.deepEqual((await a.rpc('get_commands')).data.commands.map(c => c.name), ['compact']);
  assert.equal((await a.rpc('compact')).success, true);
  assert.deepEqual(a.events.filter(e => e.type.startsWith('compaction_')).map(e => [e.type, e.errorMessage]), [['compaction_start', undefined], ['compaction_end', undefined]]);
  const entries = (await a.rpc('get_entries')).data.entries;
  assert.deepEqual([entries.at(-1).type, entries.at(-1).tokensBefore], ['compaction', 60]);
  // Reopened later: the same Codex thread, never a second one.
  const file = state.sessionFile;
  await a.adapter.close();
  const b = f.start(file);
  assert.equal((await b.rpc('get_state')).success, true);
  assert.equal(f.calls('thread/start').filter(c => !c.params.ephemeral).length, 1, 'the title is asked in a throwaway thread');
  assert.equal(f.calls('thread/resume')[0].params.threadId, 'thread-1');
  assert.deepEqual((await b.rpc('get_messages')).data.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual((await b.rpc('get_state')).data.cli.options.map(o => [o.id, o.currentValue]), [['model', 'gpt-a'], ['effort', 'low'], ['speed', 'priority']], 'the conversation keeps its model and speed');
  assert.equal((await b.rpc('get_entries')).data.entries.some(e => e.type === 'custom'), false, 'its settings are not part of the visible history');
  // An account whose plan has no Ultrafast is simply not offered it.
  const plain = fixture(t); plain.env.FAKE_CODEX_NO_ULTRAFAST = '1';
  const c = plain.start();
  assert.deepEqual((await c.rpc('get_state')).data.cli.options.find(o => o.id === 'speed').options.map(o => o.value), ['standard', 'priority']);
});

test('commands show what was run and what Codex recognised, a patch is one diff per file, and a search with no match is not a failure', { timeout: 20000 }, async t => {
  const f = fixture(t), a = f.start();
  await a.rpc('prompt', { message: 'change the cities' });
  await a.next(settled);
  const reply = lastReply(a.events);
  const calls = reply.content.filter(b => b.type === 'toolCall');
  assert.deepEqual(calls.map(c => c.name), ['grep', 'read', 'edit', 'write', 'bash']);
  assert.deepEqual(calls[0].arguments, { pattern: 'WIND', path: 'src', command: 'rg -n "WIND" src' }, 'the login-shell wrapper is gone');
  assert.deepEqual(calls[1].arguments, { path: 'src/app.js', command: "sed -n '1,40p' src/app.js" }, 'paths inside the folder are relative to it');
  assert.deepEqual(calls[2].arguments, { path: 'src/app.js', edits: [
    { oldText: 'const CITIES = {\n  北京: 1,\n};', newText: 'const CITIES = {\n  北京: 1,\n  广州: 3,\n};' },
    { oldText: 'old();\nend();', newText: 'fresh();\nend();' }] });
  assert.deepEqual(calls[3].arguments, { path: 'NOTES.md', content: '# Notes\nhello\n' });
  assert.equal(calls[4].arguments.command, 'npm test');
  const results = Object.fromEntries(a.events.filter(e => e.type === 'tool_execution_end').map(e => [calls.find(c => c.id === e.toolCallId).name, e]));
  assert.equal(results.grep.isError, false, 'rg exits 1 when nothing matches');
  assert.equal(results.grep.result.content[0].text, 'No matches.');
  assert.equal(results.read.isError, false);
  assert.equal(results.edit.isError, false);
  assert.equal(results.bash.isError, true, 'a failing test run is still a failure');
  // The saved conversation has the same steps.
  const saved = readFileSync(a.adapter.transcript.file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.type === 'message' && e.message.role === 'assistant').at(-1).message;
  assert.deepEqual(saved.content.filter(b => b.type === 'toolCall').map(c => c.name), ['grep', 'read', 'edit', 'write', 'bash']);
});

test('an agent Codex starts is a task with the agent’s brief, steps and answer; its plan is a Tasks card kept current', { timeout: 20000 }, async t => {
  const f = fixture(t), a = f.start();
  await a.rpc('get_state');
  await a.rpc('prompt', { message: 'delegate the parser check' });
  await a.next(settled);
  const reply = lastReply(a.events);
  const calls = reply.content.filter(b => b.type === 'toolCall');
  assert.deepEqual(calls.map(c => c.name), ['TodoWrite', 'Task'], 'one Tasks card and one task: the agent’s own steps are not steps of the conversation');
  assert.deepEqual(calls[0].arguments.todos, [{ content: 'Check the parser', status: 'completed' }, { content: 'Report', status: 'in_progress' }], 'the last plan Codex sent');
  assert.deepEqual([calls[1].arguments.description, calls[1].arguments.subagent_type, calls[1].arguments.model], ['Check the parser', 'Agent', 'gpt-a']);
  assert.match(calls[1].arguments.prompt, /Read src\/parser\.js/, 'the brief is what the agent was started with');
  const ended = a.events.filter(e => e.type === 'tool_execution_end' && e.toolName === 'Task');
  assert.equal(ended.length, 1, 'ended once: the later "interrupted" is Codex closing an agent that had finished');
  assert.deepEqual([ended[0].isError, ended[0].result.content[0].text], [false, 'Three edge cases: empty input, nested quotes, trailing comma.']);
  assert.deepEqual([ended[0].result.details.kind, ended[0].result.details.stepCount, ended[0].result.details.steps.map(s => s.type === 'tool' ? s.name : 'text')], ['claude-code-agent', 2, ['read', 'text']]);
  assert.ok(a.events.some(e => e.type === 'tool_execution_update' && e.toolName === 'Task' && e.partialResult.details.stepCount === 1), 'steps show while the agent works');
  assert.equal(reply.content.filter(b => b.type === 'text').map(b => b.text).join(''), 'The agent found three edge cases.', 'nothing the agent said is in the reply');
});

test('the login-shell wrapper and unified diffs are read the way the shell and git write them', () => {
  assert.equal(shellCommand("/bin/zsh -lc 'ls -la'"), 'ls -la');
  assert.equal(shellCommand("bash -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
  assert.equal(shellCommand('/bin/zsh -lc "echo \\"$HOME\\""'), 'echo "$HOME"');
  assert.equal(shellCommand('npm test'), 'npm test');
  assert.deepEqual(editsOfDiff('@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n'), [{ oldText: 'a', newText: 'b' }]);
  assert.deepEqual(editsOfDiff('@@ -1,2 +1,2 @@\n x\n-y\n+z\n--- a/other\n+++ b/other\n'), [{ oldText: 'x\ny', newText: 'x\nz' }], 'a hunk ends at its line counts');
  assert.deepEqual(editsOfDiff('not a diff'), []);
});

test('a new conversation is named by Codex after its first reply, in a request that is not part of it', { timeout: 20000 }, async t => {
  const f = fixture(t), a = f.start();
  await a.rpc('prompt', { message: 'add a temperature lookup by city' });
  const named = await a.next(e => e.type === 'extension_ui_request' && e.method === 'setStatus');
  assert.deepEqual([named.statusKey, named.statusText], ['iris-title', 'Weather lookup by city']);
  const side = f.calls('thread/start').find(c => c.params.ephemeral);
  assert.equal(side.params.sandbox, 'read-only');
  assert.equal(side.params.approvalPolicy, 'never');
  const titleTurn = f.calls('turn/start').find(c => c.params.threadId === 'title-2');
  assert.deepEqual([titleTurn.params.model, titleTurn.params.effort, titleTurn.params.outputSchema.required], ['gpt-a', 'low', ['title']], 'the lowest effort of the conversation’s model');
  await a.next(() => f.calls('thread/name/set').length > 0 || undefined).catch(() => {});
  assert.deepEqual(f.calls('thread/name/set')[0]?.params, { threadId: 'thread-1', name: 'Weather lookup by city' }, 'the Codex history gets the same name');
  // The title request is not part of the conversation: one reply, nothing else in it.
  assert.equal(a.events.filter(e => e.type === 'message_end' && e.message.role === 'assistant').length, 1);
  // A later turn does not ask again.
  await a.rpc('prompt', { message: 'and a test' });
  await a.next(e => e.type === 'agent_settled' && a.events.filter(x => x.type === 'agent_settled').length === 2);
  assert.equal(f.calls('thread/start').filter(c => c.params.ephemeral).length, 1);
});

test('a question Codex asks is a card for each part, and the answers reach Codex by question', { timeout: 20000 }, async t => {
  const f = fixture(t), a = f.start();
  await a.rpc('get_state');
  await a.rpc('prompt', { message: 'ask me first' });
  const first = await a.next(e => e.type === 'extension_ui_request');
  // Not a permission request: a question, with what each choice means.
  assert.deepEqual([first.ask, first.method, first.header, first.title, first.options], [true, 'select', 'Colour', 'Which colour do you prefer?', ['Red', 'Green']]);
  assert.deepEqual(first.optionDetails, [{ label: 'Red', description: 'Warm' }, { label: 'Green', description: 'Calm' }]);
  const from = a.events.length;
  a.adapter.handle({ type: 'extension_ui_response', id: first.id, value: 'Green' });
  const second = await a.next(e => e.type === 'extension_ui_request' && e.id !== first.id);
  assert.deepEqual([second.ask, second.method, second.header, second.title], [true, 'input', 'Reason', 'Why?']);
  assert.ok(!f.calls('reply').some(call => call.params?.answers), 'nothing goes back until every part is answered');
  a.adapter.handle({ type: 'extension_ui_response', id: second.id, value: 'It is restful' });
  await a.next(settled);
  assert.deepEqual(f.calls('reply').at(-1).params, { answers: { colour: { answers: ['Green'] }, why: { answers: ['It is restful'] } } });
  assert.match(lastReply(a.events).content.at(-1).text, /Answers: /);
  assert.equal(a.events.slice(from).filter(e => e.type === 'extension_ui_dismiss').length, 2);
});

test('a command waits for approval, and the answer reaches Codex', { timeout: 20000 }, async t => {
  for (const [answer, decision, text] of [['Allow once', 'accept', 'Tests pass.'], ['Reject', 'decline', 'Not run.']]) {
    const f = fixture(t), a = f.start();
    await a.rpc('get_state');
    await a.rpc('prompt', { message: 'run the tests' });
    const ask = await a.next(e => e.type === 'extension_ui_request');
    assert.equal(ask.header, 'Codex permission');
    assert.match(ask.message, /npm test\nruns the test suite\nin \/w/);
    assert.deepEqual(ask.options, ['Allow once', 'Allow for this conversation', 'Reject']);
    a.adapter.handle({ type: 'extension_ui_response', id: ask.id, value: answer });
    await a.next(settled);
    assert.equal(f.calls('reply').at(-1).params.decision, decision);
    const reply = lastReply(a.events);
    assert.deepEqual(reply.content.map(b => b.type === 'toolCall' ? `${b.name}:${b.arguments.command}` : b.text), ['bash:npm test', text]);
    const result = a.events.find(e => e.type === 'tool_execution_end');
    assert.equal(result.isError, decision === 'decline');
  }
  // With permissions bypassed Codex is told never to ask.
  const f = fixture(t, { bypassPermissions: true }), a = f.start();
  await a.rpc('get_state');
  assert.deepEqual([f.calls('thread/start')[0].params.approvalPolicy, f.calls('thread/start')[0].params.sandbox], ['never', 'danger-full-access']);
});

test('a message sent while Codex works joins the turn, and Stop interrupts it', { timeout: 20000 }, async t => {
  const f = fixture(t), a = f.start();
  await a.rpc('get_state');
  await a.rpc('prompt', { message: 'wait for me' });
  assert.deepEqual((await a.rpc('prompt', { message: 'also this' })).data, { disposition: 'queued' });
  assert.equal(f.calls('turn/steer')[0].params.expectedTurnId, 'turn-1');
  assert.equal((await a.rpc('abort')).success, true);
  await a.next(settled);
  assert.equal(lastReply(a.events).stopReason, 'aborted');
  assert.deepEqual((await a.rpc('get_messages')).data.messages.map(m => m.role), ['user', 'user', 'assistant']);
});

test('signed out: the conversation says so, and Settings can check and sign out without opening one', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const before = await account({ bin: f.bin, cwd: f.dir, version: '1', env: f.env });
  assert.equal(before.signedIn, true); assert.equal(before.identity, 'dev@example.test');
  const after = await account({ bin: f.bin, cwd: f.dir, version: '1', env: f.env, logout: true });
  assert.deepEqual(after, { signedIn: false, canSignIn: false });
  const a = f.start();
  const state = (await a.rpc('get_state')).data;
  assert.equal(state.cli.authRequired, true);
  assert.deepEqual(state.cli.options, []);
  assert.equal(f.calls('thread/start').length, 0, 'no conversation is started before sign-in');
  assert.match((await a.rpc('prompt', { message: 'hi' })).error, /Sign in to Codex/);
});

test('a title is read out of what Codex replies', async () => {
  const { titleOf } = await import('../agent/iris-codex.mjs');
  assert.equal(titleOf('{"title":"按城市查询天气。"}'), '按城市查询天气');
  assert.equal(titleOf('"Fix the login bug"'), 'Fix the login bug');
  assert.equal(titleOf('Plain words\nsecond line'), 'Plain words');
  assert.equal(titleOf(''), '');
});
