// Pure regressions: no app, model request or live relay required.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEvent, emptyTranscript, estimateTokens, fromHistory, requestReplies, speedDisplay, speedReply, usageOf } from '../app/renderer/src/transcript.js';

const timing = overrides => ({ source: 'agent', complete: true, requestStart: 0, start: 800, first: 1000, last: 2000, end: 2500,
  chars: 400, deltas: 3, weight: 100, firstWeight: 10, thinkingChars: 0, ...overrides });
const message = overrides => ({ role: 'assistant', timestamp: 0, provider: 'example', model: 'example-model', stopReason: 'stop',
  content: [{ type: 'text', text: 'x'.repeat(400) }], usage: { input: 200, cacheRead: 50, cacheWrite: 10, output: 100, reasoning: 0, cost: { total: 0.2 } },
  __timing: timing(), ...overrides });
const usage = overrides => usageOf([message(overrides)]);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? 'value'}: ${actual} is not ${expected}`);
const unavailable = u => {
  assert.equal(u.tps, null); assert.equal(u.genMs, 0); assert.equal(u.genOut, 0);
  assert.equal(u.speedBasis, null); assert.equal(u.speedScope, null);
  assert.equal(speedDisplay(u).value, '—'); assert.equal(speedDisplay(u).label, 'Speed unavailable');
};

test('speed is what was written after the first chunk, over the time from the first token to the last', () => {
  const m = message(), before = structuredClone(m), u = usageOf([m]);
  // 100 tokens, 10 of them in the first chunk at 1.0 s, the last at 2.0 s: 90 tokens in a second. The 0.8 s before
  // the stream, the 0.2 s before its first token and the 0.5 s of trailers are not the model's speed.
  assert.equal(u.tps, 90); assert.equal(u.genOut, 90); assert.equal(u.genMs, 1000);
  assert.equal(u.speedBasis, 'decode'); assert.equal(u.speedScope, 'all');
  assert.equal(u.speedEstimated, true); assert.equal(u.speedTokensEstimated, false); assert.equal(u.speedTimeEstimated, false);
  assert.equal(u.output, 100); assert.equal(u.prompt, 260); assert.equal(u.cacheHit, 50 / 260);
  const display = speedDisplay(u);
  assert.equal(display.value, '~90.0'); assert.equal(display.label, 'Output TPS');
  assert.match(display.title, /from the first token to the last/);
  assert.match(display.title, /wait for the first token \(TTFT\) is not counted, nor tool execution or gaps between requests/);
  assert.deepEqual(m, before);
});
test('a longer wait for the first token and a delayed completion do not change the speed', () => {
  for (const ttft of [1000, 600000]) for (const tail of [100, 600000]) {
    for (const firstWeight of [1, 10, 99, undefined]) {
      const end = ttft + 1000 + tail;
      const u = usage({ durationMs: 1, __timing: timing({ first: ttft, last: ttft + 1000, end, firstWeight }) });
      near(u.tps, 100 - (firstWeight ?? 0)); assert.equal(u.genMs, 1000); near(u.genOut, 100 - (firstWeight ?? 0));
    }
  }
});
test('a reply that gives no window to time (one chunk, a burst, no deltas) is timed as a whole request, and says so', () => {
  for (const patch of [{ first: 2000, last: 2000, deltas: 1 }, { first: null, last: null, deltas: 0 }, { first: 2015, last: 2031, chars: 13016, deltas: 110 }]) {
    const u = usage({ __timing: timing(patch) });
    assert.equal(u.genOut, 100); assert.equal(u.genMs, 2500); assert.equal(u.tps, 40); assert.equal(u.speedBasis, 'request');
    assert.equal(speedDisplay(u).label, 'Request TPS');
    assert.match(speedDisplay(u).title, /no first-token time to measure from, so the wait for the first token is included/);
  }
  // Metadata that is missing or beside the point does not change the window.
  for (const patch of [{ answer: { interrupted: true } }, { genStart: 2200 }, { thinkingChars: 0 }]) {
    const u = usage({ __timing: timing(patch) });
    assert.equal(u.genOut, 90); assert.equal(u.genMs, 1000); assert.equal(u.tps, 90);
  }
  assert.equal(usage({ __timing: timing({ weight: undefined, firstWeight: undefined }) }).tps, 100, 'an adapter that does not weigh chunks: all of the output');
  assert.equal(usage({ __timing: timing({ first: 1000, last: undefined, end: 2000, weight: undefined, firstWeight: undefined, deltas: undefined }) }).tps, 100, 'Claude Code: the first token and the end');
  assert.equal(usage({ __timing: timing({ first: 1000, last: 1020 }) }).tps, 4500, 'valid high TPS is not clamped');
});
test('explicit per-call duration is usable without source timing and never uses receipt windows', () => {
  for (const durationMs of [1, 500, 3000, 900000]) {
    for (const __timing of [undefined, timing({ source: 'renderer' }), timing({ source: undefined }), timing({ complete: false })]) {
      const u = usage({ durationMs, __timing });
      assert.equal(u.tps, 100 / (durationMs / 1000)); assert.equal(u.speedBasis, 'request');
    }
  }
  for (const source of [undefined, 'renderer', 'unknown']) unavailable(usage({ __timing: timing({ source }) }));
  for (const durationMs of [undefined, null, 0, -1, NaN, Infinity, '3000']) unavailable(usage({ durationMs, __timing: undefined }));
});

test('older source history without a window to time uses its pre-request message timestamp, never message_start alone', () => {
  for (const source of ['agent', 'relay']) {
    const old = timing({ source, requestStart: undefined, start: 2000, first: 2100, last: 2100, deltas: 1, end: 2500 });
    const u = usage({ __timing: old });
    assert.equal(u.tps, 40); assert.equal(u.speedTimeEstimated, true);
    assert.equal(speedDisplay(u).label, 'Request TPS (estimated)');
    assert.match(speedDisplay(u).title, /approximate request start/);
    for (const timestamp of [undefined, null, -1, NaN, Infinity, '0', 3000]) unavailable(usage({ timestamp, __timing: old }));
    // With a window, the same history is timed from its first token like any other.
    assert.equal(usage({ __timing: { ...old, last: 2200, deltas: 3 } }).tps, 900);
  }
});
test('malformed timing cannot produce negative or fabricated speed', () => {
  for (const patch of [{ end: 100 }, { end: NaN }, { start: null }, { start: -1 }, { complete: false }, { first: 100 }, { last: 9000, deltas: 1 }]) {
    unavailable(usage({ timestamp: undefined, __timing: timing({ requestStart: -1, ...patch }) }));
  }
  // The request's start is not needed for a window; without a window, a malformed one gives nothing.
  for (const requestStart of [-1, 900, '0', Infinity]) {
    assert.equal(usage({ timestamp: undefined, __timing: timing({ requestStart }) }).tps, 90);
    unavailable(usage({ timestamp: undefined, __timing: timing({ requestStart, deltas: 1 }) }));
  }
  unavailable(usage({ __timing: timing({ start: 0, end: 0 }) }));
});
test('slow and fast relay replay and history restore preserve the speed measured at the source', t => {
  let now = 100000; t.mock.method(Date, 'now', () => now);
  for (const delay of [1, 1000, 60000]) {
    const final = message();
    let transcript = applyEvent(emptyTranscript(), { type: 'message_start', message: final });
    now += delay;
    transcript = applyEvent(transcript, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x'.repeat(400) } });
    now += delay;
    transcript = applyEvent(transcript, { type: 'message_end', message: final });
    assert.deepEqual(transcript.messages[0].__timing, final.__timing);
    assert.equal(usageOf(transcript.messages).tps, 90);
    const persisted = JSON.parse(JSON.stringify(final));
    assert.equal(usageOf(fromHistory([persisted], { 0: timing({ source: 'renderer' }) }).messages).tps, 90);
    assert.equal(usageOf(fromHistory([message({ __timing: undefined })], { 0: final.__timing }).messages).tps, 90);
  }
});

test('mid-reply attach uses supplied duration, never a manufactured receipt window', () => {
  let transcript = applyEvent(emptyTranscript(), { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' } });
  transcript = applyEvent(transcript, { type: 'message_end', message: message({ __timing: undefined, durationMs: 3000 }) });
  assert.equal(transcript.messages[0].__timing, undefined);
  assert.equal(usageOf(transcript.messages).tps, 100 / 3);
});

test('reasoning the provider kept to itself is left out: the answer alone is timed', () => {
  const answer = { first: 1000, last: 2000, chars: 400, deltas: 3, weight: 100, firstWeight: 10 };
  for (const block of [undefined, { type: 'thinking', thinking: 'A summary' }, { type: 'thinking', redacted: true, thinkingSignature: 'opaque' }]) {
    for (const reasoning of [400, undefined]) {
      const u = usage({ usage: { output: 500, reasoning }, __usageProvenance: { thinking: 'summary' }, __timing: timing({ answer }),
        content: [...(block ? [block] : []), { type: 'text', text: 'x'.repeat(400) }] });
      // 100 answer tokens (as counted, or as streamed when reasoning is not counted apart), less the first chunk.
      near(u.tps, 90); near(u.genOut, 90); assert.equal(u.genMs, 1000);
      assert.equal(u.speedScope, 'all'); assert.equal(u.speedTokensEstimated, reasoning === undefined);
      assert.equal(u.output, 500); assert.equal(u.reasoning, reasoning ?? 0);
      assert.equal(speedDisplay(u).label, reasoning === undefined ? 'Output TPS (estimated)' : 'Output TPS');
    }
  }
  // Hidden reasoning whose start the provider announced: everything, from that moment.
  const announced = usage({ usage: { output: 500, reasoning: 400 }, __timing: timing({ answer, genStart: 900 }) });
  near(announced.tps, 500 / 1.1); assert.equal(announced.genMs, 1100);
  // Hidden reasoning and no answer that could be timed: the request as a whole.
  const whole = usage({ usage: { output: 500, reasoning: 400 }, __timing: timing({ answer: { ...answer, interrupted: true } }) });
  assert.equal(whole.tps, 200); assert.equal(whole.speedBasis, 'request');
  // Reasoning streamed as it was written is output like the rest.
  const streamed = usage({ usage: { output: 500, reasoning: 400 }, __timing: timing({ answer, thinkingChars: 1600 }) });
  assert.equal(streamed.tps, 450);
});
test('placeholder and missing counts estimate available output without rewriting usage', () => {
  for (const content of [[{ type: 'text', text: 'x'.repeat(400) }], [{ type: 'thinking', thinking: 'x'.repeat(400) }],
    [{ type: 'toolCall', name: 'write', arguments: { path: 'a.txt', content: 'x'.repeat(400) } }]]) {
    for (const output of [undefined, null, 0, -1, NaN, Infinity, '100', 1]) {
      const m = message({ content, usage: { output, input: 12, cost: { total: 0.02 } } }), before = structuredClone(m), u = usageOf([m]);
      assert.equal(u.output, output === 1 ? 1 : 0); assert.equal(u.input, 12); assert.equal(u.cost, 0.02);
      assert.equal(u.speedTokensEstimated, true); assert.ok(u.genOut >= 90); assert.equal(u.tps, u.genOut);
      assert.equal(speedDisplay(u).label, 'Output TPS (estimated)');
      assert.match(speedDisplay(u).title, /Provider token totals remain unchanged/);
      assert.deepEqual(m, before);
    }
  }
  unavailable(usage({ usage: undefined })); unavailable(usage({ usage: { output: 0 }, content: [] }));
  const reasoning = usage({ usage: { output: 1, reasoning: 80 }, content: [
    { type: 'thinking', thinking: 'x'.repeat(320) }, { type: 'text', text: 'x'.repeat(80) }],
  });
  assert.equal(reasoning.genOut, 100, '20 estimated answer + 80 reasoning, not counted twice');
  const text = '中文测试'.repeat(100);
  assert.equal(estimateTokens(text), 400);
  near(usage({ usage: { output: 1 }, content: [{ type: 'text', text }] }).genOut, 360, 'all of it, less the first chunk');
});

test('genuine positive counts are used as reported', () => {
  assert.equal(usage({ usage: { output: 1 }, content: [{ type: 'text', text: 'OK' }] }).genOut, 1);
  for (const output of [2, 16, 100]) {
    const u = usage({ usage: { output }, content: [{ type: 'toolCall', name: 'write', arguments: { content: 'x'.repeat(10000) } }] });
    near(u.genOut, output * 0.9); assert.equal(u.speedTokensEstimated, false);
  }
});

test('aggregate speed sums matching call output and windows, excluding tools, gaps and untimed calls', () => {
  const first = message(), second = message({ timestamp: 600000, usage: { output: 500 },
    __timing: timing({ requestStart: 600000, start: 601000, first: 602000, last: 603000, end: 607500 }) });
  const tool = { role: 'toolResult', toolName: 'bash', durationMs: 500000 };
  const untimed = message({ __timing: undefined });
  const u = usageOf([first, tool, second, untimed]);
  assert.equal(u.genMs, 2000); near(u.genOut, 540); near(u.tps, 270);
  assert.equal(u.output, 700); assert.equal(u.speedPartial, true); assert.equal(u.speedScope, 'all');
  assert.match(speedDisplay(u).title, /Only calls with usable timing/);
  near(usageOf([second, first]).tps, 270);
  assert.equal(usageOf([first, second]).speedPartial, false);
  // A call that could only be timed as a whole is not mixed with calls timed from their first token.
  const whole = message({ timestamp: 2, __timing: timing({ first: 1000, last: 1000, deltas: 1 }) });
  const mixed = usageOf([first, whole]);
  assert.equal(mixed.tps, 90); assert.equal(mixed.speedBasis, 'decode'); assert.equal(mixed.speedPartial, true);
  assert.equal(usageOf([whole]).tps, 40);
  const child = { role: 'toolResult', toolName: 'subagent', usage: { input: 10, output: 900, reasoning: 800 }, details: { results: [{ turns: 2 }] }, durationMs: 1 };
  const withChild = usageOf([first, child]);
  assert.equal(withChild.output, 1000); assert.equal(withChild.calls, 3); assert.equal(withChild.tps, 90);
});
test('unfinished, failed and aborted calls keep usage but do not claim final request TPS', () => {
  for (const stopReason of ['pending', 'deferred', 'error', 'aborted']) {
    const u = usage({ stopReason }); assert.equal(u.output, 100); unavailable(u);
  }
  unavailable(usage({ errorMessage: 'This operation was aborted' }));
});

test('a reply too short to time from its first token leaves the last one that could be on show', () => {
  const first = message();
  for (const output of [7, 38, 118]) {
    const last = message({ timestamp: 1, usage: { output }, content: [{ type: 'toolCall', name: 'bash', arguments: {} }],
      __timing: timing({ first: 1000, last: 1000, end: 1273, deltas: 1 }) });
    assert.equal(speedReply([first, last]), first, 'the same model, timed from its first token');
    assert.equal(speedReply([last]), last, 'nothing better: the request as a whole');
    assert.equal(usageOf([last]).tps, output / 1.273); assert.equal(usageOf([last]).speedBasis, 'request');
  }
  const untimed = message({ __timing: undefined });
  assert.equal(speedReply([first, untimed]), first);
  assert.match(speedDisplay(usageOf([first]), { earlier: true }).title, /could not be timed from their first token .*, or were too short to time/);
  const other = { ...untimed, model: 'other-model' };
  assert.equal(speedReply([first, other]), other, 'never borrow another model\'s speed');
  assert.equal(speedReply([]), undefined);
});
test('Codex and Antigravity turns are counted one model request at a time, as Pi\'s and Claude Code\'s replies are', () => {
  const tokens = (input, output) => ({ input, cacheRead: 0, cacheWrite: 0, output, reasoning: 0, totalTokens: input + output, cost: { total: 0 } });
  // A Codex turn of a minute: a request of 2 s (60 tokens), a command of 50 s, then a request of 8 s (640 tokens).
  const codex = { role: 'assistant', provider: 'codex', model: 'gpt-a', stopReason: 'stop', timestamp: 0, content: [{ type: 'text', text: 'done' }],
    usage: tokens(900, 700), durationMs: 60000, modelMs: 10000, requests: [{ ms: 2000, ...tokens(400, 60) }, { ms: 8000, ...tokens(500, 640) }] };
  const entries = requestReplies([{ role: 'user', content: 'go' }, codex]);
  assert.equal(entries.length, 3, 'the message of yours, and one entry per request');
  const [first, last] = entries.slice(1).map(entry => usageOf([entry]));
  assert.deepEqual([first.tps, first.output, first.input], [30, 60, 400]);
  assert.deepEqual([last.tps, last.output, last.input], [80, 640, 500], 'the last request: its own tokens over its own time');
  assert.equal(speedDisplay(last).label, 'Request TPS');
  // The turn as a whole (the total): every request, and never the command's fifty seconds.
  assert.equal(usageOf([codex]).tps, 70); assert.equal(usageOf([codex]).output, 700);
  // A turn saved before requests were listed: the model's time in the turn, else the turn's length.
  const { requests, ...older } = codex;
  assert.equal(usageOf([older]).tps, 70);
  assert.equal(usageOf([{ ...older, modelMs: undefined }]).tps, 700 / 60);
  assert.deepEqual(requestReplies([older]), [older]);
  // Antigravity counts tokens per turn: a request's share of them is an estimate, and says so.
  const agy = { ...codex, provider: 'antigravity', requests: [{ ms: 2000, output: 100, estimated: true }, { ms: 8000, output: 600, estimated: true }] };
  const shared = usageOf([requestReplies([agy])[1]]);
  assert.equal(shared.tps, 75); assert.equal(shared.output, 700);
  assert.equal(speedDisplay(shared).label, 'Request TPS (estimated)');
  // A request says how long it waited for its first output: speed is measured over the rest. (Codex: its first
  // reasoning or message item. Antigravity: its first chunk, whose share of the output came with it.)
  const waited = { ...codex, requests: [{ ms: 2000, ...tokens(400, 60) }, { ms: 8000, wait: 3000, ...tokens(500, 640) }] };
  const [whole, measured] = requestReplies([waited]).map(entry => usageOf([entry]));
  assert.deepEqual([measured.tps, measured.speedBasis, speedDisplay(measured).label], [128, 'decode', 'Output TPS']);
  assert.deepEqual([whole.tps, whole.speedBasis], [30, 'request'], 'a tool call alone: nothing was seen being written');
  assert.equal(requestReplies([waited])[1].usage.wait, undefined, 'timing is not usage');
  const both = requestReplies([waited]);
  assert.equal(speedReply(both), both[1]); assert.equal(speedReply([both[1], both[0]]), both[1], 'the last one that was measured from its first output');
  assert.equal(usageOf([waited]).tps, 128, 'the turn as a whole: the requests that could be measured');
  const thought = usageOf([requestReplies([{ ...agy, requests: [{ ms: 2000, wait: 500, lead: 0.4, output: 100, estimated: true }] }])[0]]);
  assert.deepEqual([thought.tps, speedDisplay(thought).label], [40, 'Output TPS (estimated)'], 'a thought that came whole is not counted over the time after it');
  assert.equal(usageOf([requestReplies([{ ...agy, requests: [{ ms: 2000, wait: 1995, lead: 0.9, output: 100 }] }])[0]]).speedBasis, 'request', 'no time left to measure over');
  const coarse = usageOf([requestReplies([{ ...agy, requests: [{ ms: 2000, wait: 1000, lead: 0.87, output: 100, estimated: true }] }])[0]]);
  assert.equal(coarse.tps, 100, 'most of it in the first piece: all of it over the time from the first output, not 13 tokens of it');
  // A request that wrote nothing countable has no speed; a stopped turn has none either.
  assert.equal(usageOf([requestReplies([{ ...codex, requests: [{ ms: 500, ...tokens(10, 0) }] }])[0]]).tps, null);
  assert.equal(usageOf([{ ...codex, stopReason: 'aborted' }]).tps, null);
});
