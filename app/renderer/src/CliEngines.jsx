import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icons.jsx';
import { MenuItem, MenuSection, Spinner, Trigger, envIcon } from './ui.jsx';
import { CliTerminal } from './TerminalPanel.jsx';
import { api, askConfirm, cliDraftMenus, loadCliAccounts, loadCliOptions, notify, openSettings, refreshCliReadiness, reportCliAccount, setCliAccounts, setDraft, setSettings, useStore } from './store.js';
import { CLI_ENGINES, engineCli, engineLabel, hasAccounts, readinessKey } from './engines.js';
import './cli-engines.css';

const cleanError = error => error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const showError = error => notify(cleanError(error), 'error');
export const openSubscriptions = environmentId => openSettings(true, 'antigravity', { environmentId }); // the Accounts page

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
export function DraftCliOptions({ environmentId, engine, skipModel = false }) {
  const options = useStore(s => s.cliDraftOptions[`${engine}:${environmentId}`]) ?? [];
  const chosen = useStore(s => s.draft.cliChoices) ?? {};
  useEffect(() => { void loadCliOptions(environmentId, engine); }, [environmentId, engine]);
  return <>
    {cliDraftMenus(options, chosen).filter(option => !(skipModel && option.category === 'model')).map(option => {
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

function CopyUsageCommand() {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="button small" onClick={async () => {
    try { await navigator.clipboard.writeText('/usage'); setCopied(true); }
    catch { notify('Could not copy. Type /usage in the terminal instead.', 'error'); }
  }}><Icon name={copied ? 'check' : 'copy'} size={13} />{copied ? 'Copied' : 'Copy /usage'}</button>;
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
const limitText = limit => {
  const span = limit.windowMinutes >= 10080 ? 'weekly' : limit.windowMinutes >= 1440 ? 'daily' : limit.windowMinutes ? `${Math.round(limit.windowMinutes / 60)}-hour` : '';
  const resets = limit.resetsAt ? `, resets ${new Date(limit.resetsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : '';
  return `${limit.usedPercent}% of ${span ? `${span} ` : ''}limit used${resets}`;
};

function AccountRow({ environmentId, engine, profile = null, onRemove }) {
  const antigravity = engine === 'antigravity';
  const accountId = profile?.id ?? null; // an extra Codex account; null is the CLI's own sign-in
  const progress = useStore(s => antigravity ? s.antigravityInstalls[environmentId] : null);
  const [account, setAccount] = useState(null);
  const [checking, setChecking] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [browserFailed, setBrowserFailed] = useState(false);
  const [error, setError] = useState(null);
  const [terminal, setTerminal] = useState(null);
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
    } catch (err) { setError(cleanError(err)); }
    finally { setChecking(false); }
  }, [environmentId, engine, accountId]);
  useEffect(() => { if (!installing) void check(); }, [check, installing]);
  const install = async () => {
    setRequesting(true);
    try { await api('antigravityInstall', environmentId, engine); }
    catch { /* the progress event carries the error, including across navigation */ }
    finally { setRequesting(false); }
  };
  const signIn = async () => {
    if (!account?.canSignIn || browserFailed) { setTerminal('login'); return; }
    setSigningIn(true); setError(null);
    try {
      const result = await api('cliAccountStatus', environmentId, true, engine, accountId);
      setAccount(result);
      if (!accountId) reportCliAccount(environmentId, result, engine);
      if (!result.signedIn) throw new Error('Sign-in did not complete. Try again in Terminal.');
    } catch (err) { setBrowserFailed(true); setError(cleanError(err)); }
    finally { setSigningIn(false); }
  };
  const signOut = async () => {
    setChecking(true); setError(null);
    try { const result = await api('cliAccountStatus', environmentId, 'logout', engine, accountId); setAccount(result); if (!accountId) reportCliAccount(environmentId, result, engine); }
    catch (err) { setError(cleanError(err)); }
    finally { setChecking(false); }
  };
  const terminalExited = useCallback(code => { if (!code && terminal !== 'usage') void check(); }, [check, terminal]);
  const signedIn = account?.signedIn === true;
  const message = progress?.stage === 'error' ? progress.message : error;
  const machine = useStore(s => s.environments.find(env => env.id === environmentId)?.label) ?? 'this computer';
  // What is true on that machine right now, in words: the buttons alone don't say.
  const status = installing ? `Installing on ${machine}`
    : !account ? (checking ? `Checking ${machine}…` : `Could not check ${machine}`)
    : account.installed === false ? `Not installed on ${machine}`
    : signedIn ? [account.identity ? `Signed in as ${account.identity}` : antigravity ? 'Installed · signed in with Google' : 'Installed · signed in', planName(account.plan), ...(account.limits ?? []).map(limitText)].filter(Boolean).join(' · ')
    // Codex signs in here on its own, so what Iris does never shows up in the user's Codex app.
    : account.signedIn === false ? (engine === 'codex' ? 'Installed · not signed in here · Iris keeps its own Codex sign-in and history, apart from your Codex app' : 'Installed · not signed in')
    : checking ? 'Installed · checking sign-in…' : 'Installed · sign-in could not be checked';
  return <>
    <div className="cli-setting-row">
      <span className="cli-setting-text"><span>{profile ? `${engineLabel(engine)} · ${profile.name}` : engineCli(engine)}</span><span className="cli-setting-desc">{status}</span></span>
      {!installing && <div className="cli-setting-actions">
        {signingIn ? <span role="status">Finish in your browser…</span> : account?.installed ? <>
          {signedIn ? <>{!antigravity && <button type="button" className="button" disabled={checking} onClick={signOut}>Sign out</button>}<span className="cli-account-state"><Icon name="check" size={14} /> Signed in</span></>
            : <button type="button" className="button primary" disabled={terminal === 'login' || (environmentId === 'local' && checking)} onClick={signIn}>{browserFailed ? 'Sign in using Terminal' : 'Sign in'}</button>}
          {antigravity && (signedIn || (!checking && account.signedIn == null)) && <button type="button" className="button" title="View quota in Terminal" disabled={terminal === 'usage'} onClick={() => setTerminal('usage')}>View quota</button>}
        </> : checking ? <span className="cli-account-state" role="status"><Spinner size={14} /> Checking…</span>
          : account?.installed === false ? (antigravity ? <button type="button" className="button primary" onClick={install}>Install CLI</button>
            : <button type="button" className="button primary" disabled={terminal === 'install'} title="Runs npm install -g @openai/codex in a terminal here" onClick={() => setTerminal('install')}>Install with npm</button>)
            : <button type="button" className="button" onClick={check}>Retry</button>}
        {profile && <button type="button" className="button ghost" title="Remove this account from Iris" onClick={onRemove}>Remove</button>}
      </div>}
      {installing && <InstallProgress progress={progress} />}
    </div>
    {message && !installing && <p className="cli-settings-error" role="alert">{message}</p>}
    {terminal && <div className="cli-terminal-card">
      <div className="cli-terminal-head">
        <span>{terminal === 'login' ? (antigravity ? 'Google sign-in' : 'Sign in to Codex') : terminal === 'install' ? <>Installing with <code>npm install -g @openai/codex</code></> : <>Run <code>/usage</code></>}</span>
        <div className="cli-setting-actions">
          {terminal === 'usage' && <CopyUsageCommand />}
          <button type="button" className="button small ghost" aria-label="Close terminal" title="Close terminal" onClick={() => setTerminal(null)}><Icon name="x" size={14} /></button>
        </div>
      </div>
      <CliTerminal key={terminal} environmentId={environmentId} action={terminal} engine={engine} account={accountId} onExit={terminalExited} />
    </div>}
  </>;
}

// One CLI on the chosen machine: its own sign-in, and for Codex any accounts added beside it.
function EngineAccounts({ environmentId, engine }) {
  const accounts = useStore(s => s.cliAccounts[engine]?.accounts) ?? [];
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  useEffect(() => { void loadCliAccounts(engine); }, [engine]);
  const add = async event => {
    event.preventDefault();
    try { setCliAccounts(engine, await api('addCliAccount', engine, name)); setName(''); setAdding(false); }
    catch (error) { showError(error); }
  };
  const remove = account => askConfirm({ title: `Remove ${account.name}?`, action: 'Remove',
    message: `Iris signs this ${engineLabel(engine)} account out on this Mac and forgets it. Conversations must be deleted first.`,
    run: () => api('removeCliAccount', engine, account.id).then(list => setCliAccounts(engine, list), showError) });
  return <>
    <AccountRow environmentId={environmentId} engine={engine} />
    {hasAccounts(engine) && accounts.filter(a => a.id !== 'default').map(account => <AccountRow key={account.id} environmentId={environmentId} engine={engine} profile={account} onRemove={() => remove(account)} />)}
    {hasAccounts(engine) && <div className="cli-setting-row cli-add-account">
      <span className="cli-setting-text"><span className="cli-setting-desc">Another {engineLabel(engine)} account (for example work and personal) gets its own sign-in; each conversation uses the one it was started with.</span></span>
      {adding
        ? <form className="cli-setting-actions" onSubmit={add}><input className="cli-account-name" autoFocus value={name} maxLength={40} placeholder="Account name" aria-label="Account name" onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setAdding(false); } }} />
            <button type="submit" className="button primary" disabled={!name.trim()}>Add</button><button type="button" className="button ghost" onClick={() => setAdding(false)}>Cancel</button></form>
        : <button type="button" className="button" onClick={() => setAdding(true)}>Add account</button>}
    </div>}
  </>;
}

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
  return <section className="cli-settings" aria-label="Account settings">
    <div className="cli-setting-row">
      <span className="cli-setting-text"><span>Machine</span><span className="cli-setting-desc">Each CLI is installed and signed in separately on each machine. Iris never sees the credentials.</span></span>
      <Trigger className="cli-machine" label="Machine" width={240} placement="bottom-end"
        menu={close => <MenuSection>{environments.map(env => <MenuItem key={env.id} icon={envIcon(env)} label={env.label} checked={env.id === environmentId} onClick={() => { select(env.id); close(); }} />)}</MenuSection>}>
        <Icon name={envIcon(current)} size={14} /><span>{current?.label ?? 'This computer'}</span><Icon name="chevronDown" size={12} />
      </Trigger>
    </div>
    {Object.keys(CLI_ENGINES).map(engine => <EngineAccounts key={`${engine}:${environmentId}`} environmentId={environmentId} engine={engine} />)}
    <div className="cli-setting-row">
      <span className="cli-setting-text"><span>Antigravity: ask before running tools</span><span className="cli-setting-desc">{bypass ? 'Off: Antigravity runs commands and edits files without asking.' : 'On: each Antigravity command and file edit waits for your approval in the conversation.'} Codex always has full access.</span></span>
      <button type="button" role="switch" aria-checked={!bypass} aria-label="Antigravity: ask before running tools" className={`switch ${!bypass ? 'on' : ''}`} disabled={saving} onClick={toggle}><span /></button>
    </div>
  </section>;
}
