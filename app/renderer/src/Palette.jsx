import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EngineLogo, Icon } from './Icons.jsx';
import { baseName } from './ui.jsx';
import { engineLabel } from './engines.js';
import { api, defaultFolder, newSession, openPalette, openSession, openSettings, pickRecent, set, setDraft, useStore } from './store.js';

// "…we added the <mark>weather</mark> lookup…": the match in a message, highlighted.
function Highlighted({ text, query }) {
  const at = text.toLowerCase().indexOf(query);
  if (!query || at < 0) return text;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>;
}

const TABS = ['All', 'Conversations', 'Projects', 'Environments'];

export function Palette() {
  const sessions = useStore(s => s.sessions);
  const environments = useStore(s => s.environments);
  const recentFolders = useStore(s => s.settings?.recentFolders ?? {});
  const [query, setQuery] = useState('');
  const initialTab = useStore(s => s.paletteTab);
  const [tab, setTab] = useState(() => Math.max(0, TABS.indexOf(initialTab)));
  const [index, setIndex] = useState(0);
  const input = useRef(null);
  const list = useRef(null);
  const q = query.trim().toLowerCase();
  const match = text => !q || text.toLowerCase().includes(q);
  // What was said in conversations, on this Mac and on connected hosts (searched a moment after typing stops).
  const [said, setSaid] = useState({ q: '', hits: [], note: '' });
  const searchesMessages = q.length >= 2 && (TABS[tab] === 'All' || TABS[tab] === 'Conversations');
  useEffect(() => {
    if (!searchesMessages) { setSaid({ q, hits: [], note: '' }); return; }
    let alive = true;
    const timer = setTimeout(() => api('searchMessages', q).then(found => {
      if (!alive) return;
      // Say what was left out, so that "no results" is not read as "never said".
      const left = found?.unsearched ?? 0;
      const note = left ? `${left} conversation${left === 1 ? '' : 's'} on hosts that are not connected ${left === 1 ? 'was' : 'were'} not searched.`
        : found?.partial ? 'Older conversations were not searched: this took too long.' : '';
      setSaid({ q, hits: Array.isArray(found?.hits) ? found.hits : [], note });
    }, () => {}), 160);
    return () => { alive = false; clearTimeout(timer); };
  }, [q, searchesMessages]);
  const envLabel = id => environments.find(e => e.id === id)?.label ?? (id === 'local' ? 'This computer' : id.replace(/^ssh:/, ''));

  const sections = useMemo(() => {
    const out = [];
    const kind = TABS[tab];
    if (kind === 'All' || kind === 'Conversations') {
      const engineOf = s => s.engine ?? 'iris';
      const items = sessions.filter(s => match(`${s.title} ${s.project} ${s.environmentLabel} ${engineLabel(engineOf(s))} ${s.engine === 'claude-code' ? 'cc' : ''}`)).slice(0, kind === 'All' ? 6 : 50)
        .map(s => ({ key: s.id, logo: engineOf(s), label: s.title,
          detail: `${s.project} · ${s.environmentLabel}${engineOf(s) === 'iris' ? '' : ` · ${engineLabel(engineOf(s))}`}`, run: () => openSession(s.id) }));
      if (items.length) out.push({ title: q ? 'Conversations' : 'Recents', items });
      // Conversations whose messages mention it (not already listed by title): opened with Find filled in.
      const listed = new Set(items.map(item => item.key));
      const messageHits = said.q === q ? said.hits.filter(hit => !listed.has(hit.id) && sessions.some(s => s.id === hit.id)).slice(0, kind === 'All' ? 6 : 30) : [];
      if (messageHits.length) out.push({ title: 'Messages', items: messageHits.map(hit => {
        const s = sessions.find(x => x.id === hit.id);
        return { key: `said:${hit.id}`, logo: s.engine ?? 'iris', label: s.title, snippet: hit.snippet, detail: hit.snippet,
          run: () => { openSession(hit.id); set({ findRequest: { id: hit.id, query: query.trim() } }); } };
      }) });
    }
    if (kind === 'All' || kind === 'Projects') {
      const items = Object.entries(recentFolders).flatMap(([envId, folders]) => folders.map(folder => ({ envId, folder })))
        .filter(({ envId, folder }) => match(`${folder} ${envLabel(envId)}`)).slice(0, kind === 'All' ? 4 : 50)
        .map(({ envId, folder }) => ({ key: envId + folder, icon: 'folder', label: baseName(folder), detail: `${envLabel(envId)} · ${folder}`, hint: 'New conversation', run: () => { newSession(); pickRecent(envId, folder); } }));
      if (items.length) out.push({ title: 'Projects', items });
    }
    if (kind === 'Environments' || (kind === 'All' && q)) {
      const items = environments.filter(e => match(`${e.label} ${e.detail ?? ''}`)).slice(0, kind === 'All' ? 4 : 100)
        .map(e => ({ key: e.id, icon: e.kind === 'ssh' ? 'terminal' : 'laptop', label: e.label, detail: e.kind === 'ssh' ? e.detail : 'Local', hint: 'New conversation', run: () => { newSession(); pickRecent(e.id, defaultFolder({ recentFolders }, e.id)); } }));
      if (items.length) out.push({ title: 'Environments', items });
    }
    if (kind === 'All') {
      const actions = [
        { key: 'new', icon: 'plus', label: 'New conversation', run: () => { newSession(); setDraft({ engine: 'iris' }); } },
        ...['claude-code', 'codex', 'antigravity', 'cursor'].map(engine => ({ key: `new-${engine}`, logo: engine, label: `New ${engineLabel(engine)} conversation`, run: () => { newSession(); setDraft({ engine }); } })),
        { key: 'models', icon: 'key', label: 'Models & API keys', run: () => openSettings(true, 'providers') },
        { key: 'accounts', icon: 'key', label: 'Subscriptions: Codex and Antigravity sign-in', run: () => openSettings(true, 'subscriptions') },
        { key: 'envs', icon: 'server', label: 'SSH connections', run: () => openSettings(true, 'connections') },
        { key: 'usage', icon: 'gauge', label: 'Usage', run: () => openSettings(true, 'usage') },
      ].filter(a => match(a.label));
      if (actions.length) out.push({ title: 'Actions', items: actions });
    }
    return out;
  }, [sessions, environments, recentFolders, q, tab, said]);
  const flat = sections.flatMap(s => s.items);

  useEffect(() => { setIndex(0); }, [q, tab]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { list.current?.querySelector('.palette-item.selected')?.scrollIntoView({ block: 'nearest' }); }, [index]);
  const close = () => openPalette(false);
  const run = item => { close(); item?.run(); };
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(flat[index]); }
    else if (e.key === 'Tab' || (e.key === 'ArrowRight' && e.metaKey)) { e.preventDefault(); setTab(t => (t + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length); }
  };
  let n = -1;
  return createPortal(
    <div className="palette-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="palette" role="dialog" aria-label="Search" onKeyDown={onKey}>
        <div className="palette-search">
          <input ref={input} placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} />
          <button className="icon-button" onClick={close} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>
        <div className="palette-tabs">{TABS.map((t, i) => <button key={t} className={i === tab ? 'on' : ''} onClick={() => { setTab(i); input.current?.focus(); }}>{t}</button>)}</div>
        <div className="palette-list" ref={list}>
          {sections.map(section => (
            <div key={section.title} className="palette-section">
              <div className="palette-section-title">{section.title}</div>
              {section.items.map(item => {
                n += 1; const i = n;
                return (
                  <button key={item.key} className={`palette-item ${i === index ? 'selected' : ''}`} title={item.detail || undefined} onMouseMove={() => setIndex(i)} onClick={() => run(item)}>
                    {item.logo ? <EngineLogo engine={item.logo} size={18} /> : <Icon name={item.icon} size={18} />}
                    {item.snippet
                      ? <span className="palette-text"><span className="palette-label">{item.label}</span><span className="palette-snippet"><Highlighted text={item.snippet} query={q} /></span></span>
                      : <span className="palette-label">{item.label}</span>}
                    {i === index && <Icon name="enter" size={17} className="palette-enter" />}
                  </button>
                );
              })}
            </div>
          ))}
          {!flat.length && <div className="palette-empty">{searchesMessages && said.q !== q ? 'Searching…' : `No results for “${query}”`}</div>}
          {searchesMessages && said.q === q && said.note && <div className="palette-note" role="status">{said.note}</div>}
        </div>
        <div className="palette-foot">
          <span>Close <kbd>Esc</kbd></span>
          <span>Change type <kbd>Tab</kbd></span>
          <span>Navigate <kbd>↑</kbd><kbd>↓</kbd></span>
          <span className="palette-foot-right">Open <kbd>↵</kbd></span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
