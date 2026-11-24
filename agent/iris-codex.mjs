// Codex engine: Pi RPC ⇄ the official Codex CLI's app server (`codex app-server`, JSON-RPC on stdio).
// The CLI owns sign-in, credentials, tools, sandboxing and model access; this adapter never reads a
// token and has no API fallback. It reports the same state (`cli_state`) and accepts the same
// commands (`cli_set_config`, …) as the Antigravity adapter: the desktop's contract for account-backed CLIs.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ENGINE = 'codex';
const BINDING = 'iris-codex-thread';
const SETTINGS = 'iris-codex-settings';
const CONTROL_MS = 20000;
const OPEN_MS = 60000;
const ABORT_MS = 8000;
const MAX_LINE = 16 * 1024 * 1024;
const TIMED_OUT = Symbol('timed out');
// A new conversation is named the way the Codex TUI names its threads: Codex answers a one-off, tool-less
// request (an ephemeral thread, never saved to the user's Codex history) with a short title.
const TITLE_PROMPT = `You name conversations. Reply with a title for the conversation that starts with the user's message below: 2 to 6 words, in the language of the message, sentence case, no quotes, no trailing punctuation.`;
const TITLE_SCHEMA = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
const TITLE_MS = 60000;
export function titleOf(reply) {
  let title = String(reply ?? '').trim();
  try { const parsed = JSON.parse(title); if (typeof parsed?.title === 'string') title = parsed.title; } catch { /* plain text */ }
  title = title.split('\n')[0].replace(/^["'“”‘’「」《》]+|["'“”‘’「」《》]+$/g, '').replace(/[.。!！?？:：;；,，、]+$/, '').replace(/\s+/g, ' ').trim();
  return title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title;
}

const text = value => typeof value === 'string' && value.length > 0;
const rpcId = value => typeof value === 'string' || Number.isSafeInteger(value);
const output = (stream, value) => stream.write(JSON.stringify(value) + '\n');
const clip = (value, max = 16000) => { const s = String(value ?? ''); return s.length > max ? `${s.slice(0, max)}\n…` : s; };
const within = async (promise, ms, fallback) => {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms, fallback); })]); }
  finally { clearTimeout(timer); }
};
// Codex runs every command through the login shell (`/bin/zsh -lc 'rg -n "x" src'`); show what was run.
export function shellCommand(command) {
  const whole = String(command ?? '').trim();
  const arg = /^(?:\S*\/)?(?:ba|z|k|da|fi)?sh\s+(?:-l\s+)?-l?c\s+([\s\S]+)$/.exec(whole)?.[1].trim();
  if (!arg) return whole;
  // POSIX quoting: a quote inside single quotes is written '\'' (or '"'"').
  if (arg.length >= 2 && arg.startsWith("'") && arg.endsWith("'")) return arg.slice(1, -1).replace(/'\\''/g, "'").replace(/'"'"'/g, "'");
  if (arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')) return arg.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  return arg;
}
// A unified diff's hunks as before/after text pairs: the shape of Pi's edit tool, so a Codex patch shows
// the same diff and +/− counts as Pi's own edits.
export function editsOfDiff(diff) {
  const edits = [];
  let hunk = null;
  for (const line of String(diff ?? '').replace(/\r?\n$/, '').split(/\r?\n/)) {
    const head = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (head) { hunk = { old: [], new: [], oldLeft: Number(head[1] ?? 1), newLeft: Number(head[2] ?? 1) }; edits.push(hunk); continue; }
    if (!hunk || line.startsWith('\\')) continue; // file headers; "\ No newline at end of file"
    const sign = line[0], body = line.slice(1);
    if (sign === '-') { hunk.old.push(body); hunk.oldLeft--; }
    else if (sign === '+') { hunk.new.push(body); hunk.newLeft--; }
    else if (sign === ' ' || line === '') { hunk.old.push(body); hunk.new.push(body); hunk.oldLeft--; hunk.newLeft--; }
    if (hunk.oldLeft <= 0 && hunk.newLeft <= 0) hunk = null;
  }
  return edits.map(h => ({ oldText: h.old.join('\n'), newText: h.new.join('\n') }));
}
// A new file's content; Codex sends it as is (older versions as an all-added diff).
const addedContent = diff => /^(?:--- \/dev\/null|@@ -0,0 )/.test(String(diff ?? '')) ? editsOfDiff(diff).map(e => e.newText).join('\n') : String(diff ?? '');
const insideFolder = (cwd, path) => {
  if (!text(path) || !text(cwd) || !isAbsolute(path)) return path;
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return path.startsWith(base) ? path.slice(base.length) || '.' : path;
};
const SEARCH_COMMAND = /^(?:rg|grep|egrep|fgrep|ag|ack|git\s+grep)\b/;

function readLines(stream, onLine, onOverflow) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let start = 0, end;
    while ((end = buffer.indexOf('\n', start)) !== -1) {
      if (end > start) onLine(buffer.slice(start, end));
      start = end + 1;
    }
    buffer = buffer.slice(start);
    if (buffer.length > MAX_LINE) { buffer = ''; onOverflow?.(); }
  });
}

