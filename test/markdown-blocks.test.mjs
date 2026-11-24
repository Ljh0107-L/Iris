import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { markdownBlocks, unchangedBlocks } from '../app/renderer/src/markdown-blocks.js';
import { mathExtension } from '../app/renderer/src/markdown-math.js';

marked.use(mathExtension); // as the app's Markdown does: a block-level extension changes where paragraphs end

const html = blocks => blocks.map(block => marked.Parser.parse(block.tokens, marked.defaults)).join('');
const reply = '# Title\n\nFirst paragraph with `code`.\n\n```js\nconst a = 1;\n```\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nLast paragraph';

test('a reply rendered a block at a time is the reply rendered whole', () => {
  assert.equal(html(markdownBlocks(marked, reply).blocks), marked.parse(reply));
  assert.deepEqual(markdownBlocks(marked, reply).blocks.map(block => block.tokens[0].type), ['heading', 'paragraph', 'code', 'list', 'table', 'paragraph']);
  assert.deepEqual(markdownBlocks(marked, '').blocks, []);
  assert.deepEqual(markdownBlocks(marked, null).blocks, []);
});

test('as a reply is written, only the block being written changes', () => {
  let previous = { context: null, blocks: [] }, rebuilt = 0;
  for (let length = 1; length <= reply.length; length++) {
    const next = markdownBlocks(marked, reply.slice(0, length)), kept = unchangedBlocks(previous, next);
    // At most the last block that was shown is rendered again (it grew, or the next block began).
    assert.ok(kept >= previous.blocks.length - 1, `after ${length} characters ${previous.blocks.length - kept} earlier blocks were rebuilt`);
    rebuilt += next.blocks.length - kept;
    assert.equal(html(next.blocks), marked.parse(reply.slice(0, length)));
    previous = next;
  }
  assert.ok(rebuilt < reply.length * 2);
});

test('a finished block is kept; a changed one and everything after it is not', () => {
  const before = markdownBlocks(marked, 'one\n\ntwo\n\nthree');
  assert.equal(unchangedBlocks(before, markdownBlocks(marked, 'one\n\ntwo\n\nthree and more')), 2);
  assert.equal(unchangedBlocks(before, markdownBlocks(marked, 'one\n\nTWO\n\nthree')), 1);
  assert.equal(unchangedBlocks(before, markdownBlocks(marked, 'one')), 1);
  assert.equal(unchangedBlocks({ context: null, blocks: [] }, before), 0);
});

test('a link definition arriving later re-renders the blocks that may use it', () => {
  const before = markdownBlocks(marked, 'See [the docs][1].\n\nMore text');
  const after = markdownBlocks(marked, 'See [the docs][1].\n\nMore text\n\n[1]: https://example.com/docs');
  assert.equal(unchangedBlocks(before, after), 0);
  assert.match(html(after.blocks), /<a href="https:\/\/example\.com\/docs">the docs<\/a>/);
});

test('raw HTML keeps the reply one document, since a tag may close in a later block', () => {
  const text = '<details>\n<summary>More</summary>\n\nHidden **text**\n\n</details>\n\nAfter';
  const { context, blocks } = markdownBlocks(marked, text);
  assert.equal(context, 'whole');
  assert.equal(blocks.length, 1);
  assert.equal(html(blocks), marked.parse(text));
});

// Reading only the end of a growing reply must give exactly what reading all of it gives, at every length.
const tricky = [
  reply,
  '1. first\n\n2. second\n\n   continued under second\n\n3. third\n\nAfter the list\n\n- a\n\n- b\n  - nested\n\n    deeper text\n\nEnd',
  '> quote line\n> more\n\n> second quote\nlazy continuation\n\nTitle\n=====\n\nSub\n---\n\npara\n    not code, still the paragraph\n\n    real indented code\n\ntail',
  'Intro\n\n$$\nx^2 + y^2\n$$\n\nInline $a+b$ and a price of $5 and $10.\n\n\\[\n\\int_0^1 x\\,dx\n\\]\n\nDone',
  'See [one][a] and [two][b].\n\nMiddle paragraph.\n\n[a]: https://example.com/a\n\nMore words here.\n\n[b]: https://example.com/b "B"\n\nLast [one][a].',
  'Before\n\n<details>\n<summary>More</summary>\n\nHidden **text**\n\n</details>\n\nAfter the details\n\nAnd more',
  'a | b\n- | -\n1 | 2\n\n```\nunclosed fence\n\nwith a blank line\n```\n\n~~~py\nprint(1)\n~~~\n\n***\n\n- [ ] task\n- [x] done\n\nwindows\r\nline endings\r\n\r\nhere',
];
test('reading only the end of a growing reply gives what reading all of it gives', () => {
  for (const document of tricky) for (const step of [1, 7]) {
    let previous;
    for (let length = step; length < document.length + step; length += step) {
      const text = document.slice(0, length);
      previous = markdownBlocks(marked, text, previous);
      const whole = markdownBlocks(marked, text);
      assert.deepEqual(previous.blocks.map(block => block.raw), whole.blocks.map(block => block.raw), `blocks after ${length} characters of ${JSON.stringify(document.slice(0, 30))}`);
      assert.equal(previous.context, whole.context);
      assert.equal(html(previous.blocks), marked.parse(text), `HTML after ${length} characters of ${JSON.stringify(document.slice(0, 30))}`);
      assert.equal(previous.blocks.map(block => block.start).join(), whole.blocks.map(block => block.start).join());
    }
  }
});

test('a long reply is not read from the start again as it grows', () => {
  const long = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} of the reply.`).join('\n\n');
  let previous = markdownBlocks(marked, long);
  const first = previous.blocks[0], next = markdownBlocks(marked, long + ' And more', previous);
  assert.equal(next.blocks[0], first, 'earlier blocks are the same objects, not parsed again');
  assert.equal(next.blocks.length, 200);
  assert.notEqual(next.blocks.at(-1), previous.blocks.at(-1));
  // Text that is not a continuation (an edited or replaced reply) is read whole.
  assert.notEqual(markdownBlocks(marked, 'Something else entirely\n\nwith\n\nblocks', previous).blocks[0], first);
});
