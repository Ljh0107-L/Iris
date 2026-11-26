// Antigravity engine: Pi RPC ⇄ the official CLI's ACP v1 stdio server.
// The CLI owns sign-in, credentials, tools and model access. This adapter has no API fallback.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { visualServer } from './iris-visual.mjs';

// The agents this adapter runs: each is its vendor's official CLI, spoken to over ACP and signed in with the
// person's own account there. What differs between them is here.
export const PROFILES = {
  antigravity: { engine: 'antigravity', label: 'Antigravity', service: 'Google', authMethod: 'oauth-personal', binding: 'iris-antigravity-session',
    args: config => ['acp', ...(config.appDataDir ? ['--app-data-dir', config.appDataDir] : []), ...(config.bypassPermissions ? ['--dangerously-skip-permissions'] : [])],
    loginArgs: dataDir => ['acp', '--login', ...(dataDir ? ['--app-data-dir', dataDir] : [])], homeEnv: () => ({}) },
  // Cursor signs in with its own command (agent login); over ACP it only takes up that sign-in (authenticate),
  // which it needs before anything else. It never opens a browser from here (NO_OPEN_BROWSER).
  // Its model is one choice of the CLI's, shared by its conversations (globalModel): each conversation here
  // keeps its own and sets it again before it sends. It asks for a model's settings (effort, context, speed)
  // as menus of their own (parameterizedModelPicker) rather than as one long list of every combination. It
  // says nothing between a turn's model requests, so a tool call is where one ends (requestsByTools).
  cursor: { engine: 'cursor', label: 'Cursor', service: 'Cursor', authMethod: 'cursor_login', binding: 'iris-cursor-session', authenticate: true, acpSignIn: false,
    env: { NO_OPEN_BROWSER: '1' }, clientCapabilities: { _meta: { parameterizedModelPicker: true } }, globalModel: true, listModels: 'cursor/list_available_models', requestsByTools: true,
    titles: true, // it names a conversation after its first message (session_info_update)
    args: config => [...(config.bypassPermissions ? ['--force'] : []), 'acp'],
    loginArgs: () => ['login'], homeEnv: home => text(home) && isAbsolute(home) ? { CURSOR_CONFIG_DIR: home } : {} },
};
const profileOf = engine => PROFILES[Object.hasOwn(PROFILES, engine) ? engine : 'antigravity'];
const CONTROL_MS = 12000;
// Opening a session can wait on a cold CLI or a slow host. A timeout here is not retried (see
// Transcript), so it must be generous: only a CLI that is really stuck should reach it. Together with
// initialize it stays inside the 90s the desktop waits for the first get_state.
const OPEN_MS = 70000;
const MENUS_MS = 20000; // inside the time an account check is given
const LOGIN_MS = 120000;
const ABORT_MS = 6000;
const STANDBY_MS = 10.5 * 60000; // safety net if Desktop exits without stopping its spare (which it keeps for ten minutes)
const MAX_LINE = 8 * 1024 * 1024;
const has = (obj, key) => Object.hasOwn(obj, key);
const text = value => typeof value === 'string' && value.length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const rpcId = value => typeof value === 'string' || Number.isSafeInteger(value);
const output = (stream, value) => stream.write(JSON.stringify(value) + '\n');
const within = async (promise, ms, fallback) => {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms, fallback); })]); }
  finally { clearTimeout(timer); }
};

function readLines(stream, onLine, onOverflow) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let start = 0, end;
    while ((end = buffer.indexOf('\n', start)) !== -1) {
      if (end - start > MAX_LINE) { buffer = ''; onOverflow(); return; }
      if (end > start) onLine(buffer.slice(start, end));
      start = end + 1;
    }
    buffer = buffer.slice(start);
    if (buffer.length > MAX_LINE) { buffer = ''; onOverflow(); }
  });
}

// What the CLI is started with: where things are, the language, and how the network is reached. Not the
// rest of the environment, which can hold keys (GEMINI_API_KEY would replace the Google sign-in). The proxy
// and certificate settings are part of it: on a machine that reaches Google only through a proxy, a CLI
// started without them signs nobody in, however the sign-in itself went.
const CLI_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', // (the commands the agent runs get these too)
  'HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TZ',
  'LC_ALL', 'LC_ADDRESS', 'LC_COLLATE', 'LC_CTYPE', 'LC_IDENTIFICATION', 'LC_MEASUREMENT', 'LC_MESSAGES',
  'LC_MONETARY', 'LC_NAME', 'LC_NUMERIC', 'LC_PAPER', 'LC_TELEPHONE', 'LC_TIME',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS'];
function cliEnv(env, profile = PROFILES.antigravity) {
  return { ...Object.fromEntries(CLI_ENV.filter(key => has(env, key)).map(key => [key, env[key]])), ...profile.env };
}

// A binding is append-only. An interrupted session/new may have reached the CLI, so never
// issue another one for that file unless the CLI confirmed it had rejected the first for auth.
class Transcript {
  constructor({ cwd, sessionsDir, sessionFile, recordId, profile = PROFILES.antigravity }) {
    this.p = profile;
    this.entries = [];
    this.leafId = null;
    this.binding = null;
    const id = randomUUID(), timestamp = new Date().toISOString();
    const dir = join(sessionsDir, this.p.engine);
    this.file = sessionFile ?? join(dir, `${recordId ?? id}.jsonl`);
    let existing = !!sessionFile;
    try {
      const flags = constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
      if (!existing) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        try { this.fd = openSync(this.file, flags | constants.O_CREAT | constants.O_EXCL, 0o600); }
        catch (error) {
          // The adapter may have saved an ACP ID before Desktop observed get_state.
          // With the same record ID, open that file instead of calling session/new again.
          if (error.code !== 'EEXIST' || !recordId) throw error;
          existing = true;
        }
      }
      if (existing) this.fd = openSync(this.file, flags);
      const stat = fstatSync(this.fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Not a private session file');
      if (!existing) {
        this.header = { type: 'session', version: 3, id, timestamp, cwd, engine: this.p.engine };
        this.#write([this.header]);
      } else {
        const records = readFileSync(this.fd, 'utf8');
        if (!records.endsWith('\n')) throw new Error('Incomplete session file');
        const lines = records.split('\n');
        this.header = JSON.parse(lines.shift());
        if (this.header?.type !== 'session' || this.header.engine !== this.p.engine || !text(this.header.id) || this.header.cwd !== cwd) throw new Error('Invalid session header');
        const ids = new Set();
        for (const line of lines) {
          if (!line) continue;
          const entry = JSON.parse(line);
          if (!text(entry?.id) || ids.has(entry.id) || entry.parentId !== this.leafId || entry.type === 'session') throw new Error('Invalid session entry');
          if (entry.type === 'custom' && entry.customType === `${this.p.binding}:choices` && object(entry.data)) this.choices = entry.data;
          if (entry.type === 'custom' && entry.customType === this.p.binding) {
            const binding = entry.data;
            if (this.binding?.sessionId || !object(binding) || !(text(binding.sessionId) || typeof binding.creating === 'boolean')) throw new Error('Invalid session binding');
            this.binding = binding;
          }
          ids.add(entry.id); this.entries.push(entry); this.leafId = entry.id;
        }
        if (!this.binding?.sessionId && this.entries.some(e => e.type === 'message')) throw new Error('Missing ACP session ID');
      }
    } catch {
      this.close();
      throw new Error(existing ? `Cannot read the original ${this.p.label} transcript. No replacement was started.` : `Cannot create a private ${this.p.label} transcript.`);
    }
  }

  #write(entries) {
    try {
      if (this.writeFailed) throw new Error('A previous write failed');
      appendFileSync(this.fd, entries.map(e => JSON.stringify(e) + '\n').join(''));
      fsyncSync(this.fd);
    } catch {
      // An append could have partly succeeded. Do not link a new entry across that uncertainty.
      this.writeFailed = true;
      throw new Error(`Cannot save the ${this.p.label} transcript.`);
    }
  }

  append(entries) {
    let parentId = this.leafId;
    const full = entries.map(entry => {
      const next = { id: randomUUID().replace(/-/g, '').slice(0, 12), parentId, timestamp: new Date().toISOString(), ...entry };
      parentId = next.id;
      return next;
    });
    this.#write(full);
    this.entries.push(...full); this.leafId = parentId;
  }

  bind(data) {
    this.append([{ type: 'custom', customType: this.p.binding, data }]);
    this.binding = data;
  }

  // What this conversation chose (model and its settings), where the CLI keeps one choice for all of them.
  choose(data) {
    this.append([{ type: 'custom', customType: `${this.p.binding}:choices`, data }]);
    this.choices = data;
  }

  messages() { return this.entries.filter(e => e.type === 'message').map(e => e.message); }
  publicEntries() { return this.entries.map(e => e.type === 'custom' && (e.customType === this.p.binding || e.customType === `${this.p.binding}:choices`) ? { ...e, data: undefined } : e); }
  close() { if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; } }
}

// What a request to the CLI was for, in words a person reads in a message.
const REQUESTS = {
  initialize: 'initialize', authenticate: 'complete sign-in', 'session/list': 'check sign-in', 'session/new': 'start a session',
  'session/load': 'load the original session', 'session/resume': 'resume the original session',
  'session/set_config_option': 'change session settings', 'session/prompt': 'complete the prompt',
};
class AcpError extends Error {
  constructor(error, method, label = 'Antigravity') {
    const code = Number.isInteger(error?.code) ? error.code : null;
    const what = REQUESTS[method];
    super(`${label} could not ${what}${code == null ? '' : ` (ACP error ${code})`}.`);
    this.code = code;
    // -32000 is also used as a generic server error by JSON-RPC implementations.
    this.authRequired = code === -32000 && typeof error?.message === 'string' &&
      /^\s*(?:authentication (?:is )?required\b|auth_required\b)/i.test(error.message);
  }
}

