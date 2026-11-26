// Every agent a conversation started, whichever agent runs it, as one list (the title bar's Agents): Iris's own
// (its subagent tool, with their live state), and the tasks of Claude Code, Codex, Cursor and Antigravity
// (a `Task` call, or a call whose result says it is an agent's).
//
// An engine's task is working while its call is, and also after, when its result says so (details.agentStatus):
// Antigravity's agents carry on after the call that starts them returns, and their end comes later.
import { subagentBatches, visibleSubagentBatches } from './subagent-state.js';

const STATUS = { pending: 'running', queued: 'queued', running: 'running', retrying: 'running', completed: 'completed', failed: 'failed', timed_out: 'failed', cancelled: 'cancelled' };
export const agentStatusLabel = status => ({ running: 'Running', queued: 'Queued', completed: 'Completed', failed: 'Failed', cancelled: 'Stopped' })[status] ?? 'Running';
export const isEngineAgent = (block, tool) => block?.type === 'toolCall' && (block.name === 'Task' || tool?.result?.details?.kind === 'claude-code-agent');

export function engineAgentStatus(tool) {
  const said = tool?.result?.details?.agentStatus;
  if (['completed', 'failed', 'cancelled'].includes(said)) return said;
  if (said === 'running' || !tool || ['running', 'pending'].includes(tool.status)) return tool?.status === 'cancelled' ? 'cancelled' : 'running';
  if (tool.status === 'cancelled') return 'cancelled';
  return ['error', 'timed_out'].includes(tool.status) ? 'failed' : 'completed';
}

const firstLine = text => String(text ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? '';

export function conversationAgents(session, transcript, live = {}) {
  if (!transcript) return [];
  const agents = [];
  for (const batch of visibleSubagentBatches(subagentBatches(transcript, live), session?.clearedSubagentIds)) {
    for (const task of batch.tasks) agents.push({ key: `iris:${task.key}`, engine: false, callId: batch.callId, taskIndex: task.index, task,
      name: task.name, type: task.type && task.type !== 'general' ? task.type : null, status: STATUS[task.status] ?? 'running' });
  }
  const seen = new Set();
  for (const message of [...transcript.messages, ...(transcript.live ? [transcript.live] : [])]) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const tool = transcript.tools?.[block?.id];
      if (!isEngineAgent(block, tool) || seen.has(block.id)) continue;
      seen.add(block.id);
      const a = block.arguments ?? {}, details = tool?.result?.details ?? {};
      agents.push({ key: `task:${block.id}`, engine: true, callId: block.id, call: block, tool,
        name: a.description?.trim() || firstLine(a.prompt) || 'Delegated task', type: a.subagent_type && a.subagent_type !== 'Agent' ? a.subagent_type : null,
        status: engineAgentStatus(tool), steps: Array.isArray(details.steps) && details.steps.length ? details.steps.filter(step => step?.type === 'tool').length : details.stepCount ?? 0,
        tokens: details.agentRuns?.[0]?.usage?.totalTokens ?? 0 });
    }
  }
  return agents;
}

export function agentsSummary(agents) {
  const running = agents.filter(agent => agent.status === 'running' || agent.status === 'queued').length;
  return { running, total: agents.length, label: running ? `${running} ${running === 1 ? 'agent' : 'agents'} running` : `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}` };
}
