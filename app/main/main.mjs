import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, powerSaveBlocker, protocol, safeStorage, screen, shell } from 'electron';
import { MIN_SIZE, openingBounds, readWindowState, rememberWindow } from './window-state.mjs';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listEnvironments } from './environments.mjs';
import { listRemoteDir, runSsh } from './remote-setup.mjs';
import { decodeRemoteFilePreview, filePreview, remoteFilePreviewScript } from './file-preview.mjs';
import { downloadLocal, downloadRemote } from './file-download.mjs';
import { gitReview, remoteGitReviewScript, decodeGitReview } from './git-review.mjs';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { shellQuote } from '../../core/transports.mjs';
import { SessionManager } from './session-manager.mjs';
import { Terminals, spawnPty } from './terminals.mjs';
import { readAntigravityUsage, stopUsageReaders } from './antigravity-usage.mjs';
import { Updater } from './updater.mjs';
import { clearSessionUpdate, loadSessionUpdate, planSessionUpdate, restartUpdatedSessions, reviewSessionUpdate, saveSessionUpdate } from './session-update.mjs';
import { Store } from './store.mjs';
import { resolveShellEnv } from './shell-env.mjs';
import { createAttention } from './attention.mjs';
import { isCliEngineId } from './cli-engines.mjs';
// The renderer names the account-backed CLI an action is for; anything else means Antigravity.
const cliEngineOf = engine => isCliEngineId(engine) ? engine : 'antigravity';
import { UsageLedger } from './usage.mjs';
import { stageExtensions } from './extensions.mjs';
import { listCustomModels, resolveProviderBaseUrl } from './custom-providers.mjs';
import { translateText } from './translate.mjs';
import { BUILTIN_PROVIDERS } from './builtin-providers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const piPackage = join(root, 'node_modules/@earendil-works/pi-coding-agent');
const piVersion = JSON.parse(readFileSync(join(piPackage, 'package.json'), 'utf8')).version;

// Pi and the relay run on this app's Electron binary acting as Node. On macOS they use the helper app's
// copy: Pi sets its process title, which makes libuv check the process in with LaunchServices, and the
// main executable would then appear in the Dock as a generic "exec" icon. The helper is a UI element
// (LSUIElement), so it never shows in the Dock.
function nodeBinary() {
  if (process.platform !== 'darwin') return process.execPath;
  const name = basename(process.execPath); // "Iris", or "Electron" in development
  const helper = join(dirname(process.execPath), '../Frameworks', `${name} Helper.app/Contents/MacOS/${name} Helper`);
  return existsSync(helper) ? helper : process.execPath;
}

if (process.env.IRIS_USER_DATA) app.setPath('userData', process.env.IRIS_USER_DATA);
app.setName('Iris');
// One Iris per profile. A second one would write the same conversation list and settings over this one's and
// start a second relay for the same conversations; starting Iris again brings the running one forward.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
else app.on('second-instance', () => showWindow());