class AcpPeer {
  constructor(config, env, onRecord, onDisconnect) {
    this.p = config.profile ?? PROFILES.antigravity;
    if (config.home) try { mkdirSync(config.home, { recursive: true, mode: 0o700 }); } catch { /* the CLI says what is wrong */ }
    try { this.child = spawn(config.bin, this.p.args(config), { cwd: config.cwd, env: { ...cliEnv(env, this.p), ...this.p.homeEnv(config.home) }, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { throw new Error(`Could not start the configured ${this.p.label} CLI.`); }
    this.pending = new Map();
    this.nextId = 0;
    this.seq = 0;
    this.closed = false;
    this.onDisconnect = onDisconnect;
    const broken = () => this.close(new Error(`The ${this.p.label} CLI connection closed.`));
    this.exited = new Promise(resolve => {
      this.child.once('exit', () => {
        resolve(true);
        // Normally stdout closes right after the final records. A descendant could hold it open.
        if (!this.closed) this.drainTimer = setTimeout(broken, 250);
      });
      this.child.on('error', () => {
        if (!this.child.pid) resolve(true);
        this.close(new Error(`Could not start or communicate with the configured ${this.p.label} CLI.`));
      });
    });
    this.child.once('close', broken);
    this.child.stdout.once('end', broken);
    this.child.stdout.on('error', broken);
    this.child.stdin.on('error', broken);
    readLines(this.child.stdout, line => {
      if (this.closed) return;
      try {
        const record = JSON.parse(line);
        if (record?.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC record');
        const seq = ++this.seq;
        if (typeof record.method === 'string') onRecord(this, record, seq);
        else if (this.pending.has(record.id)) {
          const p = this.pending.get(record.id);
          this.pending.delete(record.id); clearTimeout(p.timer);
          if (has(record, 'error')) p.reject(new AcpError(record.error, p.method, this.p.label));
          else if (has(record, 'result')) p.resolve({ result: record.result, seq });
          else p.reject(new Error(`Invalid response from the ${this.p.label} CLI.`));
        }
      } catch { this.close(new Error(`The ${this.p.label} CLI sent an invalid ACP record.`)); }
    }, () => this.close(new Error(`An ${this.p.label} CLI ACP record exceeded the size limit.`)));
  }

  send(fields) {
    if (this.closed) return;
    output(this.child.stdin, { jsonrpc: '2.0', ...fields });
  }

  request(method, params, timeout = CONTROL_MS) {
    if (this.closed) return Promise.reject(new Error(`The ${this.p.label} CLI connection closed.`));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      // No answer usually means the CLI is waiting on the network: it asks Google before it replies.
      const timer = timeout ? setTimeout(() => this.close(new Error(`${this.p.label} did not answer in time (asked to ${REQUESTS[method] ?? method}). It may not be reaching ${this.p.service} from this machine.`)), timeout) : null;
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  close(error) {
    if (this.closed) return this.stopped;
    this.closed = true;
    clearTimeout(this.drainTimer);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.child.stdin.end();
    const signal = name => { try { this.child.kill(name); } catch { /* relay owns escalation */ } };
    this.stopped = (async () => {
      if (await within(this.exited, 250, false)) return true;
      signal('SIGTERM');
      if (await within(this.exited, 500, false)) return true;
      signal('SIGKILL');
      return within(this.exited, 750, false);
    })().finally(() => this.child.stdout.destroy());
    this.onDisconnect(this);
    return this.stopped;
  }
}

const initParams = (version, P = PROFILES.antigravity) => ({ protocolVersion: 1, clientCapabilities: P.clientCapabilities ?? {},
  clientInfo: { name: 'iris', title: 'Iris', version: version ?? '0.0.0' } });
// The CLI takes a plain name for its data directory, which it keeps under ~/.gemini beside its own.
const dataDirName = home => text(home) && /^[\w.-]+$/.test(home) && !home.startsWith('.') ? home : undefined;
const personalAuth = (init, P = PROFILES.antigravity) => P.acpSignIn !== false && Array.isArray(init?.authMethods) && init.authMethods.some(m => m?.id === P.authMethod && (m.type == null || m.type === 'agent'));

// Settings can probe or authenticate without opening a chat. session/list is read-only;
// its result (including the user's conversation metadata) never leaves this process.
// home: Iris's own Antigravity data directory, the one its conversations use. The check and the sign-in
// must use it too: where there is no keychain (an SSH host), the CLI keeps a sign-in in its data directory,
// so one made or looked for in another directory is not the one a conversation gets.
// menus: { dir } asks, once signed in, what a new conversation can choose from. ACP only says that in the
// reply to session/new, so one is opened in `dir` (an empty folder of Iris's) and closed again; no message
// is sent.
async function account({ bin, cwd, login, version, home = null, menus = null, profile: P = PROFILES.antigravity }) {
  if (!isAbsolute(bin ?? '')) throw new Error(`Missing ${P.label} CLI.`);
  const appDataDir = dataDirName(home);
  const probe = menus && isAbsolute(menus.dir ?? '') && appDataDir ? menus : null;
  const peer = new AcpPeer({ bin, cwd, profile: P, ...(appDataDir ? { appDataDir } : {}) }, process.env, (p, r) => {
    if (rpcId(r.id)) p.send({ id: r.id, error: { code: -32601, message: 'Method not supported' } });
  }, () => {});
  let canSignIn = false;
  try {
    const { result: init } = await peer.request('initialize', initParams(version, P));
    if (init?.protocolVersion !== 1) throw new Error(`The ${P.label} CLI did not negotiate ACP version 1.`);
    canSignIn = personalAuth(init, P);
    // Cursor takes up its own sign-in first; without one it says so (authRequired, below).
    if (P.authenticate) await peer.request('authenticate', { methodId: P.authMethod });
    const canCheck = object(init.agentCapabilities?.sessionCapabilities?.list);
    if (login) {
      if (!canSignIn) return { signedIn: null, canSignIn };
      await peer.request('authenticate', { methodId: P.authMethod }, LOGIN_MS);
    }
    if (canCheck) await peer.request('session/list', {});
    const signedIn = canCheck || login ? true : null;
    let options = [], plan = null;
    if (signedIn && probe) {
      try {
        mkdirSync(probe.dir, { recursive: true });
        const { result } = await peer.request('session/new', { cwd: probe.dir, mcpServers: [] }, MENUS_MS);
        options = selectConfig(result?.configOptions);
        plan = text(result?._meta?.antigravity?.tier?.name) ? result._meta.antigravity.tier.name.slice(0, 60) : null; // "Google AI Pro"
        if (text(result?.sessionId) && object(init.agentCapabilities?.sessionCapabilities?.close)) await peer.request('session/close', { sessionId: result.sessionId }).catch(() => {});
      } catch { /* the sign-in is known all the same; the menus appear with the first conversation */ }
    }
    return { signedIn, canSignIn, ...(plan ? { plan } : {}), ...(options.length ? { options } : {}) };
  } catch (error) {
    if (error.authRequired) return { signedIn: false, canSignIn };
    if (error.code === -32601 && !login) return { signedIn: null, canSignIn };
    throw error;
  } finally { await peer.close(new Error('Account check finished.')); }
}

// A name as shown: some CLIs pad theirs with invisible characters (Cursor's "Fast\u200b\u200b").
const shownName = name => name.replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();
export function selectConfig(options) {
  const seen = new Set();
  return (Array.isArray(options) ? options : []).flatMap(o => {
    if (!text(o?.id) || seen.has(o.id) || o.type !== 'select' || !text(o.name) || !shownName(o.name) || typeof o.currentValue !== 'string') return [];
    // The model, its reasoning and its other settings (Cursor's context, speed), not CLI permission modes.
    const category = o.category ?? (o.id === 'model' ? 'model' : ['effort', 'thinking', 'thinking_level', 'thought_level'].includes(o.id) ? 'thought_level' : null);
    if (category !== 'model' && category !== 'thought_level' && category !== 'model_config') return [];
    seen.add(o.id);
    const values = new Set();
    const choices = (Array.isArray(o.options) ? o.options : []).flatMap(choice =>
      text(choice?.group) && Array.isArray(choice.options) ? choice.options : [choice]);
    return [{ id: o.id, name: shownName(o.name), category, currentValue: o.currentValue,
      options: choices.flatMap(choice => {
        if (typeof choice?.value !== 'string' || values.has(choice.value) || !text(choice.name) || !shownName(choice.name)) return [];
        values.add(choice.value);
        return [{ value: choice.value, name: shownName(choice.name) }];
      }) }];
  });
}

// Antigravity's own tools, by what the CLI sends for them: `update_steps` carries the whole task list,
// `invoke_subagent` the role and the brief of an agent it starts.
// Cursor's task list (its updateTodos tool) and the agents it starts (task) come as a tool's input, named in
// `_toolName`; a status may be a word or an enum name ("TODO_STATUS_IN_PROGRESS").
const todoStatus = status => /complete|done/i.test(String(status ?? '')) ? 'completed' : /progress/i.test(String(status ?? '')) ? 'in_progress' : 'pending';
function stepsOf(update) {
  const todos = update?.rawInput?.todos;
  if (update?.rawInput?._toolName === 'updateTodos' && Array.isArray(todos)) {
    return todos.filter(todo => text(todo?.content)).slice(0, 50).map(todo => ({ content: todo.content.slice(0, 300), status: todoStatus(todo.status) }));
  }
  const steps = update?.rawInput?.steps;
  if (!/update_steps/i.test(update?.title ?? '') || !Array.isArray(steps)) return null;
  return steps.filter(step => text(step?.title)).slice(0, 50).map(step => ({ content: step.title.slice(0, 300),
    status: step.status === 'done' || step.status === 'completed' ? 'completed' : step.status === 'in_progress' ? 'in_progress' : 'pending' }));
}
// A question the model puts to the person (ask_question): the question, and the answers it offers. The CLI
// does not wait for the answer inside the turn: it ends the turn with the tool pending, and takes the next
// message as the answer. So the question is shown as a card when the turn ends (see #finishTurn), and the
// choice made there is sent as that next message.
function asksOf(tool) {
  const questions = tool.raw?.questions;
  if (!/ask_question/i.test(tool.title ?? '') || !Array.isArray(questions)) return null;
  const asks = questions.filter(q => text(q?.question)).slice(0, 8).map(q => ({ question: q.question.slice(0, 2000),
    options: [...new Set((Array.isArray(q.options) ? q.options : []).filter(text).map(option => option.slice(0, 300)))].slice(0, 24), multi: q.is_multi_select === true }));
  return asks.length ? asks : null;
}
function agentOf(tool) {
  const raw = tool.raw;
  if (raw?._toolName === 'task' && (text(raw.prompt) || text(raw.description))) {
    const type = typeof raw.subagentType === 'string' ? raw.subagentType : text(raw.subagentType?.custom) ? raw.subagentType.custom : null;
    return { name: 'Task', arguments: { description: (text(raw.description) ? raw.description : raw.prompt.split('\n')[0]).slice(0, 120), prompt: String(raw.prompt ?? '').slice(0, 4000),
      subagent_type: type && !/^(unspecified|SUBAGENT_TYPE_UNSPECIFIED)$/i.test(type) ? type.replace(/^SUBAGENT_TYPE_/, '').toLowerCase().slice(0, 40) : 'Agent' } };
  }
  if (!/invoke_subagent/i.test(tool.title ?? '') || !text(raw?.Prompt)) return null;
  return { name: 'Task', arguments: { description: (text(raw.Role) ? raw.Role : raw.Prompt.split('\n')[0]).slice(0, 120), prompt: raw.Prompt.slice(0, 4000),
    subagent_type: text(raw.TypeName) && raw.TypeName !== 'self' ? raw.TypeName.slice(0, 40) : 'Agent', ...(text(raw.Model) ? { model: raw.Model.slice(0, 60) } : {}) } };
}
// The CLI's ordinary tools, shown the way Pi's and Claude Code's are: a command, a file read or written, a web
// search. The CLI names the kind of each and gives its input (CommandLine, Path, query); anything else keeps
// the CLI's own title. Only those fields are read: the rest of a tool's input is not passed on.
// The time a turn's tools ran, with runs that overlap counted once. A turn's length less this is the time the
// model itself took, which is what the turn's speed is measured over.
const toolTime = runs => {
  let total = 0, until = -Infinity;
  for (const [start, end] of runs.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0])) { total += Math.max(0, end - Math.max(start, until)); until = Math.max(until, end); }
  return total;
};
const EDIT_SHOWN = 200000; // characters of a written or changed file kept for the conversation
// The file before and after a change, as the CLI reports it once the change is made.
const shownDiff = content => { const diff = (Array.isArray(content) ? content : []).find(block => block?.type === 'diff' && typeof block.newText === 'string'); return diff ? { oldText: typeof diff.oldText === 'string' ? diff.oldText : null, newText: diff.newText } : null; };
// (Cursor names a command `command`, a file `path`, a code search `pattern`, a web search `searchTerm`.)
function toolOf(tool) {
  const raw = tool.raw ?? {};
  const named = [raw.Path, raw.path].find(value => text(value) && isAbsolute(value));
  const path = tool.paths[0] ?? named ?? null;
  // Iris's visual tool (its MCP server, by whatever name the CLI gives it): the page is the call's argument. Cursor
  // gives an MCP call as { providerIdentifier, toolName, args }.
  const visual = object(raw.args) && raw.toolName === 'show_visual' ? raw.args : raw;
  if (typeof visual.html === 'string' && (/show_visual|show a visual/i.test(`${tool.cliName ?? ''} ${tool.title ?? ''} ${raw._toolName ?? ''} ${raw.toolName ?? ''}`) || /<(html|body|canvas|svg|script)\b/i.test(visual.html))) return { name: 'mcp__iris__show_visual',
    arguments: { title: text(visual.title) ? visual.title.slice(0, 200) : 'Visual', html: visual.html, ...(Number.isFinite(visual.height) ? { height: visual.height } : {}), ...(text(visual.id) ? { id: visual.id.slice(0, 120) } : {}) } };
  if (raw._toolName === 'askQuestion' && Array.isArray(raw.questions)) return { name: 'AskUserQuestion', arguments: { questions: raw.questions.filter(q => text(q?.prompt)).slice(0, 8)
    .map(q => ({ question: q.prompt.slice(0, 2000), options: (Array.isArray(q.options) ? q.options : []).filter(o => text(o?.label)).slice(0, 24).map(o => ({ label: o.label.slice(0, 300) })), ...(q.allowMultiple ? { multiSelect: true } : {}) })) } };
  if (tool.kind === 'execute') {
    const command = text(raw.CommandLine) ? raw.CommandLine : text(raw.command) ? raw.command : tool.title;
    return text(command) ? { name: 'bash', arguments: { command: command.slice(0, 20000), ...(text(raw.toolSummary) ? { description: raw.toolSummary.slice(0, 200) } : {}) } } : null;
  }
  if (tool.kind === 'read' && path) return { name: 'read', arguments: { path } };
  if (tool.kind === 'edit' && path) {
    // A new file comes with its content; a change to one names what it replaces (Target, Replacement), and
    // when it is done the CLI also gives the file before and after.
    if (typeof raw.Content === 'string') return { name: 'write', arguments: { path, content: raw.Content.slice(0, EDIT_SHOWN) } };
    if (typeof raw.Target === 'string' && typeof raw.Replacement === 'string') return { name: 'edit', arguments: { path, edits: [{ oldText: raw.Target.slice(0, EDIT_SHOWN), newText: raw.Replacement.slice(0, EDIT_SHOWN) }] } };
    const diff = tool.diff;
    if (diff && diff.oldText == null) return { name: 'write', arguments: { path, content: diff.newText.slice(0, EDIT_SHOWN) } };
    if (diff && diff.oldText.length <= EDIT_SHOWN && diff.newText.length <= EDIT_SHOWN) return { name: 'edit', arguments: { path, edits: [{ oldText: diff.oldText, newText: diff.newText }] } };
    return { name: 'edit', arguments: { path } };
  }
  if (tool.kind === 'search' && text(raw.searchTerm)) return { name: 'WebSearch', arguments: { query: raw.searchTerm.slice(0, 500) } };
  if (tool.kind === 'search' && text(raw.pattern)) return text(raw.path) || !/[*?{]/.test(raw.pattern)
    ? { name: 'grep', arguments: { pattern: raw.pattern.slice(0, 2000), ...(text(raw.path) ? { path: raw.path.slice(0, 4000) } : {}) } }
    : { name: 'find', arguments: { pattern: raw.pattern.slice(0, 2000) } };
  if (tool.kind === 'search' && Object.keys(raw).length === 1 && text(raw.path)) return { name: 'ls', arguments: { path: raw.path.slice(0, 4000) } };
  if (tool.kind === 'search' && text(raw.query) && !tool.codebase) return { name: 'WebSearch', arguments: { query: raw.query.slice(0, 500) } };
  // The CLI's own housekeeping for commands it left running: it lists them, or asks how one is doing.
  if (tool.cliName === 'manage_task' || /^Run manage_task$/.test(tool.title ?? '')) return { name: 'manage_task', arguments: { ...(text(raw.Action) ? { action: raw.Action.slice(0, 40) } : {}) } };
  if (tool.kind === 'fetch' && text(raw.Url ?? raw.url)) return { name: 'WebFetch', arguments: { url: String(raw.Url ?? raw.url).slice(0, 2000) } };
  return null;
}
// What a tool returned, where the CLI gives it as data (Cursor's rawOutput) rather than as content.
function outputOf(raw) {
  if (!object(raw)) return [];
  const shown = value => typeof value === 'string' ? value : '';
  if ('stdout' in raw || 'stderr' in raw) {
    const printed = [shown(raw.stdout), shown(raw.stderr)].filter(Boolean).join(shown(raw.stdout).endsWith('\n') || !raw.stdout ? '' : '\n');
    return [{ type: 'text', text: commandOutput(printed || (Number.isInteger(raw.exitCode) && raw.exitCode ? `Exit code ${raw.exitCode}` : '(no output)')) }];
  }
  if (typeof raw.content === 'string') return [{ type: 'text', text: commandOutput(raw.content) }];
  if (text(raw.error)) return [{ type: 'text', text: raw.error.slice(0, 2000) }];
  const counts = [['totalMatches', 'match', 'matches'], ['totalFiles', 'file', 'files'], ['resultCount', 'result', 'results'], ['totalDiagnostics', 'problem', 'problems']]
    .flatMap(([key, one, many]) => Number.isFinite(raw[key]) ? [`${raw[key]} ${raw[key] === 1 ? one : many}${raw.truncated ? ' (more were left out)' : ''}`] : []);
  return counts.length ? [{ type: 'text', text: counts.join(', ') }] : [];
}
// What the CLI reports for a finished turn: tokens read, read from cache (counted apart: its total is the sum of
// input, cached and output), written, and of those written, thought.
function turnUsage(usage) {
  const n = value => Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  const input = n(usage?.inputTokens), output = n(usage?.outputTokens);
  if (input == null || output == null) return null;
  const cacheRead = n(usage.cachedReadTokens) ?? 0, cacheWrite = n(usage.cachedWriteTokens) ?? 0, reasoning = n(usage.thoughtTokens);
  return { input, output, cacheRead, cacheWrite, ...(reasoning == null ? {} : { reasoning }), totalTokens: n(usage.totalTokens) ?? input + cacheRead + output };
}
const STOP = new Map([['end_turn', 'stop'], ['max_tokens', 'length'], ['max_turn_requests', 'length'], ['refusal', 'stop'], ['cancelled', 'aborted']]);
const PERMISSIONS = new Map([['allow_once', 'Allow once'], ['allow_always', 'Allow and remember'], ['reject_once', 'Reject once'], ['reject_always', 'Reject and remember']]);
const cancelled = { outcome: { outcome: 'cancelled' } };
const TIMED_OUT = Symbol('timed out');
const NEW_SESSION_ATTEMPTS = 3; // unconfirmed session/new requests before a conversation stops trying
// What a command printed, without the lines the CLI puts around it ("Created At: …", "Completed At: …",
// "Command exited with code 0.", "Command output:"). A command that failed keeps the line that says so.
const commandOutput = printed => {
  const wrapped = /^Created At: [^\n]*\n(?:Completed At: [^\n]*\n)?(?:Command exited with code (\d+)\.\n)?\s*Command output:\n?([\s\S]*)$/.exec(printed);
  if (!wrapped) return printed;
  return wrapped[1] && wrapped[1] !== '0' ? `${wrapped[2]}${wrapped[2] && !wrapped[2].endsWith('\n') ? '\n' : ''}Exited with code ${wrapped[1]}.` : wrapped[2];
};
const shownContent = content => (Array.isArray(content) ? content : []).flatMap(block =>
  block?.type === 'content' && block.content?.type === 'text' && typeof block.content.text === 'string' ? [{ type: 'text', text: commandOutput(block.content.text) }] : []);
const shownPaths = locations => (Array.isArray(locations) ? locations : []).flatMap(location => text(location?.path) ? [location.path] : []);
const image = block => block?.type === 'image' && /^image\/(?:png|jpeg|gif|webp)$/.test(block.mimeType) && text(block.data);
const slashCommands = (list, engine = 'antigravity') => (Array.isArray(list) ? list : []).slice(0, 256).flatMap(c =>
  /^[\w:.-]{1,120}$/.test(c?.name ?? '') ? [{ name: c.name, description: typeof c.description === 'string' ? c.description.slice(0, 400) : '', source: engine,
    ...(text(c.input?.hint) ? { argumentHint: c.input.hint.slice(0, 200) } : {}) }] : []);
const contextOf = ({ used, size }) => Number.isSafeInteger(used) && used >= 0 && Number.isSafeInteger(size) && size > 0
  ? { tokens: used, contextWindow: size, percent: 100 * used / size } : null;
// Roughly how many tokens a piece of text is (a character of Chinese, Japanese or Korean is about one; four of
// anything else are about one). Used only to share a turn's token count among its model requests.
const sizeOf = printed => { const cjk = (printed.match(/[\u3000-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g) ?? []).length; return cjk + (printed.length - cjk) / 4; };
// The CLI counts tokens for a turn as a whole, and says when each model request of the turn ends (usage_update).
// So each request has its own time, and of the turn's output tokens the share its text, thoughts and tool calls
// are of the turn's: an estimate, marked as one, unless the turn was a single request.
function requestsOf(requests, usage) {
  if (!usage || !requests.length) return null;
  const thought = Math.min(usage.reasoning ?? 0, usage.output), written = usage.output - thought;
  const said = requests.reduce((n, r) => n + r.text + r.tools, 0), mused = requests.reduce((n, r) => n + r.thinking, 0);
  const share = (part, whole) => whole > 0 ? part / whole : 1 / requests.length;
  return requests.map(r => ({ ms: r.ms, ...waitOf(r), output: Math.round(written * share(r.text + r.tools, said) + thought * (mused > 0 ? r.thinking / mused : share(r.text + r.tools, said))),
    ...(requests.length > 1 ? { estimated: true } : {}) }));
}
// How long a request waited for its first output (wait), and the share of its output that came with it (lead:
// a thought arrives whole, written before anyone saw it). Speed is measured over the rest.
const waitOf = r => Number.isFinite(r.wait) ? { wait: r.wait, lead: r.text + r.thinking + r.tools > 0 ? Math.min(1, r.firstSize / (r.text + r.thinking + r.tools)) : 0 } : {};
// The requests that have ended in a turn still under way, before the CLI has counted the turn's tokens: their
// output is what was written, measured (an estimate).
const openRequests = requests => requests.flatMap(r => r.text + r.thinking + r.tools >= 1 ? [{ ms: r.ms, ...waitOf(r), output: Math.round(r.text + r.thinking + r.tools), estimated: true }] : []);
const estimateOutput = blocks => Math.max(0, Math.round(blocks.reduce((n, block) => {
  const printed = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : '';
  const cjk = (printed.match(/[\u3000-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g) ?? []).length;
  return n + cjk + (printed.length - cjk) / 4;
}, 0)));

export class AntigravityAdapter {
  constructor({ boot, write, env = process.env, engine = 'antigravity' }) {
    this.p = profileOf(engine);
    const { bin, cwd, sessionsDir, sessionFile, recordId, remote, clientVersion, bypassPermissions, standby, home } = boot?.[this.p.engine] ?? {};
    // home: Iris`s own ${this.p.label} data directory, so its conversations stay out of the user`s own
    // Antigravity. On a Mac the Google sign-in is in the keychain and shared with it; on a machine without
    // one it is kept in this directory, which is why Iris signs in with the same directory (account()).
    this.config = { bin, cwd, sessionsDir, sessionFile, recordId, remote: remote === true, clientVersion, bypassPermissions: bypassPermissions === true,
      appDataDir: this.p.engine === 'antigravity' ? dataDirName(home) : undefined, home: this.p.engine !== 'antigravity' && text(home) && isAbsolute(home) ? home : undefined, profile: this.p };
    this.standby = standby === true && sessionFile == null;
    this.write = write;
    this.env = env;
    this.controls = Promise.resolve();
    this.permissions = new Map();
    this.cancelEpoch = 0;
    this.authRequired = false;
    this.canSignIn = false;
    this.options = [];
    this.commands = [];
    this.contextUsage = null;
    this.configSeq = 0;
    this.closed = false;
  }

  async handle(r) {
    if (this.closed || typeof r?.type !== 'string') return;
    if (r.type === 'extension_ui_response') { this.#answer(r); return; }
    if (!rpcId(r.id)) return;
    try { this.write({ type: 'response', id: r.id, command: r.type, success: true, data: await this.#command(r) }); }
    catch (error) { this.write({ type: 'response', id: r.id, command: r.type, success: false, error: error.message }); }
  }

  #serial(fn) {
    const run = this.controls.then(() => {
      if (this.closed) throw new Error(`The ${this.p.label} adapter stopped.`);
      return fn();
    });
    this.controls = run.catch(() => {});
    return run;
  }

  #command(r) {
    switch (r.type) {
      case 'get_state': {
        const ready = () => {
          this.write({ type: 'cli_permissions', ids: [...this.permissions.keys()] });
          return this.#state();
        };
        if (this.peer && !this.peer.closed && (this.sessionId || this.authRequired)) return ready();
        return this.#serial(async () => {
          if (this.standby) { await this.#initialize(); this.#warm(); }
          else await this.#ensureReady();
          return ready();
        });
      }
      case 'cli_activate': return this.#serial(() => this.#activate(r.cwd));
      case 'cli_login': {
        if (!this.login) this.login = this.#serial(() => this.#signIn()).finally(() => { this.login = null; });
        return this.login;
      }
      case 'cli_set_config': return this.#serial(() => this.#setConfig(r.configId, r.value));
      case 'prompt': {
        const images = r.images ?? [];
        if (!Array.isArray(images) || !images.every(image)) throw new Error(`Choose a PNG, JPEG, GIF, or WebP image for ${this.p.label}.`);
        if (!(text(r.message) && r.message.trim()) && !images.length) throw new Error(`Enter a message for ${this.p.label}.`);
        const epoch = this.cancelEpoch;
        this.#askClosed();
        return this.#serial(() => this.#prompt(r.message ?? '', images, epoch));
      }
      case 'abort': return this.#abort();
      case 'abort_bash': case 'clear_queue': case 'set_session_name': return {};
      case 'get_messages': return { messages: this.#transcript(false)?.messages() ?? [] };
      case 'get_entries': {
        const tr = this.#transcript(false);
        return { entries: tr?.publicEntries() ?? [], leafId: tr?.leafId ?? null };
      }
      case 'get_session_stats': return this.contextUsage ? { contextUsage: this.contextUsage } : null;
      case 'get_commands': return { commands: this.commands };
      default: throw new Error(`This command is not supported by the ${this.p.label} adapter.`);
    }
  }

  #transcript(create = true) {
    if (!this.transcript && (create || this.config.sessionFile != null)) {
      const { cwd, sessionsDir, sessionFile, recordId } = this.config;
      if (recordId != null && (typeof recordId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(recordId))) {
        throw new Error(`Invalid ${this.p.label} conversation ID.`);
      }
      if (![cwd, sessionsDir, ...(sessionFile == null ? [] : [sessionFile])].every(v => text(v) && isAbsolute(v))) {
        throw new Error(`${this.p.label} requires absolute local working directory and transcript paths.`);
      }
      this.transcript = new Transcript(this.config);
    }
    return this.transcript;
  }

  #cliState() {
    return { authRequired: this.authRequired, canSignIn: this.canSignIn, options: this.options,
      image: this.capabilities?.promptCapabilities?.image === true,
      permissionMode: this.config.bypassPermissions ? 'bypassPermissions' : 'confirm', commands: this.commands, contextUsage: this.contextUsage,
      ...(this.turn?.requests.length ? { turnRequests: openRequests(this.turn.requests) } : {}),
      ...(this.standby ? { standby: true } : {}) };
  }
  #model() {
    const id = this.options.find(o => o.category === 'model')?.currentValue;
    return id ? { provider: this.p.engine, id } : null;
  }
  #state() {
    const model = this.#model();
    return { engine: this.p.engine, sessionId: this.transcript?.header.id ?? null, sessionFile: this.transcript?.file ?? null,
      isStreaming: !!this.turn, isCompacting: false, pendingMessageCount: 0, cli: this.#cliState(), ...(model ? { model } : {}) };
  }
  #updateState() { this.write({ type: 'cli_state', cli: this.#cliState() }); }
  #authNeeded() {
    this.sessionId = null;
    this.authRequired = true;
    this.options = [];
    this.commands = [];
    this.contextUsage = null;
    this.#updateState();
  }
  #replaceOptions(options, seq) {
    if (!Array.isArray(options) || seq < this.configSeq) return;
    this.configSeq = seq;
    this.rawOptions = options;
    this.options = this.#withSettings(selectConfig(options));
    this.#updateState();
  }
  // Each model with the settings it has of its own (Cursor's effort, context, speed), so that picking another
  // model shows its menus at once (`sub`, as Codex's models carry theirs).
  #withSettings(options) {
    if (!this.modelSettings) return options;
    return options.map(o => o.category !== 'model' ? o : { ...o, options: o.options.map(choice => this.modelSettings.has(choice.value) ? { ...choice, sub: this.modelSettings.get(choice.value) } : choice) });
  }
  async #loadModelSettings(peer) {
    if (!this.p.listModels || this.modelSettings || this.loadingSettings) return;
    this.loadingSettings = true;
    try {
      const { result } = await peer.request(this.p.listModels, {}, MENUS_MS);
      if (peer !== this.peer || !Array.isArray(result?.models)) return;
      this.modelSettings = new Map(result.models.filter(m => text(m?.value)).slice(0, 200).map(m => [m.value, selectConfig(m.configOptions)]));
      if (this.rawOptions) { this.options = this.#withSettings(selectConfig(this.rawOptions)); this.#updateState(); }
    } catch { /* the model menu works without them */ }
    finally { this.loadingSettings = false; }
  }
  // Before a message goes: this conversation's own model and settings. The CLI starts with the choice made last
  // in its directory (perhaps in another conversation); once running, a process keeps its own (another
  // process changing the directory's choice does not change it), so only what differs from what this process
  // says it has is set: each change costs the CLI a second. The model first, since it decides which settings
  // exist. A conversation that never chose keeps the model it started with.
  async #applyChoices() {
    if (!this.p.globalModel || !this.sessionId) return;
    if (!object(this.transcript.choices)) {
      const started = Object.fromEntries(this.options.filter(o => o.category !== 'model' || o.options.some(choice => choice.value === o.currentValue)).map(o => [o.id, o.currentValue]));
      if (Object.keys(started).length) this.transcript.choose(started);
      return;
    }
    const want = this.transcript.choices;
    const model = this.options.find(o => o.category === 'model');
    for (const id of Object.keys(want).sort((a, b) => (b === model?.id) - (a === model?.id))) {
      const option = this.options.find(o => o.id === id);
      if (!option || option.currentValue === want[id] || !option.options.some(choice => choice.value === want[id])) continue;
      const peer = this.peer;
      const { result, seq } = await peer.request('session/set_config_option', { sessionId: this.sessionId, configId: id, value: want[id] });
      if (peer.closed) throw new Error(`The ${this.p.label} CLI connection closed.`);
      this.#replaceOptions(result?.configOptions, seq);
    }
  }

  async #initialize() {
    if (this.peer && !this.peer.closed) return this.capabilities;
    if (this.peer && !await this.peer.stopped) throw new Error(`The previous ${this.p.label} CLI process did not stop.`);
    if (this.closed) throw new Error(`The ${this.p.label} adapter stopped.`);
    if (!text(this.config.bin) || !isAbsolute(this.config.bin)) throw new Error(`An explicit path to the official ${this.p.label} CLI is required.`);
    const peer = new AcpPeer(this.config, this.env, (p, r, seq) => this.#onRecord(p, r, seq), p => this.#disconnected(p));
    this.peer = peer;
    this.capabilities = {};
    this.configSeq = 0;
    let init;
    try {
      ({ result: init } = await peer.request('initialize', initParams(this.config.clientVersion, this.p)));
    } catch (error) {
      if (!error.authRequired) peer.close(error);
      throw error;
    }
    if (init?.protocolVersion !== 1 || peer.closed) {
      const error = new Error(`The ${this.p.label} CLI did not negotiate ACP version 1.`);
      peer.close(error); throw error;
    }
    this.capabilities = init.agentCapabilities ?? {};
    this.canSignIn = !this.config.remote && personalAuth(init, this.p);
    // Cursor: the sign-in made with its own command is taken up before anything else can be asked.
    if (this.p.authenticate) {
      try { await peer.request('authenticate', { methodId: this.p.authMethod }); }
      catch (error) { if (!error.authRequired) peer.close(error); throw error; }
    }
    return this.capabilities;
  }

  // A CLI waiting for the first message gets its slow start out of the way. The CLI signs in, and asks Google
  // for the account and its models, only when it is first asked something: left for session/new, that is
  // about two seconds between sending the first message and the model seeing it (more through a proxy).
  // session/list sets it off and changes nothing; what it returns is not used.
  #warm() {
    const peer = this.peer;
    // (Cursor has done what warms it, taking up its sign-in, in #initialize.)
    if (this.p.authenticate || !peer || peer.closed || this.warmed === peer || !object(this.capabilities?.sessionCapabilities?.list)) return;
    this.warmed = peer;
    peer.request('session/list', {}, MENUS_MS).catch(() => {}); // not signed in, or no answer: the first message finds out
  }

