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

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// Runs the CLI's interface, asks for /usage and returns parseUsageScreen's result (null if the screen never came).
export async function readAntigravityUsage({ bin, cwd, env, spawnPty, timeoutMs = 40000 }) {
  const term = spawnPty(bin, [], { name: 'xterm-256color', cols: 140, rows: 50, cwd, env });
  let out = '', exited = false;
  term.onData(data => { out = (out + data).slice(-400000); });
  term.onExit(() => { exited = true; });
  const until = async (test, ms) => { for (const end = Date.now() + ms; Date.now() < end && !exited;) { if (test()) return true; await wait(150); } return test(); };
  try {
    // Ready once its prompt line is drawn; a start-up notice may sit over it, which Escape puts away. In a
    // folder it has not seen, the CLI first asks whether to trust it: this one is Iris's own, and empty.
    let trusted = false;
    const ready = () => {
      const screen = screenText(out);
      if (!trusted && /Do you trust the contents of this project\?/.test(screen)) { trusted = true; setTimeout(() => { try { term.write('\r'); } catch { /* gone */ } }, 300); }
      return /for shortcuts/.test(screen);
    };
    if (!await until(ready, Math.min(25000, timeoutMs))) return null;
    await wait(400); term.write('\x1b'); await wait(500);
    const mark = out.length;
    for (const key of '/usage') { term.write(key); await wait(60); }
    await wait(500); term.write('\r');
    const shown = () => /Models & Quota[\s\S]*\]\s*\d+(?:\.\d+)?\s*%/.test(screenText(out.slice(mark)));
    if (!await until(shown, Math.min(20000, timeoutMs))) return null;
    await wait(900); // the rest of the screen
    return parseUsageScreen(out.slice(mark));
  } finally {
    try { term.write('\x1b'); await wait(150); term.write('\x03'); await wait(150); term.write('\x03'); } catch { /* already gone */ }
    setTimeout(() => { try { term.kill(); } catch { /* exited */ } }, 400);
  }
}