// Pages shown in the file pane are served to it under a scheme of their own (see previewUrl): a page then
// loads its styles, scripts and images by relative links, from this Mac or from an SSH host alike.
protocol.registerSchemesAsPrivileged([{ scheme: 'iris-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

let store, manager, window, usage;
const environments = () => listEnvironments({ sshConfig: process.env.IRIS_SSH_CONFIG, customHosts: store?.settings.customHosts ?? [], state: store?.settings.environments ?? {} });

// Resolve and inspect paths on the session's own machine, including remote ~/ paths.
async function targetFilePreview(environmentId, cwd, operation, rel = '', engine) {
  if (!cwd) return operation === 'search' ? { path: '', files: [] } : { path: '', entries: [] };
  const env = manager.env(environmentId);
  if (env.kind === 'local') return filePreview(operation, cwd, rel);
  // Sessions already prepare Node on the host; reuse that runtime instead of parsing
  // ls output or relying on platform-specific shell utilities for binary-safe reads.
  const { node } = await manager.prepare(environmentId, { engine });
  const output = await runSsh(env, remoteFilePreviewScript(node, operation, cwd, rel), { timeout: operation === 'read' ? 60000 : 30000 });
  return decodeRemoteFilePreview(output);
}

// A page in the file pane. Each previewed folder gets an address of its own (iris-preview://<token>/…); the
// token names the machine and the folder, and only files inside that folder are served under it.
const previews = new Map(); // "session\nfolder" -> { token, environmentId, root, engine }
const PREVIEW_TYPES = { html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', map: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
  wasm: 'application/wasm', txt: 'text/plain', md: 'text/plain', csv: 'text/csv', xml: 'application/xml', pdf: 'application/pdf', glb: 'model/gltf-binary', gltf: 'model/gltf+json' };
function previewUrl(id, path) {
  const record = manager.record(id);
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) throw new Error('A page is previewed by its full path.');
  // The conversation's folder when the page is in it (so "../assets" works), else the page's own folder.
  const cwd = String(record.cwd ?? '').replace(/\/+$/, '');
  const root = cwd.startsWith('/') && path.startsWith(`${cwd}/`) ? cwd : path.slice(0, path.lastIndexOf('/')) || '/';
  const key = `${id}\n${root}`;
  if (!previews.has(key)) {
    if (previews.size >= 64) previews.delete(previews.keys().next().value);
    previews.set(key, { token: `p${randomUUID().replaceAll('-', '')}`, environmentId: record.environmentId, root, engine: record.engine });
  }
  const rel = path.slice(root === '/' ? 1 : root.length + 1);
  return `iris-preview://${previews.get(key).token}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}
async function servePreview(request) {
  const headers = { 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  try {
    const url = new URL(request.url);
    const target = [...previews.values()].find(preview => preview.token === url.hostname);
    if (!target) return new Response('This preview is no longer open.', { status: 404, headers });
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const file = await targetFilePreview(target.environmentId, target.root, 'raw', rel, target.engine);
    const type = PREVIEW_TYPES[rel.split('.').pop().toLowerCase()] ?? 'application/octet-stream';
    return new Response(Buffer.from(file.base64, 'base64'), { headers: { ...headers, 'content-type': /^text\/|javascript|json|xml/.test(type) ? `${type}; charset=utf-8` : type } });
  } catch (error) {
    return new Response(String(error?.message ?? error), { status: 404, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
  }
}

async function sessionFilePreview(id, operation, rel = '') {
  const record = manager.record(id);
  return targetFilePreview(record.environmentId, record.cwd, operation, rel, record.engine);
}

// Save a file from the session's machine to this Mac, through a save dialog that starts in Downloads.
async function downloadSessionFile(id, rel) {
  const record = manager.record(id);
  const env = manager.env(record.environmentId);
  const name = String(rel).split('/').filter(Boolean).pop() || 'download';
  let target;
  if (process.env.IRIS_TEST_SAVE_DIR) target = join(process.env.IRIS_TEST_SAVE_DIR, name);
  else {
    const choice = await dialog.showSaveDialog(window, { defaultPath: join(app.getPath('downloads'), name) });
    if (choice.canceled || !choice.filePath) return null;
    target = choice.filePath;
  }
  if (env.kind === 'local') return downloadLocal(record.cwd, rel, target);
  const { node } = await manager.prepare(record.environmentId, { engine: record.engine });
  return downloadRemote(env, node, record.cwd, rel, target);
}

// Pi's compaction trigger is contextTokens > contextWindow - reserveTokens. Equalising
// the reserve with each model's max output makes it exactly "compact when the remaining
// context is smaller than the largest possible reply", instead of the 16K default that
// lets a 1M-context model overflow before compaction.
function syncCompactionReserves() {
  const agentDir = join(app.getPath('userData'), 'agent');
  const path = join(agentDir, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first run */ }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  const overrides = { ...(settings.compaction?.modelOverrides ?? {}) };
  for (const provider of store.settings.providers) {
    for (const model of provider.models ?? []) {
      const maxTokens = Number(model.maxTokens);
      if (!provider.id || !model.id || !Number.isFinite(maxTokens) || maxTokens <= 0) continue;
      const key = `${provider.id}/${model.id}`;
      overrides[key] = { ...(overrides[key] ?? {}), reserveTokens: Math.floor(maxTokens) };
    }
  }
  settings.compaction = { ...(settings.compaction ?? {}), modelOverrides: overrides };
  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
    chmodSync(path, 0o600);
  } catch { /* settings are best effort; Pi keeps its defaults if this cannot be written */ }
}

const TRANSLATION_KEY = 'iris-translation'; // where the translation API's key is kept, beside the providers' keys
function publicSettings() {
  const providers = store.settings.providers.map(p => ({ ...p, hasKey: store.hasKey(p.id) }));
  return { ...store.settings, providers, builtinProviders: BUILTIN_PROVIDERS,
    ...(store.settings.translation ? { translation: { ...store.settings.translation, hasKey: store.hasKey(TRANSLATION_KEY) } } : {}) };
}

const send = (channel, payload) => { if (window && !window.isDestroyed()) window.webContents.send('iris:event', { channel, payload }); };
// A page in the user's browser. Automated runs (isolated test profiles) record what they would open instead:
// a test must never put pages, least of all sign-in pages, in the browser of whoever runs it.
const openInBrowser = url => {
  if (process.env.IRIS_INSECURE_TEST_STORAGE === '1') { (globalThis.__irisOpened ??= []).push(url); return Promise.resolve(); }
  return shell.openExternal(url);
};
const terminals = new Terminals({ send });
let updater = null, installingUpdate = false, updateQuit = false;
const cliUsage = new Map(); // machine -> the last reading of a CLI's quota, and when

// Check for Updates… in the app menu: always ends in a sentence about where things stand, as other Mac
// apps do. The sidebar shows the check and the download while they run.
const appIcon = () => { const icon = nativeImage.createFromPath(join(root, 'dist/renderer/app-icon.png')); return icon.isEmpty() ? {} : { icon }; };
async function checkForUpdatesFromMenu() {
  if (!updater) return;
  const before = updater.status.state;
  if (before === 'downloading') { await dialog.showMessageBox(window, { ...appIcon(), message: 'An update is downloading', detail: `Iris ${updater.status.version} will be ready to install in a moment.` }); return; }
  const status = before === 'ready' || before === 'installing' ? updater.status : await updater.check({ manual: true }).catch(error => ({ state: 'error', message: error.message }));
  if (status.state === 'current') await dialog.showMessageBox(window, { ...appIcon(), message: 'You’re up to date', detail: `Iris ${app.getVersion()} is the latest version.` });
  else if (status.state === 'error') await dialog.showMessageBox(window, { type: 'warning', message: 'Couldn’t check for updates', detail: `${status.message}\n\nCheck your connection and try again.` });
  else if (status.state === 'ready') {
    const { response } = await dialog.showMessageBox(window, { ...appIcon(), message: `Iris ${status.version} is ready to install`, detail: `You have ${app.getVersion()}. Iris restarts to update, and running conversations are restarted afterwards.`,
      buttons: ['Restart to Update', 'Later'], defaultId: 0, cancelId: 1 });
    if (response === 0) await api.installUpdate().catch(error => send('notice', { level: 'error', message: error.message }));
  }
}
let sessionRecovery = null, sessionUpdate = null;
let quitting = false;
const setSessionUpdate = (state, version, restarted = 0, failures = 0) => {
  sessionUpdate = { state, version, restarted, failures };
  send('session-update', sessionUpdate);
};

function recoverUpdatedSessions(plan, prior = []) {
  setSessionUpdate('restarting', plan.version, prior.length);
  const dir = app.getPath('userData');
  manager.updateRestartFailed.clear();
  sessionRecovery = restartUpdatedSessions(manager, plan, { checkpoint: next => saveSessionUpdate(dir, next), cancelled: () => quitting })
    .then(result => {
      if (!quitting) {
        try { clearSessionUpdate(dir); }
        catch (error) { result.failures.push({ environment: 'Iris', message: `Could not clear the restart plan: ${error.message}` }); }
      }
      return { ...result, restarted: [...prior, ...result.restarted] };
    }).catch(error => ({ version: plan.version, restarted: prior, failures: [{ environment: 'Iris', message: error.message }] }))
    .then(result => {
      manager.updateRestartFailed = result.failedIds ?? new Set();
      setSessionUpdate('complete', plan.version, result.restarted.length, result.failures.length);
      return result;
    });
}

const api = {
  async bootstrap() {
    return { settings: publicSettings(), environments: environments(), sessions: manager.list(), sessionUpdate, piVersion, platform: process.platform, home: app.getPath('home'), fullscreen: !!window && !window.isDestroyed() && window.isFullScreen() };
  },
  environments: () => environments(),
  // SSH connections the user works with (Settings → Connections).
  addConnections(ids, engine = store.settings.defaults.engine) {
    for (const id of ids) store.settings.environments[id] = { ...store.settings.environments[id], added: true, enabled: true };
    store.saveSettings();
    if (!['antigravity', 'codex'].includes(engine)) for (const id of ids) manager.prepare(id).catch(() => {});
    return environments();
  },
  addManualConnection({ label, host, port, identityFile }, engine) {
    const clean = String(host ?? '').trim();
    if (!/^([A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$/.test(clean)) throw new Error('Enter a host like user@example.com');
    const id = 'manual-' + (label || clean).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36).slice(-4);
    store.settings.customHosts = [...(store.settings.customHosts ?? []), { id, label: (label || clean).trim(), host: clean, port: port ? Number(port) : undefined, identityFile: identityFile?.trim() || undefined }];
    return api.addConnections([`ssh:${id}`], engine);
  },
  removeConnection(id) {
    const { root, ...rest } = store.settings.environments[id] ?? {};
    store.settings.environments[id] = { ...rest, root, added: false };
    store.settings.customHosts = (store.settings.customHosts ?? []).filter(h => `ssh:${h.id}` !== id);
    store.saveSettings();
    return environments();
  },
  setConnectionEnabled(id, enabled) {
    store.settings.environments[id] = { ...store.settings.environments[id], enabled: !!enabled };
    store.saveSettings();
    return environments();
  },
  prepareEnvironment: (id, force, engine) => manager.prepare(id, { force, engine }).then(facts => ({ ok: true, facts }), error => ({ ok: false, error: error.message })),
  async listDir(environmentId, path) {
    const env = manager.env(environmentId);
    if (env.kind === 'ssh') return listRemoteDir(env, path);
    const { readdirSync } = await import('node:fs');
    const dir = path || app.getPath('home');
    return { path: dir, entries: readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name).sort((a, b) => a.localeCompare(b)) };
  },
  async pickLocalFolder() {
    if (process.env.IRIS_TEST_PICK_FOLDER) return process.env.IRIS_TEST_PICK_FOLDER;
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  },
  catalog: () => manager.catalog(),
  searchMessages: query => manager.searchMessages(query),
  // Models the provider's endpoint offers for this credential.
  async listProviderModels(draft, key) {
    const apiKey = key || store.getKey(draft.id);
    if (!apiKey) throw new Error('Enter the API key first.');
    if (draft.kind === 'builtin') return manager.builtinModels(draft.id, apiKey);
    return listCustomModels(draft, apiKey);
  },
  async saveProvider(provider, key) {
    // Normalize SDK-specific paths, but only rewrite custom Google URLs when model discovery
    // confirms the alternative. A generation-only gateway may not serve /models at all.
    const baseUrl = provider.kind === 'custom' ? await resolveProviderBaseUrl(provider, key || store.getKey(provider.id)) : provider.baseUrl;
    const providers = store.settings.providers;
    const index = providers.findIndex(p => p.id === provider.id);
    const clean = { id: provider.id, name: provider.name, kind: provider.kind, api: provider.api, baseUrl, models: provider.models, headers: provider.headers, enabledModels: provider.enabledModels?.length ? provider.enabledModels : undefined };
    if (index >= 0) providers[index] = clean; else providers.push(clean);
    if (key) store.setKey(provider.id, key);
    store.saveSettings();
    syncCompactionReserves();
    manager.invalidateCatalog();
    manager.providersChanged();
    // Provider reachability may differ: redo host setup now, in the background, not at the next message.
    manager.prepared.clear();
    for (const env of environments().filter(e => e.kind === 'ssh' && e.added && e.enabled)) manager.prepare(env.id).catch(() => {});
    return publicSettings();
  },
  deleteProvider(id) {
    store.settings.providers = store.settings.providers.filter(p => p.id !== id);
    store.setKey(id, null);
    store.saveSettings();
    syncCompactionReserves();
    manager.invalidateCatalog();
    manager.providersChanged();
    return publicSettings();
  },
  updateDefaults(patch) {
    Object.assign(store.settings.defaults, patch); store.saveSettings();
    if (Object.hasOwn(patch ?? {}, 'subagents')) manager.configChanged(); // running Pis apply it before their next prompt
    return publicSettings();
  },
  listSessions: () => manager.list(),
  resumeRemote: async () => manager.resumeRemote({ skip: (await sessionRecovery)?.skipResume }),
  prewarm: draft => manager.prewarm(draft),
  warmSessions: () => [...manager.spares.values()].filter(sp => manager.runtimes.get(sp.id)?.status === 'connected').length,
  createSession: options => manager.create(options),
  openSession: id => manager.ensureStarted(id).then(() => true),
  warmSession: id => manager.warm(id),
  focusSession: id => { manager.focus(id); return true; },
  warmFolder: id => manager.warmFolder(id),
  prompt: (id, text, attachments, options) => manager.prompt(id, text, attachments ?? [], options ?? {}),
  editMessage: (id, ordinal, originalText, text, attachments) => manager.editMessage(id, ordinal, originalText, text, attachments ?? []),
  fork: id => manager.fork(id),
  deleteSession: id => manager.delete(id),
  commands: id => manager.commands(id),
  goal: id => manager.goal(id),
  ultra: id => manager.ultra(id),
  setUltra: (id, on) => manager.setUltra(id, on),
  // Claude Code engine: effort, Ultracode, and the pinned binary on a machine (installed on first use).
  setEffort: (id, level) => manager.setEffort(id, level),
  setUltracode: (id, on) => manager.setUltracode(id, on),
  claudeCodeInfo: () => manager.claudeCodeInfo(),
  cliInfo: (environmentId, engine) => manager.cliInfo(environmentId, cliEngineOf(engine)),
  cliReadiness: (environmentId, engine, account) => manager.cliReadiness(environmentId, cliEngineOf(engine), account),
  cliAccountStatus: (environmentId, action, engine, account) => manager.cliAccountStatus(environmentId, { login: action === true || action === 'login', logout: action === 'logout', engine: cliEngineOf(engine), account }),
  cliAccounts: engine => ({ accounts: manager.cliAccounts(cliEngineOf(engine)), selected: store.settings.cliAccountDefault?.[cliEngineOf(engine)] ?? 'default' }),
  addCliAccount: (engine, name) => manager.addCliAccount(cliEngineOf(engine), name),
  removeCliAccount: (engine, id) => manager.removeCliAccount(cliEngineOf(engine), id),
  antigravityInstall: (environmentId, engine) => manager.antigravityInstall(environmentId, cliEngineOf(engine)),
  cliSetConfig: (id, configId, value) => manager.cliSetConfig(id, configId, value),
  cliOptions: (environmentId, engine, account) => manager.askCliOptions(environmentId, cliEngineOf(engine), account),
  cliSignIn: (environmentId, engine, account) => manager.cliSignIn(environmentId, { engine: cliEngineOf(engine), account }),
  cliSignInCancel: (environmentId, engine, account) => manager.cliSignInCancel(environmentId, { engine: cliEngineOf(engine), account }),
  cliCopySignIn: (environmentId, engine, account) => manager.cliCopySignIn(environmentId, { engine: cliEngineOf(engine), account }),
  cliAccountLast: (environmentId, engine, account) => manager.cliAccountLast(environmentId, cliEngineOf(engine), account),
  cliThreads: (environmentId, engine) => manager.cliThreads(environmentId, cliEngineOf(engine)),
  importCliThread: (environmentId, engine, thread) => manager.importCliThread(environmentId, cliEngineOf(engine), thread),
  cliUsageLast: (environmentId, engine) => cliEngineOf(engine) === 'antigravity' ? store.settings.cliUsage?.[environmentId] ?? null : null,
  // Antigravity's quota on this Mac, read from the CLI's own /usage screen (see antigravity-usage.mjs). It
  // takes some seconds, so a reading is kept for five minutes unless a fresh one is asked for.
  async cliUsage(environmentId, engine, force = false) {
    if (cliEngineOf(engine) !== 'antigravity' || environmentId !== 'local') return null;
    const kept = cliUsage.get(environmentId);
    if (kept && (kept.pending || (!force && Date.now() - kept.at < 5 * 60000))) return kept.promise;
    const entry = { at: Date.now(), pending: true, promise: null };
    entry.promise = (async () => {
      await manager.local.envReady;
      const bin = await manager.locateCli(manager.cliSearch ?? undefined);
      if (!bin) return null;
      // Only for an account that is signed in: started without one, the CLI asks for a sign-in (and opens the
      // browser for it), which reading a quota must never set off.
      const known = manager.cliAccountLast(environmentId, 'antigravity');
      const signedIn = known?.signedIn === true && known.ageMs != null && known.ageMs < 10 * 60000 ? true
        : (await manager.cliAccountStatus(environmentId, { engine: 'antigravity' }).catch(() => null))?.signedIn === true;
      if (!signedIn) return null;
      const cwd = join(app.getPath('userData'), 'cli-menus');
      mkdirSync(cwd, { recursive: true });
      const env = { ...process.env, ...manager.local.extraEnv, TERM: 'xterm-256color' };
      delete env.ELECTRON_RUN_AS_NODE;
      return readAntigravityUsage({ bin, cwd, env, spawnPty });
    })().then(result => { entry.pending = false; entry.at = Date.now(); if (!result) cliUsage.delete(environmentId);
      else { (store.settings.cliUsage ??= {})[environmentId] = result; try { store.saveSettings(); } catch { /* read again next time */ } } // shown at once after a restart
      return result; },
      () => { cliUsage.delete(environmentId); return null; });
    cliUsage.set(environmentId, entry);
    return entry.promise;
  },
  prepareClaudeCode: environmentId => manager.prepareClaude(environmentId).then(layout => ({ ok: true, version: manager.claudeCodeInfo().version, bin: layout.bin }), error => ({ ok: false, error: error.message })),
  agents: id => manager.agents(id),
  jobs: id => manager.jobs(id),
  stopAgent: (id, agentId) => manager.stopAgent(id, agentId),
  stopBackgroundJob: (id, jobId, startedAt) => manager.stopBackgroundJob(id, jobId, startedAt),
  messageAgent: (id, agentId, text) => manager.messageAgent(id, agentId, text),
  // Updates
  updateStatus: () => updater?.status ?? { state: 'idle' },
  // test builds only: show an update state without a real release
  testUpdateStatus: status => { if (process.env.IRIS_INSECURE_TEST_STORAGE === '1') send('update', status); },
  checkForUpdates: () => updater?.check({ manual: true }),
  async installUpdate() {
    // One click installs. Running conversations are restarted afterwards and reported in the sidebar.
    if (installingUpdate || quitting || updater?.status.state !== 'ready') return false;
    installingUpdate = true;
    try {
      return await updater.install({
        prepare: async version => saveSessionUpdate(app.getPath('userData'), await planSessionUpdate(manager, version)),
        onQuit: () => { updateQuit = true; },
      });
    } finally { installingUpdate = false; }
  },
  async showSessionUpdateReport() {
    if (sessionUpdate?.state !== 'complete') {
      await dialog.showMessageBox(window, { message: sessionUpdate?.state === 'restarting' ? 'Conversations are still restarting.' : 'There is no update report for this launch.' });
      return;
    }
    const recovery = sessionRecovery, result = await recovery;
    if (!result) return;
    const action = await reviewSessionUpdate(result, options => dialog.showMessageBox(window, options));
    if (recovery !== sessionRecovery || quitting) return;
    if (action === 'retry') {
      saveSessionUpdate(app.getPath('userData'), result.retryPlan);
      recoverUpdatedSessions(result.retryPlan, result.restarted);
    }
  },
  // The interface has said that some conversations were not restarted: it is said once per start.
  sessionUpdateTold() { if (sessionUpdate?.state === 'complete' && !sessionUpdate.told) sessionUpdate = { ...sessionUpdate, told: true }; },
  appVersion: () => app.getVersion(),
  usageSummary: () => usage.summary(),
  // Terminal panel
  termOpen(id, cols, rows) { const record = manager.record(id); return terminals.open({ env: manager.env(record.environmentId), cwd: record.cwd, cols, rows }); },
  async termOpenCli(environmentId, action, cols, rows, engine, account) {
    const { env, ...command } = await manager.cliTerminal(environmentId, action, cliEngineOf(engine), account);
    return terminals.open({ env, command, cwd: app.getPath('home'), cols, rows });
  },
  termReady: termId => terminals.ready(termId),
  termWrite: (termId, data) => terminals.write(termId, data),
  termResize: (termId, cols, rows) => terminals.resize(termId, cols, rows),
  termClose: termId => terminals.close(termId),
  async pickFiles() {
    if (process.env.IRIS_TEST_PICK_FILES) return process.env.IRIS_TEST_PICK_FILES.split(':');
    const result = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'] });
    return result.canceled ? [] : result.filePaths;
  },
  answer: (id, requestId, payload) => manager.answer(id, requestId, payload),
  abort: id => manager.abort(id),
  setModel: (id, provider, modelId) => manager.setModel(id, provider, modelId),
  setThinking: (id, level) => manager.setThinking(id, level),
  setSpeed: (id, speed) => manager.setSpeed(id, speed),
  messages: id => manager.messages(id),
  historyPage: (id, options) => manager.historyPage(id, options ?? {}),
  clearSubagentHistory: (id, ids) => manager.clearSubagentHistory(id, ids),
  stats: id => manager.stats(id),
  rename: (id, title) => manager.rename(id, title),
  archive: id => manager.archive(id),
  reconnect: id => manager.reconnect(id),
  async gitBranch(id) {
    const record = manager.record(id);
    const env = manager.env(record.environmentId);
    if (env.kind === 'ssh') return runSsh(env, `git -C ${shellQuote(record.cwd)} rev-parse --abbrev-ref HEAD 2>/dev/null || true`, { timeout: 15000 }).then(s => s.trim()).catch(() => '');
    return new Promise(resolve => execFile('git', ['-C', record.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], (error, stdout) => resolve(error ? '' : stdout.trim())));
  },
  async gitReview(id, request = {}) {
    const record = manager.record(id), env = manager.env(record.environmentId);
    if (env.kind === 'local') return gitReview(record.cwd, request);
    const { node } = await manager.prepare(record.environmentId, { engine: record.engine });
    return decodeGitReview(await runSsh(env, remoteGitReviewScript(node, record.cwd, request), { timeout: 120000 }));
  },
  appearance(theme) {
    if (!['light', 'dark', 'system'].includes(theme)) throw new Error('Unknown appearance');
    nativeTheme.themeSource = theme; // 'system' follows macOS, and the renderer's media query with it
    if (window && !window.isDestroyed()) window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#121214' : '#fdfdfd');
    // Kept for the next start: the window is created in this colour before the page can say which it wants,
    // so a dark window on a light system does not open with a white flash.
    if (store.settings.appearance !== theme) { store.settings.appearance = theme; try { store.saveSettings(); } catch { /* asked again at the next start */ } }
  },
  compact: id => manager.compact(id),
  openExternal: url => /^https?:\/\//.test(url) ? openInBrowser(url) : false,
  openPath: path => process.env.IRIS_INSECURE_TEST_STORAGE === '1' ? ((globalThis.__irisOpened ??= []).push(path), '') : shell.openPath(path),
  previewUrl: (id, path) => previewUrl(id, path),
  // Translation of the agent's thinking (the right panel). Off unless turned on in Settings → Translation, where
  // the person gives the API to use for it: its address, key and model. Nothing else is ever asked to translate.
  setTranslation(choice, key) {
    const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
    const apis = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];
    store.settings.translation = { on: choice?.on === true, api: apis.includes(choice?.api) ? choice.api : apis[0], baseUrl: text(choice?.baseUrl, 500), model: text(choice?.model, 200), language: text(choice?.language, 60) || 'Simplified Chinese' };
    if (typeof key === 'string' && key.trim()) store.setKey(TRANSLATION_KEY, key.trim());
    store.saveSettings();
    return publicSettings();
  },
  async translate(text) {
    const choice = store.settings.translation;
    if (!choice?.on) throw new Error('Translation is off. Turn it on in Settings → Translation.');
    if (!choice.baseUrl || !choice.model) throw new Error('Translation needs an address and a model: Settings → Translation.');
    return translateText({ api: choice.api, baseUrl: choice.baseUrl, apiKey: store.getKey(TRANSLATION_KEY), model: choice.model, text, language: choice.language });
  },
  // One sentence through the API as it is filled in (saved or not), so a wrong address or key shows at once.
  async testTranslation(choice, key) {
    return translateText({ api: choice?.api, baseUrl: choice?.baseUrl, apiKey: (typeof key === 'string' && key.trim()) || store.getKey(TRANSLATION_KEY), model: choice?.model, language: choice?.language || 'Simplified Chinese',
      text: 'The tests pass. Next I will read the adapter.', timeoutMs: 30000 });
  },
  // File preview (Claude-style): browse and read files in a session's folder, local or over SSH.
  listFiles: (id, rel = '') => sessionFilePreview(id, 'list', rel),
  searchFiles: (target, query = '') => typeof target === 'string'
    ? sessionFilePreview(target, 'search', query)
    : targetFilePreview(target?.environmentId ?? 'local', target?.cwd ?? '', 'search', query, target?.engine),
  readFile: (id, rel) => sessionFilePreview(id, 'read', rel),
  downloadFile: (id, rel) => downloadSessionFile(id, rel),
  showInFolder: path => shell.showItemInFolder(path),
};

// Build the renderer and show progress while recovery runs, but don't race it with
// an IPC that could attach to an old process or otherwise modify the session.
const updateReadOnly = new Set(['bootstrap', 'appVersion', 'updateStatus', 'showSessionUpdateReport', 'sessionUpdateTold', 'appearance', 'catalog', 'listSessions', 'environments', 'searchMessages']);
ipcMain.handle('iris:invoke', async (_event, method, ...args) => {
  const fn = api[method];
  if (!fn) throw new Error(`Unknown method ${method}`);
  if (!updateReadOnly.has(method)) {
    if (sessionUpdate?.state === 'restarting') await sessionRecovery;
    if (quitting || updater?.status.state === 'installing') throw new Error('Iris is restarting');
  }
  return fn(...args);
});

function createWindow() {
  const statePath = join(app.getPath('userData'), 'window.json'), saved = readWindowState(statePath);
  const displays = screen.getAllDisplays(), main = screen.getPrimaryDisplay();
  window = new BrowserWindow({
    ...openingBounds(saved, [main, ...displays.filter(display => display.id !== main.id)].map(display => display.workArea)),
    minWidth: MIN_SIZE.width, minHeight: MIN_SIZE.height,
    ...(saved?.fullscreen === true ? { fullscreen: true } : {}), // (an explicit false would take full screen away altogether)
    title: 'Iris',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121214' : '#fdfdfd',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 17, y: 15 }, // centered in the 44px title bar
    icon: join(root, 'build/icon.png'),
    webPreferences: { preload: join(root, 'app/main/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, plugins: true },
  });
  rememberWindow(window, statePath);
  window.on('focus', () => attention.focused());
  // Full screen has no traffic lights: the page gives their room back to the title bar.
  window.on('enter-full-screen', () => send('fullscreen', true));
  window.on('leave-full-screen', () => send('fullscreen', false));
  window.webContents.setWindowOpenHandler(({ url }) => { api.openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (url !== window.webContents.getURL()) { event.preventDefault(); api.openExternal(url); } });
  if (process.env.IRIS_DEV_URL) window.loadURL(process.env.IRIS_DEV_URL);
  else window.loadFile(join(root, 'dist/renderer/index.html'));
}

// The window, in front. On a Mac closing it leaves the app running, so it may have to be opened again.
function showWindow() {
  if (!manager) return null; // still starting: the window is about to open anyway
  if (!window || window.isDestroyed()) createWindow();
  else { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  return window;
}
// Something for the interface to do: open Settings, a conversation, a menu command. A window that had to be
// opened for it gets it once its page has loaded.
function ask(channel, payload) {
  const target = showWindow();
  if (!target) return;
  if (target.webContents.isLoading()) target.webContents.once('did-finish-load', () => send(channel, payload));
  else send(channel, payload);
}

// Asked once, while the app starts: what PATH the user's login shell has (shell-env.mjs). Agents on this
// Mac wait for the answer, so the first conversation already finds the user's own tools.
const shellEnv = !primary || process.env.IRIS_INSECURE_TEST_STORAGE === '1' || process.env.IRIS_NO_SHELL_ENV ? Promise.resolve({}) : resolveShellEnv();
app.whenReady().then(async () => {
  if (!primary) return;
  protocol.handle('iris-preview', servePreview);
  updater = new Updater({ app, net, cacheDir: join(app.getPath('userData'), 'updates'), send });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about' },
      { label: 'Check for Updates…', click: () => void checkForUpdatesFromMenu() },
      { type: 'separator' },
      { label: 'Update Report…', click: () => api.showSessionUpdateReport().catch(error => send('notice', { level: 'error', message: error.message })) },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => ask('menu', { command: 'settings' }) },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    // The page handles these keys itself while it has the keyboard; the menu shows them, answers a click, and
    // opens the window for them when it was closed.
    { label: 'File', submenu: [
      { label: 'New Conversation', accelerator: 'CmdOrCtrl+N', click: () => ask('menu', { command: 'new' }) },
      { label: 'Search…', accelerator: 'CmdOrCtrl+K', click: () => ask('menu', { command: 'search' }) },
      { label: 'Find in Conversation…', accelerator: 'CmdOrCtrl+F', click: () => ask('menu', { command: 'find' }) },
      { type: 'separator' }, { role: 'close' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ label: 'Show or Hide Sidebar', accelerator: 'CmdOrCtrl+\\', click: () => ask('menu', { command: 'sidebar' }) }, { type: 'separator' }, { role: 'reload', visible: !app.isPackaged }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(join(root, 'build/icon.png')));
  store = new Store(app.getPath('userData'), safeStorage, { insecureTestStorage: process.env.IRIS_INSECURE_TEST_STORAGE === '1' });
  syncCompactionReserves();
  // Pi loads the bridge in milliseconds from outside this ES module package (extensions.mjs).
  let bridgePath = join(root, 'agent/iris-bridge.js');
  try { bridgePath = stageExtensions(join(root, 'agent'), join(app.getPath('userData'), 'ext')); }
  catch (error) { console.error('Iris: could not stage the bridge, loading it in place:', error.message); }
  manager = new SessionManager({
    store, environments, piVersion,
    bridgePath,
    relayPath: join(root, 'agent/iris-relay.mjs'),
    // An automated run (an isolated test profile) never finds the Codex or Antigravity installed on this Mac,
    // and so never touches the accounts signed in to them: only a CLI the test itself put in IRIS_TEST_CLI_DIR.
    // IRIS_TEST_REAL_CLI=1 is for a run that is meant to look at the real ones.
    ...(process.env.IRIS_INSECURE_TEST_STORAGE === '1' && process.env.IRIS_TEST_REAL_CLI !== '1'
      ? { cliSearch: { home: join(app.getPath('userData'), 'no-home'), path: process.env.IRIS_TEST_CLI_DIR ?? '', system: false } } : {}),
    piPackageDir: join(root, 'node_modules/@earendil-works/pi-coding-agent'),
    cacheDir: join(app.getPath('userData'), 'downloads'),
    local: {
      node: nodeBinary(), piCli: join(piPackage, 'dist/bundle/cli.js'),
      agentDir: join(app.getPath('userData'), 'agent'),
      retryPath: join(dirname(bridgePath), 'iris-retry.mjs'),
      runDir: join(app.getPath('userData'), 'run'),
      uploadDir: join(app.getPath('userData'), 'uploads'),
      claudeRoot: app.getPath('userData'), // <userData>/claude-code/<version>/claude, never a `claude` on PATH
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
      envReady: shellEnv.then(found => { Object.assign(manager.local.extraEnv, found); }, () => {}),
    },
  });
  usage = new UsageLedger({ path: join(app.getPath('userData'), 'usage.jsonl'), sessionsDir: join(app.getPath('userData'), 'agent', 'sessions') });
  manager.on('event', ({ event }) => { if (event.type === 'message_end') usage.record(event.message); });
  manager.on('environments-changed', () => send('environments', environments()));
  // A CLI's sign-in page, in the user's browser. Only an https page the CLI itself named is opened.
  manager.on('cli-sign-in', ({ url }) => { if (typeof url === 'string' && /^https:\/\//.test(url)) openInBrowser(url).catch(() => {}); });
  for (const channel of ['event', 'status', 'question', 'question-resolved', 'questions-cleared', 'resync', 'rewound', 'notice', 'environment', 'goal', 'agents', 'jobs', 'ultra', 'claude-code', 'antigravity-install', 'cli-sign-in', 'cli-accounts']) manager.on(channel, payload => send(channel, payload));
  manager.on('event', ({ id, event }) => attention.event(id, event));
  manager.on('question', ({ id, question }) => attention.question(id, question));
  manager.on('ultra', ({ id, ultra }) => attention.ultra(id, ultra?.task?.status === 'active'));
  manager.on('ultra', ultraChanged);
  manager.on('status', ultraPiStatus);
  manager.on('sessions', () => send('sessions', manager.list()));
  try {
    const plan = loadSessionUpdate(app.getPath('userData'), app.getVersion());
    if (plan) recoverUpdatedSessions(plan);
  } catch (error) {
    sessionRecovery = Promise.resolve({ version: app.getVersion(), restarted: [], failures: [{ environment: 'Iris', message: error.message }] });
    setSessionUpdate('complete', app.getVersion(), 0, 1);
  }
  // The appearance chosen in the app, before the window exists: it opens in that colour.
  if (['light', 'dark'].includes(store.settings.appearance)) nativeTheme.themeSource = store.settings.appearance;
  createWindow();
  updater.start();
  // Subscriptions: ask the CLIs on this Mac who is signed in and how much is used, a few seconds after start-up,
  // so the page shows it without a wait. Not in tests: they do not run the user's CLIs unasked.
  if (process.env.IRIS_INSECURE_TEST_STORAGE !== '1') setTimeout(() => {
    manager.warmCliAccounts().catch(() => {});
    api.cliUsage('local', 'antigravity').catch(() => {});
  }, 4000).unref?.();
  if (process.env.IRIS_SMOKE_TEST) smokeTest();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else showWindow(); });
});

// A reply that finished, or a question waiting, while you were in another app: a notification, and a count
// on the Dock icon until you come back (attention.mjs).
const notes = new Set(); // shown notifications, kept so a click still reaches its handler
const attention = createAttention({
  isFocused: () => !!window && !window.isDestroyed() && window.isFocused(),
  titleOf: id => manager?.store.sessions.find(s => s.id === id)?.title,
  isWorking: id => !!manager?.runtimes.get(id)?.streaming,
  setBadge: count => { if (process.platform === 'darwin') app.dock?.setBadge(count ? String(count) : ''); else app.setBadgeCount?.(count); },
  notify: ({ id, title, body }) => {
    // Automated runs (isolated test profiles) record what they would show instead of showing it.
    if (process.env.IRIS_INSECURE_TEST_STORAGE === '1') { (globalThis.__irisNotifications ??= []).push({ id, title, body }); return; }
    if (!Notification.isSupported()) return;
    const note = new Notification({ title, body });
    notes.add(note);
    note.on('click', () => { notes.delete(note); ask('open-session', { id }); });
    note.on('close', () => notes.delete(note));
    note.show();
  },
});

// Ultra on this Mac: keep it awake while a task runs here (the screen may still turn off), say when a
// task ends, and ask before quitting stops one. Tasks on SSH hosts run there whatever this Mac does.
const ultraLocal = new Map(); // session id -> running here
let awake = null;
function keepAwake() {
  if (ultraLocal.size && awake == null) awake = powerSaveBlocker.start('prevent-app-suspension');
  if (!ultraLocal.size && awake != null) { powerSaveBlocker.stop(awake); awake = null; }
}
// A Pi that stopped (archived, deleted, crashed) sends no more status: it no longer keeps the Mac awake.
function ultraPiStatus({ id, status }) { if (!['connected', 'connecting', 'reconnecting'].includes(status) && ultraLocal.delete(id)) keepAwake(); }
function ultraChanged({ id, ultra, ended, title, local }) {
  if (local && ultra?.task?.status === 'active') ultraLocal.set(id, true); else ultraLocal.delete(id);
  keepAwake();
  if (ended && ['complete', 'stalled', 'needs_attention'].includes(ended) && Notification.isSupported()) {
    const note = new Notification({ title: ended === 'complete' ? 'Ultra finished' : ended === 'needs_attention' ? 'Ultra needs attention: review not passed' : 'Ultra stopped: no progress', body: title || 'Conversation' });
    note.on('click', () => ask('open-session', { id }));
    note.show();
  }
}

app.on('before-quit', event => {
  if (quitting || !manager) return;
  if (updater?.status.state === 'installing' && !updateQuit) { event.preventDefault(); return; }
  // Anything still working on this Mac stops with the app: say so first. (Automated runs quit unattended.)
  const working = updateQuit || process.env.IRIS_QUIT_ON_CLOSE ? 0 : Math.max(ultraLocal.size, manager.localWorkCount());
  if (working && window && !window.isDestroyed()) {
    const choice = dialog.showMessageBoxSync(window, { type: 'warning', buttons: ['Quit Anyway', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `${working === 1 ? 'A conversation is' : `${working} conversations are`} still working on this Mac`,
      detail: 'Quitting stops them. History is kept, and an Ultra task carries on when you open its conversation again. Conversations on SSH hosts keep running.' });
    if (choice !== 0) { event.preventDefault(); return; }
  }
  event.preventDefault();
  quitting = true;
  // Quit means gone: the window leaves at once, everything on this Mac is stopped, and nothing waits on a host.
  if (window && !window.isDestroyed()) window.hide();
  terminals.closeAll();
  stopUsageReaders();
  const leave = () => app.quit();
  setTimeout(() => app.exit(0), 8000).unref?.(); // whatever is still pending, the app does not stay behind
  manager.shutdown().then(leave, leave);
});
// However the app goes (quit, an update, a crash handler calling exit), no CLI it started to read a quota stays.
process.on('exit', stopUsageReaders);
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || process.env.IRIS_QUIT_ON_CLOSE) app.quit(); });

// Packaged-build check used by the release workflow: the UI loads, the native pty module loads, and
// Pi starts with this app's Electron binary acting as Node (no Node install on the Mac).
async function smokeTest() {
  const fail = error => { console.error('IRIS SMOKE FAILED:', error?.stack ?? error); app.exit(1); };
  try {
    await new Promise((resolve, reject) => { window.webContents.once('did-finish-load', resolve); window.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`renderer: ${desc}`))); setTimeout(() => reject(new Error('renderer load timeout')), 30000); });
    let mounted = false;
    for (let i = 0; i < 60 && !mounted; i++) {
      mounted = await window.webContents.executeJavaScript('!!document.querySelector(".sidebar, .composer")');
      if (!mounted) await new Promise(r => setTimeout(r, 250));
    }
    if (!mounted) throw new Error('renderer did not mount: ' + (await window.webContents.executeJavaScript('document.body.innerHTML.slice(0, 400)')));
    const t = terminals.open({ env: { kind: 'local' }, cwd: app.getPath('home'), cols: 80, rows: 24 });
    terminals.close(t);
    const piState = await manager.piSelfTest();
    console.log('IRIS SMOKE OK', JSON.stringify({ version: app.getVersion(), pi: piState }));
    app.exit(0);
  } catch (error) { fail(error); }
}
