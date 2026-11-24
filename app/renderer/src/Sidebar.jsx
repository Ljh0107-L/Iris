import { memo, useMemo, useRef, useState } from 'react';
import { engineCli, engineLabel, isCliEngine } from './engines.js';
import { Icon, EngineLogo } from './Icons.jsx';
import { MenuItem, Popover, Spinner, useResizable } from './ui.jsx';
import { groupSessions } from './session-groups.js';
import { setAppearance } from './store.js';
import { api, archiveSession, askConfirm, cancelWarm, deleteSession, forkSession, goBack, goForward, newSession, notify, openPalette, openSession, openSettings, toggleSidebar, useStore, warmSession } from './store.js';

export function SessionMenuItems({ session, close, onRename }) {
  const active = useStore(s => s.activeId === session.id);
  const failed = e => notify(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
  const forkUnavailable = isCliEngine(session.engine) ? `Forking is not available in ${engineCli(session.engine)}` : null;
  return <>
    <MenuItem icon="edit" label="Rename" onClick={() => { close(); onRename(); }} />
    <MenuItem icon="fork" label="Fork" disabled={!!forkUnavailable} title={forkUnavailable ?? undefined} onClick={() => { close(); forkSession(session.id).catch(failed); }} />
    <MenuItem icon="archive" label="Archive" onClick={() => { close(); archiveSession(session.id); }} />
    <MenuItem icon="trash" label="Delete" className="danger" onClick={() => { close(); askConfirm({ title: 'Delete conversation?', message: session.title, action: 'Delete', run: () => deleteSession(session.id).catch(failed) }); }} />
  </>;
}

// A menu opened at the pointer (right-click).
const pointAnchor = (x, y) => ({ current: { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0 }), contains: () => false } });

// A row is drawn again only when its own conversation changes: a status change in one conversation arrives
// as a new list, and there can be hundreds of rows.
const SessionRow = memo(function SessionRow({ session, active }) {
  const anchor = useRef(null);
  const [menu, setMenu] = useState(false);
  const [pointMenu, setPointMenu] = useState(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session.title);
  const rename = () => { setTitle(session.title); setEditing(true); };
  const asking = useStore(s => s.questions[session.id]?.length ?? 0);
  const agentName = engineLabel(session.engine);
  const indicator = asking ? <span className="row-dot attention" title={`${agentName} is waiting for your answer`} />
    : session.status === 'reconnecting' ? <span className="row-dot reconnecting" title="Reconnecting…" />
    : session.streaming ? <Spinner size={11} />
    : session.status === 'error' || session.status === 'disconnected' ? <span className="row-dot error" title={session.statusMessage ?? 'Disconnected'} /> : null;
  return (
    <div className={`session-row ${active ? 'active' : ''} ${menu || pointMenu ? 'menu-open' : ''}`} onContextMenu={e => { e.preventDefault(); setMenu(false); setPointMenu(pointAnchor(e.clientX, e.clientY)); }}>
      {editing
        ? <input className="rename-input" autoFocus value={title} onChange={e => setTitle(e.target.value)}
            onBlur={() => { setEditing(false); if (title.trim() && title !== session.title) api('rename', session.id, title.trim()); }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setTitle(session.title); setEditing(false); } }} />
        : <button className="session-row-main" onClick={() => openSession(session.id)} onMouseEnter={() => warmSession(session.id)} onMouseLeave={cancelWarm} onDoubleClick={() => { setTitle(session.title); setEditing(true); }} title={session.title}>
            {/* Which agent the conversation runs on, before its title: all four are told apart at a glance. */}
            <span className="session-engine" aria-hidden="true" title={engineLabel(session.engine)}><EngineLogo engine={session.engine ?? 'pi'} size={15} className="session-engine-logo" title={engineLabel(session.engine)} /></span>
            <span className="session-title">{session.title}</span>
            {indicator && <span className="session-indicator">{indicator}</span>}
          </button>}
      <button ref={anchor} className="row-more" onClick={() => setMenu(m => !m)} aria-label="Conversation actions"><Icon name="more" size={16} /></button>
      <Popover anchor={anchor} open={menu} onClose={() => setMenu(false)} width={200} placement="bottom-end">
        <SessionMenuItems session={session} close={() => setMenu(false)} onRename={rename} />
      </Popover>
      {pointMenu && <Popover anchor={pointMenu} open onClose={() => setPointMenu(null)} width={200} placement="bottom-start">
        <SessionMenuItems session={session} close={() => setPointMenu(null)} onRename={rename} />
      </Popover>}
    </div>
  );
});

function Group({ group, activeId, view }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="session-group">
      <button className="group-head" onClick={() => setOpen(o => !o)} aria-expanded={open} title={group.noFolder ? 'Conversations without a project folder' : group.cwd}>
        <span className="group-name">{group.project}</span>
        {group.remote && <span className="group-env" title={group.env}>{group.env}</span>}
        <Icon name={open ? 'caretDown' : 'caretRight'} size={12} className="group-caret" />
      </button>
      {open && <div className="group-items">{group.items.map(s => <SessionRow key={s.id} session={s} active={view === 'session' && activeId === s.id} />)}</div>}
    </section>
  );
}

