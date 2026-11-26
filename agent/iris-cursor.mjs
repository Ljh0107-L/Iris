#!/usr/bin/env node
// Cursor engine: Pi RPC ⇄ the official Cursor CLI's ACP server (`cursor-agent acp`). It speaks the same
// protocol as Antigravity's, so a conversation runs the same adapter (iris-antigravity.mjs) with Cursor's
// profile: its own sign-in (taken up with authenticate), its own transcripts and its own flags.
//
// Settings asks the CLI itself, with its own commands: `status` says whether it is signed in, `about` as whom
// and on which plan, ACP's cursor/list_available_models what the account can choose from (each model with its
// own settings), `login` signs in (the page it names is opened by Iris) and `logout` signs out. None of these
// opens a browser from here. All of them use Iris's own Cursor directory (CURSOR_CONFIG_DIR), as its
// conversations do.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main, PROFILES, selectConfig } from './iris-antigravity.mjs';

const P = PROFILES.cursor;
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
const text = value => typeof value === 'string' && value.trim().length > 0;
// The variables the CLI needs, no more (as the conversation's CLI gets).
const KEEP = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'XDG_CONFIG_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'];
let home = null; // Iris's Cursor directory, when given
const cliEnv = () => ({ ...Object.fromEntries(KEEP.filter(key => Object.hasOwn(process.env, key)).map(key => [key, process.env[key]])), ...P.env, ...P.homeEnv(home) });

function run(bin, args, { timeout = 30000, onLine, cancellable = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: process.cwd(), env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', pending = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Cursor did not answer in time (${args[0]}).`)); }, timeout);
    const lines = chunk => { if (!onLine) return; pending += chunk; for (let i; (i = pending.indexOf('\n')) >= 0;) { onLine(pending.slice(0, i)); pending = pending.slice(i + 1); } };
    child.stdout.on('data', d => { out += d; lines(String(d)); });
    child.stderr.on('data', d => { err += d; lines(String(d)); });
    child.on('error', error => { clearTimeout(timer); reject(new Error(`The Cursor CLI could not be started: ${error.message}`)); });
    child.on('close', code => { clearTimeout(timer); if (pending) onLine?.(pending); resolve({ code, out, err }); });
    // Settings gave up waiting (a sign-in it cancelled): it closes this process's input.
    if (cancellable) { process.stdin.once('end', () => child.kill('SIGTERM')); process.stdin.resume(); }
  });
}
const json = printed => { try { return JSON.parse(printed.slice(printed.indexOf('{'))); } catch { return null; } };

