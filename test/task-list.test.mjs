// A turn's task list: at the end of the turn, once, and gone when it is all done. The plan as it stands (the latest
// list, while steps of it are left) is carried to the end of the latest turn, as Claude Code shows its list again.
import assert from 'node:assert/strict';
import test from 'node:test';

const list = (key, statuses) => ({ kind: 'ccTodo', key, call: { arguments: { todos: statuses.map((status, i) => ({ content: `step ${i}`, status })) } } });

test('a task list stands at the end of its turn, once, and goes when every step of it is done', async () => {
  const { listsAtTurnEnd } = await import('../app/renderer/src/transcript.js');
  const blocks = [{ kind: 'user', key: 'u1' }, list('l1', ['in_progress', 'pending']), { kind: 'text', key: 't1' }, list('l2', ['completed', 'in_progress']), { kind: 'work', key: 'w1' }, { kind: 'usage', key: 'f1' },
    { kind: 'user', key: 'u2' }, { kind: 'text', key: 't2' }, list('l3', ['completed', 'completed'])];
  assert.deepEqual(listsAtTurnEnd(blocks).map(b => b.key), ['u1', 't1', 'w1', 'l2', 'f1', 'u2', 't2']);
});

test('a plan left half done (the turn was stopped) is shown again at the end of the latest turn, and only there', async () => {
  const { listsAtTurnEnd } = await import('../app/renderer/src/transcript.js');
  const stopped = [{ kind: 'user', key: 'u1' }, list('l1', ['in_progress', 'pending']), { kind: 'work', key: 'w1' }, { kind: 'usage', key: 'f1' },
    { kind: 'user', key: 'u2' }, { kind: 'text', key: 't2' }, { kind: 'usage', key: 'f2' }];
  assert.deepEqual(listsAtTurnEnd(stopped).map(b => b.key), ['u1', 'w1', 'f1', 'u2', 't2', 'l1', 'f2']);
  // Just sent, nothing written yet: the plan stands under your message.
  assert.deepEqual(listsAtTurnEnd(stopped.slice(0, 5)).map(b => b.key), ['u1', 'w1', 'f1', 'u2', 'l1']);
  // A newer list replaces it; the older turn keeps the list it ended with.
  const replaced = [...stopped, { kind: 'user', key: 'u3' }, list('l3', ['pending']), { kind: 'text', key: 't3' }];
  assert.deepEqual(listsAtTurnEnd(replaced).map(b => b.key), ['u1', 'w1', 'l1', 'f1', 'u2', 't2', 'f2', 'u3', 't3', 'l3']);
  // Carried out (in a later turn's list): gone, and not carried.
  const finished = [...stopped, { kind: 'user', key: 'u3' }, list('l3', ['completed'])];
  assert.deepEqual(listsAtTurnEnd(finished).map(b => b.key), ['u1', 'w1', 'l1', 'f1', 'u2', 't2', 'f2', 'u3']);
  // A list of an earlier page not read yet stays where it is: whether steps of it are left is not known.
  const unread = [{ kind: 'user', key: 'u1' }, { kind: 'ccTodo', key: 'l1', call: { arguments: {} } }, { kind: 'user', key: 'u2' }, { kind: 'text', key: 't2' }];
  assert.deepEqual(listsAtTurnEnd(unread).map(b => b.key), ['u1', 'l1', 'u2', 't2']);
});

test('only a list written in the run under way is the plan being carried out', async () => {
  const { displayBlocks } = await import('../app/renderer/src/transcript.js');
  const todo = (id, status) => ({ type: 'toolCall', id, name: 'TodoWrite', arguments: { todos: [{ content: 'Run the benchmark', status }] } });
  const current = t => displayBlocks(t).filter(b => b.kind === 'ccTodo').map(b => [b.key, !!b.current]);
  const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
  // Claude Code: the list in an earlier request of the run (toolUse), the run still going.
  assert.deepEqual(current({ tools: {}, messages: [user('go'), { role: 'assistant', stopReason: 'toolUse', content: [todo('a', 'in_progress')] }, { role: 'toolResult', toolCallId: 'a', toolName: 'TodoWrite', content: [] }],
    live: { role: 'assistant', stopReason: 'pending', content: [] } }), [['cc-todo:a', true]]);
  // Codex and Antigravity: the run is one reply, streaming.
  assert.deepEqual(current({ tools: {}, messages: [user('go')], live: { role: 'assistant', stopReason: 'pending', content: [todo('b', 'in_progress')] } }), [['cc-todo:b', true]]);
  // Stopped: the next run (with or without a message of yours before it) is not carrying it out.
  assert.deepEqual(current({ tools: {}, messages: [user('go'), { role: 'assistant', stopReason: 'aborted', content: [todo('c', 'in_progress')] }], live: { role: 'assistant', stopReason: 'pending', content: [] } }), [['cc-todo:c', false]]);
  assert.deepEqual(current({ tools: {}, messages: [user('go'), { role: 'assistant', stopReason: 'aborted', content: [todo('d', 'in_progress')] }, user('in Chinese')], live: { role: 'assistant', stopReason: 'pending', content: [] } }), [['cc-todo:d', false]]);
});
