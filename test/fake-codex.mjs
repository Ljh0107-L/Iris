// A stand-in for `codex app-server`: the same JSON-RPC on stdio, no account and no model.
// FAKE_CODEX_LOG receives every call; the file named by FAKE_CODEX_SIGNED_OUT, when present, means signed out.
export const FAKE_CODEX = `#!${process.execPath}
const fs = require('node:fs');
// With CODEX_HOME set it is another account: signed in only once that home has an auth.json.
const home = process.env.CODEX_HOME;
const log = process.env.FAKE_CODEX_LOG, signedIn = () => home ? fs.existsSync(home + '/auth.json') : !fs.existsSync(process.env.FAKE_CODEX_SIGNED_OUT);
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
const note = (method, params) => { fs.appendFileSync(log, JSON.stringify({ method, params }) + '\\n'); };
let cwd = '/w', turn = 0, active = null, total = { totalTokens: 1000, inputTokens: 900, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 };
const finish = status => { if (!active) return; const t = active; active = null;
  const last = { totalTokens: 60, inputTokens: 50, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 4 };
  for (const k of Object.keys(total)) total[k] += last[k];
  send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: t, tokenUsage: { total, last, modelContextWindow: 400000 } } });
  send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: t, status, error: null } } }); };
let buffer = '';
process.stdin.on('data', d => { buffer += d; let i; while ((i = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); } });
process.stdin.on('end', () => process.exit(0));
function handle(m) {
  if (m.method) note(m.method, m.params ?? m.result);
  if (m.method === undefined) { note('reply', m.result);
    if (m.result && m.result.answers) { send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: active, itemId: 'msg-3', delta: 'Answers: ' + JSON.stringify(m.result.answers) } }); finish('completed'); return; }
    if (m.result && m.result.decision) { const ok = m.result.decision.startsWith('accept');
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: active, item: { type: 'commandExecution', id: 'cmd-1', command: 'npm test', status: ok ? 'completed' : 'declined', aggregatedOutput: ok ? 'ok 12 tests' : null, exitCode: ok ? 0 : null } } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: active, itemId: 'msg-2', delta: ok ? 'Tests pass.' : 'Not run.' } }); finish('completed'); } return; }
  const reply = result => send({ id: m.id, result });
  switch (m.method) {
    case 'initialize': note('home', home ?? null); return reply({ userAgent: 'fake' });
    case 'initialized': return;
    case 'account/read': return reply(signedIn() ? { account: { type: 'chatgpt', email: 'dev@example.test', planType: 'pro', workspaceName: null }, requiresOpenaiAuth: true } : { account: null, requiresOpenaiAuth: true });
    // The browser's part is played here: the home gets its auth.json and Codex reports the sign-in done
    // (unless FAKE_CODEX_LOGIN is "hang": then nobody finishes it, as when the user never comes back).
    case 'account/login/start': reply({ type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.example.test/authorize?fixture=1' });
      if (process.env.FAKE_CODEX_LOGIN !== 'hang') setTimeout(() => { if (home) { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(home + '/auth.json', '{}'); } else fs.rmSync(process.env.FAKE_CODEX_SIGNED_OUT, { force: true });
        send({ method: 'account/login/completed', params: { loginId: 'login-1', success: true, error: null } }); }, 30);
      return;
    case 'account/login/cancel': return reply({ status: 'canceled' });
    case 'account/logout': if (home) fs.rmSync(home + '/auth.json', { force: true }); else fs.writeFileSync(process.env.FAKE_CODEX_SIGNED_OUT, '1'); return reply({});
    case 'account/rateLimits/read': return reply({ rateLimits: { primary: { usedPercent: 12.4, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: null } } });
    case 'model/list': return reply({ data: [{ id: 'gpt-a', displayName: 'GPT A', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low', serviceTiers: process.env.FAKE_CODEX_NO_ULTRAFAST ? [{ id: 'priority', name: 'Fast', description: '2x speed' }] : [{ id: 'priority', name: 'Fast', description: '2x speed' }, { id: 'ultrafast', name: 'Ultrafast', description: 'Fastest' }] }, { id: 'gpt-hidden', displayName: 'x', hidden: true, supportedReasoningEfforts: [], defaultReasoningEffort: 'low' }, { id: 'gpt-b', displayName: 'GPT B', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'medium' }] });
    // An ephemeral thread answers one question (the conversation's title) and is never saved.
    case 'thread/start': if (m.params.ephemeral) return reply({ thread: { id: 'title-' + (++turn) }, model: 'gpt-a', reasoningEffort: 'low' });
      cwd = m.params.cwd; return reply({ thread: { id: 'thread-1' }, model: 'gpt-a', reasoningEffort: 'low' });
    case 'thread/name/set': reply({}); return send({ method: 'thread/name/updated', params: { threadId: m.params.threadId, threadName: m.params.name } });
    case 'thread/resume': cwd = m.params.cwd ?? cwd; return m.params.threadId === 'thread-1' ? reply({ thread: { id: 'thread-1' }, model: 'gpt-a', reasoningEffort: 'low' }) : send({ id: m.id, error: { code: -32000, message: 'no such thread' } });
    case 'turn/start': { if (String(m.params.threadId).startsWith('title-')) { const id = m.params.threadId, t = 'turn-' + (++turn); reply({ turn: { id: t } });
        send({ method: 'item/completed', params: { threadId: id, turnId: t, item: { type: 'agentMessage', id: 'title-msg', text: JSON.stringify({ title: process.env.FAKE_CODEX_TITLE || '"Weather lookup by city."' }) } } });
        return send({ method: 'turn/completed', params: { threadId: id, turn: { id: t, status: 'completed', error: null } } }); }
      active = 'turn-' + (++turn); reply({ turn: { id: active } });
      send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: active } } });
      const text = m.params.input.find(i => i.type === 'text').text;
      if (text.includes('wait')) return; // stays active until interrupted
      // The model asks the person something (request_user_input): a server request, answered by question id.
      if (text.includes('ask')) return send({ id: 'input-1', method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: active, itemId: 'ask-1', isBlocking: true, autoResolutionMs: null,
        questions: [{ id: 'colour', header: 'Colour', question: 'Which colour do you prefer?', isOther: true, isSecret: false, options: [{ label: 'Red', description: 'Warm' }, { label: 'Green', description: 'Calm' }] },
          { id: 'why', header: 'Reason', question: 'Why?', isOther: false, isSecret: false, options: null }] } });
      if (text.includes('run')) { send({ method: 'item/started', params: { threadId: 'thread-1', turnId: active, item: { type: 'commandExecution', id: 'cmd-1', command: 'npm test', status: 'inProgress' } } });
        return send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: active, itemId: 'cmd-1', command: 'npm test', cwd: '/w', reason: 'runs the test suite' } }); }
      // Codex's own agent, as the real CLI reports one: a "started" activity naming the agent's thread, that
      // thread's own events (its brief, a command, its answer), then a "completed" activity; and a plan.
      if (text.includes('delegate')) {
        const child = 'agent-thread-1', main = (method, params) => send({ method, params: { threadId: 'thread-1', turnId: active, ...params } }), sub = (method, params) => send({ method, params: { threadId: child, turnId: 'child-turn', ...params } });
        const activity = (id, kind) => { for (const m of ['item/started', 'item/completed']) main(m, { item: { type: 'subAgentActivity', id, kind, agentThreadId: child, agentPath: '/root/parser_check', model: kind === 'started' ? 'gpt-a' : null, reasoningEffort: null } }); };
        main('turn/plan/updated', { explanation: null, plan: [{ step: 'Check the parser', status: 'inProgress' }, { step: 'Report', status: 'pending' }] });
        activity('act-1', 'started');
        sub('turn/started', { turn: { id: 'child-turn' } });
        sub('item/completed', { item: { type: 'userMessage', id: 'u-1', content: [{ type: 'text', text: 'Check the parser\\nRead src/parser.js and list the edge cases.' }] } });
        sub('item/started', { item: { type: 'commandExecution', id: 'cc-1', command: "/bin/zsh -lc 'cat src/parser.js'", commandActions: [{ type: 'read', command: 'cat src/parser.js', name: 'parser.js', path: cwd + '/src/parser.js' }], status: 'inProgress' } });
        sub('item/completed', { item: { type: 'agentMessage', id: 'cm-1', text: 'Three edge cases: empty input, nested quotes, trailing comma.' } });
        sub('turn/completed', { turn: { id: 'child-turn', status: 'completed', error: null } });
        activity('act-2', 'completed');
        activity('act-3', 'interrupted'); // closing it afterwards is reported too
        main('turn/plan/updated', { explanation: null, plan: [{ step: 'Check the parser', status: 'completed' }, { step: 'Report', status: 'inProgress' }] });
        send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: active, itemId: 'msg-d', delta: 'The agent found three edge cases.' } });
        return finish('completed');
      }
      // What a real turn looks like: commands through the login shell, a search with no match (exit 1),
      // a read, a patch over two files (one new), and a command that fails.
      if (text.includes('change')) {
        const item = (it, status = 'completed') => { send({ method: 'item/started', params: { threadId: 'thread-1', turnId: active, item: { ...it, status: 'inProgress' } } }); send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: active, item: { ...it, status } } }); };
        item({ type: 'commandExecution', id: 'c-1', command: "/bin/zsh -lc 'rg -n \\"WIND\\" src'", commandActions: [{ type: 'search', command: 'rg -n "WIND" src', query: 'WIND', path: 'src' }], aggregatedOutput: '', exitCode: 1 }, 'failed');
        item({ type: 'commandExecution', id: 'c-2', command: "/bin/zsh -lc 'sed -n '\\"'\\"'1,40p'\\"'\\"' src/app.js'", commandActions: [{ type: 'read', command: "sed -n '1,40p' src/app.js", name: 'app.js', path: cwd + '/src/app.js' }], aggregatedOutput: 'const CITIES = {};', exitCode: 0 });
        item({ type: 'fileChange', id: 'p-1', changes: [
          { path: cwd + '/src/app.js', kind: { type: 'update', move_path: null }, diff: '--- a/src/app.js\\n+++ b/src/app.js\\n@@ -1,3 +1,4 @@\\n const CITIES = {\\n   北京: 1,\\n+  广州: 3,\\n };\\n@@ -9,2 +10,2 @@\\n-old();\\n+fresh();\\n end();\\n' },
          { path: cwd + '/NOTES.md', kind: { type: 'add' }, diff: '# Notes\\nhello\\n' }] });
        item({ type: 'commandExecution', id: 'c-3', command: "/bin/bash -lc 'npm test'", commandActions: [{ type: 'unknown', command: 'npm test' }], aggregatedOutput: '1 failing', exitCode: 1 }, 'failed');
        send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: active, item: { type: 'agentMessage', id: 'msg-3', text: 'Done.' } } });
        return finish('completed');
      }
      send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-1', turnId: active, itemId: 'r-1', delta: 'thinking', summaryIndex: 0 } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: active, itemId: 'msg-1', delta: 'Hello ' } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: active, itemId: 'msg-1', delta: 'there' } });
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: active, item: { type: 'agentMessage', id: 'msg-1', text: 'Hello there' } } });
      return finish('completed'); }
    case 'turn/steer': return m.params.expectedTurnId === active ? reply({}) : send({ id: m.id, error: { code: -32000, message: 'no active turn' } });
    case 'turn/interrupt': reply({}); return finish('interrupted');
    case 'thread/compact/start': reply({}); send({ method: 'thread/compacted', params: { threadId: 'thread-1', turnId: 'compact-1' } }); return send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'compact-1', status: 'completed', error: null } } });
    default: return send({ id: m.id, error: { code: -32601, message: 'unknown ' + m.method } });
  }
}
`;
