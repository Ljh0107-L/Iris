// An offline ACP server for the Antigravity adapter tests. The workspace controls the
// scenario and stands in for the CLI's own credential and session cache.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

const bypass = process.argv.includes('--dangerously-skip-permissions');
// Iris may give the CLI a data directory of its own: like the real CLI, only a plain relative name
// (the real one keeps it under ~/.gemini and refuses an absolute path).
const argv = process.argv.slice(2), dataAt = argv.indexOf('--app-data-dir');
if (dataAt >= 0) assert.ok(/^[\w.-]+$/.test(argv[dataAt + 1] ?? '') && !isAbsolute(argv[dataAt + 1]), 'a plain app data directory name');
const dataDir = dataAt >= 0 ? argv[dataAt + 1] : 'antigravity-cli', plainArgs = dataAt >= 0 ? [...argv.slice(0, dataAt), ...argv.slice(dataAt + 2)] : argv;
const terminalLogin = plainArgs.includes('--login');
if (!terminalLogin) assert.deepEqual(plainArgs, ['acp', ...(bypass ? ['--dangerously-skip-permissions'] : [])]);
// The fixture is the folder the CLI is started in. A CLI started elsewhere (a sign-in or an account check on
// a "host" runs in its home) finds it through a note in that home, since the adapter passes on no test variables.
const noted = join(process.env.HOME ?? '', '.iris-agy-fixture');
const fixture = process.env.IRIS_AGY_FIXTURE_DIR ?? (existsSync(join(process.cwd(), '.iris-agy-scenario.json')) || !existsSync(noted) ? process.cwd() : readFileSync(noted, 'utf8').trim());
const scenarioFile = join(fixture, '.iris-agy-scenario.json');
let goalTurns = 0;
const cacheFile = join(fixture, '.iris-fake-agy-cache.json');
const logFile = join(fixture, '.iris-fake-agy.jsonl');
const scenario = () => JSON.parse(readFileSync(scenarioFile, 'utf8'));
const cache = () => existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
// Where the sign-in is kept, as in the real CLI: `signedIn` is the keychain of a Mac, one sign-in whatever
// the data directory; `signedInDirs` is a machine without a keychain (an SSH host), where the sign-in is a
// file in the data directory it was made with and no other directory has it.
// Iris gives each session its visual tool: one stdio MCP server, iris, run from iris-visual.mjs.
const irisVisual = servers => {
  if (Array.isArray(servers) && !servers.length) return; // (the empty conversation that reads the menus needs none)
  assert.equal(servers?.length, 1);
  assert.equal(servers[0].name, 'iris');
  assert.match(servers[0].args.at(-1), /iris-visual\.mjs$/);
  assert.ok(Array.isArray(servers[0].env));
};
const signedIn = () => cache().signedIn === true || cache().signedInDirs?.[dataDir] === true;
const save = value => writeFileSync(cacheFile, JSON.stringify(value));
const log = value => appendFileSync(logFile, JSON.stringify(value) + '\n');
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const reply = (id, result = {}) => send({ id, result });
const error = (id, code, message) => send({ id, error: { code, message, data: { token: 'fixture-private-error-data' } } });
const SESSION = 'fake-acp/session?exact=1';
const update = (sessionUpdate, fields, sessionId = SESSION) => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate, ...fields } } });
const chunk = (text, sessionId = SESSION) => update('agent_message_chunk', { content: { type: 'text', text } }, sessionId);
const toolCallId = 'fake-call';

log({ boot: { pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2), env: Object.keys(process.env).sort() } });

