// Antigravity remains the owner of its credentials, tools and quota.
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import app from '../../package.json' with { type: 'json' };
import { shellQuote } from '../../core/transports.mjs';
import { runSsh } from './remote-setup.mjs';

const exec = promisify(execFile);
const agentFile = name => fileURLToPath(new URL(`../../agent/${name}`, import.meta.url));

// Engines that are someone else's CLI, signed in with the user's own account there (a subscription, not
// an API key from Settings). Each keeps its credentials; the desktop only starts it and talks to it.
export const CODEX_ENGINE = 'codex';
export const CURSOR_ENGINE = 'cursor';
export const CLI_ENGINES = {
  // Its sign-in goes into the data directory Iris's conversations use (`home`). On a Mac that makes no
  // difference (the sign-in is in the keychain); on a host without one the CLI keeps it in that directory,
  // and a sign-in made in the CLI's default directory is one Iris's conversations never see.
  antigravity: { id: 'antigravity', label: 'Antigravity', bin: 'agy', adapter: 'iris-antigravity.mjs', login: (env, home) => ['acp', '--login', ...(home ? ['--app-data-dir', home] : [])],
    install: 'Install it from Settings → Subscriptions, then try again.' },
  // accounts: more than one sign-in per machine, each in its own CODEX_HOME. (Antigravity keeps one
  // sign-in per machine, so it has no such choice.)
  codex: { id: 'codex', label: 'Codex', bin: 'codex', adapter: 'iris-codex.mjs', accounts: true, signInPage: true, login: env => env.kind === 'local' ? ['login'] : ['login', '--device-auth'],
    install: 'Install it with npm install -g @openai/codex (or brew install codex), then try again.' },
  // Cursor's CLI is `cursor-agent` (its installer also names it `agent`, a name other tools use as well). Its
  // sign-in is the user's own Cursor account, kept by the CLI; Iris opens the page its login names (signInPage).
  // On SSH hosts its requests to Cursor go out through this Mac (egress, see routeThroughMac in the adapter):
  // Cursor offers the models of the region it is asked from.
  cursor: { id: 'cursor', label: 'Cursor', bin: 'cursor-agent', adapter: 'iris-cursor.mjs', signInPage: true, login: () => ['login'],
    install: 'Install it from Settings → Subscriptions, then try again.',
    egress: ['cursor.sh:443', '.cursor.sh:443', 'cursor.com:443', '.cursor.com:443', 'cursorapi.com:443', '.cursorapi.com:443'] },
};
export const isCliEngineId = id => typeof id === 'string' && Object.hasOwn(CLI_ENGINES, id);
export const cliEngine = id => CLI_ENGINES[isCliEngineId(id) ? id : 'antigravity'];
export const cliAdapterPath = engine => agentFile(cliEngine(engine).adapter);
// On a host the adapters sit side by side where the Antigravity one was deployed.
export const remoteCliAdapter = (facts, engine) => (facts.adapter ?? `${facts.root}/ext/iris-antigravity.mjs`).replace(/iris-antigravity\.mjs$/, cliEngine(engine).adapter);

export const ANTIGRAVITY_ENGINE = 'antigravity';
export const ANTIGRAVITY_REMOTE_LOGIN = 'Sign in to Antigravity on this host in Settings → Subscriptions, then reconnect.';

// The sign-in a person completes for Antigravity on a host (a link, then a code), run through the adapter
// there so that it gets what a conversation's CLI gets (see --account-login-terminal in the adapter).
export const remoteLoginCommand = (facts, engine, bin, home) => ({ bin: facts.node, args: [remoteCliAdapter(facts, engine), '--account-login-terminal', bin, app.version, home] });

export function antigravityInstallMessage(env, engine) {
  const target = env.kind === 'local' ? '' : ` on ${env.label ?? env.host}`;
  const cli = cliEngine(engine);
  return `${cli.label} CLI (${cli.bin}) was not found${target}. ${cli.install}`;
}

export function cliBoot(bin, record, sessionsDir, remote = false, bypassPermissions = true, home = null) {
  return { [cliEngine(record.engine).id]: { bin, sessionsDir, sessionFile: record.piSessionFile ?? null, cwd: record.cwd, recordId: record.id, remote, bypassPermissions, ...(home ? { home } : {}),
    ...(record.spare ? { standby: true } : {}), clientVersion: app.version } };
}

