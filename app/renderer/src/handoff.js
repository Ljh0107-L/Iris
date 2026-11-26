// Handing a conversation to another agent: a new conversation in the same folder, on the same machine, with a
// first message the person can read and change before sending. To continue the work, or to have it reviewed.
// What it says comes from the conversation as it is loaded here: what was asked, what the agent last reported,
// and the files it changed. (The other agent reads the files and the Git state itself.)
import { engineLabel } from './engines.js';
import { changesOf } from './transcript.js';

export const ENGINE_ORDER = ['iris', 'claude-code', 'codex', 'cursor', 'antigravity'];
const clip = (text, max) => { const t = String(text ?? '').trim(); return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t; };
const textOf = message => (typeof message.content === 'string' ? message.content : (message.content ?? []).filter(c => c?.type === 'text').map(c => c.text ?? '').join('\n'))
  .replace(/(?:^|\n\n)Attached files:\n(?:- .+(?:\n|$))+$/, '').trim();
const quoted = text => text.split('\n').map(line => `> ${line}`).join('\n');

export function handoffText({ engine, messages = [], tools = {}, cwd = '', mode = 'continue' }) {
  const from = engineLabel(engine);
  const asks = messages.filter(m => m.role === 'user').map(textOf).filter(t => t && !t.startsWith('/')).slice(-5).map(t => `- ${clip(t, 600).replace(/\n+/g, ' ')}`);
  const report = [...messages].reverse().find(m => m.role === 'assistant' && textOf(m));
  const files = changesOf(messages, tools).map(change => change.path).slice(0, 30);
  const where = cwd ? ` in ${cwd}` : '';
  const parts = [];
  parts.push(mode === 'review'
    ? `Please review the work ${from} did${where}.`
    : `I am moving this work over from ${from}. Pick it up where it stopped${where}.`);
  if (asks.length) parts.push(`What was asked:\n${asks.join('\n')}`);
  if (report) parts.push(`What ${from} last reported:\n${quoted(clip(textOf(report), 2000))}`);
  if (files.length) parts.push(`Files it changed:\n${files.map(path => `- ${path}`).join('\n')}`);
  parts.push(mode === 'review'
    ? 'Read the changes (git diff, and the files above) and check them for bugs, missed requirements and risky edits. Say what you would change and why; do not edit files unless I ask.'
    : 'Check the current state of the files first, then continue.');
  return parts.join('\n\n');
}
