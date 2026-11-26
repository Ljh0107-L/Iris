// The title bar's Agents: one list for every engine, and each engine task's state.
import assert from 'node:assert/strict';
import test from 'node:test';
import { agentsSummary, conversationAgents, engineAgentStatus } from '../app/renderer/src/agents.js';

const task = (id, args = {}) => ({ type: 'toolCall', id, name: 'Task', arguments: { description: `Agent ${id}`, prompt: 'Do it', subagent_type: 'Agent', ...args } });
const result = (details, status = 'done') => ({ status, result: { content: [{ type: 'text', text: 'ok' }], details } });

test('an engine task is working while its call is, and after it when its result says so (Antigravity)', () => {
  assert.equal(engineAgentStatus(undefined), 'running');
  assert.equal(engineAgentStatus({ status: 'running' }), 'running');
  assert.equal(engineAgentStatus(result({ kind: 'claude-code-agent' })), 'completed');
  assert.equal(engineAgentStatus(result({ agentStatus: 'running' })), 'running', 'the call returned, the agent works on');
  assert.equal(engineAgentStatus(result({ agentStatus: 'cancelled' })), 'cancelled');
  assert.equal(engineAgentStatus({ status: 'error' }), 'failed');
  assert.equal(engineAgentStatus(result({ agentStatus: 'running', interrupted: true }, 'cancelled')), 'cancelled', 'a turn stopped with it stops it');
});

test('every engine’s agents are listed, the live reply’s too, with what they did', () => {
  const transcript = {
    messages: [{ role: 'assistant', content: [task('a'), { type: 'toolCall', id: 'b', name: 'bash', arguments: {} }] }],
    live: { role: 'assistant', content: [task('c', { subagent_type: 'research' })] },
    tools: {
      a: result({ kind: 'claude-code-agent', agentStatus: 'completed', steps: [{ type: 'tool', name: 'read' }, { type: 'text', text: 'hm' }, { type: 'tool', name: 'bash' }], agentRuns: [{ usage: { totalTokens: 1200 } }] }),
      c: { status: 'running' },
    },
  };
  const agents = conversationAgents({ id: 's' }, transcript);
  assert.deepEqual(agents.map(a => [a.callId, a.status, a.type, a.steps, a.tokens]), [['a', 'completed', null, 2, 1200], ['c', 'running', 'research', 0, 0]]);
  assert.deepEqual(agentsSummary(agents), { running: 1, total: 2, label: '1 agent running' });
  assert.equal(agentsSummary([agents[0]]).label, '1 agent');
});

test('an engine’s agent reads as a conversation: its brief, its thoughts, its steps with what they returned, its report', async () => {
  const { engineAgentTranscript } = await import('../app/renderer/src/agents.js');
  const steps = [{ type: 'thinking', text: 'Look first.' }, { type: 'tool', id: 's1', name: 'bash', arguments: { command: 'ls' }, output: 'a b' }, { type: 'tool', id: 's2', name: 'read', arguments: { path: '/w/x' }, isError: true, output: 'file does not exist' },
    { type: 'thinking', text: 'Now report.' }, { type: 'text', text: 'Two files.' }];
  const done = engineAgentTranscript({ call: { id: 'c', arguments: { prompt: 'Audit /w' } }, tool: { status: 'done', result: { content: [{ type: 'text', text: 'Found two files: a and b.' }], details: { steps } } }, status: 'completed' });
  assert.deepEqual(done.messages.map(m => [m.role, (m.content ?? []).map(c => c.type).join('+')]), [['user', 'text'], ['assistant', 'thinking+toolCall+toolCall'], ['toolResult', 'text'], ['toolResult', 'text'], ['assistant', 'thinking+text'], ['assistant', 'text']]);
  assert.deepEqual([done.tools.s1.status, done.tools.s2.status], ['done', 'error']);
  const working = engineAgentTranscript({ call: { id: 'c', arguments: { prompt: 'Audit /w' } }, tool: { status: 'running', result: { details: { steps: [{ type: 'tool', id: 'x', name: 'bash', arguments: { command: 'make' } }] } } }, status: 'running' });
  assert.equal(working.tools.x.status, 'running', 'its step under way is running');
});