// What the account can choose from, as the menus of a new conversation: the model, each model with its own
// settings (sub), and the settings of the one chosen last. Asked over ACP (authenticate, then
// cursor/list_available_models); the choice made last is the one in Iris's Cursor directory.
async function modelMenus(bin) {
  const child = spawn(bin, ['acp'], { cwd: process.cwd(), env: cliEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  let next = 0, buffer = '';
  child.stdout.on('data', data => {
    buffer += data;
    for (let i; (i = buffer.indexOf('\n')) >= 0;) {
      let record; try { record = JSON.parse(buffer.slice(0, i)); } catch { record = null; }
      buffer = buffer.slice(i + 1);
      if (record?.method && record.id != null) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: record.id, error: { code: -32601, message: 'Not supported' } }) + '\n');
      else if (record && waiting.has(record.id)) { waiting.get(record.id)(record); waiting.delete(record.id); }
    }
  });
  const ask = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Cursor did not answer in time (${method}).`)); }, 45000);
    waiting.set(id, record => { clearTimeout(timer); record.error ? reject(new Error(record.error.message ?? method)) : resolve(record.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await ask('initialize', { protocolVersion: 1, clientCapabilities: P.clientCapabilities, clientInfo: { name: 'iris', title: 'Iris', version: process.argv[4] ?? '0.0.0' } });
    await ask('authenticate', { methodId: P.authMethod });
    const list = await ask(P.listModels, {});
    return menusOf(list?.models, selectedModel());
  } finally {
    // Cursor's ACP server does not stop when its input ends: it is stopped, and this check ends only once it has.
    child.stdin.end();
    const exited = new Promise(resolve => { if (child.exitCode != null || child.signalCode != null) resolve(); else child.once('exit', resolve); });
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
    await exited; clearTimeout(timer);
  }
}
// The model chosen last in Iris's Cursor directory (its cli-config.json), with its settings.
function selectedModel() {
  try {
    const config = JSON.parse(readFileSync(join(home ?? join(process.env.HOME ?? '', '.cursor'), 'cli-config.json'), 'utf8'));
    const chosen = config?.selectedModel;
    return text(chosen?.modelId) ? { id: chosen.modelId, parameters: new Map((Array.isArray(chosen.parameters) ? chosen.parameters : []).filter(p => text(p?.id) && typeof p.value === 'string').map(p => [p.id, p.value])) } : null;
  } catch { return null; }
}
export function menusOf(models, selected = null) {
  const choices = (Array.isArray(models) ? models : []).filter(m => text(m?.value) && text(m?.name)).slice(0, 200)
    .map(m => ({ value: m.value, name: m.name, sub: selectConfig(m.configOptions) }));
  const [model] = selectConfig([{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: choices.some(c => c.value === selected?.id) ? selected.id : choices[0]?.value ?? '', options: choices }]);
  if (!model?.options.length) return [];
  model.options = model.options.map(choice => ({ ...choice, sub: choices.find(c => c.value === choice.value)?.sub ?? [] }));
  const current = model.options.find(choice => choice.value === model.currentValue);
  const settings = (current?.sub ?? []).map(option => {
    const value = selected?.id === current.value ? selected.parameters.get(option.id) : null;
    return value && option.options.some(choice => choice.value === value) ? { ...option, currentValue: value } : option;
  });
  return [model, ...settings];
}

// Whether the CLI is signed in, as whom and on which plan, and (when asked) the menus it offers.
export async function check(bin) {
  if (!isAbsolute(bin ?? '')) throw new Error('Missing Cursor CLI.');
  // Each of these starts the CLI (two to three seconds): they run side by side. The models are asked for only
  // when Iris has none for this machine or is told to read them again (IRIS_CLI_MENUS_DIR).
  const menus = !!process.env.IRIS_CLI_MENUS_DIR;
  const [statusRun, aboutRun, options] = await Promise.all([
    run(bin, ['status', '--format', 'json']),
    run(bin, ['about', '--format', 'json']).catch(() => ({ out: '' })),
    menus ? modelMenus(bin).catch(() => []) : [],
  ]);
  const status = json(statusRun.out);
  if (!status) throw new Error('Cursor did not say whether it is signed in.');
  const signedIn = status.isAuthenticated === true;
  if (!signedIn) return { signedIn: false, canSignIn: true };
  const about = json(aboutRun.out) ?? {};
  const identity = [status.userInfo?.email, about.userEmail].find(text) ?? null;
  const plan = text(about.subscriptionTier) ? about.subscriptionTier.trim() : null;
  return { signedIn, canSignIn: true, ...(identity ? { identity: identity.slice(0, 200) } : {}), ...(plan ? { plan: plan.slice(0, 60) } : {}),
    ...(options.length ? { options } : {}) };
}

// `login` with NO_OPEN_BROWSER prints the page to open instead of opening it: Settings opens it (and offers
// the link), as for Codex. When the CLI is done, whether it is signed in now.
async function login(bin) {
  let named = false;
  const { code } = await run(bin, ['login'], { timeout: 10 * 60000, cancellable: true, onLine: line => {
    const url = /https:\/\/[^\s"'<>]+/.exec(line.replace(/\u001b\[[0-9;]*m/g, ''))?.[0];
    if (url && !named) { named = true; output({ cliSignIn: { url } }); }
  } });
  if (code !== 0 && !named) throw new Error('Cursor could not start its sign-in.');
  return check(bin);
}

// On an SSH host, Cursor's own requests go out through the Mac Iris runs on. Cursor offers the models of the
// region it is asked from, and a server's region can offer few of them; from the Mac it offers what the Cursor
// app there does. IRIS_CURSOR_EGRESS names a port on this host that the SSH connection carries to Iris's egress
// proxy on the Mac (which lets through Cursor's domains only). The CLI is given a proxy here, in this process,
// that sends Cursor's domains there and everything else as it went before: straight out, or through the host's
// own proxy. (The commands the agent runs inherit the proxy settings, so they pass through it too.) When the
// Mac cannot be reached (Iris is closed, the Mac asleep), Cursor's requests go straight out as well.
export const CURSOR_DOMAINS = /(^|\.)(cursor\.sh|cursor\.com|cursorapi\.com)$/i;
const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
export async function routeThroughMac(env = process.env) {
  const egress = /^127\.0\.0\.1:(\d{1,5})$/.exec(env.IRIS_CURSOR_EGRESS ?? '');
  if (!egress) return null;
  // The host's own proxy, if it has one: the rest goes on through it. One this proxy cannot speak to (HTTPS,
  // SOCKS) is left as it is, and so is Cursor's traffic.
  const before = PROXY_KEYS.map(key => env[key]).find(text);
  let upstream = null;
  if (before) {
    let url; try { url = new URL(before); } catch { return null; }
    if (url.protocol !== 'http:') return null;
    upstream = { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80),
      auth: url.username ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}` : null };
  }
  const noProxy = String(env.NO_PROXY ?? env.no_proxy ?? '').split(/[\s,]+/).map(p => p.replace(/:\d+$/, '').replace(/^\*?\./, '').toLowerCase()).filter(Boolean);
  const bypass = host => noProxy.some(p => p === '*' || host === p || host.endsWith(`.${p}`));
  const mac = { host: '127.0.0.1', port: Number(egress[1]), auth: null };
  // A tunnel to host:port: through a proxy (via) with CONNECT, or straight (via null).
  const open = (via, host, port) => new Promise((resolve, reject) => {
    const socket = net.connect(via ? via.port : port, via ? via.host : host);
    const fail = error => { socket.destroy(); reject(error); };
    socket.on('error', () => {}); // (after the tunnel is handed over, its end is handled there)
    socket.once('error', fail);
    socket.setTimeout(20000, () => fail(new Error('timed out')));
    if (!via) { socket.once('connect', () => { socket.setTimeout(0); socket.off('error', fail); resolve({ socket, rest: null }); }); return; }
    const name = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
    socket.once('connect', () => socket.write(`CONNECT ${name} HTTP/1.1\r\nHost: ${name}\r\n${via.auth ? `Proxy-Authorization: ${via.auth}\r\n` : ''}\r\n`));
    let head = Buffer.alloc(0);
    const read = data => {
      head = Buffer.concat([head, data]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) { if (head.length > 16384) fail(new Error('bad proxy reply')); return; }
      socket.off('data', read);
      if (!/^HTTP\/1\.[01] 2\d\d/.test(head.subarray(0, end).toString('latin1'))) { fail(new Error('refused')); return; }
      socket.setTimeout(0); socket.off('error', fail);
      resolve({ socket, rest: head.subarray(end + 4) });
    };
    socket.on('data', read);
  });
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    // Plain HTTP, never Cursor's: as it went before.
    let url; try { url = new URL(req.url ?? ''); } catch { url = null; }
    if (url?.protocol !== 'http:') { res.writeHead(400).end(); return; }
    const host = url.hostname.replace(/^\[|\]$/g, ''), via = upstream && !bypass(host.toLowerCase()) ? upstream : null;
    const headers = { ...req.headers };
    delete headers['proxy-connection']; delete headers['proxy-authorization'];
    if (via?.auth) headers['proxy-authorization'] = via.auth;
    const out = http.request(via ? { host: via.host, port: via.port, method: req.method, path: req.url, headers }
      : { host, port: Number(url.port || 80), method: req.method, path: `${url.pathname}${url.search}`, headers }, answer => { res.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(res); });
    out.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => { if (!res.writableEnded) out.destroy(); });
    req.pipe(out);
  });
  server.on('connect', async (req, client, head) => {
    sockets.add(client); client.once('close', () => sockets.delete(client));
    client.on('error', () => {});
    const match = /^(\[[0-9a-f:.]+\]|[a-z0-9_.-]+):(\d{1,5})$/i.exec(String(req.url ?? ''));
    if (!match) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const host = match[1].replace(/^\[|\]$/g, '').toLowerCase(), port = Number(match[2]);
    const routes = [...(CURSOR_DOMAINS.test(host) ? [mac] : []), upstream && !bypass(host) ? upstream : null];
    for (const via of routes) {
      let tunnel; try { tunnel = await open(via, host, port); } catch { continue; }
      if (client.destroyed) { tunnel.socket.destroy(); return; }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (tunnel.rest?.length) client.write(tunnel.rest);
      if (head?.length) tunnel.socket.write(head);
      tunnel.socket.on('error', () => client.destroy()); client.on('close', () => tunnel.socket.destroy()); tunnel.socket.on('close', () => client.destroy());
      tunnel.socket.pipe(client); client.pipe(tunnel.socket);
      return;
    }
    client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  const proxy = `http://127.0.0.1:${server.address().port}`;
  for (const key of PROXY_KEYS) env[key] = proxy;
  return { proxy, close: () => new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); }) };
}

let isMain = false;
try { isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { /* imported */ }
if (isMain) await routeThroughMac().catch(() => null);
if (isMain && ['--account-check', '--account-login', '--account-logout'].includes(process.argv[2])) {
  const bin = process.argv[3];
  if (isAbsolute(process.argv[5] ?? '')) { home = process.argv[5]; try { mkdirSync(home, { recursive: true, mode: 0o700 }); } catch { /* the CLI says what is wrong */ } }
  try {
    const result = process.argv[2] === '--account-login' ? await login(bin)
      : process.argv[2] === '--account-logout' ? (await run(bin, ['logout']), await check(bin))
      : await check(bin);
    output({ cliAccountStatus: result });
  } catch (error) { output({ cliAccountError: error.message }); }
  process.exit(0);
} else if (isMain) await main('cursor');
