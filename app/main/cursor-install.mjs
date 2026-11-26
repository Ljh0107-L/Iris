// Installing Cursor's CLI from Settings → Subscriptions, in the background: it goes on with Settings closed, and
// the card shows where it is when Settings opens again. The script is Cursor's own installer's steps
// (CURSOR_INSTALL), run on this Mac or on the host over SSH; on this Mac curl's progress gives a percentage.
import { spawn } from 'node:child_process';
import { CURSOR_INSTALL } from './cli-engines.mjs';
import { runSsh } from './remote-setup.mjs';

const lastLines = text => text.split(/[\r\n]+/).map(line => line.trim()).filter(line => line && !/^[#\s.%0-9]+$/.test(line)).slice(-3).join(' ');

export function installCursorCli(env, { onProgress = () => {}, run = runSsh, spawnImpl = spawn, timeoutMs = 15 * 60000 } = {}) {
  onProgress({ stage: 'preparing' });
  if (env.kind !== 'local') {
    onProgress({ stage: 'downloading' });
    return run(env, CURSOR_INSTALL, { timeout: timeoutMs }).then(out => { onProgress({ stage: 'installing' }); return out; },
      error => { throw new Error(`Cursor CLI could not be installed on ${env.label ?? env.host}: ${String(error.message ?? error).slice(0, 300)}`); });
  }
  return new Promise((resolve, reject) => {
    const child = spawnImpl('sh', ['-c', CURSOR_INSTALL], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let printed = '', last = -1;
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    const read = data => {
      printed = (printed + data).slice(-8000);
      if (/Downloading Cursor CLI/.test(printed) && last < 0) { last = 0; onProgress({ stage: 'downloading', percent: 0 }); }
      const percent = [...String(data).matchAll(/(\d{1,3}(?:\.\d)?)%/g)].map(m => Number(m[1])).filter(n => n <= 100).at(-1);
      if (percent != null && Math.floor(percent) !== last) {
        last = Math.floor(percent);
        onProgress(last >= 100 ? { stage: 'installing' } : { stage: 'downloading', percent: last });
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', error => { clearTimeout(timer); reject(new Error(`The installer could not be started: ${error.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(printed);
      else reject(new Error(`Cursor CLI could not be installed: ${lastLines(printed) || `the installer stopped (${code ?? 'killed'})`}`));
    });
  });
}
