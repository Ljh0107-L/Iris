// The agents a conversation started, in the title bar: a pill that says how many there are (and how many are
// working), opening a panel with each one, and from it one agent: what it was asked, the steps it took, and
// what it reported. Every engine's agents are here (agents.js); Iris's own open as the conversation they are,
// with their controls (SubagentDetail).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { Markdown, Popover, Spinner, fileBadgeKind } from './ui.jsx';
import { clearSubagentRecords, closeAgents, closeSubagent, openAgents, openFile, openSubagent, useStore } from './store.js';
import { agentStatusLabel, agentsSummary, conversationAgents } from './agents.js';
import { formatTokens } from './transcript.js';
import { isSubagentFinished } from './subagent-state.js';
import { SubagentDetail } from './Subagents.jsx';
import { describeCall } from './Conversation.jsx';

const NO_LIVE = {};
const duration = ms => ms < 1000 ? '<1s' : ms < 60000 ? `${Math.floor(ms / 1000)}s` : ms < 3600000 ? `${Math.floor(ms / 60000)}m ${Math.floor(ms % 60000 / 1000)}s` : `${Math.floor(ms / 3600000)}h ${Math.floor(ms % 3600000 / 60000)}m`;
const firstLine = text => String(text ?? '').split('\n').map(line => line.replace(/[*_`#>]/g, '').trim()).find(Boolean) ?? '';
const textOf = result => (result?.content ?? []).filter(c => c?.type === 'text').map(c => c.text ?? '').join('\n').trim();

function StatusMark({ status, size = 14 }) {
  if (status === 'running') return <Spinner size={size - 1} />;
  return <Icon name={status === 'completed' ? 'check' : status === 'queued' ? 'timer' : status === 'cancelled' ? 'x' : 'alert'} size={size} />;
}

function caption(agent) {
  return [agent.type, agentStatusLabel(agent.status), agent.steps ? `${agent.steps} ${agent.steps === 1 ? 'step' : 'steps'}` : null, agent.tokens > 0 ? `${formatTokens(agent.tokens)} tok` : null]
    .filter(Boolean).join(' · ');
}

export function AgentsBar({ session }) {
  const transcript = useStore(s => s.transcripts[session.id]);
  const live = useStore(s => s.agents[session.id] ?? NO_LIVE);
  const open = useStore(s => s.agentsOpen === session.id);
  const selection = useStore(s => s.subagentSelection[session.id]);
  const anchor = useRef(null);
  const agents = useMemo(() => conversationAgents(session, transcript, live), [session, transcript, live]);
  if (!agents.length) return null;
  const { running, label } = agentsSummary(agents);
  const selected = selection && agents.find(agent => agent.callId === selection.callId && (agent.engine || agent.taskIndex === selection.taskIndex));
  return <>
    <button ref={anchor} type="button" className={`header-pill agents-pill no-drag ${running ? 'live' : ''} ${open ? 'on' : ''}`} aria-expanded={open} aria-label={`Agents: ${label}`}
      onClick={() => open ? closeAgents() : openAgents(session.id)} title="Agents this conversation started">
      {running ? <Spinner size={11} /> : <Icon name="fork" size={12} />}<span>{label}</span>
    </button>
    <Popover anchor={anchor} open={open} onClose={closeAgents} placement="bottom-start" width={selected ? 560 : 420} className={`agents-panel ${selected ? (selected.engine ? 'detail' : 'detail iris') : ''}`}>
      {selected ? (selected.engine
        ? <EngineAgentDetail key={selected.key} sessionId={session.id} agent={selected} />
        : <div className="agents-iris-detail"><SubagentDetail key={selected.key} sessionId={session.id} task={selected.task} /></div>)
        : <AgentList session={session} agents={agents} />}
    </Popover>
  </>;
}

function AgentList({ session, agents }) {
  const { running, total } = agentsSummary(agents);
  const finishedIris = agents.some(agent => !agent.engine && isSubagentFinished(agent.task));
  return <div className="agents-list">
    <div className="agents-list-head">
      <b>Agents</b><span className="muted">{running ? `${running} running · ${total} in all` : `${total} in all`}</span>
      {finishedIris && <button type="button" className="link-button" title="Clear finished task records from this conversation’s task history" onClick={() => clearSubagentRecords(session.id)}>Clear</button>}
    </div>
    <div className="agents-list-rows">
      {[...agents].reverse().map(agent => (
        <button key={agent.key} type="button" className={`agents-row ${agent.status}`} onClick={() => openSubagent(session.id, agent.callId, agent.engine ? null : agent.taskIndex)}>
          <span className="agents-row-mark"><StatusMark status={agent.status} /></span>
          <span className="agents-row-text"><span className="agents-row-name">{agent.name}</span><span className="agents-row-caption">{caption(agent)}</span></span>
          <Icon name="chevronRight" size={14} className="agents-row-go" />
        </button>
      ))}
    </div>
  </div>;
}

// An agent of Claude Code, Codex, Cursor or Antigravity: what it was asked, what it did, what it said.
function EngineAgentDetail({ sessionId, agent }) {
  const [, tick] = useState(0);
  const [briefOpen, setBriefOpen] = useState(false);
  const steps = useRef(null);
  const { call, tool, status } = agent;
  const a = call.arguments ?? {}, details = tool?.result?.details ?? {};
  const report = status === 'running' ? '' : textOf(tool?.result);
  // (Its last words are often its report: shown once, as the report.)
  const list = (Array.isArray(details.steps) ? details.steps : []).filter(step => step && (step.type === 'tool' || (step.type === 'text' && step.text?.trim() && !(report && report.startsWith(step.text.trim().replace(/…$/, ''))))));
  const toolSteps = list.filter(step => step.type === 'tool').length;
  const run = details.agentRuns?.[0];
  const elapsed = details.agentMs ?? tool?.durationMs ?? null;
  useEffect(() => {
    if (status !== 'running') return;
    const timer = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(timer);
  }, [status]);
  // While it works, the newest step stays in view.
  useEffect(() => { if (status === 'running' && steps.current) steps.current.scrollTop = steps.current.scrollHeight; }, [status, list.length]);
  const brief = String(a.prompt ?? '').trim();
  return <div className="agent-detail">
    <div className="agent-detail-head">
      <button type="button" className="tool-button" aria-label="Back to agents" onClick={() => closeSubagent(sessionId)}><Icon name="arrowLeft" size={16} /></button>
      <b title={agent.name}>{agent.name}</b>
      <span className={`agent-status ${status}`}><StatusMark status={status} size={12} />{agentStatusLabel(status)}</span>
    </div>
    <div className="agent-detail-meta">
      {[a.subagent_type && a.subagent_type !== 'Agent' ? a.subagent_type : 'Agent', a.model || run?.model, toolSteps ? `${toolSteps} ${toolSteps === 1 ? 'step' : 'steps'}` : null,
        run?.usage?.totalTokens ? `${formatTokens(run.usage.totalTokens)} tokens` : null, elapsed != null ? duration(elapsed) : null].filter(Boolean).join(' · ')}
    </div>
    <div className="agent-detail-body" ref={steps}>
      {brief && <section className={`agent-brief ${briefOpen ? 'open' : ''}`}>
        <div className="agent-section-title">Brief</div>
        <div className="agent-brief-text">{brief}</div>
        {brief.length > 280 && <button type="button" className="link-button" onClick={() => setBriefOpen(v => !v)}>{briefOpen ? 'Show less' : 'Show all'}</button>}
      </section>}
      {list.length > 0 && <section className="agent-steps">
        <div className="agent-section-title">Steps</div>
        {list.map((step, i) => {
          const last = i === list.length - 1 && status === 'running';
          if (step.type === 'text') return <div key={i} className={`agent-step note ${last ? 'now' : ''}`}><span className="agent-step-dot" /><span className="agent-step-note">{firstLine(step.text)}</span></div>;
          const d = describeCall({ name: step.name, arguments: step.arguments });
          const path = ['read', 'edit', 'write', 'NotebookEdit'].includes(step.name) ? (step.arguments?.path ?? step.arguments?.file_path) : null;
          return <div key={step.id ?? i} className={`agent-step ${last ? 'now' : ''}`} title={d.title}>
            <span className="agent-step-dot" />
            {d.verb && <span className="step-verb">{d.verb}</span>}
            {path ? <button type="button" className="file-ref-inline" data-kind={fileBadgeKind(path)} onClick={() => openFile(sessionId, path)}>{d.subject}</button>
              : <span className={`step-subject ${d.raw ? 'mono' : ''}`}>{d.subject}</span>}
            {d.detail && <span className="step-dir">{d.detail}</span>}
          </div>;
        })}
      </section>}
      {status === 'running' && <div className="agent-working"><span className="shimmer">Working…</span></div>}
      {report && <section className={`agent-final ${status}`}>
        <div className="agent-section-title">{status === 'completed' ? 'Report' : 'Last word'}</div>
        <Markdown text={report} sessionId={sessionId} documentPath="" />
      </section>}
      {!brief && !list.length && !report && status !== 'running' && <div className="agent-empty">The agent left no record of its work.</div>}
    </div>
  </div>;
}
