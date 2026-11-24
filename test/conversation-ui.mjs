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
    if (method === 'addCliAccount') { codexAccounts.push({ id: `acc${codexAccounts.length}`, name: args[1].trim() }); return codexAccounts; }
    if (method === 'cliOptions') return [];
    if (method === 'cliInfo') return { installed: args[0] !== 'local' };
    if (method === 'cliAccountStatus') return { installed: true, signedIn: false, canSignIn: false };
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
  await page.locator('.markdown', { hasText: 'w399 tail' }).waitFor();
  assert.equal(await page.locator('.markdown.streaming').count(), 0);
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

  // ---- Settings → Models → Subscriptions: a row per CLI says what is true on the chosen machine; machines come from the app's own menu
  await page.keyboard.press('Meta+,');
  assert.deepEqual((await page.locator('.settings-sidebar-nav button').allInnerTexts()).map(t => t.trim()), ['Models', 'Connections', 'Usage'], 'sign-ins live with the models');
  await page.locator('.settings-sidebar-nav button', { hasText: 'Models' }).click();
  await page.locator('section[aria-label="API keys"]').waitFor();
  const agy = page.locator('.cli-settings');
  await agy.locator('.cli-setting-desc', { hasText: 'Not installed on This computer' }).first().waitFor();
  assert.deepEqual((await agy.locator('.cli-setting-text > span:first-child').allInnerTexts()).filter(t => !t.startsWith('Another')), ['Machine', 'Antigravity CLI', 'Codex CLI', 'Antigravity: ask before running tools']);
  assert.equal(await agy.locator('select').count(), 0, 'no system pop-up menus');
  await agy.locator('.cli-machine').click();
  await page.locator('.menu-item', { hasText: 'Lab host' }).click();
  await agy.locator('.cli-setting-desc', { hasText: 'Installed · not signed in' }).first().waitFor();
  assert.ok(ipcCalls.some(c => c.method === 'cliAccountStatus' && c.args[0] === 'ssh:lab' && c.args[2] === 'codex'), 'each CLI is checked by name');
  // Codex can have more than one account; Antigravity cannot, so only Codex offers to add one.
  await agy.locator('button', { hasText: 'Add account' }).click();
  await agy.locator('input[aria-label="Account name"]').fill('Work');
  await agy.locator('button', { hasText: /^Add$/ }).click();
  await agy.locator('.cli-setting-text', { hasText: 'Codex · Work' }).waitFor();
  assert.equal(await agy.locator('button', { hasText: 'Add account' }).count(), 1);
  assert.ok(ipcCalls.some(c => c.method === 'cliAccountStatus' && c.args[2] === 'codex' && c.args[3] === 'acc1'), 'the new account is checked on its own');
  assert.equal(await agy.locator('.cli-setting-row', { hasText: 'Codex · Work' }).locator('button', { hasText: 'Remove' }).count(), 1);
  if (process.env.IRIS_UI_SHOT) await page.screenshot({ path: process.env.IRIS_UI_SHOT });
  await page.keyboard.press('Escape');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS built renderer: streamed reply applied once per frame, queued message with Option+Enter, Find in conversation across unrendered rows and folded steps');
} catch (error) {
  console.error('FAIL', error.message, errors.length ? `\npage errors: ${errors.join(' | ')}` : '');
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.close();
}
