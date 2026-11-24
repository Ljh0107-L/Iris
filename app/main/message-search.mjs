// ⌘K finds conversations by what was said in them, not only by title: the session files are read line by
// line (every engine keeps Pi's layout), and each conversation gives its latest matching message with a
// little text around the match. Tool output and the desktop's own prompts are not searched. Files on this
// Mac are read here; a connected SSH host reads its own (remoteSearchScript) and sends back what it found.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const quote = text => `'${String(text).replace(/'/g, `'\\''`)}'`; // one shell word

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
  // A line is JSON: a quote or a backslash in the query is written there with a backslash before it.
  const written = JSON.stringify(query).slice(1, -1);
  let hit = null;
  for await (const line of lines) {
    if (line.length > MAX_LINE || !line.toLowerCase().includes(written)) continue;
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
  const hits = [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, hit]) => hit).slice(0, limit);
  // Out of time with conversations still unread: the list is not everything, and whoever shows it says so.
  if (next < conversations.length && found.size < limit) hits.partial = true;
  return hits;
}

// The same search, run by a host's own Node over its own files. The conversations ([{ id, file }]) arrive
// on standard input, so their number is not limited by the length of a command line.
export function remoteSearchScript(node, query, options = {}) {
  const source = `const { createReadStream } = require('node:fs'), { createInterface } = require('node:readline');
const MAX_LINE = ${MAX_LINE};
const textOf = ${textOf.toString()};
${snippetAround.toString()}
${findInSessionFile.toString()}
${searchSessionFiles.toString()}
let input = '';
process.stdin.on('data', chunk => { input += chunk; }).on('end', () => {
  searchSessionFiles(JSON.parse(input), ${JSON.stringify(String(query ?? ''))}, ${JSON.stringify(options)})
    .then(hits => process.stdout.write(Buffer.from(JSON.stringify({ hits, partial: hits.partial === true })).toString('base64')))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
});`;
  return `${quote(node)} -e ${quote(source)}`;
}
// Base64 keeps text whole however SSH splits its output; anything else is not an answer.
export function decodeRemoteSearch(output) {
  const encoded = String(output ?? '').trim(), data = Buffer.from(encoded, 'base64');
  if (!encoded || data.toString('base64') !== encoded) throw new Error('The host did not answer the search.');
  const result = JSON.parse(data.toString('utf8'));
  if (!Array.isArray(result?.hits)) throw new Error('The host did not answer the search.');
  return { hits: result.hits.filter(hit => typeof hit?.id === 'string' && typeof hit.snippet === 'string'), partial: result.partial === true };
}
