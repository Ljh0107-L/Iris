// A message handed to a turn under way (Option+Enter, Codex) is shown where it was sent: inside that turn's reply,
// although it is saved before the reply (Codex saves the turn's reply whole when the turn ends).
import assert from 'node:assert/strict';
import test from 'node:test';
import { displayBlocks } from '../app/renderer/src/transcript.js';

const user = (text, extra = {}) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1, ...extra });
const reply = { role: 'assistant', timestamp: 2, stopReason: 'stop', content: [{ type: 'text', text: 'Looking.' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }, { type: 'text', text: 'Done.' }] };
const order = blocks => blocks.filter(b => b.kind !== 'usage').map(b => b.kind === 'user' ? `user:${b.text}${b.steer ? ' (steer)' : ''}` : b.kind === 'text' ? `text:${b.text}` : b.kind);

test('a steered message sits in the reply after what was written when it was sent', () => {
  const blocks = displayBlocks({ messages: [user('Fix it'), user('also the README', { steer: { at: 2 } }), reply], live: null, tools: {} });
  assert.deepEqual(order(blocks), ['user:Fix it', 'text:Looking.', 'work', 'user:also the README (steer)', 'text:Done.']);
});

test('in a reply still being written too, and after all of it when sent last', () => {
  const live = { ...reply, content: reply.content.slice(0, 2) };
  assert.deepEqual(order(displayBlocks({ messages: [user('Fix it'), user('and test', { steer: { at: 9 } })], live, tools: {} })), ['user:Fix it', 'text:Looking.', 'work', 'user:and test (steer)']);
});

test('one with no reply after it stays where it is', () => {
  assert.deepEqual(order(displayBlocks({ messages: [user('Fix it'), user('and test', { steer: { at: 0 } })], live: null, tools: {} })), ['user:Fix it', 'user:and test']);
});
