import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isCliEngine } from './engines.js';
import { Icon } from './Icons.jsx';
import { MenuItem, Popover, Spinner, baseName, shortPath } from './ui.jsx';
import { antigravityTurnSpeed, formatTokens, requestReplies, speedDisplay, speedReply, speedTier, ttftOf, turnThoughts, usageOf } from './transcript.js';
import { api, openSettings, stopBackgroundJob, useStore } from './store.js';
import { backgroundElapsed, sortedBackgroundJobs } from './background-jobs.js';
import { BATCH_WAIT_MS, batchesOf, nextBatches, translatedParagraphs } from './thought-batches.js';

function Card({ title, children, open: initial = true, aside, collapsible = true }) {
  const [open, setOpen] = useState(initial);
  return (
    <section className="panel-card">
      <button className="panel-card-head" onClick={collapsible ? () => setOpen(o => !o) : undefined} aria-expanded={collapsible ? open : undefined} disabled={!collapsible}>
        <span>{title}</span>
        {children && collapsible && <Icon name={open ? 'caretDown' : 'caretRight'} size={13} className="muted" />}
        {aside && <span className="panel-card-aside">{aside}</span>}
      </button>
      {open && children && <div className="panel-card-body">{children}</div>}
    </section>
  );
}

// Speed and token usage per turn, where a turn is one model call, with every agent: the last turn's
// speed with a trend of recent turns, and input / cached / output tokens for the last turn and the session.
// Figures update as each turn finishes.
export function UsageMetrics({ transcript, antigravity, turnRequests }) {
  // Codex and Antigravity save a turn as one reply when it ends. The model requests that have ended in the turn
  // being written are counted as they end (the CLI's state names them), so a long first turn shows its speed too.
  // Codex counts each request's tokens; Antigravity counts a turn's at its end, so until then only speed is shown.
  const live = transcript?.live && Array.isArray(turnRequests) ? turnRequests.filter(r => Number.isFinite(r?.ms)).map(request => ({
    role: 'assistant', provider: transcript.live.provider, model: transcript.live.model, stopReason: 'stop', __request: request,
    ...(Number.isFinite(request.input) ? { usage: { ...request, ms: undefined, wait: undefined, lead: undefined, estimated: undefined } } : { usage: { output: request.output }, __speedOnly: true }) })) : [];
  // Antigravity: token counts when the CLI reported them (then it is shown as the others are); from an older
  // CLI, or a turn without counts, only an estimate of the turn's speed.
  if (antigravity && !live.length && !(transcript?.messages ?? []).some(m => m.role === 'assistant' && (m.usage || m.requests?.length))) {
    const reply = (transcript?.messages ?? []).findLast(m => antigravityTurnSpeed(m));
    const speed = antigravityTurnSpeed(reply);
    if (!speed) return null;
    return <div className="usage">
      <div className="usage-speed">
        <div className="usage-speed-metric" title="Estimated output and reasoning over the full turn, including tool time. Not billed usage.">
          <div className="usage-speed-value"><b>~{speed.tps >= 100 ? Math.round(speed.tps) : speed.tps.toFixed(1)}</b><span>tok/s</span></div>
          <span className="usage-speed-kind">Estimated turn TPS</span>
        </div>
        <span className="usage-speed-note">{(speed.durationMs / 1000).toFixed(1)}s</span>
      </div>
    </div>;
  }
  // One entry per model request, with every agent (see requestReplies). A CLI that counts no tokens (Cursor)
  // lists its requests with what each wrote, estimated: their speed is shown, the token table is not.
  const saved = requestReplies(transcript?.messages).filter(m => m.role === 'assistant' && (m.usage || m.__request) && !['error', 'aborted', 'pending', 'deferred'].includes(m.stopReason))
    .map(m => m.usage ? m : { ...m, usage: { output: m.__request.output }, __speedOnly: true });
  const messages = [...saved, ...live], counted = messages.filter(m => !m.__speedOnly);
  if (!messages.length) return null;
  const lastMessage = counted.at(-1);
  const last = lastMessage ? usageOf([lastMessage]) : null;
  const total = usageOf([...(transcript.messages ?? []), ...live.filter(m => !m.__speedOnly)]);
  // The speed of the last reply that could be timed from its first token (see speedReply).
  const speedMessage = speedReply(messages);
  const timed = speedMessage === lastMessage ? last : usageOf([speedMessage]);
  // Compare one provider/model and matching token/timing provenance.
  const recent = messages.slice(-14).filter(m => m.provider === speedMessage.provider && (m.responseModel ?? m.model) === (speedMessage.responseModel ?? speedMessage.model))
    .map(m => usageOf([m])).filter(u => u.tps != null && u.speedBasis === timed.speedBasis && u.speedTokensEstimated === timed.speedTokensEstimated && u.speedTimeEstimated === timed.speedTimeEstimated).map(u => u.tps);
  // The requests after the one shown could not be timed from their first token (one that only calls a tool
  // shows nothing until it ends, with Codex): how many there have been is said, so a figure that stays is not
  // taken for the latest one.
  const behind = messages.length - 1 - messages.lastIndexOf(speedMessage);
  const speed = speedDisplay(timed, { earlier: behind > 0 });
  const tier = speedTier(speedMessage);
  const peak = Math.max(...recent, 1);
  // Beside the speed: the wait for the first token (TTFT) of the last request it was seen for, how much of the
  // prompt came from the cache, and the tokens of the whole conversation (prompt and output, every request).
  const ttft = [...messages].reverse().map(ttftOf).find(ms => ms != null) ?? null;
  const stats = [
    ['TTFT', ttft == null ? '—' : ttft < 1000 ? `${Math.round(ttft)}ms` : `${(ttft / 1000).toFixed(ttft < 10000 ? 2 : 1)}s`, 'The wait from sending the last request to its first token.'],
    ...(last ? [['Cache hit', last.cacheHit == null ? '—' : `${Math.round(last.cacheHit * 100)}%`, `Of the last request’s prompt, how much was read from the cache. Whole conversation: ${total.cacheHit == null ? '—' : `${Math.round(total.cacheHit * 100)}%`}.`],
      ['Total', formatTokens(total.prompt + total.output), `Tokens of the whole conversation, every request’s prompt and output: ${formatTokens(total.prompt)} in (${formatTokens(total.cacheRead)} from the cache), ${formatTokens(total.output)} out.`]] : []),
  ];
  return (
    <div className="usage">
      <div className="usage-speed">
        <div className="usage-speed-metric" title={speed.title}>
          <div className="usage-speed-value"><b>{speed.value}</b><span>tok/s</span></div>
          <span className="usage-speed-kind">{speed.label}{behind > 0 && <span className="usage-speed-ago"> · {behind === 1 ? '1 request ago' : `${behind} requests ago`}</span>}{tier && <span className={`usage-speed-tier ${tier.slower ? 'slower' : ''}`} title={tier.title}>{tier.label}</span>}</span>
        </div>
        {recent.length > 1 && <div className="spark" aria-hidden="true">{recent.map((v, i) => <span key={i} style={{ height: `${Math.max(8, v / peak * 100)}%` }} />)}</div>}
      </div>
      <div className="usage-table">
        {stats.map(([label, value, title]) => <div key={label} className="usage-metric" title={title}><span className="usage-metric-label">{label}</span><span className="usage-metric-value">{value}</span></div>)}
      </div>
    </div>
  );
}

