// Offline adapter and relay contracts. All SSH and agy invocations reach private fixtures.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { attachJsonlReader, serializeJsonLine } from '../core/jsonl.mjs';
import { AgentSession } from '../core/agent-session.mjs';
import { localRelayTransport } from '../core/transports.mjs';
import { SessionManager } from '../app/main/session-manager.mjs';
import { prepareRemote } from '../app/main/remote-setup.mjs';
import { readHistory } from '../agent/iris-history.mjs';
import { antigravityTurnSpeed, requestReplies, usageOf } from '../app/renderer/src/transcript.js';

const adapter = fileURLToPath(new URL('../agent/iris-antigravity.mjs', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-agy-acp-antigravity.mjs', import.meta.url));
const relay = fileURLToPath(new URL('../agent/iris-relay.mjs', import.meta.url));
const exec = promisify(execFile);
const secretEnv = {
  GEMINI_API_KEY: 'fixture-private-gemini', GOOGLE_API_KEY: 'fixture-private-google',
  ANTHROPIC_API_KEY: 'fixture-private-anthropic', OPENAI_API_KEY: 'fixture-private-openai',
  GOOGLE_APPLICATION_CREDENTIALS: '/fixture-private-service-key', AGY_API_KEY: 'fixture-private-agy',
  LC_API_KEY: 'fixture-private-not-a-locale',
};
// How the machine reaches the network is not a secret to keep from the CLI: without it, a CLI behind a proxy
// cannot reach Google at all.
const networkEnv = { HTTPS_PROXY: 'http://proxy.example.test:3128', no_proxy: 'localhost,127.0.0.1' };
const shellQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const parseLines = value => value.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
async function until(fn, description, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = fn();
    if (result) return result;
    await sleep(12);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function fixture(t, scenario = {}, signedIn = false) {
  // Short POSIX path leaves room for the Unix-domain relay socket on macOS.
  const cwd = realpathSync(mkdtempSync('/tmp/pd-agy-'));
  const bin = join(cwd, 'fake agy');
  // Iris's bundled Node can be an Electron helper; only this wrapper sets the flag.
  writeFileSync(bin, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(fake)} "$@"\n`, { mode: 0o700 });
  const setScenario = value => writeFileSync(join(cwd, '.iris-agy-scenario.json'), JSON.stringify(value));
  setScenario(scenario);
  if (signedIn) writeFileSync(join(cwd, '.iris-fake-agy-cache.json'), JSON.stringify({ signedIn }));
  const config = { bin, cwd, sessionsDir: join(cwd, 'sessions') };
  const cleanup = [];
  const log = () => {
    const file = join(cwd, '.iris-fake-agy.jsonl');
    return existsSync(file) ? parseLines(readFileSync(file, 'utf8')) : [];
  };
  const calls = method => log().filter(r => r.method === method);
  t.after(async () => {
    for (const stop of cleanup.reverse()) await stop();
    rmSync(cwd, { recursive: true, force: true });
  });

  function start(sessionFile, overrides = {}, extraEnv = {}) {
    const boot = { antigravity: { ...config, sessionFile, ...overrides }, providers: [{ apiKey: 'fixture-private-boot-provider' }] };
    const child = spawn(process.execPath, [adapter], { cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...secretEnv, ...networkEnv, ...extraEnv, IRIS_BOOT: JSON.stringify(boot) } });
    const closed = once(child, 'close');
    const events = [];
    let stderr = '', n = 0;
    child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => { stderr += chunk; });
    attachJsonlReader(child.stdout, line => events.push(JSON.parse(line)));
    const send = r => child.stdin.write(serializeJsonLine(r));
    const next = (predicate, from = 0) => until(() => events.slice(from).find(predicate), 'adapter event');
    const rpc = (type, payload = {}) => {
      const id = `rpc-${++n}`;
      send({ ...payload, id, type });
      return next(r => r.id === id && r.type === 'response');
    };
    const request = async (type, payload) => {
      const r = await rpc(type, payload);
      assert.equal(r.success, true, r.error);
      return r.data;
    };
    const stop = async () => {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { return await closed; } finally { clearTimeout(timer); }
    };
    const peer = { events, request, rpc, next, stop, send, stderr: () => stderr };
    cleanup.push(stop);
    return peer;
  }
  return { cwd, config, start, log, calls, setScenario, onCleanup: fn => cleanup.push(fn) };
}

const event = type => r => r.type === type;
const lastAssistant = messages => messages.findLast(m => m.role === 'assistant');
const fileEntries = path => parseLines(readFileSync(path, 'utf8'));
const authOptions = ({ authRequired, canSignIn, options }) => ({ authRequired, canSignIn, options });

test('Settings checks and signs in without creating a conversation or exposing CLI session details', { timeout: 12000 }, async t => {
  const f = fixture(t);
  const account = async mode => JSON.parse((await exec(process.execPath, [adapter, `--account-${mode}`, f.config.bin], { cwd: f.cwd, timeout: 5000 })).stdout);
  assert.deepEqual(await account('check'), { cliAccountStatus: { signedIn: false, canSignIn: true } });
  assert.equal(f.calls('authenticate').length, 0);
  assert.deepEqual(await account('login'), { cliAccountStatus: { signedIn: true, canSignIn: true } });
  assert.deepEqual(await account('check'), { cliAccountStatus: { signedIn: true, canSignIn: true } });
  assert.equal(f.calls('session/list').length, 3);
  assert.equal(f.calls('authenticate').length, 1);
  assert.equal(f.calls('session/new').length, 0);
  assert.equal(existsSync(f.config.sessionsDir), false);
});

test('a signed-in check asked for the menus opens one empty conversation in Iris’s folder and reports the model and effort menus', { timeout: 12000 }, async t => {
  const f = fixture(t);
  const menus = join(f.cwd, 'cli-menus');
  f.setScenario({ workspace: menus });
  const account = async (mode, env = {}) => JSON.parse((await exec(process.execPath, [adapter, `--account-${mode}`, f.config.bin, '0.1.0', 'iris'], { cwd: f.cwd, timeout: 5000, env: { ...process.env, ...env } })).stdout);
  assert.deepEqual(await account('check', { IRIS_CLI_MENUS_DIR: menus }), { cliAccountStatus: { signedIn: false, canSignIn: true } }, 'signed out: nothing is opened');
  assert.equal(f.calls('session/new').length, 0);
  await account('login');
  const { cliAccountStatus: status } = await account('check', { IRIS_CLI_MENUS_DIR: menus });
  assert.equal(status.signedIn, true);
  assert.deepEqual(status.options.map(o => [o.id, o.category, o.currentValue, o.options.length > 0]), [['model', 'model', 'mock-gemini-fast', true], ['effort', 'thought_level', 'low', true]]);
  assert.equal(f.calls('session/new').length, 1);
  assert.equal(existsSync(f.config.sessionsDir), false, 'no conversation of Iris’s own is created');
});

test('standby negotiates once and only creates a transcript and ACP session on activation', { timeout: 12000 }, async t => {
  const f = fixture(t, {}, true);
  const cwd = join(f.cwd, 'conversation-folder');
  mkdirSync(cwd);
  f.setScenario({ workspace: cwd });
  const peer = f.start(null, { standby: true });
  const [a, b] = await Promise.all([peer.request('get_state'), peer.request('get_state')]);
  assert.deepEqual(a, b);
  assert.equal(a.cli.standby, true);
  assert.equal(a.sessionFile, null);
  assert.equal(existsSync(f.config.sessionsDir), false);
  // While it waits, the CLI is asked one thing that changes nothing (its list of sessions), so that it signs in
  // and reads the account and models now, not when the first message arrives.
  await until(() => f.calls('session/list').length === 1, 'the standby warm-up');
  assert.deepEqual(f.log().filter(r => r.method).map(r => r.method), ['initialize', 'session/list']);
  assert.match((await peer.rpc('prompt', { message: 'must not send' })).error, /Open the Antigravity conversation first/);
  assert.match((await peer.rpc('cli_activate', { cwd: 'relative' })).error, /Invalid Antigravity workspace/);
  const [active, same] = await Promise.all([
    peer.request('cli_activate', { cwd }), peer.request('cli_activate', { cwd }),
  ]);
  assert.deepEqual(active, same);
  assert.equal(active.cli.standby, undefined);
  assert.equal(fileEntries(active.sessionFile)[0].cwd, cwd);
  assert.equal(f.log()[0].boot.cwd, f.cwd);
  assert.deepEqual(f.log().filter(r => r.method).map(r => r.method), ['initialize', 'session/list', 'session/new']);
  assert.equal(f.calls('session/new')[0].params.cwd, cwd);
});

test('negotiates image input, CLI commands and context, and persists turn speed without fake usage', { timeout: 12000 }, async t => {
  const f = fixture(t, { photo: true, telemetry: true }, true);
  const peer = f.start(null, { bypassPermissions: true });
  const state = await peer.request('get_state');
  assert.equal(state.cli.image, true);
  assert.equal(state.cli.permissionMode, 'bypassPermissions');
  assert.deepEqual(f.log()[0].boot.argv, ['acp', '--dangerously-skip-permissions']);
  assert.deepEqual((await peer.request('get_commands')).commands, [{ name: 'test-skill', description: 'Test skill', source: 'antigravity', argumentHint: '<input>' }]);
  assert.deepEqual(await peer.request('get_session_stats'), { contextUsage: { tokens: 250, contextWindow: 1000, percent: 25 } });
  const image = { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' };
  await peer.request('prompt', { message: '', images: [image] });
  await peer.next(event('agent_settled'));
  assert.deepEqual(f.calls('session/prompt')[0].params.prompt, [image]);
  assert.equal(peer.events.some(event('extension_ui_request')), false);
  const { messages } = await readHistory(state.sessionFile);
  const reply = lastAssistant(messages);
  assert.ok(antigravityTurnSpeed(reply)?.tps > 0);
  assert.equal(usageOf(messages).calls, 0);
  assert.equal(reply.usage, undefined);
  assert.equal(antigravityTurnSpeed({ ...reply, stopReason: 'aborted' }), null);
});

async function ask(peer, message) {
  const from = peer.events.length;
  assert.deepEqual(await peer.request('prompt', { message }), { disposition: 'started' });
  const question = await peer.next(event('extension_ui_request'), from);
  assert.equal(question.method, 'select');
  assert.ok(!peer.events.slice(from).some(event('agent_settled')), 'a permission request must wait for the user');
  return { from, question };
}

const answer = (peer, question, payload) => peer.send({ type: 'extension_ui_response', id: question.id, ...payload });

test('the task list is one Tasks card kept current, and an agent Antigravity starts is a task with its role and brief', { timeout: 12000 }, async t => {
  const f = fixture(t, {}, true);
  const peer = f.start();
  const state = await peer.request('get_state');
  await peer.request('prompt', { message: 'steps' });
  await peer.next(event('agent_settled'));
  const reply = lastAssistant((await readHistory(state.sessionFile)).messages);
  const calls = reply.content.filter(block => block.type === 'toolCall');
  assert.deepEqual(calls.map(call => call.name), ['TodoWrite', 'Task'], 'three calls of the list tool are one card');
  assert.deepEqual(calls[0].arguments.todos, [{ content: 'Start sub-agent', status: 'completed' }, { content: 'Report', status: 'completed' }], 'as the list stood at the end');
  assert.deepEqual(calls[1].arguments, { description: 'Greeter', prompt: 'Reply with the word hi', subagent_type: 'Agent', model: 'flash_lite' });
  const ended = peer.events.filter(event('tool_execution_end'));
  assert.deepEqual(ended.map(e => [e.toolName, e.isError]), [['TodoWrite', false], ['Task', false]], 'each ends once');
});

test('an agent Antigravity starts is followed in its files: its steps while it works, then its report, kept with the conversation', { timeout: 15000 }, async t => {
  const f = fixture(t, {}, true);
  const home = join(f.cwd ?? '', 'home');
  const peer = f.start(undefined, {}, { HOME: home });
  const state = await peer.request('get_state');
  await peer.request('prompt', { message: 'agent' });
  await peer.next(event('agent_settled'));
  const call = lastAssistant((await readHistory(state.sessionFile)).messages).content.find(block => block.type === 'toolCall' && block.name === 'Task');
  assert.deepEqual(call.arguments, { description: 'Auditor', prompt: 'Audit src/ for dead code', subagent_type: 'research' });
  const saved = (await readHistory(state.sessionFile)).messages.filter(m => m.role === 'toolResult' && m.toolCallId === call.id);
  assert.equal(saved.at(-1).details.agentStatus, 'running', 'the turn ends with the agent still working, and says so');
  const working = await peer.next(e => e.type === 'tool_execution_update' && e.toolCallId === call.id && e.partialResult?.details?.steps?.length);
  assert.deepEqual(working.partialResult.details.steps.map(step => [step.name, step.arguments]), [['bash', { command: 'rg -n TODO src', description: 'Find TODOs' }], ['read', { path: '/work/src/a.js' }]]);
  const done = await peer.next(e => e.type === 'tool_execution_end' && e.toolCallId === call.id && e.result?.details?.agentStatus !== 'running');
  assert.equal(done.result.details.agentStatus, 'completed');
  assert.equal(done.result.content[0].text, 'Found two dead files: a.js and b.js.');
  assert.equal(done.result.details.agentRuns[0].usage.output, 65);
  const results = (await readHistory(state.sessionFile)).messages.filter(m => m.role === 'toolResult' && m.toolCallId === call.id);
  assert.equal(results.at(-1).details.agentStatus, 'completed', 'its end is saved with the conversation');
});

test('an agent still working when Iris stopped is followed again when the conversation opens', { timeout: 15000 }, async t => {
  const f = fixture(t, { agentMs: 0 }, true); // the agent finishes only once Iris has stopped
  const home = join(f.cwd, 'home');
  const first = f.start(undefined, {}, { HOME: home });
  const state = await first.request('get_state');
  await first.request('prompt', { message: 'agent' });
  await first.next(event('agent_settled'));
  await first.stop();
  // Meanwhile Antigravity's agent finished: its last steps, and its report to the conversation that started it.
  const brain = join(home, '.gemini/antigravity-cli/brain'), at = new Date().toISOString();
  appendFileSync(join(brain, 'child-1/.system_generated/logs/transcript_full.jsonl'), [
    { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at, tool_calls: [{ name: 'send_message', args: { Message: 'Found two dead files: a.js and b.js.' } }] },
    { step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at, content: 'Reported back.' }].map(line => JSON.stringify(line) + '\n').join(''));
  const again = f.start(state.sessionFile, {}, { HOME: home });
  await again.request('get_state');
  const done = await again.next(e => e.type === 'tool_execution_end' && e.result?.details?.agentStatus === 'completed');
  assert.equal(done.result.content[0].text, 'Found two dead files: a.js and b.js.');
  const results = (await readHistory(state.sessionFile)).messages.filter(m => m.role === 'toolResult' && m.toolName === 'Task');
  assert.deepEqual(results.map(m => m.details.agentStatus), ['running', 'completed']);
});

test('the CLI’s ordinary tools are a command, a file read or written and a web search, not a name and its input as JSON', { timeout: 12000 }, async t => {
  const f = fixture(t, {}, true);
  const peer = f.start();
  const state = await peer.request('get_state');
  await peer.request('prompt', { message: 'tools' });
  await peer.next(event('agent_settled'));
  const reply = lastAssistant((await readHistory(state.sessionFile)).messages);
  assert.deepEqual(reply.content.filter(block => block.type === 'toolCall').map(call => [call.name, call.arguments]), [
    ['bash', { command: 'echo hi && ls', description: 'Run echo and ls' }],
    ['read', { path: '/work/notes.txt' }],
    ['write', { path: '/work/out.txt', content: 'done\n' }],
    ['edit', { path: '/work/notes.txt', edits: [{ oldText: 'beta', newText: 'BETA' }] }],
    ['edit', { path: '/work/list.txt', edits: [{ oldText: 'one\ntwo\n', newText: 'one\n2\n' }] }],
    ['WebSearch', { query: 'Iris versicolor' }],
    ['Run something_else', {}], // a tool this app has no words for keeps the CLI's title
  ]);
  // Only the fields that are shown are read from a tool's input: nothing else in it is passed on or saved.
  assert.doesNotMatch(JSON.stringify(peer.events) + readFileSync(state.sessionFile, 'utf8'), /fixture-private-raw-input/);
  // Its thoughts are separate blocks in the one reply, each closed before the tool that follows it.
  assert.deepEqual(reply.content.map(block => block.type), ['thinking', 'toolCall', 'thinking', 'toolCall', 'toolCall', 'toolCall', 'toolCall', 'toolCall', 'toolCall', 'text']);
  const output = peer.events.filter(event('tool_execution_end')).find(e => e.toolName === 'bash');
  assert.equal(output.result.content[0].text, 'hi\nnotes.txt');
});

test('a question the model asks is a card with its choices, and the choice is its answer', { timeout: 12000 }, async t => {
  const f = fixture(t, {}, true);
  const peer = f.start();
  const state = await peer.request('get_state');
  await peer.request('prompt', { message: 'ask' });
  await peer.next(event('agent_settled'));
  // Asking ends the turn; the question is not a tool that failed.
  const asked = lastAssistant((await readHistory(state.sessionFile)).messages).content.find(block => block.type === 'toolCall');
  assert.deepEqual([asked.name, asked.arguments], ['AskUserQuestion', { questions: [{ question: 'Which colour do you prefer?', options: [{ label: 'red' }, { label: 'green' }, { label: 'blue' }] }] }]);
  assert.deepEqual(peer.events.filter(event('tool_execution_end')).map(e => [e.toolName, e.isError]), [['AskUserQuestion', false]]);
  // The CLI writes the question out as text too; the card asks it, so the conversation does not say it twice.
  assert.deepEqual(lastAssistant((await readHistory(state.sessionFile)).messages).content.map(block => block.type), ['toolCall']);
  const card = await peer.next(event('extension_ui_request'));
  assert.deepEqual([card.ask, card.method, card.header, card.title, card.options], [true, 'select', 'Question', 'Which colour do you prefer?', ['red', 'green', 'blue']]);
  // The choice is sent as the next message, which is how the CLI takes an answer.
  const from = peer.events.length;
  answer(peer, card, { value: 'green' });
  await peer.next(event('agent_settled'), from);
  assert.ok(peer.events.slice(from).some(e => e.type === 'extension_ui_dismiss' && e.id === card.id));
  const history = (await readHistory(state.sessionFile)).messages;
  assert.deepEqual(history.filter(m => m.role === 'user').map(m => m.content[0].text), ['ask', 'green']);
  const reply = lastAssistant(history);
  assert.deepEqual(reply.content.map(block => block.type), ['text'], 'the CLI closing the question it asked is not shown as another step');
  assert.equal(reply.content[0].text, 'Answer received: green');
  assert.deepEqual(f.calls('session/prompt').map(call => call.params.prompt[0].text), ['ask', 'green']);
});

test('several questions are asked one at a time and answered together; typing instead is an answer too', { timeout: 12000 }, async t => {
  const f = fixture(t, {}, true);
  const peer = f.start();
  await peer.request('get_state');
  await peer.request('prompt', { message: 'ask twice' });
  const first = await peer.next(event('extension_ui_request'));
  assert.deepEqual([first.header, first.title, first.multiSelect], ['Question 1 of 2', 'Which colour do you prefer?', undefined]);
  let from = peer.events.length;
  answer(peer, first, { value: 'blue' });
  const second = await peer.next(event('extension_ui_request'), from);
  assert.deepEqual([second.header, second.title, second.multiSelect, second.options], ['Question 2 of 2', 'Which sizes?', true, ['small', 'large']]);
  assert.equal(f.calls('session/prompt').length, 1, 'nothing is sent until every question has its answer');
  from = peer.events.length;
  answer(peer, second, { value: ['small', 'large'] });
  await peer.next(event('agent_settled'), from);
  assert.equal(f.calls('session/prompt').at(-1).params.prompt[0].text, 'Which colour do you prefer?\nblue\n\nWhich sizes?\nsmall, large');
  // Asked again, and answered by typing: the card goes and the typed message is the answer.
  from = peer.events.length;
  await peer.request('prompt', { message: 'ask' });
  const again = await peer.next(event('extension_ui_request'), from);
  const before = peer.events.length;
  await peer.request('prompt', { message: 'a colour of my own: teal' });
  await peer.next(event('agent_settled'), before);
  assert.ok(peer.events.slice(before).some(e => e.type === 'extension_ui_dismiss' && e.id === again.id));
  assert.equal(f.calls('session/prompt').at(-1).params.prompt[0].text, 'a colour of my own: teal');
});

test('a turn carries the token counts the CLI reports: input, cached, output, and thought', { timeout: 12000 }, async t => {
  const f = fixture(t, {}, true);
  const peer = f.start();
  const state = await peer.request('get_state');
  await peer.request('prompt', { message: 'counted' });
  await peer.next(event('agent_settled'));
  const reply = lastAssistant((await readHistory(state.sessionFile)).messages);
  assert.deepEqual(reply.usage, { input: 1000, output: 24, cacheRead: 600, cacheWrite: 0, reasoning: 22, totalTokens: 1624 });
  assert.ok(reply.durationMs > 0, 'with the length of the turn, for its speed');
  assert.ok(reply.modelMs > 0 && reply.modelMs <= reply.durationMs, 'and the model\'s own time in it');
});

test('speed is measured per model request: a turn lists its requests, and the time its tools ran is in none of them', { timeout: 12000 }, async t => {
  const f = fixture(t, {}, true);
  const peer = f.start();
  const state = await peer.request('get_state');
  await peer.request('prompt', { message: 'slow command' });
  await peer.next(event('agent_settled'));
  const reply = lastAssistant((await readHistory(state.sessionFile)).messages);
  assert.ok(reply.durationMs >= 400, `the turn took as long as its command (${reply.durationMs} ms)`);
  assert.ok(reply.modelMs <= reply.durationMs - 350, `the command's 400 ms are not the model's (${reply.modelMs} of ${reply.durationMs} ms)`);
  // The CLI says when each model request ends: the turn lists its two requests, each with its own time. It
  // counts tokens for the turn only, so each request has the share its text, thoughts and tool calls are of it.
  assert.equal(reply.requests.length, 2);
  assert.ok(reply.requests.every(r => r.ms > 0 && r.ms < 250), `neither request includes the command's 400 ms (${reply.requests.map(r => r.ms)})`);
  assert.equal(reply.requests[0].output + reply.requests[1].output, 40, 'the turn\'s tokens, shared out');
  assert.ok(reply.requests[0].output >= 10 && reply.requests[1].output > 0, 'the thought is the first request\'s');
  assert.ok(reply.requests.every(r => r.estimated === true));
  // The Usage card shows one request at a time, as with the other agents: the last one here.
  const entries = requestReplies([reply]);
  assert.equal(entries.length, 2);
  const last = usageOf([entries[1]]);
  assert.equal(last.genMs, reply.requests[1].ms); assert.equal(last.genOut, reply.requests[1].output);
  assert.equal(last.speedTokensEstimated, true);
  assert.equal(last.output, 40, 'the CLI counts tokens per turn: the table keeps the turn\'s');
  // The reply as a whole: every request, and still not the command.
  assert.equal(usageOf([reply]).genMs, reply.requests[0].ms + reply.requests[1].ms);
});

test('the wait for a request’s first output, and the thought that came whole with it, are not in its speed', { timeout: 12000 }, async t => {
  const f = fixture(t, {}, true);
  const peer = f.start();
  const state = await peer.request('get_state');
  const seen = [];
  peer.onEvent?.(e => seen.push(e));
  await peer.request('prompt', { message: 'slow start' });
  await peer.next(event('agent_settled'));
  const reply = lastAssistant((await readHistory(state.sessionFile)).messages);
  const [request] = reply.requests;
  // 150 ms before anything came; then a thought (whole) and the answer, written over 120 ms.
  assert.ok(request.wait >= 140 && request.wait < 260, `the wait (${request.wait} ms)`);
  assert.ok(request.ms - request.wait >= 100 && request.ms - request.wait < 220, `the writing (${request.ms - request.wait} ms of ${request.ms})`);
  assert.ok(request.lead > 0.4 && request.lead < 0.6, `the thought is about half of what was written (${request.lead})`);
  const speed = usageOf([requestReplies([reply])[0]]);
  assert.equal(speed.speedBasis, 'decode'); assert.equal(speed.genMs, request.ms - request.wait);
  assert.ok(Math.abs(speed.genOut - 40 * (1 - request.lead)) < 1e-9, 'the turn\'s 40 tokens, less the share that came with the first output');
});

test('a turn of one model request has its exact tokens, not an estimate', { timeout: 12000 }, async t => {
  const f = fixture(t, {}, true);
  const peer = f.start();
  const state = await peer.request('get_state');
  await peer.request('prompt', { message: 'counted' });
  await peer.next(event('agent_settled'));
  const reply = lastAssistant((await readHistory(state.sessionFile)).messages);
  assert.deepEqual(reply.requests.map(r => [r.output, r.estimated]), [[24, undefined]]);
});

test('negotiates ACP v1 as Iris, handles personal auth and serializes concurrent sign-in', { timeout: 12000 }, async t => {
  const f = fixture(t, { loginFailure: true });
  const peer = f.start();
  const [a, b] = await Promise.all([peer.request('get_state'), peer.request('get_state')]);
  assert.deepEqual(a, b);
  assert.deepEqual(authOptions(a.cli), { authRequired: true, canSignIn: true, options: [] });
  assert.equal(a.engine, 'antigravity');
  assert.equal(a.isCompacting, false);
  assert.equal(a.pendingMessageCount, 0);
  assert.equal(a.model, undefined);
  assert.ok(a.sessionId && a.sessionFile);
  assert.equal(statSync(a.sessionFile).mode & 0o777, 0o600);
  assert.equal(f.calls('initialize').length, 1);
  assert.equal(f.calls('session/new').length, 1, 'concurrent ready probes should share the auth state');
  assert.equal(f.calls('authenticate').length, 0, 'get_state should not trigger a browser');
  const boot = f.log()[0].boot;
  assert.deepEqual(boot.argv, ['acp']);
  assert.equal(boot.cwd, f.cwd);
  assert.ok(boot.env.includes('HOME') && boot.env.includes('PATH'));
  for (const key of Object.keys(networkEnv)) assert.ok(boot.env.includes(key), `${key} is passed on`);
  for (const key of [...Object.keys(secretEnv), 'IRIS_BOOT', 'NODE_OPTIONS']) assert.ok(!boot.env.includes(key), key);
  const failedLogin = await peer.rpc('cli_login');
  assert.equal(failedLogin.success, false);
  assert.match(failedLogin.error, /could not complete sign-in/);
  assert.deepEqual((await peer.request('get_state')).cli, a.cli);

  f.setScenario({});
  const [x, y] = await Promise.all([peer.request('cli_login'), peer.request('cli_login')]);
  assert.deepEqual(x, y);
  assert.equal(x.sessionFile, a.sessionFile);
  assert.equal(x.sessionId, a.sessionId);
  assert.equal(x.cli.authRequired, false);
  assert.deepEqual(x.model, { provider: 'antigravity', id: 'mock-gemini-fast' });
  assert.equal(f.calls('authenticate').length, 2, 'one failed user action and one shared successful action');
  assert.equal(f.calls('session/new').length, 2, 'one auth-required attempt and one successful open');
  assert.ok(peer.events.some(r => r.type === 'cli_state' && r.cli.authRequired));
  assert.ok(peer.events.some(r => r.type === 'cli_state' && r.cli.options.length === 2));
  assert.equal(peer.stderr(), '');
  assert.doesNotMatch(JSON.stringify(peer.events), /fixture-private/);
});

test('streams Pi messages, updates advertised settings, and selects only original permission options explicitly', { timeout: 12000 }, async t => {
  const f = fixture(t, {}, true);
  const peer = f.start();
  const state = await peer.request('get_state');
  assert.deepEqual(state.cli.options, [
    { id: 'model', name: 'Model', category: 'model', currentValue: 'mock-gemini-fast', options: [
      { value: 'mock-gemini-fast', name: 'Mock Gemini Fast' }, { value: 'mock-gemini-pro', name: 'Mock Gemini Pro' },
    ] },
    { id: 'effort', name: 'Effort', category: 'thought_level', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  ]);
  assert.equal((await peer.rpc('cli_set_config', { configId: 'mode', value: 'auto' })).success, false);
  assert.equal((await peer.rpc('cli_set_config', { configId: 'model', value: 'unadvertised' })).success, false);
  assert.equal((await peer.rpc('cli_set_config', { configId: 'unadvertised', value: 'high' })).success, false);
  assert.equal((await peer.rpc('prompt', { message: 'see image', images: [{ type: 'image' }] })).success, false);
  assert.equal(f.calls('session/set_config_option').length, 0);
  assert.equal(f.calls('session/prompt').length, 0);
  const changed = await peer.request('cli_set_config', { configId: 'model', value: 'mock-gemini-pro' });
  assert.equal(changed.model.id, 'mock-gemini-pro');
  const { from, question } = await ask(peer, 'explicit permission');
  assert.deepEqual(question.options, ['Allow this read', 'Reject this read']);
  assert.match(question.message, /\/work\/fixture.txt/);
  assert.equal((await peer.request('get_state')).isStreaming, true);
  assert.equal((await peer.rpc('prompt', { message: 'not queued' })).success, false);
  assert.equal(f.log().filter(r => r.id === 'permission-1').length, 0);
  answer(peer, question, { value: 'Allow this read' });
  await peer.next(event('agent_settled'), from);
  assert.deepEqual(f.log().find(r => r.id === 'permission-1').result, { outcome: { outcome: 'selected', optionId: 'allow-once-original-id' } });
  const turn = peer.events.slice(from);
  assert.ok(turn.some(event('agent_start')));
  assert.deepEqual(turn.filter(event('extension_ui_dismiss')), [{ type: 'extension_ui_dismiss', id: question.id }]);
  const begin = turn.find(event('tool_execution_start'));
  assert.equal(begin.args.path, '/work/fixture.txt');
  assert.equal(turn.find(event('tool_execution_update')).partialResult.content[0].text, 'Preparing read');
  const end = turn.find(event('tool_execution_end'));
  assert.equal(end.toolCallId, begin.toolCallId);
  assert.equal(end.isError, false);
  assert.equal(end.result.content[0].text, 'Tool output');
  assert.ok(turn.some(r => r.assistantMessageEvent?.type === 'text_delta' && r.assistantMessageEvent.delta === 'Hello 🪐'));
  assert.ok(turn.some(r => r.type === 'cli_state' && r.cli.options.find(o => o.id === 'effort')?.currentValue === 'high'));
  const { messages } = await peer.request('get_messages');
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'toolResult']);
  assert.deepEqual(messages[1].content.map(b => b.text ?? b.thinking ?? b.id), ['Hello 🪐\u2028world', 'Thinking', begin.toolCallId, 'Done.']);
  assert.equal(messages[2].toolCallId, begin.toolCallId);
  const entries = await peer.request('get_entries');
  assert.equal(entries.leafId, entries.entries.at(-1).id);
  assert.doesNotMatch(JSON.stringify(peer.events), /fixture-private|foreign session|fake-acp\/session/);
  assert.doesNotMatch(readFileSync(state.sessionFile, 'utf8'), /fixture-private|foreign session/);
  assert.equal((await peer.request('get_state')).isStreaming, false);

  const invalid = await ask(peer, 'forged permission');
  answer(peer, invalid.question, { value: 'allow-once-original-id' }); // label, not guessed ACP ID
  await peer.next(event('agent_settled'), invalid.from);
  assert.deepEqual(f.log().find(r => r.id === 'permission-2').result, { outcome: { outcome: 'cancelled' } });
  assert.deepEqual(peer.events.slice(invalid.from).filter(event('extension_ui_dismiss')), [{ type: 'extension_ui_dismiss', id: invalid.question.id }]);
});

test('ignores optional unsupported config/auth methods without a model or API fallback', { timeout: 12000 }, async t => {
  const f = fixture(t, { oauth: false, noOptions: true });
  const peer = f.start();
  const required = await peer.request('get_state');
  assert.deepEqual(authOptions(required.cli), { authRequired: true, canSignIn: false, options: [] });
  assert.equal((await peer.rpc('cli_login')).success, false);
  assert.equal((await peer.rpc('prompt', { message: 'simple' })).success, false);
  assert.equal(f.calls('authenticate').length, 0);
  assert.equal(f.calls('session/prompt').length, 0);
  assert.deepEqual(await peer.stop(), [0, null]);
  writeFileSync(join(f.cwd, '.iris-fake-agy-cache.json'), JSON.stringify({ signedIn: true }));
  const cached = f.start(required.sessionFile);
  const state = await cached.request('get_state');
  assert.equal(state.sessionFile, required.sessionFile);
  assert.deepEqual(authOptions(state.cli), { authRequired: false, canSignIn: false, options: [] });
  assert.equal(state.model, undefined);
  await cached.request('prompt', { message: 'simple' });
  await cached.next(event('agent_settled'));
  assert.equal(lastAssistant((await cached.request('get_messages')).messages).content[0].text, 'No settings needed.');
  assert.deepEqual(await cached.request('get_commands'), { commands: [] });
  assert.equal(await cached.request('get_session_stats'), null);
});

test('an SSH session never starts browser login and can reopen with the host CLI’s cached sign-in', { timeout: 12000 }, async t => {
  const f = fixture(t);
  const original = f.start(undefined, { remote: true });
  const state = await original.request('get_state');
  assert.deepEqual(authOptions(state.cli), { authRequired: true, canSignIn: false, options: [] });
  assert.match((await original.rpc('cli_login')).error, /on this host in Settings → Subscriptions/);
  assert.equal(f.calls('authenticate').length, 0);
  assert.equal(f.calls('session/prompt').length, 0);
  await original.stop();
  // Stand in for an explicit `agy acp --login` in the remote terminal.
  writeFileSync(join(f.cwd, '.iris-fake-agy-cache.json'), JSON.stringify({ signedIn: true }));
  const reopened = f.start(state.sessionFile, { remote: true });
  const ready = await reopened.request('get_state');
  assert.equal(ready.sessionId, state.sessionId);
  assert.equal(ready.cli.authRequired, false);
  await reopened.request('prompt', { message: 'simple' });
  await reopened.next(event('agent_settled'));
  assert.equal(f.calls('authenticate').length, 0);
  assert.equal(lastAssistant((await reopened.request('get_messages')).messages).content[0].text, 'No settings needed.');
});

test('a generic -32000 is not auth, and ambiguous or missing files cannot silently get a new session', { timeout: 12000 }, async t => {
  const f = fixture(t, { newFailure: true });
  const peer = f.start();
  const state = await peer.rpc('get_state');
  assert.equal(state.success, false);
  assert.match(state.error, /could not start a session \(ACP error -32000\)/);
  assert.equal(peer.events.some(r => r.type === 'cli_state' && r.cli.authRequired), false);
  // The CLI said it created nothing, so the conversation may try again instead of being unusable for good.
  assert.match((await peer.rpc('get_state')).error, /could not start a session \(ACP error -32000\)/);
  assert.equal(f.calls('session/new').length, 2);
  const missing = f.start(join(f.cwd, 'missing.jsonl'));
  assert.match((await missing.rpc('get_state')).error, /original Antigravity transcript/);
  const badBin = f.start(undefined, { bin: join(f.cwd, 'not-installed') });
  assert.match((await badBin.rpc('get_state')).error, /configured Antigravity CLI/);
  assert.equal(f.calls('initialize').length, 1);
  assert.equal(f.calls('authenticate').length, 0);
});

test('restart loads the exact ACP session without replay, prefers advertised resume and fails closed on a stale session', { timeout: 18000 }, async t => {
  const f = fixture(t, {}, true);
  const a = f.start();
  const state = await a.request('get_state');
  await a.request('prompt', { message: 'simple' });
  await a.next(event('agent_settled'));
  const { messages } = await a.request('get_messages');
  await a.stop();
  const original = readFileSync(state.sessionFile, 'utf8');
  assert.equal(fileEntries(state.sessionFile).find(e => e.data?.sessionId).data.sessionId, 'fake-acp/session?exact=1');

  const b = f.start(state.sessionFile);
  const loaded = await b.request('get_state');
  assert.equal(loaded.sessionId, state.sessionId);
  assert.deepEqual(loaded.cli.options, state.cli.options, 'load can advertise settings in a notification');
  assert.deepEqual((await b.request('get_messages')).messages, messages);
  assert.ok(!b.events.some(r => r.type.startsWith('message_') || r.type.startsWith('tool_execution_')));
  await b.stop();
  assert.equal(readFileSync(state.sessionFile, 'utf8'), original);

  f.setScenario({ resume: true });
  const c = f.start(state.sessionFile);
  assert.equal((await c.request('get_state')).sessionId, state.sessionId);
  await c.stop();
  assert.equal(f.calls('session/load').length, 1);
  assert.equal(f.calls('session/resume').length, 1);

  f.setScenario({ missingSession: true });
  const stale = f.start(state.sessionFile);
  const missing = await stale.rpc('get_state');
  assert.equal(missing.success, false);
  assert.match(missing.error, /original Antigravity session was not found/);
  assert.deepEqual((await stale.request('get_messages')).messages, messages);
  assert.equal(readFileSync(state.sessionFile, 'utf8'), original);
  await stale.stop();

  f.setScenario({ unsupportedResume: true });
  const unsupported = f.start(state.sessionFile);
  assert.match((await unsupported.rpc('get_state')).error, /cannot resume/);
  assert.equal(f.calls('session/load').length, 2);
  assert.equal(f.calls('session/new').length, 1);
  assert.equal(readFileSync(state.sessionFile, 'utf8'), original);
});

test('expired credentials preserve the existing transcript binding through reauthentication', { timeout: 12000 }, async t => {
  const f = fixture(t, {}, true);
  const peer = f.start();
  const state = await peer.request('get_state');
  await peer.request('prompt', { message: 'expire' });
  await peer.next(r => r.type === 'cli_state' && r.cli.authRequired);
  const failedPrompt = lastAssistant((await peer.request('get_messages')).messages);
  assert.equal(failedPrompt.stopReason, 'error');
  assert.match(failedPrompt.errorMessage, /sign in/i);
  const original = readFileSync(state.sessionFile, 'utf8');
  const afterLogin = await peer.request('cli_login');
  assert.equal(afterLogin.sessionId, state.sessionId);
  assert.equal(afterLogin.cli.authRequired, false);
  assert.equal(f.calls('session/new').length, 1);
  assert.equal(f.calls('session/load').length, 1);
  assert.equal(readFileSync(state.sessionFile, 'utf8'), original);
});

test('abort, turn completion and child exit each dismiss pending permissions', { timeout: 12000 }, async t => {
  const f = fixture(t, {}, true);
  const peer = f.start();
  const state = await peer.request('get_state');
  const { from, question } = await ask(peer, 'cancel me');
  const stopped = await peer.rpc('abort');
  assert.equal(stopped.success, true);
  assert.ok(peer.events.findIndex((r, i) => i >= from && r.type === 'agent_settled') < peer.events.indexOf(stopped));
  assert.ok(peer.events.slice(from).some(r => r.type === 'agent_settled'));
  assert.equal(f.calls('session/cancel').length, 1);
  assert.deepEqual(f.log().find(r => r.id === 'permission-1').result, { outcome: { outcome: 'cancelled' } });
  answer(peer, question, { value: 'Allow this read' }); // stale reply must be inert
  assert.deepEqual(await peer.request('abort_bash'), {});
  assert.deepEqual(await peer.request('clear_queue'), {});
  assert.deepEqual(peer.events.slice(from).filter(event('extension_ui_dismiss')), [{ type: 'extension_ui_dismiss', id: question.id }]);
  assert.equal(f.log().filter(r => r.id === 'permission-1').length, 1);
  assert.equal(lastAssistant((await peer.request('get_messages')).messages).stopReason, 'aborted');

  async function promptAndCheckDismissal(message) {
    const from = peer.events.length;
    await peer.request('prompt', { message });
    const question = await peer.next(event('extension_ui_request'), from);
    await peer.next(event('agent_settled'), from);
    assert.deepEqual(peer.events.slice(from).filter(event('extension_ui_dismiss')), [{ type: 'extension_ui_dismiss', id: question.id }]);
  }
  await promptAndCheckDismissal('finish with pending permission');
  await until(() => f.log().find(r => r.id === 'permission-2' && r.result?.outcome?.outcome === 'cancelled'), 'cancelled leftover permission');
  await promptAndCheckDismissal('disconnect');
  assert.match(lastAssistant((await peer.request('get_messages')).messages).errorMessage, /connection closed/);
  assert.equal((await peer.request('get_state')).sessionId, state.sessionId);
  assert.equal(f.calls('session/new').length, 1);
  assert.equal(f.calls('session/load').length, 1);
});

test('local relay owns adapter and fake CLI, reattaches to the same session and hard-stops a pending turn', { timeout: 18000 }, async t => {
  const f = fixture(t, {}, true);
  const env = { ...process.env, IRIS_RUN_DIR: join(f.cwd, 'run') };
  // Only this private relay daemon is contacted by the test. No SSH or app needed.
  mkdirSync(env.IRIS_RUN_DIR, { mode: 0o700 });
  const daemon = spawn(process.execPath, [relay, 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  daemon.stderr.resume();
  const closed = once(daemon, 'close');
  const control = (...argv) => exec(process.execPath, [relay, ...argv], { env, timeout: 6500 });
  f.onCleanup(async () => {
    if (daemon.exitCode == null && daemon.signalCode == null) {
      try { await control('shutdown'); } catch { daemon.kill('SIGTERM'); }
    }
    await closed;
  });
  const address = join(env.IRIS_RUN_DIR, 'relay.sock');
  await until(() => existsSync(address), 'relay listener');
  const connect = async () => {
    const session = new AgentSession({ id: 'mock-antigravity', boot: { antigravity: f.config },
      transport: localRelayTransport({ node: process.execPath, relayPath: relay, runDir: env.IRIS_RUN_DIR }),
      relay: { spawn: { cwd: f.cwd, argv: [process.execPath, adapter], env: secretEnv } } });
    f.onCleanup(() => session.stop(100));
    await session.start({ readyTimeout: 4000 });
    return session;
  };
  const a = await connect();
  assert.equal(a.attachInfo.created, true);
  const settled = a.nextSettled(4000);
  await a.prompt('simple');
  await settled;
  await a.stop();
  const b = await connect();
  assert.equal(b.attachInfo.created, false);
  assert.equal(b.attachInfo.pid, a.attachInfo.pid);
  assert.equal(b.initialState.sessionId, a.initialState.sessionId);
  assert.equal((await b.messages()).length, 2);
  assert.equal(f.calls('initialize').length, 1);
  const question = once(b, 'ui');
  await b.prompt('unresponsive');
  assert.equal((await question)[0].method, 'select');
  const cliPid = f.log()[0].boot.pid;
  await control('stop', 'mock-antigravity');
  assert.throws(() => process.kill(cliPid, 0), { code: 'ESRCH' });
  assert.equal(f.calls('session/cancel').length, 1);
  assert.deepEqual(f.log().find(r => r.id === 'permission-1').result, { outcome: { outcome: 'cancelled' } });
  await control('shutdown');
  await closed;
});

test('SSH deploys the adapter, prompts for host-side login, and reattaches a running turn without forwarding credentials', { timeout: 20000 }, async t => {
  const f = fixture(t, { resume: true });
  const home = join(f.cwd, 'remote-home'), root = join(home, '.iris');
  const tools = join(f.cwd, 'test-tools'), remoteNode = join(tools, 'node');
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  mkdirSync(tools);
  const ssh = join(tools, 'ssh');
  writeFileSync(ssh, `#!/bin/sh\nfor a do prev=$last; last=$a; [ "$a" != '-R' ] || exit 97; done\n[ "$prev" = 'agy-test-host' ] || exit 98\nexport HOME=${shellQuote(home)} GEMINI_API_KEY=fixture-remote-secret\nexec /bin/sh -c "$last"\n`, { mode: 0o700 });
  writeFileSync(remoteNode, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o700 });
  writeFileSync(join(home, '.local/bin/agy'), readFileSync(f.config.bin), { mode: 0o700 });
  // There is deliberately no Pi package on this SSH host.
  const originalEnv = { PATH: process.env.PATH, IRIS_NO_SSH_MUX: process.env.IRIS_NO_SSH_MUX };
  process.env.PATH = `${tools}:${process.env.PATH}`;
  process.env.IRIS_NO_SSH_MUX = '1';
  writeFileSync(join(home, '.iris-agy-fixture'), f.cwd); // the fake CLI's sign-in and scenario, wherever on the "host" it is started
  const env = { id: 'ssh:agy-fixture', kind: 'ssh', host: 'agy-test-host', label: 'Mock SSH', enabled: true, added: true };
  const store = { sessions: [], settings: { defaults: { antigravityBypassPermissions: false }, providers: [], environments: { [env.id]: { root, added: true } } },
    saveSettings() {}, saveSessions() {}, touchRecent() {} };
  const manager = new SessionManager({ store, environments: () => [env], piVersion: '1.2.3', relayPath: relay,
    bridgePath: fileURLToPath(new URL('../agent/iris-bridge.js', import.meta.url)),
    local: { node: process.execPath, agentDir: join(f.cwd, 'unused-local'), runDir: join(f.cwd, 'unused-run') },
    remoteSetup: (target, options) => prepareRemote(target, options, { probe: async () => ({ home, hostname: env.host, nodes: [{ path: remoteNode, version: process.version }], disks: [] }) }),
  });
  manager.providerHosts = async () => assert.fail('Antigravity must not load Pi providers');
  f.onCleanup(async () => {
    try {
      for (const record of store.sessions) await manager.stopRelay(env, record.id, { requireTree: true });
      await exec(ssh, [env.host, `IRIS_RUN_DIR=${shellQuote(join(root, 'run'))} ${shellQuote(remoteNode)} ${shellQuote(join(root, 'cli/iris-relay.mjs'))} shutdown`]).catch(() => {});
    } finally {
      await manager.shutdown();
      for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  assert.deepEqual(await manager.cliInfo(env.id), { installed: true });
  const record = await manager.create({ environmentId: env.id, cwd: f.cwd, engine: 'antigravity' });
  assert.equal(record.cli.authRequired, true);
  assert.equal(record.cli.canSignIn, false);
  assert.ok(record.piSessionFile.startsWith(join(root, 'agent/sessions/antigravity')));
  assert.deepEqual(readFileSync(join(root, 'cli/iris-antigravity.mjs')), readFileSync(adapter));
  assert.equal(existsSync(join(root, 'pi')), false);
  await assert.rejects(manager.cliLogin(record.id), /Settings → Subscriptions/);
  await assert.rejects(manager.prompt(record.id, 'before sign-in'), /Sign in with Google/);
  // The host has no keychain: the CLI keeps a sign-in in the data directory it was made with. Signing in the
  // way a person would by hand, in the CLI's own directory, is therefore not a sign-in for Iris's conversations
  // (which is how a host could say "Logged in" and Iris still "Not signed in").
  const signInOnHost = (bin, args, code) => execFileSync(bin, args, { input: `${code}\n`, encoding: 'utf8', cwd: home,
    env: { ...process.env, HOME: home, HTTPS_PROXY: 'http://proxy.example.test:3128', no_proxy: 'localhost', GEMINI_API_KEY: 'fixture-remote-secret', SOME_TOKEN: 'fixture-private' } });
  assert.match(execFileSync(join(home, '.local/bin/agy'), ['acp', '--login'], { input: '4/fixture-code\n', encoding: 'utf8', cwd: home, env: { HOME: home, PATH: process.env.PATH } }), /Logged in as fixture@example\.test/);
  assert.equal((await manager.cliAccountStatus(env.id, { engine: 'antigravity' })).signedIn, false);
  // The sign-in Iris starts goes through the adapter on the host, which starts the CLI the way it starts one
  // for a conversation: the same data directory and the same variables. So the CLI reaches Google the same
  // way (the proxy settings are passed on) and keeps the sign-in where a conversation's CLI looks for it.
  const login = await manager.cliTerminal(env.id, 'login', 'antigravity');
  assert.equal(login.bin, remoteNode);
  assert.deepEqual([login.args[0], login.args[1], login.args[2], login.args.at(-1)], [join(root, 'cli/iris-antigravity.mjs'), '--account-login-terminal', join(home, '.local/bin/agy'), 'iris']);
  assert.throws(() => signInOnHost(login.bin, login.args, 'not-a-code'), error => /Malformed auth code/.test(error.stdout));
  assert.equal((await manager.cliAccountStatus(env.id, { engine: 'antigravity' })).signedIn, false);
  assert.match(signInOnHost(login.bin, login.args, '4/fixture-code'), /Logged in as fixture@example\.test/);
  const started = f.log().filter(r => r.boot).at(-1).boot;
  assert.deepEqual(started.argv, ['acp', '--login', '--app-data-dir', 'iris']);
  assert.ok(['HTTPS_PROXY', 'no_proxy', 'HOME'].every(name => started.env.includes(name)), 'the CLI is told how to reach the network');
  assert.ok(!started.env.includes('GEMINI_API_KEY') && !started.env.includes('SOME_TOKEN'), 'and gets none of the keys in the environment');
  assert.equal((await manager.cliAccountStatus(env.id, { engine: 'antigravity' })).signedIn, true);
  await manager.reconnect(record.id);
  assert.equal(manager.list()[0].cli.authRequired, false);
  assert.equal(manager.list()[0].piSessionFile, record.piSessionFile);
  assert.equal(f.calls('authenticate').length, 0);
  assert.ok(f.log().filter(r => r.boot).every(r => !r.boot.env.includes('GEMINI_API_KEY')));

  const active = await manager.ensureStarted(record.id);
  const permission = once(manager, 'question');
  await manager.prompt(record.id, 'waiting for permission');
  const [{ question }] = await permission;
  await manager.close(record.id); // disconnect only: do not stop the host's work
  const attached = await manager.ensureStarted(record.id);
  assert.equal(attached.attachInfo.created, false);
  assert.equal(attached.attachInfo.pid, active.attachInfo.pid);
  assert.equal(manager.list()[0].pendingQuestions[0].requestId, question.requestId);
  await manager.abort(record.id);
  assert.equal(manager.list()[0].pendingQuestions.length, 0);
  assert.equal(f.calls('session/prompt').length, 1);
  assert.equal(f.calls('session/cancel').length, 1);
  assert.equal(manager.list()[0].egressPort, undefined);
  assert.deepEqual((await manager.historyPage(record.id)).messages.filter(m => m.role === 'user').map(m => m.content[0].text), ['waiting for permission']);
});
