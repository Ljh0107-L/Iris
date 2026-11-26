// One agent a conversation started, in the conversation's place: the same view as the conversation's own (what it
// was asked, what it thought, each step with what it returned, what it wrote), switched to from the title bar and
// back (the title bar names it; Esc, or its ✕, goes back). Iris's own agents can be stopped and written to here.
import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icons.jsx';
import { Transcript } from './Conversation.jsx';
import { AgentMessageForm } from './Subagents.jsx';
import { closeSubagent, getState, openFile, stopAgent, useStore } from './store.js';
import { agentStatusLabel, engineAgentTranscript } from './agents.js';
import { subagentTranscript } from './subagent-transcript.js';
import { formatTokens } from './transcript.js';

const duration = ms => ms < 1000 ? '<1s' : ms < 60000 ? `${Math.floor(ms / 1000)}s` : ms < 3600000 ? `${Math.floor(ms / 60000)}m ${Math.floor(ms % 60000 / 1000)}s` : `${Math.floor(ms / 3600000)}h ${Math.floor(ms % 3600000 / 60000)}m`;

export function AgentView({ session, agent }) {
  const [, tick] = useState(0);
  const running = agent.status === 'running' || agent.status === 'queued';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  // Esc goes back to the conversation, unless it is closing something else first (Settings, the palette, a menu)
  // or something is being typed. (The message box has the focus most of the time: empty, Esc goes back from it too.)
  useEffect(() => {
    const typing = el => /^(INPUT|TEXTAREA)$/.test(el?.tagName ?? '') && !(el.matches('.composer textarea') && !el.value);
    const onKey = e => {
      if (e.key !== 'Escape' || e.defaultPrevented || getState().settingsOpen || getState().paletteOpen || document.querySelector('.popover, .modal') || typing(document.activeElement)) return;
      closeSubagent(session.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session.id]);
  const transcript = useMemo(() => agent.engine ? engineAgentTranscript(agent) : subagentTranscript(agent.task), [agent]);
  const live = useStore(s => !agent.engine && agent.task?.id ? s.agents[session.id]?.[agent.task.id] : null);
  const view = useMemo(() => ({ id: `agent:${session.id}:${agent.key}`, engine: session.engine, status: 'connected', streaming: running,
    activityLabel: !agent.engine && agent.task?.currentTool ? `Working · ${agent.task.currentTool}` : running ? 'Working' : undefined }), [session.id, session.engine, agent.key, running, agent.engine, agent.task?.currentTool]);
  const details = agent.tool?.result?.details ?? {};
  const task = agent.task ?? {};
  const elapsed = agent.engine ? details.agentMs ?? agent.tool?.durationMs : (task.finishedAt ?? Date.now()) - (task.runStartedAt ?? task.startedAt ?? Date.now());
  const tokens = agent.engine ? agent.tokens : task.usage?.totalTokens;
  const meta = [agent.type ?? 'Agent', agentStatusLabel(agent.status), Number.isFinite(elapsed) && elapsed > 0 ? duration(elapsed) : null, tokens > 0 ? `${formatTokens(tokens)} tokens` : null].filter(Boolean).join(' · ');
  const canMessage = !agent.engine && !!live && live.retained !== false && task.status !== 'cancelled';
  return <>
    <Transcript key={view.id} session={view} transcript={transcript} readOnly onOpenFile={path => openFile(session.id, path)} />
    <div className="dock agent-dock">
      <div className="agent-dock-bar">
        <span className="agent-dock-meta">{meta}</span>
        {!agent.engine && running && live && <button type="button" className="button small" onClick={() => stopAgent(session.id, task.id)}>Stop agent</button>}
        <button type="button" className="button small" onClick={() => closeSubagent(session.id)}><Icon name="arrowLeft" size={13} /> Back to conversation</button>
      </div>
      {canMessage && <AgentMessageForm sessionId={session.id} agentId={task.id} name={agent.name} />}
    </div>
  </>;
}