// The conversation as the desktop shows it, in Pi's session-file layout, with the Codex thread it
// belongs to. Private to the user, append-only.
class Transcript {
  constructor({ cwd, sessionsDir, sessionFile, recordId }) {
    this.entries = []; this.leafId = null; this.binding = null;
    const id = randomUUID(), dir = join(sessionsDir, ENGINE);
    this.file = sessionFile ?? join(dir, `${recordId ?? id}.jsonl`);
    let existing = !!sessionFile;
    try {
      const flags = constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW;
      if (!existing) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        try { this.fd = openSync(this.file, flags | constants.O_CREAT | constants.O_EXCL, 0o600); }
        catch (error) { if (error.code !== 'EEXIST' || !recordId) throw error; existing = true; }
      }
      if (existing) this.fd = openSync(this.file, flags);
      const stat = fstatSync(this.fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Not a private session file');
      if (!existing) {
        this.header = { type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd, engine: ENGINE };
        this.#write([this.header]);
      } else {
        const lines = readFileSync(this.fd, 'utf8').split('\n').filter(Boolean);
        this.header = JSON.parse(lines.shift());
        if (this.header?.type !== 'session' || this.header.engine !== ENGINE) throw new Error('Invalid session header');
        for (const line of lines) {
          let entry;
          try { entry = JSON.parse(line); } catch { continue; } // a torn last line
          if (!text(entry?.id)) continue;
          if (entry.type === 'custom' && entry.customType === BINDING && text(entry.data?.threadId)) this.binding = entry.data;
          if (entry.type === 'custom' && entry.customType === SETTINGS && entry.data) this.settings = entry.data;
          this.entries.push(entry); this.leafId = entry.id;
        }
      }
    } catch {
      this.close();
      throw new Error(existing ? 'Cannot read this Codex conversation’s transcript.' : 'Cannot create a private Codex transcript.');
    }
  }
  #write(entries) {
    try { appendFileSync(this.fd, entries.map(e => JSON.stringify(e) + '\n').join('')); fsyncSync(this.fd); }
    catch { throw new Error('Cannot save the Codex transcript.'); }
  }
  append(entries) {
    let parentId = this.leafId;
    const full = entries.map(entry => { const next = { id: randomUUID().replace(/-/g, '').slice(0, 12), parentId, timestamp: new Date().toISOString(), ...entry }; parentId = next.id; return next; });
    this.#write(full);
    this.entries.push(...full); this.leafId = parentId;
  }
  bind(data) { this.append([{ type: 'custom', customType: BINDING, data }]); this.binding = data; }
  messages() { return this.entries.filter(e => e.type === 'message').map(e => e.message); }
  publicEntries() { return this.entries.filter(e => !(e.type === 'custom' && [BINDING, SETTINGS].includes(e.customType))); }
  close() { if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; } }
}

