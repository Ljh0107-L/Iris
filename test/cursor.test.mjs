// Cursor through its official CLI's ACP server, against an offline stand-in (fixtures/fake-cursor-agent.mjs):
// Settings' account check and sign-in, and a conversation with Cursor's tools, models, questions and speed.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { requestReplies, speedDisplay, usageOf } from '../app/renderer/src/transcript.js';

const entry = fileURLToPath(new URL('../agent/iris-cursor.mjs', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-cursor-agent.mjs', import.meta.url));
const exec = promisify(execFile);
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";

function fixture(t, { signedIn = true } = {}) {
  const dir = realpathSync(mkdtempSync('/tmp/iris-cursor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'cursor-agent');
  // The adapter passes the CLI only the variables it needs: the stand-in's folder is written into its script.
  writeFileSync(bin, `#!/bin/sh\nFAKE_CURSOR_DIR=${quote(dir)} ELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(fake)} "$@"\n`, { mode: 0o700 });
  if (signedIn) writeFileSync(join(dir, 'state.json'), JSON.stringify({ signedIn: true }));
  const home = join(dir, 'iris-cursor-home');
  const calls = () => existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const state = () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  const setState = value => writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...state(), ...value }));
  const account = async (flag = '--account-check', menus = false) => {
    const { stdout } = await exec(process.execPath, [entry, flag, bin, '9.9.9', home], { cwd: dir, env: { ...process.env, ...(menus ? { IRIS_CLI_MENUS_DIR: dir } : {}) } });
    return stdout.trim().split('\n').map(line => JSON.parse(line));
  };
  function start(overrides = {}) {
    const boot = { cursor: { bin, cwd: dir, sessionsDir: join(dir, 'sessions'), home, bypassPermissions: true, ...overrides } };
    const child = spawn(process.execPath, [entry], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, IRIS_BOOT: JSON.stringify(boot) } });
    t.after(() => child.kill());
    const events = [];
    let buffer = '', n = 0;
    child.stdout.on('data', data => { buffer += data; for (let i; (i = buffer.indexOf('\n')) >= 0;) { events.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); } });
    const until = async (predicate, what, ms = 8000) => {
      const deadline = Date.now() + ms;
      for (;;) { const found = events.find(predicate); if (found) return found; if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`); await sleep(10); }
    };
    const rpc = async (type, payload = {}) => {
      const id = `r${++n}`;
      child.stdin.write(JSON.stringify({ ...payload, id, type }) + '\n');
      const response = await until(e => e.type === 'response' && e.id === id, type);
      if (!response.success) throw new Error(response.error);
      return response.data;
    };
    const send = record => child.stdin.write(JSON.stringify(record) + '\n');
    return { events, rpc, send, until, child };
  }
  return { dir, bin, home, calls, state, setState, account, start };
}

test('Settings asks Cursor itself: who is signed in, on which plan, and every model with its own settings', { timeout: 20000 }, async t => {
  const f = fixture(t, { signedIn: false });
  assert.deepEqual((await f.account()).at(-1), { cliAccountStatus: { signedIn: false, canSignIn: true } });
  // Signing in: the page the CLI names is passed on (Iris opens it), and the CLI never opens a browser itself.
  const signIn = await f.account('--account-login');
  assert.equal(signIn[0].cliSignIn.url, 'https://cursor.com/loginDeepControl?challenge=fixture&uuid=fixture&mode=login');
  const { cliAccountStatus: signedIn } = signIn.at(-1);
  assert.equal(signedIn.signedIn, true); assert.equal(signedIn.identity, 'person@example.test'); assert.equal(signedIn.plan, 'Pro');
  assert.equal(signedIn.options, undefined, 'a plain check does not read the models: that takes seconds');
  const { cliAccountStatus: status } = (await f.account('--account-check', true)).at(-1);
  const [model, ...settings] = status.options;
  assert.deepEqual([model.id, model.category, model.currentValue], ['model', 'model', 'auto-smart']);
  assert.deepEqual(model.options.map(choice => [choice.value, choice.name, choice.sub.map(option => option.id)]),
    [['auto-smart', 'Auto', ['optimize_for']], ['composer-2.5', 'Composer 2.5', ['fast']], ['grok-4.7', 'Grok 4.7', ['reasoning_effort', 'fast']]]);
  assert.equal(model.options[1].sub[0].options[1].name, 'Fast', 'invisible padding is taken out of a name');
  assert.deepEqual(settings.map(o => [o.id, o.currentValue]), [['optimize_for', 'balanced']], 'the settings of the model in use');
  assert.ok(f.calls().filter(call => call.argv).every(call => call.config === f.home), 'always in Iris’s own Cursor directory');
  assert.ok(f.calls().filter(call => call.argv?.[0] === 'login').every(call => call.noBrowser === '1'), 'the CLI prints the page instead of opening a browser');
  assert.equal((await f.account('--account-logout')).at(-1).cliAccountStatus.signedIn, false);
  // The ACP server asked for the models does not outlive the check (it does not stop on its own).
  const pids = f.calls().filter(call => call.acpPid).map(call => call.acpPid);
  assert.ok(pids.length >= 1);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/, `Cursor's ACP server ${pid} was stopped`);
});

