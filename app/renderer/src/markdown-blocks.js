// A reply that is still being written is kept current a block at a time (Markdown in ui.jsx). Markdown's
// top-level blocks (paragraphs, lists, code fences, tables) are rendered separately, and a block whose source
// did not change keeps its nodes, so only the block being written is parsed, highlighted and replaced as
// text arrives. Replacing the whole reply on every frame cost more the longer the reply got, dropped any
// selection in it within a frame, and left a few hundred megabytes of discarded nodes behind a long reply.

const definitions = (token, found = []) => {
  if (token.type === 'def') found.push([token.tag, { href: token.href, title: token.title }]);
  for (const child of token.tokens ?? []) definitions(child, found);
  for (const item of token.items ?? []) definitions(item, found);
  return found;
};

function lex(marked, source, start, links) {
  const lexer = new marked.Lexer(marked.defaults);
  Object.assign(lexer.tokens.links, links);
  const tokens = lexer.lex(source.slice(start)), blocks = [];
  let at = start;
  for (const token of tokens) {
    if (token.type !== 'space') blocks.push({ raw: token.raw, start: at, tokens: Object.assign([token], { links: tokens.links }), definitions: definitions(token) });
    at += token.raw.length;
  }
  return { tokens, blocks };
}

// The reply as blocks: `raw` is a block's source and `tokens` what to render it from. `context` is whatever
// else the rendering depends on; when it changes, nothing rendered before can be kept.
//
// `previous` is what this returned for the reply a moment ago. When the reply only grew, the blocks before
// its last two are taken from there as they are and only the end is read again, so the work per frame does
// not grow with the reply. The last two, because new text can still change them: it continues the last
// block, or joins it to the one before (a second item after a blank line belongs to the list above it).
export function markdownBlocks(marked, text, previous) {
  const source = (text ?? '').replace(/\r\n?/g, '\n');
  if (previous?.source != null && previous.context !== 'whole' && previous.blocks.length > 2 && source.startsWith(previous.source)) {
    const kept = previous.blocks.slice(0, -2), links = Object.create(null);
    for (const block of kept) for (const [tag, link] of block.definitions) links[tag] ??= link;
    const { tokens, blocks } = lex(marked, source, previous.blocks.at(-2).start, links);
    // A link reference ([text][1]) is resolved by a definition anywhere in the reply, and raw HTML can open
    // in one block and close in a later one: either arriving now means reading the reply from the start.
    if (JSON.stringify(tokens.links) === previous.context && !tokens.some(token => token.type === 'html')) return { source, context: previous.context, blocks: [...kept, ...blocks] };
  }
  const { tokens, blocks } = lex(marked, source, 0, null);
  if (tokens.some(token => token.type === 'html')) return { source, context: 'whole', blocks: [{ raw: source, start: 0, tokens, definitions: [] }] };
  return { source, context: JSON.stringify(tokens.links), blocks };
}

// How many leading blocks of `previous` are still what the reply says.
export function unchangedBlocks(previous, next) {
  if (previous.context !== next.context) return 0;
  let kept = 0;
  while (kept < previous.blocks.length && kept < next.blocks.length && previous.blocks[kept].raw === next.blocks[kept].raw) kept++;
  return kept;
}
