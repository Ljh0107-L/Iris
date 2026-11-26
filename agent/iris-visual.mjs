#!/usr/bin/env node
// Iris's visual tool, as an MCP server (stdio, newline-delimited JSON-RPC) every agent is given: Iris's own, Codex,
// Claude Code, Cursor and Antigravity. `show_visual` takes a self-contained HTML page (canvas, SVG, CSS or JS
// animation) and Iris shows it in the conversation, running in a sandbox. The page is the tool call's own
// argument: this server keeps nothing, and only checks it and says it was shown.
// Runs on remote hosts with plain Node: no dependencies, no imports from app/.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export const VISUAL_TOOL = 'show_visual';
export const VISUAL_MAX_BYTES = 400 * 1024;
export const VISUAL_LIBRARIES = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com'];

export const VISUAL_DESCRIPTION = [
  'Show the person a visual in Iris: a self-contained HTML page (canvas, SVG, CSS or JavaScript animation, an interactive diagram or simulation) rendered right in the conversation.',
  'Use it when a picture, an animation or something to play with explains better than words: how an algorithm steps through data, a pipeline or protocol in motion, a data structure changing, a geometric or physical idea, a chart of numbers you computed.',
  'Write one complete page: inline <style> and <script>. Scripts and styles may load from ' + VISUAL_LIBRARIES.join(', ') + ' (for example three.js, d3, p5, chart.js); nothing else on the network is reachable, and the page cannot read files.',
  'It is shown about 720 px wide, in the light or dark theme (use prefers-color-scheme, or a background of your own). Give height for its natural height in pixels. Label what is shown; add controls (play/pause, step, sliders) where they help.',
  'To keep one visual current as work goes on (a progress panel, a chart of results so far), give it an id and call again with the same id: the newest version is the one shown, and earlier ones fold away.',
  'The page can hand the person a message to send you: iris.send(text) puts text in their message box (they send it). Use it for buttons such as "Run again with these settings".',
  'The person sees the page; describe what it shows in your reply only briefly.',
].join(' ');

// How an agent on this machine starts this server: with the Node that runs Iris's adapter (Iris's own runtime on
// this Mac, which runs as Node only when told to), from this file beside the adapter.
export function visualServer(runtime = process) {
  return { name: 'iris', command: runtime.execPath, args: [fileURLToPath(import.meta.url)],
    env: runtime.env?.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
}

export const VISUAL_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A short name for the visual, shown above it.' },
    html: { type: 'string', description: 'The complete HTML page.' },
    height: { type: 'number', description: 'Its natural height in pixels (160–900). Default 420.' },
    id: { type: 'string', description: 'Optional. The same id again replaces the visual shown with it before.' },
  },
  required: ['title', 'html'],
  additionalProperties: false,
};

// What the tool answers: shown, or why not (the model can fix the page and call again).
export function callVisual(args) {
  const title = typeof args?.title === 'string' ? args.title.trim() : '';
  const html = typeof args?.html === 'string' ? args.html : '';
  if (!html.trim()) return { isError: true, content: [{ type: 'text', text: 'Give the page in html.' }] };
  const bytes = Buffer.byteLength(html);
  if (bytes > VISUAL_MAX_BYTES) return { isError: true, content: [{ type: 'text', text: `The page is ${Math.round(bytes / 1024)} KB; keep it under ${VISUAL_MAX_BYTES / 1024} KB (load large libraries from a CDN instead of inlining them).` }] };
  return { content: [{ type: 'text', text: `Shown to the person in Iris${title ? ` as "${title.slice(0, 120)}"` : ''}.` }] };
}

export function serve({ input = process.stdin, output = process.stdout, version = '0', onEnd } = {}) {
  const send = message => output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const answer = (id, result) => send({ id, result });
  const fail = (id, code, message) => send({ id, error: { code, message } });
  let buffer = '';
  input.setEncoding?.('utf8');
  input.on('data', chunk => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message?.id == null) continue; // notifications (initialized, cancelled) need no answer
      const { id, method, params } = message;
      switch (method) {
        case 'initialize': answer(id, { protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} }, serverInfo: { name: 'iris', title: 'Iris', version },
          instructions: 'show_visual shows the person an HTML visual (animation, diagram, interactive explanation) in the conversation.' }); break;
        case 'ping': answer(id, {}); break;
        case 'tools/list': answer(id, { tools: [{ name: VISUAL_TOOL, title: 'Show a visual', description: VISUAL_DESCRIPTION, inputSchema: VISUAL_SCHEMA }] }); break;
        case 'tools/call':
          if (params?.name !== VISUAL_TOOL) fail(id, -32602, `Unknown tool: ${params?.name}`);
          else answer(id, callVisual(params.arguments));
          break;
        default: fail(id, -32601, `Method not found: ${method}`);
      }
    }
  });
  input.on('end', () => onEnd?.());
}

let isMain = false;
try { isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { /* imported */ }
if (isMain) serve({ version: process.argv[2] ?? '0', onEnd: () => process.exit(0) });
