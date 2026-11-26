// Antigravity's agents (invoke_subagent), read from Antigravity's own files. Plain Node: this runs on hosts.
//
// The call that starts an agent returns at once, and ACP says nothing more about it: the agent is a conversation
// of its own in Antigravity's data directory, and it reports back to the conversation that started it with a
// message. Both are files:
//   <data>/brain/<conversation>/.system_generated/messages/<id>.json   messages to that conversation
//       { sender, recipient, timestamp, content, renderDetails: { messageTitle } }
//   <data>/brain/<conversation>/.system_generated/logs/transcript_full.jsonl   what that conversation did
//       one step a line: { step_index, type: PLANNER_RESPONSE | GENERIC | SYSTEM_MESSAGE | USER_INPUT, status,
//       created_at, content, thinking, tool_calls: [{ name, args }], input_tokens, output_tokens, model }
// An agent's conversation is found by its first message: sent by the conversation that started it, with the
// brief. What it did becomes the steps of its task in Iris; the message it sent back (send_message) is its report.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const text = value => typeof value === 'string' && value.trim() !== '';
const clip = (value, max) => { const s = String(value ?? ''); return s.length > max ? `${s.slice(0, max)}…` : s; };
const MAX_TRANSCRIPT = 32 * 1024 * 1024;

// Antigravity keeps its data under ~/.gemini: Iris's own directory by name, or the CLI's default.
export const antigravityData = (appDataDir, home = homedir()) => join(home, '.gemini', text(appDataDir) ? appDataDir : 'antigravity-cli');

const generated = (data, conversation) => join(data, 'brain', conversation, '.system_generated');
function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function messagesTo(data, conversation) {
  const dir = join(generated(data, conversation), 'messages');
  let names = [];
  try { names = readdirSync(dir).filter(name => name.endsWith('.json') && name !== 'read.json'); } catch { return []; }
  return names.map(name => readJson(join(dir, name))).filter(m => m && typeof m === 'object');
}
const same = (a, b) => String(a ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) === String(b ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

// The conversation of the agent the parent started with this brief, at or after `since` (ms). Conversations
// already taken by other agents (`taken`) are passed over: the same brief can be given twice.
export function findAgentConversation(data, parent, brief, since = 0, taken = new Set()) {
  let conversations = [];
  try { conversations = readdirSync(join(data, 'brain')); } catch { return null; }
  const found = [];
  for (const conversation of conversations) {
    if (conversation === parent || taken.has(conversation)) continue;
    try { if (statSync(join(data, 'brain', conversation)).mtimeMs < since - 120000) continue; } catch { continue; }
    for (const message of messagesTo(data, conversation)) {
      const at = Date.parse(message.timestamp);
      if (message.sender === parent && same(message.content, brief) && !(at < since - 120000)) found.push({ conversation, at });
    }
  }
  return found.sort((a, b) => a.at - b.at)[0]?.conversation ?? null;
}

// Antigravity's tools as Iris shows a step (the names Claude Code's and Codex's agents' steps use).
const ARG = (args, ...keys) => { for (const key of keys) if (text(args?.[key])) return args[key]; return null; };
export function agentStep(call, id) {
  const name = String(call?.name ?? ''), args = call?.args && typeof call.args === 'object' ? call.args : {};
  const path = ARG(args, 'AbsolutePath', 'Path', 'TargetFile', 'File', 'FilePath');
  const step = (n, a) => ({ type: 'tool', id, name: n, arguments: a });
  if (name === 'run_command' && ARG(args, 'CommandLine', 'Command')) return step('bash', { command: clip(ARG(args, 'CommandLine', 'Command'), 4000), ...(text(args.toolSummary) ? { description: clip(args.toolSummary, 200) } : {}) });
  if (/^(read_file|view_file|view_file_outline)$/.test(name) && path) return step('read', { path });
  if (name === 'write_to_file' && path) return step('write', { path });
  if (/replace_file_content|multi_replace|edit_file/.test(name) && path) return step('edit', { path });
  if (name === 'grep_search' && ARG(args, 'Query', 'Pattern')) return step('grep', { pattern: clip(ARG(args, 'Query', 'Pattern'), 500), ...(ARG(args, 'SearchPath', 'SearchDirectory') ? { path: ARG(args, 'SearchPath', 'SearchDirectory') } : {}) });
  if (name === 'find_by_name' && ARG(args, 'Pattern')) return step('find', { pattern: clip(args.Pattern, 500), ...(ARG(args, 'SearchDirectory') ? { path: args.SearchDirectory } : {}) });
  if (name === 'list_dir' && ARG(args, 'DirectoryPath', 'Path')) return step('ls', { path: ARG(args, 'DirectoryPath', 'Path') });
  if (name === 'search_web' && ARG(args, 'query', 'Query')) return step('WebSearch', { query: clip(ARG(args, 'query', 'Query'), 500) });
  if (name === 'read_url_content' && ARG(args, 'Url', 'url')) return step('WebFetch', { url: clip(ARG(args, 'Url', 'url'), 2000) });
  const shown = {};
  for (const [key, value] of Object.entries(args).slice(0, 6)) if (['string', 'number', 'boolean'].includes(typeof value)) shown[key] = typeof value === 'string' ? clip(value, 300) : value;
  return step(name || 'tool', shown);
}

// What an agent's conversation shows now: its steps, its report, whether it is done, its tokens. `stopped`:
// when the parent was told that its agents were stopped (a cancel, or Antigravity's server restarting).
export function readAgent(data, conversation, parent, { stopped = null } = {}) {
  const path = join(generated(data, conversation), 'logs', 'transcript_full.jsonl');
  let raw = '';
  try { if (statSync(path).size <= MAX_TRANSCRIPT) raw = readFileSync(path, 'utf8'); } catch { /* not written yet */ }
  const lines = raw.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const steps = [];
  let report = null, input = 0, output = 0, cacheRead = 0, model = null, turns = 0, last = null;
  for (const entry of lines) {
    if (entry.type !== 'PLANNER_RESPONSE') { if (entry.created_at) last = entry; continue; }
    last = entry; turns++;
    input += Number(entry.input_tokens) || 0; output += Number(entry.output_tokens) || 0; cacheRead += Number(entry.cache_read_tokens) || 0;
    if (text(entry.model)) model = entry.model;
    if (text(entry.content)) steps.push({ type: 'text', text: clip(entry.content.trim(), 2000) });
    for (const [i, call] of (Array.isArray(entry.tool_calls) ? entry.tool_calls : []).entries()) {
      if (call?.name === 'send_message') { const message = call.args?.Message ?? call.args?.message; if (text(message)) report = message; continue; }
      steps.push(agentStep(call, `${conversation}:${entry.step_index}:${i}`));
    }
  }
  // Its report as the parent received it, when there is one (it is the one the parent acts on).
  const received = messagesTo(data, parent).filter(m => m.sender === conversation && text(m.content)).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).at(-1);
  if (received) report = received.content;
  // Done: it has reported back and its last step is an answer with nothing more to do.
  const settled = last?.type === 'PLANNER_RESPONSE' && !(Array.isArray(last.tool_calls) && last.tool_calls.length) && last.status !== 'RUNNING';
  const lastAt = Date.parse(last?.created_at) || 0;
  const status = report && settled ? 'completed'
    : stopped != null && lastAt <= stopped + 5000 && lines.length ? 'cancelled'
      : last?.status === 'ERROR' && settled ? 'failed' : 'running';
  return { conversation, steps, report: report ? clip(report, 20000) : null, status, model,
    usage: { input, output, cacheRead, totalTokens: input + output + cacheRead }, turns, startedAt: Date.parse(lines[0]?.created_at) || null, lastAt: lastAt || null };
}

