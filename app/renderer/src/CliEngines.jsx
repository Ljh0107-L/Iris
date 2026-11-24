import { useCallback, useEffect, useRef, useState } from 'react';
import { EngineLogo, Icon } from './Icons.jsx';
import { MenuItem, MenuSection, Spinner, Trigger, envIcon } from './ui.jsx';
import { CliTerminal } from './TerminalPanel.jsx';
import { api, askConfirm, cliDraftMenus, loadCliAccounts, loadCliOptions, notify, openSettings, refreshCliReadiness, reportCliAccount, setCliAccounts, setDraft, setSettings, useStore } from './store.js';
import { CLI_ENGINES, engineLabel, hasAccounts, readinessKey } from './engines.js';
import './cli-engines.css';

const cleanError = error => error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const showError = error => notify(cleanError(error), 'error');
export const openSubscriptions = environmentId => openSettings(true, 'subscriptions', { environmentId });

export function CliSetup({ environmentId, engine = 'antigravity' }) {
  const status = useStore(s => s.cliReadiness[readinessKey(engine, environmentId)]);
  const machine = useStore(s => s.environments.find(env => env.id === environmentId)?.label) ?? 'the selected machine';
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    const check = () => void refreshCliReadiness(environmentId, engine);
    const timer = setTimeout(check, 250);
    window.addEventListener('focus', check);
    return () => { clearTimeout(timer); window.removeEventListener('focus', check); };
  }, [environmentId, engine]);
  if (status === 'ready') return null; // the model picker says it is signed in
  if (status === 'unreachable') return <button type="button" className="trigger attention" disabled={retrying}
    title={`Can’t reach ${machine}. Try connecting again.`} onClick={async () => {
      setRetrying(true);
      try { await refreshCliReadiness(environmentId, engine); } finally { setRetrying(false); }
    }}>
    {retrying ? <Spinner size={13} /> : <Icon name="unplug" size={14} />}
    <span>{retrying ? 'Connecting…' : 'Can’t connect · Retry'}</span>
  </button>;
  const label = status === 'missing' ? 'Install CLI' : status === 'signedOut' ? 'Sign in' : 'Account';
  return <button type="button" className={`trigger ${status === 'missing' || status === 'signedOut' ? 'attention' : ''}`}
    onClick={() => openSubscriptions(environmentId)} title={`${label} on ${machine}`}>
    <Icon name="key" size={14} /><span>{label}</span>
  </button>;
}

// Which of the CLI's accounts a new conversation uses (Codex), once there is more than one.
export function DraftCliAccount({ engine }) {
  const known = useStore(s => s.cliAccounts[engine]);
  const chosen = useStore(s => s.draft.cliAccount) ?? known?.selected ?? 'default';
  useEffect(() => { void loadCliAccounts(engine); }, [engine]);
  const accounts = known?.accounts ?? [];
  if (!hasAccounts(engine) || accounts.length < 2) return null;
  const current = accounts.find(a => a.id === chosen) ?? accounts[0];
  return <Trigger label="Account" title={`${engineLabel(engine)} account for this conversation`} width={260} placement="top-start"
    menu={close => <>
      <MenuSection title={`${engineLabel(engine)} account`}>
        {accounts.map(a => <MenuItem key={a.id} icon="key" label={a.name} checked={a.id === current.id} onClick={() => { close(); setDraft({ cliAccount: a.id }); }} />)}
      </MenuSection>
      <div className="menu-foot"><MenuItem icon="settings" label="Manage accounts…" onClick={() => { close(); openSubscriptions(); }} /></div>
    </>}>
    <Icon name="key" size={13} /><span>{current.name}</span><Icon name="chevronDown" size={11} />
  </Trigger>;
}

