// Exercise actual Pi/OpenAI Responses parsing with broken HTTP streams, not synthetic UI errors.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { PiSession } from '../core/pi-session.mjs';
import { localTransport } from '../core/transports.mjs';
import { branchMessages } from '../app/main/session-manager.mjs';
import { applyEvent, displayBlocks, emptyTranscript, failureTitle, fromHistory, providerFailure } from '../app/renderer/src/transcript.js';

async function runCase(t, { breakStream = 'reset', always = false, abortRetry = false, tool = false, status = 200,
  retry = { enabled: true, maxRetries: 2, baseDelayMs: abortRetry ? 1000 : 30 }, provider = 'mock', model = 'test', speed } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pds-'));
  const agentDir = join(dir, 'agent'); mkdirSync(agentDir);
  if (retry) writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ retry }));
  let requests = 0;
  const payloads = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    payloads.push(payload);
    requests++;
    if (status !== 200) { res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'invalid API key', type: 'authentication_error' } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const id = `resp_${requests}`;
    send({ type: 'response.created', response: { id, status: 'in_progress' } });
    const hasToolOutput = payload.input?.some(item => item.type === 'function_call_output');
    const call = tool && !hasToolOutput;
    const item = call ? { type: 'function_call', id: `fc_${requests}`, call_id: `call_${requests}`, name: 'bash', arguments: 'echo once >> marker.txt' }
      : { type: 'message', id: `msg_${requests}`, role: 'assistant', content: [{ type: 'output_text', text: 'Recovered answer', annotations: [] }] };
    if (call) item.arguments = JSON.stringify({ command: item.arguments });
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, ...(call ? { arguments: '' } : { content: [] }) } });
    if (call) send({ type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments });
    else send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Recovered answer' });
    send({ type: 'response.output_item.done', output_index: 0, item });
    // For the tool case: the tool already ran before its follow-up stream breaks.
    // A retry must continue from that tool result, not resubmit the original prompt.
    if (always || requests === (tool ? 2 : 1)) {
      await sleep(30); // ensure the client has consumed the first SSE frames
      if (breakStream === 'eof') res.end(); else res.destroy();
      return;
    }
    send({ type: 'response.completed', response: { id, status: 'completed', output: [item], service_tier: payload.service_tier ?? 'default',
      usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 } } });
    res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const session = new PiSession({ id: 'stream-recovery', boot: { config: { speed }, providers: [{ id: provider, api: 'openai-responses', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test-only', models: [{ id: model }] }] },
    transport: localTransport({ node: process.execPath, piCli: resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
      cwd: dir, agentDir, retryPath: resolve('agent/iris-retry.mjs'), extensions: [resolve('agent/iris-bridge.js')] }) });
  t.after(async () => { await session.stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, { recursive: true, force: true }); });
  const events = [];
  let transcript = emptyTranscript(), retryUi;
  session.on('event', event => {
    events.push(event); transcript = applyEvent(transcript, event);
    if (event.type === 'auto_retry_start') {
      retryUi = transcript;
      if (abortRetry) session.abort().catch(() => {});
    }
  });
  await session.start(); await session.setModel(provider, model);
  const settled = session.nextSettled(15000);
  await session.prompt('test recovery'); await settled;
  const { entries, leafId } = await session.request('get_entries');
  const fromRpc = fromHistory(branchMessages(entries, leafId));
  const { sessionFile } = await session.state();
  const fileEntries = readFileSync(sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const fromDisk = fromHistory(branchMessages(fileEntries, fileEntries.at(-1).id));
  return { requests, payloads, transcript, fromRpc, fromDisk, events, retryUi, dir };
}

for (const breakStream of ['reset', 'eof']) test(`Responses ${breakStream}: retries, recovers, and stays recovered in RPC/disk history`, { timeout: 20000 }, async t => {
  const r = await runCase(t, { breakStream });
  assert.equal(r.requests, 2);
  const error = r.events.find(e => e.type === 'message_end' && e.message.stopReason === 'error')?.message;
  assert.match(error?.errorMessage, breakStream === 'reset' ? /terminated/ : /terminal response event/);
  assert.ok(r.retryUi.retry && r.retryUi.retry.attempt === 1);
  assert.equal(displayBlocks(r.retryUi).filter(b => b.kind === 'error').length, 0);
  for (const transcript of [r.transcript, r.fromRpc, r.fromDisk]) {
    const blocks = displayBlocks(transcript);
    assert.equal(blocks.filter(b => b.kind === 'error').length, 0);
    assert.ok(blocks.some(b => b.kind === 'notice' && b.text.startsWith('Recovered automatically')));
  }
  assert.equal(r.transcript.retry, null);
});

test('repeated disconnects exhaust the bounded budget and preserve the final failure', { timeout: 20000 }, async t => {
  const r = await runCase(t, { always: true });
  assert.equal(r.requests, 3);
  assert.equal(r.events.filter(e => e.type === 'auto_retry_start').length, 2);
  for (const transcript of [r.transcript, r.fromRpc, r.fromDisk]) {
    const errors = displayBlocks(transcript).filter(b => b.kind === 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0].text, /Model connection interrupted.*terminated/);
  }
});

test('default recovery schedules ten retries with increasing delays', { timeout: 20000 }, async t => {
  const first = await runCase(t, { retry: null });
  const scheduled = first.events.find(e => e.type === 'auto_retry_start');
  assert.equal(scheduled.maxAttempts, 10);
  assert.equal(scheduled.delayMs, 200);
  const exhausted = await runCase(t, { always: true, retry: { baseDelayMs: 1 } });
  const retries = exhausted.events.filter(e => e.type === 'auto_retry_start');
  assert.equal(exhausted.requests, 11);
  assert.deepEqual(retries.map(e => e.delayMs), [1, 2, 4, 8, 16, 32, 64, 128, 256, 512]);
  assert.ok(retries.every(e => e.maxAttempts === 10));
  assert.equal(exhausted.events.findLast(e => e.type === 'auto_retry_end').success, false);
});

for (const model of ['gpt-6.2-sol', 'gpt-6.2-astra']) {
  test(`${model} sends Ultrafast to the Responses endpoint, including on retry`, { timeout: 20000 }, async t => {
    const result = await runCase(t, { provider: 'openai', model, speed: 'ultrafast' });
    assert.deepEqual(result.payloads.map(({ model, service_tier }) => ({ model, service_tier })),
      Array(2).fill({ model, service_tier: 'ultrafast' }));
    const reply = result.events.findLast(e => e.type === 'message_end' && e.message.role === 'assistant').message;
    assert.deepEqual(reply.__speed, { requested: 'ultrafast', sent: 'ultrafast', used: 'ultrafast' });
  });
}

test('stop during retry cancels backoff and never starts another request', { timeout: 20000 }, async t => {
  const r = await runCase(t, { always: true, abortRetry: true });
  await sleep(1100);
  assert.equal(r.requests, 1);
  assert.equal(r.events.findLast(e => e.type === 'agent_settled').aborted, true);
  assert.equal(r.transcript.retry, null);
});

test('disconnect after a completed tool does not execute that tool again', { timeout: 20000 }, async t => {
  const r = await runCase(t, { tool: true });
  assert.equal(r.requests, 3);
  assert.equal(r.events.filter(e => e.type === 'tool_execution_start').length, 1);
  assert.equal(readFileSync(join(r.dir, 'marker.txt'), 'utf8'), 'once\n');
});

test('authentication errors are not retried or disguised as recovered', { timeout: 20000 }, async t => {
  const r = await runCase(t, { status: 401 });
  assert.equal(r.requests, 1);
  assert.equal(r.events.filter(e => e.type === 'auto_retry_start').length, 0);
  const error = displayBlocks(r.transcript).find(b => b.kind === 'error' && /invalid API key/.test(b.text));
  assert.ok(error);
  // Shown as what went wrong and what helps, not as the provider's raw response.
  assert.deepEqual([error.failure?.kind, error.failure?.status, error.failure?.fix], ['auth', 401, 'settings']);
});

test('provider failures are read out of the shapes providers and CLIs send them in', () => {
  const read = raw => { const f = providerFailure(raw); return f && [failureTitle(f), f.detail, f.fix]; };
  assert.deepEqual(read('401: {"message":"Incorrect API key provided: sk-x***.","type":"invalid_request_error","code":"invalid_api_key"}'),
    ['The provider rejected the API key (401)', 'Incorrect API key provided: sk-x***.', 'settings']);
  assert.deepEqual(read('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), ['The provider rejected the API key (401)', 'invalid x-api-key', 'settings']);
  assert.deepEqual(read('429 {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","code":"insufficient_quota"}}'),
    ['The provider account has run out of credit (429)', 'You exceeded your current quota, please check your plan and billing details.', 'settings']);
  assert.deepEqual(read('429 Too Many Requests'), ['Too many requests: the provider asked to slow down (429)', '', null]);
  assert.deepEqual(read('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), ['The provider is overloaded (529)', 'Overloaded', null]);
  assert.equal(read('400 {"error":{"message":"maximum context length is 128000 tokens","code":"context_length_exceeded"}}')[2], 'compact');
  assert.equal(read('404 {"error":{"message":"The model `x` does not exist","code":"model_not_found"}}')[0], 'The provider doesn’t offer this model (404)');
  assert.equal(read('unexpected status 401 Unauthorized: {"error":{"message":"Your token has expired."}}')[1], 'Your token has expired.');
  assert.deepEqual(read('OpenAI API error (403): {"error":{"message":"Project does not have access to model","code":"model_not_found"}}'), ['The provider refused access to this model (403)', 'Project does not have access to model', 'settings']);
  assert.deepEqual(read('connect ECONNREFUSED 127.0.0.1:8080'), ['Couldn’t reach the provider', 'connect ECONNREFUSED 127.0.0.1:8080', 'settings']);
  assert.equal(failureTitle(providerFailure('401 Unauthorized'), { cli: true }), 'The sign-in was rejected (401)');
  // Interruptions, stops and unknown text keep their own wording.
  for (const raw of ['terminated', 'This operation was aborted', 'Something odd happened', '']) assert.equal(providerFailure(raw), null, raw);
});
