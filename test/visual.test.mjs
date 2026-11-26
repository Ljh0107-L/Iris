// Iris's visual tool: the MCP server every agent is given (agent/iris-visual.mjs), and how the conversation
// knows a visual from other steps.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { VISUAL_MAX_BYTES, VISUAL_TOOL, callVisual, serve, visualServer } from '../agent/iris-visual.mjs';
import { displayBlocks, isVisualCall } from '../app/renderer/src/transcript.js';

function server() {
  const input = new PassThrough(), output = new PassThrough();
  serve({ input, output, version: '9.9.9' });
  let buffer = '';
  const answers = new Map(), waiting = new Map();
  output.on('data', chunk => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
      answers.set(message.id, message); waiting.get(message.id)?.(message);
    }
  });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return { ask, notify: method => input.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n') };
}

test('it speaks MCP: it introduces itself, lists show_visual, and says a page was shown', async () => {
  const s = server();
  const hello = await s.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex' } });
  assert.deepEqual([hello.result.protocolVersion, hello.result.serverInfo.name, hello.result.capabilities], ['2025-06-18', 'iris', { tools: {} }]);
  s.notify('notifications/initialized'); // no answer to a notification
  const { result: { tools } } = await s.ask('tools/list');
  assert.deepEqual(tools.map(t => t.name), [VISUAL_TOOL]);
  assert.deepEqual(tools[0].inputSchema.required, ['title', 'html']);
  assert.match(tools[0].description, /cdnjs\.cloudflare\.com/, 'the model is told which libraries it can load');
  const shown = await s.ask('tools/call', { name: VISUAL_TOOL, arguments: { title: 'Bubble sort', html: '<canvas></canvas><script>1</script>' } });
  assert.equal(shown.result.isError, undefined);
  assert.match(shown.result.content[0].text, /Shown to the person in Iris as "Bubble sort"/);
  assert.equal((await s.ask('tools/call', { name: 'other' })).error.code, -32602);
  assert.equal((await s.ask('resources/list')).error.code, -32601);
  assert.deepEqual((await s.ask('ping')).result, {});
});

test('a page that cannot be shown says why, so the model can try again', () => {
  assert.equal(callVisual({ title: 'x', html: '  ' }).isError, true);
  const big = callVisual({ title: 'x', html: 'a'.repeat(VISUAL_MAX_BYTES + 1) });
  assert.equal(big.isError, true);
  assert.match(big.content[0].text, /keep it under 400 KB/);
});

test('each agent starts it with the Node that runs Iris’s adapter, as Node', () => {
  assert.deepEqual(visualServer({ execPath: '/opt/node', env: {} }).env, {});
  const local = visualServer({ execPath: '/Applications/Iris.app/Contents/MacOS/Iris', env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(local.name, 'iris');
  assert.equal(local.command, '/Applications/Iris.app/Contents/MacOS/Iris');
  assert.deepEqual(local.env, { ELECTRON_RUN_AS_NODE: '1' }, 'Iris’s own runtime runs as Node only when told to');
  assert.match(local.args[0], /agent\/iris-visual\.mjs$/);
});

test('a visual is a card of its own in the conversation, whatever the agent calls the tool', () => {
  for (const name of ['mcp__iris__show_visual', 'show_visual', 'iris-show_visual']) assert.ok(isVisualCall({ name }), name);
  assert.ok(!isVisualCall({ name: 'show_visuals' }));
  const message = { role: 'assistant', content: [{ type: 'text', text: 'Here it is.' }, { type: 'toolCall', id: 'v1', name: 'mcp__iris__show_visual', arguments: { title: 'Sort', html: '<p>x</p>' } },
    { type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: 'ls' } }] };
  const blocks = displayBlocks({ messages: [message], live: null, tools: {} });
  assert.deepEqual(blocks.filter(b => b.kind === 'visual').map(b => b.call.id), ['v1']);
  assert.ok(!blocks.some(b => (b.calls ?? b.items ?? []).some(c => c.id === 'v1' || c.calls?.some(x => x.id === 'v1'))), 'not folded among the steps');
});

test('a visual shown again under the same id folds away its earlier versions; others stay as they are', () => {
  const call = (id, args) => ({ type: 'toolCall', id, name: 'mcp__iris__show_visual', arguments: { title: 'Progress', html: '<p>x</p>', ...args } });
  const messages = [{ role: 'assistant', content: [call('v1', { id: 'progress' }), { type: 'text', text: 'Working.' }, call('v2', { id: 'other' }), { type: 'text', text: 'More.' }, call('v3', { id: 'progress' }), call('v4', {})] }];
  const visuals = displayBlocks({ messages, live: null, tools: {} }).filter(b => b.kind === 'visual');
  assert.deepEqual(visuals.map(b => [b.call.id, !!b.superseded]), [['v1', true], ['v2', false], ['v3', false], ['v4', false]]);
});

test('the tool tells the model about ids and iris.send', async () => {
  const { VISUAL_DESCRIPTION, VISUAL_SCHEMA } = await import('../agent/iris-visual.mjs');
  assert.match(VISUAL_DESCRIPTION, /give it an id and call again with the same id/);
  assert.match(VISUAL_DESCRIPTION, /iris\.send\(text\)/);
  assert.equal(VISUAL_SCHEMA.properties.id.type, 'string');
});