// Model and effort for a conversation that has not started: the menus this CLI offered last time on this
// machine, with the last choices selected. They are applied when the conversation opens.
export function DraftCliOptions({ environmentId, engine }) {
  const options = useStore(s => s.cliDraftOptions[`${engine}:${environmentId}`]) ?? [];
  const chosen = useStore(s => s.draft.cliChoices) ?? {};
  const ready = useStore(s => s.cliReadiness[readinessKey(engine, environmentId)] === 'ready');
  useEffect(() => { void loadCliOptions(environmentId, engine); }, [environmentId, engine]);
  // Signed in, but the CLI has not said what it offers on this machine yet: it starts on its own default.
  if (!options.length) return ready ? <span className="trigger static" title={`${engineLabel(engine)} lists its models once a conversation has started on this machine`}><span className="strong">Default model</span></span> : null;
  return <>
    {cliDraftMenus(options, chosen).map(option => {
      const value = option.options.some(choice => choice.value === chosen[option.id]) ? chosen[option.id] : option.currentValue;
      return <Trigger key={option.id} label={option.name} title={option.name} width={280} placement="top-start"
        menu={close => <MenuSection title={option.name}>
          {option.options.map(choice => <MenuItem key={choice.value} label={choice.name} title={choice.description} checked={choice.value === value}
            onClick={() => { close(); setDraft({ cliChoices: { ...(option.category === 'model' ? {} : chosen), [option.id]: choice.value } }); }} />)}
        </MenuSection>}>
        {option.category === 'speed' && <Icon name="bolt" size={13} />}<span className={option.category === 'model' ? 'strong' : undefined}>{option.options.find(choice => choice.value === value)?.name ?? option.name}</span><Icon name="chevronDown" size={11} />
      </Trigger>;
    })}
  </>;
}

export function CliLogin({ session }) {
  if (session.status !== 'connected' || !session.cli?.authRequired) return null;
  return <div className="conn-banner">
    <Icon name="key" size={14} />
    <span className="conn-text">Sign in to send a message.</span>
    <button type="button" className="button small" onClick={() => openSubscriptions(session.environmentId)}>Sign in</button>
  </div>;
}

export function SessionCliOptions({ session }) {
  const [changing, setChanging] = useState(false);
  const state = session.cli;
  const options = state?.authRequired ? [] : state?.options ?? [];
  const change = async (configId, value) => {
    setChanging(true);
    try { await api('cliSetConfig', session.id, configId, value); }
    catch (error) { showError(error); }
    finally { setChanging(false); }
  };
  return <>
    {options.map(option => <Trigger key={option.id} label={option.name} title={option.name} width={280} placement="top-start"
      disabled={changing || session.streaming || session.status !== 'connected'}
      menu={close => <MenuSection title={option.name}>
        {option.options.map(choice => <MenuItem key={choice.value} label={choice.name} title={choice.description} checked={choice.value === option.currentValue}
          onClick={() => { close(); if (choice.value !== option.currentValue) void change(option.id, choice.value); }} />)}
      </MenuSection>}>
      {option.category === 'speed' && <Icon name="bolt" size={13} />}<span className={option.category === 'model' ? 'strong' : undefined}>{option.options.find(choice => choice.value === option.currentValue)?.name ?? option.name}</span><Icon name="chevronDown" size={11} />
    </Trigger>)}
    <SessionAccount session={session} />
  </>;
}

// The account an existing conversation belongs to (it never changes), when it is not the default one.
function SessionAccount({ session }) {
  const accounts = useStore(s => s.cliAccounts[session.engine]?.accounts);
  useEffect(() => { if (session.cliAccount) void loadCliAccounts(session.engine); }, [session.engine, session.cliAccount]);
  if (!session.cliAccount) return null;
  const name = accounts?.find(a => a.id === session.cliAccount)?.name ?? 'Removed account';
  return <span className="trigger cli-session-account" title={`${engineLabel(session.engine)} account: ${name}`}><Icon name="key" size={13} /><span>{name}</span></span>;
}

const installLabels = { preparing: 'Preparing…', downloading: 'Downloading…', uploading: 'Uploading…', installing: 'Installing…' };

function InstallProgress({ progress }) {
  const label = installLabels[progress?.stage] ?? installLabels.preparing;
  const percent = progress?.percent ?? undefined;
  return <div className="cli-install">
    <div role="status"><span>{label}</span>{percent !== undefined && <span>{percent}%</span>}</div>
    <progress aria-label={label} max={100} value={percent} />
  </div>;
}

// "pro" → "Pro", "promax" → "Pro Max": plan ids as the provider names them, made readable.
const planName = plan => plan ? `${String(plan).replace(/^(pro|plus|team|free|business|enterprise|edu)(?=.)/i, '$1 ').replace(/\b\w/g, c => c.toUpperCase())} plan` : null;

