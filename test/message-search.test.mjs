// ⌘K finds conversations on this Mac by what was said in them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { decodeRemoteSearch, findInSessionFile, remoteSearchScript, searchSessionFiles, snippetAround } from '../app/main/message-search.mjs';
import { SessionManager } from '../app/main/session-manager.mjs';
import { Store } from '../app/main/store.mjs';

const line = entry => JSON.stringify(entry);
const message = (role, content, extra = {}) => line({ type: 'message', id: Math.random().toString(36).slice(2), message: { role, content, ...extra } });

function files(t, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'iris-search-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Object.entries(contents).map(([id, lines]) => { const file = join(dir, `${id}.jsonl`); writeFileSync(file, lines.join('\n') + '\n'); return { id, file }; });
}

test('a conversation is found by its latest message that says it, with the words around the match', async t => {
  const [weather, other, tools] = files(t, {
    weather: [line({ type: 'session', version: 3 }), message('user', [{ type: 'text', text: '加一个按城市查询温度的函数' }]),
      message('assistant', [{ type: 'thinking', thinking: 'Open-Meteo is free' }, { type: 'text', text: '好的,我用 Open-Meteo 查询温度。' }]),
      message('user', [{ type: 'text', text: 'Now cache the Open-Meteo responses for ten minutes, please.' }])],
    other: [message('user', 'Something unrelated'), message('user', [{ type: 'text', text: '/iris-title open-meteo' }])],
    tools: [message('toolResult', [{ type: 'text', text: 'open-meteo appears only in tool output' }]), 'not json {open-meteo}'],
  });
  assert.deepEqual(await findInSessionFile(weather.file, 'open-meteo'), { role: 'user', snippet: 'Now cache the Open-Meteo responses for ten minutes, please.' });
  assert.equal(await findInSessionFile(other.file, 'open-meteo'), null, 'the desktop’s own prompts are not searched');
  assert.equal(await findInSessionFile(tools.file, 'open-meteo'), null, 'nor tool output');
  assert.deepEqual((await searchSessionFiles([other, weather, tools], 'Open-Meteo')).map(h => h.id), ['weather']);
  assert.deepEqual((await searchSessionFiles([weather], '温度')).map(h => [h.role, h.snippet]), [['assistant', '好的,我用 Open-Meteo 查询温度。']]);
  assert.deepEqual(await searchSessionFiles([weather], 'o'), [], 'one letter is too little to search for');
});

test('results keep the order they were asked in, stop at the limit, and a missing file is skipped', async t => {
  const list = files(t, Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [id, [message('user', `fix the parser in ${id}`)]])));
  const missing = { id: 'gone', file: join(tmpdir(), 'iris-no-such-file.jsonl') };
  assert.deepEqual((await searchSessionFiles([list[3], missing, list[0], list[2], list[1]], 'parser', { limit: 3 })).map(h => h.id), ['d', 'a', 'c']);
});

test('a snippet is plain words: no code fences, quote marks or heading hashes', () => {
  const text = "console.log(x);\n```\n\n> Next: use Open-Meteo for the forecast\n## Plan";
  assert.equal(snippetAround(text, text.indexOf('Open-Meteo'), 10, { before: 40 }), 'console.log(x); Next: use Open-Meteo for the forecast Plan');
});

test('a snippet is the match with some text on either side, on one line', () => {
  const text = `${'x'.repeat(80)}\nthe needle is here\n${'y'.repeat(200)}`;
  const snippet = snippetAround(text, text.indexOf('needle'), 6);
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…') && !snippet.includes('\n') && snippet.includes('the needle is here'));
});

test('a search that runs out of time says its list is not everything', async t => {
  const list = files(t, Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [id, [message('user', `the parser in ${id}`)]])));
  let clock = 0;
  const cut = await searchSessionFiles(list, 'parser', { parallel: 1, budgetMs: 2, now: () => clock++ });
  assert.ok(cut.length < 4 && cut.partial === true);
  const all = await searchSessionFiles(list, 'parser');
  assert.deepEqual([all.length, all.partial], [4, undefined]);
  assert.equal((await searchSessionFiles(list, 'parser', { limit: 2 })).partial, undefined, 'a full page of results is not a search cut short');
});