// menusDir: where the CLI may open one empty conversation to say what a new one can choose from (Antigravity
// has no other way to ask); given only while Iris has no menus for that CLI on that machine.
// forward (on a host, for a CLI with egress): the port that carries its requests to this Mac (runSsh's forward).
export async function cliAccountStatus(env, { bin, local, facts, login = false, logout = false, engine, home = null, menusDir = null, forward = null, run = runSsh, invoke = exec }) {
  if (login && env.kind !== 'local') throw new Error(ANTIGRAVITY_REMOTE_LOGIN);
  const args = [login ? '--account-login' : logout ? '--account-logout' : '--account-check', bin, app.version, ...(home ? [home] : [])];
  const timeout = login ? 145000 : 35000;
  let out;
  if (env.kind === 'local') {
    ({ stdout: out } = await invoke(local.node, [cliAdapterPath(engine), ...args], { cwd: homedir(), env: { ...process.env, ...local.extraEnv, ...(menusDir ? { IRIS_CLI_MENUS_DIR: menusDir } : {}) }, timeout }));
  } else {
    const cmd = [facts.node, remoteCliAdapter(facts, engine), ...args].map(shellQuote).join(' ');
    const vars = [...(menusDir ? [`IRIS_CLI_MENUS_DIR=${shellQuote(menusDir)}`] : []), ...(forward ? [`IRIS_CURSOR_EGRESS=127.0.0.1:${forward.remotePort}`] : [])];
    out = await run(env, `cd "$HOME" && ${vars.map(v => `${v} `).join('')}exec ${cmd}`, { timeout, ...(forward ? { forward } : {}) });
  }
  const line = out.trim().split('\n').at(-1);
  let result;
  try { result = JSON.parse(line); } catch { throw new Error(`${cliEngine(engine).label} did not report its sign-in status.`); }
  if (!result?.cliAccountStatus) throw new Error(result?.cliAccountError ?? `${cliEngine(engine).label} did not report its sign-in status.`);
  const { signedIn, canSignIn, identity, plan, limits, options } = result.cliAccountStatus;
  // Who is signed in, the plan and how much of each limit is used, when the CLI says (Codex does).
  return { installed: true, signedIn: typeof signedIn === 'boolean' ? signedIn : null, canSignIn: env.kind === 'local' && canSignIn === true,
    ...(typeof identity === 'string' ? { identity: identity.slice(0, 200) } : {}), ...(typeof plan === 'string' ? { plan: plan.slice(0, 60) } : {}),
    ...(Array.isArray(options) && options.length ? { options } : {}),
    ...(Array.isArray(limits) ? { limits: limits.slice(0, 4).filter(l => Number.isFinite(l?.usedPercent)).map(l => ({ usedPercent: l.usedPercent, windowMinutes: l.windowMinutes, resetsAt: l.resetsAt })) } : {}) };
}

