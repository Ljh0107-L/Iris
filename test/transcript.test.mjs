// Pure regressions for the transcript model; also imported by e2e.mjs.
import assert from 'node:assert/strict';
import { applyEvent, collapseWork, displayBlocks, emptyTranscript, fromHistory, isAbortText, speedDisplay, usageOf } from '../app/renderer/src/transcript.js';

const message = { role: 'assistant', timestamp: 1000, content: [], usage: { input: 10000, cacheRead: 30000, output: 600, reasoning: 400 }, durationMs: 6000 };
const deliveredInBurst = { start: 100000, first: 100001, last: 100061, end: 100062, est: 600, chars: 2400 };
// A relay replaying a buffered reply in 60 ms: use the whole request duration, never the burst.
assert.equal(usageOf([{ ...message, __timing: deliveredInBurst }]).tps, 100);
assert.equal(usageOf([{ ...message, __timing: deliveredInBurst }]).speedBasis, 'request');
assert.equal(usageOf(fromHistory([message], { 1000: deliveredInBurst }).messages).tps, 100);
for (const [ms, tps] of [[500, 1200], [6000, 100]]) {
  const u = usageOf([{ ...message, durationMs: ms }]);
  assert.equal(u.tps, tps); assert.equal(u.speedBasis, 'request');
  assert.equal(speedDisplay(u).label, 'Request TPS');
}
for (const ms of [undefined, null, 0, -10, NaN, Infinity, '6000']) {
  const u = usageOf([{ ...message, durationMs: ms }]);
  assert.equal(u.tps, null, 'no request timing: nothing to calculate from');
  assert.equal(speedDisplay(u).label, 'Speed unavailable');
}
for (const output of [undefined, 0, -1, Infinity, NaN]) {
  assert.equal(usageOf([{ ...message, usage: { output } }]).tps, null);
}
assert.equal(usageOf([message, { ...message, usage: { output: 400 }, durationMs: 2000 }]).tps, 125, 'sum tokens and request durations, never average speeds');
const generated = { ...message, usage: { output: 200 }, content: [{ type: 'text', text: 'x'.repeat(400) }] };
const sourceTiming = { source: 'agent', complete: true, requestStart: 0, start: 900, first: 1000, last: 2000, end: 2500, chars: 400, deltas: 3, weight: 100, firstWeight: 10, thinkingChars: 0 };
const generatedUsage = usageOf([{ ...generated, __timing: sourceTiming }]);
assert.equal(generatedUsage.tps, 180, 'from the first token to the last, less the first chunk: not the wait before it or the trailers');
assert.equal(generatedUsage.output, 200, 'TPS never changes provider usage');
assert.equal(generatedUsage.genMs, 1000);
assert.equal(generatedUsage.genOut, 180);
assert.equal(generatedUsage.speedBasis, 'decode');
assert.equal(speedDisplay(generatedUsage).label, 'Output TPS');
assert.equal(usageOf(fromHistory([generated], { 1000: sourceTiming }).messages).tps, 180);
let t = applyEvent(emptyTranscript(), { type: 'message_start', message });
t = applyEvent(t, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'buffered output' } });
t = applyEvent(t, { type: 'message_end', message });
assert.equal(usageOf(t.messages).tps, 100);
assert.equal(usageOf(t.messages).speedBasis, 'request');

const tools = { kind: 'tools', key: 'g1', calls: [{ type: 'toolCall', id: 'a', name: 'bash', arguments: {} }] };
const thought = { kind: 'thinking', key: 'h1', hidden: true };
const original = collapseWork([tools])[0];
assert.equal(collapseWork([thought, tools])[0].key, original.key, 'final hidden reasoning must not remount an expanded group');
assert.equal(collapseWork([tools, { ...thought, key: 'k2' }])[0].key, original.key);
const text = { kind: 'text', key: 't2', text: 'Progress stays visible' };
assert.deepEqual(collapseWork([tools, text, thought]).map(b => b.kind), ['work', 'text', 'thinking']);
const user = { role: 'user', timestamp: 10, content: 'Edit a file' };
const edited = { ...message, content: [{ type: 'toolCall', id: 'edit-a', name: 'write', arguments: { path: 'a.txt', content: 'hello' } }] };
const editing = { ...emptyTranscript(), loaded: true, messages: [user, edited], tools: { 'edit-a': { status: 'done' } } };
const footer = displayBlocks(editing).find(b => b.kind === 'usage');
const inFlight = applyEvent(editing, { type: 'message_start', message: { ...message, timestamp: 2000 } });
const streamingFooter = displayBlocks(inFlight).find(b => b.kind === 'usage');
assert.deepEqual(streamingFooter.changes, footer.changes, 'file changes stay visible during the next model call');
assert.equal(streamingFooter.key, footer.key);
assert.equal(displayBlocks({ ...editing, messages: [...editing.messages, { ...user, timestamp: 3000 }] }).find(b => b.kind === 'usage').key, footer.key, 'new user prompt must not remount the old footer');
assert.equal(usageOf([{ ...message, usage: { output: 12, reasoning: 0 } }]).reasoningReported, true, 'reported zero differs from missing reasoning');
assert.equal(usageOf([{ ...message, usage: { output: 12 } }]).reasoningReported, false);
console.log('PASS  transcript regressions: speed from the first token, replay, missing timing, stable groups/footers, reasoning');

