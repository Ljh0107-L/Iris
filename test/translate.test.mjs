// Translation of the agent's thinking: the request a conversation with the chosen model sends (pi-ai), at the
// thinking level chosen in Settings → Translation; and the thinking card's batches of paragraphs.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { translateText } from '../app/main/translate.mjs';
import { BATCH_MAX_TOKENS, BATCH_MIN_TOKENS, BATCH_WAIT_MS, batchesOf, estimateTokens, nextBatches, translatedParagraphs } from '../app/renderer/src/thought-batches.js';

const QWEN = { id: 'openai/qwen3.8-27b', name: 'Qwen', api: 'anthropic-messages', provider: 'lp', reasoning: true, input: ['text'],
  thinkingLevelMap: { minimal: null, low: 'low', medium: 'medium', high: null, xhigh: 'xhigh' }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262000, maxTokens: 32000 };

// An Anthropic-style endpoint that streams one answer, and keeps what it was sent.
async function anthropicServer(t, { text = '测试通过。', status = 200 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      if (status !== 200) { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'reasoning_effort: "off" is not one of low, medium, xhigh' } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event('message_start', { message: { id: 'm1', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, usage: { input_tokens: 9, output_tokens: 0 } } });
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } });
      event('message_stop', {});
      res.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { model: { ...QWEN, baseUrl: `http://127.0.0.1:${server.address().port}` }, seen };
}

test('a translation is the request a conversation sends: thinking off unless chosen, a level as the model maps it', async t => {
  const { model, seen } = await anthropicServer(t);
  assert.equal(await translateText({ model, apiKey: 'key-1', headers: { 'x-team': 'iris' }, text: 'The tests pass.', language: 'Simplified Chinese' }), '测试通过。');
  assert.deepEqual(seen[0].body.thinking, { type: 'disabled' });
  assert.equal(seen[0].headers['x-api-key'], 'key-1');
  assert.equal(seen[0].headers['x-team'], 'iris', 'the provider’s own headers');
  assert.match(JSON.stringify(seen[0].body.system), /into Simplified Chinese/);
  assert.match(JSON.stringify(seen[0].body.system), /one paragraph of translation for each paragraph/);
  assert.equal(seen[0].body.messages.at(-1).content.at?.(-1)?.text ?? seen[0].body.messages.at(-1).content, 'The tests pass.');

  await translateText({ model, apiKey: 'key-1', text: 'The tests pass.', language: 'Simplified Chinese', thinking: 'low' });
  assert.equal(seen[1].body.thinking.type, 'enabled', 'Low: thinking, as a conversation at Low asks for it');
  await translateText({ model, apiKey: 'key-1', text: 'The tests pass.', language: 'Simplified Chinese', thinking: 'high' });
  assert.equal(seen[2].body.thinking.type, 'enabled', 'a level the model does not offer (High) becomes one it does');
  await translateText({ model: { ...model, reasoning: false }, apiKey: 'key-1', text: 'The tests pass.', language: 'Simplified Chinese', thinking: 'medium' });
  assert.equal(seen[3].body.thinking, undefined, 'a model that does not think is not asked about it');
});

test('what goes wrong is said as what it is, in the provider’s own words', async t => {
  const refused = await anthropicServer(t, { status: 400 });
  const error = await translateText({ model: refused.model, apiKey: 'k', text: 'hi', language: 'English' }).catch(e => e.message);
  assert.match(error, /refused the request \(400\): reasoning_effort: "off" is not one of low, medium, xhigh$/);
  const empty = await anthropicServer(t, { text: '' });
  assert.match(await translateText({ model: empty.model, apiKey: 'k', text: 'hi', language: 'English' }).catch(e => e.message), /returned nothing/);
  assert.match(await translateText({ model: { ...QWEN, baseUrl: 'not a url' }, text: 'hi', language: 'English', load: () => assert.fail('nothing is sent') }).catch(e => e.message), /has no address/);
  assert.match(await translateText({ model: null, text: 'hi', language: 'English' }).catch(e => e.message), /Choose a model/);
  assert.match(await translateText({ model: QWEN, text: 'x'.repeat(20000), language: 'English' }).catch(e => e.message), /too long/);
  assert.equal(await translateText({ model: QWEN, text: '   ', language: 'English', load: () => assert.fail('not called') }), '');
  const slow = { completeSimple: (m, c, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))), clampThinkingLevel: (m, l) => l };
  assert.match(await translateText({ model: { ...QWEN, baseUrl: 'http://x.test' }, text: 'hi', language: 'English', timeoutMs: 30, load: async () => slow }).catch(e => e.message), /did not answer in time/);
});

test('a thought goes out in batches: enough of it, or once it has waited, or once it is over; never more at once than may go', () => {
  const short = 'A short paragraph.'; // about 5 tokens
  const long = 'word '.repeat(4 * BATCH_MIN_TOKENS / 5 + 4).trim(); // a little over the minimum
  assert.ok(estimateTokens(long) >= BATCH_MIN_TOKENS && estimateTokens(short) < 10);
  assert.equal(estimateTokens('测试通过了'), 5, 'a CJK character is about a token');
  const base = { ends: [], complete: false, waited: 0, slots: 2 };
  assert.deepEqual(nextBatches({ ...base, finished: [short, short] }), [], 'too little, too soon: it waits for more');
  assert.deepEqual(nextBatches({ ...base, finished: [short, short], waited: BATCH_WAIT_MS }), [2], 'waited long enough: a slow model is not kept waiting');
  assert.deepEqual(nextBatches({ ...base, finished: [short], complete: true }), [1], 'the thought is over');
  assert.deepEqual(nextBatches({ ...base, finished: [short, long, short] }), [3], 'enough: all of it in one');
  assert.deepEqual(nextBatches({ ...base, finished: [short, long], slots: 0 }), [], 'no request may go: it piles up for the next');
  // Many paragraphs at once (a fast model): split at the most a request takes, two requests at a time.
  const many = Array(12).fill(long);
  const ends = nextBatches({ ...base, finished: many });
  assert.equal(ends.length, 2);
  for (const batch of batchesOf(many, ends)) assert.ok(estimateTokens(batch.text) <= BATCH_MAX_TOKENS + 20);
  assert.deepEqual(nextBatches({ ...base, finished: many, ends: [3] }).slice(0, 1), [3], 'earlier batches stay as they were');
});

test('a batch’s translation goes back paragraph by paragraph, or whole when the model joined them', () => {
  const [batch] = batchesOf(['**Plan**', 'Read it.', 'Then test.'], [3]);
  assert.equal(batch.text, '**Plan**\n\nRead it.\n\nThen test.');
  assert.deepEqual(translatedParagraphs(batch, '**计划**\n\n读一下。\n\n然后测试。'), ['**计划**', '读一下。', '然后测试。']);
  assert.deepEqual(translatedParagraphs(batch, '计划：读一下，然后测试。'), ['计划：读一下，然后测试。', null, null]);
});
