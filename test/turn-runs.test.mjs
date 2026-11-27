// How one turn gives way to the next on the page: a run the agent begins itself (the next step toward a goal, a goal
// resumed after a stop) is a turn of its own; your message sent to stop a run stands after that run, from the moment
// it is sent; a goal set with /goal shows at once; and the agent's events are taken up before what it says next.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEvent, displayBlocks, emptyTranscript } from '../app/renderer/src/transcript.js';

let receive, invoke = () => Promise.resolve(null);
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = { iris: { subscribe: fn => { receive = fn; }, invoke: (...args) => invoke(...args) } };
const store = await import('../app/renderer/src/store.js');

const user = (text, extra = {}) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1, ...extra });
let clock = 10;
const reply = (text, stopReason = 'stop', extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason, timestamp: clock++, usage: { input: 1, output: 1 }, ...extra });
const kinds = t => displayBlocks({ ...emptyTranscript(), ...t }).map(b => b.kind === 'text' ? `text:${b.text}` : b.kind === 'continued' ? `continued:${b.goal ? 'goal' : 'run'}` : b.kind);
const goal = objective => ({ role: 'custom', customType: 'iris-goal', content: `The user set a goal for this session.\n\n<objective>\n${objective}\n</objective>`, display: false, timestamp: 3 });

test('a run the agent begins itself is a turn of its own, after the one that ended, with its own footer', () => {
  // Codex working on toward a goal: replies one after another with no message between them.
  assert.deepEqual(kinds({ messages: [goal('Port it'), reply('Step one.'), reply('Step two.'), reply('Done.')] }),
    ['goal', 'text:Step one.', 'usage', 'continued:goal', 'text:Step two.', 'usage', 'continued:goal', 'text:Done.', 'usage']);
  // Resumed after a stop: not more of the stopped run.
  assert.deepEqual(kinds({ messages: [goal('Port it'), reply('Half', 'aborted'), reply('On again.')] }),
    ['goal', 'text:Half', 'notice', 'usage', 'continued:goal', 'text:On again.', 'usage']);
  // Without a goal (Claude Code taken up by a background task), just marked as begun by the agent.
  assert.deepEqual(kinds({ messages: [user('go'), reply('Started it.'), reply('It finished.')] }), ['user', 'text:Started it.', 'usage', 'continued:run', 'text:It finished.', 'usage']);
  // A message of yours since the goal: what follows is not the goal's.
  assert.deepEqual(kinds({ messages: [goal('Port it'), reply('A.'), user('and this'), reply('B.'), reply('C.')] }).filter(k => k.startsWith('continued')), ['continued:run']);
  // The goal's continuation prompt (Iris's agent, Antigravity, Cursor) is the mark itself.
  assert.deepEqual(kinds({ messages: [goal('Port it'), reply('A.'), { role: 'custom', customType: 'iris-goal', content: 'Continue working toward the active goal.', display: false, timestamp: 4 }, reply('B.')] }),
    ['goal', 'text:A.', 'usage', 'continued:goal', 'text:B.', 'usage']);
});

test('steps of one run, and a request retried after it failed, stay one run', () => {
  const call = { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } };
  assert.deepEqual(kinds({ messages: [user('go'), { ...reply('', 'toolUse'), content: [call] }, { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [] }, reply('Listed.')], tools: { c1: { status: 'done' } } }),
    ['user', 'work', 'text:Listed.', 'usage']);
  assert.ok(!kinds({ messages: [user('go'), reply('', 'error', { errorMessage: 'overloaded', __retryOmitted: true }), reply('Answer.')] }).some(k => k.startsWith('continued')));
});

test('your message sent to stop a run stands after that run, from the moment it is sent', () => {
  const sent = user('stop and say hi', { __optimistic: true, __interrupting: true });
  let t = { ...emptyTranscript(), messages: [user('go'), sent], live: { role: 'assistant', content: [{ type: 'text', text: 'Working on it' }], stopReason: 'pending' } };
  assert.deepEqual(kinds(t), ['user', 'text:Working on it', 'user'], 'the reply being written stays above your message');
  t = applyEvent(t, { type: 'message_end', message: reply('Working on it', 'aborted') });
  assert.deepEqual(t.messages.map(m => m.role + (m.__optimistic ? '*' : '')), ['user', 'assistant', 'user*'], 'the stopped reply goes before it');
  assert.equal(t.messages.at(-1).__interrupting, undefined, 'and once that run has ended, the message no longer waits on it ("Interrupting…" is over)');
  t = applyEvent(t, { type: 'message_end', message: user('stop and say hi') });
  assert.deepEqual(t.messages.map(m => m.role + (m.__optimistic ? '*' : '')), ['user', 'assistant', 'user']);
  // A message handed to the turn under way (Codex's Option+Enter) is shown inside the reply, as before.
  const steer = user('also this', { __optimistic: true, steer: { at: 1 } });
  assert.deepEqual(kinds({ messages: [user('go'), steer], live: { role: 'assistant', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }], stopReason: 'pending' } }),
    ['user', 'text:A', 'user', 'text:B']);
});

test('the agent’s events are taken up before what is said about the conversation after them', () => {
  store.set({ transcripts: {}, sessions: [{ id: 's', engine: 'codex', status: 'connected', streaming: true }] });
  receive({ channel: 'event', payload: { id: 's', event: { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } } } });
  receive({ channel: 'event', payload: { id: 's', event: { type: 'message_end', message: reply('Done.') } } });
  // (Not yet taken up: they wait for the next frame.) The turn ends: by then the reply is finished.
  receive({ channel: 'status', payload: { id: 's', status: 'connected', streaming: false } });
  const t = store.getState().transcripts.s;
  assert.equal(t.live, null);
  assert.equal(t.messages.at(-1).content[0].text, 'Done.');
});

test('a goal set with /goal shows at once, until the agent’s own record of it arrives', async () => {
  store.set({ transcripts: {}, sessions: [{ id: 'g', engine: 'codex', status: 'connected', streaming: true }], questions: {} });
  let release; invoke = method => method === 'prompt' ? new Promise(resolve => { release = resolve; }) : Promise.resolve(null);
  const sending = store.sendPrompt('g', '/goal Port the parser');
  assert.equal(store.getState().transcripts.g.pendingGoal.objective, 'Port the parser');
  assert.equal(store.getState().transcripts.g.messages.length, 0, 'a command, not a message');
  release({}); await sending;
  receive({ channel: 'event', payload: { id: 'g', event: { type: 'message_end', message: goal('Port the parser') } } });
  store.applyPendingEvents();
  assert.equal(store.getState().transcripts.g.pendingGoal, null);
  // /goal pause, resume and clear set no goal; Claude Code has none.
  for (const word of ['pause', 'resume', 'clear']) { const p = store.sendPrompt('g', `/goal ${word}`); release({}); await p; assert.equal(store.getState().transcripts.g.pendingGoal ?? null, null); }
  store.set({ sessions: [{ id: 'c', engine: 'claude-code', status: 'connected', streaming: false }] });
  const p = store.sendPrompt('c', '/goal Port it'); release({}); await p;
  assert.equal(store.getState().transcripts.c?.pendingGoal ?? null, null, 'Claude Code has no goals');
  // A goal the agent would not set is taken off the page again.
  store.set({ sessions: [{ id: 'f', engine: 'codex', status: 'connected', streaming: false }] });
  invoke = method => method === 'prompt' ? Promise.reject(new Error('Codex could not set the goal')) : Promise.resolve(null);
  await assert.rejects(store.sendPrompt('f', '/goal Port it'));
  assert.equal(store.getState().transcripts.f.pendingGoal, null);
});