test('a Cursor conversation: its tools and task list, its title, the model Auto chose, and a speed per model request without the wait', { timeout: 30000 }, async t => {
  const f = fixture(t);
  const a = f.start();
  const state = await a.rpc('get_state');
  assert.equal(state.engine, 'cursor');
  assert.deepEqual(f.calls().find(call => call.argv)?.argv, ['--force', 'acp'], 'full access: Cursor runs its tools without asking');
  assert.ok(f.calls().some(call => call.method === 'authenticate' && call.params.methodId === 'cursor_login'), 'it takes up the sign-in first');
  assert.deepEqual(f.calls().find(call => call.method === 'initialize').params.clientCapabilities, { _meta: { parameterizedModelPicker: true } }, 'one menu per setting, not every combination');
  await a.until(e => e.type === 'cli_state' && e.cli.options.find(o => o.category === 'model')?.options.some(choice => choice.sub), 'each model with its settings');
  const options = a.events.findLast(e => e.type === 'cli_state').cli.options;
  assert.deepEqual(options.map(o => o.id), ['model', 'optimize_for'], 'its mode menu is not one of Iris’s');
  await a.rpc('prompt', { message: 'list the folder' });
  await a.until(e => e.type === 'agent_settled', 'the turn');
  const reply = a.events.findLast(e => e.type === 'message_end' && e.message.role === 'assistant').message;
  assert.equal(reply.provider, 'cursor'); assert.equal(reply.responseModel, 'Fake Sonnet', 'Auto’s first line says the model: it is not text of the reply');
  assert.deepEqual(reply.content.map(b => b.type === 'toolCall' ? b.name : b.type), ['thinking', 'bash', 'read', 'TodoWrite', 'text']);
  assert.equal(reply.content.find(b => b.name === 'bash').arguments.command, 'ls');
  assert.equal(reply.content.find(b => b.name === 'read').arguments.path, '/w/a.txt');
  assert.deepEqual(reply.content.find(b => b.name === 'TodoWrite').arguments.todos, [{ content: 'Read the files', status: 'completed' }, { content: 'Answer', status: 'in_progress' }]);
  assert.ok(!reply.content.some(b => b.type === 'text' && /routed/.test(b.text)));
  const results = a.events.filter(e => e.type === 'tool_execution_end');
  assert.equal(results.find(e => e.toolName === 'bash').result.content[0].text, 'a.txt\nb.txt\n', 'what the command printed');
  assert.equal(results.find(e => e.toolName === 'read').result.content[0].text, 'alpha\n');
  assert.ok(a.events.some(e => e.method === 'setStatus' && e.statusKey === 'iris-title' && e.statusText === 'Fake Folder Listing'), 'Cursor names the conversation');
  // No token counts: two requests (the tool calls end the first), each with what it wrote and its wait apart.
  assert.equal(reply.usage, undefined);
  assert.equal(reply.requests.length, 2);
  assert.ok(reply.requests.every(r => r.estimated && r.output > 0 && r.wait >= 30), JSON.stringify(reply.requests));
  assert.ok(reply.requests[1].ms < 200, `the command’s 200 ms are in neither request (${reply.requests.map(r => r.ms)})`);
  const last = usageOf([{ ...requestReplies([reply])[1], usage: { output: reply.requests[1].output } }]);
  assert.equal(speedDisplay(last).label, 'Output TPS (estimated)');
});

