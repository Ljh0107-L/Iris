// The PATH and locale of the user's login shell, for the agents this app starts on this Mac.
//
// An app opened from the Dock or Finder gets launchd's environment: PATH is /usr/bin:/bin:/usr/sbin:/sbin
// and there is no LANG. Pi runs its commands with `bash -c`, which reads no profile, so the agent could
// not find anything the user installed themselves (Homebrew, npm, gh, cargo, conda) although the same
// command worked in the terminal panel, which starts a login shell. The shell is asked once, at start-up,
// what its PATH is; nothing else is taken from it.
import { execFile } from 'node:child_process';
import { delimiter } from 'node:path';

const MARK = '__IRIS_SHELL_ENV__';

// `$SHELL -ilc`: login and interactive, since PATH additions live in .zprofile and .zshrc alike (nvm,
// conda and pyenv usually in the latter). fish and csh-family shells take the same flags.
export function shellEnvCommand(shell) {
  // Only syntax every common shell shares (zsh, bash, fish).
  const script = `printf '%s%s%s%s%s' ${MARK} "$PATH" ${MARK} "$LANG" ${MARK}`;
  return { file: shell, args: ['-ilc', script] };
}

// The values between the markers: profiles may print anything before and after.
export function parseShellEnv(output) {
  const parts = String(output ?? '').split(MARK);
  if (parts.length < 4) return null;
  const [path, lang] = parts.slice(-3);
  const entries = path.split(delimiter).filter(entry => entry.startsWith('/') && !/[\r\n\0]/.test(entry));
  return entries.length ? { path: entries, lang: /^[\w.@-]{1,64}$/.test(lang) ? lang : null } : null;
}

// The shell's entries first and in its order, then whatever only the app had.
export function mergePath(shellEntries, current = '') {
  return [...new Set([...shellEntries, ...String(current).split(delimiter).filter(Boolean)])].join(delimiter);
}

// Resolves to { PATH, LANG } for the agent's environment, or {} when the shell cannot be asked in time
// (a profile that waits for input, an unusual shell): agents then start as they did before.
export function resolveShellEnv({ env = process.env, shell = env.SHELL || '/bin/zsh', timeout = 5000, run = execFile } = {}) {
  return new Promise(resolve => {
    const fallback = env.LANG || env.LC_ALL ? {} : { LANG: 'en_US.UTF-8' };
    let child;
    try {
      const { file, args } = shellEnvCommand(shell);
      // Not this app's variables: ELECTRON_RUN_AS_NODE and the like must not shape what the profile does.
      const base = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'PATH', 'LANG', 'LC_ALL', 'TERM'].filter(k => env[k] !== undefined).map(k => [k, env[k]]));
      child = run(file, args, { env: { ...base, TERM: base.TERM ?? 'dumb' }, timeout, killSignal: 'SIGKILL', maxBuffer: 1 << 20, encoding: 'utf8' }, (error, stdout) => {
        const parsed = parseShellEnv(stdout);
        if (!parsed) { resolve(fallback); return; }
        resolve({ PATH: mergePath(parsed.path, env.PATH), ...(parsed.lang ? { LANG: parsed.lang } : fallback) });
      });
      child?.stdin?.end(); // a profile that reads stdin sees end-of-file instead of waiting
    } catch { resolve(fallback); }
  });
}
