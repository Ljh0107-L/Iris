// What a new conversation runs on, chosen in one place: a model, grouped by where it comes from. The engine
// follows from the choice — a ChatGPT plan runs in Codex, a Google account in Antigravity, an Anthropic
// API key in Claude Code (or Pi), any other API key in Pi — so there is no separate engine menu to learn.
import { useEffect, useMemo, useState } from 'react';
import { EngineLogo, Icon } from './Icons.jsx';
import { MenuItem, Spinner, Trigger } from './ui.jsx';
import { readinessKey } from './engines.js';
import { modelsForEnvironment } from './model-catalog.js';
import { cliDraftMenus, loadCliOptions, openSettings, refreshCliReadiness, setDraft, useStore } from './store.js';

export const SOURCES = {
  codex: { title: 'Codex', detail: 'Your ChatGPT plan' },
  antigravity: { title: 'Antigravity', detail: 'Your Google account' },
  'claude-code': { title: 'Claude Code', detail: 'Anthropic’s agent · API key' },
  pi: { title: 'Pi', detail: 'Any model · API key' },
};
const CLI_SOURCES = ['codex', 'antigravity'];
const SHORT_LIST = 4;

// The CLI's own model menu for this machine (known once it has been checked or used here).
const cliModels = (options, chosen) => cliDraftMenus(options ?? [], chosen).find(o => o.category === 'model');

// Signed in, needs a sign-in, not installed: said in the group's heading, with the one action that helps.
function CliStatus({ engine, environmentId, status, close }) {
  const open = () => { close(); openSettings(true, 'antigravity', { environmentId }); };
  if (status === 'ready') return <span className="source-status ok"><span className="source-dot" />Signed in</span>;
  if (status === 'signedOut') return <button type="button" className="source-action" onClick={open}>Sign in</button>;
  if (status === 'missing') return <button type="button" className="source-action" onClick={open}>Install</button>;
  if (status === 'unreachable') return <span className="source-status">Machine unreachable</span>;
  return <span className="source-status"><Spinner size={10} />Checking</span>;
}

function SourceHead({ engine, children }) {
  return <div className="source-head">
    <EngineLogo engine={engine} size={16} className="source-icon" />
    <span className="source-title">{SOURCES[engine].title}</span>
    <span className="source-detail">{SOURCES[engine].detail}</span>
    {children}
  </div>;
}

function SourceMenu({ environmentId, close }) {
  const draft = useStore(s => s.draft);
  const catalog = useStore(s => s.catalog);
  const catalogError = useStore(s => s.catalogError);
  const providers = useStore(s => s.settings?.providers ?? []);
  const builtin = useStore(s => s.settings?.builtinProviders ?? {});
  const readiness = useStore(s => Object.fromEntries(CLI_SOURCES.map(engine => [engine, s.cliReadiness[readinessKey(engine, environmentId)]])));
  const cliOptions = useStore(s => Object.fromEntries(CLI_SOURCES.map(engine => [engine, s.cliDraftOptions[`${engine}:${environmentId}`]])));
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState({}); // a subscription's full model list, after "Show N more"
  const q = query.trim().toLowerCase();
  const hit = (...words) => !q || words.join(' ').toLowerCase().includes(q);
  // Opening the menu checks what each CLI can do on this machine right now.
  useEffect(() => {
    for (const engine of CLI_SOURCES) { void refreshCliReadiness(environmentId, engine); void loadCliOptions(environmentId, engine); }
  }, [environmentId]);
  const providerName = id => providers.find(p => p.id === id)?.name ?? builtin[id] ?? id;
  const claudeModels = useMemo(() => modelsForEnvironment(catalog, environmentId, 'claude-code'), [catalog, environmentId]);
  const piGroups = useMemo(() => {
    const groups = new Map();
    for (const m of modelsForEnvironment(catalog, environmentId, 'pi')) {
      if (!groups.has(m.provider)) groups.set(m.provider, []);
      groups.get(m.provider).push(m);
    }
    return [...groups.entries()];
  }, [catalog, environmentId]);
  const isModel = (engine, m) => draft.engine === engine && draft.model?.provider === m.provider && draft.model?.id === m.id;
  const pick = patch => { setDraft(patch); close(); };
  const apiModel = (engine, m, detail) => hit(m.name, m.id, m.provider, providerName(m.provider), SOURCES[engine].title) &&
    <MenuItem key={`${engine}:${m.provider}/${m.id}`} label={m.name} title={`${providerName(m.provider)} · ${m.provider}/${m.id}`} checked={isModel(engine, m)}
      trailing={detail ? <span className="source-model-detail">{detail}</span> : null}
      onClick={() => pick({ engine, model: { provider: m.provider, id: m.id } })} />;
  const sections = [];
  for (const engine of CLI_SOURCES) {
    const menu = cliModels(cliOptions[engine], draft.engine === engine ? draft.cliChoices : undefined);
    const current = draft.engine === engine ? (draft.cliChoices?.[menu?.id] ?? menu?.currentValue) : null;
    // A long list (Codex offers a dozen) shows its first few, and the chosen one, until asked for all.
    const matching = (menu?.options ?? []).filter(choice => hit(choice.name, choice.value, SOURCES[engine].title));
    const shown = q || expanded[engine] || matching.length <= SHORT_LIST ? matching
      : matching.filter((choice, index) => index < SHORT_LIST || (draft.engine === engine && choice.value === current));
    const items = menu?.options?.length
      ? [...shown.map(choice => <MenuItem key={choice.value} label={choice.name} title={choice.description}
          checked={draft.engine === engine && choice.value === current} onClick={() => pick({ engine, cliChoices: { [menu.id]: choice.value } })} />),
        ...(shown.length < matching.length ? [<button key="more" type="button" className="menu-item source-more" onClick={() => setExpanded(open => ({ ...open, [engine]: true }))}>Show {matching.length - shown.length} more</button>] : [])]
      : hit(SOURCES[engine].title, SOURCES[engine].detail) ? [<MenuItem key="default" label={`${SOURCES[engine].title}’s default model`} checked={draft.engine === engine} onClick={() => pick({ engine })} />] : [];
    if (items.length) sections.push(<div key={engine} className="source-section"><SourceHead engine={engine}><CliStatus engine={engine} environmentId={environmentId} status={readiness[engine]} close={close} /></SourceHead>{items}</div>);
  }
  const claudeItems = claudeModels.map(m => apiModel('claude-code', m, providerName(m.provider))).filter(Boolean);
  if (claudeItems.length) sections.push(<div key="claude-code" className="source-section"><SourceHead engine="claude-code" />{claudeItems}</div>);
  const piItems = piGroups.flatMap(([provider, models]) => {
    const rows = models.map(m => apiModel('pi', m)).filter(Boolean);
    return rows.length ? [<div key={`p:${provider}`} className="source-provider">{providerName(provider)}</div>, ...rows] : [];
  });
  sections.push(<div key="pi" className="source-section">
    <SourceHead engine="pi">{!providers.length && <button type="button" className="source-action" onClick={() => { close(); openSettings(true, 'providers'); }}>Add API key</button>}</SourceHead>
    {catalogError && <div className="menu-empty error">{catalogError}</div>}
    {piItems.length ? piItems : providers.length && !q ? <div className="menu-empty">No models for this machine yet.</div> : null}
  </div>);
  return <div className="model-menu source-menu">
    <input className="menu-search" autoFocus placeholder="Search models…" value={query} onChange={e => setQuery(e.target.value)} />
    <div className="menu-scroll">{sections}</div>
    <div className="menu-foot"><MenuItem icon="settings" label="Models & accounts…" onClick={() => { close(); openSettings(true, 'providers'); }} /></div>
  </div>;
}