function UsageCard({ transcript, antigravity, turnRequests }) {
  // Worked out from the saved replies and the turn's requests: not again for every word a reply streams.
  const live = !!transcript?.live, provider = transcript?.live?.provider, model = transcript?.live?.model;
  const body = useMemo(() => UsageMetrics({ transcript, antigravity, turnRequests }), // eslint-disable-line react-hooks/exhaustive-deps
    [transcript?.messages, transcript?.tools, live, provider, model, antigravity, turnRequests]);
  if (!body) return null;
  return <Card title="Usage">{body}</Card>;
}

// Only active jobs stay in the card. Completion messages and host-side records are unchanged.
const jobMs = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60 ? ` ${s % 60}s` : ''}`.trim() : `${Math.floor(m / 60)}h ${m % 60}m`;
};
// A background task: one line (what it is, how long it has run, Stop), opening to its command and output.
function BackgroundJob({ job, sessionId, connected, elapsed }) {
  const [stopping, setStopping] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const isStopping = stopping || job.stopping;
  const running = job.status === 'running';
  const stop = async () => {
    setStopping(true);
    try { await stopBackgroundJob(sessionId, job.id, job.startedAt); }
    catch { /* the store shows the error */ }
    finally { setStopping(false); }
  };
  return <div className={`job ${job.status}`} data-job-id={job.id}>
    <div className="job-row">
      <button type="button" className="job-details-toggle job-main" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(value => !value)} title={job.command}>
        {running ? (connected ? <Spinner size={12} /> : <Icon name="timer" size={13} />) : <Icon name={job.status === 'completed' ? 'check' : 'alert'} size={13} />}
        <span className="job-name">{job.description || job.command}</span>
        <span className="job-elapsed">{isStopping ? 'Stopping…' : jobMs(elapsed)}</span>
      </button>
      {running && job.stoppable !== false && <button type="button" className="job-stop" aria-label={`Stop job ${job.id}`} title="Stop" disabled={!connected || isStopping} onClick={stop}><Icon name="stop" size={11} /></button>}
    </div>
    {expanded && <div className="job-details" id={detailId}>
      {job.cwd && <div className="job-cwd"><Icon name="folder" size={13} /><span title={job.cwd}>{job.cwd}</span></div>}
      <div className="job-terminal">
        <div className="job-code"><span className="job-code-label">Command</span><pre className="job-command">{job.command}</pre></div>
        <div className="job-code"><span className="job-code-label">{running ? 'Output' : job.exitCode != null ? `Output · exit ${job.exitCode}` : 'Output'}</span><pre className="job-output">{job.tail || (running ? 'Waiting for output…' : 'No output.')}</pre></div>
      </div>
      {running && job.stoppable === false && <div className="job-note">Iris cannot stop this from outside the agent: ask the agent to stop it.</div>}
    </div>}
  </div>;
}
function BackgroundJobs({ sessionId }) {
  const snapshot = useStore(s => s.jobs[sessionId]);
  const connected = useStore(s => s.sessions.find(session => session.id === sessionId)?.status === 'connected');
  const all = sortedBackgroundJobs(snapshot?.jobs);
  const list = all.filter(job => job.status === 'running');
  const finished = all.filter(job => job.status !== 'running');
  const failed = finished.filter(job => job.status === 'failed' || (job.exitCode != null && job.exitCode !== 0)).length;
  const [showFinished, setShowFinished] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!list.length || !connected) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [list.length, connected]);
  // The card is there while something runs (finished tasks are summed up under the running ones), and goes
  // when the last one ends.
  if (!list.length) return null;
  return <Card title="Background tasks" aside={<span className="panel-pill">{list.length} running</span>}>
    <div className="jobs">
      {!connected && <div className="jobs-offline">Disconnected — showing last known state</div>}
      {list.map(job => <BackgroundJob key={`${job.id}:${job.startedAt}`} job={job} sessionId={sessionId} connected={connected}
        elapsed={backgroundElapsed(job, snapshot, now, connected)} />)}
      {finished.length > 0 && <button type="button" className="jobs-finished" aria-expanded={showFinished} onClick={() => setShowFinished(v => !v)}>
        <Icon name="check" size={13} /><span>{finished.length} finished</span>{failed > 0 && <span className="jobs-failed">{failed} failed</span>}<Icon name={showFinished ? 'caretDown' : 'caretRight'} size={12} />
      </button>}
      {showFinished && finished.map(job => <BackgroundJob key={`${job.id}:${job.startedAt}`} job={job} sessionId={sessionId} connected={connected} elapsed={backgroundElapsed(job, snapshot, now, connected)} />)}
    </div>
  </Card>;
}

// Where this conversation runs: machine, folder and Git branch.
function EnvironmentCard({ session }) {
  const home = useStore(s => s.home);
  const [branch, setBranch] = useState('');
  useEffect(() => {
    let alive = true;
    const refresh = () => api('gitBranch', session.id).then(value => { if (alive) setBranch(value || ''); }).catch(() => {});
    refresh(); window.addEventListener('focus', refresh);
    return () => { alive = false; window.removeEventListener('focus', refresh); };
  }, [session.id, session.cwd]);
  const local = session.environmentId === 'local';
  const cwd = session.cwd;
  const parent = cwd ? cwd.slice(0, cwd.lastIndexOf('/')) || '/' : '';
  return (
    <Card title="Environment" collapsible={false}>
      <div className="panel-row"><Icon name={local ? 'laptop' : 'terminal'} size={18} /><span className="panel-row-text">{local ? 'This computer' : session.environmentLabel}</span></div>
      {cwd && <div className="panel-row" title={cwd}><Icon name="folder" size={18} /><span className="panel-row-text">{session.noFolder ? baseName(cwd) : session.project || baseName(cwd)}<span className="muted"> · {shortPath(parent, home)}</span></span></div>}
      {branch && <div className="panel-row"><Icon name="branch" size={18} /><span className="panel-row-text">{branch}</span></div>}
    </Card>
  );
}

// Agents that Claude Code or Codex started in this conversation (their own Task / spawn-agent tools). Each has
// its card in the conversation; here they are listed together, and a row leads to its card.
// Thinking shown in the reader's language: only when translation is on in Settings → Translation, by the model
// chosen there. A thought is translated in batches of its paragraphs (see thought-batches.js): each paragraph
// counts once it is finished, and the one still being written once it has stood still for a moment (Antigravity
// sends a whole thought at once, and it is then "the last thing written" until the next step begins). A batch
// is never sent twice.
const LANGUAGE_NAMES = { 'Simplified Chinese': '简体中文', 'Traditional Chinese': '繁體中文', English: 'English', Japanese: '日本語', Korean: '한국어', Spanish: 'Español', French: 'Français', German: 'Deutsch' };
const translations = new Map(); // "provider\nmodel\nlanguage\nparagraph" -> { pending } | { text } | { error, at }
const translationWatchers = new Set();
// Only what the card shows is worth translating. A fast model goes through a thought a second: batches still
// waiting when their thought has left the card are dropped, not translated one after another while the thought
// on show waits behind them. A few go out at a time, in the order they are read.
const TRANSLATE_AT_ONCE = 2, TRANSLATE_LIMIT = 6, RETRY_MS = 20000;
const translationQueue = []; // { key, paragraph }, not yet asked for
const translationsOut = new Set(); // keys asked for and not yet answered
let translationsWanted = new Map(); // what the card shows now: key -> paragraph
// Requests already sent for a thought that has since left are not waited for (up to a limit on all of them):
// the thought on show starts at once.
// How many more batches of the thought on show may go out now (those asked for or waiting count).
const translationSlots = () => {
  let busy = 0;
  for (const key of translationsWanted.keys()) if (translationsOut.has(key) || translationQueue.some(q => q.key === key)) busy++;
  return Math.max(0, TRANSLATE_AT_ONCE - busy);
};
function pumpTranslations() {
  const shown = () => { let n = 0; for (const key of translationsOut) if (translationsWanted.has(key)) n++; return n; };
  while (translationQueue.length && translationsOut.size < TRANSLATE_LIMIT && shown() < TRANSLATE_AT_ONCE) {
    const { key, paragraph } = translationQueue.shift();
    translationsOut.add(key);
    api('translate', paragraph).then(text => { translations.set(key, { text }); },
      error => { translations.set(key, { error: error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), at: Date.now() }); })
      .then(() => { translationsOut.delete(key); for (const watch of translationWatchers) watch(); pumpTranslations(); });
  }
}
function useTranslation(paragraphs, choice) {
  const [, redraw] = useState(0);
  const scope = choice?.on && choice.provider && choice.model ? [choice.provider, choice.model, choice.language].join('\n') : null;
  useEffect(() => { const watch = () => redraw(n => n + 1); translationWatchers.add(watch); return () => { translationWatchers.delete(watch); }; }, []);
  useEffect(() => {
    const wanted = new Map(scope ? paragraphs.map(paragraph => [`${scope}\n${paragraph}`, paragraph]) : []);
    translationsWanted = wanted;
    for (let i = translationQueue.length - 1; i >= 0; i--) {
      if (wanted.has(translationQueue[i].key)) continue;
      translations.delete(translationQueue[i].key); translationQueue.splice(i, 1);
    }
    for (const [key, paragraph] of wanted) {
      const known = translations.get(key);
      if (known && !(known.error && Date.now() - known.at > RETRY_MS)) continue; // a failure is tried again after a while
      if (translations.size > 400) translations.delete(translations.keys().next().value);
      translations.set(key, { pending: true });
      translationQueue.push({ key, paragraph });
    }
    pumpTranslations();
  }, [scope, paragraphs.join('\u0000')]);
  return paragraph => scope ? translations.get(`${scope}\n${paragraph}`) ?? null : null;
}
const SETTLED_MS = 700; // a paragraph that has not grown for this long is translated although it may yet grow
const SHOWN_MS = 500;   // a thought is translated once it has been on the card this long: one that is gone sooner was never read

// What the agent is thinking right now: the thought being written, or the last one it had on this turn. One
// at a time: when the next thought begins, the one before it leaves (the conversation keeps them all, folded).
function ThinkingCard({ transcript, working }) {
  const thought = useMemo(() => turnThoughts(transcript).at(-1) ?? null, [transcript?.messages, transcript?.live]);
  const choice = useStore(s => s.settings?.translation);
  const modelName = useStore(s => s.catalog?.find(m => m.provider === choice?.provider && m.id === choice?.model)?.name) ?? choice?.model;
  const live = !!thought?.streaming && working;
  const paragraphs = useMemo(() => (thought?.text ?? '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean), [thought?.text]);
  const [settled, setSettled] = useState(null); // the text that has stood still
  useEffect(() => { const text = thought?.text ?? null; const timer = setTimeout(() => setSettled(text), SETTLED_MS); return () => clearTimeout(timer); }, [thought?.key, thought?.text]);
  const [shown, setShown] = useState(null); // the thought that has been on the card long enough to be read
  useEffect(() => { const key = thought?.key ?? null; const timer = setTimeout(() => setShown(key), SHOWN_MS); return () => clearTimeout(timer); }, [thought?.key]);
  const finished = shown !== (thought?.key ?? null) ? [] : live && settled !== thought?.text ? paragraphs.slice(0, -1) : paragraphs;
  const on = !!(choice?.on && choice.provider && choice.model);
  // The batches of this thought so far (where each ends). A paragraph taken in while it stood still and that
  // grew again takes its batch back out, to go again when it is done.
  const [cut, setCut] = useState({ key: null, ends: [] });
  const ends = cut.key === thought?.key ? cut.ends.filter(end => end <= finished.length) : [];
  const batches = batchesOf(finished, ends);
  const translated = useTranslation(batches.map(batch => batch.text), choice);
  const tail = useRef({ key: null, start: -1, at: 0 }), [, tick] = useState(0);
  useEffect(() => {
    const start = ends.at(-1) ?? 0;
    if (!on || !thought || finished.length <= start) return;
    if (tail.current.key !== thought.key || tail.current.start !== start) tail.current = { key: thought.key, start, at: Date.now() };
    const waited = Date.now() - tail.current.at;
    const next = nextBatches({ finished, ends, complete: !live && finished.length === paragraphs.length, waited, slots: translationSlots() });
    if (next.length !== ends.length) { setCut({ key: thought.key, ends: next }); return; }
    // Not yet: when the first of these has waited long enough (or when a request ends, which redraws the card).
    if (waited < BATCH_WAIT_MS) { const timer = setTimeout(() => tick(n => n + 1), BATCH_WAIT_MS - waited + 20); return () => clearTimeout(timer); }
  });
  const [original, setOriginal] = useState(false);
  useEffect(() => { setOriginal(false); }, [thought?.key]);
  const feed = useRef(null), following = useRef(true);
  useLayoutEffect(() => { following.current = true; }, [thought?.key]);
  useLayoutEffect(() => { const el = feed.current; if (el && following.current) el.scrollTop = el.scrollHeight; });
  if (!thought) return <Card title="Thinking" collapsible={false} aside={<span>{working ? 'Nothing yet' : 'None this turn'}</span>} />;
  const results = batches.map(batch => translated(batch.text));
  const failed = results.find(result => result?.error), pending = on && (results.some(result => result?.pending) || ends.length === 0 || (ends.at(-1) ?? 0) < paragraphs.length);
  const language = LANGUAGE_NAMES[choice?.language] ?? choice?.language;
  // Each paragraph as it is shown: its translation, or the batch's whole translation in its first paragraph's place.
  const shownText = paragraphs.map(paragraph => ({ text: paragraph, pending: false }));
  if (!original) batches.forEach((batch, i) => {
    const result = results[i];
    if (result?.text) translatedParagraphs(batch, result.text).forEach((text, k) => { shownText[batch.from + k] = text == null ? null : { text, pending: false }; });
    else if (result?.pending) for (let k = batch.from; k < batch.to; k++) shownText[k] = { text: paragraphs[k], pending: true };
  });
  return <Card title="Thinking" aside={live ? <span className="panel-pill">Live</span> : null}>
    <div className="thinking-feed" ref={feed} onScroll={e => { const el = e.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
      {shownText.flatMap((item, index) => {
        if (!item) return [];
        // A thought's heading, as Cursor's and Codex's summaries open theirs ("**Considering the tests**"): bold, not asterisks.
        return item.text.split(/\n{2,}/).map((text, k) => {
          const heading = /^\*\*([^*\n]+)\*\*$/.exec(text.trim());
          return <p key={`${index}:${k}`} className={`${live && index === paragraphs.length - 1 ? 'live' : ''} ${item.pending ? 'pending' : ''} ${heading ? 'heading' : ''}`}>{heading ? heading[1] : text}</p>;
        });
      })}
    </div>
    {on && <div className={`thinking-foot ${failed ? 'failed' : ''}`} role="status">
      {failed ? <><Icon name="alert" size={12} /><span className="thinking-foot-text" title={failed.error}>Not translated: {failed.error}</span>
          <button type="button" className="thinking-foot-action" onClick={() => openSettings(true, 'translation')}>Settings</button></>
        : pending ? <><Spinner size={11} kind="orbit" /><span className="thinking-foot-text">Translating into {language}…</span></>
        : <><Icon name="globe" size={12} /><span className="thinking-foot-text" title={`Translated by ${modelName}`}>{original ? 'As the model wrote it' : `${language} · ${modelName}`}</span>
          <button type="button" className="thinking-foot-action" onClick={() => setOriginal(shown => !shown)}>{original ? 'Translation' : 'Original'}</button></>}
    </div>}
  </Card>;
}

// The panel has little room, and what is worth it differs from person to person: each card can be left out.
// The choice is kept, for every conversation.
const PANEL_CARDS = [['environment', 'Environment'], ['context', 'Context'], ['usage', 'Usage'], ['thinking', 'Thinking'], ['jobs', 'Background tasks']];
const PANEL_KEY = 'iris.panel.hidden';
function usePanelCards() {
  const [hidden, setHidden] = useState(() => { try { return new Set(JSON.parse(localStorage.getItem(PANEL_KEY) ?? '[]')); } catch { return new Set(); } });
  const toggle = id => setHidden(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem(PANEL_KEY, JSON.stringify([...next])); } catch { /* kept for this window */ }
    return next;
  });
  return [id => !hidden.has(id), toggle];
}
function PanelChoice({ shows, toggle }) {
  const anchor = useRef(null);
  const [open, setOpen] = useState(false);
  return <div className="panel-tools">
    <button ref={anchor} type="button" className={`tool-button ${open ? 'on' : ''}`} onClick={() => setOpen(o => !o)} title="Choose what this panel shows" aria-label="Choose what this panel shows"><Icon name="sliders" size={14} /></button>
    <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={210} placement="bottom-end">
      {PANEL_CARDS.map(([id, label]) => <MenuItem key={id} label={label} checked={shows(id)} onClick={() => toggle(id)} />)}
    </Popover>
  </div>;
}

export function RightPanel({ session }) {
  const [shows, toggleCard] = usePanelCards();
  const transcript = useStore(s => s.transcripts[session.id]);
  const stats = useStore(s => s.stats[session.id]);
  const antigravity = session.engine === 'antigravity' || session.engine === 'cursor'; // CLIs whose token counts may be missing
  const context = isCliEngine(session.engine) ? session.cli?.contextUsage : stats?.contextUsage;
  const percent = Number.isFinite(context?.percent) ? context.percent : null;
  const contextLabel = Number.isFinite(context?.tokens)
    ? `${formatTokens(context.tokens)} / ${Number.isFinite(context?.contextWindow) ? formatTokens(context.contextWindow) : '—'}`
    : percent != null ? `${Math.round(percent)}%` : session.status === 'connecting' ? 'Loading…' : 'Not reported';
  return (
    <aside className="right-panel">
      <PanelChoice shows={shows} toggle={toggleCard} />
      {shows('environment') && <EnvironmentCard session={session} />}
      {shows('context') && (!antigravity || context) && <Card title="Context" collapsible={false} aside={<span title="Context usage reported by the agent">{contextLabel}{percent != null && Number.isFinite(context?.tokens) ? ` · ${Math.round(percent)}%` : ''}</span>}>
        {percent != null && <div className={`context-bar ${percent > 100 ? 'over' : percent >= 80 ? 'high' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(100, percent))} aria-label="Context window used"><span style={{ width: `${Math.max(1, Math.min(100, percent))}%` }} /></div>}
      </Card>}
      {shows('usage') && <UsageCard transcript={transcript} antigravity={antigravity} turnRequests={session.cli?.turnRequests} />}
      {shows('usage') && antigravity && !context && !transcript?.messages.some(m => antigravityTurnSpeed(m)) && <div className="panel-note">No usage yet</div>}
      {shows('thinking') && <ThinkingCard transcript={transcript} working={!!session.streaming} />}
      {shows('jobs') && <BackgroundJobs key={session.id} sessionId={session.id} />}
    </aside>
  );
}
