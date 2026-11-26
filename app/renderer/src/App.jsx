import { useEffect, useMemo, useRef, useState } from 'react';
import { engineCli, engineLabel, isCliEngine, readinessKey } from './engines.js';
import { EngineLogo, EngineMark, Icon, IrisMark } from './Icons.jsx';
import { Sidebar, SessionMenuItems } from './Sidebar.jsx';
import { Composer, ComposerBar, NewSessionTrayHead } from './Composer.jsx';
import { CliLogin, openSubscriptions } from './CliEngines.jsx';
import { Transcript, transcriptBlocks } from './Conversation.jsx';
import { AgentReports, SubagentSummary } from './Subagents.jsx';
import { RightPanel, UsageMetrics } from './RightPanel.jsx';
import { SettingsPage } from './Settings.jsx';
import { FilePane } from './FilePane.jsx';
import { GitReview } from './GitReview.jsx';
import { TerminalPanel } from './TerminalPanel.jsx';
import { Palette } from './Palette.jsx';
import { Modal, Popover, Spinner, Trigger, baseName } from './ui.jsx';
import { AgentsBar, useAgents } from './AgentsBar.jsx';
import { AgentView } from './AgentView.jsx';
import { antigravityTurnSpeed, emptyTranscript, findBlocks, formatTokens } from './transcript.js';
import { sortedBackgroundJobs } from './background-jobs.js';
import { ENGINE_ORDER } from './handoff.js';
import { api, bootstrap, closeConfirm, closeHandoff, handOff, dismissNotice, set as setStore, getState, isPendingSession, newSession, notify, openFile, openPalette, openSettings, runCommand, sendPrompt, setFilePaneOpen, setSidebarAuto, sidebarShown, startSession, toggleRightPanel, toggleSidebar, useStore } from './store.js';

// The session's goal (/goal): objective, state, and pause / resume / clear.
function GoalBanner({ session }) {
  const goal = useStore(s => s.goals[session.id]);
  if (!goal?.objective) return null;
  // (Codex also stops a goal when the plan's usage or the goal's own budget runs out.)
  const label = { active: 'Working', paused: 'Paused', complete: 'Achieved', blocked: 'Blocked', usageLimited: 'Usage limit reached', budgetLimited: 'Budget used up' }[goal.status] ?? goal.status;
  const run = arg => api('prompt', session.id, `/goal ${arg}`).catch(e => notify(e.message, 'error'));
  return (
    <div className={`goal-banner ${goal.status}`}>
      <Icon name="target" size={15} className="goal-icon" />
      <span className="goal-objective" title={goal.objective}>{goal.objective}</span>
      <span className={`goal-state ${goal.status}`}>{goal.status === 'active' && <span className="goal-pulse" />}{label}</span>
      {goal.status === 'active' && <button className="goal-action" onClick={() => run('pause')}>Pause</button>}
      {['paused', 'blocked', 'usageLimited', 'budgetLimited'].includes(goal.status) && <button className="goal-action" onClick={() => run('resume')}>Resume</button>}
      <button className="goal-close" aria-label="Clear goal" title="Clear goal" onClick={() => run('clear')}><Icon name="x" size={13} /></button>
    </div>
  );
}