// Character heuristics cannot replace a positive provider count, even for compressible text.
const longGreeting = { ...message, timestamp: 5000, durationMs: 5886, usage: { output: 16 }, content: [{ type: 'text', text: 'x'.repeat(662) }] };
const reportedSpeed = usageOf([longGreeting]);
assert.equal(reportedSpeed.speedTokensEstimated, false);
assert.equal(reportedSpeed.output, 16); assert.equal(reportedSpeed.genOut, 16);
assert.ok(Math.abs(reportedSpeed.tps - 16 / 5.886) < 1e-9);
const receiptTiming = { start: 0, first: 1000, last: 3190, end: 3300, chars: 662, est: 185 };
assert.equal(usageOf([{ ...longGreeting, __timing: receiptTiming }]).tps, reportedSpeed.tps, 'receipt windows do not override request duration');
const hidden = { ...message, timestamp: 7000, usage: { output: 500, reasoning: 400 }, content: [{ type: 'text', text: 'x'.repeat(400) }] };
const hiddenUsage = usageOf([{ ...hidden, __timing: { ...sourceTiming, answer: { first: 1000, last: 2000, chars: 400, deltas: 3, weight: 100, firstWeight: 10 } } }]);
// Hidden reasoning was not seen being written: the answer's 100 tokens (less its first chunk) over its second.
assert.equal(hiddenUsage.tps, 90); assert.equal(hiddenUsage.genOut, 90);
assert.equal(hiddenUsage.output, 500); assert.equal(hiddenUsage.reasoning, 400);
assert.equal(hiddenUsage.speedScope, 'all'); assert.equal(speedDisplay(hiddenUsage).label, 'Output TPS');
console.log('PASS  speed provenance: authoritative counts, hidden reasoning left out with its time, no receipt-window substitute');

// A user stop can arrive as an ordinary error message; it must not look like a provider failure.
for (const text of ['This operation was aborted', 'Request was aborted', 'AbortError: The operation was aborted', 'Error: request was aborted']) {
  assert.equal(isAbortText(text), true, `abort text classified: ${text}`);
}
assert.equal(isAbortText('400: maximum context length exceeded'), false);
const interrupted = { ...message, timestamp: 8000, stopReason: 'error', errorMessage: 'This operation was aborted', content: [{ type: 'text', text: 'Partial answer' }] };
const interruptedBlocks = displayBlocks({ ...emptyTranscript(), loaded: true, messages: [{ role: 'user', content: 'do work', timestamp: 7000 }, interrupted] });
assert.equal(interruptedBlocks.some(b => b.kind === 'error'), false, 'aborted turn is not a red error');
assert.equal(interruptedBlocks.some(b => b.kind === 'notice' && b.text === 'Interrupted'), true, 'aborted turn shows a neutral interruption notice');
const failed = { ...message, timestamp: 9000, stopReason: 'error', errorMessage: 'terminated', content: [] };
assert.equal(displayBlocks({ ...emptyTranscript(), loaded: true, messages: [{ role: 'user', content: 'do work', timestamp: 8500 }, failed] }).some(b => b.kind === 'error'), true, 'real failures stay errors');
console.log('PASS  aborted turns render as interruption notices, not errors');

// Tool arguments count as model output, but tool execution time does not count as request time.
const writeCall = { ...message, timestamp: 10000, usage: { output: 100 }, content: [{ type: 'toolCall', name: 'write', arguments: { path: 'a.txt', content: 'x'.repeat(10000) } }], __timing: sourceTiming };
const writeUsage = usageOf([writeCall]);
assert.equal(writeUsage.speedTokensEstimated, false);
assert.equal(writeUsage.output, 100); assert.equal(writeUsage.genOut, 90); assert.equal(writeUsage.tps, 90);
console.log('PASS  tool-call TPS: reported output over its window, without inflating reported counts');

// A thought is still being thought only while nothing follows it in the reply being written.
{
  // Antigravity reports a whole turn as one reply: thought, tool, thought, tool. Each thought that something
  // follows is finished; shown as running, every one kept its spinner until the turn ended.
  const live = { role: 'assistant', content: [
    { type: 'thinking', thinking: 'First the command.' }, { type: 'toolCall', id: 't-1', name: 'bash', arguments: { command: 'ls' } },
    { type: 'thinking', thinking: 'Then the file.' }, { type: 'toolCall', id: 't-2', name: 'read', arguments: { path: '/work/notes.txt' } },
    { type: 'thinking', thinking: 'And now' }] };
  const t = { ...emptyTranscript(), messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: 1 }], live, tools: { 't-1': { status: 'done' }, 't-2': { status: 'done' } } };
  const thoughts = displayBlocks(t).flatMap(block => block.kind === 'work' ? block.items : [block]).filter(item => item.kind === 'thinking');
  assert.deepEqual(thoughts.map(item => [item.text, item.streaming]), [['First the command.', false], ['Then the file.', false], ['And now', true]]);
}

// A tool the person stopped was cancelled, not a failure.
{
  const ended = (isError, details) => applyEvent({ ...emptyTranscript(), tools: { a: { status: 'running' } } }, { type: 'tool_execution_end', toolCallId: 'a', isError, result: { content: [], details } }).tools.a.status;
  assert.deepEqual([ended(false, {}), ended(true, {}), ended(true, { engine: 'antigravity', interrupted: true })], ['done', 'error', 'cancelled']);
}
