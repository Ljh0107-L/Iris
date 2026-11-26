// Handing a conversation to another agent: the first message of the new conversation says what was asked, what
// the agent last reported and which files it changed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handoffText } from '../app/renderer/src/handoff.js';

const messages = [
  { role: 'user', content: [{ type: 'text', text: 'Add retries to the uploader' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'toolCall', id: 'e1', name: 'edit', arguments: { path: 'src/upload.js', edits: [{ oldText: 'a', newText: 'b' }] } }] },
  { role: 'user', content: [{ type: 'text', text: 'and log each retry\n\nAttached files:\n- /tmp/x.png' }] },
  { role: 'assistant', content: [{ type: 'toolCall', id: 'w1', name: 'write', arguments: { path: 'src/log.js', content: 'x' } }, { type: 'text', text: 'Retries are in, with a log line each.' }] },
  { role: 'user', content: [{ type: 'text', text: '/compact' }] },
];
const tools = { e1: { status: 'done' }, w1: { status: 'done' } };

test('continuing: what was asked, where the agent got to, the files it changed', () => {
  const text = handoffText({ engine: 'codex', messages, tools, cwd: '/w/app' });
  assert.match(text, /^I am moving this work over from Codex\. Pick it up where it stopped in \/w\/app\./);
  assert.match(text, /What was asked:\n- Add retries to the uploader\n- and log each retry\n\n/, 'attachments and commands left out');
  assert.match(text, /What Codex last reported:\n> Retries are in, with a log line each\./);
  assert.match(text, /Files it changed:\n- src\/upload\.js\n- src\/log\.js/);
  assert.match(text, /Check the current state of the files first, then continue\.$/);
});

test('a review asks for findings, not edits', () => {
  const text = handoffText({ engine: 'iris', messages, tools, mode: 'review' });
  assert.match(text, /^Please review the work Iris did\./);
  assert.match(text, /do not edit files unless I ask\.$/);
});

test('an empty conversation still hands over cleanly', () => {
  assert.equal(handoffText({ engine: 'cursor' }), 'I am moving this work over from Cursor. Pick it up where it stopped.\n\nCheck the current state of the files first, then continue.');
});
