// A Codex conversation through the session manager and this machine's relay, with a stand-in CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { SessionManager } from '../app/main/session-manager.mjs';
import { Store } from '../app/main/store.mjs';
import { listEnvironments } from '../app/main/environments.mjs';
import { FAKE_CODEX } from './fake-codex.mjs';

test('Codex: found on the login PATH, opened with the choices made beforehand, and remembered for the next conversation', { timeout: 60000 }, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pdx-')));
  const bin = join(dir, 'bin'), log = join(dir, 'calls.jsonl'), workDir = join(dir, 'work');
  for (const d of [bin, workDir]) mkdirSync(d);
  writeFileSync(join(bin, 'codex'), FAKE_CODEX); chmodSync(join(bin, 'codex'), 0o755); writeFileSync(log, '');
  const calls = method => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(c => c.method === method);
  const root = resolve('.');
  const store = new Store(join(dir, 'data'), null, { insecureTestStorage: true });
  const manager = new SessionManager({ store, environments: () => listEnvironments({ sshConfig: '/dev/null' }), piVersion: '0', bridgePath: join(root, 'agent/iris-bridge.js'), relayPath: join(root, 'agent/iris-relay.mjs'), cacheDir: join(dir, 'cache'),
    local: { node: process.execPath, piCli: join(dir, 'no-pi.js'), agentDir: join(dir, 'agent'), runDir: join(dir, 'run'), uploadDir: join(dir, 'uploads'),
      // As after start-up: the login shell's PATH, where an npm-installed CLI lives.
      extraEnv: { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_CODEX_LOG: log, FAKE_CODEX_SIGNED_OUT: join(dir, 'signed-out') } } });
  t.after(async () => { await manager.shutdown?.().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  const settled = () => new Promise(resolveSettled => { const on = ({ event }) => { if (event.type === 'agent_settled') { manager.off('event', on); resolveSettled(); } }; manager.on('event', on); });

  assert.deepEqual(await manager.cliInfo('local', 'codex'), { installed: true });
  assert.deepEqual(manager.cliOptions('local', 'codex'), [], 'nothing is offered before the CLI has said what it has');
  // Iris keeps its own Codex home: the user's own Codex is signed in (no signed-out marker), yet
  // here it is not, and nothing it does lands in the user's Codex history.
  const ownHome = join(dir, 'cli-accounts', 'codex', 'default');
  assert.equal((await manager.cliAccountStatus('local', { engine: 'codex' })).signedIn, false);
  assert.ok(readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(c => c.method === 'home').every(c => c.params === ownHome), 'never the CLI’s own home');
  writeFileSync(join(ownHome, 'auth.json'), '{}'); // signed in here once
  const account = await manager.cliAccountStatus('local', { engine: 'codex' });
  assert.deepEqual([account.signedIn, account.identity, account.plan, account.limits.length, account.options], [true, 'dev@example.test', 'pro', 2, undefined]);
  // The account check also learned the menus: a first conversation can pick its model before it starts.
  assert.deepEqual(manager.cliOptions('local', 'codex').map(o => [o.id, o.currentValue, o.options.length]), [['model', 'gpt-a', 2], ['effort', 'low', 2], ['speed', 'standard', 3]]);

  assert.equal(await manager.cliReadiness('local', 'codex'), 'ready');
  const first = await manager.create({ environmentId: 'local', cwd: workDir, engine: 'codex', prompt: 'hello', creationId: 'pending:1' });
  assert.deepEqual([first.engine, first.status, first.cli.options.map(o => o.currentValue)], ['codex', 'connected', ['gpt-a', 'low', 'standard']]);
  let done = settled();
  assert.equal((await manager.prompt(first.id, 'hello')).disposition, 'started');
  await done;
  assert.deepEqual((await manager.historyPage(first.id, {})).messages.map(m => m.role), ['user', 'assistant']);
  // The conversation is Iris's own: it runs in Iris's Codex home, never the user's.
  assert.ok(calls('home').length > 1 && calls('home').every(c => c.params === ownHome), 'every Codex start used Iris’s own home');
  // Named by Codex after its first reply (the first words until then).
  for (let i = 0; i < 100 && manager.record(first.id).title !== 'Weather lookup by city'; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(manager.record(first.id).title, 'Weather lookup by city');
  // A choice made in a conversation is the default for the next one, and its menus are known beforehand.
  await manager.cliSetConfig(first.id, 'effort', 'high');
  assert.deepEqual(manager.cliOptions('local', 'codex').map(o => [o.id, o.currentValue]), [['model', 'gpt-a'], ['effort', 'high'], ['speed', 'standard']]);

  const second = await manager.create({ environmentId: 'local', cwd: workDir, engine: 'codex', prompt: 'again', creationId: 'pending:2', cliChoices: { model: 'gpt-a', effort: 'high', speed: 'ultrafast' } });
  done = settled();
  await manager.prompt(second.id, 'again');
  await done;
  const turnStart = calls('turn/start').filter(c => c.params.threadId === 'thread-1').at(-1); // not the title request
  assert.deepEqual([turnStart.params.effort, turnStart.params.serviceTier], ['high', 'ultrafast'], 'applied before the first message');
  assert.equal(manager.record(second.id).cliChoices, undefined, 'applied once');

  // Codex always has full access: Antigravity's "ask before running tools" switch does not apply to it.
  store.settings.defaults = { ...store.settings.defaults, antigravityBypassPermissions: false };
  assert.equal(manager.cliPermissionMode({ engine: 'codex' }), 'bypassPermissions');
  assert.equal(manager.cliPermissionMode({ engine: 'antigravity' }), 'confirm');
  const opened = calls('thread/start').filter(c => !c.params.ephemeral).at(-1); // the title is asked read-only, in a throwaway thread
  assert.deepEqual([opened.params.approvalPolicy, opened.params.sandbox], ['never', 'danger-full-access']);

  // A message sent while Codex works joins the turn instead of being refused.
  done = settled();
  await manager.prompt(second.id, 'wait for me');
  assert.equal((await manager.prompt(second.id, 'one more thing')).disposition, 'queued');
  await manager.abort(second.id);
  await done;
  await manager.delete(first.id); await manager.delete(second.id);

  // A second account is a second home directory: its own sign-in, and conversations that stay with it.
  assert.deepEqual(manager.cliAccounts('codex'), [{ id: 'default', name: 'Default' }]);
  assert.deepEqual(manager.cliAccounts('antigravity'), [{ id: 'default', name: 'Default' }]);
  assert.throws(() => manager.addCliAccount('antigravity', 'Second'), /one sign-in per machine/);
  const [, work] = manager.addCliAccount('codex', '  Work  ');
  assert.equal(work.name, 'Work');
  assert.throws(() => manager.addCliAccount('codex', 'work'), /already an account/);
  const home = join(dir, 'cli-accounts', 'codex', work.id);
  assert.equal((await manager.cliAccountStatus('local', { engine: 'codex', account: work.id })).signedIn, false, 'a new account starts signed out');
  assert.equal((await manager.cliAccountStatus('local', { engine: 'codex' })).signedIn, true, 'the default account is untouched');
  const login = await manager.cliTerminal('local', 'login', 'codex', work.id);
  assert.deepEqual([login.bin, login.args.slice(2)], ['sh', ['sh', home, join(bin, 'codex'), 'login']], 'sign-in runs with that home');
  writeFileSync(join(home, 'auth.json'), '{}'); // what `codex login` leaves behind
  assert.equal((await manager.cliAccountStatus('local', { engine: 'codex', account: work.id })).signedIn, true);
  const third = await manager.create({ environmentId: 'local', cwd: workDir, engine: 'codex', prompt: 'hi', creationId: 'pending:3', cliAccount: work.id });
  assert.deepEqual([third.status, third.cliAccount], ['connected', work.id]);
  assert.equal(calls('home').at(-1).params, home, 'the conversation runs as that account');
  await assert.rejects(manager.removeCliAccount('codex', work.id), /1 conversation uses this account/);
  await manager.delete(third.id);
  assert.deepEqual(await manager.removeCliAccount('codex', work.id), [{ id: 'default', name: 'Default' }]);
});
