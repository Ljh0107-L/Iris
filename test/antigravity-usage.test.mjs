// Antigravity's /usage screen, as the CLI printed it in a terminal (colours and cursor moves included).
import test from 'node:test';
import assert from 'node:assert/strict';
import { headingPlan, parseUsageScreen, screenText } from '../app/main/antigravity-usage.mjs';
import { readAntigravityUsage, stopUsageReaders } from '../app/main/antigravity-usage.mjs';
import { spawn } from 'node:child_process';

const SCREEN = [
  '\x1b[2J\x1b[H> /usage\r\n',
  '\x1b[1m└ Models & Quota\x1b[0m\r\n  Account: dev@example.test\r\n',
  '\x1b[36mGEMINI MODELS\x1b[0m\r\n  Models within this group: Gemini 4 Neon, Gemini 4 Carbon\r\n',
  '  Weekly Limit Remaining\r\n[██████████████████████████████░░░░░░░░░░░░░░░░░░░░] 61.50%\r\nRefreshes in 167h 56m\r\n',
  '  Five Hour Limit Remaining\r\n[██████████████████████████████████████████████████] 99.97%\r\nRefreshes in 4h 56m\r\n',
  '\x1b[36mCLAUDE AND GPT MODELS\x1b[0m\r\n  Models within this group: Claude Opus 5.5, GPT-OSS 120B\r\n',
  '[██████████████████████████████████████████████████] 100.00%\r\nQuota available\r\n',
  '  │Within each group, models share a weekly limit and a 5-hour limit.\r\n  ↑/↓ Scroll · esc Close\r\n',
].join('');

test('the /usage screen gives the account and, per group of models, what is used and when it refreshes', () => {
  const now = Date.UTC(2026, 10, 24, 12);
  assert.deepEqual(parseUsageScreen(SCREEN, now), { identity: 'dev@example.test', limits: [
    { label: 'Gemini · Weekly', usedPercent: 38.5, windowMinutes: 10080, resetsAt: now + (167 * 60 + 56) * 60000 },
    { label: 'Gemini · 5-hour', usedPercent: 0.03, windowMinutes: 300, resetsAt: now + (4 * 60 + 56) * 60000 },
    { label: 'Claude & GPT', usedPercent: 0 },
  ] });
});

test('a redrawn screen is read from its last drawing, and a terminal without the screen gives nothing', () => {
  const twice = SCREEN.replace('61.50%', '70.00%') + SCREEN;
  assert.equal(parseUsageScreen(twice, 0).limits[0].usedPercent, 38.5);
  assert.equal(parseUsageScreen('\x1b[2J> hello\r\n? for shortcuts'), null);
  assert.equal(screenText('\x1b[31mred\x1b[0m\rnext'), 'red\nnext');
});

test('the plan is the bracket the heading draws after the account', () => {
  assert.equal(headingPlan(screenText('\x1b[1m▀▀▀  dev@example.test\x1b[0m\x1b[3;40H (Google AI Ultra)\r\n> Auto mode (shift+tab to cycle)')), 'Google AI Ultra');
  assert.equal(headingPlan('Welcome. You are currently not signed in. (shift+tab to cycle)'), null);
});

// A stand-in for the CLI in a terminal: a real process (so that stopping it can be seen) that shows `screen`.
function fakeTerminal(t, screen) {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGHUP", () => {}); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  const listeners = { data: [], exit: [] };
  child.on('exit', () => listeners.exit.forEach(fn => fn({ exitCode: null })));
  const term = { pid: child.pid, typed: '', onData: fn => listeners.data.push(fn), onExit: fn => listeners.exit.push(fn), write(text) { term.typed += text; }, kill() { child.kill('SIGHUP'); } };
  setTimeout(() => listeners.data.forEach(fn => fn(screen)), 20);
  return { term, gone: () => new Promise(resolve => child.exitCode !== null || child.signalCode ? resolve(true) : child.once('exit', () => resolve(true))) };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a CLI that is not signed in is left at once: reading a quota never starts a sign-in', { timeout: 15000 }, async t => {
  const fake = fakeTerminal(t, 'Welcome to Antigravity\r\n\r\nLog in with Google to continue\r\n');
  const started = Date.now();
  assert.equal(await readAntigravityUsage({ bin: 'agy', cwd: process.cwd(), env: {}, spawnPty: () => fake.term }), null);
  assert.ok(Date.now() - started < 3000, 'it does not wait out the start-up time on a sign-in screen');
  assert.doesNotMatch(fake.term.typed, /usage/, 'nothing is typed into a sign-in screen');
  // The process ignores a hang-up, as the real CLI does; it is made to go all the same.
  await fake.gone();
  assert.equal(alive(fake.term.pid), false);
});

test('quitting the app stops a CLI that is still being read', { timeout: 15000 }, async t => {
  const fake = fakeTerminal(t, 'starting…');
  const reading = readAntigravityUsage({ bin: 'agy', cwd: process.cwd(), env: {}, spawnPty: () => fake.term, timeoutMs: 8000 });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(alive(fake.term.pid), true);
  stopUsageReaders(); // what the app does on its way out
  await fake.gone();
  assert.equal(alive(fake.term.pid), false);
  assert.equal(await reading, null);
});