// `agy acp --login`: the sign-in a person does in a terminal. The real one prints a Google link, waits for the
// authorization code the page shows, and keeps the sign-in in the data directory it was started with.
if (terminalLogin) {
  assert.deepEqual(plainArgs, ['acp', '--login']);
  process.stdout.write('Open this link in a browser to log in with Google:\n\n  https://accounts.google.com/o/oauth2/auth?client_id=fixture&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=fixture\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n');
  const code = await new Promise(resolve => { const input = createInterface({ input: process.stdin }); input.once('line', line => { resolve(line.trim()); input.close(); }); input.once('close', () => resolve('')); });
  if (!code) { process.stdout.write('login cancelled: no authorization code was entered\n'); process.exit(1); }
  if (!code.startsWith('4/')) { process.stdout.write('\ncouldn\'t log in: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."\n'); process.exit(1); }
  save({ ...cache(), signedInDirs: { ...cache().signedInDirs, [dataDir]: true } });
  process.stdout.write('Logged in as fixture@example.test.\n');
  process.exit(0);
}
process.stderr.write('fixture-private-stderr-oauth-url\n');

let model = 'mock-gemini-fast', effort = 'low';
const options = () => [{ id: 'model', type: 'select', name: 'Model', category: 'model', currentValue: model,
  options: [{ group: 'mock-group', name: 'Advertised Gemini models', options: [
    { value: 'mock-gemini-fast', name: 'Mock Gemini Fast' }, { value: 'mock-gemini-pro', name: 'Mock Gemini Pro' },
  ] }] }, { id: 'effort', type: 'select', name: 'Effort', category: 'thought_level', currentValue: effort,
  options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
{ id: 'mode', type: 'select', name: 'Permissions', category: 'mode', currentValue: 'ask', options: [{ value: 'ask', name: 'Confirm' }, { value: 'auto', name: 'Automatic' }] },
{ id: 'unsupported', type: 'boolean', name: 'Not an MVP control', currentValue: true }];
const config = () => scenario().noOptions ? { models: { currentModelId: 'legacy-model' }, configOptions: null } : { configOptions: options() };
const authRequired = id => error(id, -32000, 'Authentication required');
let turn, nextPermission = 0, cancelTimer;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  const r = JSON.parse(line);
  log(r);
  assert.equal(r.jsonrpc, '2.0');
  switch (r.method) {
    case 'initialize': {
      assert.equal(r.params.protocolVersion, 1);
      assert.equal(r.params.clientInfo.name, 'iris');
      assert.equal(r.params.clientInfo.title, 'Iris');
      assert.deepEqual(r.params.clientCapabilities, {});
      const { resume, unsupportedResume, oauth, photo, list, badProtocol } = scenario();
      reply(r.id, { protocolVersion: badProtocol ? 2 : 1, agentCapabilities: { loadSession: !unsupportedResume, promptCapabilities: { image: photo === true },
        sessionCapabilities: { ...(resume ? { resume: {} } : {}), ...(list !== false ? { list: {} } : {}) } },
        authMethods: oauth === false ? [{ id: 'api-key' }] : [{ id: 'oauth-personal', name: 'Sign in with Google', ...(oauth === 'terminal' ? { type: 'terminal' } : {}) }] });
      break;
    }
    case 'authenticate':
      assert.deepEqual(r.params, { methodId: 'oauth-personal' });
      if (scenario().loginFailure) { error(r.id, -32000, 'fixture-private-login-failure'); break; }
      save({ ...cache(), signedIn: true });
      reply(r.id);
      break;
    case 'session/list':
      assert.deepEqual(r.params, {});
      if (signedIn()) reply(r.id, { sessions: [{ sessionId: SESSION, title: 'fixture-private-session-name' }] });
      else authRequired(r.id);
      break;
    case 'session/new': {
      assert.equal(r.params.cwd, scenario().workspace ?? process.cwd());
      irisVisual(r.params.mcpServers);
      if (scenario().newFailure) { error(r.id, -32000, 'fixture-private-non-auth-server-error'); break; }
      if (!signedIn()) { authRequired(r.id); break; }
      assert.equal(cache().session, undefined, 'client tried to replace an existing CLI session');
      save({ ...cache(), session: SESSION });
      if (scenario().telemetry) {
        update('available_commands_update', { availableCommands: [{ name: 'test-skill', description: 'Test skill', input: { hint: '<input>' } }] });
        update('usage_update', { used: 250, size: 1000, cost: { amount: 99, currency: 'USD' } });
      }
      reply(r.id, { sessionId: SESSION, ...config() });
      break;
    }
    case 'session/load': case 'session/resume': {
      irisVisual(r.params.mcpServers);
      assert.deepEqual({ ...r.params, mcpServers: undefined }, { cwd: scenario().workspace ?? process.cwd(), mcpServers: undefined, sessionId: SESSION });
      if (!signedIn() || scenario().expireResume) { authRequired(r.id); break; }
      if (scenario().missingSession || cache().session !== SESSION) { error(r.id, -32002, 'fixture-private-stale-session-data'); break; }
      if (r.method === 'session/load') {
        update('user_message_chunk', { content: { type: 'text', text: 'replayed user' } });
        chunk('replayed assistant');
        update('tool_call', { toolCallId, title: 'Replayed tool' });
        update('config_option_update', { configOptions: options() });
        reply(r.id);
      } else reply(r.id, config());
      break;
    }
    case 'session/set_config_option':
      assert.equal(r.params.sessionId, SESSION);
      if (r.params.configId === 'model') {
        assert.equal(r.params.value, 'mock-gemini-pro');
        model = r.params.value;
      } else {
        assert.equal(r.params.configId, 'effort');
        assert.equal(r.params.value, 'high');
        effort = r.params.value;
      }
      reply(r.id, config());
      break;
    case 'session/prompt': {
      assert.equal(r.params.sessionId, SESSION);
      assert.equal(turn, undefined);
      if (r.params.prompt.some(p => p.type === 'image')) {
        assert.equal(scenario().photo, true);
        assert.deepEqual(r.params.prompt.at(-1), { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' });
        chunk('Image received.'); reply(r.id, { stopReason: 'end_turn' }); break;
      }
      assert.equal(r.params.prompt.length, 1);
      assert.equal(r.params.prompt[0].type, 'text');
      const text = r.params.prompt[0].text;
      // A goal's turns (Iris's /goal): progress, then Iris's update_goal tool on the turn the scenario says (goalDoneAt).
      if (text.startsWith('The user set a goal') || text.includes('Continue working toward the active goal')) {
        goalTurns += 1;
        // (goalPlan: its task list says a step is left, yet it calls the goal complete, every turn.)
        if (scenario().goalPlan && goalTurns === 1) {
          const steps = { toolCallId: 'p-1', kind: 'other', title: 'Run update_steps', rawInput: { steps: [{ status: 'done', title: 'Probe the cards' }, { status: 'pending', title: 'Restore the cards' }] } };
          update('tool_call', { ...steps, status: 'in_progress' }); update('tool_call_update', { ...steps, status: 'completed' });
        }
        if (scenario().goalPlan || goalTurns === scenario().goalDoneAt) {
          const call = { toolCallId: `g-${goalTurns}`, kind: 'other', title: 'mcp__iris__update_goal', rawInput: { status: 'complete' } };
          update('tool_call', { ...call, status: 'in_progress' }); update('tool_call_update', { ...call, status: 'completed' });
          chunk('Done: verified.'); reply(r.id, { stopReason: 'end_turn' }); break;
        }
        if (scenario().goalHold === goalTurns) { turn = { id: r.id, text }; chunk('Working on the goal'); break; } // (a turn to stop)
        chunk(`Progress ${goalTurns}.`); reply(r.id, { stopReason: 'end_turn' }); break;
      }
      // Iris's visual tool, as an MCP call the CLI names by its server and tool: a fragment, with no <html> or <canvas>
      // to know it by (only the tool's name says what it is).
      if (text === 'visual') {
        const call = { toolCallId: 'v-1', kind: 'other', title: 'mcp__iris__show_visual', rawInput: { title: 'Bubble sort', html: '<h3>Pass 1</h3><p>3 1 2</p>', height: 300, id: 'sort' } };
        update('tool_call', { ...call, status: 'in_progress' }); update('tool_call_update', { ...call, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Shown to the person in Iris as "Bubble sort".' } }] });
        chunk('Here it is.'); reply(r.id, { stopReason: 'end_turn' }); break;
      }
      if (text === 'expire') {
        save({ ...cache(), signedIn: false });
        authRequired(r.id); break;
      }
      // A turn that keeps a task list and starts an agent, as the real CLI reports them: `update_steps` called
      // again for every change, `invoke_subagent` with the role and the brief.
      if (text === 'steps') {
        const tool = (id, title, rawInput) => { update('tool_call', { toolCallId: id, kind: 'other', title, status: 'in_progress', rawInput }); update('tool_call_update', { toolCallId: id, kind: 'other', title, status: 'completed', rawInput }); };
        tool('s-1', 'Run update_steps', { steps: [{ status: 'in_progress', title: 'Start sub-agent' }, { status: 'pending', title: 'Report' }] });
        tool('a-1', 'Run invoke_subagent', { Model: 'flash_lite', Prompt: 'Reply with the word hi', Role: 'Greeter', TypeName: 'self' });
        tool('s-2', 'Run update_steps', { steps: [{ status: 'done', title: 'Start sub-agent' }, { status: 'done', title: 'Report' }] });
        chunk('It said hi.'); reply(r.id, { stopReason: 'end_turn' }); break;
      }
      // A command moved to the background, as the real CLI reports one: its step ends saying it is a task (with
      // its log file), its output goes to the log, and its end is a message to the conversation from the task.
      if (text === 'background') {
        const gen = join(process.env.HOME, '.gemini', dataDir, 'brain', SESSION, '.system_generated'), id = `${SESSION}/task-7`, log = join(gen, 'tasks', 'task-7.log');
        mkdirSync(join(gen, 'tasks'), { recursive: true }); mkdirSync(join(gen, 'messages'), { recursive: true });
        writeFileSync(log, 'tick 1\n');
        const said = `Created At: now\nTool is running as a background task with task id: ${id}\nTask Description: make bench\nTask logs are available at: file://${log}`;
        update('tool_call', { toolCallId: 'bg-1', kind: 'execute', title: 'make bench', status: 'in_progress', rawInput: { CommandLine: 'make bench', toolSummary: 'Run the benchmark' } });
        update('tool_call_update', { toolCallId: 'bg-1', kind: 'execute', title: 'make bench', status: 'completed', rawInput: { CommandLine: 'make bench', toolSummary: 'Run the benchmark' }, content: [{ type: 'content', content: { type: 'text', text: said } }] });
        chunk('It runs in the background.'); reply(r.id, { stopReason: 'end_turn' });
        setTimeout(() => appendFileSync(log, 'tick 2\n'), 600);
        if (scenario().taskMs !== 0) setTimeout(() => writeFileSync(join(gen, 'messages', 'done.json'), JSON.stringify({ id: 'done', recipient: SESSION, sender: id, timestamp: new Date().toISOString(),
          renderDetails: { messageTitle: 'Run the benchmark finished' }, content: `Task id "${id}" finished with result:\nCommand exited with code 0.\n\nCommand output:\ntick 1\ntick 2\ndone\n` })), scenario().taskMs ?? 2600);
        break;
      }
      // An agent, as the real CLI runs one: invoke_subagent returns at once; the agent is a conversation of its own
      // in the data directory (~/.gemini/<dir>/brain/<id>), started by a message carrying the brief, and it sends
      // its report back to the parent as a message. Its steps are written as it works.
      if (text === 'agent') {
        const brain = join(process.env.HOME, '.gemini', dataDir, 'brain'), child = join(brain, 'child-1', '.system_generated'), parent = join(brain, SESSION, '.system_generated'); // (the session id has a slash: a folder inside a folder)
        const now = () => new Date().toISOString();
        mkdirSync(join(child, 'messages'), { recursive: true }); mkdirSync(join(child, 'logs'), { recursive: true }); mkdirSync(join(parent, 'messages'), { recursive: true });
        const sender = SESSION;
        writeFileSync(join(child, 'messages', 'm-1.json'), JSON.stringify({ id: 'm-1', recipient: 'child-1', sender, timestamp: now(), content: 'Audit src/ for dead code' }));
        const step = entry => appendFileSync(join(child, 'logs', 'transcript_full.jsonl'), JSON.stringify({ created_at: now(), status: 'DONE', ...entry }) + '\n');
        step({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'brief' });
        step({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', model: 'gemini-test', input_tokens: 100, output_tokens: 20, tool_calls: [{ name: 'run_command', args: { CommandLine: 'rg -n TODO src', toolSummary: 'Find TODOs' } }, { name: 'view_file', args: { AbsolutePath: '/work/src/a.js' } }] });
        step({ step_index: 2, source: 'MODEL', type: 'GENERIC', content: 'Command output' });
        update('tool_call', { toolCallId: 'a-1', kind: 'other', title: 'Run invoke_subagent', status: 'in_progress', rawInput: { Prompt: 'Audit src/ for dead code', Role: 'Auditor', TypeName: 'research' } });
        update('tool_call_update', { toolCallId: 'a-1', kind: 'other', title: 'Run invoke_subagent', status: 'completed', rawInput: { Prompt: 'Audit src/ for dead code', Role: 'Auditor', TypeName: 'research' } });
        chunk('The auditor is on it.'); reply(r.id, { stopReason: 'end_turn' });
        if (scenario().agentMs !== 0) setTimeout(() => {
          step({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', model: 'gemini-test', input_tokens: 200, output_tokens: 40, tool_calls: [{ name: 'send_message', args: { Message: 'Found two dead files: a.js and b.js.' } }] });
          step({ step_index: 4, source: 'MODEL', type: 'GENERIC', content: 'Message sent.' });
          step({ step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', model: 'gemini-test', input_tokens: 10, output_tokens: 5, content: 'Reported back.' });
          writeFileSync(join(parent, 'messages', 'r-1.json'), JSON.stringify({ id: 'r-1', recipient: sender, sender: 'child-1', timestamp: now(), content: 'Found two dead files: a.js and b.js.', renderDetails: { messageTitle: 'Message from Auditor (research)' } }));
        }, scenario().agentMs ?? 1200);
        break;
      }
      // A turn that uses the CLI's ordinary tools, reported as the real CLI reports them (kind, title, rawInput).
      if (text === 'tools') {
        const tool = (id, fields, done = {}) => { update('tool_call', { toolCallId: id, status: 'in_progress', ...fields }); update('tool_call_update', { toolCallId: id, status: 'completed', ...fields, ...done }); };
        update('agent_thought_chunk', { content: { type: 'text', text: 'First the command.' } });
        tool('t-1', { kind: 'execute', title: 'echo hi && ls', rawInput: { CommandLine: 'echo hi && ls', WaitMsBeforeAsync: 5000, toolSummary: 'Run echo and ls', apiKey: 'fixture-private-raw-input' } }, { content: [{ type: 'content', content: { type: 'text', text: 'Created At: 2026-11-24T09:15:32-08:00\nCompleted At: 2026-11-24T09:15:40-08:00\nCommand exited with code 0.\n\nCommand output:\nhi\nnotes.txt' } }] });
        update('agent_thought_chunk', { content: { type: 'text', text: 'Then the files.' } });
        tool('t-2', { kind: 'read', title: 'File notes.txt', rawInput: { Path: '/work/notes.txt' }, locations: [{ path: '/work/notes.txt' }] });
        tool('t-3', { kind: 'edit', title: 'File out.txt', rawInput: { Content: 'done\n', Overwrite: true, Path: '/work/out.txt' }, locations: [{ path: '/work/out.txt' }] });
        // A change to a file names what it replaces; a change of another shape only gives the file before and after, at the end.
        tool('t-3b', { kind: 'edit', title: 'File notes.txt', rawInput: { Path: '/work/notes.txt', Target: 'beta', Replacement: 'BETA' }, locations: [{ path: '/work/notes.txt' }] }, { content: [{ type: 'diff', path: '/work/notes.txt', oldText: 'alpha\nbeta\n', newText: 'alpha\nBETA\n' }] });
        tool('t-3c', { kind: 'edit', title: 'File list.txt', rawInput: { Path: '/work/list.txt', Chunks: 2 }, locations: [{ path: '/work/list.txt' }] }, { content: [{ type: 'diff', path: '/work/list.txt', oldText: 'one\ntwo\n', newText: 'one\n2\n' }] });
        tool('t-4', { kind: 'search', title: '"Iris versicolor" on Web', rawInput: { query: 'Iris versicolor' } });
        tool('t-5', { kind: 'other', title: 'Run something_else', rawInput: { token: 'fixture-private-raw-input' } });
        chunk('All four done.'); reply(r.id, { stopReason: 'end_turn' }); break;
      }
      // The model asks the person something. The real CLI does not wait inside the turn: it ends it with the
      // tool pending, takes the next message as the answer, and only then reports the tool as completed.
      if (text === 'ask' || text === 'ask twice') {
        const questions = [{ is_multi_select: false, options: ['red', 'green', 'blue'], question: 'Which colour do you prefer?' },
          ...(text === 'ask twice' ? [{ is_multi_select: true, options: ['small', 'large'], question: 'Which sizes?' }] : [])];
        const askId = `q-${(cache().asks ?? 0) + 1}`; // (every call has an id of its own, as in the real CLI)
        update('tool_call', { toolCallId: askId, kind: 'other', title: 'Run ask_question', status: 'in_progress', rawInput: { questions } });
        update('tool_call_update', { toolCallId: askId, kind: 'other', title: 'Run ask_question', status: 'pending', rawInput: { questions } });
        // (The real CLI then writes the question out as text as well.)
        chunk(questions.map(q => `${q.question}\n\n${q.options.map((option, i) => `- [${i + 1}] ${option}`).join('\n')}`).join('\n\n'));
        save({ ...cache(), asked: questions, asks: (cache().asks ?? 0) + 1 });
        reply(r.id, { stopReason: 'end_turn' }); break;
      }
      if (cache().asked) {
        const questions = cache().asked;
        save({ ...cache(), asked: undefined });
        update('tool_call_update', { toolCallId: `q-${cache().asks}`, kind: 'other', title: 'Run ask_question', status: 'completed', rawInput: { questions } });
        chunk(`Answer received: ${text}`); reply(r.id, { stopReason: 'end_turn' }); break;
      }
      // A turn that goes on until it is cancelled.
      if (text === 'long') { turn = { id: r.id, text }; chunk('Working on it'); break; }
      // A command that takes a while: the model's own time in the turn is the turn's length less this.
      // (As in the real CLI: it says how full the context is when a turn starts and each time a model request
      // ends, and names a request's tool calls right after that.)
      if (text === 'slow command') {
        update('usage_update', { used: 0, size: 1000000 });
        update('agent_thought_chunk', { content: { type: 'text', text: 'A command first, then the answer.' } });
        update('usage_update', { used: 500, size: 1000000 });
        update('tool_call', { toolCallId: 'slow-1', kind: 'execute', title: 'sleep 1', status: 'in_progress', rawInput: { CommandLine: 'sleep 1' } });
        setTimeout(() => { update('tool_call_update', { toolCallId: 'slow-1', kind: 'execute', title: 'sleep 1', status: 'completed', rawInput: { CommandLine: 'sleep 1' } }); chunk('Slept, and here is a sentence about it.');
          update('usage_update', { used: 560, size: 1000000 });
          reply(r.id, { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 40, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 10, totalTokens: 140 } }); }, 400);
        break;
      }
      // A turn whose model thought far more than it showed (Antigravity shows a summary of the thinking): what was
      // written is 25 tokens or so, what is counted 250.
      if (text === 'hidden thinking') {
        update('usage_update', { used: 0, size: 1000000 });
        chunk('x'.repeat(100));
        reply(r.id, { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 250, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 225, totalTokens: 350 } });
        break;
      }
      // A model that takes a while to begin: the thought comes whole, then the answer in pieces.
      if (text === 'slow start') {
        update('usage_update', { used: 0, size: 1000000 });
        setTimeout(() => { update('agent_thought_chunk', { content: { type: 'text', text: 'A thought of forty characters, all at once' } }); chunk('The first half of it, ');
          setTimeout(() => { chunk('and the second half.');
            update('usage_update', { used: 300, size: 1000000 });
            reply(r.id, { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 40, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 10, totalTokens: 140 } }); }, 120); }, 150);
        break;
      }
      // A turn with the token counts the CLI gives (cached tokens are counted apart from the input).
      if (text === 'counted') { chunk('Counted.'); reply(r.id, { stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 24, cachedReadTokens: 600, cachedWriteTokens: 0, thoughtTokens: 22, totalTokens: 1624 } }); break; }
      if (text === 'simple' || bypass) { chunk('No settings needed.'); reply(r.id, { stopReason: 'end_turn' }); break; }
      turn = { id: r.id, permission: `permission-${++nextPermission}`, text };
      chunk('foreign session should be ignored', 'wrong-session');
      chunk('Hello 🪐'); chunk('\u2028world');
      update('agent_thought_chunk', { content: { type: 'text', text: 'Thinking' } });
      update('tool_call', { toolCallId, title: 'Read fixture', kind: 'read', status: 'pending', locations: [{ path: '/work/fixture.txt' }], rawInput: { apiKey: 'fixture-private-raw-input' } });
      send({ id: turn.permission, method: 'session/request_permission', params: { sessionId: SESSION, toolCall: { toolCallId }, options: [
        { optionId: 'allow-once-original-id', name: 'Allow this read', kind: 'allow_once' },
        { optionId: 'reject-once-original-id', name: 'Reject this read', kind: 'reject_once' },
      ] } });
      if (text === 'disconnect') process.stdout.write('', () => process.exit(22));
      if (text === 'finish with pending permission') {
        reply(turn.id, { stopReason: 'end_turn' });
        turn = undefined;
      }
      break;
    }
    case 'session/cancel':
      assert.deepEqual(r.params, { sessionId: SESSION });
      assert.ok(turn);
      turn.cancelled = true;
      // Send a last chunk, then acknowledge asynchronously. abort must not settle on send.
      chunk('Final update after cancel.');
      if (turn.text !== 'unresponsive') cancelTimer = setTimeout(() => {
        const id = turn.id;
        turn = undefined;
        reply(id, { stopReason: 'cancelled' });
      }, 100);
      break;
    default:
      if (!turn || r.id !== turn.permission) break;
      if (turn.cancelled) {
        assert.deepEqual(r.result, { outcome: { outcome: 'cancelled' } });
        break;
      }
      const allowed = r.result?.outcome?.optionId === 'allow-once-original-id';
      update('tool_call_update', { toolCallId, status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'Preparing read' } }] });
      update('tool_call_update', { toolCallId, status: allowed ? 'completed' : 'failed', rawOutput: { token: 'fixture-private-raw-output' },
        content: [{ type: 'content', content: { type: 'text', text: allowed ? 'Tool output' : 'Permission denied' } }] });
      effort = 'high';
      if (!scenario().noOptions) update('config_option_update', { configOptions: options() });
      chunk('Done.');
      reply(turn.id, { stopReason: 'end_turn' });
      turn = undefined;
  }
});
lines.on('close', () => clearTimeout(cancelTimer));
