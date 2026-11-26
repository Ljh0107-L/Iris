// Line diffs for the change review.
import { diffLines } from 'diff';

const splitLines = text => { const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop(); return lines; };
// A diff is worked out once per pair of texts: the same edit is drawn again on every render of its turn (and
// while a reply streams, that is every frame). The newest few hundred are kept.
const diffs = new Map(), DIFFS_KEPT = 400;
function lineDiff(oldText, newText) {
  const key = `${oldText.length}:${newText.length}:${oldText}\u0000${newText}`;
  let parts = diffs.get(key);
  if (parts) { diffs.delete(key); diffs.set(key, parts); return parts; }
  parts = diffLines(oldText, newText);
  diffs.set(key, parts);
  if (diffs.size > DIFFS_KEPT) diffs.delete(diffs.keys().next().value);
  return parts;
}

// One hunk → display lines, with unchanged lines trimmed to `context` around changes.
export function hunkLines({ oldText, newText }, context = 3) {
  if (oldText === null) return splitLines(newText).map(text => ({ type: 'add', text }));
  const lines = [];
  for (const part of lineDiff(oldText, newText)) {
    const type = part.added ? 'add' : part.removed ? 'del' : 'ctx';
    for (const text of splitLines(part.value)) lines.push({ type, text });
  }
  const keep = lines.map((l, i) => l.type !== 'ctx' || lines.slice(Math.max(0, i - context), i + context + 1).some(x => x.type !== 'ctx'));
  const out = [];
  lines.forEach((l, i) => { if (keep[i]) out.push(l); else if (out.at(-1)?.type !== 'gap') out.push({ type: 'gap', text: '' }); });
  return out;
}

export function changeStats(change) {
  let added = 0, removed = 0;
  for (const h of change.hunks) for (const l of hunkLines(h, 0)) { if (l.type === 'add') added++; if (l.type === 'del') removed++; }
  return { added, removed };
}
