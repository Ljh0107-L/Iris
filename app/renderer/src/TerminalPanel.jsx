// A terminal docked under the conversation, in the session's folder on the session's machine.
// Each session keeps its terminal (and scrollback) while the app runs; hiding the panel keeps it alive.
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Icon } from './Icons.jsx';
import { api, set as setStore, useStore } from './store.js';

// Shell prompts (Powerlevel10k, Starship, oh-my-posh) draw icons from Nerd Fonts: after the usual monospace
// fonts come the Nerd Font families people install, so those icons show instead of empty boxes.
const TERMINAL_FONTS = ["'SF Mono'", 'ui-monospace', 'Menlo',
  "'Symbols Nerd Font Mono'", "'Symbols Nerd Font'", "'MesloLGS NF'", "'MesloLGS Nerd Font'", "'FiraCode Nerd Font'", "'FiraCode Nerd Font Mono'",
  "'JetBrainsMono Nerd Font'", "'JetBrainsMono Nerd Font Mono'", "'Hack Nerd Font'", "'CaskaydiaCove Nerd Font'", "'SauceCodePro Nerd Font'", 'monospace'].join(', ');

const terms = new Map(); // session id -> { term, fit, el, termId, exited }
const byTermId = new Map();

window.iris.subscribe(({ channel, payload }) => {
  if (channel === 'term-data') { const entry = byTermId.get(payload.id); entry?.term.write(payload.data); entry?.onData?.(payload.data); }
  if (channel === 'term-exit') {
    const entry = byTermId.get(payload.id);
    if (entry) {
      entry.exited = true;
      if (entry.onExit) entry.onExit(payload.exitCode);
      else entry.term.write('\r\n\x1b[2m[process exited — press Enter to restart]\x1b[0m\r\n');
    }
  }
  // A conversation that was deleted or archived takes its terminal with it: the shell (on a host, an
  // ssh login shell) would otherwise run until the app quits.
  if (channel === 'sessions' && Array.isArray(payload)) {
    const open = new Set(payload.map(session => session.id));
    for (const sessionId of [...terms.keys()]) if (!open.has(sessionId)) closeTerminal(sessionId);
  }
});

async function start(sessionId, entry) {
  entry.exited = false;
  const termId = await api('termOpen', sessionId, entry.term.cols, entry.term.rows);
  // Its conversation was deleted while the shell was starting.
  if (terms.get(sessionId) !== entry) { api('termClose', termId).catch(() => {}); return; }
  entry.termId = termId;
  byTermId.set(entry.termId, entry);
}