// When the parent was last told that all its agents were stopped (Antigravity's own notice), after `since`.
export function agentsStoppedAt(data, parent, since = 0) {
  const notices = messagesTo(data, parent).filter(m => m.sender === 'system' && /subagents and background tasks have been stopped/i.test(String(m.content ?? '')))
    .map(m => Date.parse(m.timestamp)).filter(at => at >= since);
  return notices.length ? Math.max(...notices) : null;
}

// Antigravity's background commands. A command still running after the wait it was given becomes a task:
// its step's result says so ("Tool is running as a background task with task id: <parent>/task-N", with its
// log file); its output goes to <data>/brain/<parent>/.system_generated/tasks/task-N.log; and when it ends,
// the parent gets a message from it ("Task id ... finished with result: ... exited with code N", or "was
// canceled").
export function backgroundTaskOf(result) {
  const said = String(result ?? '');
  const id = /running as a background task with task id:\s*(\S+)/i.exec(said)?.[1];
  if (!id) return null;
  const description = /Task Description:\s*([^\n]+)/i.exec(said)?.[1]?.trim() ?? null;
  const log = /Task logs are available at:\s*file:\/\/(\S+)/i.exec(said)?.[1] ?? null;
  return { id, description, log };
}
export function readTaskLog(path, max = 4000) {
  try {
    const size = statSync(path).size;
    if (size <= max) return readFileSync(path, 'utf8');
    const fd = openSync(path, 'r'), buffer = Buffer.alloc(max);
    try { readSync(fd, buffer, 0, max, size - max); } finally { closeSync(fd); }
    return buffer.toString('utf8');
  } catch { return null; }
}
// The end of a task, when its message has come: whether it failed, and its exit code.
export function taskEnded(data, parent, id) {
  const message = messagesTo(data, parent).find(m => m.sender === id);
  if (!message) return null;
  const content = String(message.content ?? '');
  const code = /exited with code (-?\d+)/i.exec(content)?.[1];
  const canceled = /was cancel+ed/i.test(content);
  const exitCode = code != null ? Number(code) : null;
  return { failed: canceled || (exitCode != null && exitCode !== 0), exitCode, output: /Command output:\n([\s\S]*)$/.exec(content)?.[1] ?? null, canceled };
}
