// Built renderer in a browser, with the desktop bridge stubbed: a reply streamed faster than frames,
// Find in conversation across rows that are not rendered, and a message queued while the agent works.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const session = { id: 'talk', title: 'Trace the login flow', environmentId: 'local', environmentLabel: 'This computer', project: 'web', cwd: '/tmp/web', status: 'connected', engine: 'iris', model: { provider: 'mock', id: 'mock' } };
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
    if (method === 'catalog') return [{ provider: 'mock', id: 'mock', name: 'Offline fixture', api: 'openai-responses', engines: ['iris'], input: ['text'], reasoning: true, speeds: [] }];
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
    if (method === 'termOpen') { if (cli.termFails) { cli.termFails = false; throw new Error('Could not connect to Lab host'); } return 41; }
    if (method === 'usageSummary') {
      const key = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const today = new Date(), yesterday = new Date(Date.now() - 86400000);
      return { totals: { tokens: 406_700_000, input: 8_900_000, cacheRead: 396_600_000, cacheWrite: 0, output: 1_200_000 }, today: key(today),
        days: { [key(today)]: 227_900_000, [key(yesterday)]: 176_600_000 }, models: [{ provider: 'antigravity', model: 'gemini-4-neon', tokens: 178_500_000 }] };
    }
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

  // ---- a turn the agent says nothing in: after a while the line says how long, after minutes that it may be stuck,
  // with Stop and Restart
  await page.evaluate(({ id }) => {
    const send = event => window.fixtureEvent({ channel: 'event', payload: { id, event } });
    window.fixtureEvent({ channel: 'status', payload: { id, status: 'connected', streaming: true } });
    send({ type: 'message_start', message: { role: 'assistant', timestamp: Date.now() } });
  }, { id: session.id });
  await page.locator('div.working').waitFor();
  await page.evaluate(() => window.__irisState()); // (the turn's start taken up before the clock is moved on)
  // (the page's clock moved on, as if that much time had passed)
  const later = ms => page.evaluate(ms => { const real = window.__realNow ??= Date.now.bind(Date); Date.now = () => real() + ms; }, ms);
  await later(20000);
  await page.locator('div.working', { hasText: /Waiting for the model/ }).waitFor({ timeout: 3000 });
  assert.doesNotMatch(await page.locator('div.working').innerText(), /no output/, 'a wait is said in words, not counted as "no output"');
  await later(200000);
  const stalled = page.locator('div.working.stalled');
  await stalled.waitFor({ timeout: 3000 });
  assert.match(await stalled.innerText(), /No output for 3m \d+s\. .* may be stuck\./);
  await stalled.getByRole('button', { name: 'Restart' }).click();
  for (let i = 0; i < 50 && !ipcCalls.some(c => c.method === 'restartConversation'); i++) await page.waitForTimeout(20);
  assert.deepEqual(ipcCalls.findLast(c => c.method === 'restartConversation')?.args, [session.id]);
  await page.evaluate(() => { Date.now = window.__realNow; });
  await page.evaluate(({ id }) => {
    const send = event => window.fixtureEvent({ channel: 'event', payload: { id, event } });
    send({ type: 'message_end', message: { role: 'assistant', timestamp: Date.now(), stopReason: 'stop', content: [{ type: 'text', text: 'Back.' }] } });
    send({ type: 'agent_settled' });
    window.fixtureEvent({ channel: 'status', payload: { id, status: 'connected', streaming: false } });
  }, { id: session.id });

  // ---- hand the conversation to another agent: a new conversation in the same folder, its message written
  await page.locator('.session-row', { hasText: session.title }).first().hover();
  await page.locator('.session-row', { hasText: session.title }).first().getByRole('button', { name: 'Conversation actions' }).click();
  await page.getByRole('button', { name: 'Hand off to another agent…' }).click();
  const dialog = page.locator('.handoff');
  await dialog.waitFor();
  assert.deepEqual((await dialog.locator('.handoff-engine').allInnerTexts()).map(t => t.trim().split('\n')[0]), ['Iris', 'Claude Code', 'Codex', 'Cursor', 'Antigravity'], 'every agent, this one first (a new conversation of it: another account or model)');
  assert.match(await dialog.locator('.handoff-engine').first().innerText(), /New conversation/);
  await dialog.getByRole('radio', { name: 'Review the work' }).click();
  await dialog.locator('.handoff-engine', { hasText: 'Codex' }).click();
  const handed = page.locator('.dock textarea[aria-label="Message"]');
  await page.waitForFunction(() => /^Please review the work Iris did in /.test(document.querySelector('.dock textarea[aria-label="Message"]')?.value ?? ''));
  assert.match(await handed.inputValue(), /What was asked:\n- /);
  assert.match(await handed.inputValue(), /do not edit files unless I ask\.$/);
  await handed.fill('');
  await page.locator('.session-row', { hasText: session.title }).first().click();
  await page.locator('.user-bubble', { hasText: 'Question 119' }).first().waitFor({ timeout: 10000 }).catch(() => {});

  // ---- a reload while a CLI's turn is under way (opening the conversation again, a resync) keeps what is known
  // of its finished steps: only the step still running shows as running
  await page.evaluate(({ id }) => {
    const send = event => window.fixtureEvent({ channel: 'event', payload: { id, event } });
    window.fixtureEvent({ channel: 'status', payload: { id, status: 'connected', streaming: true } });
    const call = (i, cid, command) => {
      send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: i, id: cid, toolName: 'bash' } });
      send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: i, toolCall: { type: 'toolCall', id: cid, name: 'bash', arguments: { command } } } });
      send({ type: 'tool_execution_start', toolCallId: cid, toolName: 'bash', args: { command } });
    };
    send({ type: 'message_start', message: { role: 'assistant', timestamp: 9000 } });
    call(0, 'done-1', 'ls');
    send({ type: 'tool_execution_end', toolCallId: 'done-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'a' }] }, isError: false });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 1 } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Listed; now building.' } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: 'Listed; now building.' } });
    call(2, 'busy-1', 'make');
  }, { id: session.id });
  await page.locator('.markdown', { hasText: 'Listed; now building.' }).waitFor();
  const spinning = () => page.evaluate(() => [...document.querySelectorAll('.tool-group')].slice(-2).map(g => !!g.querySelector('.tool-group-head .shimmer')));
  await page.waitForFunction(() => document.querySelectorAll('.tool-group').length >= 2);
  assert.deepEqual(await spinning(), [false, true]);
  const loads = ipcCalls.filter(c => c.method === 'historyPage').length;
  await page.evaluate(({ id }) => window.fixtureEvent({ channel: 'resync', payload: { id } }), { id: session.id });
  for (let i = 0; i < 100 && ipcCalls.filter(c => c.method === 'historyPage').length === loads; i++) await page.waitForTimeout(20);
  await page.waitForTimeout(200);
  assert.deepEqual(await spinning(), [false, true], 'the finished step stays finished after the reload');
  assert.match(await page.locator('.tool-group').last().locator('.group-summary').innerText(), /^Running make/, 'a step under way is named: a long command does not read as the agent having stopped');
  // A command still running that began before others finished is listed after them, where the latest step is.
  await page.evaluate(({ id }) => {
    const send = event => window.fixtureEvent({ channel: 'event', payload: { id, event } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 3, id: 'quick-1', toolName: 'bash' } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 3, toolCall: { type: 'toolCall', id: 'quick-1', name: 'bash', arguments: { command: 'tail -5 build.log' } } } });
    send({ type: 'tool_execution_start', toolCallId: 'quick-1', toolName: 'bash', args: { command: 'tail -5 build.log' } });
    send({ type: 'tool_execution_end', toolCallId: 'quick-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false });
  }, { id: session.id });
  await page.locator('.tool-group').last().locator('.tool-group-head').click();
  const order = await page.locator('.tool-group').last().locator('.work-body .step-text').allInnerTexts();
  assert.deepEqual(order.map(t => t.trim()), ['tail -5 build.log', 'make'], 'finished first, running last');
  await page.evaluate(({ id }) => {
    const send = event => window.fixtureEvent({ channel: 'event', payload: { id, event } });
    send({ type: 'tool_execution_end', toolCallId: 'busy-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false });
    send({ type: 'message_end', message: { role: 'assistant', timestamp: 9000, stopReason: 'stop', content: [{ type: 'text', text: 'Listed; now building.' }] } });
    send({ type: 'agent_settled' });
    window.fixtureEvent({ channel: 'status', payload: { id, status: 'connected', streaming: false } });
  }, { id: session.id });

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
  assert.deepEqual((await page.locator('.settings-sidebar-nav button').allInnerTexts()).map(t => t.trim()), ['Subscriptions', 'Cursor', 'Models', 'Connections', 'Translation', 'Usage'], 'sign-ins have a page of their own');
  await page.locator('.settings-sidebar-nav button', { hasText: 'Models' }).click();
  await page.locator('section[aria-label="API keys"]').waitFor();
  assert.equal(await page.locator('.cli-settings').count(), 0, 'API keys are apart from the subscriptions');
  await page.locator('.settings-sidebar-nav button', { hasText: 'Subscriptions' }).click();
  const agy = page.locator('.cli-settings');
  await agy.locator('.sub-state', { hasText: 'Not installed' }).first().waitFor();
  assert.deepEqual(await agy.locator('.sub-card-title').allInnerTexts(), ['Codex', 'Antigravity', 'Cursor']);
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

  // ---- one mark for work in progress, on the line under the turn, which stays there from the turn's start to its
  // end; what it shows says what is going on: three dots turning while the model thinks, circling in a row while it
  // writes, four dots changing places while a step runs. A step under way has no mark of its own: its words shimmer.
  // (The line used to step aside while a step ran: with short commands the end of the conversation jumped.)
  await page.keyboard.press('Escape');
  const marks = () => page.evaluate(() => ({ line: [...document.querySelectorAll('.session-main .working .spinner')].map(el => `${el.dataset.kind}:${el.children.length}`),
    step: [...document.querySelectorAll('.session-main .tool-group-head .spinner, .session-main .step-head .spinner')].map(el => `${el.dataset.kind}:${el.children.length}`),
    shimmering: [...document.querySelectorAll('.session-main .tool-group-head .shimmer')].map(el => el.innerText.trim()),
    label: document.querySelector('.session-main .working .shimmer')?.innerText.trim() ?? null,
    lineTop: Math.round(document.querySelector('.session-main .working')?.getBoundingClientRect().top ?? -1) }));
  const fire = events => page.evaluate(({ id, events }) => { for (const event of events) { if (event.status) window.fixtureEvent({ channel: 'status', payload: { id, ...event.status } }); else window.fixtureEvent({ channel: 'event', payload: { id, event } }); } }, { id: session.id, events });
  const call = (id, name, args, index) => [{ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: index, id, toolName: name } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: index, toolCall: { type: 'toolCall', id, name, arguments: args } } },
    { type: 'tool_execution_start', toolCallId: id, toolName: name, args }];
  const done = (id, name) => ({ type: 'tool_execution_end', toolCallId: id, toolName: name, result: { content: [{ type: 'text', text: 'ok' }] }, isError: false });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60)))));
  await fire([{ status: { status: 'connected', streaming: true } }, { type: 'agent_start' }, { type: 'message_start', message: { role: 'assistant', timestamp: Date.now(), content: [] } }]);
  await page.getByRole('button', { name: 'Latest' }).click().catch(() => {}); // (Find left the page on an earlier turn)
  await page.locator('.session-main .working .spinner').waitFor();
  assert.deepEqual((({ line, step, label }) => ({ line, step, label }))(await marks()), { line: ['tumble:3'], step: [], label: 'Thinking' }, 'thinking: three dots turning, under the conversation');
  await fire(call('mark-read', 'read', { path: '/work/README.md' }, 0));
  await page.locator('.session-main .tool-group-head .shimmer').waitFor();
  await settle();
  const reading = await marks();
  assert.deepEqual((({ line, step, label }) => ({ line, step, label }))(reading), { line: ['swap:4'], step: [], label: 'Working' }, 'a step under way: the line stays, its mark turns to four dots; the step has no mark of its own');
  assert.equal(reading.shimmering.length, 1, 'the step under way shimmers');
  await fire([done('mark-read', 'read'), ...call('mark-bash', 'bash', { command: 'npm test' }, 1)]);
  await settle();
  const commanding = await marks();
  assert.deepEqual((({ line, step }) => ({ line, step }))(commanding), { line: ['swap:4'], step: [] }, 'a command is a step like any other');
  assert.match(commanding.shimmering.join(' '), /npm test/, 'the step names itself on its own line');
  await fire([done('mark-bash', 'bash')]);
  await page.locator('.session-main .working .spinner[data-kind="tumble"]').waitFor();
  const between = await marks();
  assert.deepEqual((({ line, step, shimmering }) => ({ line, step, shimmering }))(between), { line: ['tumble:3'], step: [], shimmering: [] }, 'between steps the model is thinking again');
  assert.equal(between.lineTop, commanding.lineTop, 'the line under the turn did not move as the step ended');
  await fire([{ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 2 } }, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 2, delta: 'Done with ' } }]);
  await page.locator('.session-main .working .spinner.orbit').waitFor();
  assert.deepEqual((({ line, step }) => ({ line, step }))(await marks()), { line: ['orbit:3'], step: [] }, 'writing: the three dots circle in a row');
  await fire([{ type: 'message_end', message: { role: 'assistant', timestamp: Date.now(), stopReason: 'stop', content: [{ type: 'toolCall', id: 'mark-read', name: 'read', arguments: { path: '/work/README.md' } }, { type: 'toolCall', id: 'mark-bash', name: 'bash', arguments: { command: 'npm test' } }, { type: 'text', text: 'Done with both.' }] } },
    { type: 'agent_settled' }, { status: { status: 'connected', streaming: false } }]);
  await page.locator('.markdown', { hasText: 'Done with both.' }).waitFor();
  assert.deepEqual((({ line, step, shimmering }) => ({ line, step, shimmering }))(await marks()), { line: [], step: [], shimmering: [] }, 'finished: no mark anywhere');

  // A turn whose task list was left with a step under way, then a turn in which the agent starts a long command
  // and writes on while it runs (Antigravity): the old list does not turn, the step's line says it is still
  // running without its moving mark, and the line under the turn names the command, not "Writing".
  await fire([{ type: 'message_end', message: { role: 'assistant', timestamp: Date.now(), stopReason: 'aborted', content: [{ type: 'toolCall', id: 'old-plan', name: 'TodoWrite', arguments: { todos: [{ content: 'Check the build', status: 'completed' }, { content: 'Run the benchmark', status: 'in_progress' }] } }] } }]);
  await fire([{ status: { status: 'connected', streaming: true } }, { type: 'agent_start' }, { type: 'message_start', message: { role: 'assistant', timestamp: Date.now(), content: [] } },
    ...call('bench', 'bash', { command: 'python bench.py --cards 64', description: 'Run the 64-card benchmark' }, 0),
    { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 1 } }, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Started the benchmark; results follow.' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: 'Started the benchmark; results follow.' } }]);
  await page.locator('.markdown', { hasText: 'Started the benchmark' }).waitFor();
  await page.waitForTimeout(3200); // (the text has stood still: nothing is being written)
  await page.waitForFunction(() => /Run the 64-card benchmark/.test(document.querySelector('.session-main .working')?.innerText ?? ''), undefined, { timeout: 5000 });
  assert.doesNotMatch(await page.locator('.session-main .working').innerText(), /Writing/);
  const head = page.locator('.session-main .tool-group-head', { hasText: 'Run the 64-card benchmark' }).last();
  assert.match(await head.innerText(), /still running/);
  assert.equal(await head.locator('.spinner').count(), 0, 'the moving mark is on the line under the turn, not on a step above what came after it');
  const oldPlan = page.locator('.cc-todo-card[data-tool-id="old-plan"]');
  assert.equal(await oldPlan.locator('.spinner').count(), 0, 'a list of a turn that is over does not turn');
  await fire([done('bench', 'bash'), { type: 'message_end', message: { role: 'assistant', timestamp: Date.now(), stopReason: 'stop', content: [{ type: 'toolCall', id: 'bench', name: 'bash', arguments: { command: 'python bench.py --cards 64', description: 'Run the 64-card benchmark' } }, { type: 'text', text: 'Started the benchmark; results follow.' }] } },
    { type: 'agent_settled' }, { status: { status: 'connected', streaming: false } }]);

  // A long command, with settings before it and a program by its full path: named short, on one line, with the
  // time beside it.
  const longCommand = 'OMP_NUM_THREADS=4 LPKERNELS_REPO=/home/me/AgentLP/LPKernels PYTHONPATH=.:../lpdecode-prefill-transfer:/home/me/ds41-critical/python-check /home/me/AgentLP/build/runtime-qwen-demo-20261101/bin/python -m pytest -q -rs tests/test_transfer.py tests/test_cache.py';
  await fire([{ status: { status: 'connected', streaming: true } }, { type: 'agent_start' }, { type: 'message_start', message: { role: 'assistant', timestamp: Date.now(), content: [] } },
    ...call('pytest', 'bash', { command: longCommand }, 0),
    { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 1 } }, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'The tests run; meanwhile the routing is checked.' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: 'The tests run; meanwhile the routing is checked.' } }]);
  await page.waitForTimeout(3200);
  const line = page.locator('.session-main .working');
  await page.waitForFunction(() => /python -m pytest/.test(document.querySelector('.session-main .working')?.innerText ?? ''), undefined, { timeout: 5000 });
  assert.match(await line.innerText(), /^Running python -m pytest -q -rs/, 'the settings before it and the program’s folder are left out');
  const lineBox = await line.evaluate(el => ({ label: el.querySelector('.shimmer').getBoundingClientRect().height, meta: Math.max(...[...el.querySelectorAll('.working-meta')].map(m => m.getBoundingClientRect().height)) }));
  assert.ok(lineBox.label < 30 && lineBox.meta < 30, `the command and its time each on one line (${JSON.stringify(lineBox)})`);
  await fire([done('pytest', 'bash'), { type: 'message_end', message: { role: 'assistant', timestamp: Date.now(), stopReason: 'stop', content: [{ type: 'toolCall', id: 'pytest', name: 'bash', arguments: { command: longCommand } }, { type: 'text', text: 'The tests run; meanwhile the routing is checked.' }] } },
    { type: 'agent_settled' }, { status: { status: 'connected', streaming: false } }]);

  // The plan the stopped run left is the plan as it stands: once you write again it stands under your message, at the
  // end of the latest turn (as Claude Code shows its list again), still: no moving mark, the step's ring at rest.
  // (Read with motion on: the page is run with reduced motion, which stops every animation.)
  const dots = async locator => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    try { return await locator.locator('.cc-todo-dot.active').evaluateAll(els => els.map(el => getComputedStyle(el).animationName)); }
    finally { await page.emulateMedia({ reducedMotion: 'reduce' }); }
  };
  assert.deepEqual(await dots(oldPlan), ['none'], 'the step under way of a stopped plan is at rest');
  // (The runs after it finished: it stays where it was left. A run stopped now leaves the plan as it stands.)
  await fire([{ status: { status: 'connected', streaming: true } }, { type: 'agent_start' }, { type: 'message_start', message: { role: 'assistant', timestamp: Date.now(), content: [] } },
    ...call('stopped-plan', 'TodoWrite', { todos: [{ content: 'Check the build', status: 'completed' }, { content: 'Run the benchmark', status: 'in_progress' }] }, 0), done('stopped-plan', 'TodoWrite'),
    { type: 'message_end', message: { role: 'assistant', timestamp: Date.now(), stopReason: 'aborted', content: [{ type: 'toolCall', id: 'stopped-plan', name: 'TodoWrite', arguments: { todos: [{ content: 'Check the build', status: 'completed' }, { content: 'Run the benchmark', status: 'in_progress' }] } }] } },
    { type: 'agent_settled' }, { status: { status: 'connected', streaming: false } }]);
  await page.locator('.cc-todo-card[data-tool-id="stopped-plan"]').waitFor();
  await fire([{ type: 'message_end', message: { role: 'user', timestamp: Date.now(), content: [{ type: 'text', text: 'Reply in Chinese from now on' }] } },
    { status: { status: 'connected', streaming: true } }, { type: 'agent_start' }, { type: 'message_start', message: { role: 'assistant', timestamp: Date.now(), content: [] } }]);
  await page.locator('.user-bubble', { hasText: 'Reply in Chinese from now on' }).waitFor();
  await settle();
  assert.equal(await page.evaluate(() => {
    const bubble = [...document.querySelectorAll('.user-bubble')].findLast(el => el.textContent.includes('Reply in Chinese from now on'));
    const after = [...document.querySelectorAll('.cc-todo-card')].filter(card => bubble.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING);
    const before = [...document.querySelectorAll('.cc-todo-card')].filter(card => !after.includes(card));
    // (The old list stays where its run left it: that run, begun by the agent with no message between, is a turn of its own.)
    return JSON.stringify({ after: after.map(c => c.dataset.toolId), before: before.map(c => c.dataset.toolId) });
  }), JSON.stringify({ after: ['stopped-plan'], before: ['old-plan'] }), 'the plan is shown once, under the latest message');
  assert.match(await page.locator('.run-continued').first().innerText(), /^Continued$/, 'a run the agent began itself says so, in a quiet line');
  const stoppedPlan = page.locator('.cc-todo-card[data-tool-id="stopped-plan"]');
  assert.equal(await stoppedPlan.locator('.spinner').count(), 0, 'a run that is not carrying it out does not turn it');
  assert.deepEqual(await dots(stoppedPlan), ['none']);
  // The agent takes the plan up again: its new list is the one being carried out, and turns while it works.
  await fire([...call('new-plan', 'TodoWrite', { todos: [{ content: 'Check the build', status: 'completed' }, { content: 'Run the benchmark', status: 'in_progress', activeForm: 'Running the benchmark' }] }, 0)]);
  const newPlan = page.locator('.cc-todo-card[data-tool-id="new-plan"]');
  await newPlan.locator('.spinner').waitFor();
  await fire([done('new-plan', 'TodoWrite'), { type: 'message_end', message: { role: 'assistant', timestamp: Date.now(), stopReason: 'aborted', content: [{ type: 'toolCall', id: 'new-plan', name: 'TodoWrite', arguments: { todos: [{ content: 'Check the build', status: 'completed' }, { content: 'Run the benchmark', status: 'in_progress' }] } }] } },
    { type: 'agent_settled' }, { status: { status: 'connected', streaming: false } }]);
  await page.waitForFunction(() => !document.querySelector('.cc-todo-card[data-tool-id="new-plan"] .spinner'));
  assert.deepEqual(await dots(newPlan), ['none'], 'stopped: at rest');
  // A run after it that finishes (the agent answering something else, its plan not brought up to date): the plan no
  // longer follows the conversation, it stays where it was left.
  await fire([{ type: 'message_end', message: { role: 'user', timestamp: Date.now(), content: [{ type: 'text', text: 'What was the problem?' }] } },
    { status: { status: 'connected', streaming: true } }, { type: 'agent_start' }, { type: 'message_start', message: { role: 'assistant', timestamp: Date.now(), content: [] } },
    { type: 'message_end', message: { role: 'assistant', timestamp: Date.now(), stopReason: 'stop', content: [{ type: 'text', text: 'The benchmark hung on card 3.' }] } },
    { type: 'agent_settled' }, { status: { status: 'connected', streaming: false } }]);
  await page.locator('.markdown', { hasText: 'The benchmark hung on card 3.' }).waitFor();
  await settle();
  assert.equal(await page.evaluate(() => {
    const bubble = [...document.querySelectorAll('.user-bubble')].findLast(el => el.textContent.includes('What was the problem?'));
    return [...document.querySelectorAll('.cc-todo-card')].filter(card => bubble.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).length;
  }), 0, 'a plan does not follow the conversation once a later run has finished');
  assert.equal(await newPlan.count(), 1, 'it is still there, where it was left');

  // A shell that cannot be opened says why in the terminal, and Enter tries again.
  cli.termFails = true;
  await page.locator('.transcript').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Control+Backquote');
  await page.locator('.terminal-panel .xterm-rows', { hasText: 'could not open a shell' }).waitFor();
  assert.match(await page.locator('.terminal-panel .xterm-rows').innerText(), /Could not connect to Lab host/);
  await page.locator('.terminal-panel .xterm-screen').click();
  await page.keyboard.press('Enter');
  for (let i = 0; i < 100 && ipcCalls.filter(c => c.method === 'termOpen').length < 2; i++) await page.waitForTimeout(20);
  assert.equal(ipcCalls.filter(c => c.method === 'termOpen').length, 2, 'Enter opens the shell again');
  await page.keyboard.press('Control+Backquote');
  await page.locator('.terminal-panel').waitFor({ state: 'detached' });

  // Settings → Usage: the tip over a day at either end of the graph stays inside it; the pane grows no scroll bars.
  await page.keyboard.press('Meta+Comma');
  await page.locator('.settings-page-root').waitFor();
  await page.locator('.settings-page-root').getByRole('button', { name: 'Usage', exact: true }).click();
  await page.locator('.heatmap').waitFor();
  for (const which of ['last', 'first']) {
    const cell = page.locator('.heat-cell:not(.future)')[which]();
    await cell.hover();
    await page.locator('.heat-tip').waitFor();
    const fit = await page.evaluate(() => {
      const tip = document.querySelector('.heat-tip').getBoundingClientRect(), map = document.querySelector('.heatmap').getBoundingClientRect();
      const pane = document.querySelector('.settings-content');
      return { inside: tip.left >= map.left - 0.5 && tip.right <= map.right + 0.5, wide: pane.scrollWidth > pane.clientWidth };
    });
    assert.deepEqual(fit, { inside: true, wide: false }, `the tip over the ${which} day stays inside the graph`);
    await page.mouse.move(5, 5);
  }
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
