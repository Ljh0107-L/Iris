// The agents a conversation started, in the title bar: a pill that says how many there are (and how many are
// working), opening a panel with each one, and from it one agent: what it was asked, the steps it took, and
// what it reported. Every engine's agents are here (agents.js); Iris's own open as the conversation they are,
// with their controls (SubagentDetail).
import { useMemo, useRef } from 'react';
import { Icon } from './Icons.jsx';
import { Popover, Spinner } from './ui.jsx';
import { clearSubagentRecords, closeAgents, closeSubagent, openAgents, useStore, viewAgent } from './store.js';
import { agentStatusLabel, agentsSummary, conversationAgents } from './agents.js';
import { formatTokens } from './transcript.js';
import { isSubagentFinished } from './subagent-state.js';

const NO_LIVE = {};

function StatusMark({ status, size = 14 }) {
  if (status === 'running') return <Spinner size={size - 1} />;
  return <Icon name={status === 'completed' ? 'check' : status === 'queued' ? 'timer' : status === 'cancelled' ? 'x' : 'alert'} size={size} />;
}

function caption(agent) {
  return [agent.type, agentStatusLabel(agent.status), agent.steps ? `${agent.steps} ${agent.steps === 1 ? 'step' : 'steps'}` : null, agent.tokens > 0 ? `${formatTokens(agent.tokens)} tok` : null]
    .filter(Boolean).join(' · ');
}

// The agent shown in the conversation's place, if one is.
export function useAgents(session) {
  const transcript = useStore(s => s.transcripts[session.id]);
  const live = useStore(s => s.agents[session.id] ?? NO_LIVE);
  const selection = useStore(s => s.subagentSelection[session.id]);
  const agents = useMemo(() => conversationAgents(session, transcript, live), [session, transcript, live]);
  const shown = selection ? agents.find(agent => agent.callId === selection.callId && (agent.engine || agent.taskIndex === selection.taskIndex)) ?? null : null;
  return { agents, shown };
}

export function AgentsBar({ session }) {
  const open = useStore(s => s.agentsOpen === session.id);
  const anchor = useRef(null);
  const { agents, shown } = useAgents(session);
  if (!agents.length) return null;
  const { running, label } = agentsSummary(agents);
  return <>
    {shown && <span className="agent-crumb no-drag" title={shown.name}>
      <Icon name="chevronRight" size={12} className="agent-crumb-sep" />
      <span className={`agent-crumb-mark ${shown.status}`}><StatusMark status={shown.status} size={12} /></span>
      <span className="agent-crumb-name">{shown.name}</span>
      <button type="button" className="agent-crumb-close" aria-label="Back to the conversation" title="Back to the conversation (Esc)" onClick={() => closeSubagent(session.id)}><Icon name="x" size={12} /></button>
    </span>}
    <button ref={anchor} type="button" className={`header-pill agents-pill no-drag ${running ? 'live' : ''} ${open ? 'on' : ''}`} aria-expanded={open} aria-label={`Agents: ${label}`}
      onClick={() => open ? closeAgents() : openAgents(session.id)} title="Agents this conversation started">
      {running ? <Spinner size={11} /> : <Icon name="fork" size={12} />}<span>{label}</span>
    </button>
    <Popover anchor={anchor} open={open} onClose={closeAgents} placement="bottom-start" width={420} className="agents-panel">
      <AgentList session={session} agents={agents} shown={shown} />
    </Popover>
  </>;
}

function AgentList({ session, agents, shown }) {
  const { running, total } = agentsSummary(agents);
  const finishedIris = agents.some(agent => !agent.engine && isSubagentFinished(agent.task));
  return <div className="agents-list">
    <div className="agents-list-head">
      <b>Agents</b><span className="muted">{running ? `${running} running · ${total} in all` : `${total} in all`}</span>
      {finishedIris && <button type="button" className="link-button" title="Clear finished task records from this conversation’s task history" onClick={() => clearSubagentRecords(session.id)}>Clear</button>}
    </div>
    <div className="agents-list-rows">
      {shown && <button type="button" className="agents-row back" onClick={() => { closeSubagent(session.id); closeAgents(); }}>
        <span className="agents-row-mark"><Icon name="arrowLeft" size={13} /></span>
        <span className="agents-row-text"><span className="agents-row-name">Back to the conversation</span></span>
      </button>}
      {[...agents].reverse().map(agent => (
        <button key={agent.key} type="button" className={`agents-row ${agent.status} ${shown?.key === agent.key ? 'current' : ''}`} onClick={() => viewAgent(session.id, agent.callId, agent.engine ? null : agent.taskIndex)}>
          <span className="agents-row-mark"><StatusMark status={agent.status} /></span>
          <span className="agents-row-text"><span className="agents-row-name">{agent.name}</span><span className="agents-row-caption">{caption(agent)}</span></span>
          <Icon name="chevronRight" size={14} className="agents-row-go" />
        </button>
      ))}
    </div>
  </div>;
}