// The conversation's Ultra task: what Pi works on, for how long, and stop / resume / dismiss. The latest
// progress report and any error show on hover.
const elapsed = ms => { const m = Math.max(0, Math.floor(ms / 60000)), h = Math.floor(m / 60); return m < 1 ? '<1m' : h ? `${h}h ${m % 60}m` : `${m}m`; };
function UltraBanner({ session }) {
  const ultra = useStore(s => s.ultra[session.id]);
  const [, tick] = useState(0);
  const task = ultra?.task;
  useEffect(() => {
    if (task?.status !== 'active') return;
    const timer = setInterval(() => tick(n => n + 1), 30000);
    return () => clearInterval(timer);
  }, [task?.status]);
  if (!task?.objective) return null;
  const retrying = task.status === 'active' && task.retryAt > Date.now();
  const label = task.status === 'active' ? (task.reviewing ? 'Reviewing' : retrying ? 'Retrying soon' : 'Working') : { paused: 'Paused', stalled: 'Stalled', needs_attention: 'Needs attention', complete: 'Done' }[task.status] ?? task.status;
  const run = verb => api('prompt', session.id, `/iris-ultra ${verb}`).catch(e => notify(e.message, 'error'));
  const stop = () => { api('abort', session.id).catch(() => {}); run('pause'); };
  const title = [task.objective, task.progress?.done && `Done: ${task.progress.done}`, task.progress?.next && `Next: ${task.progress.next}`, task.reason, task.lastError].filter(Boolean).join('\n');
  return (
    <div className="ultra-task"><div className={`goal-banner ultra-banner ${task.status}`} title={title}>
      <Icon name="infinity" size={15} className="goal-icon" />
      <span className="goal-objective">{task.objective}</span>
      <span className={`goal-state ${task.status === 'complete' ? 'complete' : ['stalled', 'needs_attention'].includes(task.status) ? 'blocked' : ''}`}>{task.status === 'active' && <span className="goal-pulse" />}{label} · {elapsed((task.finishedAt ?? Date.now()) - task.startedAt)}</span>
      {task.status === 'active' && <button className="goal-action" onClick={stop}>Stop</button>}
      {['paused', 'stalled', 'needs_attention'].includes(task.status) && ultra.enabled && <button className="goal-action" onClick={() => run('resume')}>Resume</button>}
      {task.status !== 'active' && <button className="goal-close" aria-label="Dismiss" title="Dismiss" onClick={() => run('dismiss')}><Icon name="x" size={13} /></button>}
    </div>{task.status === 'needs_attention' && <div className="ultra-review-gaps" role="status"><strong>{task.reason}</strong><pre>{task.review?.text}</pre></div>}</div>
  );
}

// Hand a conversation to another agent: continue its work there, or have it reviewed. The new conversation opens
// with the message written, to read and send (handoff.js says what it holds).
// Hand off to another agent: a relay from this conversation's agent to the one picked, to continue the work or
// to review it. The line at the top shows who hands to whom (the agent under the pointer, until one is picked);
// picking one opens a new conversation in the same folder with the first message written, to edit and send.
const HANDOFF_MODES = [
  ['continue', 'Continue the work', 'forward', 'Picks up where it stopped, with the files as they are now.'],
  ['review', 'Review the work', 'eye', 'Reads the changes and reports what it would fix. No edits.'],
];
function HandoffHost() {
  const handoff = useStore(s => s.handoff);
  const session = useStore(s => s.sessions.find(x => x.id === s.handoff?.sessionId));
  const [mode, setMode] = useState('continue');
  const [target, setTarget] = useState(null);
  useEffect(() => { if (handoff) { setMode(handoff.mode ?? 'continue'); setTarget(null); } }, [handoff?.sessionId, handoff?.mode]);
  if (!handoff || !session) return null;
  const from = session.engine ?? 'iris';
  // The same agent is one of them: a new conversation of it, with another account or model, say.
  const engines = [from, ...ENGINE_ORDER.filter(engine => engine !== from)];
  const folder = session.noFolder ? 'No folder' : session.project || baseName(session.cwd);
  return (
    <Modal title={mode === 'review' ? 'Review with another agent' : 'Hand off to another agent'} width={520} onClose={closeHandoff}>
      <div className={`handoff ${mode}`}>
        <div className="handoff-relay" aria-hidden="true">
          <div className={`handoff-end from engine-${from}`}><EngineLogo engine={from} size={30} /></div>
          <div className="handoff-line"><span className="handoff-pulse" /></div>
          <div className={`handoff-end to ${target ? `engine-${target}` : 'empty'}`} key={target ?? 'none'}>{target ? <EngineLogo engine={target} size={30} /> : <Icon name="question" size={18} />}</div>
        </div>
        <div className="handoff-relay-labels" aria-hidden="true">
          <span><b>{engineLabel(from)}</b><span className="handoff-subject">{session.title}</span></span>
          <span className="to">{target ? <b>{engineLabel(target)}</b> : <span className="muted">Pick an agent</span>}</span>
        </div>
        <div className="handoff-modes" role="radiogroup" aria-label="What the other agent does">
          {HANDOFF_MODES.map(([value, label, icon, note]) => (
            <button key={value} type="button" role="radio" aria-checked={mode === value} className={`handoff-mode ${mode === value ? 'on' : ''}`} onClick={() => setMode(value)}>
              <span className="handoff-mode-icon"><Icon name={icon} size={16} /></span>
              <span className="handoff-mode-text"><b>{label}</b><span>{note}</span></span>
            </button>
          ))}
        </div>
        <div className="handoff-engines" onMouseLeave={() => setTarget(null)}>
          {engines.map(engine => (
            <button key={engine} type="button" className={`handoff-engine engine-${engine}`} onMouseEnter={() => setTarget(engine)} onFocus={() => setTarget(engine)}
              onClick={() => void handOff(session.id, engine, mode)} aria-label={`${mode === 'review' ? 'Review with' : 'Hand off to'} ${engineLabel(engine)}`}>
              <EngineLogo engine={engine} size={26} /><span>{engineLabel(engine)}{engine === from && <small className="handoff-same">New conversation</small>}</span><Icon name="arrowUpRight" size={14} className="handoff-go" />
            </button>
          ))}
        </div>
        <p className="handoff-note"><Icon name="folder" size={13} /><span>Opens in the same folder ({folder}) on {session.environmentLabel ?? 'this computer'}. The first message points the agent at this conversation; you can edit it before sending.</span></p>
      </div>
    </Modal>
  );
}

