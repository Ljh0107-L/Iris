// A model chosen while Pi waits to try a failed request again: the wait is stopped and the request made again at
// once on the new model (session manager #retryNow: abort_retry, then the bridge's /iris-retry-now).
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { AgentSession } from '../core/agent-session.mjs';
import { localTransport } from '../core/transports.mjs';

test('switching models during a retry wait asks again at once, on the new model', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pdr-'));
  const agentDir = join(dir, 'agent'); mkdirSync(agentDir);
  // A long wait between attempts: the test fails if the new model is only used once it is over.
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: true, maxRetries: 5, baseDelayMs: 60000 } }));
  const models = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    models.push(payload.model);
    if (payload.model === 'down') { res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'internal error', type: 'server_error' } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const item = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Answer from up', annotations: [] }] };
    send({ type: 'response.created', response: { id: 'r1', status: 'in_progress' } });
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
    send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Answer from up' });
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { id: 'r1', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } });
    res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const session = new AgentSession({ id: 'retry-switch', boot: { providers: [{ id: 'mock', api: 'openai-responses', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test-only', models: [{ id: 'down' }, { id: 'up' }] }] },
    transport: localTransport({ node: process.execPath, piCli: resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
      cwd: dir, agentDir, retryPath: resolve('agent/iris-retry.mjs'), extensions: [resolve('agent/iris-bridge.js')] }) });
  t.after(async () => { await session.stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, { recursive: true, force: true }); });
  const events = [];
  session.on('event', event => events.push(event));
  await session.start(); await session.setModel('mock', 'down');
  const waiting = new Promise(resolve => session.on('event', event => { if (event.type === 'auto_retry_start') resolve(); }));
  await session.prompt('hello');
  await waiting;
  const started = Date.now();
  await session.setModel('mock', 'up');
  const settled = session.nextSettled(15000);
  await session.request('abort_retry');
  await settled;
  const answered = new Promise(resolve => session.on('event', event => { if (event.type === 'message_end' && event.message?.role === 'assistant' && event.message.stopReason !== 'error') resolve(event.message); }));
  await session.prompt('/iris-retry-now');
  const reply = await answered;
  assert.ok(Date.now() - started < 10000, 'not after the minute-long wait');
  assert.equal(reply.model, 'up');
  assert.deepEqual(models, ['down', 'up']);
  const { messages } = await session.request('get_messages');
  assert.equal(messages.filter(m => m.role === 'user').length, 1, 'no new message from the person');
});
