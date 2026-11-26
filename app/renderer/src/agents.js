// Every agent a conversation started, whichever agent runs it, as one list (the title bar's Agents): Iris's own
// (its subagent tool, with their live state), and the tasks of Claude Code, Codex, Cursor and Antigravity
// (a `Task` call, or a call whose result says it is an agent's).
//
// An engine's task is working while its call is, and also after, when its result says so (details.agentStatus):
// Antigravity's agents carry on after the call that starts them returns, and their end comes later.
import { subagentBatches, visibleSubagentBatches } from './subagent-state.js';
import { fromHistory } from './transcript.js';

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

// An engine's agent as a conversation of its own, for its view (the same as the conversation's): what it was asked,
// then what it thought, did (each step with what it returned, where the CLI says) and wrote, then its report.
const textOfResult = result => (result?.content ?? []).filter(c => c?.type === 'text').map(c => c.text ?? '').join('\n').trim();
export function engineAgentTranscript(agent) {
  const { call, tool, status } = agent, a = call.arguments ?? {}, details = tool?.result?.details ?? {};
  const steps = Array.isArray(details.steps) ? details.steps.filter(Boolean) : [];
  const key = part => `agent:${call.id}:${part}`;
  const messages = [];
  let at = 1, content = [], results = [], running = null;
  if (String(a.prompt ?? '').trim()) messages.push({ __entryId: key('brief'), role: 'user', timestamp: at++, content: [{ type: 'text', text: a.prompt }] });
  const flush = () => {
    if (content.length) messages.push({ __entryId: key(`a${at}`), role: 'assistant', timestamp: at++, stopReason: 'stop', content }, ...results);
    content = []; results = [];
  };
  steps.forEach((step, i) => {
    // A thought after what was done or said begins the next request of the agent.
    if (step.type === 'thinking') { if (content.some(c => c.type !== 'thinking')) flush(); content.push({ type: 'thinking', thinking: step.text ?? '' }); return; }
    if (step.type === 'text') { if (String(step.text ?? '').trim()) content.push({ type: 'text', text: step.text }); return; }
    if (step.type !== 'tool') return;
    const id = step.id ?? key(`t${i}`);
    content.push({ type: 'toolCall', id, name: step.name, arguments: step.arguments ?? {} });
    if (typeof step.output === 'string' || step.isError) results.push({ __entryId: key(`r${i}`), role: 'toolResult', toolCallId: id, toolName: step.name, timestamp: at, content: [{ type: 'text', text: step.output ?? '' }], isError: !!step.isError });
    else if (status === 'running' && i === steps.length - 1) running = id;
  });
  flush();
  const report = status === 'running' ? '' : textOfResult(tool?.result);
  const said = messages.flatMap(m => m.role === 'assistant' ? m.content.filter(c => c.type === 'text').map(c => c.text.trim()) : []);
  if (report && !said.some(text => text && report.startsWith(text.replace(/…$/, '')) && text.length > report.length * 0.8))
    messages.push({ __entryId: key('report'), role: 'assistant', timestamp: at++, stopReason: status === 'failed' ? 'error' : 'stop', content: [{ type: 'text', text: report }] });
  const t = fromHistory(messages);
  return running ? { ...t, tools: { ...t.tools, [running]: { status: 'running' } } } : t;
}
