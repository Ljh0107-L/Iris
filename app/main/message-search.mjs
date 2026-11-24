// ⌘K finds conversations by what was said in them, not only by title: the session files on this Mac are
// read line by line (every engine keeps Pi's layout), and each conversation gives its latest matching
// message with a little text around the match. Tool output and the desktop's own prompts are not searched.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const MAX_LINE = 4 << 20; // a line this long is an image or a huge tool result, not something to search
const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n') : '';

export function snippetAround(text, at, length, { before = 40, after = 100 } = {}) {
  const start = Math.max(0, at - before), end = Math.min(text.length, at + length + after);
  // One line of words: code fences, quote marks and headings' hashes go.
  const words = text.slice(start, end).replace(/```[\w-]*/g, ' ').replace(/(^|\n)\s*(?:>|#{1,6})\s?/g, '$1').replace(/\s+/g, ' ').trim();
  return `${start ? '…' : ''}${words}${end < text.length ? '…' : ''}`;
}

// The latest user or assistant message in a session file that contains `query` (lower case), or null.
export async function findInSessionFile(file, query) {
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let hit = null;
  for await (const line of lines) {
    if (line.length > MAX_LINE || !line.toLowerCase().includes(query)) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = entry?.type === 'message' ? entry.message : null;
    if (!['user', 'assistant'].includes(message?.role)) continue;
    const text = textOf(message.content);
    if (message.role === 'user' && text.startsWith('/iris-')) continue;
    const at = text.toLowerCase().indexOf(query);
    if (at >= 0) hit = { role: message.role, snippet: snippetAround(text, at, query.length) };
  }
  return hit;
}

// Conversations (newest first) whose messages mention `query`; stops at `limit` hits or when the time is up.
export async function searchSessionFiles(conversations, query, { limit = 20, budgetMs = 2500, parallel = 4, now = Date.now } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length < 2) return [];
  const deadline = now() + budgetMs, found = new Map();
  let next = 0;
  const worker = async () => {
    while (next < conversations.length && found.size < limit && now() < deadline) {
      const index = next++, { id, file } = conversations[index];
      const hit = await findInSessionFile(file, q).catch(() => null);
      if (hit) found.set(index, { id, ...hit });
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, conversations.length) }, worker));
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, hit]) => hit).slice(0, limit);
}
