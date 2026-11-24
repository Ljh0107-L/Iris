// Notifications and the Dock count for conversations that finish or ask while the window is in the background.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttention } from '../app/main/attention.mjs';

function fixture({ focused = false, working = false } = {}) {
  const shown = [], badges = [], timers = [];
  const state = { focused, working };
  const attention = createAttention({
    isFocused: () => state.focused, isWorking: () => state.working,
    titleOf: id => ({ a: 'Weather app', b: '**Bold** title' })[id],
    notify: note => shown.push(note), setBadge: n => badges.push(n),
    timers: { setTimeout: (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); return t; }, clearTimeout: t => { if (t) t.done = true; } },
  });
  const flush = () => { for (const t of timers.splice(0)) if (!t.done) t.fn(); };
  const reply = (id, message) => attention.event(id, { type: 'message_end', message: { role: 'assistant', ...message } });
  const turn = (id, message) => { attention.event(id, { type: 'agent_start' }); reply(id, message); attention.event(id, { type: 'agent_settled' }); };
  return { attention, shown, badges, state, flush, reply, turn };
}

test('a reply that finishes in the background is announced once things are quiet, with its first words', () => {
  const f = fixture();
  f.turn('a', { stopReason: 'stop', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '## Done\n\nAdded `getTemperature()` and **two** tests.' }] });
  assert.equal(f.shown.length, 0, 'not before the turn has settled');
  f.flush();
  assert.deepEqual(f.shown, [{ id: 'a', title: 'Weather app', body: 'Done Added getTemperature() and two tests.' }]);
  assert.deepEqual(f.badges, [1]);
  // Another conversation adds to the count; the same one again does not.
  f.turn('b', { stopReason: 'error', errorMessage: '401: Incorrect API key provided. See your settings.' });
  f.turn('a', { stopReason: 'stop', content: [{ type: 'text', text: 'Again.' }] });
  f.flush();
  assert.deepEqual(f.shown.slice(1).map(n => [n.title, n.body]), [['Bold title', 'Stopped with an error: 401: Incorrect API key provided.'], ['Weather app', 'Again.']]);
  assert.deepEqual(f.badges, [1, 2]);
  f.attention.focused();
  assert.deepEqual(f.badges, [1, 2, 0], 'coming back clears the Dock count');
});

test('a notification reads as plain words: no formulas, code or Markdown marks', () => {
  const f = fixture();
  f.turn('a', { stopReason: 'stop', content: [{ type: 'text', text: '体感温度用**风寒指数**估算:\n\n$$T_{wc} = 13.12 + 0.6215\\,T_a$$\n\n其中 $T_a$ 是气温,$v \\le 10$ 时适用。\n```js\nx()\n```' }] });
  f.flush();
  assert.equal(f.shown[0].body, '体感温度用风寒指数估算: 其中 Ta 是气温,v ≤ 10 时适用。');
});

test('nothing is sent while the window has focus, for a stopped turn, or while the next turn of a run starts', () => {
  const f = fixture({ focused: true });
  f.turn('a', { stopReason: 'stop', content: [{ type: 'text', text: 'Done.' }] });
  f.flush();
  f.state.focused = false;
  f.turn('a', { stopReason: 'aborted', content: [] });
  f.flush();
  // A goal run: the next turn starts before the pause is over.
  f.turn('a', { stopReason: 'stop', content: [{ type: 'text', text: 'Step 1.' }] });
  f.attention.event('a', { type: 'agent_start' });
  f.flush();
  // Ultra announces its own end.
  f.attention.ultra('a', true);
  f.turn('a', { stopReason: 'stop', content: [{ type: 'text', text: 'Round 2.' }] });
  f.flush();
  f.attention.ultra('a', false);
  // Still working (a queued message): not finished yet.
  f.state.working = true;
  f.turn('a', { stopReason: 'stop', content: [{ type: 'text', text: 'Halfway.' }] });
  f.flush();
  assert.deepEqual(f.shown, []);
  assert.deepEqual(f.badges, []);
});

test('a question or permission request waiting in the background is announced at once', () => {
  const f = fixture();
  f.attention.question('a', { title: 'Which weather source?', method: 'select' });
  f.attention.question('b', { title: 'Run this command?', permission: true });
  assert.deepEqual(f.shown.map(n => n.body), ['Waiting for your answer: Which weather source?', 'Asks for permission: Run this command?']);
  assert.deepEqual(f.badges, [1, 2]);
  f.attention.forget('b');
  assert.deepEqual(f.badges, [1, 2, 1]);
});