// The model button under the composer of a new conversation.
export function NewModelPicker({ environmentId, label, loading = false, attention = false }) {
  const engine = useStore(s => s.draft.engine);
  return <Trigger width={360} placement="top-start" label="Model" title={`${label} · ${SOURCES[engine]?.title ?? 'Pi'}`} className={`model-trigger source-trigger ${attention ? 'attention' : ''}`}
    menu={close => <SourceMenu environmentId={environmentId} close={close} />}>
    {loading ? <Spinner size={11.5} /> : <EngineLogo engine={engine} size={15} className="source-trigger-icon" />}
    <span className="strong">{label}</span><Icon name="chevronDown" size={11} />
  </Trigger>;
}

// The name the button shows for a CLI engine: its chosen model, else the CLI's own name.
export function cliModelLabel(options, chosen, engine) {
  const menu = cliModels(options, chosen);
  const value = chosen?.[menu?.id] ?? menu?.currentValue;
  return menu?.options?.find(choice => choice.value === value)?.name ?? SOURCES[engine]?.title ?? engine;
}

// Nothing to run a conversation with yet: the ways to get a model, with what this Mac already has.
const START = [
  { engine: 'codex', title: 'Use your ChatGPT plan', detail: 'Codex CLI, signed in with ChatGPT' },
  { engine: 'antigravity', title: 'Use your Google account', detail: 'Antigravity CLI, signed in with Google' },
];
export function GetStarted() {
  const readiness = useStore(s => Object.fromEntries(CLI_SOURCES.map(engine => [engine, s.cliReadiness[readinessKey(engine, 'local')]])));
  useEffect(() => { for (const engine of CLI_SOURCES) void refreshCliReadiness('local', engine); }, []);
  const accounts = () => openSettings(true, 'antigravity', { environmentId: 'local' });
  return <section className="get-started" aria-label="Connect a model">
    <div className="get-started-title">Connect a model to start</div>
    {START.map(({ engine, title, detail }) => {
      const status = readiness[engine];
      return <div key={engine} className="get-started-row">
        <EngineLogo engine={engine} size={24} className="get-started-icon" />
        <span className="get-started-text"><span>{title}</span><span className="get-started-detail">{status === 'ready' ? `${detail} · ready on this Mac` : status === 'signedOut' ? `${detail} · installed, not signed in` : status === 'missing' ? `${detail} · not installed` : detail}</span></span>
        {status === 'ready' ? <button type="button" className="button primary small" onClick={() => setDraft({ engine })}>Use {SOURCES[engine].title}</button>
          : status === 'signedOut' ? <button type="button" className="button small" onClick={accounts}>Sign in</button>
          : status === 'missing' ? <button type="button" className="button small" onClick={accounts}>Install</button>
          : <Spinner size={13} />}
      </div>;
    })}
    <div className="get-started-row">
      <EngineLogo engine="pi" size={24} className="get-started-icon" />
      <span className="get-started-text"><span>Use an API key</span><span className="get-started-detail">OpenAI, Anthropic, Google, DeepSeek, OpenRouter or your own endpoint</span></span>
      <button type="button" className="button small" onClick={() => openSettings(true, 'providers')}>Add API key</button>
    </div>
  </section>;
}