function ConfirmHost() {
  const confirm = useStore(s => s.confirm);
  if (!confirm) return null;
  return (
    <Modal title={confirm.title} width={400} onClose={closeConfirm} footer={<>
      <button className="button" onClick={closeConfirm}>Cancel</button>
      <button className="button danger-solid" autoFocus onClick={() => { closeConfirm(); confirm.run(); }}>{confirm.action}</button>
    </>}>{confirm.message && <div className="confirm-text">{confirm.message}</div>}</Modal>
  );
}

function useWindowWidth() {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return width;
}

function NewSessionView() {
  const draft = useStore(s => s.draft);
  const isClaude = draft.engine === 'claude-code', cli = isCliEngine(draft.engine);
  // The chosen agent has nothing to run on yet (a new user, mostly): one line under the heading says how to
  // start, with the two places to go. Nothing is shown while that is still being found out.
  const readiness = useStore(s => s.cliReadiness[readinessKey(draft.engine, draft.environmentId)]);
  const loadingModels = useStore(s => s.catalogLoading);
  const needsStart = cli ? ['missing', 'signedOut'].includes(readiness) : !draft.model && !loadingModels;
  // Warm the selected engine's runtime without waiting for the first message.
  useEffect(() => {
    if (!draft.model && !isClaude && !cli) return;
    const t = setTimeout(() => api('prewarm', { environmentId: draft.environmentId, cwd: draft.cwd, model: draft.model, thinkingLevel: draft.thinkingLevel, speed: draft.speed, engine: draft.engine, cliAccount: draft.cliAccount ?? null }).catch(() => {}), 400);
    return () => clearTimeout(t);
  }, [draft.environmentId, draft.cwd, draft.model?.provider, draft.model?.id, draft.engine, draft.cliAccount, isClaude, cli]);
  return (
    <div className="new-session">
      <div className="welcome-stage">
        <div className="code-empty" aria-label="Ready to code">
          <IrisMark />
          <h1 className="welcome-heading">What can we build today?</h1>
          {needsStart && <p className="welcome-start">To start, <button type="button" className="welcome-link" onClick={() => openSettings(true, 'subscriptions', { environmentId: draft.environmentId })}>sign in with a ChatGPT or Google plan</button> or <button type="button" className="welcome-link" onClick={() => openSettings(true, 'providers')}>add an API key</button>.</p>}
        </div>
        <div className="dock new-session-dock">
          <div className="composer-shell">
            <NewSessionTrayHead />
            <Composer autoFocus placeholder={isCliEngine(draft.engine) ? `Message ${engineLabel(draft.engine)}…` : 'Ask anything, @ to mention, / for actions'} onSubmit={startSession} footer={<ComposerBar />} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ConnectionBanner({ session }) {
  if (session.status === 'reconnecting') {
    const agent = engineCli(session.engine);
    return <div className="conn-banner"><Spinner size={13} /> <span className="conn-text">Reconnecting to <b>{session.environmentLabel}</b>… {agent} keeps working {session.environmentId === 'local' ? 'on this Mac' : 'on the server'}.</span></div>;
  }
  if (session.status === 'disconnected' || session.status === 'error') {
    return <div className="conn-banner error"><Icon name="unplug" size={15} /> <span className="conn-text">{session.statusMessage || 'Disconnected from this conversation.'}</span>
      <button className="button small" onClick={() => api('reconnect', session.id).catch(e => notify(e.message, 'error'))}>Reconnect</button></div>;
  }
  return null;
}

function SessionFindBar({ sessionId, partial, onClose, initialQuery = '' }) {
  const [query, setQuery] = useState(initialQuery);
  const [index, setIndex] = useState(0);
  const [count, setCount] = useState(0);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  // Search what the conversation says, not what happens to be rendered: rows away from the viewport
  // are placeholders, and folded steps keep their details out of the DOM.
  const collect = q => {
    const shown = transcriptBlocks.get(sessionId);
    return shown ? findBlocks(shown.blocks, shown.tools, q) : [];
  };
  const jump = (q, nextIdx) => {
    const hits = collect(q);
    setCount(hits.length);
    document.querySelectorAll('.find-active-block').forEach(el => el.classList.remove('find-active-block'));
    if (!hits.length) { setIndex(0); return; }
    const wrapped = ((nextIdx % hits.length) + hits.length) % hits.length;
    setIndex(wrapped);
    const row = [...document.querySelectorAll('.session-main .transcript-inner > .history-virtual-row')].find(el => el.dataset.historyKey === hits[wrapped]);
    if (!row) return;
    row.classList.add('find-active-block');
    row.scrollIntoView({ block: 'center' });
    // A row that was a placeholder gets its real height once it mounts: centre it again.
    requestAnimationFrame(() => requestAnimationFrame(() => { if (row.isConnected && row.classList.contains('find-active-block')) row.scrollIntoView({ block: 'center' }); }));
  };
  useEffect(() => () => { document.querySelectorAll('.find-active-block').forEach(el => el.classList.remove('find-active-block')); }, []);
  // Opened from a message found with ⌘K: go to its latest mention once the conversation has loaded.
  useEffect(() => {
    if (!initialQuery.trim()) return;
    let tries = 0, timer;
    const look = () => {
      const hits = collect(initialQuery);
      if (hits.length || ++tries > 50) jump(initialQuery, Math.max(0, hits.length - 1));
      else timer = setTimeout(look, 100);
    };
    look();
    return () => clearTimeout(timer);
  }, [initialQuery]);
  return (
    <div className="session-find-bar" role="search" aria-label="Find in conversation">
      <Icon name="search" size={14} className="find-icon" />
      <input ref={inputRef} value={query} placeholder="Find in conversation…" aria-label="Find in conversation"
        onChange={e => { const v = e.target.value; setQuery(v); jump(v, 0); }}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          else if (e.key === 'Enter') { e.preventDefault(); jump(query, index + (e.shiftKey ? -1 : 1)); }
        }} />
      {query.trim() && <span className="find-count" title={partial ? 'Earlier messages are not loaded yet: scroll up to load them, then search again.' : undefined}>{count ? `${index + 1} / ${count}` : '0 results'}{partial ? ' · loaded part' : ''}</span>}
      <button type="button" className="icon-button" disabled={!count} onClick={() => jump(query, index - 1)} aria-label="Previous match" title="Previous (⇧↵)"><Icon name="chevronUp" size={14} /></button>
      <button type="button" className="icon-button" disabled={!count} onClick={() => jump(query, index + 1)} aria-label="Next match" title="Next (↵)"><Icon name="chevronDown" size={14} /></button>
      <button type="button" className="icon-button" onClick={onClose} aria-label="Close find" title="Close (Esc)"><Icon name="x" size={14} /></button>
    </div>
  );
}