test('a host searches its own files with the same script, fed the conversations on standard input', async t => {
  const list = files(t, { one: [message('user', 'Tune the scheduler’s 重试 policy')], two: [message('assistant', [{ type: 'text', text: 'nothing here' }])], three: [message('user', 'scheduler again, it\'s "quoted"')] });
  // The host is played by this machine: the script runs under sh, as it would over SSH.
  const run = (query, input) => execFileSync('sh', ['-c', remoteSearchScript(process.execPath, query, { limit: 20 })], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.deepEqual(decodeRemoteSearch(run('Scheduler', list)), { hits: [{ id: 'one', role: 'user', snippet: 'Tune the scheduler’s 重试 policy' }, { id: 'three', role: 'user', snippet: 'scheduler again, it\'s "quoted"' }], partial: false });
  assert.deepEqual(decodeRemoteSearch(run('重试', list)).hits.map(hit => hit.id), ['one']);
  assert.deepEqual(decodeRemoteSearch(run("it's \"quoted\"", list)).hits.map(hit => hit.id), ['three'], 'the query is data, whatever it contains');
  assert.deepEqual(decodeRemoteSearch(run('scheduler', [...list, { id: 'gone', file: '/no/such/file.jsonl' }])).hits.length, 2);
  assert.throws(() => decodeRemoteSearch('bash: node: command not found'), /did not answer/);
  assert.throws(() => decodeRemoteSearch(''), /did not answer/);
});

test('⌘K searches this Mac and connected hosts, and counts the conversations it could not read', { timeout: 20000 }, async t => {
  const [here, there, away] = files(t, { here: [message('user', 'the flaky scheduler test')], there: [message('user', 'scheduler on the lab host')], away: [message('user', 'scheduler on a host that is off')] });
  const dir = mkdtempSync(join(tmpdir(), 'iris-search-manager-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'data'), null, { insecureTestStorage: true });
  const record = (id, environmentId, file, updatedAt) => ({ id, title: id, environmentId, cwd: dir, piSessionFile: file, createdAt: 1, updatedAt });
  store.sessions.push(record('here', 'local', here.file, 30), record('there', 'ssh:lab', there.file, 20), record('away', 'ssh:off', away.file, 10), { ...record('old', 'local', here.file, 5), archived: true });
  const root = resolve('.'), asked = [];
  const runRemote = async (env, script, { input } = {}) => { asked.push(env.host); return execFileSync('sh', ['-c', script], { input, encoding: 'utf8' }); };
  const manager = new SessionManager({ store, environments: () => [{ id: 'local', kind: 'local', label: 'This computer' }, { id: 'ssh:lab', kind: 'ssh', enabled: true, added: true, label: 'Lab', host: 'lab' }, { id: 'ssh:off', kind: 'ssh', enabled: true, added: true, label: 'Off', host: 'off' }],
    piVersion: '0', bridgePath: join(root, 'agent/iris-bridge.js'), relayPath: join(root, 'agent/iris-relay.mjs'), cacheDir: join(dir, 'cache'),
    local: { node: process.execPath, piCli: join(dir, 'no-pi.js'), agentDir: join(dir, 'agent'), runDir: join(dir, 'run'), uploadDir: join(dir, 'uploads'), extraEnv: {} },
    remoteSetup: async () => ({ root: join(dir, 'host'), node: process.execPath }), runRemote });
  t.after(() => manager.shutdown?.().catch(() => {}));
  // Nothing is set up yet: a search reads this Mac and does not go looking for hosts.
  assert.deepEqual(await manager.searchMessages('scheduler'), { hits: [{ id: 'here', role: 'user', snippet: 'the flaky scheduler test' }], unsearched: 2, partial: false });
  assert.deepEqual(asked, []);
  manager.prepared.set('ssh:lab', Promise.resolve({ root: join(dir, 'host'), node: process.execPath })); // as after the host was set up in this run
  manager.prepared.set('ssh:off', new Promise(() => {})); // still being set up: not waited for
  const found = await manager.searchMessages('scheduler');
  assert.deepEqual(found.hits.map(hit => hit.id), ['here', 'there'], 'newest conversation first, wherever it lives');
  assert.deepEqual([found.unsearched, found.partial, asked], [1, false, ['lab']]);
  assert.deepEqual(await manager.searchMessages('s'), { hits: [], unsearched: 1, partial: false });
});
