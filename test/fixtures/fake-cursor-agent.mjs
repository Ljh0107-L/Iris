// An offline stand-in for Cursor's CLI (`cursor-agent`): `status`, `about`, `login`, `logout` and its ACP
// server, as the real one answers them (2026.11). The folder in FAKE_CURSOR_DIR holds what it keeps: whether it
// is signed in (state.json), and a log of what it was asked (calls.jsonl).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const dir = process.env.FAKE_CURSOR_DIR;
const stateFile = join(dir, 'state.json'), logFile = join(dir, 'calls.jsonl');
const state = () => existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const save = value => writeFileSync(stateFile, JSON.stringify({ ...state(), ...value }));
const log = value => appendFileSync(logFile, JSON.stringify(value) + '\n');
const args = process.argv.slice(2);
log({ argv: args, config: process.env.CURSOR_CONFIG_DIR ?? null, noBrowser: process.env.NO_OPEN_BROWSER ?? null });
const signedIn = () => state().signedIn === true;

if (args[0] === 'status') {
  process.stdout.write(JSON.stringify(signedIn() ? { status: 'authenticated', isAuthenticated: true, hasAccessToken: true, userInfo: { email: 'person@example.test', userId: 1 } }
    : { status: 'unauthenticated', isAuthenticated: false, message: 'Not logged in' }) + '\n');
  process.exit(0);
}
if (args[0] === 'about') { process.stdout.write(JSON.stringify({ cliVersion: '2026.11.22-fake', subscriptionTier: 'Pro', userEmail: 'person@example.test' }) + '\n'); process.exit(0); }
if (args[0] === 'logout') { save({ signedIn: false }); process.stdout.write('Logged out\n'); process.exit(0); }
if (args[0] === 'login') {
  // With NO_OPEN_BROWSER it prints the page instead of opening it, and waits until that page is done.
  process.stdout.write('\nPlease open the following URL in your browser:\n\nhttps://cursor.com/loginDeepControl?challenge=fixture&uuid=fixture&mode=login\n\nWaiting for browser authentication...\n');
  setTimeout(() => { save({ signedIn: true }); process.stdout.write('\nLogin successful!\n'); process.exit(0); }, Number(process.env.FAKE_CURSOR_LOGIN_MS ?? 80));
} else {
  const acp = args.filter(arg => arg !== '--force');
  if (acp.join(' ') !== 'acp') { process.stderr.write(`unexpected arguments: ${args.join(' ')}\n`); process.exit(2); }
  serve(args.includes('--force'));
  // Like the real one, its ACP server keeps running when its input ends: it has to be stopped.
  log({ acpPid: process.pid });
  setInterval(() => {}, 1 << 30);
}