test('each Cursor conversation keeps its own model, which the CLI shares between its conversations, and its questions are cards', { timeout: 30000 }, async t => {
  const f = fixture(t);
  const a = f.start();
  await a.rpc('get_state');
  await a.rpc('cli_set_config', { configId: 'model', value: 'grok-4.7' });
  await a.rpc('cli_set_config', { configId: 'reasoning_effort', value: 'low' });
  // Another conversation picks another model meanwhile: a running CLI keeps its own, so nothing is set again
  // (each change costs the CLI a second).
  f.setState({ choice: { model: 'composer-2.5', settings: { fast: 'false' } } });
  const sets = f.calls().filter(call => call.method === 'session/set_config_option').length;
  await a.rpc('prompt', { message: 'hello' });
  await a.until(e => e.type === 'agent_settled', 'the turn');
  assert.deepEqual(f.state().prompted.at(-1).choice, { model: 'grok-4.7', settings: { reasoning_effort: 'low' } });
  assert.equal(f.calls().filter(call => call.method === 'session/set_config_option').length, sets, 'nothing set again before sending');
  // A question Cursor's model asks while it works: a card, answered with the option's id.
  const before = a.events.length;
  await a.rpc('prompt', { message: 'ask me' });
  const card = await a.until(e => e.type === 'extension_ui_request' && e.ask === true, 'the question card');
  assert.equal(card.title, 'Red or blue?'); assert.deepEqual(card.options, ['Red', 'Blue']);
  a.send({ type: 'extension_ui_response', id: card.id, value: 'Blue' });
  await a.until(e => e.type === 'agent_settled' && a.events.indexOf(e) > before, 'the turn after the answer');
  assert.deepEqual(f.state().answer, { outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['blue'] }] } });
  // Opened again (a new CLI process): the conversation still has its model.
  a.child.kill();
  const sessionFile = a.events.map(e => e.data?.sessionFile).filter(Boolean).at(-1);
  const b = f.start({ sessionFile });
  await b.rpc('get_state');
  f.setState({ choice: { model: 'auto-smart', settings: {} } });
  await b.rpc('prompt', { message: 'hello again' });
  await b.until(e => e.type === 'agent_settled', 'the turn');
  assert.equal(f.state().prompted.at(-1).choice.model, 'grok-4.7');
});

test('an image Cursor’s model makes is the tool’s result and part of the reply', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const a = f.start();
  await a.rpc('get_state');
  await a.rpc('prompt', { message: 'draw a pelican' });
  await a.until(e => e.type === 'agent_settled', 'the turn');
  const reply = a.events.findLast(e => e.type === 'message_end' && e.message.role === 'assistant').message;
  const image = reply.content.find(b => b.type === 'image');
  assert.equal(image?.mimeType, 'image/png'); assert.ok(image.data.length > 20, 'the image, in the reply');
  const result = a.events.findLast(e => e.type === 'tool_execution_end' && e.toolCallId === reply.content.find(b => b.type === 'toolCall').id).result;
  assert.deepEqual(result.content.map(c => c.type), ['text', 'image'], 'and in the step: where it was saved, and the image');
  assert.match(result.content[0].text, /pelican\.png$/);
});
