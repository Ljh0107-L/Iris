// Which agent a new conversation runs on, chosen beside its folder and machine: Pi, Claude Code, Codex,
// Antigravity or Cursor. The model and the modes under the message box are then that agent's own.
import { useEffect } from 'react';
import { EngineLogo, Icon } from './Icons.jsx';
import { MenuItem, Spinner, Trigger } from './ui.jsx';
import { isCliEngine, readinessKey } from './engines.js';
import { modelsForEnvironment } from './model-catalog.js';
import { loadCliOptions, openSettings, refreshCliReadiness, setDraft, useStore } from './store.js';

// In the order of the menu: the three that sign in with a plan, then the two that take API keys.
export const HARNESSES = [
  { id: 'codex', title: 'Codex', detail: 'Your ChatGPT plan' },
  { id: 'antigravity', title: 'Antigravity', detail: 'Your Google account' },
  { id: 'cursor', title: 'Cursor', detail: 'Your Cursor plan' },
  { id: 'claude-code', title: 'Claude Code', detail: 'Anthropic models · API key' },
  { id: 'pi', title: 'Pi', detail: 'Any model · API key' },
];
const CLI_STATUS = { ready: 'Signed in', signedOut: 'Not signed in', missing: 'Not installed', unreachable: 'Machine unreachable' };

function HarnessMenu({ environmentId, close }) {
  const engine = useStore(s => s.draft.engine);
  const catalog = useStore(s => s.catalog);
  const readiness = useStore(s => s.cliReadiness);
  // Opening the menu checks what each CLI can do on this machine right now.
  useEffect(() => {
    for (const { id } of HARNESSES) if (isCliEngine(id)) { void refreshCliReadiness(environmentId, id); void loadCliOptions(environmentId, id); }
  }, [environmentId]);
  const status = id => {
    if (isCliEngine(id)) {
      const state = readiness[readinessKey(id, environmentId)];
      return CLI_STATUS[state] ? <span className={`harness-status ${state === 'ready' ? 'ok' : ''}`}>{CLI_STATUS[state]}</span> : <span className="harness-status"><Spinner size={10} />Checking</span>;
    }
    const count = modelsForEnvironment(catalog, environmentId, id).length;
    return <span className="harness-status">{count ? `${count} model${count === 1 ? '' : 's'}` : 'No models yet'}</span>;
  };
  return <div className="harness-menu">
    {HARNESSES.map(({ id, title, detail }) => (
      <button key={id} type="button" className="menu-item harness-row" role="menuitemradio" aria-checked={engine === id} onClick={() => { setDraft({ engine: id }); close(); }}>
        <EngineLogo engine={id} size={20} className="harness-logo" />
        <span className="harness-text"><span className="harness-title">{title}</span><span className="harness-detail">{detail}</span></span>
        {status(id)}
        <Icon name="check" size={16} className="menu-check" style={{ visibility: engine === id ? 'visible' : 'hidden' }} />
      </button>
    ))}
    <div className="menu-foot"><MenuItem icon="settings" label="Subscriptions and API keys…" onClick={() => { close(); openSettings(true, isCliEngine(engine) ? 'subscriptions' : 'providers', { environmentId }); }} /></div>
  </div>;
}

export function HarnessPicker({ environmentId }) {
  const engine = useStore(s => s.draft.engine) ?? 'pi';
  const current = HARNESSES.find(h => h.id === engine) ?? HARNESSES.at(-1);
  return <Trigger width={340} placement="top-start" label="Agent" title={`${current.title} · ${current.detail}`} className="harness-trigger"
    menu={close => <HarnessMenu environmentId={environmentId} close={close} />}>
    <EngineLogo engine={current.id} size={14} /><span>{current.title}</span><Icon name="chevronDown" size={11} className="tray-caret" />
  </Trigger>;
}