export const Sidebar = memo(function Sidebar({ peek = false }) {
  // The project-first layout replaces the experimental flat-list preference.
  const [grouped, setGrouped] = useState(() => { try { return localStorage.getItem('iris.sidebar.view') !== 'recents'; } catch { return true; } });
  const changeView = projects => {
    setGrouped(projects);
    try { localStorage.setItem('iris.sidebar.view', projects ? 'projects' : 'recents'); } catch {}
  };
  const appearance = useStore(s => s.appearance);
  const update = useStore(s => s.update);
  const sessionUpdate = useStore(s => s.sessionUpdate);
  const updateError = error => notify(error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
  const sessions = useStore(s => s.sessions);
  const activeId = useStore(s => s.activeId);
  const view = useStore(s => s.view);
  const canBack = useStore(s => s.history.length > 0);
  const canForward = useStore(s => s.future.length > 0);
  const groups = useMemo(() => groupSessions(sessions), [sessions]);
  const [sidebarWidth, sidebarHandle] = useResizable('sidebar', 288, 260, 400, 'right');
  return (
    <aside className={`sidebar ${peek ? 'peek' : ''}`} style={{ width: sidebarWidth }}>
      {sidebarHandle}
      <div className="sidebar-top drag">
        <div className="window-tools">
          <button className="tool-button" onClick={toggleSidebar} aria-label="Hide sidebar" title="Hide sidebar (⌘\)"><Icon name="sidebarToggle" size={18} /></button>
          <button className="tool-button" onClick={goBack} disabled={!canBack} aria-label="Back" title="Back"><Icon name="back" size={24} stroke={1.4} /></button>
          <button className="tool-button" onClick={goForward} disabled={!canForward} aria-label="Forward" title="Forward"><Icon name="forward" size={24} stroke={1.4} /></button>
        </div>
        <div className="sidebar-view-toggle" role="group" aria-label="Conversation organization">
          <button className="sidebar-view-btn" aria-label="Show recent conversations" title="Recent conversations" aria-pressed={!grouped} onClick={() => changeView(false)}><Icon name="clock" size={17} stroke={1.9} /></button>
          <button className="sidebar-view-btn" aria-label="Group conversations by project" title="Group by project" aria-pressed={grouped} onClick={() => changeView(true)}><Icon name="folder" size={17} stroke={1.9} /></button>
        </div>
      </div>
      <nav className="sidebar-nav">
        <button className={`nav-item new ${view === 'new' ? 'active' : ''}`} onClick={newSession} aria-label="New" title="New conversation (⌘N)">
          <span className="nav-icon"><Icon name="plus" size={22} stroke={1.45} /></span><span>New</span><span className="nav-shortcut">⌘N</span>
        </button>
        <button className="nav-item" onClick={() => openPalette(true)} aria-label="Search" title="Search (⌘K)">
          <span className="nav-icon"><Icon name="search" size={18} stroke={1.75} /></span><span>Search</span><span className="nav-shortcut">⌘K</span>
        </button>
        <button className="nav-item" onClick={() => openPalette(true, 'Projects')} aria-label="Projects" title="Browse projects">
          <span className="nav-icon"><Icon name="listTree" size={20} stroke={1.6} /></span><span>Projects</span>
        </button>
      </nav>
      <div className="sidebar-sessions">
        {grouped ? groups.map(group => <Group key={group.key} group={group} activeId={activeId} view={view} />) : sessions.map(session => <SessionRow key={session.id} session={session} active={view === 'session' && activeId === session.id} />)}
      </div>
      {/* Updates, in their own row above Settings: checking (when asked), downloading, ready, restarting. Once an
          update is in, the row is gone: there is nothing to confirm. */}
      <div className="sidebar-update">
        {update?.state === 'checking' && update.manual && <span className="update-button downloading" role="status"><Spinner size={12} /> Checking for updates…</span>}
        {update?.state === 'downloading' && <div className="update-button downloading" role="progressbar" aria-valuenow={Math.round((update.progress ?? 0) * 100)} title={`Downloading Iris ${update.version}`}>
          <span className="update-fill" style={{ '--progress': Math.max(0.04, Math.min(1, update.progress ?? 0)) }} />
          <span className="update-label">Downloading update… {Math.round((update.progress ?? 0) * 100)}%</span>
        </div>}
        {update?.state === 'ready' && sessionUpdate?.state !== 'restarting' && <button className="update-button" onClick={() => api('installUpdate').catch(updateError)} title={`Iris ${update.version} is ready. Running conversations are restarted afterwards.`}><Icon name="download" size={13} /> Restart to update</button>}
        {(update?.state === 'installing' || sessionUpdate?.state === 'restarting') && <span className="update-button downloading" role="status" title="Restarting running conversations"><Spinner size={12} /> Restarting…</span>}
      </div>
      <div className="sidebar-foot">
        <button className="nav-item settings-button" onClick={() => openSettings(true)} aria-label="Settings" title="Settings (⌘,)"><span className="nav-icon"><Icon name="settings" size={20} stroke={1.6} /></span><span>Settings</span></button>
        <button className="tool-button appearance-toggle" onClick={() => setAppearance(appearance === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${appearance === 'dark' ? 'light' : 'dark'} theme`} title={`${appearance === 'dark' ? 'Light' : 'Dark'} appearance`}><Icon name={appearance === 'dark' ? 'sun' : 'moon'} size={15} /></button>
      </div>
    </aside>
  );
});
