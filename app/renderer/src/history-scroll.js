// Keep the same displayed entry at the same pixel offset as older pages or late details arrive.
//
// The bookmark is what is on screen: the entries found at a few heights in the viewport (a step, or else the row
// holding it), each with its offset from the top. It is found by asking what is at those points, not by measuring
// every entry of the conversation: a long conversation has thousands, and the bookmark is taken as it scrolls.
const keyOf = node => node.dataset.toolId ? `tool:${node.dataset.toolId}` : `row:${node.dataset.historyKey}`;
const PROBES = [0.08, 0.3, 0.55, 0.8];

export function historyBookmark(scroller) {
  if (!scroller) return [];
  const box = scroller.getBoundingClientRect();
  if (!box.height) return [];
  const x = box.left + Math.min(box.width / 2, 400);
  const found = [], seen = new Set();
  for (const share of PROBES) {
    const hit = document.elementFromPoint(x, box.top + box.height * share);
    if (!hit || !scroller.contains(hit)) continue;
    // The step under the point if there is one (it stays put while text streams around it), and its row.
    for (const node of [hit.closest('[data-tool-id]'), hit.closest('[data-history-key]')]) {
      if (!node || !scroller.contains(node)) continue;
      const key = keyOf(node);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ key, offset: node.getBoundingClientRect().top - box.top, step: !!node.dataset.toolId });
    }
  }
  // Steps first (they hold still), in the order they are on screen.
  return found.sort((a, b) => Number(b.step) - Number(a.step)).map(({ key, offset }) => ({ key, offset }));
}

const lookup = (scroller, key) => {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  return scroller.querySelector(kind === 'tool' ? `[data-tool-id="${CSS.escape(id)}"]` : `[data-history-key="${CSS.escape(id)}"]`);
};

export function restoreHistoryBookmark(scroller, bookmark) {
  if (!scroller || !bookmark?.length) return;
  for (const anchor of bookmark) {
    const node = lookup(scroller, anchor.key);
    if (!node) continue;
    scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
    break;
  }
}
