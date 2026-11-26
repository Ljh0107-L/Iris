// Claude-style file preview: tabs of open files, a rendered/source preview, and the session folder's tree.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/common';
import { Icon } from './Icons.jsx';
import { FileContextMenu, MenuItem, Markdown, Popover, Spinner, pointAnchor, useResizable } from './ui.jsx';
import { ImagePreview } from './ImagePreview.jsx';
import { changeStats, hunkLines } from './diffs.js';
import { prepareCodePreview, shouldAutoRefreshPreview } from './file-preview-view.js';
import { relativeSessionPath } from './file-paths.js';
import { api, closeFile, downloadFile, notify, openFile, set as setStore, setFilePaneOpen, useStore } from './store.js';

const LANGS = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', zsh: 'bash', bash: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', json: 'json', rs: 'rust', go: 'go', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cu: 'cpp',
  java: 'java', kt: 'kotlin', swift: 'swift', rb: 'ruby', php: 'php', css: 'css', scss: 'scss', less: 'less', html: 'xml', xml: 'xml', svg: 'xml', sql: 'sql',
  lua: 'lua', r: 'r', pl: 'perl', diff: 'diff', patch: 'diff', makefile: 'makefile', mk: 'makefile', md: 'markdown', graphql: 'graphql' };
const PLAIN_TEXT = new Set(['', 'txt', 'text', 'log', 'out', 'csv', 'tsv']);
const extOf = path => { const name = path.split('/').pop().toLowerCase(); return name === 'makefile' ? 'makefile' : name.includes('.') ? name.split('.').pop() : ''; };
export const iconFor = name => {
  const ext = extOf(name);
  if (['md', 'txt', 'rst', 'pdf'].includes(ext)) return 'fileText';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return 'fileImage';
  if (LANGS[ext]) return 'fileCode';
  return 'fileAny';
};
export const sizeLabel = n => n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const joinRel = (dir, name) => dir ? `${dir}/${name}` : name;

// Folder listings per session, so expanding the tree twice doesn't refetch.
const listings = new Map();
function useListing(sessionId, rel, open, version) {
  const key = `${sessionId}\n${rel}`;
  const [state, setState] = useState(() => listings.get(key) ?? null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api('listFiles', sessionId, rel).then(r => { if (alive) { listings.set(key, r); setState(r); } }, e => { if (alive) setState({ error: e.message }); });
    return () => { alive = false; };
  }, [key, open, version]);
  return state;
}

// Saves the file to this Mac; the button spins while the file is transferred.
export function DownloadButton({ sessionId, path, className = 'tool-button', label }) {
  const [busy, setBusy] = useState(false);
  return <button className={className} disabled={busy} title="Download to this Mac" aria-label={`Download ${path.split('/').pop()}`}
    onClick={async e => { e.stopPropagation(); setBusy(true); try { await downloadFile(sessionId, path); } finally { setBusy(false); } }}>
    {busy ? <Spinner size={13} /> : <Icon name="download" size={15} />}{label}
  </button>;
}