// Each model with its own settings, as cursor/list_available_models gives them.
const MODELS = [
  { value: 'auto-smart', name: 'Auto', configOptions: [{ id: 'optimize_for', name: 'Optimize For', category: 'model_config', type: 'select', currentValue: 'balanced', options: [{ value: 'intelligence', name: 'Intelligence' }, { value: 'balanced', name: 'Balance' }] }] },
  { value: 'composer-2.5', name: 'Composer 2.5', configOptions: [{ id: 'fast', name: 'Fast', category: 'model_config', type: 'select', currentValue: 'true', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast​​' }] }] },
  { value: 'grok-4.7', name: 'Grok 4.7', configOptions: [
    { id: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
    { id: 'fast', name: 'Fast', category: 'model_config', type: 'select', currentValue: 'false', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }] }] },
];

function serve(force) {
  const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const SESSION = 'cursor-session-1';
  const update = fields => send({ method: 'session/update', params: { sessionId: SESSION, update: fields } });
  // The model and its settings: a process starts with the choice made last in its config directory, then keeps
  // its own (another process changing the directory's choice does not change it), as the real CLI does.
  let mine = null;
  const choice = () => mine ?? state().choice ?? { model: 'auto-smart', settings: {} };
  const configOptions = () => {
    const { model, settings } = choice(), current = MODELS.find(m => m.value === model);
    return [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'agent', options: [{ value: 'agent', name: 'Agent' }, { value: 'plan', name: 'Plan' }] },
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: MODELS.map(m => ({ value: m.value, name: m.name })) },
      ...current.configOptions.map(o => ({ ...o, currentValue: settings[o.id] ?? o.currentValue }))];
  };
  let authenticated = false, asked = null;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  createInterface({ input: process.stdin }).on('line', async line => {
    const m = JSON.parse(line);
    log({ method: m.method ?? null, id: m.id ?? null, params: m.params ?? null, result: m.result ?? null });
    if (m.method == null) { if (asked && m.id === asked.id) asked.resolve(m.result); return; }
    const reply = result => send({ id: m.id, result }), fail = (code, message) => send({ id: m.id, error: { code, message } });
    switch (m.method) {
      case 'initialize': return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {} } },
        authMethods: [{ id: 'cursor_login', name: 'Cursor Login', description: "Run 'agent login' first if not logged in." }] });
      case 'authenticate': if (!signedIn()) return fail(-32000, 'Authentication required'); authenticated = true; return reply({});
      case 'cursor/list_available_models': if (!authenticated) return fail(-32000, 'Authentication required'); return reply({ models: MODELS });
      case 'session/new': case 'session/load': if (!authenticated) return fail(-32000, 'Authentication required');
        save({ mcpServers: (m.params.mcpServers ?? []).map(server => server.name) });
        return reply({ ...(m.method === 'session/new' ? { sessionId: SESSION } : {}), configOptions: configOptions() });
      case 'session/set_config_option': {
        const { configId, value } = m.params;
        mine = configId === 'model' ? { model: value, settings: {} } : { ...choice(), settings: { ...choice().settings, [configId]: value } };
        save({ choice: mine });
        return reply({ configOptions: configOptions() });
      }
      case 'session/prompt': {
        const text = m.params.prompt.find(p => p.type === 'text')?.text ?? '';
        save({ prompted: [...(state().prompted ?? []), { text, choice: choice() }] });
        if (choice().model === 'auto-smart') update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '> Auto routed to Fake Sonnet\n\n' } });
        await sleep(60); // the wait for the first token
        for (const piece of ['Looking at ', 'the folder first.']) { update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: piece } }); await sleep(15); }
        if (/list/.test(text)) {
          update({ sessionUpdate: 'tool_call', toolCallId: 'call_1\nfc_1', title: '`ls`', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } });
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1\nfc_1', status: 'in_progress' });
          await sleep(200); // the command runs: not the model's time
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1\nfc_1', status: 'completed', rawOutput: { exitCode: 0, stdout: 'a.txt\nb.txt\n', stderr: '' } });
          update({ sessionUpdate: 'tool_call', toolCallId: 'call_2', title: 'Read a.txt', kind: 'read', status: 'pending', rawInput: { path: '/w/a.txt' }, locations: [{ path: '/w/a.txt' }] });
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_2', status: 'completed', rawOutput: { content: 'alpha\n' } });
          update({ sessionUpdate: 'tool_call', toolCallId: 'call_3', title: 'Update todos', kind: 'other', status: 'pending', rawInput: { _toolName: 'updateTodos', todos: [{ id: '1', content: 'Read the files', status: 'TODO_STATUS_COMPLETED' }, { id: '2', content: 'Answer', status: 'TODO_STATUS_IN_PROGRESS' }] } });
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_3', status: 'completed' });
          await sleep(40);
        }
        if (/draw/.test(text)) {
          // Its generateImage tool: the tool, then a notification naming the file it wrote.
          const file = join(dir, 'pelican.png');
          writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'));
          update({ sessionUpdate: 'tool_call', toolCallId: 'call_img', title: 'Generate Image: a pelican on a bicycle...', kind: 'other', status: 'pending', rawInput: { _toolName: 'generateImage', description: 'a pelican on a bicycle', filename: 'pelican.png' } });
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_img', status: 'completed' });
          // (Cursor's "notifications" are requests it does not wait on.)
          send({ id: 'img-1', method: 'cursor/generate_image', params: { toolCallId: 'call_img', description: 'a pelican on a bicycle', filePath: file } });
          await sleep(20);
        }
        if (/visualize/.test(text)) {
          // An MCP call (Iris's visual tool), as Cursor reports one: named and given its input only after it began.
          update({ sessionUpdate: 'tool_call', toolCallId: 'call_viz', title: 'MCP: tool', kind: 'other', status: 'pending', rawInput: {} });
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_viz', title: 'iris: show_visual', rawInput: { providerIdentifier: 'iris', toolName: 'show_visual', args: { title: 'Dot', html: '<canvas></canvas>' } } });
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_viz', status: 'completed', rawOutput: { success: true } });
        }
        if (/ask/.test(text)) {
          const answer = await new Promise(resolve => {
            asked = { id: 'ask-1', resolve };
            send({ id: 'ask-1', method: 'cursor/ask_question', params: { toolCallId: 'call_q', title: 'Need input', questions: [{ id: 'q1', prompt: 'Red or blue?', options: [{ id: 'red', label: 'Red' }, { id: 'blue', label: 'Blue' }] }] } });
          });
          asked = null;
          save({ answer });
        }
        update({ sessionUpdate: 'session_info_update', title: 'Fake Folder Listing' });
        for (const piece of ['Two files: ', 'a.txt and ', 'b.txt.']) { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } }); await sleep(15); }
        return reply({ stopReason: 'end_turn' }); // the real CLI counts no tokens
      }
      case 'session/cancel': return;
      default: return fail(-32601, `Method not found: ${m.method}`);
    }
  });
  void force;
}
