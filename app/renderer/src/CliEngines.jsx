import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EngineLogo, Icon } from './Icons.jsx';
import { MenuItem, MenuSection, Spinner, Trigger, envIcon } from './ui.jsx';
import { CliTerminal, watchTerminal } from './TerminalPanel.jsx';
import { readSignInOutput } from './sign-in-output.js';
import { api, askConfirm, cliDraftMenus, cliOptionsKey, draftCliAccount, loadCliAccounts, loadCliOptions, notify, openSettings, refreshCliReadiness, reportCliAccount, setCliAccounts, setDraft, setSettings, shownCliOptions, useStore } from './store.js';
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

// An account by who it is (its e-mail address, once it has been checked), else by its name in Iris.
const accountLabel = account => account.identity || account.name;
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
        {accounts.map(a => <MenuItem key={a.id} icon="key" label={accountLabel(a)} checked={a.id === current.id} onClick={() => { close(); setDraft({ cliAccount: a.id }); }} />)}
      </MenuSection>
      <div className="menu-foot"><MenuItem icon="settings" label="Manage accounts…" onClick={() => { close(); openSubscriptions(); }} /></div>
    </>}>
    <Icon name="key" size={13} /><span>{accountLabel(current)}</span><Icon name="chevronDown" size={11} />
  </Trigger>;
}

// One of a CLI's menus. A long one (Cursor lists dozens of models) can be searched, and scrolls inside the
// window instead of running past it.
const LONG_MENU = 12;
function ChoiceMenu({ option, value, onPick, close }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const long = option.options.length > LONG_MENU;
  const listed = option.options.filter(choice => !q || `${choice.name} ${choice.value}`.toLowerCase().includes(q));
  const items = listed.map(choice => <MenuItem key={choice.value} label={choice.name} title={choice.description} checked={choice.value === value}
    onClick={() => { close(); onPick(choice.value); }} />);
  if (!long) return <MenuSection title={option.name}>{items}</MenuSection>;
  return <div className="model-menu">
    <input className="menu-search" autoFocus placeholder={`Search ${option.name.toLowerCase()}s…`} value={query} onChange={e => setQuery(e.target.value)} />
    <div className="menu-scroll cli-menu-scroll">
      <MenuSection title={option.name}>{items}</MenuSection>
      {!listed.length && <div className="menu-empty">No {option.name.toLowerCase()} matches.</div>}
    </div>
  </div>;
}
// What a menu shows when closed: its choice, and for a setting that is on or off (Cursor's Fast) or a size
// (its Context), the setting's name too: "Fast Off" says what "Off" alone does not.
const choiceLabel = (option, value) => {
  const name = option.options.find(choice => choice.value === value)?.name;
  if (!name) return option.name;
  return option.category === 'model_config' && name !== option.name ? `${option.name} ${name}` : name;
};

