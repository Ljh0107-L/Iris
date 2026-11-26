// Real-CLI acceptance: the app driven against the real Codex (and, with --cursor, the real Cursor CLI), for what
// stand-ins cannot show: questions asked without stopping, long commands, agents, stopping and steering a
// turn, visuals, restarting. It uses YOUR signed-in accounts and spends real model calls, so it never runs in
// CI or in `npm test`: run it by hand, before a release, when you mean to.
//
//   IRIS_REAL_CLI=1 node test/real-cli.mjs [--cursor] [--shots DIR]
//
// The app runs with an isolated profile in /tmp (its own settings and history); only Codex's sign-in is shared:
// the profile's Codex home is a link to Iris's own (~/Library/Application Support/Iris/cli-accounts/codex/default),
// so Codex needs no new sign-in and its auth file is never copied. Cursor keeps its sign-in in the Keychain.
// Each check prints PASS or FAIL; the run ends with the count. The link and the profile are removed at the end.
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launch, shot } from './harness.mjs';

if (process.env.IRIS_REAL_CLI !== '1') { console.error('This uses your real Codex (and Cursor) accounts. Run it with IRIS_REAL_CLI=1.'); process.exit(2); }
const args = process.argv.slice(2);
const withCursor = args.includes('--cursor');
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : join('/tmp', 'iris-real-cli-shots');
const profile = '/tmp/iris-real-cli', work = '/tmp/iris-real-cli-work';
const codexHome = join(homedir(), 'Library/Application Support/Iris/cli-accounts/codex/default');
const link = join(profile, 'cli-accounts/codex/default');
if (!existsSync(join(codexHome, 'auth.json'))) { console.error(`Sign in to Codex in Iris first (no ${codexHome}/auth.json).`); process.exit(2); }

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const cleanup = () => { try { if (lstatSync(link).isSymbolicLink()) unlinkSync(link); } catch { /* not made */ } rmSync(profile, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); };
cleanup();
mkdirSync(join(profile, 'cli-accounts/codex'), { recursive: true });
symlinkSync(codexHome, link);
mkdirSync(work, { recursive: true });
writeFileSync(join(work, 'calc.py'), 'def add(a, b):\n    return a + b\n');

const { app, page } = await launch({ userData: profile, width: 1500, height: 950, env: { IRIS_TEST_REAL_CLI: '1', IRIS_TEST_SAVE_DIR: work } });
const S = name => shot(page, shots, name);
const box = () => page.locator('.dock textarea[aria-label="Message"]');
const send = async (text, keys = 'Enter') => { await box().fill(text); await box().press(keys); };
const settled = (timeout = 240000) => page.waitForFunction(() => !document.querySelector('.composer [aria-label="Stop"], .send-button.stop') && !document.querySelector('div.working') && !document.querySelector('.tool-group-head .spinner'), undefined, { timeout });
const open = async (engine, title) => {
  const s = await page.evaluate(({ engine, work, title }) => window.iris.invoke('createSession', { environmentId: 'local', cwd: work, engine, prompt: title, creationId: `pending:${title}` }), { engine, work, title });
  await page.locator('.session-row', { hasText: s.title }).first().click({ timeout: 30000 });
  await box().waitFor();
  return s;
};
const texts = sel => page.evaluate(sel => [...document.querySelectorAll(sel)].map(e => e.innerText), sel);

