// ⌘K finds conversations on this Mac by what was said in them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findInSessionFile, searchSessionFiles, snippetAround } from '../app/main/message-search.mjs';

const line = entry => JSON.stringify(entry);
const message = (role, content, extra = {}) => line({ type: 'message', id: Math.random().toString(36).slice(2), message: { role, content, ...extra } });

function files(t, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'iris-search-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Object.entries(contents).map(([id, lines]) => { const file = join(dir, `${id}.jsonl`); writeFileSync(file, lines.join('\n') + '\n'); return { id, file }; });
}

test('a conversation is found by its latest message that says it, with the words around the match', async t => {
  const [weather, other, tools] = files(t, {
    weather: [line({ type: 'session', version: 3 }), message('user', [{ type: 'text', text: '加一个按城市查询温度的函数' }]),
      message('assistant', [{ type: 'thinking', thinking: 'Open-Meteo is free' }, { type: 'text', text: '好的,我用 Open-Meteo 查询温度。' }]),
      message('user', [{ type: 'text', text: 'Now cache the Open-Meteo responses for ten minutes, please.' }])],
    other: [message('user', 'Something unrelated'), message('user', [{ type: 'text', text: '/iris-title open-meteo' }])],
    tools: [message('toolResult', [{ type: 'text', text: 'open-meteo appears only in tool output' }]), 'not json {open-meteo}'],
  });
  assert.deepEqual(await findInSessionFile(weather.file, 'open-meteo'), { role: 'user', snippet: 'Now cache the Open-Meteo responses for ten minutes, please.' });
  assert.equal(await findInSessionFile(other.file, 'open-meteo'), null, 'the desktop’s own prompts are not searched');
  assert.equal(await findInSessionFile(tools.file, 'open-meteo'), null, 'nor tool output');
  assert.deepEqual((await searchSessionFiles([other, weather, tools], 'Open-Meteo')).map(h => h.id), ['weather']);
  assert.deepEqual((await searchSessionFiles([weather], '温度')).map(h => [h.role, h.snippet]), [['assistant', '好的,我用 Open-Meteo 查询温度。']]);
  assert.deepEqual(await searchSessionFiles([weather], 'o'), [], 'one letter is too little to search for');
});

test('results keep the order they were asked in, stop at the limit, and a missing file is skipped', async t => {
  const list = files(t, Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [id, [message('user', `fix the parser in ${id}`)]])));
  const missing = { id: 'gone', file: join(tmpdir(), 'iris-no-such-file.jsonl') };
  assert.deepEqual((await searchSessionFiles([list[3], missing, list[0], list[2], list[1]], 'parser', { limit: 3 })).map(h => h.id), ['d', 'a', 'c']);
});

test('a snippet is plain words: no code fences, quote marks or heading hashes', () => {
  const text = "console.log(x);\n```\n\n> Next: use Open-Meteo for the forecast\n## Plan";
  assert.equal(snippetAround(text, text.indexOf('Open-Meteo'), 10, { before: 40 }), 'console.log(x); Next: use Open-Meteo for the forecast Plan');
});

test('a snippet is the match with some text on either side, on one line', () => {
  const text = `${'x'.repeat(80)}\nthe needle is here\n${'y'.repeat(200)}`;
  const snippet = snippetAround(text, text.indexOf('needle'), 6);
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…') && !snippet.includes('\n') && snippet.includes('the needle is here'));
});
