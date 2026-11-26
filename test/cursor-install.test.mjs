// Installing Cursor's CLI in the background: what the installer prints becomes the card's progress, and a
// failure says why in the installer's own words.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { installCursorCli } from '../app/main/cursor-install.mjs';

function fakeSpawn(chunks, code) {
  return (bin, args) => {
    assert.equal(bin, 'sh'); assert.equal(args[0], '-c'); assert.match(args[1], /downloads\.cursor\.com/);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setImmediate(() => { for (const [stream, text] of chunks) child[stream].emit('data', Buffer.from(text)); child.emit('close', code); });
    return child;
  };
}

test('the installer’s progress becomes the card’s, and its end is the install’s', async () => {
  const seen = [];
  await installCursorCli({ kind: 'local' }, { onProgress: state => seen.push(state), spawnImpl: fakeSpawn([
    ['stdout', 'Downloading Cursor CLI 2026.11.22-fake…\n'], ['stderr', '\r###       12.5%'], ['stderr', '\r######    48.0%'], ['stderr', '\r########## 100.0%'],
    ['stdout', 'Cursor CLI 2026.11.22-fake is installed as ~/.local/bin/cursor-agent.\n']], 0) });
  assert.deepEqual(seen, [{ stage: 'preparing' }, { stage: 'downloading', percent: 0 }, { stage: 'downloading', percent: 12 }, { stage: 'downloading', percent: 48 }, { stage: 'installing' }]);
});

test('a failed install says why, in the installer’s words', async () => {
  await assert.rejects(installCursorCli({ kind: 'local' }, { spawnImpl: fakeSpawn([['stdout', 'Could not find the current version of the Cursor CLI.\n']], 1) }),
    /Cursor CLI could not be installed: Could not find the current version of the Cursor CLI\./);
});

test('on a host the installer runs there, over SSH', async () => {
  const runs = [], seen = [];
  await installCursorCli({ kind: 'ssh', label: 'Lab' }, { onProgress: state => seen.push(state.stage), run: async (env, script) => { runs.push(script); return 'ok'; } });
  assert.equal(runs.length, 1); assert.match(runs[0], /ln -sfn "\$dir\/cursor-agent" "\$HOME\/\.local\/bin\/cursor-agent"/);
  assert.doesNotMatch(runs[0], /\.local\/bin\/agent"/, 'the agent command of another tool is left alone');
  assert.deepEqual(seen, ['preparing', 'downloading', 'installing']);
});