try {
  await page.getByRole('button', { name: 'Conversation details' }).click().catch(() => {});
  await open('codex', 'Real check');
  const panel = page.getByRole('button', { name: 'Conversation details' });
  if ((await panel.getAttribute('aria-pressed').catch(() => null)) !== 'true') await panel.click().catch(() => {});

  // A question asked without stopping, and a long command named while it runs.
  await send('Use your non-blocking question tool (request_user_input_async) to ask me whether add() in calc.py should accept strings, with two options. Without waiting, run `sleep 25 && echo done` in the shell, then reply in one sentence.');
  const card = await page.locator('.question-card').waitFor({ timeout: 120000 }).then(() => true, () => false);
  check('a question asked without stopping is a card', card);
  const running = await page.locator('.tool-group-head', { hasText: /^Running sleep 25/ }).waitFor({ timeout: 60000 }).then(() => true, () => false);
  check('a long command is named while it runs', running);
  await S('real-1-question');
  await settled();
  if (card) {
    await page.locator('.question-option').last().click();
    const answered = await page.waitForFunction(() => document.querySelectorAll('.user-bubble').length >= 2, undefined, { timeout: 30000 }).then(() => true, () => false);
    check('an answer is a message of its own', answered);
    await settled();
  }

  // An agent and a long command, stopped by a message: the stopped turn is kept, the message starts a new one.
  await send('Start a sub-agent (your agent tool) to list the edge cases of add() in calc.py. While it works, run `sleep 45 && echo slept` yourself.');
  await page.waitForTimeout(20000);
  await send('Stop that. Reply with just: interrupted-ok');
  const replied = await page.waitForFunction(() => [...document.querySelectorAll('.markdown')].some(e => e.innerText.trim() === 'interrupted-ok'), undefined, { timeout: 120000 }).then(() => true, () => false);
  check('a message stops the turn and gets its own reply', replied);
  check('the stopped turn is kept', (await texts('.transcript')).join('').includes('Interrupted'));
  await S('real-2-interrupt');
  await settled();

  // A message handed to the turn under way (Option+Enter) is shown inside its reply.
  await send('Run `sleep 20 && echo first` in the shell, then tell me what it printed.');
  await page.waitForTimeout(8000);
  await send('Also run `echo second` after it, and report both.', 'Alt+Enter');
  await settled();
  const order = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.transcript-inner .user-bubble, .transcript-inner .tool-group-head')].map(e => e.classList.contains('user-bubble') ? `user:${e.innerText.slice(0, 20)}` : 'steps');
    return rows.slice(-4);
  });
  const steeredAt = order.findIndex(row => row.startsWith('user:Also run'));
  check('a steered message sits inside the reply', steeredAt > 0 && order[steeredAt - 1] === 'steps' && order.slice(steeredAt + 1).includes('steps'), order.join(' | '));
  await S('real-3-steer');

  // Visuals: shown, kept current under one id, and able to hand the person a message.
  await send('Call show_visual (iris MCP server) with id "progress", title "Progress", and a page showing a bar at 30% and a button labelled "Next" whose click calls iris.send("next please"). Then call it again with the same id and the bar at 80%. One sentence reply.');
  await settled();
  const cards = await page.locator('.visual-card').count(), folded = await page.locator('.visual-card.folded').count();
  check('a visual is shown, and its earlier version folds away', cards >= 2 && folded >= 1, `${cards} cards, ${folded} folded`);
  const frame = page.frameLocator('.visual-card:not(.folded) iframe').last();
  await frame.getByRole('button', { name: /next/i }).click({ timeout: 20000 }).catch(() => {});
  const handed = await page.waitForFunction(() => document.querySelector('.dock textarea[aria-label="Message"]')?.value === 'next please', undefined, { timeout: 10000 }).then(() => true, () => false);
  check('the page hands the person a message to send', handed);
  await box().fill('');
  await S('real-4-visual');

  // Restart: the agent's process ends and starts again, and the conversation goes on.
  // (Codex has named the conversation by now: it is the row that is open.)
  const row = page.locator('.session-row.active, .session-row[aria-current="true"]').first();
  await (await row.count() ? row : page.locator('.session-row').first()).hover();
  await (await row.count() ? row : page.locator('.session-row').first()).getByRole('button', { name: 'Conversation actions' }).click();
  await page.getByRole('button', { name: 'Restart agent' }).click();
  await page.waitForTimeout(8000);
  await send('Reply with just: restarted-ok');
  check('after a restart the conversation goes on', await page.waitForFunction(() => [...document.querySelectorAll('.markdown')].some(e => e.innerText.trim() === 'restarted-ok'), undefined, { timeout: 120000 }).then(() => true, () => false));

  if (withCursor) {
    await open('cursor', 'Real Cursor check');
    await send('Call the show_visual tool from the iris MCP server with an animated sine wave on a canvas (title: Sine wave). One sentence reply.');
    check('Cursor shows a visual', await page.locator('.visual-card iframe').waitFor({ timeout: 180000 }).then(() => true, () => false));
    await S('real-5-cursor');
  }
} catch (error) {
  failed++;
  console.log(`FAIL the run stopped: ${error.message.split('\n')[0]}`);
  await S('real-error').catch(() => {});
} finally {
  await app.close().catch(() => {});
  cleanup();
  console.log(`\n${passed} passed, ${failed} failed. Screenshots: ${shots}`);
  process.exit(failed ? 1 : 0);
}
