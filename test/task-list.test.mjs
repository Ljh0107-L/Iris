// A turn's task list: at the end of the turn, once, and gone when it is all done.
import assert from 'node:assert/strict';
import test from 'node:test';

test('a task list stands at the end of its turn, once, and goes when every step of it is done', async () => {
  const { listsAtTurnEnd } = await import('../app/renderer/src/transcript.js');
  const list = (key, statuses) => ({ kind: 'ccTodo', key, call: { arguments: { todos: statuses.map((status, i) => ({ content: `step ${i}`, status })) } } });
  const blocks = [{ kind: 'user', key: 'u1' }, list('l1', ['in_progress', 'pending']), { kind: 'text', key: 't1' }, list('l2', ['completed', 'in_progress']), { kind: 'work', key: 'w1' }, { kind: 'usage', key: 'f1' },
    { kind: 'user', key: 'u2' }, { kind: 'text', key: 't2' }, list('l3', ['completed', 'completed'])];
  assert.deepEqual(listsAtTurnEnd(blocks).map(b => b.key), ['u1', 't1', 'w1', 'l2', 'f1', 'u2', 't2']);
});
