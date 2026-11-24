// Antigravity's /usage screen, as the CLI printed it in a terminal (colours and cursor moves included).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsageScreen, screenText } from '../app/main/antigravity-usage.mjs';

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
