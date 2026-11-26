import { Fragment, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { engineLabel, isCliEngine } from './engines.js';
import { conversationAgents, engineAgentStatus } from './agents.js';
import { Icon } from './Icons.jsx';
import { FileContextMenu, Markdown, Spinner, fileBadgeKind, looksLikePath, pointAnchor } from './ui.jsx';
import { changesOf, displayBlocks, failureTitle, formatTokens, isAbortText, listsAtTurnEnd, retainWorkKeys, toolSummary, ultraProgress } from './transcript.js';
import { api, editMessage, firstSentAt, lastActivityAt, restartConversation, setComposerDraft, isPendingSession, loadEarlierHistory, loadHistoryEntry, notify, onFollowRequest, openChanges, openFile, openSettings, requestFollow, useStore } from './store.js';
import { VirtualHistory } from './VirtualHistory.jsx';
import { historyBookmark, restoreHistoryBookmark } from './history-scroll.js';
import { ImagePreview } from './ImagePreview.jsx';
import { DownloadButton, iconFor, sizeLabel } from './FilePane.jsx';
import { changeStats, hunkLines } from './diffs.js';
import { Composer } from './Composer.jsx';
import './permissions.css';

// Disclosure state belongs to the transcript, not a transient grouped row. A streamed thought can
// become a work group, and groups can split when text arrives. Preserve the user's choices by step ID.
const DisclosureContext = createContext(null);
function useDisclosure(ids) {
  const { expanded, setExpanded, pauseFollowing } = useContext(DisclosureContext);
  const keys = Array.isArray(ids) ? ids : [ids];
  const open = keys.some(id => expanded[id]);
  const setOpen = action => {
    pauseFollowing();
    setExpanded(previous => {
      const next = typeof action === 'function' ? action(keys.some(id => previous[id])) : action;
      return { ...previous, ...Object.fromEntries(keys.map(id => [id, next])) };
    });
  };
  return [open, setOpen];
}
const groupIds = items => items.flatMap(item => item.kind === 'tools'
  ? item.calls.map(call => `group:tool:${call.id}`) : [`group:${item.key}`]);

const textOf = result => (result?.content ?? []).map(c => c.text ?? '').join('').replace(/\s+$/, '');

const baseOf = path => String(path ?? '').split('/').filter(Boolean).pop() ?? '';
// A command without a description, as a readable line: no leading "cd …;" / exports, no heredoc bodies.
const shortCommand = command => {
  const full = String(command ?? '').trim();
  const parts = full.split(/<<-?\s*['"]?\w+['"]?/);
  let c = parts[0].replace(/\s+/g, ' ').trim();
  if (parts.length > 1) c = c.replace(/\s+-$/, '') + ' script'; // "python3 - <<'EOF' …" reads "python3 script"
  c = c.replace(/^(?:(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)|export\s+[^;&]+|set\s+-\w+)\s*(?:&&|;)\s*)+/, '');
  return c || full;
};
// Text that fades out at the right edge when it does not fit (as in Claude), instead of an ellipsis.
function FadeText({ className = '', children, title }) {
  const ref = useRef(null);
  const [clipped, setClipped] = useState(false);
  // Measured when it is laid out anew (its size or its text changed), once a frame at most: not on every render
  // (a streaming reply renders every frame, and a measure each time is a layout each time).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const measure = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; setClipped(el.scrollWidth > el.clientWidth + 1); }); };
    const resized = new ResizeObserver(measure), changed = new MutationObserver(measure);
    resized.observe(el);
    changed.observe(el, { childList: true, characterData: true, subtree: true });
    return () => { resized.disconnect(); changed.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  return <span ref={ref} className={`fade-text ${clipped ? 'clipped' : ''} ${className}`} title={title}>{children}</span>;
}

const urlLabel = url => {
  try {
    const u = new URL(url);
    const tail = u.pathname && u.pathname !== '/' ? u.pathname : '';
    return (u.hostname + tail).slice(0, 96);
  } catch { return String(url ?? '').slice(0, 96); }
};

// Whether the last thing in the conversation is a block of steps that is under way, and so carries the mark
// itself. (Blocks that show nothing may follow it; a paragraph, a thought or a message after it means it is not.)
const stepsRunning = (blocks, tools, live) => {
  const block = blocks.findLast(candidate => ['work', 'tools', 'text', 'thinking', 'user', 'error'].includes(candidate.kind));
  if (block?.kind === 'tools') return block.calls.some(call => tools[call.id]?.status === 'running' || (!tools[call.id] && live));
  if (block?.kind !== 'work') return false;
  return block.items.some(item => item.streaming || (item.kind === 'tools' && item.calls.some(call => tools[call.id]?.status === 'running' || (!tools[call.id] && live))));
};
// How long the step under way has been going, counted where it is shown.
function Elapsed({ since }) {
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(timer); }, []);
  const ms = Date.now() - since;
  return ms >= 1000 ? <span className="step-duration">{seconds(ms)}</span> : null;
}
// What marks the step that is under way: four dots changing places for something being done (a command, a file
// read or written, a search), three dots turning for a thought being written. A step that is done has no mark.
function Running({ thinking = false }) {
  return <Spinner size={14} spectrum kind={thinking ? 'tumble' : 'swap'} />;
}
// How a step reads in a row: an icon, a short sentence, and (for files) the folder in grey.
// A step while it runs, as the line under the turn says it: what is being done now ("Editing notes.md"). A
// command with a description is that description; one without, "Running" and the command.
const NOW = { read: 'Reading', write: 'Writing', edit: 'Editing', NotebookEdit: 'Editing', grep: 'Searching for', find: 'Finding', ls: 'Listing', WebSearch: 'Searching the web for', WebFetch: 'Fetching' };
export function runningLabel(call) {
  const d = describeCall(call);
  if (call.name === 'bash') return d.raw ? `Running ${d.subject}` : d.subject;
  if (NOW[call.name]) return [NOW[call.name], d.subject].filter(Boolean).join(' ');
  return d.verb ? [d.verb, d.subject].filter(Boolean).join(' ') : `Running ${d.subject}`;
}
export function describeCall(call) {
  if (call.__trace?.status === 'skipped') return { subject: `${call.name} — not executed`, title: 'Output token limit: incomplete tool arguments were not executed.' };
  const a = call.arguments ?? {};
  const path = a.path ?? a.file_path ?? a.notebook_path ?? '';
  if (call.name?.startsWith('mcp__')) {
    const [, server, method] = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(call.name) ?? [null, 'MCP', call.name.slice(5)];
    const hint = Object.values(a).find(v => typeof v === 'string' && v.trim());
    return { verb: `MCP · ${server}`, subject: method, detail: hint ? String(hint).split('\n')[0].slice(0, 64) : '', title: `${server} / ${method}` };
  }
  switch (call.name) {
    case 'subagent': return { verb: 'Subagents', subject: (a.tasks ?? []).map(t => t.name).join(' · '), title: 'Delegated tasks on this conversation’s machine' };
    case 'subagent_message': return { verb: 'Messaged agent', subject: a.message ?? '', detail: a.id, title: a.message };
    case 'subagent_stop': return { verb: 'Stopped agent', subject: a.id ?? '' };
    case 'Task': return { verb: a.subagent_type ? `Agent · ${a.subagent_type}` : 'Agent', subject: a.description || String(a.prompt ?? '').split('\n')[0].slice(0, 90) || 'Delegated task', title: a.prompt };
    case 'AskUserQuestion': return { verb: 'Asked', subject: String(a.questions?.[0]?.question ?? '').split('\n')[0].slice(0, 120) || 'a question', detail: (a.questions?.length ?? 0) > 1 ? `and ${a.questions.length - 1} more` : '' };
    // Antigravity looking after the commands it left running (saved by older versions as "Run manage_task").
    case 'manage_task': case 'Run manage_task': return a.action === 'list' ? { verb: 'Listed', subject: 'background tasks' }
      : /^(kill|stop|cancel|terminate)$/i.test(a.action ?? '') ? { verb: 'Stopped', subject: 'a background task' } : { verb: 'Checked', subject: 'a background task' };
    case 'TodoWrite': return { verb: 'Updated tasks', subject: `${(a.todos ?? []).length} ${(a.todos ?? []).length === 1 ? 'item' : 'items'}` };
    case 'WebSearch': return { verb: 'Searched web', subject: a.query ?? '', detail: Array.isArray(a.allowed_domains) && a.allowed_domains[0] ? a.allowed_domains[0] : '' };
    case 'WebFetch': return { verb: 'Fetched', subject: urlLabel(a.url), detail: a.prompt ? String(a.prompt).split('\n')[0].slice(0, 60) : '', title: a.url };
    case 'Skill': return { verb: 'Used skill', subject: a.skill ? `/${String(a.skill).replace(/^\//, '')}` : 'skill', detail: a.args ?? '' };
    case 'Workflow': return { verb: 'Workflow', subject: a.description || a.name || String(a.prompt ?? '').split('\n')[0].slice(0, 80) || 'Run workflow' };
    case 'NotebookEdit': return { verb: 'Edited notebook', subject: baseOf(path), detail: a.edit_mode ?? '', title: path };
    case 'EnterPlanMode': return { verb: 'Entered plan mode', subject: '' };
    case 'ExitPlanMode': return { verb: 'Proposed plan', subject: String(a.plan ?? '').split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '' };
    case 'EnterWorktree': return { verb: 'Entered worktree', subject: a.name ?? a.path ?? '' };
    case 'ExitWorktree': return { verb: 'Exited worktree', subject: a.action ?? '' };
    case 'ToolSearch': return { verb: 'Loaded tools', subject: a.query ?? '' };
    case 'CronCreate': case 'ScheduleWakeup': return { verb: 'Scheduled', subject: String(a.prompt ?? a.reason ?? a.cron ?? '').split('\n')[0].slice(0, 80) };
    case 'CronDelete': return { verb: 'Cancelled schedule', subject: a.id ?? '' };
    case 'CronList': return { verb: 'Listed schedules', subject: '' };
    case 'Monitor': return { verb: 'Monitored', subject: a.description || shortCommand(a.command), title: a.command };
    case 'ListAgents': return { verb: 'Listed agents', subject: '' };
    case 'SendMessage': return { verb: 'Messaged', subject: a.to ?? a.recipient ?? 'agent', detail: String(a.message ?? a.content ?? '').split('\n')[0].slice(0, 60) };
    case 'ReportFindings': return { verb: 'Reported findings', subject: String(a.summary ?? a.findings ?? '').split('\n')[0].slice(0, 80) };
    case 'bash': return a.description?.trim() ? { subject: a.description.trim(), title: a.command } : { subject: shortCommand(a.command), title: a.command, raw: true };
    case 'read': return { verb: 'Read', subject: baseOf(path), title: path };
    case 'write': return { verb: 'Wrote', subject: baseOf(path), title: path };
    case 'edit': return { verb: 'Edited', subject: baseOf(path), title: path };
    case 'grep': return { verb: 'Searched for', subject: a.pattern ?? '', detail: a.path };
    case 'find': return { verb: 'Found files', subject: a.pattern ?? a.path ?? '' };
    case 'ls': return { verb: 'Listed', subject: a.path ?? '.' };
    default: {
      // A tool this page has no words for: its name, and the one thing it was given that reads as words
      // (a path, a query). Never its input as JSON: `{}` after a name says nothing.
      const hint = path ? baseOf(path) : Object.values(a).find(v => typeof v === 'string' && v.trim() && v.length <= 200);
      return hint ? { verb: call.name, subject: String(hint).split('\n')[0].slice(0, 120), title: path || undefined } : { subject: call.name };
    }
  }
}

const editHunks = args => args?.edits ?? (args?.oldText !== undefined || args?.old_string !== undefined ? [{ oldText: args.oldText ?? args.old_string, newText: args.newText ?? args.new_string }] : []);
function EditDiff({ hunks }) {
  if (!hunks.length) return null;
  return (
    <div className="diff">
      {hunks.slice(0, 8).map((h, i) => (
        <div key={i} className="diff-hunk">
          {hunkLines(h).map((l, j) => l.type === 'gap' ? <div key={j} className="diff-line gap">⋯</div>
            : <div key={j} className={`diff-line ${l.type}`}><span className="diff-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>{l.text}</div>)}
        </div>
      ))}
    </div>
  );
}

// Inline disclosure triangle, right after a row's text (as in Claude).
const Caret = ({ open }) => <Icon name={open ? 'caretDown' : 'caretRight'} size={14} className="step-caret" />;
const outputText = text => text.length > 8000 ? text.slice(0, 8000) + '\n…' : text;

// bare: the step is the only one in its group, whose line already says what it is. Opening the group then
// shows what the step did, not the same line once more with another arrow to press.
function ToolCall({ call, tool, bare = false }) {
  const [opened, setOpen] = useDisclosure(`tool:${call.id}`);
  const open = bare || opened;
  const { onOpenFile, onFileContextMenu, sessionId, setExpanded } = useContext(DisclosureContext);
  // Shown open as the only step, it stays open when the group gains another (a thought, a second command):
  // what someone is reading must not fold away under them.
  useEffect(() => { if (bare) setExpanded(previous => previous[`tool:${call.id}`] ? previous : { ...previous, [`tool:${call.id}`]: true }); }, [bare, call.id, setExpanded]);
  const detailState = useHistoryDetails([call.__historyRef, tool?.historyRef], open);
  const trace = call.__trace;
  const { verb, subject, detail, mono, title } = describeCall(call);
  const status = tool?.status ?? 'pending';
  const failed = ['error', 'cancelled', 'timed_out'].includes(status);
  const output = textOf(tool?.result);
  const shownOutput = tool?.fullHistory ? output : outputText(output);
  const filePath = call.__historyTruncated ? null : trace?.path ?? (['read', 'edit', 'write', 'NotebookEdit'].includes(call.name) && !failed ? (call.arguments?.path ?? call.arguments?.file_path ?? call.arguments?.notebook_path) : null);
  const hunks = trace || call.__historyTruncated ? [] : call.name === 'edit' ? editHunks(call.arguments) : call.name === 'write' ? [{ oldText: null, newText: String(call.arguments?.content ?? '') }] : call.name === 'NotebookEdit' && call.arguments?.new_source != null ? [{ oldText: null, newText: String(call.arguments.new_source) }] : [];
  const stats = hunks.length && status !== 'error' ? changeStats({ hunks }) : null;
  const openTarget = path => onOpenFile ? onOpenFile(path) : window.dispatchEvent(new CustomEvent('iris:open-file', { detail: path }));
  const a = call.arguments ?? {};
  const isMcp = call.name?.startsWith('mcp__');
  return (
    <div className={`step tool-call ${status} ${open ? 'open' : ''}`} data-tool-id={call.id}>
      {!bare && <div className="step-head tool-call-head" role="button" tabIndex={0} aria-expanded={open}
        onClick={e => { if ((e.metaKey || e.ctrlKey) && filePath) { openTarget(filePath); return; } setOpen(o => !o); }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}>
        {status === 'running' && <Running />}
        <FadeText className="step-text" title={title ?? filePath ?? undefined}>
          {verb && <span className="step-verb">{verb}</span>}
          {filePath ? (
            <span className="step-subject file-ref-inline" data-kind={fileBadgeKind(filePath)} onContextMenu={e => onFileContextMenu?.(e, filePath)}>{subject}</span>
          ) : (
            <span className={`step-subject ${mono ? 'mono' : ''}`}>{subject}</span>
          )}
          {detail && <span className="step-dir">{detail}</span>}
        </FadeText>
        {stats && <span className="step-stats">{stats.added > 0 && <span className="plus">+{stats.added}</span>}{stats.removed > 0 && <span className="minus">−{stats.removed}</span>}</span>}
        {trace?.durationMs != null && <span className="step-duration">{trace.durationMs < 1000 ? '<1s' : seconds(trace.durationMs)}</span>}
        {status === 'skipped' && <span className="step-duration">Skipped</span>}
        {failed && <span className="step-failed">{status === 'cancelled' ? 'Cancelled' : status === 'timed_out' ? 'Timed out' : 'Failed'}</span>}
        <Caret open={open} />
      </div>}
      {open && (
        <div className="step-detail tool-detail">
          {detailState.pending ? <HistoryLoading {...detailState} /> : <>
          {(tool?.result?.content ?? []).filter(c => c.type === 'image' && c.data).map((image, i) => <ImagePreview key={i} src={`data:${image.mimeType};base64,${image.data}`} alt={`${call.name} image ${i + 1}`} />)}
          {trace && call.name !== 'bash' ? <>
            {trace.input && <pre className="tool-command">{call.name === 'bash' ? '$ ' : ''}{trace.input}</pre>}
            {output && <pre className={`tool-output boxed ${failed ? 'error' : ''}`}>{shownOutput}</pre>}
            {!output && status === 'running' && <div className="tool-running">Running…</div>}
          </> : call.name === 'bash'
            ? <div className={`tool-console ${status === 'error' ? 'error' : ''}`}>
                <pre className="tool-command"><span className="prompt">$</span> {a.command}</pre>
                {output && <pre className="tool-output">{shownOutput}</pre>}
                {!output && status === 'running' && <div className="tool-running">Running…</div>}
              </div>
            : call.name === 'WebFetch' || call.name === 'WebSearch'
            ? <div className="cc-web-detail">
                {a.url && <button type="button" className="cc-web-link" onClick={() => api('openExternal', a.url)} title={a.url}><Icon name="globe" size={13} /><span>{a.url}</span><Icon name="externalLink" size={12} /></button>}
                {a.query && <div className="cc-meta-line"><span className="cc-meta-key">Query</span><span>{a.query}</span></div>}
                {a.prompt && <div className="cc-meta-line"><span className="cc-meta-key">Prompt</span><span>{a.prompt}</span></div>}
                {output && (status === 'error' ? <pre className="tool-output boxed error">{shownOutput}</pre> : <div className="step-markdown"><Markdown text={shownOutput} sessionId={sessionId} documentPath="" /></div>)}
                {!output && status === 'running' && <div className="tool-running">Fetching…</div>}
              </div>
            : call.name === 'ExitPlanMode' && a.plan
            ? <div className="step-markdown"><Markdown text={String(a.plan)} sessionId={sessionId} documentPath="" /></div>
            : isMcp || call.name === 'Skill' || call.name === 'Workflow'
            ? <div className="cc-structured-detail">
                {Object.keys(a).length > 0 && <pre className="tool-command">{JSON.stringify(a, null, 2)}</pre>}
                {output && <pre className={`tool-output boxed ${status === 'error' ? 'error' : ''}`}>{shownOutput}</pre>}
                {!output && status === 'running' && <div className="tool-running">Running…</div>}
              </div>
            : <>
                {hunks.length > 0 && <EditDiff hunks={hunks} />}
                {output && call.name !== 'write' && (call.name !== 'edit' || status === 'error') && <pre className={`tool-output boxed ${status === 'error' ? 'error' : ''}`}>{shownOutput}</pre>}
                {!output && status === 'running' && <div className="tool-running">Running…</div>}
              </>}
          {filePath && <button className="step-open" onClick={() => openTarget(filePath)} onContextMenu={e => onFileContextMenu?.(e, filePath)}>Open {baseOf(filePath)}</button>}
          </>}
        </div>
      )}
    </div>
  );
}

function ToolGroup({ calls, tools, live, behind = false }) {
  const running = calls.some(c => tools[c.id]?.status === 'running' || (!tools[c.id] && live));
  const background = behind && calls.some(c => tools[c.id]?.status === 'running');
  const failed = calls.filter(c => tools[c.id]?.status === 'error').length;
  const [open, setOpen] = useDisclosure(calls.map(c => `group:tool:${c.id}`));
  return (
    <div className="tool-group">
      <button className="tool-group-head" onClick={() => setOpen(o => !o)}>
        {running && !background && <Running />}
        <span>{toolSummary(calls)}{background && <span className="group-still">, still running</span>}</span>
        {failed > 0 && <span className="tool-failed">{failed} failed</span>}
        <Icon name={open ? 'caretDown' : 'caretRight'} size={14} />
      </button>
      {open && <div className="tool-group-body">{calls.map(call => <ToolCall key={call.id} call={call} tool={tools[call.id]} />)}</div>}
    </div>
  );
}

// The conversation's colour scheme, kept current: a visual's page takes it, so its frame is see-through.
const themeNow = () => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
function useTheme() {
  const [theme, setTheme] = useState(themeNow);
  useEffect(() => {
    const watcher = new MutationObserver(() => setTheme(themeNow()));
    watcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => watcher.disconnect();
  }, []);
  return theme;
}
const VISUAL_MAX_HEIGHT = 1200; // a taller page scrolls inside its frame
const visualError = error => String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// A visual the agent showed (show_visual): its page, part of the conversation the way a paragraph is, with no
// frame or heading around it, as tall as the page itself. Under it, as a figure's caption, its title and its
// controls (save, start again, fill the window). Filling the window opens it in a view of its own, above
// everything, started afresh there.
function VisualCard({ call, tool, live, superseded = false }) {
  const detailState = useHistoryDetails([call.__historyRef]);
  const { sessionId } = useContext(DisclosureContext) ?? {};
  const theme = useTheme();
  const frameRef = useRef(null), fullRef = useRef(null);
  const [older, showOlder] = useState(false);
  const html = typeof call.arguments?.html === 'string' ? call.arguments.html : null;
  const title = String(call.arguments?.title ?? '').trim() || 'Visual';
  const asked = Number(call.arguments?.height);
  const initial = Math.min(900, Math.max(120, asked || 320));
  const refused = tool?.status === 'error' ? (tool.result?.content ?? []).map(c => c?.text ?? '').join('\n').trim() : null;
  const ready = !!html && (!!tool || !live); // a page still being written is not loaded half-way
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(null);
  const [run, setRun] = useState(0); // starting again: a frame of its own
  const [full, setFull] = useState(false);
  const [height, setHeight] = useState(null); // the page's own, once it says
  const grown = useRef(0);
  useEffect(() => {
    if (!ready || refused) return;
    let alive = true;
    api('visualUrl', html).then(u => { if (alive) { setUrl(u); setError(null); } }, e => { if (alive) setError(visualError(e)); });
    return () => { alive = false; };
  }, [ready, html, refused]);
  useEffect(() => { setHeight(null); grown.current = 0; }, [url, run, theme]);
  useEffect(() => {
    const onMessage = event => {
      const inline = frameRef.current && event.source === frameRef.current.contentWindow;
      const fullView = fullRef.current && event.source === fullRef.current.contentWindow;
      if (!inline && !fullView) return;
      // The page's height. A page that is as tall as its frame plus a little (100vh and a margin) would grow
      // with every answer: it is let grow a few times only.
      if (event.data?.iris === 'size' && inline) {
        const next = Math.min(VISUAL_MAX_HEIGHT, Math.max(24, Math.round(Number(event.data.height) || 0)));
        setHeight(current => {
          if (current != null && next > current && ++grown.current > 4) return current;
          return next;
        });
        return;
      }
      // The page handing the person a message to send (iris.send): it goes in their message box, for them to send.
      if (event.data?.iris !== 'send' || !sessionId) return;
      const text = String(event.data.text ?? '').trim().slice(0, 4000);
      if (!text) return;
      setComposerDraft(sessionId, 'text', () => text);
      setFull(false);
      window.dispatchEvent(new CustomEvent('iris:focus-composer'));
      notify('The visual put a message in the message box. Send it when you are ready.');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [sessionId]);
  useEffect(() => {
    if (!full) return;
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); setFull(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [full]);
  if (!html && detailState.pending) return <HistoryLoading {...detailState} />;
  const lost = !html && !live; // (an agent that gave no page)
  if (superseded && !older) return (
    <div className="visual-card folded" data-tool-id={call.id}>
      <button type="button" className="visual-folded" onClick={() => showOlder(true)} title="Show this version">
        <Icon name="prompt" size={13} /><span className="visual-title">{title}</span><span className="visual-later">Updated later in the conversation</span><Icon name="chevronDown" size={13} />
      </button>
    </div>
  );
  const save = async () => {
    try { const saved = await api('saveVisual', html, title); if (saved) notify(`Saved ${saved.split('/').pop()}`); }
    catch (error) { notify(visualError(error), 'error'); }
  };
  const src = url && `${url}?theme=${theme}`;
  const problem = refused || (lost ? 'the agent gave no page.' : error);
  return (
    <div className={`visual-card ${height == null ? 'measuring' : ''}`} data-tool-id={call.id} role="group" aria-label={`Visual: ${title}`}>
      {problem ? <div className="visual-note error"><Icon name="alert" size={14} /><span><b>{title}</b> was not shown: {problem}</span></div>
        : !src ? <div className="visual-note drawing" style={{ height: Math.min(initial, 200) }}><Icon name="prompt" size={14} /><span className="shimmer">Drawing {title}…</span></div>
        : <>
          <iframe ref={frameRef} key={`${run}:${theme}`} className="visual-frame" src={src} title={title} sandbox="allow-scripts" style={{ height: height ?? initial, colorScheme: theme }} />
          <div className="visual-caption" role="toolbar" aria-label="Visual controls">
            <Icon name="prompt" size={12} /><span className="visual-caption-title" title={title}>{title}</span>
            <button type="button" className="tool-button" onClick={save} title="Save as a web page" aria-label="Save the visual as a web page"><Icon name="download" size={14} /></button>
            <button type="button" className="tool-button" onClick={() => setRun(n => n + 1)} title="Start again" aria-label="Start the visual again"><Icon name="refresh" size={14} /></button>
            <button type="button" className="tool-button" onClick={() => setFull(true)} title="Fill the window" aria-label="Fill the window"><Icon name="maximize" size={14} /></button>
          </div>
        </>}
      {full && src && createPortal(
        <div className="visual-overlay" onMouseDown={e => { if (e.target === e.currentTarget) setFull(false); }}>
          <div className="visual-sheet" role="dialog" aria-label={title}>
            <div className="visual-sheet-head">
              <Icon name="prompt" size={14} /><span className="visual-title">{title}</span>
              <button type="button" className="tool-button" onClick={save} title="Save as a web page" aria-label="Save the visual as a web page"><Icon name="download" size={15} /></button>
              <button type="button" className="tool-button" onClick={() => setFull(false)} title="Back to the conversation (Esc)" aria-label="Exit full window"><Icon name="minimize" size={15} /></button>
            </div>
            <iframe ref={fullRef} className="visual-sheet-frame" src={src} title={title} sandbox="allow-scripts" style={{ colorScheme: theme }} />
          </div>
        </div>, document.body)}
    </div>
  );
}

function ProgressReport({ call, tool, sessionId, live }) {
  const detailState = useHistoryDetails([call.__historyRef, tool?.historyRef]);
  const report = ultraProgress(call, tool);
  if (detailState.pending && !report) return <HistoryLoading {...detailState} />;
  if (!report) return <ToolGroup calls={[call]} tools={{ [call.id]: tool }} live={live} />;
  return (
    <div className="ultra-progress" data-tool-id={call.id} role="group" aria-label="Progress update" title="Progress reported by the agent">
      <div className="ultra-progress-head"><span className="ultra-progress-dot" /><span>Progress</span></div>
      {report.done && <div className="ultra-progress-done"><Markdown text={report.done} sessionId={sessionId} documentPath="" /></div>}
      {(report.next || report.notes) && (
        <div className="ultra-progress-meta">
          {report.next && <div className="ultra-progress-row"><span className="ultra-progress-tag next">Next</span><div className="ultra-progress-cell"><Markdown text={report.next} sessionId={sessionId} documentPath="" /></div></div>}
          {report.notes && <div className="ultra-progress-row"><span className="ultra-progress-tag note">Scope</span><div className="ultra-progress-cell"><Markdown text={report.notes} sessionId={sessionId} documentPath="" /></div></div>}
        </div>
      )}
    </div>
  );
}

// One reasoning step inside a folded group: its first line, opening to the full text.
const firstLine = text => String(text ?? '').split('\n').map(l => l.replace(/[*_`#>]/g, '').trim()).find(Boolean) ?? '';
const thoughtLabel = ms => ms > 800 ? `Thought for ${seconds(ms)}` : 'Thought';
const ReasoningTokens = ({ tokens }) => tokens > 0 ? <span className="reasoning-tokens" title="Reasoning tokens reported by the provider">{formatTokens(tokens)} tokens</span> : null;
function WorkNote({ item }) {
  const [open, setOpen] = useDisclosure(`note:${item.key}`);
  const { sessionId } = useContext(DisclosureContext) ?? {};
  if (item.hidden || item.redacted || !item.text) return <div className="step static"><div className="step-head"><span className="step-text">{thoughtLabel(item.durationMs)}</span><ReasoningTokens tokens={item.tokens} /></div></div>;
  return (
    <div className={`step thought ${open ? 'open' : ''}`}>
      <div className="step-head" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(o => !o)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}>
        {item.streaming && <Running thinking />}
        <FadeText className="step-text">{open ? thoughtLabel(item.durationMs) : firstLine(item.text) || 'Thought'}</FadeText>
        <ReasoningTokens tokens={item.tokens} />
        <Caret open={open} />
      </div>
      {open && <div className="step-detail step-markdown"><ThoughtText text={item.text} sessionId={sessionId} historyRef={item.historyRef} id={item.key} /></div>}
    </div>
  );
}

// The steps of an open group. A long run (Antigravity and Codex can do sixty things without a word between
// them) opens to its last steps, where the work ended up, with the earlier ones one press away: opening a group
// should not push the rest of the conversation a screen and a half down.
const STEPS_SHOWN = 8;
function WorkSteps({ items, calls, tools }) {
  const steps = items.flatMap(item => item.kind === 'tools'
    ? item.calls.map(call => ({ key: call.id, running: tools[call.id]?.status === 'running', render: () => <ToolCall key={call.id} call={call} tool={tools[call.id]} bare={items.length === 1 && calls.length === 1} /> }))
    : [{ key: item.key, render: () => <WorkNote key={item.key} item={item} /> }]);
  // What is still running is at the end, where the latest step is read: a long command begun earlier would
  // otherwise sit at the top, above steps that have long finished, or among the hidden earlier ones.
  const rows = [...steps.filter(row => !row.running), ...steps.filter(row => row.running)];
  const [all, setAll] = useDisclosure(`steps:${rows[0]?.key}`);
  // A step that is open (opened by hand earlier, or by Find in conversation to show a match) is never among the
  // hidden ones: then the whole run shows.
  const { expanded } = useContext(DisclosureContext);
  const early = rows.length <= STEPS_SHOWN + 2 ? [] : rows.slice(0, rows.length - STEPS_SHOWN);
  const hidden = all || early.some(row => expanded[`tool:${row.key}`] || expanded[`note:${row.key}`]) ? 0 : early.length;
  return <div className="work-body">
    {hidden > 0 && <div className="step earlier"><div className="step-head" role="button" tabIndex={0} onClick={() => setAll(true)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAll(true); } }}>
      <span className="step-text">{hidden} earlier steps</span><Icon name="caretRight" size={14} className="step-caret" /></div></div>}
    {rows.slice(hidden).map(row => row.render())}
  </div>;
}

// A thought, opened. A long one shows its first part, and the rest when asked: a page of the model talking to
// itself should not bury the answer under it.
function ThoughtText({ text, sessionId, historyRef, id }) {
  const [full, setFull] = useDisclosure(`thought:${id}`);
  const box = useRef(null);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => { const el = box.current; if (el && !full) setLong(el.scrollHeight > el.clientHeight + 4); }, [text, full]);
  return <>
    <div ref={box} className={`thought-text ${full ? 'full' : ''} ${long && !full ? 'cut' : ''}`}><HistoryContent historyRef={historyRef}><Markdown text={text} sessionId={sessionId} documentPath="" /></HistoryContent></div>
    {long && !full && <button type="button" className="thought-more" onClick={() => setFull(true)}>Show all of it</button>}
  </>;
}

// Consecutive steps folded into one line ("Ran 2 commands, edited plan.md (1 failed) +12"), opening to a card
// with one row per step.
// behind: something came after it in the conversation (the agent wrote on while a step of it runs). Its running
// step is then not what is happening now: it says it is still running, and the line under the turn names it.
function WorkGroup({ items, tools, live, behind = false }) {
  const [open, setOpen] = useDisclosure(groupIds(items));
  const { onOpenFile, onFileContextMenu, sessionId } = useContext(DisclosureContext);
  const calls = items.flatMap(i => i.kind === 'tools' ? i.calls : []);
  const running = items.some(i => i.streaming) || calls.some(c => tools[c.id]?.status === 'running' || (!tools[c.id] && live));
  const failed = calls.filter(c => tools[c.id]?.status === 'error').length;
  const thinkMs = items.reduce((n, i) => n + (i.kind === 'thinking' ? i.durationMs ?? 0 : 0), 0);
  const groupChanges = useMemo(() => changesOf([{ role: 'assistant', content: calls }], tools), [calls, tools]);
  const edits = useMemo(() => groupChanges.map(changeStats).reduce((t, c) => ({ added: t.added + c.added, removed: t.removed + c.removed }), { added: 0, removed: 0 }), [groupChanges]);
  const only = calls.length === 1 ? describeCall(calls[0]) : null;
  const onlyCall = calls.length === 1 ? calls[0] : null;
  const onlyFile = onlyCall && !onlyCall.__historyTruncated && ['read', 'edit', 'write', 'NotebookEdit'].includes(onlyCall.name) && tools[onlyCall.id]?.status !== 'error'
    ? (onlyCall.__trace?.path ?? onlyCall.arguments?.path ?? onlyCall.arguments?.file_path ?? onlyCall.arguments?.notebook_path) : null;
  const summary = (only && !only.mono && !only.raw ? [only.verb, only.subject].filter(Boolean).join(' ') : toolSummary(calls)) || (running ? '' : thoughtLabel(thinkMs));
  const latest = items.at(-1);
  const thinkingNow = running && latest?.kind === 'thinking' && latest.streaming;
  // While a step runs, the line names it ("Running make check"): a long command otherwise reads as the agent
  // having stopped. The step most recently begun of those still running.
  const runningCall = running && !thinkingNow ? calls.findLast(c => tools[c.id]?.status === 'running') : null;
  const now = runningCall ? describeCall(runningCall) : null;
  const nowText = now ? runningLabel(runningCall) : null;
  const othersRunning = runningCall ? calls.filter(c => c !== runningCall && tools[c.id]?.status === 'running').length : 0;
  const background = behind && !!runningCall;
  const stillRunning = background ? calls.filter(c => tools[c.id]?.status === 'running').length : 0;
  // When the step now under way began (the earliest of those still running).
  const started = Math.min(...calls.filter(c => tools[c.id]?.status === 'running' && tools[c.id].startedAt).map(c => tools[c.id].startedAt), Infinity);
  const openTarget = path => onOpenFile ? onOpenFile(path) : window.dispatchEvent(new CustomEvent('iris:open-file', { detail: path }));
  return (
    <div className={`tool-group work ${open ? 'open' : ''}`}>
      <div className="tool-group-head" role="button" tabIndex={0} aria-expanded={open}
        onClick={e => { if ((e.metaKey || e.ctrlKey) && onlyFile) { openTarget(onlyFile); return; } setOpen(o => !o); }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}>
        {running && !background && <Running thinking={thinkingNow} />}
        <FadeText className={`group-summary ${thinkingNow ? 'shimmer' : ''}`}>
          {thinkingNow ? (firstLine(latest.text) || 'Thinking')
            : background ? <>{only ? [only.verb, only.subject].filter(Boolean).join(' ') : toolSummary(calls)}<span className="group-still">{only ? ', still running' : `, ${stillRunning} still running`}</span>
                {!open && <span className="group-live" role="link" tabIndex={0} onClick={e => { e.stopPropagation(); setOpen(true); }} onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); setOpen(true); } }}>View live output</span>}</>
            : nowText ? <>{nowText}{othersRunning > 0 && <span className="group-also"> · {othersRunning} more running</span>}</>
            : onlyFile && only?.verb ? <>
                <span>{only.verb} </span>
                <span className="file-ref-inline" data-kind={fileBadgeKind(onlyFile)} onContextMenu={e => onFileContextMenu?.(e, onlyFile)}>{only.subject}</span>
              </>
            : (summary || 'Working')}
        </FadeText>
        {failed > 0 && <span className="group-failed">({failed} failed)</span>}
        {running && Number.isFinite(started) && <Elapsed since={started} />}
        {(edits.added > 0 || edits.removed > 0) && (
          <span className="group-diff-stats">
            {edits.added > 0 && <span className="plus">+{edits.added}</span>}
            {edits.removed > 0 && <span className="minus">−{edits.removed}</span>}
          </span>
        )}
        <Caret open={open} />
      </div>
      {onlyFile && sessionId && (
        <button type="button" className="work-quick-open" onClick={() => openTarget(onlyFile)} onContextMenu={e => onFileContextMenu?.(e, onlyFile)}
          title={`Open ${onlyFile}`} aria-label={`Open ${only?.subject ?? onlyFile}`}>
          <Icon name="arrowUpRight" size={12} />
        </button>
      )}
      {!onlyFile && sessionId && groupChanges.length > 0 && (
        <button type="button" className="work-quick-open" onClick={() => openChanges(sessionId, groupChanges)}
          title="View changes" aria-label="View changes">
          <Icon name="fileDiff" size={12} />
        </button>
      )}
      {open && <WorkSteps items={items} calls={calls} tools={tools} />}
    </div>
  );
}

const seconds = ms => ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60000)}m ${Math.round(ms % 60000 / 1000)}s`;

// Reasoning comes in four shapes: streamed in full, summarized by the provider, redacted, or hidden
// entirely (billed but never sent). Only the first two have text to open.
function Thinking({ text, streaming, redacted, hidden, durationMs, blockKey, tokens, historyRef }) {
  const [open, setOpen] = useDisclosure([`group:${blockKey}`, `note:${blockKey}`]);
  const { sessionId } = useContext(DisclosureContext) ?? {};
  const label = durationMs > 800 ? `Thought for ${seconds(durationMs)}` : 'Thought';
  if (hidden || redacted || !text) {
    return <div className="thinking"><div className="tool-group-head static">{streaming ? <span className="shimmer">Thinking</span> : <span>{label}</span>}<ReasoningTokens tokens={tokens} /></div></div>;
  }
  const latest = streaming ? text.trim().split('\n').filter(l => l.trim()).at(-1)?.replace(/[*_`#>]/g, '').trim() : null;
  // A thought that is over is one quiet line: how it began (opening to all of it), its length in the tooltip.
  const gist = !streaming ? firstLine(text) : null;
  return (
    <div className="thinking">
      <button className="tool-group-head thinking-head" onClick={() => setOpen(o => !o)} title={[label, tokens > 0 ? `${formatTokens(tokens)} reasoning tokens` : null].filter(Boolean).join(' · ')}>
        {streaming ? <span className="shimmer thinking-latest">{latest || 'Thinking'}</span> : <FadeText className="thinking-gist">{gist || label}</FadeText>}
        <Icon name={open ? 'caretDown' : 'caretRight'} size={14} />
      </button>
      {open && <div className="thinking-body"><ThoughtText text={text} sessionId={sessionId} historyRef={historyRef} id={blockKey} /></div>}
    </div>
  );
}

// Claude Code's native subagent card (`Task` tool): live steps, file pills, token count, and final report.
function ClaudeTaskCard({ call, tool, sessionId }) {
  const [open, setOpen] = useDisclosure(`cc-task:${call.id}`);
  const { onOpenFile, onFileContextMenu } = useContext(DisclosureContext);
  const detailState = useHistoryDetails([call.__historyRef, tool?.historyRef], open);
  const a = call.arguments ?? {};
  // (An agent can work on after its call returned: Antigravity's say so in their result.)
  const status = engineAgentStatus(tool);
  const running = status === 'running';
  const failed = status === 'failed' || status === 'cancelled';
  const details = tool?.result?.details ?? {};
  const steps = Array.isArray(details.steps) ? details.steps.filter(s => s && (s.type === 'tool' || (s.type === 'text' && s.text?.trim()))) : [];
  const toolStepCount = steps.filter(s => s.type === 'tool').length;
  const stepCount = toolStepCount || details.stepCount || 0;
  const agentRun = details.agentRuns?.[0];
  const agentType = a.subagent_type || 'Agent';
  const title = a.description?.trim() || firstLine(a.prompt) || 'Delegated task';
  const output = textOf(tool?.result);
  const latestStep = steps.at(-1);
  const liveLine = running
    ? (latestStep?.type === 'tool'
        ? (() => { const d = describeCall({ name: latestStep.name, arguments: latestStep.arguments }); return [d.verb, d.subject].filter(Boolean).join(' '); })()
        : firstLine(latestStep?.text || output))
    : '';
  const openTarget = path => onOpenFile ? onOpenFile(path) : window.dispatchEvent(new CustomEvent('iris:open-file', { detail: path }));
  return (
    <section className={`cc-task-card ${status} ${open ? 'open' : ''}`} data-tool-id={call.id} aria-label={`Agent task: ${title}`}>
      <button type="button" className="cc-task-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="cc-task-status">
          {running ? <Spinner size={13} /> : failed ? <Icon name="alert" size={14} className="cc-task-err" /> : <Icon name="check" size={14} className="cc-task-ok" />}
        </span>
        <span className="cc-task-badge">{agentType}</span>
        <FadeText className="cc-task-title" title={a.prompt || title}>{title}</FadeText>
        {stepCount > 0 && <span className="cc-task-meta">{stepCount} {stepCount === 1 ? 'step' : 'steps'}</span>}
        {agentRun?.usage?.totalTokens > 0 && <span className="cc-task-meta">{formatTokens(agentRun.usage.totalTokens)} tok</span>}
        {tool?.durationMs != null && <span className="cc-task-meta">{tool.durationMs < 1000 ? '<1s' : seconds(tool.durationMs)}</span>}
        <Caret open={open} />
      </button>
      {running && !open && liveLine && (
        <div className="cc-task-live"><span className="shimmer">{liveLine}</span></div>
      )}
      {open && (
        <div className="cc-task-body">
          {detailState.pending ? <HistoryLoading {...detailState} /> : <>
            {a.prompt && <div className="cc-task-prompt"><span className="cc-meta-key">Brief</span><span>{a.prompt}</span></div>}
            {steps.length > 0 && (
              <div className="cc-task-steps">
                {steps.map((step, idx) => {
                  if (step.type === 'text') {
                    return <div key={idx} className="cc-task-step note"><FadeText>{firstLine(step.text)}</FadeText></div>;
                  }
                  const d = describeCall({ name: step.name, arguments: step.arguments });
                  const stepPath = ['read', 'edit', 'write', 'NotebookEdit'].includes(step.name)
                    ? (step.arguments?.path ?? step.arguments?.file_path ?? step.arguments?.notebook_path)
                    : null;
                  return (
                    <div key={step.id ?? idx} className="cc-task-step">
                      {d.verb && <span className="step-verb">{d.verb}</span>}
                      {stepPath ? (
                        <button type="button" className="file-ref-inline cc-step-file" data-kind={fileBadgeKind(stepPath)} title={stepPath} onClick={() => openTarget(stepPath)} onContextMenu={e => onFileContextMenu?.(e, stepPath)}>
                          {d.subject}
                        </button>
                      ) : (
                        <span className="step-subject">{d.subject}</span>
                      )}
                      {d.detail && <span className="step-dir">{d.detail}</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {!running && output && (failed
              ? <pre className="tool-output boxed error">{outputText(output)}</pre>
              : <div className="cc-task-report"><Markdown text={output} sessionId={sessionId} documentPath="" /></div>)}
          </>}
        </div>
      )}
    </section>
  );
}

// Claude Code's `TodoWrite` checklist card.
// agents: how many agents are still working (the last list of the conversation): said under its step in progress.
function ClaudeTodoCard({ call, tool, live, agents = 0 }) {
  const detailState = useHistoryDetails([call.__historyRef, tool?.historyRef]);
  const todos = Array.isArray(call.arguments?.todos) ? call.arguments.todos.filter(Boolean) : [];
  if (detailState.pending && !todos.length) return <HistoryLoading {...detailState} />;
  if (!todos.length) return null;
  const doneCount = todos.filter(t => t.status === 'completed').length;
  const pct = Math.round((doneCount / todos.length) * 100);
  return (
    <section className="cc-todo-card" data-tool-id={call.id} aria-label="Task checklist">
      <div className="cc-todo-head">
        <Icon name="list" size={14} className="cc-todo-icon" />
        <span className="cc-todo-title">Tasks</span>
        <span className="cc-todo-count">{doneCount}/{todos.length}</span>
        <span className="meter"><span style={{ width: `${pct}%` }} /></span>
      </div>
      <ul className="cc-todo-list">
        {todos.map((item, i) => {
          const state = item.status === 'completed' ? 'completed' : item.status === 'in_progress' ? 'in_progress' : 'pending';
          const label = state === 'in_progress' && item.activeForm ? item.activeForm : item.content;
          return (
            <li key={item.id ?? i} className={`cc-todo-item ${state}`}>
              <span className="cc-todo-mark" aria-hidden="true">
                {state === 'completed'
                  ? <span className="cc-todo-check"><Icon name="check" size={10} stroke={3.2} /></span>
                  : state === 'in_progress'
                    ? (live ? <Spinner size={11} /> : <span className="cc-todo-dot active" />)
                    : <span className="cc-todo-dot" />}
              </span>
              <span className="cc-todo-text">{label}{state === 'in_progress' && agents > 0 && <span className="cc-todo-agents">{agents} {agents === 1 ? 'agent' : 'agents'} working</span>}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function useQuestionAnswer(sessionId, requestId) {
  const [busy, setBusy] = useState(false);
  const send = async payload => {
    setBusy(true);
    requestFollow(sessionId);
    try { await api('answer', sessionId, requestId, payload); } catch (e) { notify(e.message, 'error'); setBusy(false); }
  };
  return [busy, send];
}

function PermissionDetails({ text }) {
  const { pauseFollowing } = useContext(DisclosureContext);
  const id = useId();
  const preview = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = preview.current;
    if (!el || expanded) return;
    el.scrollTop = 0;
    el.scrollLeft = 0;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <div className="cli-permission-details">
      {(clipped || expanded) && <button type="button" className="cli-permission-disclosure" aria-expanded={expanded} aria-controls={id}
        onClick={() => { pauseFollowing(); setExpanded(open => !open); }}>
        <Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={14} />{expanded ? 'Collapse details' : 'Show full details'}
      </button>}
      <pre ref={preview} id={id} className="cli-permission-text" data-expanded={expanded}
        tabIndex={expanded ? 0 : undefined} role={expanded ? 'region' : undefined} aria-label={expanded ? 'Full tool request details' : undefined}>{text}</pre>
    </div>
  );
}

function PermissionCard({ sessionId, question }) {
  const [busy, send] = useQuestionAnswer(sessionId, question.requestId);
  const detailsByLabel = new Map((question.optionDetails ?? []).map(o => [o.label, o.description]));
  // ACP can put the entire command in the title. Keep both fields verbatim in the preview.
  const details = [question.title, question.message].filter(Boolean).join('\n');
  return (
    <div className="cli-permission" role="group" aria-label="Tool permission request" aria-busy={busy}>
      <div className="cli-permission-heading"><Icon name="shieldAlert" size={16} />{question.header || 'Tool permission'}</div>
      {details && <PermissionDetails text={details} />}
      <div className="cli-permission-actions">
        <button type="button" className="button ghost cli-permission-action cli-permission-cancel" disabled={busy} onClick={() => send({ cancelled: true })}>Cancel request</button>
        {(question.options ?? []).map(option => {
          // The adapter supplies the exact scope as the description; the CLI's label is the answer value.
          const scope = detailsByLabel.get(option);
          const remember = scope === 'Allow and remember' || scope === 'Reject and remember';
          const variant = scope === 'Allow once' ? ' primary' : remember ? ' remember' : '';
          return (
            <button key={option} type="button" className={`button cli-permission-action cli-permission-option${variant}`} disabled={busy} onClick={() => send({ value: option })}>
              <span>{option}</span>
              {scope && scope !== option && <span className="cli-permission-scope">{scope}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// A question from Pi or Claude Code (ask_user, AskUserQuestion, ExitPlanMode), answered right in the conversation.
function QuestionCard({ sessionId, question }) {
  const [busy, send] = useQuestionAnswer(sessionId, question.requestId);
  const [text, setText] = useState(question.prefill ?? '');
  const [selected, setSelected] = useState([]);
  const options = question.method === 'select' ? question.options ?? [] : [];
  const detailsByLabel = useMemo(() => new Map((question.optionDetails ?? []).map(o => [o.label, o.description])), [question.optionDetails]);
  const multi = question.method === 'select' && !!question.multiSelect;
  const freeText = question.method !== 'confirm';
  const toggleOption = option => setSelected(prev => prev.includes(option) ? prev.filter(x => x !== option) : [...prev, option]);
  const submitMulti = () => {
    const extra = text.trim();
    const values = extra ? [...selected, extra] : selected;
    if (values.length) send({ value: values });
  };
  return (
    <div className="question-card" role="group" aria-label="Question from agent">
      {question.header && <div className="question-header-chip">{question.header}</div>}
      <div className="question-title">{question.title}</div>
      {question.message && (question.method === 'confirm'
        ? <div className="question-message question-plan"><Markdown text={question.message} sessionId={sessionId} documentPath="" /></div>
        : <div className="question-message">{question.message}</div>)}
      {options.length > 0 && <div className="question-options">
        {options.map((option, i) => {
          const desc = detailsByLabel.get(option);
          const checked = multi && selected.includes(option);
          return (
            <button key={option} type="button" className={`question-option ${checked ? 'checked' : ''}`} disabled={busy}
              aria-pressed={multi ? checked : undefined}
              onClick={() => multi ? toggleOption(option) : send({ value: option })}>
              <span className={`question-key ${multi ? 'checkbox' : ''}`}>{multi ? (checked ? <Icon name="check" size={12} /> : '') : i + 1}</span>
              <span className="question-option-body">
                <span className="question-option-label">{option}</span>
                {desc && <span className="question-option-desc">{desc}</span>}
              </span>
            </button>
          );
        })}
      </div>}
      {freeText && <form className="question-input" onSubmit={e => {
        e.preventDefault();
        if (multi) submitMulti();
        else if (text.trim()) send({ value: text.trim() });
      }}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder={multi ? 'Other (optional)…' : options.length ? 'Something else…' : question.placeholder || 'Type your answer…'} disabled={busy} autoFocus={!options.length} />
        {multi
          ? <button type="submit" className="button primary small" disabled={busy || (!selected.length && !text.trim())}>Submit{selected.length ? ` (${selected.length})` : ''}</button>
          : <button type="submit" className="button primary small" disabled={busy || !text.trim()}>Send</button>}
      </form>}
      <div className="question-actions">
        {question.method === 'confirm'
          ? <><button className="button ghost" disabled={busy} onClick={() => send({ confirmed: false })}>No</button><button className="button primary" disabled={busy} onClick={() => send({ confirmed: true })}>Approve</button></>
          : <button className="button ghost small" disabled={busy} onClick={() => send({ cancelled: true })}>Skip</button>}
      </div>
    </div>
  );
}

// Under each finished reply: copy, and the files this turn changed (opens the change review).
function TurnFooter({ text, changes, sessionId, last }) {
  const [copied, setCopied] = useState(false);
  const totals = useMemo(() => (changes ?? []).map(changeStats).reduce((t, c) => ({ added: t.added + c.added, removed: t.removed + c.removed }), { added: 0, removed: 0 }), [changes]);
  if (!text && !changes?.length) return null;
  return (
    <div className={`turn-foot ${last ? 'last' : ''}`}>
      {text && <button className="turn-action" aria-label="Copy reply" title={copied ? 'Copied' : 'Copy'} onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
        <Icon name={copied ? 'check' : 'copy'} size={14} /></button>}
      {changes?.length > 0 && <button className="changes-pill" onClick={() => openChanges(sessionId, changes)}>
        <Icon name="fileDiff" size={14} />{changes.length === 1 ? changes[0].path.split('/').pop() : `${changes.length} files changed`}
        <span className="plus">+{totals.added}</span><span className="minus">−{totals.removed}</span>
      </button>}
    </div>
  );
}

// Where /goal set an objective.
function GoalMarker({ block }) {
  const [open, setOpen] = useDisclosure(block.key);
  return <div>
    <button type="button" className="goal-marker" aria-expanded={open} aria-label={open ? 'Collapse goal' : 'Show full goal'} onClick={() => setOpen(o => !o)}>
      <Icon name="target" size={15} /><span className="goal-marker-label">Goal</span><span className="goal-marker-text">{block.objective}</span><Caret open={open} />
    </button>
    {open && <div className="goal-marker-body"><HistoryContent historyRef={block.historyRef}>{block.objective}</HistoryContent></div>}
  </div>;
}

// Your text as typed, with list items ("1. …", "- …") given a hanging indent and @file mentions clickable.
const LIST_ITEM = /^(\s*)(\d+[.)]|[-*\u2022])\s+(.*)$/;
const MENTION_TOKEN = /(^|\s)@([\p{L}\p{N}_./-]+(?:\/[\p{L}\p{N}_./-]*)?)/gu;
function renderInlineMentions(str, onFileContextMenu) {
  if (!str || !str.includes('@')) return str;
  const parts = [];
  let last = 0, match;
  MENTION_TOKEN.lastIndex = 0;
  while ((match = MENTION_TOKEN.exec(str)) !== null) {
    const [, lead, candidate] = match;
    const tokenStart = match.index + lead.length;
    if (looksLikePath(candidate)) {
      if (tokenStart > last) parts.push(str.slice(last, tokenStart));
      const partsOfPath = candidate.split('/').filter(Boolean);
      const shortLabel = partsOfPath.length >= 2 && !candidate.endsWith('/') ? partsOfPath.at(-1) : candidate;
      parts.push(
        <span key={tokenStart} className="user-mention" data-kind={fileBadgeKind(candidate)} title={`Open ${candidate}`}
          onClick={() => window.dispatchEvent(new CustomEvent('iris:open-file', { detail: candidate }))}
          onContextMenu={e => onFileContextMenu?.(e, candidate)}>@{shortLabel}</span>
      );
      last = tokenStart + 1 + candidate.length;
    }
  }
  if (!parts.length) return str;
  if (last < str.length) parts.push(str.slice(last));
  return parts;
}
// A user's message is shown as typed, with the three things people do type as Markdown made readable: lists,
// fenced code and `inline code`.
const USER_FENCE = /(?:^|\n)```[^\n]*\n([\s\S]*?)\n```[ \t]*(?=\n|$)/g;
function UserText({ text }) {
  if (!text.includes('```')) return <UserLines text={text} />;
  const parts = [];
  let at = 0;
  for (const m of text.matchAll(USER_FENCE)) {
    if (m.index > at) parts.push(<UserLines key={at} text={text.slice(at, m.index)} />);
    parts.push(<pre key={`c${m.index}`} className="ub-code">{m[1]}</pre>);
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push(<UserLines key={at} text={text.slice(at).replace(/^\n/, '')} />);
  return parts;
}
function userInline(text, onFileContextMenu) {
  if (!text.includes('`')) return renderInlineMentions(text, onFileContextMenu);
  return text.split(/(`[^`\n]+`)/).map((part, i) => part.length > 2 && part.startsWith('`') && part.endsWith('`')
    ? <code key={i} className="ub-inline-code">{part.slice(1, -1)}</code> : <Fragment key={i}>{renderInlineMentions(part, onFileContextMenu)}</Fragment>);
}
function UserLines({ text }) {
  const { onFileContextMenu } = useContext(DisclosureContext) ?? {};
  const lines = text.split('\n');
  const width = m => m[1].replace(/\t/g, '   ').length;
  const items = lines.map(l => LIST_ITEM.exec(l));
  if (!items.some(Boolean)) return userInline(text, onFileContextMenu);
  const base = Math.min(...items.filter(Boolean).map(width)); // the shallowest item is the top level
  return lines.map((line, i) => {
    const m = items[i];
    if (!m) return <div key={i} className="ub-line">{line ? userInline(line, onFileContextMenu) : '\u00a0'}</div>;
    const depth = Math.floor((width(m) - base) / 3);
    return <div key={i} className="ub-li" style={{ '--depth': depth }}><span className="ub-marker">{/\d/.test(m[2]) ? m[2] : '•'}</span>{userInline(m[3], onFileContextMenu)}</div>;
  });
}

// A message you sent: images and files it carried, and (on hover) copy and edit.
function UserMessage({ block, sessionId, editable }) {
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const { onFileContextMenu } = useContext(DisclosureContext) ?? {};
  if (editing) {
    return (
      <div className="user-row editing">
        <Composer autoFocus compact initialText={block.text} placeholder="Edit message" onCancel={() => setEditing(false)}
          onSubmit={async (text, attachments) => {
            const images = (block.images ?? []).map(img => ({ kind: 'image', name: 'image', mimeType: img.mimeType, data: img.data }));
            const files = (block.files ?? []).map(path => ({ kind: 'file', name: path.split('/').pop(), path }));
            setEditing(false);
            await editMessage(sessionId, block.entryId ?? block.ordinal, block.text, text, [...images, ...files, ...attachments]);
          }} />
      </div>
    );
  }
  return (
    <div className="user-row">
      <div className="user-stack">
        {block.images?.length > 0 && <div className="user-images">{block.images.map((img, i) => <ImagePreview key={i} src={`data:${img.mimeType};base64,${img.data}`} alt={`Attached image ${i + 1}`} />)}</div>}
        {block.files?.length > 0 && <div className="user-files">{block.files.map(path => <button key={path} className="attachment file" title={path} onClick={() => window.dispatchEvent(new CustomEvent('iris:open-file', { detail: path }))} onContextMenu={e => onFileContextMenu?.(e, path)}><Icon name="fileAny" size={15} /><span>{path.split('/').pop()}</span></button>)}</div>}
        {block.text && <div className="user-bubble"><UserText text={block.text} /></div>}
        <div className="user-actions">
          <button className="turn-action" aria-label="Copy message" title={copied ? 'Copied' : 'Copy'} onClick={() => { navigator.clipboard.writeText(block.text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}><Icon name={copied ? 'check' : 'copy'} size={14} /></button>
          {editable && <button className="turn-action" aria-label="Edit message" title="Edit" onClick={() => setEditing(true)}><Icon name="edit" size={14} /></button>}
        </div>
      </div>
    </div>
  );
}

// Where Pi summarized the earlier conversation (automatically, on return after the cache expired, or by hand).
function CompactionMarker({ summary, tokensBefore, blockKey, historyRef }) {
  const [open, setOpen] = useDisclosure(`compaction:${blockKey}`);
  const { sessionId } = useContext(DisclosureContext) ?? {};
  return (
    <div className="compaction">
      <button className="compaction-line" onClick={() => setOpen(o => !o)}>
        <span className="compaction-rule" />
        <span className="compaction-label"><Icon name="compact" size={14} /> Conversation compacted{tokensBefore ? ` · ${formatTokens(tokensBefore)} → summary` : ''}<Icon name={open ? 'caretDown' : 'caretRight'} size={13} /></span>
        <span className="compaction-rule" />
      </button>
      {open && <div className="compaction-body"><HistoryContent historyRef={historyRef}><Markdown text={summary ?? ''} sessionId={sessionId} documentPath="" /></HistoryContent></div>}
    </div>
  );
}

function AskBlock({ call, tool }) {
  const answer = textOf(tool?.result).replace(/^The user answered: /, '');
  return (
    <div className="ask-block">
      <div className="ask-q"><Icon name="question" size={15} /> {call.arguments?.question}</div>
      <div className="ask-a">{answer}</div>
    </div>
  );
}

// While Pi or Claude Code works: what it is doing, for how long, and how many tokens it has produced this turn.
const QUIET_MS = 15000, STALL_MS = 180000;
// A turn the agent has said nothing in for minutes, with no step running: say so, and offer what helps.
function StallRow({ session, quiet }) {
  const [busy, setBusy] = useState(null);
  const run = async (what, action) => {
    setBusy(what);
    try { await action(); } catch (error) { notify(String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error'); }
    finally { setBusy(null); }
  };
  return (
    <div className="working stalled" role="status">
      <Icon name="alert" size={14} />
      <span className="stalled-text">No output for {seconds(quiet)}. {engineLabel(session.engine)} may be stuck.</span>
      <button type="button" className="button small" disabled={!!busy} onClick={() => run('stop', () => api('abort', session.id))}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</button>
      <button type="button" className="button small" disabled={!!busy} title="End the agent’s process and start it again from the conversation’s history"
        onClick={() => run('restart', () => restartConversation(session.id))}>{busy === 'restart' ? 'Restarting…' : 'Restart'}</button>
    </div>
  );
}
function WorkingRow({ session, transcript, sending = false }) {
  const [, tick] = useState(0);
  const envPrep = useStore(s => session?.environmentId ? s.envStatus[session.environmentId] : null);
  const ccPrep = useStore(s => session?.environmentId ? s.claudeStatus[session.environmentId] : null);
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t); }, []);
  if (session?.status === 'connecting') {
    const isClaude = session.engine === 'claude-code', cli = isCliEngine(session.engine);
    const agentName = engineLabel(session.engine);
    const connecting = cli
      ? session.environmentId === 'local' ? `Starting ${engineLabel(session.engine)}…` : `Connecting to ${session.environmentLabel}…`
      : 'Connecting…';
    const preparingText = session.statusMessage
      || (isClaude && ccPrep?.status === 'preparing' ? ccPrep.message : null)
      || (envPrep?.status === 'preparing' ? envPrep.message : null)
      || (isClaude ? 'Preparing Claude Code…' : 'Preparing remote environment…');
    const phase = {
      preparing: cli ? connecting : preparingText,
      starting: `Starting ${agentName}…`,
      opening: 'Opening conversation…',
      configuring: 'Restoring conversation…',
    }[session.phase] ?? connecting;
    // A first message has been sent and its conversation is being opened: to the person that is the agent
    // thinking about it, so it reads as that, timed from the moment they sent it. What takes real time and
    // has something to say (a host being set up, an upload with its size) still says it.
    const sent = isPendingSession(session.id) ? transcript.messages.findLast(m => m.role === 'user')?.timestamp : null;
    if (sent) {
      const setup = session.statusMessage || (isClaude && ccPrep?.status === 'preparing' ? ccPrep.message : null) || (envPrep?.status === 'preparing' ? envPrep.message : null);
      const elapsed = Math.max(0, Date.now() - sent);
      return <div className="working"><Spinner size={14} spectrum />{elapsed >= 1000 && <span className="working-meta">{seconds(elapsed)}</span>}<span className="shimmer">{setup || 'Thinking'}</span></div>;
    }
    return <div className="working"><Spinner size={14} spectrum /><span className="shimmer">{phase}</span></div>;
  }
  // Sent, and the agent has not started the turn yet: no timer from the previous turn.
  // The first message of a conversation is timed from when it was sent (the conversation was opened for it).
  const first = session ? firstSentAt(session.id) : null;
  if (sending && !session?.streaming) {
    const waited = first ? Date.now() - first : 0;
    return <div className="working"><Spinner size={14} spectrum />{waited >= 1000 && <span className="working-meta">{seconds(waited)}</span>}<span className="shimmer">Thinking</span></div>;
  }
  const messages = transcript.messages;
  let from = messages.length; while (from > 0 && messages[from - 1].role !== 'user') from--;
  const turn = messages.slice(from);
  const startedAt = first ?? messages[from - 1]?.timestamp ?? turn[0]?.__timing?.start ?? transcript.live?.__t0;
  const live = transcript.live;
  // Real output tokens of the model calls finished so far this turn (no live estimate).
  const tokens = turn.reduce((n, m) => n + (m.role === 'assistant' ? m.usage?.output ?? 0 : 0), 0) + Math.round(transcript.live?.__est ?? 0);
  const lastBlock = live?.content?.filter(Boolean).at(-1);
  const pending = messages.at(-1)?.__interrupting;
  // A step still running after the agent wrote on (a long command it left going): that is what the turn is
  // doing, so the line names it, rather than "Writing" over text that has long been written.
  const runningStep = (live?.content ?? []).filter(b => b?.type === 'toolCall' && transcript.tools[b.id]?.status === 'running').at(-1);
  const stepLabel = runningStep ? runningLabel(runningStep) : null;
  const streamingNow = live?.__tLast != null && Date.now() - live.__tLast < 3000;
  const state = pending ? 'Interrupting…'
    : (session?.compacting ?? transcript.compacting) ? 'Compacting conversation'
    : transcript.retry ? `Reconnecting to model · retry ${transcript.retry.attempt}/${transcript.retry.maxAttempts}`
    : !live || !live.content?.length || lastBlock?.type === 'thinking' ? (stepLabel && !streamingNow ? stepLabel : 'Thinking')
    : lastBlock?.type === 'toolCall' ? (stepLabel ?? 'Working')
    : stepLabel && !streamingNow ? stepLabel : 'Writing';
  const elapsed = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
  // How long the agent has said nothing (no event at all). A while: said, so a long wait for the model reads as
  // that. Long: it may be stuck, and it can be stopped or restarted from here. (A step that is running says so
  // on its own line instead; this one shows only while no step runs.)
  const heard = session ? lastActivityAt(session.id) : null;
  const quiet = heard && startedAt && heard >= startedAt ? Date.now() - heard : startedAt ? elapsed : 0;
  const waiting = state === 'Thinking' || state === 'Writing' ? 'Waiting for the model' : state;
  // (While a step runs, a quiet agent is waiting for it: not stuck, and no "no output" either.)
  if (session && !pending && !runningStep && quiet >= STALL_MS) return <StallRow session={session} quiet={quiet} />;
  return (
    <div className="working">
      <Spinner size={14} spectrum kind={state === 'Writing' ? 'orbit' : 'tumble'} />
      {/* While the model writes, the line has nothing to name: how long, and how much it has written. */}
      {(session?.activityLabel || state !== 'Writing' || quiet >= QUIET_MS) && <span className="shimmer">{session?.activityLabel ?? (quiet >= QUIET_MS && !runningStep ? waiting : state)}</span>}
      {elapsed >= 1000 && <span className="working-meta">{seconds(elapsed)}</span>}
      {tokens > 0 && <span className="working-meta">{formatTokens(tokens)} tokens</span>}
    </div>
  );
}

const NO_QUESTIONS = [];
// What each open conversation currently shows, for Find in conversation (App.jsx): its blocks with the
// keys their rows carry, and the tool results.
export const transcriptBlocks = new Map(); // session id -> { blocks, tools }
// Files the agent handed over with present_files: open one in the file pane, or save it to this Mac.
// Images come first as a grid of thumbnails, so a few of them don't fill the screen; open one to see it
// full size. Other files are one row each.
function FileCards({ sessionId, call, tool }) {
  const detailState = useHistoryDetails([call.__historyRef, tool?.historyRef]);
  const { onFileContextMenu } = useContext(DisclosureContext) ?? {};
  const details = tool?.result?.details;
  const files = details?.kind === 'iris-files' && Array.isArray(details.files) ? details.files : null;
  if (tool?.status === 'error') {
    const text = (tool.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    return <div className="block-error"><Icon name="alert" size={15} /> {text || 'The files could not be shown.'}</div>;
  }
  // Until the result arrives: the paths the model named, without sizes.
  const shown = files ?? (Array.isArray(call.arguments?.paths) ? call.arguments.paths : []).map(path => ({ path: String(path), name: String(path).split('/').pop(), pending: true }));
  if (detailState.pending) return <HistoryLoading {...detailState} />;
  if (!shown.length) return null;
  const isImage = file => !!sessionId && iconFor(file.name) === 'fileImage';
  const images = shown.filter(isImage), others = shown.filter(file => !isImage(file));
  return (
    <section className="file-cards" data-call-id={call.id}>
      {details?.caption && <div className="file-cards-caption">{details.caption}</div>}
      {images.length > 0 && <div className="file-thumbs">{images.map(file => <FileThumb key={file.path} sessionId={sessionId} file={file} onContextMenu={onFileContextMenu} />)}</div>}
      {others.map(file => (
        <div key={file.path} className="file-card">
          <button className="file-card-main" disabled={file.pending || !sessionId} onClick={() => openFile(sessionId, file.path)} onContextMenu={e => { if (!file.pending) onFileContextMenu?.(e, file.path); }} title={file.path}>
            <Icon name={iconFor(file.name)} size={18} className="file-card-icon" />
            <span className="file-card-text"><span className="file-card-name">{file.name}</span><span className="file-card-meta">{file.pending ? 'Preparing…' : sizeLabel(file.size)}</span></span>
          </button>
          {!file.pending && sessionId && <DownloadButton sessionId={sessionId} path={file.path} className="file-card-download" label={<span>Download</span>} />}
        </div>
      ))}
    </section>
  );
}

// One shared image: its thumbnail, name and size; click to open it in the file pane, or download it.
function FileThumb({ sessionId, file, onContextMenu }) {
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if (file.pending) return;
    let alive = true;
    api('readFile', sessionId, file.path).then(result => { if (alive) setPreview(result); }, error => { if (alive) setPreview({ error: error.message }); });
    return () => { alive = false; };
  }, [sessionId, file.path, file.pending]);
  return (
    <div className="file-thumb">
      <button className="file-thumb-main" disabled={file.pending} onClick={() => openFile(sessionId, file.path)} onContextMenu={e => { if (!file.pending) onContextMenu?.(e, file.path); }} title={`Open ${file.name}`}>
        <span className="file-thumb-image">
          {preview?.dataUrl ? <img src={preview.dataUrl} alt={file.name} draggable={false} />
            : preview ? <Icon name="fileImage" size={22} className="file-thumb-missing" />
            : <Spinner size={14} />}
        </span>
        <span className="file-thumb-text"><span className="file-thumb-name">{file.name}</span><span className="file-thumb-meta">{file.pending ? 'Preparing…' : sizeLabel(file.size)}</span></span>
      </button>
      {!file.pending && <DownloadButton sessionId={sessionId} path={file.path} className="file-thumb-download" />}
    </div>
  );
}

function useHistoryDetails(refs, enabled = true) {
  const { sessionId } = useContext(DisclosureContext);
  const key = JSON.stringify(refs.filter(Boolean));
  const [error, setError] = useState(null);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!enabled || !sessionId || key === '[]') return;
    let alive = true;
    setError(null);
    Promise.all(JSON.parse(key).map(ref => loadHistoryEntry(sessionId, ref))).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [sessionId, key, enabled, attempt]);
  return { pending: key !== '[]', error, retry: () => retry(n => n + 1) };
}

function HistoryLoading({ error, retry }) {
  return error ? <button className="history-retry" title={error} onClick={retry}><Icon name="refresh" size={14} /> Retry</button>
    : <span className="history-loading" role="status" aria-label="Loading content"><Spinner /></span>;
}

function HistoryContent({ historyRef, active = true, children }) {
  const detailState = useHistoryDetails([historyRef], active);
  return detailState.pending ? <HistoryLoading {...detailState} /> : children;
}

// A failed model request: what went wrong in a few words, the provider's own sentence under it, and the
// one thing that helps (the key or account in Settings, or compacting a conversation that grew too long).
function ErrorBlock({ block, engine, sessionId }) {
  const failure = block.failure;
  if (!failure) return <div className="block-error"><Icon name="alert" size={15} /> {block.text}</div>;
  const cli = isCliEngine(engine);
  const fix = failure.fix === 'settings'
    ? cli ? { label: 'Open sign-in', run: () => openSettings(true, 'subscriptions') } : { label: 'Open Settings', run: () => openSettings(true, 'providers') }
    : failure.fix === 'compact' && sessionId && !cli ? { label: 'Compact', run: () => api('compact', sessionId).catch(error => notify(error.message, 'error')) } : null;
  return (
    <div className="block-error described" title={block.text}>
      <Icon name="alert" size={15} />
      <div className="block-error-body">
        <div className="block-error-title">{failureTitle(failure, { cli })}</div>
        {failure.detail && <div className="block-error-detail">{failure.detail}</div>}
      </div>
      {fix && <button type="button" className="block-error-action" onClick={fix.run}>{fix.label}</button>}
    </div>
  );
}

export function Transcript({ session, transcript, questions = NO_QUESTIONS, readOnly = false, onOpenFile, renderSubagents, renderAgentReport, copyText }) {
  const scroller = useRef(null);
  const stick = useRef(true);
  const scrollIntent = useRef(false);
  const bookmark = useRef([]);
  const previousTop = useRef(0);
  const initialFill = useRef(0);
  const [following, setFollowing] = useState(true);
  const [expanded, setExpanded] = useState({});
  const [fileMenu, setFileMenu] = useState(null);
  // "Latest" appears only when there is unseen content below — not merely because you opened a step.
  const updateLatest = () => {
    const el = scroller.current;
    if (el) setFollowing(stick.current || el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };
  // What is on screen now (kept as it was when nothing could be found: the conversation covered by a panel, say).
  const bookmarkFrame = useRef(0);
  const takeBookmark = useCallback(() => { const next = historyBookmark(scroller.current); if (next.length) bookmark.current = next; }, []);
  const pauseFollowing = useCallback(() => {
    stick.current = false;
    scrollIntent.current = false;
    takeBookmark();
  }, [takeBookmark]);
  const followLatest = () => {
    stick.current = true;
    setFollowing(true);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  };
  const committed = useRef({ sessionId: session?.id, blocks: [] });
  const blocks = useMemo(() => retainWorkKeys(committed.current.sessionId === session?.id ? committed.current.blocks : [], listsAtTurnEnd(displayBlocks(transcript))), [transcript, session?.id]);
  useLayoutEffect(() => { committed.current = { sessionId: session?.id, blocks }; }, [blocks, session?.id]);
  useLayoutEffect(() => {
    if (readOnly || !session?.id) return;
    const entry = { blocks, tools: transcript.tools };
    transcriptBlocks.set(session.id, entry);
    return () => { if (transcriptBlocks.get(session.id) === entry) transcriptBlocks.delete(session.id); };
  }, [blocks, transcript.tools, session?.id, readOnly]);
  const earlier = async () => {
    const el = scroller.current;
    if (!el || !transcript.history?.next || transcript.history.loading) return;
    pauseFollowing();
    await loadEarlierHistory(session.id);
  };
  const lastUsage = blocks.findLast(b => b.kind === 'usage');
  const lastListKey = blocks.findLast(b => b.kind === 'ccTodo')?.key;
  const liveAgents = useStore(s => session?.id ? s.agents[session.id] : null);
  const agentsWorking = useMemo(() => readOnly ? 0 : conversationAgents(session, transcript, liveAgents ?? {}).filter(a => a.status === 'running' || a.status === 'queued').length, [readOnly, session, transcript, liveAgents]);
  // Groups of steps that the agent wrote on after (text, a visual, a card): a step of theirs still running is not
  // what is happening now (see WorkGroup's `behind`).
  const behind = useMemo(() => {
    const keys = new Set();
    let later = false;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === 'user') later = false;
      else if ((b.kind === 'work' || b.kind === 'tools') && later) keys.add(b.key);
      else if (['text', 'visual', 'ccTask', 'ccTodo', 'files', 'image', 'subagents'].includes(b.kind)) later = true;
    }
    return keys;
  }, [blocks]);
  const onScroll = e => {
    // Output panes also scroll. Their events must not re-enable transcript auto-follow.
    if (e.target !== scroller.current) return;
    const el = scroller.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    const movedUp = el.scrollTop < previousTop.current;
    const moved = Math.abs(el.scrollTop - previousTop.current) > 1;
    previousTop.current = el.scrollTop;
    if (moved) {
      stick.current = atBottom;
      // Taken once a frame at most, however many scroll events come.
      if (!atBottom && !bookmarkFrame.current) bookmarkFrame.current = requestAnimationFrame(() => { bookmarkFrame.current = 0; takeBookmark(); });
    }
    if (el.scrollTop < el.clientHeight * 3 && movedUp && scrollIntent.current && transcript.history?.next) earlier();
    scrollIntent.current = false;
    updateLatest();
  };
  // (Following the end, there is nothing to keep in place: the bookmark is taken when following stops.)
  const retainPosition = () => {
    if (stick.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    else restoreHistoryBookmark(scroller.current, bookmark.current);
    previousTop.current = scroller.current?.scrollTop ?? 0;
    updateLatest();
  };
  const retainRef = useRef(retainPosition); retainRef.current = retainPosition;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => { if (el.clientHeight) retainRef.current(); });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(retainPosition, [blocks, questions]);
  useEffect(() => { initialFill.current = 0; setExpanded({}); followLatest(); }, [session?.id]);
  // Your own message is always shown: sending (or answering, or editing) follows the conversation again
  // even after you scrolled up or opened a step, which otherwise pauses following.
  useEffect(() => onFollowRequest(id => { if (id === session?.id) followLatest(); }), [session?.id]);
  useEffect(() => {
    const el = scroller.current;
    if (readOnly || !session?.id || !transcript.loaded || !transcript.history?.next || transcript.history.loading || transcript.history.error || !stick.current || initialFill.current >= 8) return;
    // A page full of folded tool calls may occupy only a few lines. Fill a useful
    // reading window in the background instead of exposing tiny raw-record pages.
    if (el?.clientHeight > 0 && el.scrollHeight < el.clientHeight * 3) {
      initialFill.current++;
      void loadEarlierHistory(session.id, { background: true });
    }
  }, [blocks, transcript.history, transcript.loaded, session?.id, readOnly]);
  const onFileContextMenu = useCallback((e, path) => {
    if (!path) return;
    e.preventDefault();
    e.stopPropagation();
    setFileMenu({ path, dir: String(path).endsWith('/'), anchor: pointAnchor(e.clientX, e.clientY) });
  }, []);
  const disclosure = useMemo(() => ({ expanded, setExpanded, pauseFollowing, onOpenFile, onFileContextMenu, sessionId: session?.id }), [expanded, pauseFollowing, onOpenFile, onFileContextMenu, session?.id]);
  // Starting the agent shows as work only when something waits on it (a new conversation, a message on its
  // way, a reply in progress): reopening a conversation just shows its history while the agent starts.
  const sending = useStore(s => !!s.sending[session?.id]);
  const working = session?.streaming || (session?.compacting ?? transcript.compacting) || sending;
  // Only while there is nothing to show yet: history now comes from the session file while Pi starts, and
  // a new conversation already shows your message.
  const loading = !transcript.error && !transcript.loaded;
  return (
    <DisclosureContext.Provider value={disclosure}>
    <div className="transcript-shell">
    <div className="transcript" ref={scroller} onScroll={onScroll}
      onWheelCapture={e => {
        if (e.target.closest('.tool-output, .tool-command, .diff, .cli-permission-text[data-expanded="true"]')) { pauseFollowing(); return; }
        if (e.deltaY < 0) {
          pauseFollowing();
          if (scroller.current && scroller.current.scrollTop < scroller.current.clientHeight * 3) earlier();
        }
        scrollIntent.current = true;
      }}
      onPointerDown={e => { if (e.target === scroller.current) scrollIntent.current = true; }}
      onPointerMove={e => { if (e.buttons && e.target === scroller.current) scrollIntent.current = true; }}
      onKeyDown={e => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) scrollIntent.current = true;
      }}>
      <div className="transcript-inner">
        {transcript.error && (isAbortText(transcript.error)
          ? <div className="block-notice" title="Interrupted"><FadeText>Interrupted</FadeText></div>
          : <div className="block-error"><Icon name="alert" size={15} /> {transcript.error}</div>)}
        {transcript.history?.next && <div className="history-boundary" data-loading={!!transcript.history.loading} aria-busy={!!transcript.history.loading} />}
        {transcript.history?.warning && <div className="block-notice" title={transcript.history.warning}><FadeText>{transcript.history.warning}</FadeText></div>}
        <VirtualHistory items={blocks} scroller={scroller} onMeasure={retainPosition} renderItem={(block, active) => {
          const render = () => {
          switch (block.kind) {
            case 'orphanResult': return <ToolCall key={block.key} call={{ id: block.message.toolCallId, name: block.message.toolName ?? 'tool', arguments: { description: 'Command result' } }} tool={transcript.tools[block.message.toolCallId]} />;
            case 'pendingHistory': return <div key={block.key} className="block-notice">This part of the conversation is read when it comes into view.</div>;
            case 'image': return <ImagePreview key={block.key} src={`data:${block.image.mimeType};base64,${block.image.data}`} alt="Assistant image" />;
            case 'user': return <UserMessage key={block.key} block={block} sessionId={session?.id} editable={!block.truncated && (!transcript.history || !!block.entryId) && !readOnly && (!isCliEngine(session?.engine) || session?.engine === 'codex') && !!session && !isPendingSession(session.id) && session.status === 'connected' && !session.streaming && !block.steer && !block.text.startsWith('/')} />;
            case 'goal': return <GoalMarker key={block.key} block={block} />;
            case 'text': return <Markdown key={block.key} text={block.text} streaming={block.streaming} sessionId={session?.id} documentPath="" />;
            case 'usage': return <TurnFooter key={block.key} text={block.text} changes={readOnly ? [] : block.changes} sessionId={session?.id} last={block === lastUsage} />;
            case 'compaction': return <CompactionMarker key={block.key} {...block} blockKey={block.key} />;
            case 'thinking': return <Thinking key={block.key} {...block} blockKey={block.key} />;
            case 'work': return <WorkGroup key={block.key} items={block.items} tools={transcript.tools} live={!!transcript.live} behind={behind.has(block.key)} />;
            case 'tools': return <ToolGroup key={block.key} calls={block.calls} tools={transcript.tools} live={!!transcript.live} behind={behind.has(block.key)} />;
            case 'subagents': return renderSubagents?.(block);
            case 'ccTask': return <ClaudeTaskCard key={block.key} call={block.call} tool={transcript.tools[block.call.id]} sessionId={session?.id} />;
            case 'ccTodo': return <ClaudeTodoCard key={block.key} call={block.call} tool={transcript.tools[block.call.id]} live={working && !!block.live} agents={block.key === lastListKey ? agentsWorking : 0} />; // (a list of a turn that is over does not turn)
            case 'progress': return <ProgressReport key={block.key} call={block.call} tool={transcript.tools[block.call.id]} sessionId={session?.id} live={!!transcript.live} />;
            case 'visual': return <VisualCard key={block.key} call={block.call} tool={transcript.tools[block.call.id]} live={!!transcript.live} superseded={!!block.superseded} />;
            case 'files': return <FileCards key={block.key} sessionId={readOnly ? null : session?.id} call={block.call} tool={transcript.tools[block.call.id]} />;
            case 'agentReports': return renderAgentReport?.(block) ?? null;
            case 'ask': return transcript.tools[block.call.id]?.status === 'done' ? <AskBlock key={block.key} call={block.call} tool={transcript.tools[block.call.id]} /> : null;
            case 'bash': return <pre key={block.key} className="tool-output">$ {block.message.command}{'\n'}{block.message.output}</pre>;
            case 'error': return <ErrorBlock key={block.key} block={block} engine={session?.engine} sessionId={readOnly ? null : session?.id} />;
            case 'notice': return <div key={block.key} className="block-notice" title={block.text}><FadeText>{block.text}</FadeText></div>;
            default: return null;
          }
          };
          const automatic = ['text', 'user', 'bash', 'notice', 'pendingHistory', 'image'].includes(block.kind);
          return <HistoryContent key={block.key} historyRef={automatic ? block.historyRef : null} active={active}>{render()}</HistoryContent>;
        }} />
        {readOnly && copyText && <TurnFooter text={copyText} last />}
        {(transcript.queued ?? []).map(q => (
          <div key={q.id} className="user-row queued" aria-label="Queued message">
            <div className="user-stack">
              {q.images?.length > 0 && <div className="user-images">{q.images.map((img, i) => <img key={i} src={`data:${img.mimeType};base64,${img.data}`} alt="" />)}</div>}
              {q.text && <div className="user-bubble"><UserText text={q.text} /></div>}
            </div>
          </div>
        ))}
        {questions.map(q => {
          const Card = q.permission ? PermissionCard : QuestionCard;
          return <Card key={q.requestId} sessionId={session.id} question={q} />;
        })}
        {/* One mark at a time: while a step is under way the mark is on that step, and this line steps aside. */}
        {working && !loading && !questions.length && !stepsRunning(blocks, transcript.tools, !!transcript.live) && <WorkingRow session={session} transcript={transcript} sending={sending} />}
        <div className="transcript-end" />
      </div>
    </div>
    {!following && (questions.length
      ? <button className="transcript-follow waiting" aria-label="Jump to the question waiting for you" onClick={followLatest}><Icon name="arrowDown" size={15} /> Waiting for you</button>
      : <button className="transcript-follow" aria-label="Jump to latest" onClick={followLatest}><Icon name="arrowDown" size={15} /> Latest</button>)}
    {loading && <div className="transcript-loading" role="status" aria-label="Loading conversation"><Spinner size={26} /></div>}
    </div>
    <FileContextMenu menu={fileMenu} sessionId={readOnly ? null : session?.id} onOpen={onOpenFile} onClose={() => setFileMenu(null)} />
    </DisclosureContext.Provider>
  );
}