// The terminal follows the app's appearance. A light terminal needs colours of its own: the sixteen that
// read on a dark screen (yellow, white, bright green) wash out on a light one.
const TERMINAL_THEMES = {
  dark: { background: '#0d0d0f', foreground: '#f2f2f4', cursor: '#f2f2f4', selectionBackground: 'rgba(142,162,255,.32)', black: '#1f1f23', brightBlack: '#8a8a92' },
  light: { background: '#f6f6f8', foreground: '#16161a', cursor: '#16161a', cursorAccent: '#f6f6f8', selectionBackground: 'rgba(59,91,219,.22)',
    black: '#16161a', red: '#b3362b', green: '#2f7a3d', yellow: '#8a6100', blue: '#2f5fd0', magenta: '#8b3fb5', cyan: '#0f7f8c', white: '#62626b',
    brightBlack: '#70707a', brightRed: '#c9433a', brightGreen: '#3b8f4b', brightYellow: '#9a6f00', brightBlue: '#3b5bdb', brightMagenta: '#9d4fc7', brightCyan: '#1a8f9c', brightWhite: '#111114' },
};
const terminalTheme = () => TERMINAL_THEMES[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'];
const openTerminals = new Set();
new MutationObserver(() => { for (const term of openTerminals) term.options.theme = terminalTheme(); })
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
function makeTerminal() {
  const term = new Terminal({
    fontFamily: TERMINAL_FONTS, fontSize: 12.5, lineHeight: 1.25, cursorBlink: true, allowProposedApi: true,
    theme: terminalTheme(),
  });
  openTerminals.add(term);
  const dispose = term.dispose.bind(term);
  term.dispose = () => { openTerminals.delete(term); dispose(); };
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}

function terminalFor(sessionId) {
  let entry = terms.get(sessionId);
  if (entry) return entry;
  const { term, fit } = makeTerminal();
  const el = document.createElement('div');
  el.className = 'terminal-host';
  entry = { term, fit, el, termId: null, exited: false, opened: false };
  terms.set(sessionId, entry);
  term.onData(data => {
    if (entry.exited) { if (data === '\r') { term.reset(); start(sessionId, entry); } return; }
    if (entry.termId) api('termWrite', entry.termId, data);
  });
  term.onResize(({ cols, rows }) => { if (entry.termId) api('termResize', entry.termId, cols, rows); });
  return entry;
}

export function closeTerminal(sessionId) {
  const entry = terms.get(sessionId);
  if (!entry) return;
  if (entry.termId) { byTermId.delete(entry.termId); api('termClose', entry.termId).catch(() => {}); }
  entry.el.remove();
  entry.term.dispose();
  terms.delete(sessionId);
}

// Short-lived CLI process inside Settings. Keep Google device codes and quota
// output in the terminal only, not in the session transcript or notifications.
// onLink(url): the first web page the command prints (a sign-in prints the page to open). A terminal wraps a long
// address over several lines, where it cannot be clicked, so the page is offered as buttons beside the terminal.
export function CliTerminal({ environmentId, action, engine = 'antigravity', account = null, onExit, onLink }) {
  const host = useRef(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let disposed = false, id;
    const { term, fit } = makeTerminal();
    term.open(host.current);
    const refit = () => { try { fit.fit(); } catch { /* hidden */ } };
    refit();
    term.focus();
    term.onData(data => { if (id) api('termWrite', id, data).catch(() => {}); });
    term.onResize(({ cols, rows }) => { if (id) api('termResize', id, cols, rows).catch(() => {}); });
    const observer = new ResizeObserver(refit);
    observer.observe(host.current);
    api('termOpenCli', environmentId, action, term.cols, term.rows, engine, account).then(termId => {
      if (disposed) { api('termClose', termId).catch(() => {}); return; }
      id = termId;
      let printed = '', linked = false;
      byTermId.set(id, { term, onExit: code => {
        term.write(`\r\n\x1b[2m[${engine === 'codex' ? 'Codex' : 'Antigravity'} exited${code ? ` with code ${code}` : ''}]\x1b[0m\r\n`);
        onExit?.(code);
      }, onData: data => {
        if (linked || !onLink) return;
        printed = (printed + data).slice(-8000);
        // Complete once something follows it (the address is printed in one piece, then a new line).
        const found = /(https:\/\/[^\s\x1b"'<>]+)[\s\x1b]/.exec(printed.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''));
        if (found) { linked = true; onLink(found[1]); }
      } });
      return api('termReady', id);
    }).catch(err => { if (!disposed) setError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); });
    return () => {
      disposed = true;
      observer.disconnect();
      if (id) { byTermId.delete(id); api('termClose', id).catch(() => {}); }
      term.dispose();
    };
  }, [environmentId, action, engine, account, onExit, onLink]);
  return <>{error && <p className="cli-settings-error" role="alert">{error}</p>}<div className="cli-settings-terminal" ref={host} /></>;
}

export function TerminalPanel({ session }) {
  const host = useRef(null);
  const height = useStore(s => s.terminalHeight ?? 280);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const entry = terminalFor(session.id);
    host.current.appendChild(entry.el);
    if (!entry.opened) { entry.term.open(entry.el); entry.opened = true; }
    const refit = () => { try { entry.fit.fit(); } catch { /* hidden */ } };
    refit();
    if (!entry.termId) start(session.id, entry);
    entry.term.focus();
    const observer = new ResizeObserver(refit);
    observer.observe(host.current);
    return () => { observer.disconnect(); entry.el.remove(); };
  }, [session.id]);
  const onDrag = e => {
    e.preventDefault();
    setDragging(true);
    const startY = e.clientY, startH = height;
    const move = ev => setStore({ terminalHeight: Math.max(120, Math.min(window.innerHeight - 220, startH + startY - ev.clientY)) });
    const up = () => { setDragging(false); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <div className={`terminal-panel ${dragging ? 'dragging' : ''}`} style={{ height }}>
      <div className="terminal-grip" onMouseDown={onDrag} />
      <div className="terminal-bar">
        <Icon name="terminalPanel" size={14} /><span>{session.environmentLabel}</span>
        <span className="spacer" />
        <button className="tool-button" aria-label="Close terminal" title="Close terminal" onClick={() => setStore({ terminalOpen: false })}><Icon name="x" size={14} /></button>
      </div>
      <div className="terminal-body" ref={host} />
    </div>
  );
}
