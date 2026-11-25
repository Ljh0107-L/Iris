// Translation of the agent's thinking: one request to the API the person gave, in that API's own shape.
import assert from 'node:assert/strict';
import test from 'node:test';
import { translateText } from '../app/main/translate.mjs';

const answering = (body, status = 200) => { const calls = []; const fetch = async (url, init) => { calls.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return { ok: status >= 200 && status < 300, status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) }; }; return { fetch, calls }; };
const ask = (api, baseUrl, reply, more = {}) => { const f = answering(reply, more.status); return translateText({ api, baseUrl, apiKey: 'key-1', model: 'small-1', text: 'The tests pass.', language: 'Simplified Chinese', fetch: f.fetch, ...more }).then(text => ({ text, call: f.calls[0] }), error => ({ error: error.message, call: f.calls[0] })); };

test('each kind of API is asked in its own shape, with the key where that API reads it', async () => {
  const chat = await ask('openai-completions', 'https://api.example.test/v1/', { choices: [{ message: { content: ' 测试通过。 ' } }] });
  assert.equal(chat.text, '测试通过。');
  assert.equal(chat.call.url, 'https://api.example.test/v1/chat/completions');
  assert.equal(chat.call.headers.authorization, 'Bearer key-1');
  assert.deepEqual(chat.call.body.messages.map(m => m.role), ['system', 'user']);
  assert.equal(chat.call.body.messages[1].content, 'The tests pass.');
  assert.match(chat.call.body.messages[0].content, /into Simplified Chinese/);
  assert.match(chat.call.body.messages[0].content, /Keep code, commands, file paths/);
  // A pasted endpoint path is not repeated.
  assert.equal((await ask('openai-completions', 'https://api.example.test/v1/chat/completions', { choices: [{ message: { content: 'ok' } }] })).call.url, 'https://api.example.test/v1/chat/completions');

  const responses = await ask('openai-responses', 'https://api.example.test/v1', { output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '测试通过。' }] }] });
  assert.deepEqual([responses.text, responses.call.url, responses.call.body.input], ['测试通过。', 'https://api.example.test/v1/responses', 'The tests pass.']);

  const anthropic = await ask('anthropic-messages', 'https://api.example.test/v1', { content: [{ type: 'text', text: '测试通过。' }] });
  assert.deepEqual([anthropic.text, anthropic.call.url, anthropic.call.headers['x-api-key']], ['测试通过。', 'https://api.example.test/v1/messages', 'key-1']);
  assert.ok(anthropic.call.body.max_tokens > 0 && anthropic.call.body.system);

  const google = await ask('google-generative-ai', 'https://generativelanguage.example.test/v1beta', { candidates: [{ content: { parts: [{ thought: true, text: 'thinking' }, { text: '测试通过。' }] } }] });
  assert.equal(google.text, '测试通过。', 'the model’s own thinking is not part of the translation');
  assert.equal(google.call.url, 'https://generativelanguage.example.test/v1beta/models/small-1:generateContent');
  assert.equal(google.call.headers['x-goog-api-key'], 'key-1');
});

test('what goes wrong is said as what it is, and nothing is asked without what it needs', async () => {
  assert.match((await ask('openai-completions', 'https://api.example.test/v1', { error: { message: 'Incorrect API key provided' } }, { status: 401 })).error, /refused the request \(401\): Incorrect API key/);
  assert.match((await ask('openai-completions', 'https://api.example.test/v1', '<html>Bad gateway</html>', { status: 502 })).error, /refused the request \(502\)/);
  assert.match((await ask('openai-completions', 'https://api.example.test/v1', { choices: [{ message: { content: '' } }] })).error, /returned nothing/);
  const none = await ask('openai-completions', 'not a url', {});
  assert.match(none.error, /has no address/); assert.equal(none.call, undefined);
  assert.match((await ask('openai-completions', 'https://api.example.test/v1', {}, { model: '' })).error, /Choose a model/);
  assert.match((await ask('openai-completions', 'https://api.example.test/v1', {}, { text: 'x'.repeat(20000) })).error, /too long/);
  assert.equal(await translateText({ api: 'openai-completions', baseUrl: 'https://api.example.test/v1', model: 'm', language: 'English', text: '   ', fetch: () => { throw new Error('not called'); } }), '');
  const unreachable = await translateText({ api: 'openai-completions', baseUrl: 'https://api.example.test/v1', model: 'm', language: 'English', text: 'hi', fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); } }).catch(e => e.message);
  assert.match(unreachable, /could not be reached: getaddrinfo ENOTFOUND/);
});