  async #activate(cwd) {
    if (!text(cwd) || !isAbsolute(cwd) || (!this.standby && cwd !== this.config.cwd)) throw new Error(`Invalid ${this.p.label} workspace.`);
    // ACP's session/new takes the session's own working directory. A No-folder
    // spare can run in the shared root until the first message names its folder.
    this.config.cwd = cwd;
    this.standby = false;
    await this.#ensureReady();
    return this.#state();
  }

  async #ensureReady() {
    if (this.standby) throw new Error(`Open the ${this.p.label} conversation first.`);
    const tr = this.#transcript();
    if (this.peer && !this.peer.closed && (this.sessionId || this.authRequired)) return;
    // An earlier session/new never reported its ID (the CLI timed out, crashed or was stopped mid-start).
    // A prompt is only ever sent to a session with a known ID, so whatever the CLI may have created is
    // empty: trying again loses nothing, while refusing at once left the conversation unusable for good.
    // Bounded, so a CLI that keeps creating sessions without answering cannot fill the account with them.
    if (tr.binding?.creating && (tr.binding.attempts ?? 1) >= NEW_SESSION_ATTEMPTS) {
      throw new Error(`${this.p.label} did not confirm a new session after several attempts. No further session was started; start a new conversation to continue.`);
    }
    try { await this.#initialize(); }
    catch (error) { if (error.authRequired) { this.#authNeeded(); return; } throw error; }
    await this.#open();
  }

  async #open() {
    const tr = this.transcript, saved = tr.binding?.sessionId;
    const peer = this.peer;
    if (this.closed || peer.closed) throw new Error(`The ${this.p.label} CLI connection closed.`);
    const method = !saved ? 'session/new' : object(this.capabilities.sessionCapabilities?.resume) ? 'session/resume' :
      this.capabilities.loadSession === true ? 'session/load' : null;
    if (!method) throw new Error(`The ${this.p.label} CLI cannot resume this session. No replacement was started.`);
    const opening = { saved, latest: null, metadata: new Map() };
    this.opening = opening;
    try {
      this.write({ type: 'cli_opening' });
      if (!saved) tr.bind({ creating: true, attempts: (tr.binding?.creating ? tr.binding.attempts ?? 1 : 0) + 1 });
      // Iris's visual tool, as an MCP server of the session's own (ACP gives the environment as a list).
      const { env: visualEnv, ...visual } = visualServer();
      const mcpServers = [{ ...visual, env: Object.entries(visualEnv).map(([name, value]) => ({ name, value })) }];
      const { result, seq } = await peer.request(method, { cwd: this.config.cwd, mcpServers, ...(saved ? { sessionId: saved } : {}) }, OPEN_MS);
      const sessionId = saved ?? result?.sessionId;
      if (!text(sessionId) || (saved && result?.sessionId != null && result.sessionId !== saved)) throw new Error(`${this.p.label} did not return the expected session ID.`);
      // Record a successful new session even if the pipe closes immediately after the reply.
      if (!saved) tr.bind({ sessionId });
      if (this.closed || peer.closed) throw new Error(`The ${this.p.label} CLI connection closed.`);
      this.sessionId = sessionId;
      this.authRequired = false;
      this.options = [];
      const metadata = opening.metadata.get(sessionId);
      this.commands = metadata?.commands ?? [];
      this.contextUsage = metadata?.contextUsage ?? null;
      const early = opening.latest?.id === sessionId ? opening.latest : null;
      if (early && (early.seq > seq || !Array.isArray(result?.configOptions))) this.#replaceOptions(early.options, early.seq);
      else if (Array.isArray(result?.configOptions)) this.#replaceOptions(result.configOptions, seq);
      else this.#updateState();
      void this.#loadModelSettings(peer);
    } catch (error) {
      // The CLI answered that it created nothing (an ACP error, sign-in needed): the next attempt starts clean.
      // A timeout or a closed pipe stays recorded as an unconfirmed attempt (see #ensureReady).
      if (!saved && (error.authRequired || error instanceof AcpError)) tr.bind({ creating: false });
      if (error.authRequired) {
        this.#authNeeded();
        return;
      }
      if (saved && error instanceof AcpError && error.code === -32002) throw new Error(`The original ${this.p.label} session was not found. No replacement was started.`);
      throw error;
    } finally { this.opening = null; }
  }

  async #signIn() {
    await this.#ensureReady();
    if (this.sessionId) return this.#state();
    if (!this.authRequired || !this.canSignIn) throw new Error(this.config.remote
      ? `Sign in to ${this.p.label} on this host in Settings → Subscriptions, then reconnect.` : `Sign in using the official ${this.p.label} CLI, then reconnect.`);
    try { await this.peer.request('authenticate', { methodId: this.p.authMethod }, LOGIN_MS); }
    catch (error) { if (error.authRequired) { this.#authNeeded(); return this.#state(); } throw error; }
    await this.#open();
    return this.#state();
  }

  async #setConfig(configId, value) {
    if (this.turn) throw new Error(`Wait for the current ${this.p.label} turn to finish.`);
    await this.#ensureReady();
    if (!this.sessionId) throw new Error(`Sign in to ${this.p.label} before changing session settings.`);
    if (!this.options.find(o => o.id === configId)?.options.some(choice => choice.value === value)) throw new Error(`That ${this.p.label} setting is not an advertised option.`);
    const peer = this.peer;
    try {
      const { result, seq } = await peer.request('session/set_config_option', { sessionId: this.sessionId, configId, value });
      if (peer.closed) throw new Error(`The ${this.p.label} CLI connection closed.`);
      const model = this.options.find(o => o.id === configId)?.category === 'model';
      this.#replaceOptions(result?.configOptions, seq);
      // Another model has settings of its own: what was chosen for the one before does not carry over.
      if (this.p.globalModel) this.transcript.choose({ ...(model ? {} : this.transcript.choices), [configId]: value });
    } catch (error) { if (error.authRequired) this.#authNeeded(); else throw error; }
    return this.#state();
  }

  async #prompt(message, images, epoch) {
    if (this.turn) throw new Error(`${this.p.label} is already responding; stop this turn before sending another prompt.`);
    if (this.cancelEpoch !== epoch) throw new Error(`The ${this.p.label} prompt was cancelled before it started.`);
    await this.#ensureReady();
    if (this.closed || this.cancelEpoch !== epoch) throw new Error(`The ${this.p.label} prompt was cancelled before it started.`);
    if (!this.sessionId) throw new Error(`Sign in to ${this.p.label} before sending a prompt.`);
    try { await this.#applyChoices(); }
    catch (error) { if (error.authRequired) { this.#authNeeded(); throw new Error(`Sign in to ${this.p.label} before sending a prompt.`); } throw error; }
    if (this.closed || this.cancelEpoch !== epoch) throw new Error(`The ${this.p.label} prompt was cancelled before it started.`);
    if (images.length && this.capabilities?.promptCapabilities?.image !== true) throw new Error(`This ${this.p.label} CLI does not accept image prompts.`);
    const prompt = [...(message ? [{ type: 'text', text: message }] : []), ...images.map(({ mimeType, data }) => ({ type: 'image', mimeType, data }))];
    // The ACP line reader and the relay both have finite record sizes.
    if (Buffer.byteLength(JSON.stringify(prompt)) > 6 * 1024 * 1024) throw new Error(`${this.p.label} prompts must be smaller than 6 MB after encoding.`);
    const user = { role: 'user', content: prompt, timestamp: Date.now() };
    this.transcript.append([{ type: 'message', message: user }]);
    const turn = { sessionId: this.sessionId, startedAt: Math.max(Date.now(), user.timestamp + 1), tools: new Map(), content: [], model: this.#model()?.id,
      // The model requests of the turn (see requestsOf): those that ended, and what the one being answered has written.
      requests: [], open: { text: 0, thinking: 0, tools: 0 }, from: Date.now() };
    // (open.first: when the request under way first wrote something; open.firstSize: how much that was.)
    this.turn = turn;
    this.write({ type: 'agent_start' });
    this.#message(user);
    this.write({ type: 'message_start', message: this.#assistant(turn, []) });
    turn.requestedAt = performance.now(); turn.from = Date.now();
    turn.done = this.peer.request('session/prompt', { sessionId: turn.sessionId, prompt: user.content }, null).then(
      ({ result }) => {
        const reason = STOP.get(result?.stopReason);
        turn.usage = turnUsage(result?.usage);
        this.#finishTurn(turn, reason ?? 'error', reason ? null : `${this.p.label} returned an unrecognized stop reason.`);
        return !!reason;
      }, error => {
        const aborted = turn.cancelled || error.code === -32800;
        this.#finishTurn(turn, aborted ? 'aborted' : 'error', aborted ? null : error.authRequired ? `Sign in to ${this.p.label} to continue.` : error.message);
        if (!this.closed && error.authRequired) this.#authNeeded();
        return error instanceof AcpError;
      });
    return { disposition: 'started' };
  }

  #assistant(turn, content) {
    return { role: 'assistant', content, provider: this.p.engine, api: `${this.p.engine}-acp`, ...(turn.model ? { model: turn.model } : {}),
      ...(turn.responseModel ? { responseModel: turn.responseModel } : {}), timestamp: turn.startedAt };
  }
  #message(message) { this.write({ type: 'message_start', message }); this.write({ type: 'message_end', message }); }
  #delta(fields) { this.write({ type: 'message_update', assistantMessageEvent: fields }); }
  #endBlock(turn) {
    if (turn.blockIndex == null) return;
    const index = turn.blockIndex, block = turn.content[index];
    this.#delta({ type: `${block.type}_end`, contentIndex: index, content: block[block.type] });
    turn.blockIndex = null;
  }
  #chunk(turn, type, content) {
    if (content?.type !== 'text' || !text(content.text)) return;
    // Cursor's Auto says which model answers, as the reply's first line: it is the reply's model, not its text.
    const routed = type === 'text' && !turn.content.some(block => block.type === 'text') ? /^> Auto routed to ([^\n]{1,80})\n*$/.exec(content.text) : null;
    if (routed) { turn.responseModel = routed[1].trim(); return; }
    if (turn.open.first == null) { turn.open.first = Date.now(); turn.open.firstSize = sizeOf(content.text); }
    turn.open[type] += sizeOf(content.text);
    if (turn.blockIndex == null || turn.content[turn.blockIndex].type !== type) {
      this.#endBlock(turn);
      turn.blockIndex = turn.content.push({ type, [type]: '' }) - 1;
      this.#delta({ type: `${type}_start`, contentIndex: turn.blockIndex });
    }
    turn.content[turn.blockIndex][type] += content.text;
    this.#delta({ type: `${type}_delta`, contentIndex: turn.blockIndex, delta: content.text });
  }

  #tool(turn, update) {
    if (!text(update.toolCallId)) return;
    // The question of the turn before, which the CLI closes now that it has its answer: already shown.
    if (update.toolCallId === this.askedId) return;
    let tool = turn.tools.get(update.toolCallId);
    // Antigravity keeps its task list with a tool it calls again for every change. All of a turn's calls are
    // one Tasks card, kept current, as the list is one thing.
    const steps = stepsOf(update);
    if (!tool && steps && turn.plan) { tool = turn.plan; turn.tools.set(update.toolCallId, tool); }
    if (!tool) {
      this.#endBlock(turn);
      // A CLI that says nothing between its model requests (Cursor): the request that wrote this call ends here.
      if (this.p.requestsByTools && turn.open.text + turn.open.thinking > 0) this.#requestEnded(turn);
      tool = { id: randomUUID(), index: turn.content.length, start: Date.now(), paths: [], result: [], codebase: this.p.engine === 'cursor' };
      turn.tools.set(update.toolCallId, tool);
      // The CLI names a request's tool calls right after it says the request ended: they are that request's.
      try { (turn.requests.at(-1) ?? turn.open).tools += sizeOf(JSON.stringify(update.rawInput ?? {}).slice(0, 400000)); } catch { /* an input that cannot be measured weighs nothing */ }
      if (steps) turn.plan = tool;
    }
    if (text(update.kind)) tool.kind = update.kind;
    if (text(update.name)) tool.cliName = update.name;
    if (text(update.title)) tool.title = update.title;
    if (update.rawInput && typeof update.rawInput === 'object') tool.raw = update.rawInput;
    if (Array.isArray(update.locations)) tool.paths = shownPaths(update.locations);
    if (Array.isArray(update.content)) { tool.result = shownContent(update.content); tool.diff = shownDiff(update.content) ?? tool.diff; }
    if (object(update.rawOutput) && !tool.result.length) tool.result = outputOf(update.rawOutput);
    // Its task list and the agents it starts are shown as Claude Code's are: a Tasks card, and a task with its brief.
    const asks = asksOf(tool);
    if (asks) tool.asks = asks;
    const known = tool === turn.plan ? { name: 'TodoWrite', arguments: { todos: stepsOf({ title: tool.title, rawInput: tool.raw }) ?? [] } }
      : asks ? { name: 'AskUserQuestion', arguments: { questions: asks.map(ask => ({ question: ask.question, options: ask.options.map(label => ({ label })), ...(ask.multi ? { multiSelect: true } : {}) })) } }
      : agentOf(tool) ?? toolOf(tool);
    const call = known ? { type: 'toolCall', id: tool.id, ...known } : { type: 'toolCall', id: tool.id, name: tool.title ?? tool.kind ?? `${this.p.label} tool`,
      arguments: tool.paths.length ? { path: tool.paths[0], ...(tool.paths.length > 1 ? { paths: tool.paths } : {}) } : {} };
    if (known?.name === 'TodoWrite') tool.fallback = 'Tasks updated.';
    else if (known?.name === 'Task') tool.fallback = `The agent was started; it reports back to ${this.p.label}.`;
    turn.content[tool.index] = call;
    if (!tool.call) this.#delta({ type: 'toolcall_start', contentIndex: tool.index, id: call.id, toolName: call.name });
    this.#delta({ type: 'toolcall_end', contentIndex: tool.index, toolCall: call });
    if (!tool.call) this.write({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments });
    tool.call = call;
    if (update.status === 'completed' || update.status === 'failed') {
      if (tool.message) return; // the Tasks card of an earlier call, updated above
      tool.finished = true;
      this.#toolEnd(tool, update.status === 'failed', update.status === 'failed' ? 'Tool failed.' : tool.fallback ?? 'Tool completed.');
    } else if (!tool.finished && !turn.cancelled && tool.result.length) {
      this.write({ type: 'tool_execution_update', toolCallId: call.id, toolName: call.name, args: call.arguments,
        partialResult: { content: tool.result, details: { engine: this.p.engine } } });
    } else if (turn.cancelled && !tool.finished && !tool.interrupted) {
      tool.interrupted = true;
      this.#toolEnd(tool, true, 'Interrupted.');
    }
  }
  // An image Cursor's model made (its generateImage tool): it names the file once it is written. The image is
  // the tool's result, and part of the reply, where it is seen without opening the step.
  #generatedImage(turn, params) {
    const path = text(params?.filePath) && isAbsolute(params.filePath) ? params.filePath : null;
    const mimeType = path && { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[path.split('.').pop().toLowerCase()];
    if (!mimeType) return;
    let data;
    try { const file = readFileSync(path); if (file.length > 6 * 1024 * 1024) return; data = file.toString('base64'); } catch { return; }
    const tool = turn.tools.get(params.toolCallId);
    if (tool) {
      tool.result = [{ type: 'text', text: path }, { type: 'image', mimeType, data }];
      if (tool.message) { tool.message.content = tool.result; this.write({ type: 'tool_execution_end', toolCallId: tool.id, toolName: tool.call.name, result: { content: tool.result, details: tool.message.details }, isError: false, durationMs: tool.end - tool.start }); }
    }
    this.#endBlock(turn);
    turn.content.push({ type: 'image', mimeType, data });
  }
  #toolEnd(tool, isError, fallback) {
    const content = tool.result.length ? tool.result : [{ type: 'text', text: fallback }];
    // Stopped by the person (Stop, or a message sent while it worked) is not the tool failing.
    const details = { engine: this.p.engine, ...(fallback === 'Interrupted.' ? { interrupted: true } : {}) };
    tool.end = Date.now();
    if (this.turn) this.turn.from = tool.end; // the next model request begins once the tools before it are done
    const durationMs = tool.end - tool.start;
    tool.message = { role: 'toolResult', toolCallId: tool.id, toolName: tool.call.name, content, details, isError, timestamp: Date.now() };
    this.write({ type: 'tool_execution_end', toolCallId: tool.id, toolName: tool.call.name, result: { content, details }, isError, durationMs });
  }

  #requestEnded(turn) {
    const now = Date.now();
    const { first, ...written } = turn.open;
    turn.requests.push({ ms: Math.max(1, now - turn.from), ...(first != null && first >= turn.from ? { wait: first - turn.from } : {}), ...written });
    turn.open = { text: 0, thinking: 0, tools: 0 }; turn.from = now;
    if (this.turn === turn) this.#updateState(); // its speed is shown while the turn goes on
  }

  #finishTurn(turn, stopReason, errorMessage) {
    if (this.turn !== turn) return;
    this.#askRpcEnd({ outcome: 'cancelled' }); // a question still open when the turn ends (Cursor) is not answered
    if (turn.open.text + turn.open.thinking + turn.open.tools > 0) this.#requestEnded(turn); // a last request the CLI did not close
    this.#cancelPermissions();
    this.#endBlock(turn);
    // A question left open is the turn asking for an answer, not a tool that failed.
    const asked = stopReason === 'stop' ? [...turn.tools.entries()].find(([, tool]) => tool.asks && !tool.message) : null;
    if (asked) this.#toolEnd(asked[1], false, 'Asked.');
    for (const tool of turn.tools.values()) if (!tool.message) this.#toolEnd(tool, true, stopReason === 'aborted' ? 'Interrupted.' : `${this.p.label} did not report tool completion.`);
    // ACP does not expose individual model request timestamps or token counts.
    // Keep elapsed turn time separate from the provider metering used by Pi.
    // The CLI also writes its question out as text ("Which colour? [1] red [2] green"). The card asks it, with
    // the choices as buttons; the same thing as a paragraph above the card is left out of the conversation.
    if (asked) turn.content = turn.content.filter(block => !(block?.type === 'text' && asked[1].asks.every(ask => block.text.includes(ask.question) && ask.options.every(option => block.text.includes(option)))
      && block.text.length < 400 + asked[1].asks.reduce((n, ask) => n + ask.question.length + ask.options.join('').length + ask.options.length * 12, 0)));
    const __agyTurn = { durationMs: Math.max(1, Math.round(performance.now() - turn.requestedAt)), tokenEstimate: estimateOutput(turn.content) };
    // The CLI's own token counts for the turn, when it gives them (with the turn's length, they give its speed).
    // The model's own time: the turn's length less the time its tools ran. The turn's speed is measured over it.
    const ended = Date.now();
    const modelMs = Math.max(1, __agyTurn.durationMs - toolTime([...new Set(turn.tools.values())].map(tool => [tool.start, tool.end ?? ended])));
    let message = { ...this.#assistant(turn, turn.content), __agyTurn, ...(turn.usage ? { usage: turn.usage, durationMs: __agyTurn.durationMs, modelMs, ...(requestsOf(turn.requests, turn.usage) ? { requests: requestsOf(turn.requests, turn.usage) } : {}) }
        // A CLI that counts no tokens at all (Cursor): each request's speed, from what it wrote (an estimate).
        : this.p.requestsByTools && openRequests(turn.requests).length ? { durationMs: __agyTurn.durationMs, modelMs, requests: openRequests(turn.requests) } : {}), stopReason, ...(errorMessage ? { errorMessage } : {}) };
    const results = [...turn.tools.values()].map(t => t.message);
    try { this.transcript.append([message, ...results].map(message => ({ type: 'message', message }))); }
    catch { message = { ...message, stopReason: 'error', errorMessage: `Could not save this turn to the ${this.p.label} transcript.` }; }
    this.turn = null;
    this.write({ type: 'message_end', message });
    for (const result of results) this.#message(result);
    this.write({ type: 'agent_end' });
    this.write({ type: 'agent_settled' });
    if (turn.requests.length && !this.closed) this.#updateState(); // the turn's requests are in the saved reply now
    if (asked && !this.closed) { this.ask = { toolCallId: asked[0], questions: asked[1].asks, answers: [], open: null }; this.#askNext(); }
  }

  // Questions Cursor's model asks while it works (cursor/ask_question): the turn waits for the answers. They are
  // the same cards; each answer goes back as the ids of the options chosen.
  #askRpc(peer, id, params) {
    const questions = (Array.isArray(params?.questions) ? params.questions : []).filter(q => text(q?.id) && text(q.prompt)).slice(0, 8).map(q => {
      const choices = (Array.isArray(q.options) ? q.options : []).filter(o => text(o?.id) && text(o.label)).slice(0, 24);
      return { id: q.id, question: q.prompt.slice(0, 2000), choices, options: [...new Set(choices.map(o => o.label.slice(0, 300)))], multi: q.allowMultiple === true };
    });
    if (!this.turn || !questions.length || this.ask) { peer.send({ id, result: { outcome: { outcome: 'cancelled' } } }); return; }
    this.ask = { rpc: { peer, id }, questions, answers: [], picked: [] };
    this.#askNext();
  }
  #askRpcEnd(outcome) {
    const ask = this.ask;
    if (!ask?.rpc) return false;
    this.ask = null;
    if (ask.open) this.write({ type: 'extension_ui_dismiss', id: ask.open });
    ask.rpc.peer.send({ id: ask.rpc.id, result: { outcome } });
    return true;
  }
  // The question card for the next unanswered question (one at a time when the model asked several).
  #askNext() {
    const ask = this.ask;
    if (!ask) return;
    const at = ask.answers.length, question = ask.questions[at];
    ask.open = randomUUID();
    this.write({ type: 'extension_ui_request', id: ask.open, ask: true, method: question.options.length ? 'select' : 'input',
      header: ask.questions.length > 1 ? `Question ${at + 1} of ${ask.questions.length}` : 'Question', title: question.question,
      ...(question.options.length ? { options: question.options } : {}), ...(question.multi ? { multiSelect: true } : {}) });
  }
  // An answer chosen on the card. With every question answered, the answers go to the CLI as the next message,
  // which is how it takes them; dismissing the card sends nothing, and whatever is typed next is the answer.
  #askAnswered(r) {
    const ask = this.ask;
    this.write({ type: 'extension_ui_dismiss', id: r.id });
    ask.open = null;
    if (ask.rpc) {
      const labels = (Array.isArray(r.value) ? r.value : [r.value]).filter(text);
      const question = ask.questions[ask.answers.length];
      const ids = question.choices.filter(o => labels.includes(o.label.slice(0, 300))).map(o => o.id);
      if (r.cancelled || !ids.length) { this.#askRpcEnd({ outcome: 'skipped', reason: 'The person did not answer.' }); return; }
      ask.answers.push({ questionId: question.id, selectedOptionIds: ids });
      if (ask.answers.length < ask.questions.length) { this.#askNext(); return; }
      this.#askRpcEnd({ outcome: 'answered', answers: ask.answers });
      return;
    }
    const value = Array.isArray(r.value) ? r.value.filter(text).join(', ') : text(r.value) ? r.value : '';
    if (r.cancelled || !value.trim()) { this.ask = null; this.askedId = ask.toolCallId; return; }
    ask.answers.push(value);
    if (ask.answers.length < ask.questions.length) { this.#askNext(); return; }
    this.ask = null; this.askedId = ask.toolCallId;
    const message = ask.questions.length === 1 ? ask.answers[0] : ask.questions.map((question, i) => `${question.question}\n${ask.answers[i]}`).join('\n\n');
    const epoch = this.cancelEpoch;
    this.#serial(() => this.#prompt(message, [], epoch)).catch(error => this.write({ type: 'extension_ui_request', id: randomUUID(), method: 'notify', notifyType: 'error', message: error.message }));
  }
  // A message typed while a question is open is the answer: the card goes.
  #askClosed() {
    const ask = this.ask;
    if (!ask) return;
    if (this.#askRpcEnd({ outcome: 'skipped', reason: 'The person wrote a message instead.' })) return;
    this.ask = null; this.askedId = ask.toolCallId;
    if (ask.open) this.write({ type: 'extension_ui_dismiss', id: ask.open });
  }

  #cancelTurn(turn) {
    if (turn.cancelled) return;
    turn.cancelled = true;
    this.#askRpcEnd({ outcome: 'cancelled' });
    this.peer.send({ method: 'session/cancel', params: { sessionId: turn.sessionId } });
    this.#cancelPermissions();
    for (const tool of turn.tools.values()) if (!tool.finished && !tool.interrupted) {
      tool.interrupted = true;
      this.#toolEnd(tool, true, 'Interrupted.');
    }
  }
  async #abort() {
    ++this.cancelEpoch;
    const turn = this.turn;
    if (turn) {
      this.#cancelTurn(turn);
      // Never claim a successful Stop until the original prompt really settled.
      if (await within(turn.done, ABORT_MS, TIMED_OUT) === TIMED_OUT) throw new Error(`${this.p.label} did not confirm the cancellation.`);
    }
    return {};
  }

  #onRecord(peer, record, seq) {
    if (peer !== this.peer || this.closed) return;
    const { id, method, params } = record;
    if (has(record, 'id')) {
      if (!rpcId(id)) return;
      if (method === 'session/request_permission') this.#permission(peer, id, params);
      else if (method === 'cursor/ask_question') this.#askRpc(peer, id, params);
      // A plan to approve comes only in Cursor's plan mode, which Iris does not start: carry on.
      else if (method === 'cursor/create_plan') peer.send({ id, result: { outcome: { outcome: 'accepted' } } });
      // What Cursor calls its notifications come as requests it does not wait on: each is answered at once.
      else if (method === 'cursor/generate_image') {
        if (this.turn) this.#generatedImage(this.turn, params);
        peer.send({ id, result: text(params?.filePath) ? { outcome: { outcome: 'generated', filePath: params.filePath } } : { outcome: { outcome: 'cancelled' } } });
      } else if (method === 'cursor/update_todos') peer.send({ id, result: { outcome: { outcome: 'accepted', todos: Array.isArray(params?.todos) ? params.todos : [] } } });
      else if (method === 'cursor/task') peer.send({ id, result: { outcome: { outcome: 'completed', ...(text(params?.agentId) ? { agentId: params.agentId } : {}) } } });
      else peer.send({ id, error: { code: -32601, message: 'Method not supported by Iris' } });
    } else if (method === 'cursor/generate_image') {
      if (this.turn) this.#generatedImage(this.turn, params);
    } else if (method === 'session/update') {
      const update = params?.update;
      if (!text(params?.sessionId) || !object(update)) return;
      if (update.sessionUpdate === 'config_option_update') {
        if (!Array.isArray(update.configOptions)) return;
        if (this.opening && (!this.opening.saved || this.opening.saved === params.sessionId)) this.opening.latest = { id: params.sessionId, options: update.configOptions, seq };
        else if (params.sessionId === this.sessionId) this.#replaceOptions(update.configOptions, seq);
      }
      if (update.sessionUpdate === 'available_commands_update' || update.sessionUpdate === 'usage_update') {
        const patch = update.sessionUpdate === 'usage_update' ? { contextUsage: contextOf(update) }
          : { commands: slashCommands(update.availableCommands, this.p.engine) };
        if (this.opening && (!this.opening.saved || this.opening.saved === params.sessionId) &&
          (this.opening.metadata.has(params.sessionId) || this.opening.metadata.size < 8)) {
          this.opening.metadata.set(params.sessionId, { ...this.opening.metadata.get(params.sessionId), ...patch });
        } else if (params.sessionId === this.sessionId) {
          Object.assign(this, patch);
          this.#updateState();
        }
      }
      // session/load replays history as session/update. The local Pi file is authoritative
      // for the UI, so only an active prompt can append/emit messages and tools.
      const turn = this.turn;
      // The CLI says how full the context is each time a model request ends: that is where one request of the
      // turn stops. (It also says so when a turn starts, with the figure it gave last: nothing ended then.)
      if (update.sessionUpdate === 'usage_update' && Number.isSafeInteger(update.used) && update.used > 0) {
        if (turn && params.sessionId === turn.sessionId && update.used !== this.usedBefore) this.#requestEnded(turn);
        if (params.sessionId === this.sessionId || this.opening) this.usedBefore = update.used;
      }
      if (!turn || params.sessionId !== turn.sessionId) return;
      switch (update.sessionUpdate) {
        case 'agent_message_chunk': this.#chunk(turn, 'text', update.content); break;
        case 'agent_thought_chunk': this.#chunk(turn, 'thinking', update.content); break;
        case 'tool_call': case 'tool_call_update': this.#tool(turn, update); break;
        case 'session_info_update': if (this.p.titles && text(update.title)) this.write({ type: 'extension_ui_request', id: randomUUID(), method: 'setStatus', statusKey: 'iris-title', statusText: update.title.trim().slice(0, 120) }); break;
      }
    }
  }

  #permission(peer, id, params) {
    const turn = this.turn;
    const reject = () => peer.send({ id, result: cancelled });
    if (!turn || turn.cancelled || params?.sessionId !== turn.sessionId || !Array.isArray(params.options) || this.permissions.size >= 8) { reject(); return; }
    const call = params.toolCall;
    if (!text(call?.toolCallId) || !params.options.length || params.options.length > 32) { reject(); return; }
    const options = new Map(), details = [], ids = new Set();
    for (const option of params.options) {
      if (!text(option?.optionId) || !text(option.name) || ids.has(option.optionId) || !PERMISSIONS.has(option.kind)) { reject(); return; }
      let label = option.name;
      for (let suffix = 2; options.has(label); suffix++) label = `${option.name} (${suffix})`;
      options.set(label, option.optionId); ids.add(option.optionId);
      details.push({ label, description: PERMISSIONS.get(option.kind) });
    }
    const uiId = randomUUID();
    this.permissions.set(uiId, { peer, id, options });
    const tool = turn.tools.get(call.toolCallId);
    const kind = text(call.kind) ? call.kind : tool?.kind;
    const paths = Array.isArray(call.locations) ? shownPaths(call.locations) : tool?.paths ?? [];
    this.write({ type: 'extension_ui_request', id: uiId, method: 'select', header: `${this.p.label} tool permission`,
      title: (text(call.title) ? call.title : tool?.title) ?? `Approve this ${this.p.label} tool call?`,
      message: [kind, ...paths, ...shownContent(call.content).map(block => block.text)].filter(Boolean).join('\n'),
      options: [...options.keys()], optionDetails: details });
  }
  #answer(r) {
    if (this.ask?.open === r.id) { this.#askAnswered(r); return; }
    const entry = this.permissions.get(r.id);
    if (!entry) return;
    this.permissions.delete(r.id);
    const optionId = !r.cancelled && entry.options.get(r.value);
    entry.peer.send({ id: entry.id, result: optionId ? { outcome: { outcome: 'selected', optionId } } : cancelled });
    this.write({ type: 'extension_ui_dismiss', id: r.id });
  }
  #cancelPermissions() { for (const id of this.permissions.keys()) this.#answer({ id, cancelled: true }); }
  #disconnected(peer) {
    if (peer !== this.peer) return;
    this.sessionId = null;
    this.#cancelPermissions();
    if (!this.closed) {
      this.authRequired = false; this.canSignIn = false; this.options = []; this.commands = []; this.contextUsage = null;
      this.#updateState();
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const turn = this.turn;
    if (turn) this.#cancelTurn(turn);
    this.#cancelPermissions();
    const stopping = this.peer?.close(new Error(`The ${this.p.label} adapter stopped.`));
    await turn?.done;
    await this.controls;
    this.transcript?.close();
    await stopping;
  }
}

