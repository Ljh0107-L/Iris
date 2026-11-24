// Antigravity's quota, as its own CLI shows it. The CLI gives quota to no other program: it is on the
// /usage screen of its terminal interface only. So that interface is run in a pseudo-terminal nobody sees,
// /usage is typed, and the screen is read: the account, and for each group of models how much of the weekly
// and the five-hour limit is left and when it refreshes. The CLI makes the request with its own sign-in;
// nothing here touches a token.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>()][0-9A-Za-z]?|\x1b./g;
export const screenText = raw => String(raw ?? '').replace(ANSI, '').replace(/\r/g, '\n');

const minutes = text => {
  const m = /(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/.exec(text ?? '');
  const total = (Number(m?.[1]) || 0) * 1440 + (Number(m?.[2]) || 0) * 60 + (Number(m?.[3]) || 0);
  return total > 0 ? total : null;
};
const groupName = heading => heading.replace(/\s+MODELS$/, '').replace(/\s+AND\s+/g, ' & ').toLowerCase().replace(/\b(gpt)\b/g, 'GPT').replace(/^./, c => c.toUpperCase()).replace(/\bclaude\b/g, 'Claude').replace(/\bgemini\b/g, 'Gemini');
const SPANS = [[/week/i, 10080, 'Weekly'], [/five\s*hour|5[\s-]*hour/i, 300, '5-hour'], [/da(?:il)?y/i, 1440, 'Daily']];

// The last /usage screen in what the terminal printed -> { identity, limits: [{ label, usedPercent, windowMinutes?, resetsAt? }] }.
export function parseUsageScreen(raw, now = Date.now()) {
  const text = screenText(raw);
  const at = text.lastIndexOf('Models & Quota');
  if (at < 0) return null;
  const lines = text.slice(at).split('\n').map(line => line.trim()).filter(Boolean);
  const identity = /Account:\s*(\S+@\S+)/.exec(lines.join('\n'))?.[1] ?? null;
  const limits = [];
  let group = null, pending = null;
  for (const line of lines) {
    if (/^[A-Z][A-Z &,/-]* MODELS$/.test(line)) { group = groupName(line); pending = null; continue; }
    if (!group) continue;
    const named = /^(.*?)\s*Limit Remaining$/i.exec(line);
    if (named) { pending = named[1]; continue; }
    const bar = /\]\s*(\d+(?:\.\d+)?)\s*%/.exec(line);
    if (bar) {
      const span = SPANS.find(([pattern]) => pattern.test(pending ?? ''));
      const remaining = Math.max(0, Math.min(100, Number(bar[1])));
      limits.push({ label: span ? `${group} · ${span[2]}` : group, usedPercent: Math.round((100 - remaining) * 100) / 100, ...(span ? { windowMinutes: span[1] } : {}) });
      pending = null;
      continue;
    }
    const refresh = /^Refreshes in\s+(.+)$/i.exec(line);
    if (refresh && limits.length && limits.at(-1).resetsAt == null) { const m = minutes(refresh[1]); if (m) limits.at(-1).resetsAt = now + m * 60000; }
  }
  return limits.length || identity ? { identity, limits: limits.slice(0, 8) } : null;
}

// The plan, as the CLI's heading names it beside the account: "name@example.com (Google AI Ultra)". The two are
// drawn separately (other parts of the screen come between), so it is looked for by its own form.
export function headingPlan(screen) {
  return /[\w.+-]+@[\w.-]+/.test(screen) ? /\((Google [^)\n]{2,50})\)/.exec(screen)?.[1]?.trim() ?? null : null;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// Runs the CLI's interface, asks for /usage and returns parseUsageScreen's result with the plan from the
// CLI's heading ("name@example.com (Google AI Ultra)"); null if the screen never came. The CLI needs about
// two seconds for it, so nothing here waits a fixed time: each step goes as soon as the screen shows the last.
export async function readAntigravityUsage({ bin, cwd, env, spawnPty, timeoutMs = 30000 }) {
  const term = spawnPty(bin, [], { name: 'xterm-256color', cols: 140, rows: 50, cwd, env });
  let out = '', exited = false, changed = null, last = Date.now();
  term.onData(data => { out = (out + data).slice(-400000); last = Date.now(); changed?.(); });
  term.onExit(() => { exited = true; changed?.(); });
  // Resolves true as soon as test() holds for what has been printed, false once `ms` have gone by.
  const until = (test, ms) => new Promise(resolve => {
    const end = setTimeout(() => { changed = null; resolve(test()); }, ms);
    const look = () => { if (exited || test()) { clearTimeout(end); changed = null; resolve(!exited || test()); } };
    changed = look; look();
  });
  const type = text => { try { term.write(text); } catch { /* gone */ } };
  try {
    // In a folder it has not seen, the CLI first asks whether to trust it: this one is Iris's own, and empty.
    let trusted = false;
    const ready = () => {
      const screen = screenText(out);
      if (!trusted && /Do you trust the contents of this project\?/.test(screen)) { trusted = true; setTimeout(() => type('\r'), 150); }
      return /for shortcuts/.test(screen);
    };
    if (!await until(ready, Math.min(20000, timeoutMs))) return null;
    let mark = out.length;
    const shown = () => /Models & Quota[\s\S]*\]\s*\d+(?:\.\d+)?\s*%/.test(screenText(out.slice(mark)));
    type('/usage\r');
    if (!await until(shown, 3500)) {
      // A start-up notice can swallow the keys: put it away, clear the line, and ask again, key by key.
      type('\x1b'); await wait(300); type('\x15'); mark = out.length;
      for (const key of '/usage') { type(key); await wait(50); }
      await wait(250); type('\r');
      if (!await until(shown, Math.min(15000, timeoutMs))) return null;
    }
    // The rest of the screen follows the first bar: read once nothing more has come for a moment.
    for (const end = Date.now() + 2500; Date.now() < end && Date.now() - last < 250 && !exited;) await wait(40);
    const usage = parseUsageScreen(out.slice(mark));
    // The CLI's heading names the plan beside the account: "name@example.com (Google AI Ultra)".
    const plan = headingPlan(screenText(out));
    return usage ? { ...usage, ...(plan ? { plan } : {}) } : null;
  } finally {
    type('\x1b'); setTimeout(() => { type('\x03'); type('\x03'); }, 100);
    setTimeout(() => { try { term.kill(); } catch { /* exited */ } }, 500);
  }
}
