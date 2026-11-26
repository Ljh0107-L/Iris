// A turn that ends without finishing: a step stopped with it is cancelled (not failed), and a turn whose agent is
// gone leaves nothing running.
import assert from 'node:assert/strict';
import test from 'node:test';

test('a step stopped with its turn is cancelled, whatever the agent said it with', async () => {
  const { applyEvent, emptyTranscript, fromHistory } = await import('../app/renderer/src/transcript.js');
  const ended = (text, details = {}) => applyEvent(emptyTranscript(), { type: 'tool_execution_end', toolCallId: 'x', result: { content: [{ type: 'text', text }], details }, isError: true }).tools.x.status;
  assert.equal(ended('Interrupted', { engine: 'claude-code', interrupted: true }), 'cancelled');
  assert.equal(ended('Interrupted.', { engine: 'codex' }), 'cancelled', 'said only in its text (an older adapter)');
  assert.equal(ended('Operation aborted'), 'cancelled');
  assert.equal(ended('No such file: src/a.ts'), 'error');
  // Read back from a saved conversation (Claude Code's own words for it).
  const saved = fromHistory([{ role: 'toolResult', toolCallId: 'y', isError: true, content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }]);
  assert.equal(saved.tools.y.status, 'cancelled');
});

test('when the agent is gone mid-turn, its reply is kept as stopped and nothing reads as running', async () => {
  const { settleStopped, emptyTranscript } = await import('../app/renderer/src/transcript.js');
  const live = { role: 'assistant', stopReason: 'pending', content: [{ type: 'text', text: 'Running the tests' }, { type: 'toolCall', id: 'run', name: 'bash', arguments: { command: 'npm test' } }] };
  const t = { ...emptyTranscript(), messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], live,
    tools: { run: { status: 'running', startedAt: 1 }, done: { status: 'done' } } };
  const settled = settleStopped(t);
  assert.equal(settled.live, null);
  assert.equal(settled.messages.at(-1).stopReason, 'aborted');
  assert.equal(settled.messages.at(-1).content[0].text, 'Running the tests');
  assert.equal(settled.tools.run.status, 'cancelled');
  assert.equal(settled.tools.done.status, 'done');
  // Nothing under way: left as it is.
  const idle = { ...emptyTranscript(), messages: t.messages };
  assert.equal(settleStopped(idle), idle);
});
