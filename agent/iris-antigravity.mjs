// Antigravity engine: Pi RPC ⇄ the official CLI's ACP v1 stdio server.
// The CLI owns sign-in, credentials, tools and model access. This adapter has no API fallback.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const ENGINE = 'antigravity';
const AUTH_METHOD = 'oauth-personal';
const BINDING = 'iris-antigravity-session';
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
function cliEnv(env) {
  return Object.fromEntries(CLI_ENV.filter(key => has(env, key)).map(key => [key, env[key]]));
}

// A binding is append-only. An interrupted session/new may have reached the CLI, so never
// issue another one for that file unless the CLI confirmed it had rejected the first for auth.
class Transcript {
  constructor({ cwd, sessionsDir, sessionFile, recordId }) {
    this.entries = [];
    this.leafId = null;
    this.binding = null;
    const id = randomUUID(), timestamp = new Date().toISOString();
    const dir = join(sessionsDir, 'antigravity');
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
        this.header = { type: 'session', version: 3, id, timestamp, cwd, engine: ENGINE };
        this.#write([this.header]);
      } else {
        const records = readFileSync(this.fd, 'utf8');
        if (!records.endsWith('\n')) throw new Error('Incomplete session file');
        const lines = records.split('\n');
        this.header = JSON.parse(lines.shift());
        if (this.header?.type !== 'session' || this.header.engine !== ENGINE || !text(this.header.id) || this.header.cwd !== cwd) throw new Error('Invalid session header');
        const ids = new Set();
        for (const line of lines) {
          if (!line) continue;
          const entry = JSON.parse(line);
          if (!text(entry?.id) || ids.has(entry.id) || entry.parentId !== this.leafId || entry.type === 'session') throw new Error('Invalid session entry');
          if (entry.type === 'custom' && entry.customType === BINDING) {
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
      throw new Error(existing ? 'Cannot read the original Antigravity transcript. No replacement was started.' : 'Cannot create a private Antigravity transcript.');
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
      throw new Error('Cannot save the Antigravity transcript.');
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
    this.append([{ type: 'custom', customType: BINDING, data }]);
    this.binding = data;
  }

  messages() { return this.entries.filter(e => e.type === 'message').map(e => e.message); }
  publicEntries() { return this.entries.map(e => e.type === 'custom' && e.customType === BINDING ? { ...e, data: undefined } : e); }
  close() { if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; } }
}

// What a request to the CLI was for, in words a person reads in a message.
const REQUESTS = {
  initialize: 'initialize', authenticate: 'complete sign-in', 'session/list': 'check sign-in', 'session/new': 'start a session',
  'session/load': 'load the original session', 'session/resume': 'resume the original session',
  'session/set_config_option': 'change session settings', 'session/prompt': 'complete the prompt',
};
class AcpError extends Error {
  constructor(error, method) {
    const code = Number.isInteger(error?.code) ? error.code : null;
    const what = REQUESTS[method];
    super(`Antigravity could not ${what}${code == null ? '' : ` (ACP error ${code})`}.`);
    this.code = code;
    // -32000 is also used as a generic server error by JSON-RPC implementations.
    this.authRequired = code === -32000 && typeof error?.message === 'string' &&
      /^\s*(?:authentication (?:is )?required\b|auth_required\b)/i.test(error.message);
  }
}

class AcpPeer {
  constructor(config, env, onRecord, onDisconnect) {
    const args = ['acp', ...(config.appDataDir ? ['--app-data-dir', config.appDataDir] : []), ...(config.bypassPermissions ? ['--dangerously-skip-permissions'] : [])];
    try { this.child = spawn(config.bin, args, { cwd: config.cwd, env: cliEnv(env), stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { throw new Error('Could not start the configured Antigravity CLI.'); }
    this.pending = new Map();
    this.nextId = 0;
    this.seq = 0;
    this.closed = false;
    this.onDisconnect = onDisconnect;
    const broken = () => this.close(new Error('The Antigravity CLI connection closed.'));
    this.exited = new Promise(resolve => {
      this.child.once('exit', () => {
        resolve(true);
        // Normally stdout closes right after the final records. A descendant could hold it open.
        if (!this.closed) this.drainTimer = setTimeout(broken, 250);
      });
      this.child.on('error', () => {
        if (!this.child.pid) resolve(true);
        this.close(new Error('Could not start or communicate with the configured Antigravity CLI.'));
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
          if (has(record, 'error')) p.reject(new AcpError(record.error, p.method));
          else if (has(record, 'result')) p.resolve({ result: record.result, seq });
          else p.reject(new Error('Invalid response from the Antigravity CLI.'));
        }
      } catch { this.close(new Error('The Antigravity CLI sent an invalid ACP record.')); }
    }, () => this.close(new Error('An Antigravity CLI ACP record exceeded the size limit.')));
  }

  send(fields) {
    if (this.closed) return;
    output(this.child.stdin, { jsonrpc: '2.0', ...fields });
  }

  request(method, params, timeout = CONTROL_MS) {
    if (this.closed) return Promise.reject(new Error('The Antigravity CLI connection closed.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      // No answer usually means the CLI is waiting on the network: it asks Google before it replies.
      const timer = timeout ? setTimeout(() => this.close(new Error(`Antigravity did not answer in time (asked to ${REQUESTS[method] ?? method}). It may not be reaching Google from this machine.`)), timeout) : null;
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

const initParams = version => ({ protocolVersion: 1, clientCapabilities: {},
  clientInfo: { name: 'iris', title: 'Iris', version: version ?? '0.0.0' } });
// The CLI takes a plain name for its data directory, which it keeps under ~/.gemini beside its own.
const dataDirName = home => text(home) && /^[\w.-]+$/.test(home) && !home.startsWith('.') ? home : undefined;
const personalAuth = init => Array.isArray(init?.authMethods) && init.authMethods.some(m => m?.id === AUTH_METHOD && (m.type == null || m.type === 'agent'));

// Settings can probe or authenticate without opening a chat. session/list is read-only;
// its result (including the user's conversation metadata) never leaves this process.
// home: Iris's own Antigravity data directory, the one its conversations use. The check and the sign-in
// must use it too: where there is no keychain (an SSH host), the CLI keeps a sign-in in its data directory,
// so one made or looked for in another directory is not the one a conversation gets.
// menus: { dir } asks, once signed in, what a new conversation can choose from. ACP only says that in the
// reply to session/new, so one is opened in `dir` (an empty folder of Iris's) and closed again; no message
// is sent.
async function account({ bin, cwd, login, version, home = null, menus = null }) {
  if (!isAbsolute(bin ?? '')) throw new Error('Missing Antigravity CLI.');
  const appDataDir = dataDirName(home);
  const probe = menus && isAbsolute(menus.dir ?? '') && appDataDir ? menus : null;
  const peer = new AcpPeer({ bin, cwd, ...(appDataDir ? { appDataDir } : {}) }, process.env, (p, r) => {
    if (rpcId(r.id)) p.send({ id: r.id, error: { code: -32601, message: 'Method not supported' } });
  }, () => {});
  let canSignIn = false;
  try {
    const { result: init } = await peer.request('initialize', initParams(version));
    if (init?.protocolVersion !== 1) throw new Error('The Antigravity CLI did not negotiate ACP version 1.');
    canSignIn = personalAuth(init);
    const canCheck = object(init.agentCapabilities?.sessionCapabilities?.list);
    if (login) {
      if (!canSignIn) return { signedIn: null, canSignIn };
      await peer.request('authenticate', { methodId: AUTH_METHOD }, LOGIN_MS);
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

function selectConfig(options) {
  const seen = new Set();
  return (Array.isArray(options) ? options : []).flatMap(o => {
    if (!text(o?.id) || seen.has(o.id) || o.type !== 'select' || !text(o.name) || typeof o.currentValue !== 'string') return [];
    // Only model and reasoning controls belong in the desktop MVP, not CLI permission modes.
    const category = o.category ?? (o.id === 'model' ? 'model' : ['effort', 'thinking', 'thinking_level', 'thought_level'].includes(o.id) ? 'thought_level' : null);
    if (category !== 'model' && category !== 'thought_level') return [];
    seen.add(o.id);
    const values = new Set();
    const choices = (Array.isArray(o.options) ? o.options : []).flatMap(choice =>
      text(choice?.group) && Array.isArray(choice.options) ? choice.options : [choice]);
    return [{ id: o.id, name: o.name, category, currentValue: o.currentValue,
      options: choices.flatMap(choice => {
        if (typeof choice?.value !== 'string' || values.has(choice.value) || !text(choice.name)) return [];
        values.add(choice.value);
        return [{ value: choice.value, name: choice.name }];
      }) }];
  });
}

// Antigravity's own tools, by what the CLI sends for them: `update_steps` carries the whole task list,
// `invoke_subagent` the role and the brief of an agent it starts.
function stepsOf(update) {
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
  if (!/invoke_subagent/i.test(tool.title ?? '') || !text(raw?.Prompt)) return null;
  return { name: 'Task', arguments: { description: (text(raw.Role) ? raw.Role : raw.Prompt.split('\n')[0]).slice(0, 120), prompt: raw.Prompt.slice(0, 4000),
    subagent_type: text(raw.TypeName) && raw.TypeName !== 'self' ? raw.TypeName.slice(0, 40) : 'Agent', ...(text(raw.Model) ? { model: raw.Model.slice(0, 60) } : {}) } };
}
// The CLI's ordinary tools, shown the way Pi's and Claude Code's are: a command, a file read or written, a web
// search. The CLI names the kind of each and gives its input (CommandLine, Path, query); anything else keeps
// the CLI's own title. Only those fields are read: the rest of a tool's input is not passed on.
const EDIT_SHOWN = 200000; // characters of a written or changed file kept for the conversation
// The file before and after a change, as the CLI reports it once the change is made.
const shownDiff = content => { const diff = (Array.isArray(content) ? content : []).find(block => block?.type === 'diff' && typeof block.newText === 'string'); return diff ? { oldText: typeof diff.oldText === 'string' ? diff.oldText : null, newText: diff.newText } : null; };
function toolOf(tool) {
  const raw = tool.raw ?? {};
  const path = tool.paths[0] ?? (text(raw.Path) && isAbsolute(raw.Path) ? raw.Path : null);
  if (tool.kind === 'execute') {
    const command = text(raw.CommandLine) ? raw.CommandLine : tool.title;
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
  if (tool.kind === 'search' && text(raw.query)) return { name: 'WebSearch', arguments: { query: raw.query.slice(0, 500) } };
  if (tool.kind === 'fetch' && text(raw.Url ?? raw.url)) return { name: 'WebFetch', arguments: { url: String(raw.Url ?? raw.url).slice(0, 2000) } };
  return null;
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
const slashCommands = list => (Array.isArray(list) ? list : []).slice(0, 256).flatMap(c =>
  /^[\w:.-]{1,120}$/.test(c?.name ?? '') ? [{ name: c.name, description: typeof c.description === 'string' ? c.description.slice(0, 400) : '', source: ENGINE,
    ...(text(c.input?.hint) ? { argumentHint: c.input.hint.slice(0, 200) } : {}) }] : []);
const contextOf = ({ used, size }) => Number.isSafeInteger(used) && used >= 0 && Number.isSafeInteger(size) && size > 0
  ? { tokens: used, contextWindow: size, percent: 100 * used / size } : null;
const estimateOutput = blocks => Math.max(0, Math.round(blocks.reduce((n, block) => {
  const printed = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : '';
  const cjk = (printed.match(/[\u3000-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g) ?? []).length;
  return n + cjk + (printed.length - cjk) / 4;
}, 0)));

export class AntigravityAdapter {
  constructor({ boot, write, env = process.env }) {
    const { bin, cwd, sessionsDir, sessionFile, recordId, remote, clientVersion, bypassPermissions, standby, home } = boot?.antigravity ?? {};
    // home: Iris's own Antigravity data directory, so its conversations stay out of the user's own
    // Antigravity. On a Mac the Google sign-in is in the keychain and shared with it; on a machine without
    // one it is kept in this directory, which is why Iris signs in with the same directory (account()).
    this.config = { bin, cwd, sessionsDir, sessionFile, recordId, remote: remote === true, clientVersion, bypassPermissions: bypassPermissions === true,
      appDataDir: dataDirName(home) };
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
      if (this.closed) throw new Error('The Antigravity adapter stopped.');
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
        if (!Array.isArray(images) || !images.every(image)) throw new Error('Choose a PNG, JPEG, GIF, or WebP image for Antigravity.');
        if (!(text(r.message) && r.message.trim()) && !images.length) throw new Error('Enter a message for Antigravity.');
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
      default: throw new Error('This command is not supported by the Antigravity adapter.');
    }
  }

  #transcript(create = true) {
    if (!this.transcript && (create || this.config.sessionFile != null)) {
      const { cwd, sessionsDir, sessionFile, recordId } = this.config;
      if (recordId != null && (typeof recordId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(recordId))) {
        throw new Error('Invalid Antigravity conversation ID.');
      }
      if (![cwd, sessionsDir, ...(sessionFile == null ? [] : [sessionFile])].every(v => text(v) && isAbsolute(v))) {
        throw new Error('Antigravity requires absolute local working directory and transcript paths.');
      }
      this.transcript = new Transcript(this.config);
    }
    return this.transcript;
  }

  #cliState() {
    return { authRequired: this.authRequired, canSignIn: this.canSignIn, options: this.options,
      image: this.capabilities?.promptCapabilities?.image === true,
      permissionMode: this.config.bypassPermissions ? 'bypassPermissions' : 'confirm', commands: this.commands, contextUsage: this.contextUsage,
      ...(this.standby ? { standby: true } : {}) };
  }
  #model() {
    const id = this.options.find(o => o.category === 'model')?.currentValue;
    return id ? { provider: ENGINE, id } : null;
  }
  #state() {
    const model = this.#model();
    return { engine: ENGINE, sessionId: this.transcript?.header.id ?? null, sessionFile: this.transcript?.file ?? null,
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
    this.options = selectConfig(options);
    this.#updateState();
  }

  async #initialize() {
    if (this.peer && !this.peer.closed) return this.capabilities;
    if (this.peer && !await this.peer.stopped) throw new Error('The previous Antigravity CLI process did not stop.');
    if (this.closed) throw new Error('The Antigravity adapter stopped.');
    if (!text(this.config.bin) || !isAbsolute(this.config.bin)) throw new Error('An explicit path to the official Antigravity CLI is required.');
    const peer = new AcpPeer(this.config, this.env, (p, r, seq) => this.#onRecord(p, r, seq), p => this.#disconnected(p));
    this.peer = peer;
    this.capabilities = {};
    this.configSeq = 0;
    let init;
    try {
      ({ result: init } = await peer.request('initialize', initParams(this.config.clientVersion)));
    } catch (error) {
      if (!error.authRequired) peer.close(error);
      throw error;
    }
    if (init?.protocolVersion !== 1 || peer.closed) {
      const error = new Error('The Antigravity CLI did not negotiate ACP version 1.');
      peer.close(error); throw error;
    }
    this.capabilities = init.agentCapabilities ?? {};
    this.canSignIn = !this.config.remote && personalAuth(init);
    return this.capabilities;
  }

  // A CLI waiting for the first message gets its slow start out of the way. The CLI signs in, and asks Google
  // for the account and its models, only when it is first asked something: left for session/new, that is
  // about two seconds between sending the first message and the model seeing it (more through a proxy).
  // session/list sets it off and changes nothing; what it returns is not used.
  #warm() {
    const peer = this.peer;
    if (!peer || peer.closed || this.warmed === peer || !object(this.capabilities?.sessionCapabilities?.list)) return;
    this.warmed = peer;
    peer.request('session/list', {}, MENUS_MS).catch(() => {}); // not signed in, or no answer: the first message finds out
  }

  async #activate(cwd) {
    if (!text(cwd) || !isAbsolute(cwd) || (!this.standby && cwd !== this.config.cwd)) throw new Error('Invalid Antigravity workspace.');
    // ACP's session/new takes the session's own working directory. A No-folder
    // spare can run in the shared root until the first message names its folder.
    this.config.cwd = cwd;
    this.standby = false;
    await this.#ensureReady();
    return this.#state();
  }

  async #ensureReady() {
    if (this.standby) throw new Error('Open the Antigravity conversation first.');
    const tr = this.#transcript();
    if (this.peer && !this.peer.closed && (this.sessionId || this.authRequired)) return;
    // An earlier session/new never reported its ID (the CLI timed out, crashed or was stopped mid-start).
    // A prompt is only ever sent to a session with a known ID, so whatever the CLI may have created is
    // empty: trying again loses nothing, while refusing at once left the conversation unusable for good.
    // Bounded, so a CLI that keeps creating sessions without answering cannot fill the account with them.
    if (tr.binding?.creating && (tr.binding.attempts ?? 1) >= NEW_SESSION_ATTEMPTS) {
      throw new Error('Antigravity did not confirm a new session after several attempts. No further session was started; start a new conversation to continue.');
    }
    try { await this.#initialize(); }
    catch (error) { if (error.authRequired) { this.#authNeeded(); return; } throw error; }
    await this.#open();
  }

  async #open() {
    const tr = this.transcript, saved = tr.binding?.sessionId;
    const peer = this.peer;
    if (this.closed || peer.closed) throw new Error('The Antigravity CLI connection closed.');
    const method = !saved ? 'session/new' : object(this.capabilities.sessionCapabilities?.resume) ? 'session/resume' :
      this.capabilities.loadSession === true ? 'session/load' : null;
    if (!method) throw new Error('The Antigravity CLI cannot resume this session. No replacement was started.');
    const opening = { saved, latest: null, metadata: new Map() };
    this.opening = opening;
    try {
      this.write({ type: 'cli_opening' });
      if (!saved) tr.bind({ creating: true, attempts: (tr.binding?.creating ? tr.binding.attempts ?? 1 : 0) + 1 });
      const { result, seq } = await peer.request(method, { cwd: this.config.cwd, mcpServers: [], ...(saved ? { sessionId: saved } : {}) }, OPEN_MS);
      const sessionId = saved ?? result?.sessionId;
      if (!text(sessionId) || (saved && result?.sessionId != null && result.sessionId !== saved)) throw new Error('Antigravity did not return the expected session ID.');
      // Record a successful new session even if the pipe closes immediately after the reply.
      if (!saved) tr.bind({ sessionId });
      if (this.closed || peer.closed) throw new Error('The Antigravity CLI connection closed.');
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
    } catch (error) {
      // The CLI answered that it created nothing (an ACP error, sign-in needed): the next attempt starts clean.
      // A timeout or a closed pipe stays recorded as an unconfirmed attempt (see #ensureReady).
      if (!saved && (error.authRequired || error instanceof AcpError)) tr.bind({ creating: false });
      if (error.authRequired) {
        this.#authNeeded();
        return;
      }
      if (saved && error instanceof AcpError && error.code === -32002) throw new Error('The original Antigravity session was not found. No replacement was started.');
      throw error;
    } finally { this.opening = null; }
  }

  async #signIn() {
    await this.#ensureReady();
    if (this.sessionId) return this.#state();
    if (!this.authRequired || !this.canSignIn) throw new Error(this.config.remote
      ? 'Sign in to Antigravity on this host in Settings → Subscriptions, then reconnect.' : 'Sign in using the official Antigravity CLI, then reconnect.');
    try { await this.peer.request('authenticate', { methodId: AUTH_METHOD }, LOGIN_MS); }
    catch (error) { if (error.authRequired) { this.#authNeeded(); return this.#state(); } throw error; }
    await this.#open();
    return this.#state();
  }

  async #setConfig(configId, value) {
    if (this.turn) throw new Error('Wait for the current Antigravity turn to finish.');
    await this.#ensureReady();
    if (!this.sessionId) throw new Error('Sign in to Antigravity before changing session settings.');
    if (!this.options.find(o => o.id === configId)?.options.some(choice => choice.value === value)) throw new Error('That Antigravity setting is not an advertised option.');
    const peer = this.peer;
    try {
      const { result, seq } = await peer.request('session/set_config_option', { sessionId: this.sessionId, configId, value });
      if (peer.closed) throw new Error('The Antigravity CLI connection closed.');
      this.#replaceOptions(result?.configOptions, seq);
    } catch (error) { if (error.authRequired) this.#authNeeded(); else throw error; }
    return this.#state();
  }

  async #prompt(message, images, epoch) {
    if (this.turn) throw new Error('Antigravity is already responding; stop this turn before sending another prompt.');
    if (this.cancelEpoch !== epoch) throw new Error('The Antigravity prompt was cancelled before it started.');
    await this.#ensureReady();
    if (this.closed || this.cancelEpoch !== epoch) throw new Error('The Antigravity prompt was cancelled before it started.');
    if (!this.sessionId) throw new Error('Sign in to Antigravity before sending a prompt.');
    if (images.length && this.capabilities?.promptCapabilities?.image !== true) throw new Error('This Antigravity CLI does not accept image prompts.');
    const prompt = [...(message ? [{ type: 'text', text: message }] : []), ...images.map(({ mimeType, data }) => ({ type: 'image', mimeType, data }))];
    // The ACP line reader and the relay both have finite record sizes.
    if (Buffer.byteLength(JSON.stringify(prompt)) > 6 * 1024 * 1024) throw new Error('Antigravity prompts must be smaller than 6 MB after encoding.');
    const user = { role: 'user', content: prompt, timestamp: Date.now() };
    this.transcript.append([{ type: 'message', message: user }]);
    const turn = { sessionId: this.sessionId, startedAt: Math.max(Date.now(), user.timestamp + 1), tools: new Map(), content: [], model: this.#model()?.id };
    this.turn = turn;
    this.write({ type: 'agent_start' });
    this.#message(user);
    this.write({ type: 'message_start', message: this.#assistant(turn, []) });
    turn.requestedAt = performance.now();
    turn.done = this.peer.request('session/prompt', { sessionId: turn.sessionId, prompt: user.content }, null).then(
      ({ result }) => {
        const reason = STOP.get(result?.stopReason);
        turn.usage = turnUsage(result?.usage);
        this.#finishTurn(turn, reason ?? 'error', reason ? null : 'Antigravity returned an unrecognized stop reason.');
        return !!reason;
      }, error => {
        const aborted = turn.cancelled || error.code === -32800;
        this.#finishTurn(turn, aborted ? 'aborted' : 'error', aborted ? null : error.authRequired ? 'Sign in to Antigravity to continue.' : error.message);
        if (!this.closed && error.authRequired) this.#authNeeded();
        return error instanceof AcpError;
      });
    return { disposition: 'started' };
  }

  #assistant(turn, content) {
    return { role: 'assistant', content, provider: ENGINE, api: 'antigravity-acp', ...(turn.model ? { model: turn.model } : {}), timestamp: turn.startedAt };
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
      tool = { id: randomUUID(), index: turn.content.length, start: Date.now(), paths: [], result: [] };
      turn.tools.set(update.toolCallId, tool);
      if (steps) turn.plan = tool;
    }
    if (text(update.kind)) tool.kind = update.kind;
    if (text(update.title)) tool.title = update.title;
    if (update.rawInput && typeof update.rawInput === 'object') tool.raw = update.rawInput;
    if (Array.isArray(update.locations)) tool.paths = shownPaths(update.locations);
    if (Array.isArray(update.content)) { tool.result = shownContent(update.content); tool.diff = shownDiff(update.content) ?? tool.diff; }
    // Its task list and the agents it starts are shown as Claude Code's are: a Tasks card, and a task with its brief.
    const asks = asksOf(tool);
    if (asks) tool.asks = asks;
    const known = tool === turn.plan ? { name: 'TodoWrite', arguments: { todos: stepsOf({ title: tool.title, rawInput: tool.raw }) ?? [] } }
      : asks ? { name: 'AskUserQuestion', arguments: { questions: asks.map(ask => ({ question: ask.question, options: ask.options.map(label => ({ label })), ...(ask.multi ? { multiSelect: true } : {}) })) } }
      : agentOf(tool) ?? toolOf(tool);
    const call = known ? { type: 'toolCall', id: tool.id, ...known } : { type: 'toolCall', id: tool.id, name: tool.title ?? tool.kind ?? 'Antigravity tool',
      arguments: tool.paths.length ? { path: tool.paths[0], ...(tool.paths.length > 1 ? { paths: tool.paths } : {}) } : {} };
    if (known?.name === 'TodoWrite') tool.fallback = 'Tasks updated.';
    else if (known?.name === 'Task') tool.fallback = 'The agent was started; it reports back to Antigravity.';
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
        partialResult: { content: tool.result, details: { engine: ENGINE } } });
    } else if (turn.cancelled && !tool.finished && !tool.interrupted) {
      tool.interrupted = true;
      this.#toolEnd(tool, true, 'Interrupted.');
    }
  }
  #toolEnd(tool, isError, fallback) {
    const content = tool.result.length ? tool.result : [{ type: 'text', text: fallback }];
    // Stopped by the person (Stop, or a message sent while it worked) is not the tool failing.
    const details = { engine: ENGINE, ...(fallback === 'Interrupted.' ? { interrupted: true } : {}) };
    const durationMs = Date.now() - tool.start;
    tool.message = { role: 'toolResult', toolCallId: tool.id, toolName: tool.call.name, content, details, isError, timestamp: Date.now() };
    this.write({ type: 'tool_execution_end', toolCallId: tool.id, toolName: tool.call.name, result: { content, details }, isError, durationMs });
  }

  #finishTurn(turn, stopReason, errorMessage) {
    if (this.turn !== turn) return;
    this.#cancelPermissions();
    this.#endBlock(turn);
    // A question left open is the turn asking for an answer, not a tool that failed.
    const asked = stopReason === 'stop' ? [...turn.tools.entries()].find(([, tool]) => tool.asks && !tool.message) : null;
    if (asked) this.#toolEnd(asked[1], false, 'Asked.');
    for (const tool of turn.tools.values()) if (!tool.message) this.#toolEnd(tool, true, stopReason === 'aborted' ? 'Interrupted.' : 'Antigravity did not report tool completion.');
    // ACP does not expose individual model request timestamps or token counts.
    // Keep elapsed turn time separate from the provider metering used by Pi.
    // The CLI also writes its question out as text ("Which colour? [1] red [2] green"). The card asks it, with
    // the choices as buttons; the same thing as a paragraph above the card is left out of the conversation.
    if (asked) turn.content = turn.content.filter(block => !(block?.type === 'text' && asked[1].asks.every(ask => block.text.includes(ask.question) && ask.options.every(option => block.text.includes(option)))
      && block.text.length < 400 + asked[1].asks.reduce((n, ask) => n + ask.question.length + ask.options.join('').length + ask.options.length * 12, 0)));
    const __agyTurn = { durationMs: Math.max(1, Math.round(performance.now() - turn.requestedAt)), tokenEstimate: estimateOutput(turn.content) };
    // The CLI's own token counts for the turn, when it gives them (with the turn's length, they give its speed).
    let message = { ...this.#assistant(turn, turn.content), __agyTurn, ...(turn.usage ? { usage: turn.usage, durationMs: __agyTurn.durationMs } : {}), stopReason, ...(errorMessage ? { errorMessage } : {}) };
    const results = [...turn.tools.values()].map(t => t.message);
    try { this.transcript.append([message, ...results].map(message => ({ type: 'message', message }))); }
    catch { message = { ...message, stopReason: 'error', errorMessage: 'Could not save this turn to the Antigravity transcript.' }; }
    this.turn = null;
    this.write({ type: 'message_end', message });
    for (const result of results) this.#message(result);
    this.write({ type: 'agent_end' });
    this.write({ type: 'agent_settled' });
    if (asked && !this.closed) { this.ask = { toolCallId: asked[0], questions: asked[1].asks, answers: [], open: null }; this.#askNext(); }
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
    this.ask = null; this.askedId = ask.toolCallId;
    if (ask.open) this.write({ type: 'extension_ui_dismiss', id: ask.open });
  }

  #cancelTurn(turn) {
    if (turn.cancelled) return;
    turn.cancelled = true;
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
      if (await within(turn.done, ABORT_MS, TIMED_OUT) === TIMED_OUT) throw new Error('Antigravity did not confirm the cancellation.');
    }
    return {};
  }

  #onRecord(peer, record, seq) {
    if (peer !== this.peer || this.closed) return;
    const { id, method, params } = record;
    if (has(record, 'id')) {
      if (!rpcId(id)) return;
      if (method === 'session/request_permission') this.#permission(peer, id, params);
      else peer.send({ id, error: { code: -32601, message: 'Method not supported by Iris' } });
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
          : { commands: slashCommands(update.availableCommands) };
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
      if (!turn || params.sessionId !== turn.sessionId) return;
      switch (update.sessionUpdate) {
        case 'agent_message_chunk': this.#chunk(turn, 'text', update.content); break;
        case 'agent_thought_chunk': this.#chunk(turn, 'thinking', update.content); break;
        case 'tool_call': case 'tool_call_update': this.#tool(turn, update); break;
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
    this.write({ type: 'extension_ui_request', id: uiId, method: 'select', header: 'Antigravity tool permission',
      title: (text(call.title) ? call.title : tool?.title) ?? 'Approve this Antigravity tool call?',
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
    const stopping = this.peer?.close(new Error('The Antigravity adapter stopped.'));
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

let isMain = false;
try { isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { /* imported */ }
if (isMain && ['--account-check', '--account-login'].includes(process.argv[2])) {
  try {
    const result = await account({ bin: process.argv[3], cwd: process.cwd(), login: process.argv[2] === '--account-login', version: process.argv[4],
      home: process.argv[5], menus: process.env.IRIS_CLI_MENUS_DIR ? { dir: process.env.IRIS_CLI_MENUS_DIR } : null });
    output(process.stdout, { cliAccountStatus: result });
  } catch (error) { output(process.stdout, { cliAccountError: error.message }); }
} else if (isMain && process.argv[2] === '--account-login-terminal') {
  // The CLI's own terminal sign-in (a link, then the code its page shows), started with exactly what a
  // conversation's CLI is started with: the same variables and the same data directory. Whatever the CLI
  // decides from those (where it keeps the sign-in, how it reaches Google) is then the same for both; a
  // sign-in made in a person's own shell could succeed there and still not be one for Iris's conversations.
  const dataDir = dataDirName(process.argv[5]);
  if (!isAbsolute(process.argv[3] ?? '')) { process.stdout.write('couldn\'t log in: the Antigravity CLI was not found\n'); process.exit(1); }
  const child = spawn(process.argv[3], ['acp', '--login', ...(dataDir ? ['--app-data-dir', dataDir] : [])],
    { cwd: process.cwd(), env: { ...cliEnv(process.env), ...(process.env.TERM ? { TERM: process.env.TERM } : {}) }, stdio: 'inherit' });
  child.on('error', error => { process.stdout.write(`couldn't log in: ${error.message}\n`); process.exit(1); });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else if (isMain) {
  let boot;
  try { boot = JSON.parse(takeBoot() ?? '{}'); } catch { boot = {}; }
  const adapter = new AntigravityAdapter({ boot, write: value => { if (!process.stdout.destroyed) output(process.stdout, value); } });
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