// One `codex app-server` process: requests with replies, notifications, and the server's own requests.
class Peer {
  constructor({ bin, cwd, env, home, onNotification, onRequest, onClose }) {
    this.pending = new Map(); this.next = 0; this.closed = false; this.stderr = '';
    this.onClose = onClose;
    // The CLI gets the user's environment as it is, minus what belongs to this desktop.
    const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:IRIS_|PI_|ELECTRON_)/.test(key)));
    // Another account is another CODEX_HOME: its own sign-in, settings and threads. Unset means the CLI's own.
    if (text(home)) { mkdirSync(home, { recursive: true, mode: 0o700 }); childEnv.CODEX_HOME = home; }
    this.child = spawn(bin, ['app-server'], { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', error => this.close(new Error(error.code === 'ENOENT' ? 'The configured Codex CLI could not be started.' : `Codex could not be started: ${error.message}`)));
    this.child.on('close', () => this.close(new Error(`Codex stopped unexpectedly${this.stderr.trim() ? `: ${this.stderr.trim().split('\n').at(-1).slice(0, 300)}` : '.'}`)));
    this.child.stdin.on('error', () => {});
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-4000); });
    readLines(this.child.stdout, line => {
      let record;
      try { record = JSON.parse(line); } catch { return; }
      if (record?.method && rpcId(record.id)) { onRequest(record.id, record.method, record.params ?? {}); return; }
      if (record?.method) { onNotification(record.method, record.params ?? {}); return; }
      const waiting = this.pending.get(record?.id);
      if (!waiting) return;
      this.pending.delete(record.id); clearTimeout(waiting.timer);
      if (record.error) waiting.reject(Object.assign(new Error(text(record.error.message) ? record.error.message : 'Codex reported an error.'), { code: record.error.code, rpc: true }));
      else waiting.resolve(record.result ?? {});
    });
  }
  send(record) { if (!this.closed) this.child.stdin.write(JSON.stringify(record) + '\n'); }
  request(method, params, timeout = CONTROL_MS) {
    if (this.closed) return Promise.reject(this.reason ?? new Error('The Codex connection closed.'));
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex did not answer ${method} in time.`)); }, timeout) : null;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }
  close(reason = new Error('The Codex connection closed.')) {
    if (this.closed) return;
    this.closed = true; this.reason = reason;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(reason); }
    this.pending.clear();
    try { this.child.stdin.end(); } catch { /* gone */ }
    const child = this.child;
    setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, 1500).unref();
    this.onClose?.(reason);
  }
}

const clientInfo = version => ({ name: 'iris', title: 'Iris', version: text(version) ? version : '0' });
const signInNeeded = error => /not (?:logged|signed) in|unauthorized|401|login required|authentication/i.test(error?.message ?? '');
// What the account page shows: who is signed in, on which plan, and how much of each limit is used.
function accountOf(read, limits) {
  const a = read?.account;
  const window = w => w && Number.isFinite(w.usedPercent) ? { usedPercent: Math.max(0, Math.min(100, Math.round(w.usedPercent))),
    ...(Number.isFinite(w.windowDurationMins) ? { windowMinutes: w.windowDurationMins } : {}), ...(Number.isFinite(w.resetsAt) ? { resetsAt: w.resetsAt * 1000 } : {}) } : null;
  const r = limits?.rateLimits;
  return {
    signedIn: a ? true : read?.requiresOpenaiAuth === false ? null : false, canSignIn: false,
    ...(a?.type === 'chatgpt' ? { identity: a.email ?? null, plan: a.planType ?? null } : a?.type === 'apiKey' ? { identity: 'API key', plan: null } : {}),
    ...(r ? { limits: [window(r.primary), window(r.secondary)].filter(Boolean) } : {}),
  };
}
async function connect({ bin, cwd, env = process.env, version, home, handlers = {} }) {
  // Handlers get the peer itself: notifications can arrive before this function returns it.
  const peer = new Peer({ bin, cwd, env, home,
    onNotification: (method, params) => handlers.onNotification?.(peer, method, params),
    onRequest: (id, method, params) => handlers.onRequest ? handlers.onRequest(peer, id, method, params) : peer.send({ id, error: { code: -32601, message: `Unsupported: ${method}` } }),
    onClose: reason => handlers.onClose?.(peer, reason) });
  await peer.request('initialize', { clientInfo: clientInfo(version), capabilities: null });
  peer.send({ method: 'initialized' });
  return peer;
}
// Settings can check, or end, the sign-in without opening a conversation.
export async function account({ bin, cwd, version, logout = false, home, env = process.env }) {
  const peer = await connect({ bin, cwd, env, version, home });
  try {
    if (logout) await peer.request('account/logout', undefined);
    const read = await peer.request('account/read', { refreshToken: false });
    if (!read?.account) return accountOf(read, null);
    // Signed in: also what a new conversation can choose from, so its menus exist before the first one opens.
    const [limits, models] = await Promise.all([peer.request('account/rateLimits/read', undefined).catch(() => null), peer.request('model/list', {}).catch(() => null)]);
    return { ...accountOf(read, limits), options: optionsOf(visibleModels(models)) };
  } finally { peer.close(); }
}

// Signs in with ChatGPT the way Codex's own clients do: Codex returns the page to open and tells us when
// the browser has come back to it. The credentials stay in Codex's home; this process never sees them.
// onUrl(url) is called once with the page; `cancelled` resolves if the user gives up.
const SIGN_IN_MS = 10 * 60 * 1000;
export async function signIn({ bin, cwd, version, home, env = process.env, onUrl, cancelled = new Promise(() => {}) }) {
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  let loginId = null;
  const peer = await connect({ bin, cwd, env, version, home, handlers: {
    onNotification: (_peer, method, params) => { if (method === 'account/login/completed' && (params.loginId == null || params.loginId === loginId)) finish(params); },
    onClose: (_peer, reason) => finish({ success: false, error: reason?.message ?? 'Codex stopped before the sign-in finished.' }) } });
  try {
    const started = await peer.request('account/login/start', { type: 'chatgpt' });
    if (!text(started?.authUrl)) throw new Error('Codex did not offer a ChatGPT sign-in.');
    loginId = started.loginId ?? null;
    onUrl?.(started.authUrl);
    let timer;
    const result = await Promise.race([completed, cancelled.then(() => ({ cancelled: true })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ success: false, error: 'The sign-in was not finished in time.' }), SIGN_IN_MS); })]);
    clearTimeout(timer);
    if (result.cancelled) { if (loginId) await peer.request('account/login/cancel', { loginId }).catch(() => {}); throw new Error('Sign-in cancelled.'); }
    if (!result.success) throw new Error(text(result.error) ? `Sign-in failed: ${result.error}` : 'Sign-in did not complete.');
    const read = await peer.request('account/read', { refreshToken: false });
    const [limits, models] = await Promise.all([peer.request('account/rateLimits/read', undefined).catch(() => null), peer.request('model/list', {}).catch(() => null)]);
    return { ...accountOf(read, limits), options: optionsOf(visibleModels(models)) };
  } finally { peer.close(); }
}

// What the composer's slash menu offers in a Codex conversation (the desktop runs it; see #compact).
const COMMANDS = [{ name: 'compact', description: 'Summarize the conversation to free up context', source: ENGINE }];
const EFFORT_NAMES = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
const effortId = e => typeof e === 'string' ? e : e?.reasoningEffort ?? e?.effort ?? null;
const visibleModels = list => (list?.data ?? []).filter(m => text(m?.id) && !m.hidden);
// The choices a conversation has, in the shape the composer already renders for Antigravity.
function optionsOf(models, model, effort, speed) {
  if (!models.length) return [];
  const current = models.find(m => m.id === model) ?? models[0];
  return [
    // Each model carries the efforts and speeds it has (`sub`), so a screen that lets the model be
    // picked before a conversation exists can show the right ones at once.
    { id: 'model', name: 'Model', category: 'model', currentValue: current.id, options: models.map(m => ({ value: m.id, name: m.displayName || m.id, sub: [...effortOption(m), ...speedOption(m)] })) },
    ...effortOption(current, effort), ...speedOption(current, speed),
  ];
}
function effortOption(model, effort) {
  const efforts = (model?.supportedReasoningEfforts ?? []).map(effortId).filter(text);
  if (!efforts.length) return [];
  return [{ id: 'effort', name: 'Reasoning effort', category: 'thought_level', currentValue: efforts.includes(effort) ? effort : effortId(model.defaultReasoningEffort) ?? efforts[0],
    options: efforts.map(value => ({ value, name: EFFORT_NAMES[value] ?? value })) }];
}
// Faster service tiers (Fast, Ultrafast). Codex lists, per model, the ones the signed-in account may use
// (a plan without Ultrafast simply does not get it listed), so nothing is inferred from the plan's name.
const tiersOf = model => (Array.isArray(model?.serviceTiers) ? model.serviceTiers : []).filter(t => text(t?.id) && t.id !== 'standard').slice(0, 6);
function speedOption(model, speed) {
  const tiers = tiersOf(model);
  if (!tiers.length) return [];
  return [{ id: 'speed', name: 'Speed', category: 'speed', currentValue: tiers.some(t => t.id === speed) ? speed : 'standard',
    options: [{ value: 'standard', name: 'Standard' }, ...tiers.map(t => ({ value: t.id, name: text(t.name) ? t.name : t.id, ...(text(t.description) ? { description: t.description.slice(0, 160) } : {}) }))] }];
}

export class CodexAdapter {
  constructor({ boot, write, env = process.env }) {
    const { bin, cwd, sessionsDir, sessionFile, recordId, remote, clientVersion, bypassPermissions, home } = boot?.codex ?? {};
    this.config = { bin, cwd, sessionsDir, sessionFile, recordId, remote: remote === true, clientVersion, bypassPermissions: bypassPermissions === true, home: text(home) && isAbsolute(home) ? home : undefined };
    this.write = write; this.env = env;
    this.controls = Promise.resolve();
    this.permissions = new Map();
    this.models = []; this.model = null; this.effort = null; this.speed = null;
    this.authRequired = false; this.account = null; this.contextUsage = null;
    this.closed = false; this.turn = null; this.threadId = null;
    this.sides = new Map(); // ephemeral threads answering a one-off question (the title) -> what they replied
  }

  async handle(r) {
    if (this.closed || typeof r?.type !== 'string') return;
    if (r.type === 'extension_ui_response') { this.#answer(r); return; }
    if (!rpcId(r.id)) return;
    try { this.write({ type: 'response', id: r.id, command: r.type, success: true, data: await this.#command(r) }); }
    catch (error) { this.write({ type: 'response', id: r.id, command: r.type, success: false, error: error.message }); }
  }
  #serial(fn) {
    const run = this.controls.then(() => { if (this.closed) throw new Error('The Codex adapter stopped.'); return fn(); });
    this.controls = run.catch(() => {});
    return run;
  }
  #command(r) {
    switch (r.type) {
      case 'get_state': return this.#serial(async () => { await this.#ensureReady(); this.write({ type: 'cli_permissions', ids: [...this.permissions.keys()] }); return this.#state(); });
      case 'cli_login': throw new Error(this.config.remote ? 'Run codex login --device-auth in the SSH host’s terminal, then reconnect.' : 'Sign in to Codex from Settings → Subscriptions, then reconnect.');
      case 'cli_set_config': return this.#serial(() => this.#setConfig(r.configId, r.value));
      case 'prompt': {
        const images = Array.isArray(r.images) ? r.images : [];
        if (!(text(r.message) && r.message.trim()) && !images.length) throw new Error('Enter a message for Codex.');
        return this.#serial(() => this.#prompt(r.message ?? '', images));
      }
      case 'abort': return this.#abort();
      case 'abort_bash': case 'clear_queue': case 'set_session_name': return {};
      case 'get_messages': return { messages: this.#transcript(false)?.messages() ?? [] };
      case 'get_entries': { const tr = this.#transcript(false); return { entries: tr?.publicEntries() ?? [], leafId: tr?.leafId ?? null }; }
      case 'get_session_stats': return this.contextUsage ? { contextUsage: this.contextUsage } : null;
      case 'get_commands': return { commands: COMMANDS };
      case 'compact': return this.#serial(() => this.#compact());
      default: throw new Error('This command is not supported in Codex conversations.');
    }
  }

  #transcript(create = true) {
    if (!this.transcript && (create || this.config.sessionFile != null)) {
      const { cwd, sessionsDir, sessionFile } = this.config;
      if (![cwd, sessionsDir, ...(sessionFile == null ? [] : [sessionFile])].every(v => text(v) && isAbsolute(v))) throw new Error('Codex requires absolute working directory and transcript paths.');
      this.transcript = new Transcript(this.config);
    }
    return this.transcript;
  }
  #options() { return this.authRequired ? [] : optionsOf(this.models, this.model, this.effort, this.speed); }
  #cliState() {
    return { authRequired: this.authRequired, canSignIn: false, options: this.#options(), image: true,
      permissionMode: this.config.bypassPermissions ? 'bypassPermissions' : 'confirm', commands: COMMANDS, contextUsage: this.contextUsage,
      ...(this.account ? { account: this.account } : {}) };
  }
  #state() {
    return { engine: ENGINE, sessionId: this.transcript?.header.id ?? null, sessionFile: this.transcript?.file ?? null,
      isStreaming: !!this.turn, isCompacting: false, pendingMessageCount: 0, cli: this.#cliState(),
      ...(this.model ? { model: { provider: ENGINE, id: this.model } } : {}) };
  }
  #updateState() { if (!this.closed) this.write({ type: 'cli_state', cli: this.#cliState() }); }

  async #ensureReady() {
    const tr = this.#transcript();
    if (this.peer && !this.peer.closed && (this.threadId || this.authRequired)) return;
    if (!text(this.config.bin)) throw new Error('The configured Codex CLI could not be started.');
    this.write({ type: 'cli_opening' });
    const peer = await connect({ bin: this.config.bin, cwd: this.config.cwd, env: this.env, version: this.config.clientVersion, home: this.config.home, handlers: {
      onNotification: (from, method, params) => this.#notification(from, method, params),
      onRequest: (from, id, method, params) => this.#request(from, id, method, params),
      onClose: (from, reason) => this.#disconnected(from, reason),
    } });
    this.peer = peer;
    const read = await peer.request('account/read', { refreshToken: false });
    if (!read?.account && read?.requiresOpenaiAuth !== false) { this.authRequired = true; this.account = null; this.#updateState(); return; }
    this.authRequired = false;
    const [limits, models] = await Promise.all([peer.request('account/rateLimits/read', undefined).catch(() => null), peer.request('model/list', {}).catch(() => ({ data: [] }))]);
    this.account = accountOf(read, limits);
    this.models = visibleModels(models);
    // "Ask before running tools" means ask: with `on-request` Codex runs anything inside the workspace
    // without a word. `untrusted` lets only commands it knows to be read-only pass unasked.
    const policy = this.config.bypassPermissions ? { approvalPolicy: 'never', sandbox: 'danger-full-access' } : { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
    const saved = tr.binding?.threadId;
    let opened;
    try {
      opened = saved ? await peer.request('thread/resume', { threadId: saved, cwd: this.config.cwd, ...policy }, OPEN_MS)
        : await peer.request('thread/start', { cwd: this.config.cwd, ...policy }, OPEN_MS);
    } catch (error) {
      if (signInNeeded(error)) { this.authRequired = true; this.#updateState(); return; }
      throw new Error(saved ? `Codex could not reopen this conversation: ${error.message}` : `Codex could not start a conversation: ${error.message}`);
    }
    const threadId = opened?.thread?.id;
    if (!text(threadId)) throw new Error('Codex did not return a conversation ID.');
    if (!saved) tr.bind({ threadId });
    this.threadId = threadId;
    const kept = tr.settings ?? {};
    this.model = (this.models.some(m => m.id === kept.model) ? kept.model : null) ?? (this.models.some(m => m.id === opened.model) ? opened.model : this.models[0]?.id ?? opened.model ?? null);
    this.effort = kept.effort ?? effortId(opened.reasoningEffort) ?? null;
    this.speed = kept.speed ?? null;
    this.#updateState();
  }
  #setConfig(id, value) {
    if (this.turn) throw new Error('Wait for Codex to finish, then change this setting.');
    const option = this.#options().find(o => o.id === id);
    if (!option || !option.options.some(o => o.value === value)) throw new Error('Codex does not offer that choice.');
    if (id === 'model') { this.model = value; this.effort = null; } else if (id === 'speed') this.speed = value === 'standard' ? null : value; else this.effort = value;
    // Kept with the conversation: reopened later, it continues with the same model, effort and speed.
    try { this.transcript.append([{ type: 'custom', customType: SETTINGS, data: { model: this.model, effort: this.effort, speed: this.speed } }]); } catch { /* until the conversation is reopened */ }
    this.#updateState();
    return this.#state();
  }

  async #prompt(message, images) {
    await this.#ensureReady();
    if (this.authRequired) throw new Error('Sign in to Codex to continue.');
    const input = [...(message ? [{ type: 'text', text: message, text_elements: [] }] : []), ...images.map(({ mimeType, data }) => ({ type: 'image', url: `data:${mimeType};base64,${data}` }))];
    // A message sent while Codex works joins the running turn before its next model call.
    if (this.turn?.id) {
      await this.peer.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turn.id, input });
      const user = { role: 'user', content: [...(message ? [{ type: 'text', text: message }] : []), ...images.map(({ mimeType, data }) => ({ type: 'image', mimeType, data }))], timestamp: Date.now() };
      this.transcript.append([{ type: 'message', message: user }]);
      this.#message(user);
      return { disposition: 'queued' };
    }
    if (this.turn) throw new Error('Codex is starting a turn. Try again in a moment.');
    const user = { role: 'user', content: [...(message ? [{ type: 'text', text: message }] : []), ...images.map(({ mimeType, data }) => ({ type: 'image', mimeType, data }))], timestamp: Date.now() };
    this.transcript.append([{ type: 'message', message: user }]);
    const options = this.#options(), effort = options.find(o => o.id === 'effort')?.currentValue;
    const speed = options.find(o => o.id === 'speed')?.currentValue;
    const turn = { startedAt: Math.max(Date.now(), user.timestamp + 1), items: new Map(), content: [], tools: new Map(), results: [], model: this.model, usage: null, text: message };
    turn.done = new Promise(resolve => { turn.finish = resolve; });
    this.turn = turn;
    this.write({ type: 'agent_start' });
    this.#message(user);
    this.write({ type: 'message_start', message: this.#assistant(turn, []) });
    try {
      const started = await this.peer.request('turn/start', { threadId: this.threadId, input, ...(this.model ? { model: this.model } : {}), ...(effort ? { effort } : {}),
        // Every turn says which tier it wants: null puts the thread back on standard speed.
        serviceTier: speed && speed !== 'standard' ? speed : null }, OPEN_MS);
      turn.id ??= started?.turn?.id;
    } catch (error) {
      if (signInNeeded(error)) { this.authRequired = true; this.#updateState(); }
      this.#finishTurn(turn, 'error', signInNeeded(error) ? 'Sign in to Codex to continue.' : error.message);
    }
    return { disposition: 'started' };
  }
  // Codex summarizes the thread itself; the conversation shows where that happened.
  async #compact() {
    await this.#ensureReady();
    if (this.authRequired) throw new Error('Sign in to Codex to continue.');
    if (this.turn) throw new Error('Wait for Codex to finish, then compact.');
    const before = this.contextUsage?.tokens;
    const compaction = {};
    compaction.done = new Promise(resolve => { compaction.finish = resolve; });
    this.compaction = compaction;
    this.write({ type: 'compaction_start', reason: 'manual' });
    let errorMessage;
    try {
      await this.peer.request('thread/compact/start', { threadId: this.threadId }, OPEN_MS);
      if (await within(compaction.done, 180000, TIMED_OUT) === TIMED_OUT) errorMessage = 'Codex did not finish compacting in time.';
      else if (typeof compaction.error === 'string') errorMessage = compaction.error;
    } catch (error) { errorMessage = error.message; }
    this.compaction = null;
    if (!errorMessage) {
      try { this.transcript.append([{ type: 'compaction', summary: 'Codex summarized the earlier conversation to free up context. The summary itself stays with Codex.', ...(Number.isFinite(before) ? { tokensBefore: before } : {}) }]); }
      catch { /* shown until the conversation is reopened */ }
    }
    this.write({ type: 'compaction_end', reason: 'manual', aborted: false, ...(errorMessage ? { errorMessage } : {}) });
    if (errorMessage) throw new Error(errorMessage);
    return {};
  }
  #assistant(turn, content) { return { role: 'assistant', content, provider: ENGINE, api: 'codex-app-server', ...(turn.model ? { model: turn.model } : {}), timestamp: turn.startedAt }; }
  #message(message) { this.write({ type: 'message_start', message }); this.write({ type: 'message_end', message }); }
  #delta(fields) { this.write({ type: 'message_update', assistantMessageEvent: fields }); }
  #endBlock(turn) {
    if (turn.blockIndex == null) return;
    const index = turn.blockIndex, block = turn.content[index];
    this.#delta({ type: `${block.type}_end`, contentIndex: index, content: block[block.type] });
    turn.blockIndex = null; turn.blockItem = null;
  }
  #chunk(turn, type, itemId, delta) {
    if (!text(delta)) return;
    if (turn.blockIndex == null || turn.content[turn.blockIndex].type !== type || turn.blockItem !== itemId) {
      this.#endBlock(turn);
      turn.blockIndex = turn.content.push({ type, [type]: '' }) - 1; turn.blockItem = itemId;
      this.#delta({ type: `${type}_start`, contentIndex: turn.blockIndex });
    }
    turn.content[turn.blockIndex][type] += delta;
    this.#delta({ type: `${type}_delta`, contentIndex: turn.blockIndex, delta });
    (turn.streamed ??= new Set()).add(itemId);
  }
  // A Codex item that is an action becomes the tool calls the conversation already knows how to show: a
  // command Codex recognises as reading, listing or searching shows as that; a patch is one edit per file.
  #toolsOf(item) {
    const cwd = this.config.cwd;
    if (item.type === 'commandExecution') {
      const command = shellCommand(item.command);
      const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
      const only = actions.length === 1 ? actions[0] : null;
      if (only?.type === 'read' && text(only.path)) return [{ name: 'read', arguments: { path: insideFolder(cwd, only.path), command } }];
      if (only?.type === 'listFiles') return [{ name: 'ls', arguments: { path: insideFolder(cwd, only.path) || '.', command } }];
      if (only?.type === 'search' && text(only.query)) return [{ name: 'grep', arguments: { pattern: only.query, ...(text(only.path) ? { path: insideFolder(cwd, only.path) } : {}), command } }];
      return [{ name: 'bash', arguments: { command: clip(command, 8000) } }];
    }
    if (item.type === 'fileChange') {
      return (Array.isArray(item.changes) ? item.changes : []).filter(change => text(change?.path)).map(change => {
        const kind = typeof change.kind === 'string' ? change.kind : change.kind?.type;
        const path = insideFolder(cwd, change.kind?.move_path ?? change.kind?.movePath ?? change.path);
        if (kind === 'add') return { name: 'write', arguments: { path, content: addedContent(change.diff) }, diff: change.diff };
        if (kind === 'delete') return { name: 'edit', arguments: { path, edits: [{ oldText: String(change.diff ?? ''), newText: '' }], description: 'Deleted the file' }, diff: change.diff };
        return { name: 'edit', arguments: { path, edits: editsOfDiff(change.diff) }, diff: change.diff };
      });
    }
    if (item.type === 'mcpToolCall') return [{ name: `mcp__${item.server}__${item.tool}`, arguments: item.arguments && typeof item.arguments === 'object' ? item.arguments : {} }];
    if (item.type === 'webSearch') return [{ name: 'WebSearch', arguments: { query: item.query ?? '' } }];
    // An agent Codex starts of its own (its spawn-agent tool) shows as a task, as Claude Code's agents do.
    if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent') {
      const prompt = typeof item.prompt === 'string' ? item.prompt : '';
      return [{ name: 'Task', arguments: { description: prompt.split('\n')[0].slice(0, 120) || 'Agent', prompt, subagent_type: 'Agent', ...(text(item.model) ? { model: item.model } : {}) } }];
    }
    return [];
  }
  // Codex reports an agent's state with each of its agent tools (spawn, wait, close…), keyed by the agent's
  // thread. The task stays open from the spawn until one of them says the agent has ended.
  #agentStates(turn, item) {
    const ended = { completed: false, shutdown: false, errored: true, interrupted: true, notFound: true };
    for (const [thread, state] of Object.entries(item.agentsStates ?? {})) {
      const tool = turn.agents?.get(thread);
      if (!tool || tool.message || !(state?.status in ended)) continue;
      this.#toolEnd(tool, ended[state.status], clip(state.message ?? '') || (ended[state.status] ? `The agent ended: ${state.status}.` : 'The agent finished.'));
    }
  }
  #itemStarted(turn, item) {
    if (turn.tools.has(item.id)) return;
    const shapes = this.#toolsOf(item);
    if (!shapes.length) return;
    this.#endBlock(turn);
    turn.tools.set(item.id, shapes.map(({ diff, ...shape }) => {
      const call = { type: 'toolCall', id: randomUUID(), ...shape };
      const tool = { call, index: turn.content.push(call) - 1, start: Date.now(), output: '', diff };
      this.#delta({ type: 'toolcall_start', contentIndex: tool.index, id: call.id, toolName: call.name });
      this.#delta({ type: 'toolcall_end', contentIndex: tool.index, toolCall: call });
      this.write({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments });
      return tool;
    }));
  }
  // Codex can refine a patch after announcing it: keep each file's step (and its diff) current.
  #patchUpdated(turn, item) {
    const tools = turn.tools.get(item.id);
    if (!tools) { this.#itemStarted(turn, item); return; }
    const shapes = this.#toolsOf(item);
    if (shapes.length !== tools.length) return;
    shapes.forEach(({ diff, ...shape }, i) => {
      const tool = tools[i];
      if (tool.message || JSON.stringify(shape.arguments) === JSON.stringify(tool.call.arguments)) return;
      Object.assign(tool.call, shape); tool.diff = diff;
      this.#delta({ type: 'toolcall_end', contentIndex: tool.index, toolCall: tool.call });
    });
  }
  #itemCompleted(turn, item) {
    if (item.type === 'agentMessage' && !turn.streamed?.has(item.id)) this.#chunk(turn, 'text', item.id, item.text);
    if (item.type === 'reasoning' && !turn.streamed?.has(item.id)) this.#chunk(turn, 'thinking', item.id, [...(item.summary ?? []), ...(item.content ?? [])].join('\n\n'));
    if (item.type === 'agentMessage' || item.type === 'reasoning') { if (turn.blockItem === item.id) this.#endBlock(turn); return; }
    if (item.type === 'fileChange') this.#patchUpdated(turn, item); else if (!turn.tools.has(item.id)) this.#itemStarted(turn, item);
    const declined = item.status === 'declined';
    if (item.type === 'collabAgentToolCall') {
      const [tool] = turn.tools.get(item.id) ?? [];
      if (tool && !tool.message) {
        if (item.status === 'failed' || item.status === 'interrupted' || !item.receiverThreadIds?.length) this.#toolEnd(tool, true, 'Codex could not start the agent.');
        else for (const thread of item.receiverThreadIds) (turn.agents ??= new Map()).set(thread, tool);
      }
      this.#agentStates(turn, item);
      return;
    }
    for (const tool of turn.tools.get(item.id) ?? []) {
      if (tool.message) continue;
      if (item.type === 'commandExecution') {
        // A search that finds nothing exits 1: an answer, not a failure.
        const nothingFound = item.exitCode === 1 && !declined && (tool.call.name === 'grep' || SEARCH_COMMAND.test(shellCommand(item.command)));
        const failed = !nothingFound && (declined || item.status === 'failed' || (Number.isInteger(item.exitCode) && item.exitCode !== 0));
        this.#toolEnd(tool, failed, clip(item.aggregatedOutput ?? tool.output) || (declined ? 'Command declined.' : nothingFound ? 'No matches.' : failed ? `Exit code ${item.exitCode ?? '?'}` : 'Command completed.'));
      } else if (item.type === 'fileChange') {
        const failed = declined || item.status === 'failed';
        this.#toolEnd(tool, failed, declined ? 'Change declined.' : item.status === 'failed' ? 'Codex could not apply this change.' : clip(tool.diff) || 'File changed.');
      } else {
        const failed = declined || item.status === 'failed';
        this.#toolEnd(tool, failed, declined ? 'Declined.' : failed ? 'Tool failed.' : 'Tool completed.');
      }
    }
  }
  #toolEnd(tool, isError, shown) {
    const content = [{ type: 'text', text: shown }], details = { engine: ENGINE };
    tool.message = { role: 'toolResult', toolCallId: tool.call.id, toolName: tool.call.name, content, details, isError, timestamp: Date.now() };
    this.write({ type: 'tool_execution_end', toolCallId: tool.call.id, toolName: tool.call.name, result: { content, details }, isError, durationMs: Date.now() - tool.start });
  }
  #finishTurn(turn, stopReason, errorMessage) {
    if (this.turn !== turn) return;
    this.#cancelPermissions();
    this.#endBlock(turn);
    const agentTools = new Set(turn.agents?.values());
    for (const tool of [...turn.tools.values()].flat()) if (!tool.message) this.#toolEnd(tool, stopReason === 'aborted' || !agentTools.has(tool), stopReason === 'aborted' ? 'Interrupted.' : agentTools.has(tool) ? 'The agent was still running when this turn ended.' : 'Codex did not report the result.');
    const u = turn.usage;
    const usage = u ? { input: Math.max(0, (u.inputTokens ?? 0) - (u.cachedInputTokens ?? 0)), output: u.outputTokens ?? 0, cacheRead: u.cachedInputTokens ?? 0, cacheWrite: u.cacheWriteInputTokens ?? 0,
      reasoning: u.reasoningOutputTokens ?? 0, totalTokens: u.totalTokens ?? 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } : undefined;
    let message = { ...this.#assistant(turn, turn.content), stopReason, ...(usage ? { usage } : {}), durationMs: Math.max(1, Date.now() - turn.startedAt), ...(errorMessage ? { errorMessage } : {}) };
    const results = [...turn.tools.values()].flat().map(t => t.message);
    try { this.transcript.append([message, ...results].map(message => ({ type: 'message', message }))); }
    catch { message = { ...message, stopReason: 'error', errorMessage: 'Could not save this turn to the Codex transcript.' }; }
    this.turn = null;
    this.write({ type: 'message_end', message });
    for (const result of results) this.#message(result);
    this.write({ type: 'agent_end' });
    this.write({ type: 'agent_settled' });
    turn.finish(true);
    // The first reply of a new conversation: ask Codex for its title.
    if (stopReason === 'stop' && text(turn.text) && !turn.text.startsWith('/') && this.transcript.entries.filter(e => e.type === 'message' && e.message?.role === 'user').length === 1) void this.#nameThread(turn.text);
  }
  async #nameThread(message) {
    const peer = this.peer, threadId = this.threadId;
    if (!peer || peer.closed || !threadId) return;
    let side = null;
    try {
      const opened = await peer.request('thread/start', { cwd: this.config.cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, developerInstructions: TITLE_PROMPT }, OPEN_MS);
      if (!text(opened?.thread?.id)) return;
      side = { threadId: opened.thread.id, reply: '' };
      const done = new Promise(resolve => { side.done = resolve; });
      this.sides.set(side.threadId, side);
      const efforts = (this.models.find(m => m.id === this.model)?.supportedReasoningEfforts ?? []).map(effortId).filter(text);
      await peer.request('turn/start', { threadId: side.threadId, input: [{ type: 'text', text: clip(message, 4000), text_elements: [] }],
        ...(this.model ? { model: this.model } : {}), ...(efforts[0] ? { effort: efforts[0] } : {}), outputSchema: TITLE_SCHEMA }, OPEN_MS);
      if (await within(done, TITLE_MS, TIMED_OUT) !== true) return;
      const title = titleOf(side.reply);
      if (!title || this.closed) return;
      this.#title(title);
      // The user's own Codex history (the TUI, `codex resume`) shows the same name.
      peer.request('thread/name/set', { threadId, name: title }, CONTROL_MS).catch(() => {});
    } catch { /* a conversation without a generated title keeps its first words */ }
    finally { if (side) this.sides.delete(side.threadId); }
  }
  // The desktop takes a title from the `iris-title` status, unless the conversation was renamed there.
  #title(title) { this.write({ type: 'extension_ui_request', id: randomUUID(), method: 'setStatus', statusKey: 'iris-title', statusText: title }); }

  #notification(peer, method, params) {
    if (peer !== this.peer || this.closed) return;
    const side = text(params?.threadId) ? this.sides.get(params.threadId) : null;
    if (side) {
      if (method === 'item/completed' && params.item?.type === 'agentMessage' && typeof params.item.text === 'string') side.reply = params.item.text;
      if (method === 'turn/completed') side.done(params.turn?.status === 'completed');
      return;
    }
    // Renamed elsewhere (another Codex client): the conversation follows, unless it was renamed here.
    if (method === 'thread/name/updated' && params.threadId === this.threadId && text(params.threadName)) { this.#title(titleOf(params.threadName)); return; }
    if (method === 'account/rateLimits/updated') {
      const limits = accountOf({ account: {} }, params).limits;
      if (this.account && limits) { this.account = { ...this.account, limits }; this.#updateState(); }
      return;
    }
    if (method === 'thread/tokenUsage/updated' && params.threadId === this.threadId) {
      const usage = params.tokenUsage;
      if (Number.isFinite(usage?.last?.totalTokens) && Number.isFinite(usage.modelContextWindow) && usage.modelContextWindow > 0) {
        this.contextUsage = { tokens: usage.last.totalTokens, contextWindow: usage.modelContextWindow, percent: 100 * usage.last.totalTokens / usage.modelContextWindow };
      }
      // A turn's usage is the thread total now minus the total before the turn's first model call.
      if (this.turn && usage?.total) {
        this.turn.usageBase ??= Object.fromEntries(Object.entries(usage.total).map(([key, value]) => [key, value - (usage.last?.[key] ?? 0)]));
        this.turn.usageTotal = usage.total;
      }
      this.#updateState();
      return;
    }
    // A compaction runs as a turn of its own on the Codex side.
    if (this.compaction && params.threadId === this.threadId && !this.turn) {
      if (method === 'error' && !params.willRetry) this.compaction.error = params.error?.message ?? 'Codex could not compact this conversation.';
      if (method === 'thread/compacted') this.compaction.compacted = true;
      if (method === 'turn/completed') { if (params.turn?.status === 'failed') this.compaction.error ??= params.turn.error?.message ?? 'Codex could not compact this conversation.'; this.compaction.finish(); }
      return;
    }
    const turn = this.turn;
    if (!turn || params.threadId !== this.threadId) return;
    switch (method) {
      case 'turn/started': turn.id ??= params.turn?.id; break;
      case 'item/started': if (params.item) this.#itemStarted(turn, params.item); break;
      case 'item/agentMessage/delta': this.#chunk(turn, 'text', params.itemId, params.delta); break;
      case 'item/reasoning/summaryTextDelta': case 'item/reasoning/textDelta': this.#chunk(turn, 'thinking', params.itemId, params.delta); break;
      case 'item/commandExecution/outputDelta': {
        const tool = turn.tools.get(params.itemId)?.[0];
        if (tool && !tool.message && text(params.delta)) {
          tool.output = (tool.output + params.delta).slice(-64000);
          this.write({ type: 'tool_execution_update', toolCallId: tool.call.id, toolName: tool.call.name, args: tool.call.arguments, partialResult: { content: [{ type: 'text', text: clip(tool.output) }], details: { engine: ENGINE } } });
        }
        break;
      }
      case 'item/completed': if (params.item) this.#itemCompleted(turn, params.item); break;
      case 'item/fileChange/patchUpdated': if (text(params.itemId) && Array.isArray(params.changes)) this.#patchUpdated(turn, { type: 'fileChange', id: params.itemId, changes: params.changes }); break;
      case 'error': if (!params.willRetry && text(params.error?.message)) turn.error = params.error.message; break;
      case 'turn/completed': {
        const done = params.turn ?? {};
        if (turn.usageTotal) turn.usage = Object.fromEntries(Object.entries(turn.usageTotal).map(([key, value]) => [key, Math.max(0, value - (turn.usageBase?.[key] ?? 0))]));
        const reason = done.status === 'completed' ? 'stop' : done.status === 'interrupted' ? 'aborted' : 'error';
        this.#finishTurn(turn, reason, reason === 'error' ? done.error?.message ?? turn.error ?? 'Codex could not complete this turn.' : null);
        break;
      }
    }
  }
  // Codex asks before running a command or changing files (unless permissions are bypassed).
  #request(peer, id, method, params) {
    const turn = this.turn;
    const command = method === 'item/commandExecution/requestApproval', change = method === 'item/fileChange/requestApproval';
    if (!command && !change) { peer.send({ id, error: { code: -32601, message: `Iris does not handle ${method}.` } }); return; }
    if (peer !== this.peer || !turn || params.threadId !== this.threadId || this.permissions.size >= 8) { peer.send({ id, result: { decision: 'cancel' } }); return; }
    const uiId = randomUUID();
    const options = new Map([['Allow once', 'accept'], ['Allow for this conversation', 'acceptForSession'], ['Reject', 'decline']]);
    this.permissions.set(uiId, { peer, id, options });
    const tools = turn.tools.get(params.itemId) ?? [];
    this.write({ type: 'extension_ui_request', id: uiId, method: 'select', header: 'Codex permission',
      title: command ? 'Run this command?' : 'Apply these file changes?',
      message: [command ? shellCommand(params.command ?? tools[0]?.call.arguments.command) : tools.map(tool => tool.call.arguments.path).filter(Boolean).join('\n'), params.reason, command && text(params.cwd) ? `in ${params.cwd}` : null].filter(Boolean).join('\n'),
      options: [...options.keys()], optionDetails: [{ label: 'Allow once', description: 'Allow once' }, { label: 'Allow for this conversation', description: 'Allow and remember' }, { label: 'Reject', description: 'Reject once' }] });
  }
  #answer(r) {
    const entry = this.permissions.get(r.id);
    if (!entry) return;
    this.permissions.delete(r.id);
    entry.peer.send({ id: entry.id, result: { decision: (!r.cancelled && entry.options.get(r.value)) || 'cancel' } });
    this.write({ type: 'extension_ui_dismiss', id: r.id });
  }
  #cancelPermissions() { for (const id of [...this.permissions.keys()]) this.#answer({ id, cancelled: true }); }

  async #abort() {
    const turn = this.turn;
    if (!turn) return {};
    turn.cancelled = true;
    this.#cancelPermissions();
    if (turn.id && this.peer && !this.peer.closed) await this.peer.request('turn/interrupt', { threadId: this.threadId, turnId: turn.id }, ABORT_MS).catch(() => {});
    if (await within(turn.done, ABORT_MS, TIMED_OUT) === TIMED_OUT) {
      // Codex did not confirm in time: end the turn here, and start from a fresh connection next time.
      this.#finishTurn(turn, 'aborted', null);
      this.peer?.close();
    }
    return {};
  }
  #disconnected(peer, reason) {
    if (peer !== this.peer) return;
    this.peer = null; this.threadId = null;
    if (this.turn) this.#finishTurn(this.turn, this.turn.cancelled ? 'aborted' : 'error', this.turn.cancelled ? null : reason?.message ?? 'Codex stopped.');
  }
  async close() {
    if (this.closed) return;
    if (this.turn) this.#finishTurn(this.turn, 'aborted', null);
    this.closed = true;
    this.peer?.close();
    this.transcript?.close();
  }
}

// The boot record arrives on an inherited pipe (see iris-antigravity.mjs).
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
if (isMain && ['--account-check', '--account-logout'].includes(process.argv[2])) {
  try { output(process.stdout, { cliAccountStatus: await account({ bin: process.argv[3], cwd: process.cwd(), version: process.argv[4], logout: process.argv[2] === '--account-logout', home: process.argv[5] || undefined }) }); }
  catch (error) { output(process.stdout, { cliAccountError: error.message }); }
  process.exit(0);
} else if (isMain && process.argv[2] === '--account-login') {
  // One line with the page to open, then the account once the browser is done. Closing stdin cancels.
  const cancelled = new Promise(resolve => { process.stdin.on('end', resolve).on('close', resolve).on('error', resolve); for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, resolve); });
  process.stdin.resume();
  try {
    const result = await signIn({ bin: process.argv[3], cwd: process.cwd(), version: process.argv[4], home: process.argv[5] || undefined, cancelled,
      onUrl: url => output(process.stdout, { cliSignIn: { url } }) });
    output(process.stdout, { cliAccountStatus: result });
  } catch (error) { output(process.stdout, { cliAccountError: error.message }); }
  process.exit(0);
} else if (isMain) {
  let boot;
  try { boot = JSON.parse(takeBoot() ?? '{}'); } catch { boot = {}; }
  const adapter = new CodexAdapter({ boot, write: value => { if (!process.stdout.destroyed) output(process.stdout, value); } });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    process.stdin.destroy();
    adapter.close().then(() => process.stdout.end(), () => { process.exitCode = 1; process.stdout.end(); });
  };
  readLines(process.stdin, line => { try { void adapter.handle(JSON.parse(line)); } catch { /* malformed parent input */ } }, shutdown);
  for (const event of ['end', 'close', 'error']) process.stdin.on(event, shutdown);
  process.stdout.on('error', shutdown);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, shutdown);
}