// Version-control internals and OS clutter stay out of the tree (as in editors' default excludes).
const HIDDEN_ENTRIES = new Set(['.git', '.hg', '.svn', 'CVS', '.DS_Store', 'Thumbs.db']);
function TreeDir({ sessionId, rel, depth, active, version }) {
  const listing = useListing(sessionId, rel, true, version);
  const [expanded, setExpanded] = useState({});
  const [menu, setMenu] = useState(null); // { path, anchor } of a right-clicked file
  if (!listing) return <div className="fp-tree-row muted" style={{ paddingLeft: 12 + depth * 14 }}><Spinner size={11} /></div>;
  if (listing.error) return <div className="fp-tree-row error" style={{ paddingLeft: 12 + depth * 14 }}>{listing.error}</div>;
  const close = () => setMenu(null);
  return <>{listing.entries.filter(entry => !HIDDEN_ENTRIES.has(entry.name)).map(entry => {
    const path = joinRel(rel, entry.name);
    if (entry.dir) {
      const open = expanded[entry.name] ?? false; // folders open when asked, not to reveal the open file
      return (
        <div key={path}>
          <button className="fp-tree-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setExpanded(x => ({ ...x, [entry.name]: !open }))}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} className="fp-caret" /><span className="fp-name">{entry.name}</span>
          </button>
          {open && <TreeDir sessionId={sessionId} rel={path} depth={depth + 1} active={active} version={version} />}
        </div>
      );
    }
    return (
      <button key={path} className={`fp-tree-row file ${active === path ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 14 + 18 }} onClick={() => openFile(sessionId, path)} title={path}
        onContextMenu={e => { e.preventDefault(); setMenu({ path, anchor: { current: e.currentTarget } }); }}>
        <Icon name={iconFor(entry.name)} size={15} className="fp-file-icon" /><span className="fp-name">{entry.name}</span>
      </button>
    );
  })}
  {menu && <Popover anchor={menu.anchor} open onClose={close} width={200} placement="bottom-start">
    <MenuItem icon="fileText" label="Open" onClick={() => { close(); openFile(sessionId, menu.path); }} />
    <MenuItem icon="download" label="Download" onClick={() => { close(); downloadFile(sessionId, menu.path); }} />
    <MenuItem icon="copy" label="Copy path" onClick={() => { close(); navigator.clipboard.writeText(menu.path); notify('Path copied'); }} />
  </Popover>}</>;
}

// Cheap and stable: only to tell whether a page's text changed since it was last drawn.
const hashText = text => { let hash = 0; for (let i = 0; i < text.length; i += Math.max(1, Math.floor(text.length / 4096))) hash = (hash * 31 + text.charCodeAt(i)) | 0; return hash; };
const escapeHtml = text => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// line: the line a link in the conversation pointed at. It is brought into view and marked.
function CodeView({ view, ext, line, lineAt }) {
  const { displayedText: text, lineCount, highlight, wrapped } = view;
  const box = useRef(null);
  const [mark, setMark] = useState(null);
  useLayoutEffect(() => {
    const source = box.current?.querySelector('.fp-source');
    const height = source ? parseFloat(getComputedStyle(source).lineHeight) : 0;
    if (!line || wrapped || line > lineCount || !(height > 0)) { setMark(null); return; }
    const top = source.offsetTop + (line - 1) * height;
    setMark({ top, height });
    const scroller = box.current.closest('.fp-content');
    scroller?.scrollTo({ top: Math.max(0, box.current.offsetTop + top - scroller.clientHeight / 3) });
  }, [line, lineAt, lineCount, wrapped, text]);
  const html = useMemo(() => {
    if (!highlight) return escapeHtml(text);
    const lang = LANGS[ext];
    if (!lang && PLAIN_TEXT.has(ext)) return escapeHtml(text); // notes and logs are not code: no guessed colours
    try {
      return lang && hljs.getLanguage(lang)
        ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(text).value;
    } catch { return escapeHtml(text); }
  }, [text, ext, highlight]);
  const showGutter = !wrapped || lineCount <= 1;
  return (
    <div ref={box} className={`fp-code ${wrapped ? 'wrap' : ''}`}>
      {mark && <div className="fp-line-mark" style={{ top: mark.top, height: mark.height }} />}
      {showGutter && <pre className="fp-gutter" aria-hidden="true">{Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}</pre>}
      <pre className="fp-source"><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>
    </div>
  );
}

function PdfPreview({ dataUrl, name }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), c => c.charCodeAt(0));
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [dataUrl]);
  return url ? <iframe className="fp-pdf" src={url} title={`PDF: ${name}`} /> : <div className="fp-empty"><Spinner /></div>;
}

// A page, drawn. It runs in a frame of its own, apart from Iris, and loads what it links to (styles, scripts,
// images) from its folder on the machine the conversation runs on.
function HtmlPreview({ sessionId, path, name, version }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    api('previewUrl', sessionId, path).then(found => { if (alive) setUrl(found); }, e => { if (alive) setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); });
    return () => { alive = false; };
  }, [sessionId, path]);
  if (error) return <div className="fp-empty error"><Icon name="alert" size={15} /> {error}</div>;
  return url ? <iframe key={version} className="fp-html" src={url} title={`Page: ${name}`} sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock" />
    : <div className="fp-empty"><Spinner /></div>;
}

function DirectoryPreview({ sessionId, listing, onOpen }) {
  const [menu, setMenu] = useState(null);
  const entries = listing.entries ?? [];
  const childPath = entry => {
    const base = listing.path.endsWith('/') ? listing.path.slice(0, -1) : listing.path;
    return `${base}/${entry.name}${entry.dir ? '/' : ''}`;
  };
  return (
    <div className="fp-dir-view">
      <div className="fp-dir-head">
        <Icon name="folderOpen" size={15} />
        <span>{entries.length} {entries.length === 1 ? 'item' : 'items'}</span>
      </div>
      {!entries.length && <div className="fp-empty">Empty folder</div>}
      <div className="fp-dir-list">
        {entries.map(entry => {
          const full = childPath(entry);
          return (
            <button key={entry.name} type="button" className="fp-dir-row" onClick={() => onOpen(full)}
              onContextMenu={e => { e.preventDefault(); setMenu({ path: full, dir: entry.dir, anchor: pointAnchor(e.clientX, e.clientY) }); }}>
              <Icon name={entry.dir ? 'folder' : iconFor(entry.name)} size={15} className="fp-file-icon" />
              <span className="fp-name">{entry.name}</span>
            </button>
          );
        })}
      </div>
      <FileContextMenu menu={menu} sessionId={sessionId} onOpen={onOpen} onClose={() => setMenu(null)} />
    </div>
  );
}

const PAGE_TYPES = new Set(['html', 'htm']);
function Preview({ sessionId, path, toolsDone, manualVersion, reveal, local }) {
  const [file, setFile] = useState(null);
  const [dirListing, setDirListing] = useState(null);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [wrapOverride, setWrapOverride] = useState(null);
  const fileRef = useRef(null);
  const lastManualRef = useRef(-1);
  const lastTargetRef = useRef('');
  const scroller = useRef(null);
  fileRef.current = file;
  useEffect(() => {
    const targetKey = `${sessionId}\n${path}`;
    const targetChanged = lastTargetRef.current !== targetKey;
    const manualChanged = lastManualRef.current !== manualVersion;
    if (!targetChanged && !shouldAutoRefreshPreview(fileRef.current, manualChanged)) return;
    lastTargetRef.current = targetKey;
    lastManualRef.current = manualVersion;
    let alive = true;
    setError(null);
    const cleanError = e => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    api('readFile', sessionId, path).then(
      f => { if (alive) { setDirListing(null); setFile(f); } },
      e => {
        const msg = cleanError(e);
        if (/not a regular file/i.test(msg) || path.endsWith('/')) {
          api('listFiles', sessionId, path).then(
            listing => { if (alive) { setFile(null); setDirListing(listing); setError(null); } },
            () => { if (alive) { setFile(null); setDirListing(null); setError(msg); } },
          );
          return;
        }
        if (alive) { setFile(null); setDirListing(null); setError(msg); }
      },
    );
    return () => { alive = false; };
  }, [sessionId, path, toolsDone, manualVersion]);
  useEffect(() => { setSource(false); setExpanded(false); setWrapOverride(null); scroller.current?.scrollTo(0, 0); }, [path]);
  // A link to a line of a page shows its source, where the line is.
  useEffect(() => { if (reveal && PAGE_TYPES.has(extOf(path))) setSource(true); }, [reveal?.at, path]);
  const ext = extOf(path);
  const cleanPath = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const parts = cleanPath.split('/');
  const crumbs = parts.length > 4 ? [parts[0], '…', ...parts.slice(-3)] : parts;
  const page = PAGE_TYPES.has(ext);
  const rendered = (ext === 'md' || page) && !source;
  const isCode = file?.kind === 'text' && !rendered;
  // The page is drawn again when its file changed, and when asked to (Reload, Refresh).
  const [reloads, setReloads] = useState(0);
  const pageVersion = useMemo(() => `${reloads}:${manualVersion}:${file?.size ?? 0}:${file?.content?.length ?? 0}:${hashText(file?.content ?? '')}`, [reloads, manualVersion, file]);
  const codeView = useMemo(
    () => (isCode ? prepareCodePreview(file.content, { expanded, wrapOverride }) : null),
    [isCode, file, expanded, wrapOverride],
  );
  const refreshKey = toolsDone + manualVersion;
  return (
    <div className="fp-preview">
      <div className="fp-crumbs">
        <span className="fp-crumb-path">{crumbs.map((c, i) => <span key={i} className={i === crumbs.length - 1 ? 'last' : ''}>{c}</span>)}</span>
        {file?.kind === 'text' && page && rendered && <button className="tool-button" onClick={() => setReloads(n => n + 1)} title="Reload the page" aria-label="Reload page"><Icon name="refresh" size={15} /></button>}
        {file?.kind === 'text' && page && local && <button className="tool-button" onClick={() => api('openPath', file.path ?? path)} title="Open in your browser" aria-label="Open in browser"><Icon name="externalLink" size={15} /></button>}
        {file?.kind === 'text' && (ext === 'md' || page) && <button className={`tool-button ${!rendered ? 'on' : ''}`} onClick={() => setSource(s => !s)} title={source ? 'Show preview' : 'Show source'} aria-label="Toggle source"><Icon name="code" size={16} /></button>}
        {codeView && <button className={`tool-button ${codeView.wrapped ? 'on' : ''}`} disabled={codeView.maxLineLength > 50000 && expanded} onClick={() => setWrapOverride(!codeView.wrapped)} title={codeView.wrapped ? 'Disable line wrap' : 'Wrap lines'} aria-label="Toggle line wrap" aria-pressed={codeView.wrapped}><Icon name="wrap" size={15} /></button>}
        {file && <DownloadButton sessionId={sessionId} path={file.path ?? path} />}
      </div>
      {codeView && (codeView.previewLimited || codeView.longLines) && (
        <div className="fp-notice">
          <span className="fp-notice-text">
            {codeView.longLines
              ? `Long single-line file (${sizeLabel(file.size)})`
              : `Large file (${sizeLabel(file.size)})`}
            {codeView.previewLimited
              ? ` · showing first ${sizeLabel(new TextEncoder().encode(codeView.displayedText).length)}${codeView.wrapped ? ' wrapped' : ''}`
              : !codeView.highlight ? ' · syntax highlighting paused for speed' : ''}
          </span>
          <span className="fp-notice-actions">
            {codeView.previewLimited && (
              <button type="button" className="fp-notice-btn" onClick={() => setExpanded(true)}>
                Show {file.truncated ? `${sizeLabel(file.content.length)} preview` : 'full file'}
              </button>
            )}
            <button type="button" className="fp-notice-btn primary" onClick={() => downloadFile(sessionId, file.path ?? path)}>
              Download
            </button>
          </span>
        </div>
      )}
      <div className="fp-content" ref={scroller}>
        {error && <div className="fp-empty error"><Icon name="alert" size={15} /> {error}</div>}
        {!error && !file && !dirListing && <div className="fp-empty"><Spinner /></div>}
        {dirListing && <DirectoryPreview sessionId={sessionId} listing={dirListing} onOpen={target => openFile(sessionId, target)} />}
        {file?.kind === 'image' && (file.dataUrl ? <div className="fp-image"><ImagePreview src={file.dataUrl} alt={parts.at(-1)} /></div> : <div className="fp-empty">Image too large to preview · {sizeLabel(file.size)}</div>)}
        {file?.kind === 'pdf' && (file.dataUrl ? <PdfPreview dataUrl={file.dataUrl} name={parts.at(-1)} /> : <div className="fp-empty">PDF too large to preview · {sizeLabel(file.size)} (32 MB limit)</div>)}
        {file?.kind === 'binary' && <div className="fp-empty"><Icon name="fileAny" size={16} /> Binary file · {sizeLabel(file.size)}</div>}
        {file?.kind === 'text' && (rendered && page ? <HtmlPreview sessionId={sessionId} path={file.path ?? path} name={parts.at(-1)} version={pageVersion} />
          : rendered ? <div className="fp-markdown"><Markdown text={file.content} sessionId={sessionId} documentPath={file.path ?? path} refreshKey={refreshKey} /></div>
          : <CodeView view={codeView} ext={ext} line={reveal?.line} lineAt={reveal?.at} />)}
        {file?.truncated && file.kind === 'text' && <div className="fp-truncated">First {sizeLabel(new TextEncoder().encode(file.content).length)} of {sizeLabel(file.size)}</div>}
      </div>
    </div>
  );
}

// The change review: every file one turn changed, as diffs.
function ChangesView({ sessionId, changes, cwd }) {
  return (
    <div className="fp-preview">
      <div className="fp-content changes">
        <div className="git-review-scope">Tool edit records for this turn. For the current repository diff, <button onClick={() => setStore({ gitReviewOpen: true, filePaneOpen: false, filePaneMax: false })}>open Git review</button>.</div>
        {changes.map(change => {
          const { added, removed } = changeStats(change);
          return (
            <section key={change.path} className="change-file">
              <button className="change-head" onClick={() => openFile(sessionId, change.path)} title="Open file">
                <Icon name={iconFor(change.path)} size={15} /><span className="change-path" title={change.path}>{relativeSessionPath(cwd, change.path) ?? change.path}</span>
                <span className="plus">+{added}</span><span className="minus">−{removed}</span>
              </button>
              <div className="change-body">
                {change.hunks.map((h, i) => (
                  <div key={i} className="change-hunk">
                    {hunkLines(h).map((l, j) => l.type === 'gap'
                      ? <div key={j} className="diff-gap">⋯</div>
                      : <div key={j} className={`diff-row ${l.type}`}><span className="diff-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span><span className="diff-text">{l.text || ' '}</span></div>)}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function FilePane({ session }) {
  const state = useStore(s => s.files[session.id]) ?? { tabs: [], active: null };
  const maximized = useStore(s => s.filePaneMax);
  // Beside an open file the folder's tree shows only when asked for (the choice is kept); with no file open it
  // is what the pane shows.
  const [tree, setTreeState] = useState(() => { try { return localStorage.getItem('iris.fileTree') === 'shown'; } catch { return false; } });
  const setTree = next => setTreeState(now => { const value = typeof next === 'function' ? next(now) : next; try { localStorage.setItem('iris.fileTree', value ? 'shown' : 'hidden'); } catch { /* for this window */ } return value; });
  // The pane and its file tree are both draggable (double-click a handle to reset).
  const [paneWidth, paneHandle] = useResizable('file-pane', 760, 420, 1400, 'left');
  const [treeWidth, treeHandle] = useResizable('file-tree', 280, 180, 520, 'left');
  const [menu, setMenu] = useState(false);
  const [version, setVersion] = useState(0);
  const menuRef = useRef(null);
  // Re-read the open file and the tree whenever Pi finishes a tool call (it may have changed files).
  const toolsDone = useStore(s => Object.values(s.transcripts[session.id]?.tools ?? {}).filter(t => t.status !== 'running').length);
  const refresh = toolsDone + version;
  const local = session.environmentId === 'local';
  const absolute = path => path.startsWith('/') ? path : `${session.cwd.replace(/\/$/, '')}/${path}`;
  const target = state.active ? absolute(state.active) : session.cwd;
  return (
    <aside className={`file-pane ${state.active || state.changes ? 'has-file' : ''} ${maximized ? 'maximized' : ''}`} style={maximized ? undefined : { width: paneWidth }}>
      {!maximized && paneHandle}
      <div className="fp-bar">
        <div className="fp-tabs">
          {state.tabs.map(path => (
            <div key={path} className={`fp-tab ${path === state.active ? 'active' : ''}`} title={path}>
              <button className="fp-tab-name" onClick={() => openFile(session.id, path)}>{path.split('/').filter(Boolean).pop() || path}</button>
              <button className="fp-tab-close" onClick={() => closeFile(session.id, path)} aria-label="Close"><Icon name="x" size={13} /></button>
            </div>
          ))}
          {state.changes && <div className={`fp-tab ${!state.active ? 'active' : ''}`}>
            <button className="fp-tab-name" onClick={() => setStore(s => ({ files: { ...s.files, [session.id]: { ...state, active: null } } }))}>Changes</button>
            <button className="fp-tab-close" onClick={() => setStore(s => ({ files: { ...s.files, [session.id]: { ...state, changes: null } } }))} aria-label="Close"><Icon name="x" size={13} /></button>
          </div>}
          {!state.tabs.length && !state.changes && <span className="fp-title">Files</span>}
        </div>
        <div className="fp-actions">
          {(state.active || state.changes) && <button className={`tool-button ${tree ? 'on' : ''}`} onClick={() => setTree(t => !t)} title={tree ? 'Hide file tree' : 'Show file tree'} aria-label="Toggle file tree"><Icon name="listTree" size={16} /></button>}
          <button ref={menuRef} className="tool-button" onClick={() => setMenu(m => !m)} title="More" aria-label="More file actions"><Icon name="more" size={16} /></button>
          <Popover anchor={menuRef} open={menu} onClose={() => setMenu(false)} width={220} placement="bottom-end">
            <MenuItem icon="refresh" label="Refresh" onClick={() => { setMenu(false); setVersion(v => v + 1); }} />
            {state.active && <MenuItem icon="download" label="Download" onClick={() => { setMenu(false); downloadFile(session.id, state.active); }} />}
            <MenuItem icon="copy" label={state.active ? 'Copy file path' : 'Copy folder path'} onClick={() => { setMenu(false); navigator.clipboard.writeText(target); notify('Path copied'); }} />
            {local && <MenuItem icon="externalLink" label="Reveal in Finder" onClick={() => { setMenu(false); api(state.active ? 'showInFolder' : 'openPath', target); }} />}
            {state.tabs.length > 0 && <MenuItem icon="x" label="Close all tabs" onClick={() => { setMenu(false); state.tabs.forEach(t => closeFile(session.id, t)); }} />}
          </Popover>
          <button className="tool-button" onClick={() => setStore({ filePaneMax: !maximized })} title={maximized ? 'Restore' : 'Maximize'} aria-label="Maximize files"><Icon name={maximized ? 'minimize' : 'maximize'} size={15} /></button>
          <button className="tool-button" onClick={() => { setFilePaneOpen(false); setStore({ filePaneMax: false }); }} title="Close" aria-label="Close files"><Icon name="x" size={16} /></button>
        </div>
      </div>
      <div className="fp-body">
        {state.active
          ? <Preview key={`${session.id}\n${state.active}`} sessionId={session.id} path={state.active} toolsDone={toolsDone} manualVersion={version}
              reveal={state.reveal?.path === state.active ? state.reveal : null} local={local} />
          : state.changes ? <ChangesView sessionId={session.id} changes={state.changes} cwd={session.cwd} />
          : <div className="fp-preview fp-placeholder"><Icon name="folder" size={26} /><span>Open files appear here</span></div>}
        {(tree || !(state.active || state.changes)) && (state.active || state.changes
          ? <div className="fp-tree-wrap" style={{ width: treeWidth }}>{treeHandle}<div className="fp-tree"><TreeDir sessionId={session.id} rel="" depth={0} active={state.active} version={refresh} /></div></div>
          : <div className="fp-tree"><TreeDir sessionId={session.id} rel="" depth={0} active={state.active} version={refresh} /></div>)}
      </div>
    </aside>
  );
}