// A sign-in the CLI itself carries out, on this Mac: the adapter names the page to open (onUrl), then
// reports the account once the browser has finished. cancel() gives up; the CLI is told to drop it.
export function cliSignIn({ bin, local, engine, home = null, onUrl }) {
  const child = spawn(local.node, [cliAdapterPath(engine), '--account-login', bin, app.version, ...(home ? [home] : [])],
    { cwd: homedir(), env: { ...process.env, ...local.extraEnv }, stdio: ['pipe', 'pipe', 'ignore'] });
  let buffer = '', last = null;
  const promise = new Promise((resolve, reject) => {
    child.stdout.on('data', data => {
      buffer += data;
      for (let i; (i = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        let record; try { record = JSON.parse(line); } catch { continue; }
        if (typeof record?.cliSignIn?.url === 'string' && /^https:\/\//.test(record.cliSignIn.url)) onUrl?.(record.cliSignIn.url);
        else if (record?.cliAccountStatus || record?.cliAccountError) last = record;
      }
    });
    child.on('error', error => reject(new Error(`${cliEngine(engine).label} could not be started: ${error.message}`)));
    child.on('close', () => {
      if (last?.cliAccountStatus) resolve(last.cliAccountStatus);
      else reject(new Error(last?.cliAccountError ?? `${cliEngine(engine).label} did not finish the sign-in.`));
    });
  });
  return { promise, cancel: () => { try { child.stdin.end(); } catch { /* already gone */ } } };
}

// system: false looks only in `home` and `path`, not in the places Homebrew and installers use on this Mac
// (automated runs must not find the CLIs, and so the accounts, of whoever runs them).
export function findCli({ home = homedir(), path = process.env.PATH ?? '', name = 'agy', system = true } = {}) {
  const dirs = [join(home, '.local', 'bin'), ...path.split(delimiter), ...(system ? ['/opt/homebrew/bin', '/usr/local/bin'] : [])];
  for (const dir of new Set(dirs.filter(isAbsolute))) {
    const bin = join(dir, name);
    try {
      if (!statSync(bin).isFile()) continue;
      accessSync(bin, constants.X_OK);
      return bin;
    } catch { /* try the next installation location */ }
  }
  return null;
}

// Cursor's installer keeps each version in ~/.local/share/cursor-agent/versions/<version>; the newest one is
// used when no cursor-agent is on the PATH (an install that did not link it, or a link removed since).
export function newestCursorCli(home = homedir()) {
  const dir = join(home, '.local', 'share', 'cursor-agent', 'versions');
  let names = [];
  try { names = readdirSync(dir).filter(name => /^\d{4}\.\d{2}\.\d{2}-[\w]+$/.test(name)).sort().reverse(); } catch { return null; }
  for (const name of names) {
    const bin = join(dir, name, 'cursor-agent');
    try { if (statSync(bin).isFile()) { accessSync(bin, constants.X_OK); return bin; } } catch { /* an unfinished version */ }
  }
  return null;
}
// Installs Cursor's CLI the way its own installer does (the version it names, into the same folders), except
// that only `cursor-agent` is linked: its installer also points `agent` at it, which may be another tool's.
// Run in a terminal the person watches, on this Mac or a host.
export const CURSOR_INSTALL = String.raw`set -e
case "$(uname -s)" in Darwin) os=darwin;; Linux) os=linux;; *) echo "Cursor CLI does not run on $(uname -s)."; exit 1;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; *) echo "Cursor CLI does not run on $(uname -m)."; exit 1;; esac
ver=$(curl -fsSL https://cursor.com/install | sed -n 's|.*downloads\.cursor\.com/lab/\([0-9][^/"]*\)/.*|\1|p' | head -n 1)
[ -n "$ver" ] || { echo "Could not find the current version of the Cursor CLI."; exit 1; }
dir="$HOME/.local/share/cursor-agent/versions/$ver"
if [ ! -x "$dir/cursor-agent" ]; then
  tmp="$dir.tmp-$$"; rm -rf "$tmp"; mkdir -p "$tmp"
  echo "Downloading Cursor CLI $ver…"
  curl -fSL --progress-bar "https://downloads.cursor.com/lab/$ver/$os/$arch/agent-cli-package.tar.gz" | tar --strip-components=1 -xzf - -C "$tmp"
  rm -rf "$dir"; mv "$tmp" "$dir"
fi
mkdir -p "$HOME/.local/bin"; ln -sfn "$dir/cursor-agent" "$HOME/.local/bin/cursor-agent"
echo "Cursor CLI $ver is installed as ~/.local/bin/cursor-agent."`;

// Run only presence checks in the remote account. Never execute agy or ask for credentials here.
export async function findRemoteCli(env, { run = runSsh, name = 'agy' } = {}) {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) throw new Error('Invalid CLI name.');
  // The login shell's PATH too: a CLI installed with npm or a version manager is only on that one.
  const output = await run(env, `for bin in "$HOME/.local/bin/${name}" "$(command -v ${name} 2>/dev/null)" "$("\${SHELL:-sh}" -lc 'command -v ${name}' 2>/dev/null | tail -1)" /opt/homebrew/bin/${name} /usr/local/bin/${name}; do
  case "$bin" in /*) if [ -f "$bin" ] && [ -x "$bin" ]; then printf 'IRIS_AGY=%s\\n' "$bin"; break; fi;; esac
 done`, { timeout: 30000 });
  const bin = output.split('\n').findLast(line => line.startsWith('IRIS_AGY='))?.slice('IRIS_AGY='.length);
  return bin && isAbsolute(bin) && !/[\u0000-\u001f\u007f]/.test(bin) ? bin : null;
}