// The boot record (provider keys) arrives on an inherited pipe named by IRIS_BOOT_FD, so no secret is
// ever part of this process's environment, which the same user can read back from the system. The pipe
// is drained and closed here, before any tool can run. A start without the relay passes it in IRIS_BOOT instead.
function takeBoot() {
  const fd = Number(process.env.IRIS_BOOT_FD);
  delete process.env.IRIS_BOOT_FD;
  let raw = process.env.IRIS_BOOT;
  delete process.env.IRIS_BOOT;
  if (Number.isInteger(fd) && fd > 2) {
    try { raw = readFileSync(fd, 'utf8'); } catch { /* no pipe was passed */ }
    try { closeSync(fd); } catch { /* already closed */ }
  }
  return raw;
}

// What runs when this file (or iris-cursor.mjs, for Cursor) is started: an account check or sign-in for
// Settings, or the adapter of a conversation.
export async function main(engine = 'antigravity') {
  const P = profileOf(engine);
  if (['--account-check', '--account-login'].includes(process.argv[2])) {
    try {
      const result = await account({ bin: process.argv[3], cwd: process.cwd(), login: process.argv[2] === '--account-login', version: process.argv[4],
        home: P.engine === 'antigravity' ? process.argv[5] : null, profile: P, menus: process.env.IRIS_CLI_MENUS_DIR ? { dir: process.env.IRIS_CLI_MENUS_DIR } : null });
      output(process.stdout, { cliAccountStatus: result });
    } catch (error) { output(process.stdout, { cliAccountError: error.message }); }
    return;
  }
  if (process.argv[2] === '--account-login-terminal') {
    // The CLI's own terminal sign-in (a link, then the code its page shows), started with exactly what a
    // conversation's CLI is started with: the same variables and the same data directory. Whatever the CLI
    // decides from those (where it keeps the sign-in, how it reaches the service) is then the same for both; a
    // sign-in made in a person's own shell could succeed there and still not be one for Iris's conversations.
    const dataDir = dataDirName(process.argv[5]);
    if (!isAbsolute(process.argv[3] ?? '')) { process.stdout.write(`couldn't log in: the ${P.label} CLI was not found\n`); process.exit(1); }
    if (P.engine !== 'antigravity' && isAbsolute(process.argv[5] ?? '')) try { mkdirSync(process.argv[5], { recursive: true, mode: 0o700 }); } catch { /* the CLI says what is wrong */ }
    const child = spawn(process.argv[3], P.loginArgs(dataDir),
      { cwd: process.cwd(), env: { ...cliEnv(process.env, P), ...P.homeEnv(process.argv[5]), ...(process.env.TERM ? { TERM: process.env.TERM } : {}) }, stdio: 'inherit' });
    child.on('error', error => { process.stdout.write(`couldn't log in: ${error.message}\n`); process.exit(1); });
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    return;
  }
  let boot;
  try { boot = JSON.parse(takeBoot() ?? '{}'); } catch { boot = {}; }
  const adapter = new AntigravityAdapter({ engine: P.engine, boot, write: value => { if (!process.stdout.destroyed) output(process.stdout, value); } });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    process.stdin.destroy();
    adapter.close().then(() => process.stdout.end(), () => { process.exitCode = 1; process.stdout.end(); });
  };
  if (adapter.standby) setTimeout(() => { if (adapter.standby) shutdown(); }, STANDBY_MS).unref();
  readLines(process.stdin, line => {
    try { void adapter.handle(JSON.parse(line)); } catch { /* malformed parent input */ }
  }, shutdown);
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.stdin.on('error', shutdown);
  process.stdout.on('error', shutdown);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, shutdown);
}

let isMain = false;
try { isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { /* imported */ }
if (isMain) await main('antigravity');