function SessionView({ session }) {
  const gitReviewOpen = useStore(s => s.gitReviewOpen);
  const transcript = useStore(s => s.transcripts[session.id]) ?? emptyTranscript();
  const questions = useStore(s => s.questions[session.id]) ?? [];
  const ultraWorking = useStore(s => s.ultra[session.id]?.task?.status === 'active');
  const rightPanel = useStore(s => s.rightPanel);
  const filePaneOpen = useStore(s => s.filePaneOpen);
  const terminalOpen = useStore(s => s.terminalOpen);
  const filePaneMax = useStore(s => s.filePaneMax) && filePaneOpen;
  const { shown: shownAgent } = useAgents(session);
  const [findOpen, setFindOpen] = useState(false);
  // ⌘K found this conversation by a message in it: open Find with those words.
  const findRequest = useStore(s => s.findRequest?.id === session.id ? s.findRequest : null);
  const [findQuery, setFindQuery] = useState('');
  useEffect(() => {
    if (!findRequest) return;
    if (findRequest.query != null) setFindQuery(findRequest.query); // ⌘F opens Find with what was in it
    setFindOpen(true);
    setStore({ findRequest: null });
  }, [findRequest]);
  useEffect(() => {
    const onKey = e => {
      if (e.ctrlKey && e.key === '`') { e.preventDefault(); setStore(st => ({ terminalOpen: !st.terminalOpen })); }
      else if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); runCommand('find'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Relative links in replies (e.g. "authoring/plan.md") open in the file preview.
  useEffect(() => {
    const onOpen = e => openFile(session.id, e.detail);
    window.addEventListener('iris:open-file', onOpen);
    return () => window.removeEventListener('iris:open-file', onOpen);
  }, [session.id]);
  const isClaude = session.engine === 'claude-code', cli = isCliEngine(session.engine);
  // The message box says what a message does now: while the agent works, Enter sends at once (stopping what it
  // is doing) and Option+Enter adds it after the step under way; otherwise, how to begin.
  const placeholder = cli && questions.some(q => q.permission) ? 'Choose a permission option above…'
    : questions.length ? (cli ? 'Choose an answer above, or type your own…' : 'Answer the agent’s question…')
    : cli && session.cli?.authRequired ? 'Sign in to send a message…'
    : !isClaude && !cli && ultraWorking ? 'Add to the task, @ to mention, / for actions'
    : session.streaming ? (cli && session.engine !== 'codex' ? '↵ to send now, stopping this turn' : '↵ to send now · ⌥↵ to add after this step')
    : cli ? `Message ${engineLabel(session.engine)} · / for commands`
    : 'Ask anything, @ to mention, / for actions';
  return (
    <div className={`session-view ${filePaneMax ? 'files-max' : ''}`}>
      <div className="session-main">
        {findOpen && <SessionFindBar key={findQuery} sessionId={session.id} initialQuery={findQuery} partial={!!transcript.history?.next} onClose={() => { setFindOpen(false); setFindQuery(''); }} />}
        {/* An agent of the conversation, in its place (chosen in the title bar's Agents, or from its card). */}
        {shownAgent ? <AgentView key={shownAgent.key} session={session} agent={shownAgent} /> : <>
        {!transcript.messages.length && !transcript.live && !session.streaming && session.status === 'connected' && !questions.length ?
          <div className="code-empty" aria-label="Ready to code">
            <EngineMark engine={session.engine} />
          </div> : <Transcript session={session} transcript={transcript} questions={questions}
          renderSubagents={block => <SubagentSummary key={block.key} sessionId={session.id} call={block.call} tool={transcript.tools[block.call.id]} />}
          renderAgentReport={block => <AgentReports key={block.key} sessionId={session.id} agents={block.agents} />} />}
        <div className="dock">
          <div className="composer-shell">
            <ConnectionBanner session={session} />
            {cli && <CliLogin session={session} />}
            {((!isClaude && !cli) || session.engine === 'codex') && <GoalBanner session={session} />}
            {!isClaude && !cli && <UltraBanner session={session} />}
            <Composer session={session} autoFocus placeholder={placeholder} onSubmit={(text, attachments, options) => sendPrompt(session.id, text, attachments, options)} footer={<ComposerBar session={session} />} />
          </div>
        </div>
        </>}
        {terminalOpen && <TerminalPanel session={session} />}
      </div>
      {gitReviewOpen ? <GitReview key={session.id} session={session} /> : filePaneOpen ? <FilePane key={session.id} session={session} /> : rightPanel && <RightPanel session={session} />}
    </div>
  );
}

function HeaderTelemetry({ session }) {
  const stats = useStore(s => s.stats[session.id]);
  const transcript = useStore(s => s.transcripts[session.id]);
  const jobsSnapshot = useStore(s => s.jobs[session.id]);
  const rightPanel = useStore(s => s.rightPanel);
  const filePaneOpen = useStore(s => s.filePaneOpen);
  const gitReviewOpen = useStore(s => s.gitReviewOpen);
  const runningJobs = useMemo(() => sortedBackgroundJobs(jobsSnapshot?.jobs).filter(j => j.status === 'running').length, [jobsSnapshot]);
  // Both CLIs report context themselves; only Antigravity lacks token counts (its speed is an estimate).
  const antigravity = session.engine === 'antigravity' || session.engine === 'cursor'; // CLIs whose token counts may be missing
  const context = isCliEngine(session.engine) ? session.cli?.contextUsage : stats?.contextUsage;
  const percent = Number.isFinite(context?.percent) ? Math.round(context.percent) : null;
  const contextLabel = Number.isFinite(context?.tokens)
    ? `${formatTokens(context.tokens)} / ${Number.isFinite(context?.contextWindow) ? formatTokens(context.contextWindow) : '—'}`
    : percent != null ? `${percent}%` : null;
  const hasUsage = (transcript?.messages ?? []).some(m => m.role === 'assistant' && (antigravity ? antigravityTurnSpeed(m) : m.usage));
  const inspectorVisible = rightPanel && !filePaneOpen && !gitReviewOpen;
  return <>
    {runningJobs > 0 && !inspectorVisible && (
      <button type="button" className="header-pill live" onClick={() => setStore({ filePaneOpen: false, gitReviewOpen: false, rightPanel: true })} title="View running background tasks">
        <Spinner size={11} /><span>{runningJobs} running</span>
      </button>
    )}
    {!inspectorVisible && (contextLabel || hasUsage) && (
      <Trigger width={264} placement="bottom-end" label="Context and token usage" className="header-pill context-pill"
        title={contextLabel ? `Context: ${contextLabel}` : 'Token usage'}
        menu={() => (
          <div className="telemetry-popover">
            {contextLabel && (
              <div className="telemetry-context">
                <span>Context</span>
                <span className="telemetry-context-val">
                  {contextLabel}
                  {percent != null && <span className={`meter ${percent > 100 ? 'over' : ''}`}><span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></span>}
                </span>
              </div>
            )}
            <UsageMetrics transcript={transcript} antigravity={antigravity} turnRequests={session.cli?.turnRequests} />
          </div>
        )}>
        {percent != null ? <>
          <span className={`context-ring ${percent > 85 ? 'high' : ''}`} style={{ '--pct': `${Math.max(4, Math.min(100, percent))}%` }} />
          <span>{percent}%</span>
        </> : <Icon name="activity" size={13} />}
      </Trigger>
    )}
  </>;
}

function Header({ session, view }) {
  const gitReviewOpen = useStore(s => s.gitReviewOpen);
  const rightPanel = useStore(s => s.rightPanel);
  const filePaneOpen = useStore(s => s.filePaneOpen);
  const terminalOpen = useStore(s => s.terminalOpen);
  const sidebar = useStore(sidebarShown);
  const anchor = useRef(null);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  const local = session?.environmentId === 'local';
  const activeSession = view === 'session' && session && !isPendingSession(session.id);
  // A conversation that is still being opened already has its place in the window: its name and machine are
  // shown, and the tools appear when there is a conversation for them to act on.
  const opening = view === 'session' && session && isPendingSession(session.id);
  return (
    <header className={`main-head drag ${activeSession || opening ? '' : 'welcome-head'} ${sidebar ? '' : 'no-sidebar'}`}>
      {!sidebar && <div className="window-tools no-drag"><button className="tool-button" onClick={toggleSidebar} aria-label="Show sidebar"><Icon name="sidebarToggle" size={18} /></button></div>}
      {opening && <div className="header-context">
        <span className="title-button opening" title={session.title}><EngineLogo engine={session.engine ?? 'iris'} size={16} className="title-engine-logo" title={engineLabel(session.engine)} /><span>{session.title}</span></span>
        {!local && session.environmentLabel && <span className="header-env-badge"><Icon name="terminal" size={11} />{session.environmentLabel}</span>}
      </div>}
      {activeSession ? <>
        {renaming
          ? <input className="title-input no-drag" autoFocus value={title} onChange={e => setTitle(e.target.value)} onBlur={() => { setRenaming(false); if (title.trim()) api('rename', session.id, title.trim()); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(false); }} />
          : <div className="header-context">
              <button ref={anchor} className="title-button no-drag" onClick={() => setMenu(m => !m)} aria-expanded={menu} title={session.title}>
                <EngineLogo engine={session.engine ?? 'iris'} size={16} className="title-engine-logo" title={engineLabel(session.engine)} /><span>{session.title}</span><Icon name="chevronDown" size={12} />
              </button>
              {!local && session.environmentLabel && (
                <span className="header-env-badge" title={session.cwd}><Icon name="terminal" size={11} />{session.environmentLabel}</span>
              )}
              <AgentsBar session={session} />
            </div>}
        <Popover anchor={anchor} open={menu} onClose={() => setMenu(false)} width={220} placement="bottom-start">
          <SessionMenuItems session={session} close={() => setMenu(false)} onRename={() => { setTitle(session.title); setRenaming(true); }} />
        </Popover>
        <div className="main-tools no-drag">
          <HeaderTelemetry session={session} />
          <button className={`tool-button git-review-toggle ${gitReviewOpen ? 'on' : ''}`} onClick={() => setStore({ gitReviewOpen: !gitReviewOpen, filePaneOpen: false, filePaneMax: false })} aria-label="Review Git changes" aria-pressed={gitReviewOpen} title="Review repository changes"><Icon name="fileDiff" size={16} /></button>
          <button className={`tool-button ${terminalOpen ? 'on' : ''}`} onClick={() => setStore({ terminalOpen: !terminalOpen })} aria-label="Terminal" aria-pressed={terminalOpen} title="Terminal (⌃`)"><Icon name="terminalPanel" size={16} /></button>
          <button className={`tool-button ${filePaneOpen ? 'on' : ''}`} onClick={() => setFilePaneOpen(!filePaneOpen)} aria-label="Files" aria-pressed={filePaneOpen} title="Files"><Icon name="folder" size={16} /></button>
          <button className={`tool-button ${rightPanel && !filePaneOpen && !gitReviewOpen ? 'on' : ''}`} onClick={() => { if (filePaneOpen || gitReviewOpen) { setStore({ filePaneOpen: false, gitReviewOpen: false, rightPanel: true }); } else toggleRightPanel(); }} aria-label="Conversation details" aria-pressed={rightPanel && !filePaneOpen && !gitReviewOpen} title="Conversation details"><Icon name="panel" size={16} /></button>
        </div>
      </> : null}
    </header>
  );
}

export function App() {
  const ready = useStore(s => s.ready);
  const view = useStore(s => s.view);
  const activeId = useStore(s => s.activeId);
  const sessions = useStore(s => s.sessions);
  const settingsOpen = useStore(s => s.settingsOpen);
  const paletteOpen = useStore(s => s.paletteOpen);
  const notices = useStore(s => s.notices);
  const sidebar = useStore(sidebarShown);
  const pendingSession = useStore(s => s.pendingSessions[s.activeId]);
  // Only a conversation that is still being created is drawn from here. Reading every conversation's
  // transcript would redraw the whole window, sidebar included, on each frame of a reply.
  const pendingTranscript = useStore(s => s.pendingSessions[s.activeId] ? s.transcripts[s.activeId] : null);
  useEffect(() => { bootstrap().catch(e => notify(e.message, 'error')); }, []);
  // A narrow window keeps the conversation readable: with a panel open on the right (details, files, Git
  // review) the sidebar steps aside below 1180px, and without one below 860px.
  const width = useWindowWidth();
  const sideOpen = useStore(s => s.view === 'session' && (s.rightPanel || s.filePaneOpen || s.gitReviewOpen));
  const peek = useStore(s => s.sidebarAuto && s.sidebarPeek);
  useEffect(() => setSidebarAuto(width < (sideOpen ? 1180 : 860)), [width, sideOpen]);
  // Dim the chrome while the window is in the background. Focus moving into an embedded frame is not a blur.
  useEffect(() => {
    const sync = () => setTimeout(() => document.body.classList.toggle('window-inactive', !document.hasFocus()), 0);
    const activate = () => document.body.classList.remove('window-inactive');
    window.addEventListener('blur', sync); window.addEventListener('focus', activate);
    return () => { window.removeEventListener('blur', sync); window.removeEventListener('focus', activate); };
  }, []);
  useEffect(() => {
    const onKey = e => {
      if (e.metaKey && e.key.toLowerCase() === 'k') { e.preventDefault(); runCommand('search'); }
      else if (e.metaKey && e.key.toLowerCase() === 'n') { e.preventDefault(); runCommand('new'); }
      else if (e.metaKey && e.key === '\\') { e.preventDefault(); runCommand('sidebar'); }
      else if (e.metaKey && e.key === ',') { e.preventDefault(); runCommand('settings'); }
      // (Marked as used: what is under it, an agent's view, does not close with the same Esc.)
      else if (e.key === 'Escape' && getState().settingsOpen && !document.querySelector('.modal')) { e.preventDefault(); openSettings(false); }
      else if (e.key === 'Escape' && getState().sidebarAuto && getState().sidebarPeek) { e.preventDefault(); toggleSidebar(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // The window carries the open conversation's name: Mission Control and the Window menu show it.
  const windowTitle = view === 'session' ? (pendingSession ?? sessions.find(s => s.id === activeId))?.title : null;
  useEffect(() => { document.title = windowTitle || 'Iris'; }, [windowTitle]);
  if (!ready) return <div className="app loading" />;
  const pending = isPendingSession(activeId);
  const session = pendingSession ?? sessions.find(s => s.id === activeId);
  const toasts = <div className="toasts">{notices.map(n => <div key={n.id} className={`toast ${n.level}`}><Icon name={n.level === 'error' ? 'alert' : 'check'} size={15} /> <span className="toast-text">{n.message}</span>
    {n.action && <button className="toast-action" onClick={() => { dismissNotice(n.id); n.action.run(); }}>{n.action.label}</button>}</div>)}</div>;
  return (
    <div className="app workspace-app">
      {sidebar && <Sidebar peek={peek} />}
      {peek && <div className="sidebar-scrim" onClick={toggleSidebar} />}
      <main className="main">
        <Header session={session} view={view} />
        {view === 'session' && session ? (pending
          ? <div className="session-view"><div className="session-main">
              <Transcript session={session} transcript={pendingTranscript ?? emptyTranscript()} questions={[]} />
              {/* The message box is where it will be, so nothing moves when the conversation is there. */}
              <div className="dock"><div className="composer-shell">
                <div className="composer with-toolbar opening">
                  <div className="composer-box"><div className="composer-row">
                    <span className="composer-plus" aria-hidden="true"><Icon name="plus" size={22} stroke={1.45} /></span>
                    <textarea rows={1} disabled aria-label="Message" placeholder={`${engineLabel(session.engine)} is working on your first message…`} />
                  </div></div>
                  <div className="composer-toolbar" aria-hidden="true" />
                </div>
              </div></div>
            </div></div>
          : <SessionView key={session.id} session={session} />) : <NewSessionView />}
      </main>
      {settingsOpen && <SettingsPage />}
      {paletteOpen && <Palette />}
      <ConfirmHost />
      <HandoffHost />
      {toasts}
    </div>
  );
}