// Model and effort for a conversation that has not started: the menus this CLI offered last time on this
// machine, with the last choices selected. They are applied when the conversation opens.
export function DraftCliOptions({ environmentId, engine }) {
  // The account the conversation will use: each has the menus of its own plan.
  const account = useStore(s => draftCliAccount(s.draft));
  const remembered = useStore(s => s.cliDraftOptions[cliOptionsKey(engine, environmentId, account)]);
  const settings = useStore(s => s.settings);
  const options = useMemo(() => shownCliOptions(engine, remembered ?? [], settings), [engine, remembered, settings]);
  const chosen = useStore(s => s.draft.cliChoices) ?? {};
  const ready = useStore(s => s.cliReadiness[readinessKey(engine, environmentId)] === 'ready');
  useEffect(() => { void loadCliOptions(environmentId, engine, account); }, [environmentId, engine, account]);
  // Signed in, but the CLI has not said what it offers on this machine yet: it starts on its own default.
  if (!options.length) return ready ? <span className="trigger static" title={`${engineLabel(engine)} lists its models once a conversation has started on this machine`}><span className="strong">Default model</span></span> : null;
  return <>
    {cliDraftMenus(options, chosen).map(option => {
      const value = option.options.some(choice => choice.value === chosen[option.id]) ? chosen[option.id] : option.currentValue;
      return <Trigger key={option.id} label={option.name} title={option.name} width={280} placement="top-start"
        menu={close => <ChoiceMenu option={option} value={value} close={close} onPick={picked => setDraft({ cliChoices: { ...(option.category === 'model' ? {} : chosen), [option.id]: picked } })} />}>
        {option.category === 'speed' && <Icon name="bolt" size={13} />}<span className={option.category === 'model' ? 'strong' : undefined}>{choiceLabel(option, value)}</span><Icon name="chevronDown" size={11} />
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
  // A choice made while the agent works is shown at once; it takes effect with the next message.
  const waiting = session.cliChoices ?? {};
  const settings = useStore(s => s.settings);
  const options = shownCliOptions(session.engine, state?.authRequired ? [] : state?.options ?? [], settings).map(option => typeof waiting[option.id] === 'string' && option.options?.some(choice => choice.value === waiting[option.id]) ? { ...option, currentValue: waiting[option.id] } : option);
  const change = async (configId, value) => {
    setChanging(true);
    try { await api('cliSetConfig', session.id, configId, value); }
    catch (error) { showError(error); }
    finally { setChanging(false); }
  };
  return <>
    {options.map(option => <Trigger key={option.id} label={option.name} title={option.name} width={280} placement="top-start"
      disabled={changing || session.status !== 'connected'}
      menu={close => <ChoiceMenu option={option} value={option.currentValue} close={close} onPick={picked => { if (picked !== option.currentValue) void change(option.id, picked); }} />}>
      {option.category === 'speed' && <Icon name="bolt" size={13} />}<span className={option.category === 'model' ? 'strong' : undefined}>{choiceLabel(option, option.currentValue)}</span><Icon name="chevronDown" size={11} />
    </Trigger>)}
    <SessionAccount session={session} />
  </>;
}

// The account an existing conversation belongs to (it never changes), when it is not the default one.
function SessionAccount({ session }) {
  const accounts = useStore(s => s.cliAccounts[session.engine]?.accounts);
  useEffect(() => { if (session.cliAccount) void loadCliAccounts(session.engine); }, [session.engine, session.cliAccount]);
  if (!session.cliAccount) return null;
  const found = accounts?.find(a => a.id === session.cliAccount);
  const name = found ? accountLabel(found) : 'Removed account';
  return <span className="trigger cli-session-account" title={`${engineLabel(session.engine)} account: ${name}`}><Icon name="key" size={13} /><span>{name}</span></span>;
}

const installLabels = { preparing: 'Preparing…', downloading: 'Downloading…', uploading: 'Uploading…', installing: 'Installing…' };

function InstallProgress({ progress }) {
  const label = installLabels[progress?.stage] ?? installLabels.preparing;
  const percent = progress?.percent ?? undefined;
  return <div className="cli-install">
    <div role="status"><span>{label}</span>{percent !== undefined && <span>{percent}%</span>}</div>
    <div className={`cli-install-bar ${percent === undefined ? 'indeterminate' : ''}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span style={percent === undefined ? undefined : { '--progress': Math.max(0, Math.min(100, percent)) / 100 }} />
    </div>
  </div>;
}

// "pro" → "Pro", "promax" → "Pro Max": plan ids as the provider names them, made readable.
const planName = plan => plan ? `${String(plan).replace(/^(pro|plus|team|free|business|enterprise|edu)(?=.)/i, '$1 ').replace(/\b\w/g, c => c.toUpperCase())} plan` : null;

const SUBSCRIPTION = { codex: 'ChatGPT plan', antigravity: 'Google account', cursor: 'Cursor plan' };
const BRAND = { codex: 'ChatGPT', antigravity: 'Google', cursor: 'Cursor' };
// How each CLI is installed when Iris does not do it itself: in a terminal here, where it can be watched.
const TERMINAL_INSTALL = { codex: <>Installing with <code>npm install -g @openai/codex</code></> };
const TERMINAL_INSTALL_TITLE = { codex: 'Runs npm install -g @openai/codex in a terminal here' };
// How much of one limit is used, as a bar: "5-hour limit · 42% used · resets 3:00 PM".
function LimitBar({ limit }) {
  const span = limit.label ?? `${limit.windowMinutes >= 10080 ? 'Weekly' : limit.windowMinutes >= 1440 ? 'Daily' : limit.windowMinutes ? `${Math.round(limit.windowMinutes / 60)}-hour` : 'Usage'} limit`;
  const used = Math.max(0, Math.min(100, Math.round(limit.usedPercent)));
  const at = limit.resetsAt ? new Date(limit.resetsAt) : null;
  const resets = at && !Number.isNaN(at.getTime()) ? ` · resets ${at.getTime() - Date.now() < 86400000 ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : '';
  return <div className="sub-limit">
    <span className="sub-limit-name" title={span}>{span}</span>
    <span className={`sub-limit-bar ${used >= 90 ? 'high' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-label={`${span} used`}><span style={{ width: `${used}%` }} /></span>
    <span className="sub-limit-text">{used}% used{resets}</span>
  </div>;
}

// One account of a CLI on the chosen machine. fresh: it was just added, so its sign-in starts at once and,
// if that is given up, the account is dropped again (onAbandon).
const RECENT_MS = 60000;             // a check this recent is not repeated when the page opens
const lastAccountStatus = new Map(); // "engine:machine:account" -> what its last check found, while the app runs
const lastUsage = new Map();         // the same key -> Antigravity's last quota reading
function AccountRow({ environmentId, engine, profile = null, fresh = false, onRemove, onAbandon, onSignedIn }) {
  const antigravity = engine === 'antigravity';
  const local = environmentId === 'local';
  const accountId = profile?.id ?? null; // an extra Codex account; null is the CLI's own sign-in
  const hostLabel = useStore(s => s.environments.find(e => e.id === environmentId)?.label) ?? 'the host';
  const progress = useStore(s => s.antigravityInstalls[`${environmentId}:${engine}`] ?? (antigravity ? s.antigravityInstalls[environmentId] : null));
  const signInUrl = useStore(s => s.cliSignIns[`${engine}:${environmentId}:${accountId ?? 'default'}`]);
  // What the last check found is shown at once when the page opens again; the new check then updates it
  // quietly, so a row says "Checking" only the first time.
  const statusKey = `${engine}:${environmentId}:${accountId ?? 'default'}`;
  const [account, setAccountState] = useState(() => lastAccountStatus.get(statusKey) ?? null);
  const setAccount = useCallback(value => setAccountState(previous => {
    const next = typeof value === 'function' ? value(previous) : value;
    if (next?.installed != null) lastAccountStatus.set(statusKey, next);
    return next;
  }), [statusKey]);
  const [checking, setChecking] = useState(true);
  // Until the app has said what it found last time (a moment), the row says nothing rather than "Checking".
  const [asked, setAsked] = useState(() => lastAccountStatus.has(statusKey));
  const [refreshing, setRefreshing] = useState(false); // the Refresh button was pressed; a check of its own accord is quiet
  const [requesting, setRequesting] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState(null);
  const [terminal, setTerminal] = useState(null);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [terminalLink, setTerminalLink] = useState(null); // the page a sign-in in the terminal says to open
  const [hostSignIn, setHostSignIn] = useState(false); // Antigravity on a host: the link-and-code sign-in is open
  const [hostIdentity, setHostIdentity] = useState(null); // who the CLI said it signed in, until a check says so itself
  // Antigravity's quota and account come from the CLI's own /usage screen, read in the background: it takes
  // some seconds, so the last reading is shown meanwhile.
  const [usage, setUsage] = useState(() => lastUsage.get(statusKey) ?? null);
  const [readingUsage, setReadingUsage] = useState(false);
  const readUsage = useCallback(async force => {
    if (!antigravity || !local) return;
    setReadingUsage(true);
    try { const found = await api('cliUsage', environmentId, engine, !!force); if (found) { lastUsage.set(statusKey, found); setUsage(found); } }
    catch { /* the row still says who is signed in */ }
    finally { setReadingUsage(false); }
  }, [antigravity, local, environmentId, engine, statusKey]);
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
  }, [environmentId, engine, accountId, setAccount]);
  const install = async () => {
    setRequesting(true);
    try { await api('antigravityInstall', environmentId, engine); }
    catch { /* the progress event carries the error, including across navigation */ }
    finally { setRequesting(false); }
  };
  // The card's callbacks are new functions on every render: read through a ref, they do not restart the check below.
  const handlers = useRef({});
  handlers.current = { onAbandon, onSignedIn };
  // On this Mac the CLI signs in through the browser and Iris waits for it. On a host, Antigravity's sign-in is
  // a link and a code, shown as two steps here (HostCodeSignIn); Codex's is its device sign-in in a terminal.
  const signIn = useCallback(async () => {
    if (!local && engine === 'antigravity') { setError(null); setHostSignIn(true); return; }
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
  }, [local, environmentId, engine, accountId, fresh, setAccount]);
  // On a host, Codex can take the sign-in this Mac already has: no browser or code needed there.
  const copySignIn = async () => {
    setCopying(true); setError(null);
    try {
      const result = await api('cliCopySignIn', environmentId, engine, accountId);
      setAccount(result);
      if (!accountId) reportCliAccount(environmentId, result, engine);
      if (!result.signedIn) throw new Error('The host did not accept the sign-in. Sign in on the host instead.');
    } catch (err) { setError(cleanError(err)); }
    finally { setCopying(false); }
  };
  const started = useRef(false);
  useEffect(() => {
    if (installing) return;
    if (fresh && !started.current) { started.current = true; setChecking(false); setAccount({ installed: true, signedIn: false }); void signIn(); return; }
    if (fresh) return;
    // What was found within the last minute (by this page, or by the app in the background) is shown as it is;
    // anything older is shown too, and checked again beside it.
    let alive = true;
    api('cliAccountLast', environmentId, engine, accountId).then(last => {
      if (!alive) return;
      setAsked(true);
      if (last) setAccountState(now => now ?? last);
      if (last?.ageMs != null && last.ageMs < RECENT_MS) { if (!accountId) reportCliAccount(environmentId, last, engine); setChecking(false); } else void check();
    }, () => { if (alive) { setAsked(true); void check(); } });
    return () => { alive = false; };
  }, [check, installing, fresh, signIn, environmentId, engine, accountId]);
  const signOut = async () => {
    setChecking(true); setError(null);
    try { const result = await api('cliAccountStatus', environmentId, 'logout', engine, accountId); setAccount(result); if (!accountId) reportCliAccount(environmentId, result, engine); }
    catch (err) { setError(cleanError(err)); }
    finally { setChecking(false); }
  };
  const terminalExited = useCallback(code => { setTerminalLink(null); if (!code) void check(); }, [check]);
  // Cursor signing in on a host prints the page to open and waits until it is done there: no code to paste. The
  // page opens here by itself, once; the terminal stays for what the CLI says.
  const opened = useRef(null);
  const onTerminalLink = useCallback(link => {
    setTerminalLink(link);
    if (engine === 'cursor' && link && opened.current !== link) { opened.current = link; api('openExternal', link).catch(() => {}); }
  }, [engine]);
  const signedIn = account?.signedIn === true;
  // Read beside the account check, not after it; and until either answers, what the last run of the app found.
  useEffect(() => { void readUsage(false); }, [readUsage]);
  useEffect(() => {
    if (fresh) return;
    let alive = true;
    if (antigravity && local && !lastUsage.has(statusKey)) api('cliUsageLast', environmentId, engine).then(last => { if (alive && last) setUsage(now => now ?? last); }, () => {});
    return () => { alive = false; };
  }, [statusKey, environmentId, engine, accountId, antigravity, local, fresh]);
  const message = progress?.stage === 'error' ? progress.message : error;
  // What is true on that machine right now, in two or three words.
  const state = installing ? 'Installing' : signingIn ? 'Signing in' : !account ? (!asked && !fresh ? '' : checking ? 'Checking' : 'Could not check')
    : account.installed === false ? 'Not installed'
    : signedIn ? null : checking && asked ? 'Checking' : account.signedIn === false ? 'Not signed in'
    : 'Could not check';
  const busy = state === 'Checking' || state === 'Installing' || state === 'Signing in';
  // Signed in, the row is the account: who, and on which plan.
  const who = signedIn ? (account.identity || usage?.identity || hostIdentity || profile?.name || 'Signed in') : profile?.name;
  const plan = signedIn ? planName(account.plan) : null;
  const limits = signedIn ? (account.limits?.length ? account.limits : usage?.limits ?? []) : [];
  const brand = BRAND[engine] ?? 'ChatGPT';
  return <div className="sub-account">
    <div className="sub-account-row">
      {signedIn ? <span className="sub-state ok"><span className="sub-dot" /><span className="sub-who" title={who}>{who}</span></span>
        : <span className={`sub-state ${busy ? 'busy' : ''}`}>{busy ? <Spinner size={11} /> : state ? <span className="sub-dot" /> : null}{who && state ? `${who} · ${state}` : state || who}</span>}
      {plan && <span className="sub-plan">{plan}</span>}
      {!installing && !signingIn && <div className="sub-actions">
        {account?.installed ? <>
          {signedIn && <button type="button" className="tool-button" aria-label="Refresh" title="Refresh" disabled={refreshing} onClick={() => { setRefreshing(true); void Promise.all([check(), readUsage(true)]).finally(() => setRefreshing(false)); }}>{refreshing ? <Spinner size={13} /> : <Icon name="refresh" size={14} />}</button>}
          {signedIn ? (profile ? <button type="button" className="button small" title="Sign out and remove this account from Iris" onClick={onRemove}>Remove</button>
              : !antigravity && <button type="button" className="button small" disabled={checking} onClick={signOut}>Sign out</button>)
            : <>
              {!local && engine === 'codex' && <button type="button" className="button small primary" disabled={checking || copying || terminal === 'login'} title="Copies this Mac’s Codex sign-in to the host over SSH" onClick={copySignIn}>{copying ? 'Copying…' : 'Use this Mac’s sign-in'}</button>}
              <button type="button" className={`button small ${!local && engine === 'codex' ? '' : 'primary'}`} disabled={terminal === 'login' || hostSignIn || checking || copying} onClick={signIn}>{!local && !antigravity ? 'Sign in on the host' : `Sign in with ${brand}`}</button>
              {profile && <button type="button" className="button small ghost" onClick={onRemove}>Remove</button>}
            </>}
        </> : account?.installed === false ? (antigravity || engine === 'cursor' ? <button type="button" className="button small primary" title={engine === 'cursor' ? 'Downloads Cursor’s own CLI into ~/.local/share/cursor-agent and links it as cursor-agent (an existing agent command is left alone). It goes on in the background.' : undefined} onClick={install}>Install</button>
          : <button type="button" className="button small primary" disabled={terminal === 'install'} title={TERMINAL_INSTALL_TITLE[engine]} onClick={() => setTerminal('install')}>Install</button>)
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
    {hostSignIn && !signedIn && <HostCodeSignIn environmentId={environmentId} engine={engine} account={accountId} host={hostLabel}
      onSignedIn={async identity => {
        setHostIdentity(identity); setHostSignIn(false);
        const result = await check();
        // The CLI said it signed in, and a CLI started the same way a moment later says nobody is. Say so,
        // rather than a bare "Not signed in" after a sign-in that looked as if it worked.
        if (result && result.signedIn === false) setError(`The CLI on ${hostLabel} signed in as ${identity}, but its next start there found no sign-in. Its log in ~/.gemini/iris/log on the host says why.`);
      }} onClose={() => setHostSignIn(false)} />}
    {installing && <InstallProgress progress={progress} />}
    {limits.length > 0 && <div className="sub-limits">{limits.map((limit, index) => <LimitBar key={index} limit={limit} />)}</div>}
    {signedIn && !limits.length && readingUsage && <div className="sub-reading" role="status"><Spinner size={11} />Reading quota from the CLI…</div>}
    {message && !installing && <p className="cli-settings-error" role="alert">{message}</p>}
    {terminal && <div className="cli-terminal-card">
      <div className="cli-terminal-head">
        <span>{terminal === 'login' ? `Sign in with ${brand}` : TERMINAL_INSTALL[engine]}</span>
        <div className="sub-actions">
          {terminal === 'login' && terminalLink && <>
            <button type="button" className="button small primary" onClick={() => api('openExternal', terminalLink)}>Open sign-in page</button>
            <button type="button" className="button small" onClick={async () => { try { await navigator.clipboard.writeText(terminalLink); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* it is in the terminal too */ } }}>{copied ? 'Copied' : 'Copy link'}</button>
          </>}
          <button type="button" className="button small ghost" aria-label="Close terminal" title="Close terminal" onClick={() => setTerminal(null)}><Icon name="x" size={14} /></button>
        </div>
      </div>
      <CliTerminal key={terminal} environmentId={environmentId} action={terminal} engine={engine} account={accountId} onExit={terminalExited} onLink={onTerminalLink} />
    </div>}
  </div>;
}

// Signing Antigravity in on an SSH host. The CLI does it in a terminal there: it prints a Google link and
// waits for the code that page shows. Here that is two steps on the page (the link opens in the browser, the
// code goes in a field) and the terminal is not shown: a 700-character link wrapped over six lines, and a
// prompt that takes a paste only while it has the keyboard, is where people got lost.
function HostCodeSignIn({ environmentId, engine, account, host, onSignedIn, onClose }) {
  const [attempt, setAttempt] = useState(0);
  const [seen, setSeen] = useState(() => readSignInOutput(''));
  const [phase, setPhase] = useState('starting'); // starting | code | finishing | failed
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState(null);
  const [copied, setCopied] = useState(false);
  const term = useRef(null);
  const done = useRef({});
  done.current = { onSignedIn };
  useEffect(() => {
    let disposed = false, id = null, output = '', opened = false, unwatch = null;
    setSeen(readSignInOutput('')); setPhase('starting'); setCode(''); setProblem(null);
    // Wide, so that nothing the CLI prints is broken into lines.
    api('termOpenCli', environmentId, 'login', 1000, 30, engine, account).then(termId => {
      if (disposed) { api('termClose', termId).catch(() => {}); return; }
      id = termId; term.current = termId;
      unwatch = watchTerminal(termId, {
        onData: data => {
          output = (output + data).slice(-20000);
          const now = readSignInOutput(output);
          setSeen(now);
          if (now.wantsCode && !opened) { opened = true; setPhase('code'); api('openExternal', now.link).catch(() => {}); }
        },
        onExit: () => {
          const end = readSignInOutput(output);
          term.current = null;
          if (end.signedInAs) { done.current.onSignedIn?.(end.signedInAs); return; }
          setProblem(end.refused ? 'That code was not accepted. Sign in again and paste the new code.'
            : end.failure ? `The host could not finish the sign-in: ${end.failure.slice(0, 240)}`
            : end.lastLine || 'The sign-in could not be started on this host.');
          setPhase('failed');
        },
      });
      return api('termReady', termId);
    }).catch(err => { if (!disposed) { setProblem(cleanError(err)); setPhase('failed'); } });
    return () => { disposed = true; unwatch?.(); if (id) api('termClose', id).catch(() => {}); term.current = null; };
  }, [environmentId, engine, account, attempt]);
  const finish = event => {
    event.preventDefault();
    const value = code.trim();
    if (!value || !term.current) return;
    setPhase('finishing');
    api('termWrite', term.current, `${value}\r`).catch(err => { setProblem(cleanError(err)); setPhase('failed'); });
  };
  if (phase === 'failed') return <div className="sub-flow failed" role="alert">
    <span className="sub-flow-text">{problem}</span>
    <div className="sub-actions">
      <button type="button" className="button small primary" onClick={() => setAttempt(n => n + 1)}>Try again</button>
      <button type="button" className="button small ghost" onClick={onClose}>Cancel</button>
    </div>
  </div>;
  if (phase !== 'code') return <div className="sub-flow" role="status">
    <span className="sub-flow-text"><Spinner size={11} /> {phase === 'finishing' ? 'Finishing the sign-in…' : `Starting the sign-in on ${host}…`}</span>
    <div className="sub-actions"><button type="button" className="button small ghost" onClick={onClose}>Cancel</button></div>
  </div>;
  return <form className="sub-flow code" onSubmit={finish}>
    <span className="sub-flow-text">Sign in with Google in your browser, then paste the code it shows.</span>
    <div className="sub-code-row">
      <input className="sub-code" autoFocus value={code} onChange={event => setCode(event.target.value)} placeholder="Authorization code" aria-label="Authorization code" autoComplete="off" autoCapitalize="off" spellCheck={false} />
      <button type="submit" className="button small primary" disabled={!code.trim()}>Finish</button>
      <button type="button" className="button small" onClick={() => api('openExternal', seen.link)}>Open again</button>
      <button type="button" className="button small" onClick={async () => { try { await navigator.clipboard.writeText(seen.link); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the page is open already */ } }}>{copied ? 'Copied' : 'Copy link'}</button>
      <button type="button" className="button small ghost" onClick={onClose}>Cancel</button>
    </div>
  </form>;
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
    {['codex', 'antigravity', 'cursor'].filter(engine => CLI_ENGINES[engine]).map(engine => <SubscriptionCard key={`${engine}:${environmentId}`} environmentId={environmentId} engine={engine}>
      {engine === 'antigravity' && <label className="sub-option">
        <span>Ask before running commands and editing files</span>
        <button type="button" role="switch" aria-checked={!bypass} aria-label="Antigravity: ask before running tools" className={`switch ${!bypass ? 'on' : ''}`} disabled={saving} onClick={toggle}><span /></button>
      </label>}
    </SubscriptionCard>)}
  </section>;
}

// Settings → Cursor: which of Cursor's models its model menu lists. Cursor offers dozens, each with settings of
// its own (effort, context, speed); the ones switched off here stay out of the menu of every Cursor
// conversation, on every machine (a conversation's own model is listed all the same). Until a choice is made,
// all of them are. The list is the one Cursor gives on the chosen machine (each machine's CLI says its own).
export function CursorSettings() {
  const shown = useStore(s => s.settings?.defaults?.cursorModels);
  const environments = useStore(s => s.environments.filter(e => e.kind === 'local' || (e.added && e.enabled)));
  const known = useStore(s => s.cliDraftOptions);
  const initial = useStore(s => s.settingsEnvironmentId ?? s.draft.environmentId);
  // The machine to start on: the one the new conversation is on, else one Cursor has listed its models on.
  const [selected, select] = useState(() => initial);
  const machine = environments.some(e => e.id === selected) ? selected
    : environments.find(e => known[cliOptionsKey('cursor', e.id)]?.length)?.id ?? 'local';
  const current = environments.find(e => e.id === machine);
  const readiness = useStore(s => s.cliReadiness[readinessKey('cursor', machine)]);
  const remembered = known[cliOptionsKey('cursor', machine)];
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  // The check may read the models again (a host's, once after they start going through this Mac): they are
  // loaded again when it is done.
  useEffect(() => { setError(null); void loadCliOptions(machine, 'cursor'); void Promise.resolve(refreshCliReadiness(machine, 'cursor')).finally(() => loadCliOptions(machine, 'cursor')); }, [machine]);
  const models = (remembered ?? []).find(o => o.category === 'model')?.options ?? [];
  const on = value => !Array.isArray(shown) || shown.includes(value);
  const count = models.filter(choice => on(choice.value)).length;
  const save = async next => {
    setError(null);
    try { setSettings(await api('updateDefaults', { cursorModels: next })); }
    catch (err) { setError(cleanError(err)); }
  };
  const toggle = value => {
    const current = Array.isArray(shown) ? shown.filter(v => models.some(choice => choice.value === v)) : models.map(choice => choice.value);
    const next = on(value) ? current.filter(v => v !== value) : [...current, value];
    void save(models.every(choice => next.includes(choice.value)) ? null : next);
  };
  const refresh = async () => {
    setRefreshing(true); setError(null);
    try { await api('refreshCliMenus', machine, 'cursor', null); await loadCliOptions(machine, 'cursor'); }
    catch (err) { setError(cleanError(err)); }
    finally { setRefreshing(false); }
  };
  const picker = environments.length > 1 && <div className="sub-machine">
    <span>Machine</span>
    <Trigger className="cli-machine" label="Machine" width={240} placement="bottom-end"
      menu={close => <MenuSection>{environments.map(env => <MenuItem key={env.id} icon={envIcon(env)} label={env.label} checked={env.id === machine} onClick={() => { select(env.id); close(); }} />)}</MenuSection>}>
      <Icon name={envIcon(current)} size={14} /><span>{current?.label ?? 'This computer'}</span><Icon name="chevronDown" size={12} />
    </Trigger>
  </div>;
  const where = current?.kind === 'ssh' ? ` on ${current.label}` : ' on this Mac';
  const q = query.trim().toLowerCase();
  const listed = models.filter(choice => !q || `${choice.name} ${choice.value}`.toLowerCase().includes(q));
  if (!models.length) return <section className="section cli-settings" aria-label="Cursor models">
    {picker}
    <ul className="rows"><li className="row-card setting-rows"><div className="row-head">
      <div className="setting-text">
        <span className="row-name">{readiness === 'missing' ? `Cursor CLI is not installed${where}` : readiness === 'signedOut' ? `Not signed in to Cursor${where}` : readiness === 'unreachable' ? `${current?.label ?? 'The machine'} cannot be reached` : `Reading Cursor’s models${where}…`}</span>
        <span className="row-meta">{readiness === 'missing' || readiness === 'signedOut' ? 'Install it and sign in in Settings → Subscriptions; its models are listed here then.' : 'Cursor lists the models of your plan once it is signed in.'}</span>
      </div>
      <div className="row-actions">
        {readiness === 'missing' || readiness === 'signedOut'
          ? <button type="button" className="button small primary" onClick={() => openSettings(true, 'subscriptions', { environmentId: machine })}>Open Subscriptions</button>
          : <button type="button" className="button small" disabled={refreshing} onClick={refresh}>{refreshing ? <Spinner size={12} /> : 'Refresh'}</button>}
      </div>
    </div></li></ul>
    {error && <p className="cli-settings-error" role="alert">{error}</p>}
  </section>;
  return <section className="section cli-settings" aria-label="Cursor models">
    {picker}
    <div className="section-head">
      <div>
        <h2 className="section-title">Models in the menu</h2>
        <p className="section-intro">{count === models.length ? `All ${models.length} models of your plan are listed.` : `${count} of ${models.length} models are listed.`} Switch off the ones you don’t use; this holds on every machine.</p>
      </div>
      <div className="row-actions">
        <button type="button" className="tool-button" aria-label="Refresh the list" title="Read the list again from Cursor" disabled={refreshing} onClick={refresh}>{refreshing ? <Spinner size={13} /> : <Icon name="refresh" size={14} />}</button>
        <button type="button" className="button small" disabled={count === models.length} onClick={() => save(null)}>Show all</button>
        <button type="button" className="button small" disabled={count === 0} onClick={() => save([])}>Hide all</button>
      </div>
    </div>
    <input className="cursor-model-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search models" aria-label="Search models" spellCheck={false} />
    <ul className="rows">
      <li className="row-card setting-rows cursor-models">
        {listed.map(choice => {
          const settings = (choice.sub ?? []).map(option => option.name);
          return <div key={choice.value} className="row-head">
            <div className="setting-text">
              <span className="row-name" title={choice.value}>{choice.name}</span>
              <span className="row-meta">{settings.length ? settings.join(' · ') : 'No settings of its own'}</span>
            </div>
            <div className="row-actions">
              <button type="button" role="switch" aria-checked={on(choice.value)} aria-label={`List ${choice.name} in the model menu`} className={`switch ${on(choice.value) ? 'on' : ''}`} onClick={() => toggle(choice.value)}><span /></button>
            </div>
          </div>;
        })}
        {!listed.length && <div className="row-head"><span className="row-meta">No model matches “{query.trim()}”.</span></div>}
      </li>
    </ul>
    {error && <p className="cli-settings-error" role="alert">{error}</p>}
  </section>;
}
