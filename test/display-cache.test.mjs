// The blocks of a conversation worked out with the turns before the one under way kept: the same as worked out
// whole, and the earlier part not worked out again while a reply streams.
import assert from 'node:assert/strict';
import test from 'node:test';
import { displayBlocks, displayBlocksCached, fromHistory } from '../app/renderer/src/transcript.js';

const user = (id, text, extra = {}) => ({ __entryId: id, role: 'user', timestamp: 1, content: [{ type: 'text', text }], ...extra });
const visual = (id, vid) => ({ type: 'toolCall', id, name: 'mcp__iris__show_visual', arguments: { title: 'V', html: '<p>x</p>', id: vid } });
function conversation() {
  const messages = [
    user('u1', 'first'),
    { __entryId: 'a1', role: 'assistant', timestamp: 2, stopReason: 'toolUse', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, content: [{ type: 'thinking', thinking: 'hm' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }, visual('v1', 'chart')] },
    { __entryId: 'r1', role: 'toolResult', toolCallId: 'c1', toolName: 'bash', timestamp: 3, content: [{ type: 'text', text: 'a b' }] },
    { __entryId: 'a1b', role: 'assistant', timestamp: 4, stopReason: 'stop', content: [{ type: 'text', text: 'Done one.' }] },
    user('u2', 'second'),
    { __entryId: 'a2', role: 'assistant', timestamp: 6, stopReason: 'stop', content: [{ type: 'toolCall', id: 'e2', name: 'edit', arguments: { path: '/w/a.js', edits: [{ oldText: 'a', newText: 'b' }] } }, { type: 'text', text: 'Edited.' }] },
    { __entryId: 'r2', role: 'toolResult', toolCallId: 'e2', toolName: 'edit', timestamp: 7, content: [{ type: 'text', text: 'ok' }] },
    user('u3', 'third'),
    user('s3', 'also this', { steer: { at: 1 } }),
  ];
  const t = fromHistory(messages);
  return { ...t, live: { role: 'assistant', __liveKey: 'live-1', stopReason: 'pending', content: [{ type: 'toolCall', id: 'c3', name: 'bash', arguments: { command: 'make' } }, visual('v3', 'chart'), { type: 'text', text: 'Working on' }] },
    tools: { ...t.tools, c3: { status: 'running' } } };
}
const plain = blocks => JSON.parse(JSON.stringify(blocks));

test('worked out with the earlier turns kept, the blocks are the same as worked out whole', () => {
  const t = conversation(), cache = {};
  assert.deepEqual(plain(displayBlocksCached(t, cache)), plain(displayBlocks(t)));
  assert.ok(displayBlocksCached(t, cache).some(b => b.kind === 'visual' && b.call.id === 'v1' && b.superseded), 'a visual of an earlier turn folds away for the newer one');
  // The reply streams on: only its turn is worked out again.
  const before = cache.before;
  const later = { ...t, live: { ...t.live, content: [...t.live.content.slice(0, 2), { type: 'text', text: 'Working on it now' }] } };
  assert.deepEqual(plain(displayBlocksCached(later, cache)), plain(displayBlocks(later)));
  assert.equal(cache.before, before, 'the earlier part was kept');
  // Saved (the turn ended): worked out whole.
  assert.deepEqual(plain(displayBlocksCached({ ...t, live: null }, cache)), plain(displayBlocks({ ...t, live: null })));
});