const SUBSCRIPTION = { codex: 'ChatGPT plan', antigravity: 'Google account' };
// How much of one limit is used, as a bar: "5-hour limit · 42% used · resets 3:00 PM".
function LimitBar({ limit }) {
  const span = limit.windowMinutes >= 10080 ? 'Weekly' : limit.windowMinutes >= 1440 ? 'Daily' : limit.windowMinutes ? `${Math.round(limit.windowMinutes / 60)}-hour` : 'Usage';
  const used = Math.max(0, Math.min(100, Math.round(limit.usedPercent)));
  const at = limit.resetsAt ? new Date(limit.resetsAt) : null;
  const resets = at && !Number.isNaN(at.getTime()) ? ` · resets ${at.getTime() - Date.now() < 86400000 ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : '';
  return <div className="sub-limit">
    <span className="sub-limit-name">{span} limit</span>
    <span className={`sub-limit-bar ${used >= 90 ? 'high' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-label={`${span} limit used`}><span style={{ width: `${used}%` }} /></span>
    <span className="sub-limit-text">{used}% used{resets}</span>
  </div>;
}

// One account of a CLI on the chosen machine. fresh: it was just added, so its sign-in starts at once and,
// if that is given up, the account is dropped again (onAbandon).
function AccountRow({ environmentId, engine, profile = null, fresh = false, onRemove, onAbandon, onSignedIn }) {
  const antigravity = engine === 'antigravity';
  const local = environmentId === 'local';
  const accountId = profile?.id ?? null; // an extra Codex account; null is the CLI's own sign-in
  const progress = useStore(s => s.antigravityInstalls[`${environmentId}:${engine}`] ?? (antigravity ? s.antigravityInstalls[environmentId] : null));
  const signInUrl = useStore(s => s.cliSignIns[`${engine}:${environmentId}:${accountId ?? 'default'}`]);
  const [account, setAccount] = useState(null);
  const [checking, setChecking] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState(null);
  const [terminal, setTerminal] = useState(null);
  const [copied, setCopied] = useState(false);
  const installing = requesting || !!installLabels[progress?.stage];
  const check = useCallback(async () => {
    setChecking(true); setError(null);
    try {
      const info = await api('cliInfo', environmentId, engine);
      if (!info) throw new Error('Could not check this machine.');
      setAccount(previous => info.installed && previous?.installed ? previous : info);
      const result = info.installed ? await api('cliAccountStatus', environmentId, false, engine, accountId) : info;
      setAccount(result);
      if (!accountId) reportCliAccount(environmentId, result, engine);
      if (result.signedIn) setTerminal(open => open === 'login' ? null : open);
      return result;
    } catch (err) { setError(cleanError(err)); return null; }
    finally { setChecking(false); }
  }, [environmentId, engine, accountId]);
  const install = async () => {
    setRequesting(true);
    try { await api('antigravityInstall', environmentId, engine); }
    catch { /* the progress event carries the error, including across navigation */ }
    finally { setRequesting(false); }
  };
  // The card's callbacks are new functions on every render: read through a ref, they do not restart the check below.
  const handlers = useRef({});
  handlers.current = { onAbandon, onSignedIn };
  // On this Mac the CLI signs in through the browser and Iris waits for it; on a host, in a terminal there.
  const signIn = useCallback(async () => {
    if (!local) { setTerminal('login'); return; }
    setSigningIn(true); setError(null);
    try {
      const result = await api('cliSignIn', environmentId, engine, accountId);
      setAccount(result);
      if (!accountId) reportCliAccount(environmentId, result, engine);
      if (!result.signedIn) throw new Error('Sign-in did not complete.');
      handlers.current.onSignedIn?.();
    } catch (err) {
      const message = cleanError(err);
      if (fresh) handlers.current.onAbandon?.(); else if (!/cancelled/i.test(message)) setError(message);
    } finally { setSigningIn(false); }
  }, [local, environmentId, engine, accountId, fresh]);
  const started = useRef(false);
  useEffect(() => {
    if (installing) return;
    if (fresh && !started.current) { started.current = true; setChecking(false); setAccount({ installed: true, signedIn: false }); void signIn(); return; }
    if (!fresh) void check();
  }, [check, installing, fresh, signIn]);
  const signOut = async () => {
    setChecking(true); setError(null);
    try { const result = await api('cliAccountStatus', environmentId, 'logout', engine, accountId); setAccount(result); if (!accountId) reportCliAccount(environmentId, result, engine); }
    catch (err) { setError(cleanError(err)); }
    finally { setChecking(false); }
  };
  const terminalExited = useCallback(code => { if (!code) void check(); }, [check]);
  const signedIn = account?.signedIn === true;
  const message = progress?.stage === 'error' ? progress.message : error;
  // What is true on that machine right now, in two or three words.
  const state = installing ? 'Installing' : signingIn ? 'Signing in' : !account ? (checking ? 'Checking' : 'Could not check')
    : account.installed === false ? 'Not installed'
    : signedIn ? null : account.signedIn === false ? 'Not signed in'
    : checking ? 'Checking' : 'Could not check';
  const busy = state === 'Checking' || state === 'Installing' || state === 'Signing in';
  // Signed in, the row is the account: who, and on which plan.
  const who = signedIn ? (account.identity || profile?.name || 'Signed in') : profile?.name;
  const plan = signedIn ? planName(account.plan) : null;
  const limits = signedIn ? account.limits ?? [] : [];
  const brand = antigravity ? 'Google' : 'ChatGPT';
  return <div className="sub-account">
    <div className="sub-account-row">
      {signedIn ? <span className="sub-state ok"><span className="sub-dot" /><span className="sub-who" title={who}>{who}</span></span>
        : <span className={`sub-state ${busy ? 'busy' : ''}`}>{busy ? <Spinner size={11} /> : <span className="sub-dot" />}{who ? `${who} · ${state}` : state}</span>}
      {plan && <span className="sub-plan">{plan}</span>}
      {!installing && !signingIn && <div className="sub-actions">
        {account?.installed ? <>
          {signedIn && <button type="button" className="tool-button" aria-label="Refresh" title="Refresh" disabled={checking} onClick={check}>{checking ? <Spinner size={13} /> : <Icon name="refresh" size={14} />}</button>}
          {signedIn ? (profile ? <button type="button" className="button small" title="Sign out and remove this account from Iris" onClick={onRemove}>Remove</button>
              : !antigravity && <button type="button" className="button small" disabled={checking} onClick={signOut}>Sign out</button>)
            : <>
              <button type="button" className="button small primary" disabled={terminal === 'login' || (local && checking)} onClick={signIn}>Sign in with {brand}</button>
              {profile && <button type="button" className="button small ghost" onClick={onRemove}>Remove</button>}
            </>}
        </> : account?.installed === false ? (antigravity ? <button type="button" className="button small primary" onClick={install}>Install</button>
          : <button type="button" className="button small primary" disabled={terminal === 'install'} title="Runs npm install -g @openai/codex in a terminal here" onClick={() => setTerminal('install')}>Install</button>)
          : !checking && <button type="button" className="button small" onClick={check}>Retry</button>}
      </div>}
    </div>
    {signingIn && <div className="sub-flow" role="status">
      <span className="sub-flow-text">{signInUrl ? 'Your browser has opened. Finish signing in there, then come back.' : `Opening ${brand} sign-in in your browser…`}</span>
      <div className="sub-actions">
        {signInUrl && <>
          <button type="button" className="button small" onClick={() => api('openExternal', signInUrl)}>Open again</button>
          <button type="button" className="button small" onClick={async () => { try { await navigator.clipboard.writeText(signInUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the page is open already */ } }}>{copied ? 'Copied' : 'Copy link'}</button>
        </>}
        {!antigravity && <button type="button" className="button small ghost" onClick={() => api('cliSignInCancel', environmentId, engine, accountId)}>Cancel</button>}
      </div>
    </div>}
    {installing && <InstallProgress progress={progress} />}
    {limits.length > 0 && <div className="sub-limits">{limits.map((limit, index) => <LimitBar key={index} limit={limit} />)}</div>}
    {message && !installing && <p className="cli-settings-error" role="alert">{message}</p>}
    {terminal && <div className="cli-terminal-card">
      <div className="cli-terminal-head">
        <span>{terminal === 'login' ? `Sign in with ${brand}` : <>Installing with <code>npm install -g @openai/codex</code></>}</span>
        <button type="button" className="button small ghost" aria-label="Close terminal" title="Close terminal" onClick={() => setTerminal(null)}><Icon name="x" size={14} /></button>
      </div>
      <CliTerminal key={terminal} environmentId={environmentId} action={terminal} engine={engine} account={accountId} onExit={terminalExited} />
    </div>}
  </div>;
}

// One subscription on the chosen machine, as a list of accounts. Codex can have several: "Add account" signs
// another one in straight away, and every conversation keeps the account it was started with.
function SubscriptionCard({ environmentId, engine, children }) {
  const accounts = useStore(s => s.cliAccounts[engine]?.accounts) ?? [];
  const signedIn = useStore(s => s.cliReadiness[readinessKey(engine, environmentId)] === 'ready');
  const [fresh, setFresh] = useState(null); // the account being added, until its sign-in ends either way
  useEffect(() => { void loadCliAccounts(engine); }, [engine]);
  const extra = accounts.filter(a => a.id !== 'default');
  const add = async () => {
    try {
      const list = await api('addCliAccount', engine, '');
      setFresh(list.at(-1)?.id ?? null);
      setCliAccounts(engine, list);
    } catch (error) { showError(error); }
  };
  const forget = id => api('removeCliAccount', engine, id).then(list => setCliAccounts(engine, list), showError).finally(() => setFresh(current => current === id ? null : current));
  const remove = account => askConfirm({ title: 'Remove this account?', action: 'Remove',
    message: `Iris signs it out of ${engineLabel(engine)} on this Mac and forgets it. Conversations started with it must be deleted first.`,
    run: () => forget(account.id) });
  return <section className="sub-card" aria-label={engineLabel(engine)}>
    <header className="sub-card-head">
      <EngineLogo engine={engine} size={28} />
      <h3 className="sub-card-title">{engineLabel(engine)}</h3>
      <span className="sub-card-plan">{SUBSCRIPTION[engine]}</span>
      {hasAccounts(engine) && environmentId === 'local' && signedIn && !fresh && extra.length < 8 && <button type="button" className="button small sub-add" title={`Sign in to another ${SUBSCRIPTION[engine].replace(/ .*/, '')} account, for example work and personal`} onClick={add}><Icon name="plus" size={13} />Add account</button>}
    </header>
    <AccountRow environmentId={environmentId} engine={engine} />
    {hasAccounts(engine) && extra.map(account => <AccountRow key={account.id} environmentId={environmentId} engine={engine} profile={account}
      fresh={fresh === account.id} onAbandon={() => forget(account.id)} onSignedIn={() => setFresh(null)} onRemove={() => remove(account)} />)}
    {children}
  </section>;
}

// Which machine's sign-ins the page shows: each CLI is installed and signed in per machine.
export function SubscriptionSettings() {
  const initialEnv = useStore(s => s.settingsEnvironmentId ?? s.draft.environmentId);
  const environments = useStore(s => s.environments.filter(e => e.kind === 'local' || (e.added && e.enabled)));
  const [selected, select] = useState(initialEnv);
  const environmentId = environments.some(e => e.id === selected) ? selected : 'local';
  const current = environments.find(e => e.id === environmentId);
  const bypass = useStore(s => s.settings?.defaults?.antigravityBypassPermissions !== false);
  const [saving, setSaving] = useState(false);
  const toggle = async () => {
    setSaving(true);
    try { setSettings(await api('updateDefaults', { antigravityBypassPermissions: !bypass })); }
    catch (err) { showError(err); }
    finally { setSaving(false); }
  };
  return <section className="cli-settings" aria-label="Subscriptions">
    {environments.length > 1 && <div className="sub-machine">
      <span>Machine</span>
      <Trigger className="cli-machine" label="Machine" width={240} placement="bottom-end"
        menu={close => <MenuSection>{environments.map(env => <MenuItem key={env.id} icon={envIcon(env)} label={env.label} checked={env.id === environmentId} onClick={() => { select(env.id); close(); }} />)}</MenuSection>}>
        <Icon name={envIcon(current)} size={14} /><span>{current?.label ?? 'This computer'}</span><Icon name="chevronDown" size={12} />
      </Trigger>
    </div>}
    {['codex', 'antigravity'].filter(engine => CLI_ENGINES[engine]).map(engine => <SubscriptionCard key={`${engine}:${environmentId}`} environmentId={environmentId} engine={engine}>
      {engine === 'antigravity' && <label className="sub-option">
        <span>Ask before running commands and editing files</span>
        <button type="button" role="switch" aria-checked={!bypass} aria-label="Antigravity: ask before running tools" className={`switch ${!bypass ? 'on' : ''}`} disabled={saving} onClick={toggle}><span /></button>
      </label>}
    </SubscriptionCard>)}
  </section>;
}
