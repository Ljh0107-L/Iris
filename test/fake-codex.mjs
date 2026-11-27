// A stand-in for `codex app-server`: the same JSON-RPC on stdio, no account and no model.
// FAKE_CODEX_LOG receives every call; the file named by FAKE_CODEX_SIGNED_OUT, when present, means signed out.
export const FAKE_CODEX = `#!${process.execPath}
const fs = require('node:fs');
// With CODEX_HOME set it is another account: signed in only once that home has an auth.json.
const home = process.env.CODEX_HOME;
const log = process.env.FAKE_CODEX_LOG, signedIn = () => home ? fs.existsSync(home + '/auth.json') : !fs.existsSync(process.env.FAKE_CODEX_SIGNED_OUT);
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
const note = (method, params) => { fs.appendFileSync(log, JSON.stringify({ method, params }) + '\\n'); };
// (A goal is kept with the thread, as Codex keeps it in its own database: it is still there when Codex starts again.)
const goalFile = log + '.goal';
const keep = () => { if (goal) fs.writeFileSync(goalFile, JSON.stringify(goal)); else fs.rmSync(goalFile, { force: true }); };
let goal = null; try { goal = JSON.parse(fs.readFileSync(goalFile, 'utf8')); } catch { /* none yet */ }
let slowStop = false, cwd = '/w', turn = 0, active = null, total = { totalTokens: 1000, inputTokens: 900, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 };
// Codex counts tokens when a model request ends: once per request of a turn.
const count = t => { const last = { totalTokens: 60, inputTokens: 50, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 4 };
  total = Object.fromEntries(Object.entries(total).map(([k, v]) => [k, v + last[k]]));
  send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: t, tokenUsage: { total, last, modelContextWindow: 400000 } } }); };
const finish = status => { if (!active) return; const t = active; active = null;
  count(t);
  send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: t, status, error: null } } });
  if (process.env.FAKE_CODEX_GOAL === 'steps' && status === 'completed' && goal && goal.status === 'active') setTimeout(() => goalTurn(), 300); };
// A turn of short steps: a thought, a command (counted as a model request when it ends), again, then the answer.
// (FAKE_CODEX_STEP_MS: how long each takes.)
const stepMs = Number(process.env.FAKE_CODEX_STEP_MS) || 250;
const steps = (t, n, answer, then) => { let i = 0;
  const say = (method, params) => send({ method, params: { threadId: 'thread-1', turnId: t, ...params } });
  const next = () => {
    if (active !== t) return;
    if (i === n) { say('item/agentMessage/delta', { itemId: 'ans-' + t, delta: answer }); say('item/completed', { item: { type: 'agentMessage', id: 'ans-' + t, text: answer } }); finish('completed'); return then && then(); }
    const k = i++, item = { type: 'commandExecution', id: 'mc-' + t + '-' + k, command: 'echo step ' + k, cwd, commandActions: [{ type: 'unknown', command: 'echo step ' + k }] };
    say('item/reasoning/summaryTextDelta', { itemId: 'mr-' + t + '-' + k, delta: 'Checking step ' + k, summaryIndex: 0 });
    setTimeout(() => { if (active !== t) return; say('item/started', { item: { ...item, status: 'inProgress', aggregatedOutput: null } });
      setTimeout(() => { if (active !== t) return; say('item/completed', { item: { ...item, status: 'completed', exitCode: 0, aggregatedOutput: 'step ' + k } }); count(t); setTimeout(next, stepMs); }, stepMs); }, stepMs / 2);
  };
  next(); };
// FAKE_CODEX_GOAL=steps: an active goal is worked on in turns Codex starts itself, three of them, then it is complete.
let goalTurns = 0;
const goalTurn = () => {
  if (active || !goal || goal.status !== 'active') return;
  active = 'turn-' + (++turn); goalTurns++;
  send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: active } } });
  const t = active, last = goalTurns >= 3;
  steps(t, 2, 'Goal step ' + goalTurns + (last ? ': done.' : '.'), () => {
    if (last) { goalTurns = 0; goal = { ...goal, status: 'complete' }; keep(); return send({ method: 'thread/goal/updated', params: { threadId: 'thread-1', turnId: t, goal } }); }
    setTimeout(goalTurn, 300);
  }); };
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
    case 'thread/resume': cwd = m.params.cwd ?? cwd;
      return m.params.threadId === 'thread-1' ? reply({ thread: { id: 'thread-1' }, model: 'gpt-a', reasoningEffort: 'low' }) : send({ id: m.id, error: { code: -32000, message: 'no such thread' } });
    case 'turn/start': { if (String(m.params.threadId).startsWith('title-')) { const id = m.params.threadId, t = 'turn-' + (++turn); reply({ turn: { id: t } });
        send({ method: 'item/completed', params: { threadId: id, turnId: t, item: { type: 'agentMessage', id: 'title-msg', text: JSON.stringify({ title: process.env.FAKE_CODEX_TITLE || '"Weather lookup by city."' }) } } });
        return send({ method: 'turn/completed', params: { threadId: id, turn: { id: t, status: 'completed', error: null } } }); }
      active = 'turn-' + (++turn); reply({ turn: { id: active } });
      send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: active } } });
      const text = m.params.input.find(i => i.type === 'text').text;
      slowStop = text.includes('slow stop');
      // A command left running in the background (a background terminal, as the real CLI reports one): it starts,
      // the turn ends, and the command ends a while later, with its output.
      if (text.includes('in the background')) {
        const t = active, item = { type: 'commandExecution', id: 'bg-cmd', command: "/bin/zsh -lc 'sleep 1; echo ticked'", cwd, processId: '4242', source: 'unifiedExecStartup', commandActions: [{ type: 'unknown', command: 'sleep 1; echo ticked' }] };
        send({ method: 'item/started', params: { threadId: 'thread-1', turnId: t, item: { ...item, status: 'inProgress', aggregatedOutput: null } } });
        send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: t, item: { type: 'agentMessage', id: 'bg-msg', text: 'started' } } });
        finish('completed');
        setTimeout(() => {
          send({ method: 'item/commandExecution/outputDelta', params: { threadId: 'thread-1', turnId: t, itemId: 'bg-cmd', delta: 'ticked' + String.fromCharCode(10) } });
          send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: t, item: { ...item, status: 'completed', exitCode: 0, aggregatedOutput: 'ticked' + String.fromCharCode(10) } } });
        }, 300);
        return;
      }
      // A command that runs until the turn is stopped.
      if (text.includes('long command')) {
        send({ method: 'item/started', params: { threadId: 'thread-1', turnId: active, item: { type: 'commandExecution', id: 'long-cmd', command: "/bin/zsh -lc 'sleep 600'", cwd, processId: '4243', status: 'inProgress', aggregatedOutput: null, commandActions: [{ type: 'unknown', command: 'sleep 600' }] } } });
        return;
      }
      // A visual (Iris's MCP tool): the page is the file FAKE_CODEX_VISUAL_FILE (read each time), FAKE_CODEX_VISUAL, or a small one of its own.
      if (text.includes('show a visual')) {
        // (FAKE_CODEX_VISUAL_ARGS_FILE, read each time too: more of the call's arguments, such as its id or height.)
        const more = process.env.FAKE_CODEX_VISUAL_ARGS_FILE && fs.existsSync(process.env.FAKE_CODEX_VISUAL_ARGS_FILE) ? JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_VISUAL_ARGS_FILE, 'utf8')) : {};
        const item = { type: 'mcpToolCall', id: 'vis-' + turn, server: 'iris', tool: 'show_visual', arguments: { title: 'Polygon and circle', html: (process.env.FAKE_CODEX_VISUAL_FILE ? fs.readFileSync(process.env.FAKE_CODEX_VISUAL_FILE, 'utf8') : process.env.FAKE_CODEX_VISUAL) || '<div style="padding:24px;font:16px sans-serif;color:#ddd">A small page<div style="height:180px;background:#2a5"></div></div>', ...more } };
        send({ method: 'item/started', params: { threadId: 'thread-1', turnId: active, item: { ...item, status: 'inProgress' } } });
        send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: active, item: { ...item, status: 'completed', result: { content: [{ type: 'text', text: 'Shown.' }] } } } });
        send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: active, item: { type: 'agentMessage', id: 'vis-msg-' + turn, text: 'Here it is.' } } });
        return finish('completed');
      }
      if (text.includes('wait')) return; // stays active until interrupted
      // Short commands one after another, a thought before each, as Codex works through a task.
      if (text.includes('many commands')) return steps(active, 6, 'All six ran.');
      // A command that takes a while: the model's own time in the turn is the turn's length less this.
      // (As in the real CLI: the command starts while the request that asked for it is still being answered,
      // the request is counted when it ends, and the next request begins when the command is done.)
      if (text.includes('slow command')) { send({ method: 'item/started', params: { threadId: 'thread-1', turnId: active, item: { type: 'commandExecution', id: 'cmd-slow', command: 'sleep 1', status: 'inProgress' } } });
        setTimeout(() => count(active), 20);
        return setTimeout(() => { send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: active, item: { type: 'commandExecution', id: 'cmd-slow', command: 'sleep 1', status: 'completed', aggregatedOutput: '', exitCode: 0 } } });
          send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: active, itemId: 'msg-slow', delta: 'Slept.' } }); finish('completed'); }, 400); }
      // A model that takes a while to begin writing: the reasoning item begins when it does, the answer follows.
      if (text.includes('slow start')) return setTimeout(() => { send({ method: 'item/started', params: { threadId: 'thread-1', turnId: active, item: { type: 'reasoning', id: 'rs-slow', summary: [], content: [] } } });
        setTimeout(() => { send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: active, itemId: 'msg-slow', delta: 'Written.' } }); finish('completed'); }, 120); }, 150);
      // A question asked without stopping (request_user_input_async): a message carrying the questions, and the
      // turn goes on (here: until it is interrupted). The answer is the next message the person sends.
      if (text.includes('question later')) {
        const say = (method, params) => send({ method, params: { threadId: 'thread-1', turnId: active, ...params } });
        const full = ['Is a large job allocated?', '- Use 64 cards', '- I will provide one'].join(String.fromCharCode(10));
        say('item/started', { item: { type: 'agentMessage', id: 'q-async', text: '', phase: 'final_answer', delivery: 'async', questions: null } });
        say('item/agentMessage/delta', { itemId: 'q-async', delta: full });
        say('item/completed', { item: { type: 'agentMessage', id: 'q-async', text: full, phase: 'final_answer', delivery: 'async', questions: [{ title: 'Is a large job allocated?', options: ['Use 64 cards', 'I will provide one'] }] } });
        return say('item/started', { item: { type: 'commandExecution', id: 'cmd-on', command: 'make check', status: 'inProgress' } });
      }
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
        sub('item/started', { item: { type: 'reasoning', id: 'child-reasoning', summary: [], content: [] } }); // (no step of its own: the adapter once died on it)
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
    // Goals, as Codex keeps them: one per thread. An active goal on an idle thread is worked on without being
    // asked (a turn Codex starts itself), unless FAKE_CODEX_GOAL is "idle"; "long" keeps that turn going.
    // (FAKE_CODEX_GOAL_GET_MS: the answer is late, as a slow machine's can be; it says the goal as it was asked.)
    case 'thread/goal/get': { const was = goal; return process.env.FAKE_CODEX_GOAL_GET_MS ? setTimeout(() => reply({ goal: was }), Number(process.env.FAKE_CODEX_GOAL_GET_MS)) : reply({ goal }); }
    case 'thread/goal/clear': goal = null; keep(); reply({ cleared: true }); return send({ method: 'thread/goal/cleared', params: { threadId: 'thread-1' } });
    case 'thread/goal/set': {
      if (!goal && !m.params.objective) return send({ id: m.id, error: { code: -32600, message: 'thread has no goal' } });
      goal = { threadId: 'thread-1', objective: m.params.objective ?? goal.objective, status: m.params.status ?? goal?.status ?? 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1764000000, updatedAt: 1764000000 };
      keep(); reply({ goal });
      send({ method: 'thread/goal/updated', params: { threadId: 'thread-1', turnId: null, goal } });
      if (process.env.FAKE_CODEX_GOAL === 'steps') { if (goal.status === 'active') setTimeout(goalTurn, 20); return; }
      if (goal.status === 'active' && !active && process.env.FAKE_CODEX_GOAL !== 'idle') setTimeout(() => {
        if (active || !goal || goal.status !== 'active') return;
        active = 'turn-' + (++turn);
        send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: active } } });
        send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: active, itemId: 'goal-msg-' + turn, delta: 'Working toward: ' + goal.objective } });
        if (process.env.FAKE_CODEX_GOAL === 'long') return;
        goal = { ...goal, status: 'complete' }; keep();
        send({ method: 'thread/goal/updated', params: { threadId: 'thread-1', turnId: active, goal } });
        finish('completed');
      }, 20);
      return;
    }
    case 'thread/revert': return reply({ thread: { id: m.params.threadId }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
    case 'turn/steer': return m.params.expectedTurnId === active ? reply({}) : send({ id: m.id, error: { code: -32000, message: 'no active turn' } });
    // A turn whose commands take a while to stop ('slow stop'): Codex confirms the stop seconds later.
    case 'turn/interrupt': reply({}); return slowStop ? setTimeout(() => finish('interrupted'), 1500) : finish('interrupted');
    case 'thread/compact/start': reply({}); send({ method: 'thread/compacted', params: { threadId: 'thread-1', turnId: 'compact-1' } }); return send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'compact-1', status: 'completed', error: null } } });
    default: return send({ id: m.id, error: { code: -32601, message: 'unknown ' + m.method } });
  }
}
`;
