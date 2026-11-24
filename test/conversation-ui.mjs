// Built renderer in a browser, with the desktop bridge stubbed: a reply streamed faster than frames,
// Find in conversation across rows that are not rendered, and a message queued while the agent works.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const session = { id: 'talk', title: 'Trace the login flow', environmentId: 'local', environmentLabel: 'This computer', project: 'web', cwd: '/tmp/web', status: 'connected', engine: 'pi', model: { provider: 'mock', id: 'mock' } };
const settings = { defaults: { environmentId: 'local', model: session.model }, providers: [], builtinProviders: { mock: 'Mock provider' }, environments: {}, recentFolders: {}, recentEnvironments: [] };
const environments = [{ id: 'local', kind: 'local', label: 'This computer' }, { id: 'ssh:lab', kind: 'ssh', label: 'Lab host', added: true, enabled: true }];
// 120 turns: far more rows than stay mounted. One early reply and one folded tool result hold the needles.
const history = [];
for (let turn = 0; turn < 120; turn++) {
  history.push({ __entryId: `u${turn}`, role: 'user', timestamp: turn * 10 + 1, content: [{ type: 'text', text: `Question ${turn}: what does step ${turn} do?` }] });
  if (turn === 3) {
    history.push({ __entryId: 'a3call', role: 'assistant', timestamp: 32, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call3', name: 'bash', arguments: { command: 'grep -rn token src' } }] });
    history.push({ __entryId: 'r3', role: 'toolResult', toolCallId: 'call3', toolName: 'bash', timestamp: 33, content: [{ type: 'text', text: 'src/auth.ts:42: needle-beta verifyToken()' }] });
  }
  history.push({ __entryId: `a${turn}`, role: 'assistant', timestamp: turn * 10 + 5, stopReason: 'stop', content: [{ type: 'text', text: turn === 5 ? 'Step 5 refreshes the session: needle-alpha 登录逻辑.' : `Step ${turn} is routine work. `.repeat(6) }] });
}
const ipcCalls = [];
const codexAccounts = [{ id: 'default', name: 'Default' }];
const cli = { localInstalled: false, signedIn: {}, signIn: null }; // what the fixture's Codex says on this Mac
const dist = resolve('dist/renderer');
const server = createServer(async (req, res) => {
  try {
    const path = resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!path.startsWith(dist + '/') && path !== dist) { res.writeHead(403); res.end(); return; }
    const target = path === dist || path.endsWith('/') ? join(path, 'index.html') : path;
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }[extname(target)] ?? 'application/octet-stream';
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': type }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const executablePath = process.env.IRIS_CHROMIUM || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(existsSync);
let browser; const errors = [];
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('fixtureInvoke', async (method, ...args) => {
    ipcCalls.push({ method, args });
    if (method === 'bootstrap') return { settings, environments, sessions: [session], home: '/tmp' };
    if (method === 'catalog') return [{ provider: 'mock', id: 'mock', name: 'Offline fixture', api: 'openai-responses', engines: ['pi'], input: ['text'], reasoning: true, speeds: [] }];
    if (method === 'historyPage') return { messages: history, next: null, snapshot: { identity: 'fixture', end: 1 } };
    if (method === 'updateStatus') return { state: 'idle' };
    if (method === 'jobs') return { version: 0, jobs: [] };
    if (method === 'agents' || method === 'commands') return [];
    if (method === 'cliAccounts') return { accounts: codexAccounts, selected: 'default' };
    if (method === 'addCliAccount') { codexAccounts.push({ id: `acc${codexAccounts.length}`, name: args[1].trim() || `Account ${codexAccounts.length + 1}` }); return codexAccounts; }
    if (method === 'removeCliAccount') { codexAccounts.splice(codexAccounts.findIndex(a => a.id === args[1]), 1); return codexAccounts; }
    if (method === 'cliOptions') return [];
    if (method === 'cliInfo') return { installed: args[0] !== 'local' || cli.localInstalled };
    if (method === 'cliAccountStatus' && args[0] === 'ssh:lab' && args[2] === 'antigravity' && cli.hostSignedIn) return { installed: true, signedIn: true, canSignIn: false };
    if (method === 'cliAccountStatus') return args[0] === 'local' && args[2] === 'codex' && cli.signedIn[args[3] ?? 'default']
      ? { installed: true, signedIn: true, canSignIn: true, identity: cli.signedIn[args[3] ?? 'default'], plan: 'pro', limits: [{ usedPercent: 42, windowMinutes: 300, resetsAt: Date.now() + 3600000 }, { usedPercent: 18, windowMinutes: 10080 }] }
      : { installed: true, signedIn: false, canSignIn: true };
    if (method === 'termOpenCli') return 7;
    if (method === 'cliSignIn') return (cli.signIn = Promise.withResolvers()).promise; // the browser's part: the test finishes or abandons it
    if (method === 'cliReadiness') return 'missing';
    if (method === 'prompt') return { disposition: args[3]?.interrupt ? 'started' : 'queued' };
    return null;
  });
  await page.addInitScript(() => {
    const listeners = new Set();
    window.fixtureEvent = event => { for (const listener of listeners) listener(event); };
    window.iris = { invoke: (...args) => window.fixtureInvoke(...args), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, pathForFile: () => '' };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('.session-row', { hasText: session.title }).click();
  await page.locator('.user-bubble', { hasText: 'Question 119' }).waitFor();
  const rows = await page.locator('.transcript-inner > .history-virtual-row').count();
  const mounted = await page.locator('.transcript-inner > .history-virtual-row[data-mounted="true"]').count();
  assert.ok(rows > 200 && mounted < rows / 2, `most rows are placeholders (${mounted} of ${rows} mounted)`);

  // ---- a reply streamed faster than frames arrives whole and in order
  const words = Array.from({ length: 400 }, (_, i) => `w${i} `);
  await page.evaluate(({ id, words }) => {
    const send = event => window.fixtureEvent({ channel: 'event', payload: { id, event } });
    window.fixtureEvent({ channel: 'status', payload: { id, status: 'connected', streaming: true } });
    send({ type: 'message_start', message: { role: 'assistant', timestamp: 5000 } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
    for (const delta of words) send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } });
  }, { id: session.id, words });
  const streamed = page.locator('.markdown.streaming');
  await streamed.waitFor();
  assert.equal((await streamed.innerText()).replace(/\s+/g, ' ').trim(), words.join('').trim(), 'every delta is shown, in order');

  // ---- text that arrives later leaves what is already written alone: the same nodes, and a selection in them stays
  await page.evaluate(() => {
    const first = document.querySelector('.markdown.streaming > p');
    window.firstBlock = first;
    const range = document.createRange(); range.selectNodeContents(first);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  const more = ['\n\n```js\nconst a', ' = 1;\n```\n\n', 'Second ', 'paragraph '];
  words.push(...more);
  for (const delta of more) {
    await page.evaluate(({ id, delta }) => window.fixtureEvent({ channel: 'event', payload: { id, event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } } } }), { id: session.id, delta });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  await streamed.locator('p', { hasText: 'Second paragraph' }).waitFor();
  assert.deepEqual(await page.evaluate(() => {
    const blocks = [...document.querySelector('.markdown.streaming').children];
    return { kept: blocks[0] === window.firstBlock, blocks: blocks.map(el => el.tagName === 'DIV' ? el.className : el.tagName), selected: getSelection().toString().slice(0, 8), code: document.querySelector('.markdown.streaming code.hljs').innerText.trim() };
  }), { kept: true, blocks: ['P', 'code-block', 'P'], selected: 'w0 w1 w2', code: 'const a = 1;' });

  // ---- a message sent with Option+Enter while the agent works is queued, not an interruption
  const input = page.locator('.dock textarea[aria-label="Message"]');
  await input.fill('Also update the README afterwards');
  await input.press('Alt+Enter');
  await page.locator('.user-row.queued', { hasText: 'Also update the README afterwards' }).waitFor();
  let prompt = ipcCalls.findLast(c => c.method === 'prompt');
  assert.deepEqual(prompt.args.slice(0, 2).concat(prompt.args[3]), [session.id, 'Also update the README afterwards', { interrupt: false }]);
  assert.equal(await streamed.count(), 1, 'the reply keeps streaming');
  await input.fill('Stop, do this instead');
  await input.press('Enter');
  await page.waitForFunction(() => document.querySelector('.dock textarea[aria-label="Message"]').value === '');
  prompt = ipcCalls.findLast(c => c.method === 'prompt');
  assert.deepEqual(prompt.args[3], { interrupt: true }, 'plain Enter still interrupts');

  // ---- the stream ends: deltas that were still waiting for a frame come before the final message
  await page.evaluate(({ id, text }) => {
    const send = event => window.fixtureEvent({ channel: 'event', payload: { id, event } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'tail' } });
    send({ type: 'message_end', message: { role: 'assistant', timestamp: 5000, stopReason: 'stop', content: [{ type: 'text', text: text + 'tail' }], usage: { input: 10, output: 400, cacheRead: 0, cacheWrite: 0, totalTokens: 410 } } });
    send({ type: 'agent_settled' });
    window.fixtureEvent({ channel: 'status', payload: { id, status: 'connected', streaming: false } });
  }, { id: session.id, text: words.join('') });
  await page.locator('.markdown', { hasText: 'Second paragraph tail' }).waitFor();
  assert.equal(await page.locator('.markdown.streaming').count(), 0);
  assert.equal(await page.evaluate(() => window.firstBlock.isConnected), true, 'nothing is rebuilt when the reply finishes either');
  assert.equal(await page.locator('.user-row.queued').count(), 0, 'the queue is cleared when the run settles');

  // ---- Find in conversation reaches rows that are not rendered and results inside folded steps
  await input.press('Meta+f');
  const find = page.locator('.session-find-bar input');
  await find.fill('needle-alpha');
  await page.locator('.find-count', { hasText: '1 / 1' }).waitFor();
  const hit = page.locator('.history-virtual-row.find-active-block');
  await hit.locator('.markdown', { hasText: 'needle-alpha' }).waitFor(); // scrolled to, so it mounted
  const box = await hit.boundingBox(), view = await page.locator('.transcript').boundingBox();
  assert.ok(box.y >= view.y && box.y + box.height <= view.y + view.height, 'the match is scrolled into view');
  await find.fill('needle-beta');
  await page.locator('.find-count', { hasText: '1 / 1' }).waitFor();
  assert.equal(await page.locator('.history-virtual-row.find-active-block').getAttribute('data-block-kind'), 'work', 'a tool result inside a folded step is found');
  await find.fill('登录逻辑');
  await page.locator('.find-count', { hasText: '1 / 1' }).waitFor();
  await find.fill('no such text anywhere');
  await page.locator('.find-count', { hasText: '0 results' }).waitFor();
  await find.press('Escape');

  // ---- Settings → Subscriptions: a card per plan says what is true on the chosen machine; machines come from the app's own menu
  await page.keyboard.press('Meta+,');
  assert.deepEqual((await page.locator('.settings-sidebar-nav button').allInnerTexts()).map(t => t.trim()), ['Subscriptions', 'Models', 'Connections', 'Usage'], 'sign-ins have a page of their own');
  await page.locator('.settings-sidebar-nav button', { hasText: 'Models' }).click();
  await page.locator('section[aria-label="API keys"]').waitFor();
  assert.equal(await page.locator('.cli-settings').count(), 0, 'API keys are apart from the subscriptions');
  await page.locator('.settings-sidebar-nav button', { hasText: 'Subscriptions' }).click();
  const agy = page.locator('.cli-settings');
  await agy.locator('.sub-state', { hasText: 'Not installed' }).first().waitFor();
  assert.deepEqual(await agy.locator('.sub-card-title').allInnerTexts(), ['Codex', 'Antigravity']);
  assert.equal(await agy.locator('select').count(), 0, 'no system pop-up menus');
  await agy.locator('.cli-machine').click();
  await page.locator('.menu-item', { hasText: 'Lab host' }).click();
  await agy.locator('.sub-state', { hasText: 'Not signed in' }).first().waitFor();
  assert.ok(ipcCalls.some(c => c.method === 'cliAccountStatus' && c.args[0] === 'ssh:lab' && c.args[2] === 'codex'), 'each CLI is checked by name');
  assert.equal(await agy.locator('button', { hasText: 'Add account' }).count(), 0, 'nothing to add an account to while signed out');
  // Antigravity on a host signs in with a link and a code: two steps on the page, and no terminal.
  const hostAgy = agy.locator('.sub-card', { has: page.locator('.sub-card-title', { hasText: 'Antigravity' }) });
  const signInLink = 'https://accounts.google.com/o/oauth2/auth?client_id=fixture&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback';
  const terminal = data => page.evaluate(data => window.fixtureEvent({ channel: 'term-data', payload: { id: 7, data } }), data);
  await hostAgy.locator('button', { hasText: 'Sign in with Google' }).click();
  await hostAgy.locator('.sub-flow', { hasText: 'Starting the sign-in on Lab host…' }).waitFor();
  assert.deepEqual(ipcCalls.findLast(c => c.method === 'termOpenCli').args.filter((_, i) => i !== 2 && i !== 3), ['ssh:lab', 'login', 'antigravity', null]);
  await terminal(`Open this link in a browser to log in with Google:\r\n\r\n  ${signInLink}\r\n\r\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\r\n`);
  const codeField = hostAgy.locator('.sub-flow.code input[aria-label="Authorization code"]');
  await codeField.waitFor();
  assert.equal(await hostAgy.locator('.cli-terminal-card, .cli-settings-terminal').count(), 0);
  assert.deepEqual(ipcCalls.filter(c => c.method === 'openExternal').map(c => c.args[0]), [signInLink], 'the page opens by itself, once');
  assert.equal(await hostAgy.locator('.sub-flow.code button', { hasText: 'Finish' }).isDisabled(), true, 'nothing to finish before a code is there');
  await codeField.fill(' 4/0Afixture-code ');
  await codeField.press('Enter');
  await hostAgy.locator('.sub-flow', { hasText: 'Finishing the sign-in…' }).waitFor();
  assert.deepEqual(ipcCalls.findLast(c => c.method === 'termWrite').args, [7, '4/0Afixture-code\r'], 'the code goes to the CLI as typed, without the spaces around it');
  // Google refuses it: said in words, with a way to start over (the CLI takes one code per link).
  await terminal('\r\ncouldn\'t log in: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."\r\n');
  await page.evaluate(() => window.fixtureEvent({ channel: 'term-exit', payload: { id: 7, exitCode: 1 } }));
  await hostAgy.locator('.sub-flow.failed', { hasText: 'That code was not accepted. Sign in again and paste the new code.' }).waitFor();
  await hostAgy.locator('.sub-flow.failed button', { hasText: 'Try again' }).click();
  await terminal(`Open this link in a browser to log in with Google:\r\n\r\n  ${signInLink}&attempt=2\r\n\r\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\r\n`);
  await codeField.waitFor();
  await codeField.fill('4/0Asecond-code');
  await hostAgy.locator('.sub-flow.code button', { hasText: 'Finish' }).click();
  cli.hostSignedIn = true;
  await terminal('Logged in as lab@example.test.\r\n');
  await page.evaluate(() => window.fixtureEvent({ channel: 'term-exit', payload: { id: 7, exitCode: 0 } }));
  await hostAgy.locator('.sub-who', { hasText: 'lab@example.test' }).waitFor();
  assert.equal(await hostAgy.locator('.sub-flow').count(), 0);
  // On this Mac, signed in: the row is the account (who, plan, how much of each limit is used).
  cli.localInstalled = true; cli.signedIn.default = 'dev@example.test';
  await agy.locator('.cli-machine').click();
  await page.locator('.menu-item', { hasText: 'This computer' }).click();
  const codex = agy.locator('.sub-card', { has: page.locator('.sub-card-title', { hasText: 'Codex' }) });
  await codex.locator('.sub-who', { hasText: 'dev@example.test' }).waitFor();
  assert.equal(await codex.locator('.sub-plan').innerText(), 'Pro plan');
  assert.deepEqual(await codex.locator('.sub-limit-name').allInnerTexts(), ['5-hour limit', 'Weekly limit']);
  assert.match(await codex.locator('.sub-limit-text').first().innerText(), /^42% used · resets /);
  assert.equal(await agy.locator('.cli-settings-terminal, .cli-terminal-card').count(), 0, 'usage is on the page, not in a terminal');
  // Codex can have more than one account; Antigravity cannot. Adding one starts its sign-in at once.
  assert.equal(await agy.locator('button', { hasText: 'Add account' }).count(), 1);
  await codex.locator('button', { hasText: 'Add account' }).click();
  await codex.locator('.sub-flow', { hasText: 'Opening ChatGPT sign-in' }).waitFor();
  assert.ok(ipcCalls.some(c => c.method === 'cliSignIn' && c.args[1] === 'codex' && c.args[2] === 'acc1'), 'the new account signs in on its own');
  await page.evaluate(() => window.fixtureEvent({ channel: 'cli-sign-in', payload: { environmentId: 'local', engine: 'codex', account: 'acc1', url: 'https://auth.example.test/authorize' } }));
  await codex.locator('.sub-flow', { hasText: 'Your browser has opened' }).waitFor();
  assert.deepEqual(await codex.locator('.sub-flow button').allInnerTexts(), ['Open again', 'Copy link', 'Cancel']);
  cli.signedIn.acc1 = 'work@example.test';
  cli.signIn.resolve({ installed: true, signedIn: true, canSignIn: true, identity: 'work@example.test', plan: 'team' });
  const work = codex.locator('.sub-account', { hasText: 'work@example.test' });
  await work.waitFor();
  assert.equal(await work.locator('button', { hasText: 'Remove' }).count(), 1);
  assert.equal(await codex.locator('.sub-flow').count(), 0);
  const checksOfWork = () => ipcCalls.filter(c => c.method === 'cliAccountStatus' && c.args[3] === 'acc1').length;
  const before = checksOfWork();
  await page.waitForTimeout(600);
  assert.equal(checksOfWork(), before, 'a row is not checked again whenever the page re-renders');
  // Giving up a sign-in leaves no empty account behind.
  await codex.locator('button', { hasText: 'Add account' }).click();
  await codex.locator('.sub-flow button', { hasText: 'Cancel' }).click();
  assert.ok(ipcCalls.some(c => c.method === 'cliSignInCancel' && c.args[2] === 'acc2'));
  cli.signIn.reject(new Error('Sign-in cancelled.'));
  await page.waitForFunction(() => document.querySelectorAll('.sub-card')[0].querySelectorAll('.sub-account').length === 2);
  assert.ok(ipcCalls.some(c => c.method === 'removeCliAccount' && c.args[1] === 'acc2'));
  if (process.env.IRIS_UI_SHOT) await page.screenshot({ path: process.env.IRIS_UI_SHOT });
  await page.keyboard.press('Escape');

  // ---- after an update there is nothing to click: the row is gone once conversations have been restarted
  const updateRow = page.locator('.sidebar-update');
  await page.evaluate(() => window.fixtureEvent({ channel: 'session-update', payload: { state: 'restarting', version: '9.9.9', restarted: 0, failures: 0 } }));
  await updateRow.locator('[role=status]', { hasText: 'Restarting…' }).waitFor();
  await page.evaluate(() => window.fixtureEvent({ channel: 'session-update', payload: { state: 'complete', version: '9.9.9', restarted: 2, failures: 0 } }));
  await page.waitForFunction(() => !document.querySelector('.sidebar-update')?.children.length);
  assert.equal(await page.locator('.toast').count(), 0, 'an update that went well says nothing');
  // Only a restart that failed is mentioned, once, as a notice that goes away by itself.
  await page.evaluate(() => window.fixtureEvent({ channel: 'session-update', payload: { state: 'complete', version: '9.9.9', restarted: 1, failures: 1 } }));
  await page.locator('.toast.error', { hasText: 'Iris 9.9.9 is installed, with one issue.' }).waitFor();
  assert.equal(await updateRow.locator('button').count(), 0);
  await page.locator('.toast-action', { hasText: 'Details' }).click();
  assert.ok(ipcCalls.some(c => c.method === 'sessionUpdateTold') && ipcCalls.some(c => c.method === 'showSessionUpdateReport'));

  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS built renderer: streamed reply applied once per frame, queued message with Option+Enter, Find in conversation across unrendered rows and folded steps');
} catch (error) {
  console.error('FAIL', error.message, errors.length ? `\npage errors: ${errors.join(' | ')}` : '');
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.close();
}
