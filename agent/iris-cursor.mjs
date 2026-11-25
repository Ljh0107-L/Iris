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

// Whether the CLI is signed in, as whom and on which plan, and (once it is) the menus it offers.
export async function check(bin) {
  if (!isAbsolute(bin ?? '')) throw new Error('Missing Cursor CLI.');
  const status = json((await run(bin, ['status', '--format', 'json'])).out);
  if (!status) throw new Error('Cursor did not say whether it is signed in.');
  const signedIn = status.isAuthenticated === true;
  if (!signedIn) return { signedIn: false, canSignIn: true };
  const about = json((await run(bin, ['about', '--format', 'json']).catch(() => ({ out: '' }))).out) ?? {};
  const identity = [status.userInfo?.email, about.userEmail].find(text) ?? null;
  const plan = text(about.subscriptionTier) ? about.subscriptionTier.trim() : null;
  let options = [];
  try { options = await modelMenus(bin); } catch { /* the menus appear with the first conversation */ }
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

let isMain = false;
try { isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { /* imported */ }
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
