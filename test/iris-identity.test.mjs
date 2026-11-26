// Iris's agent says it is Iris's: the prompt Pi builds opens with Iris's line, not pi's, and still lists the tools
// and their rules as Pi would; a prompt of the person's own is kept.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
import { IRIS_PREAMBLE, irisPrompt } from '../agent/iris-bridge.js';

const { buildSystemPrompt } = await import(pathToFileURL(resolve('node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js')).href);
const options = () => ({ cwd: '/w', selectedTools: ['read', 'bash', 'edit', 'present_files'], toolSnippets: { read: 'Read file contents', bash: 'Run shell commands', edit: 'Edit files', present_files: 'Give the user finished files' },
  toolGuidelines: { present_files: ['Call present_files for files the user keeps'] }, promptGuidelines: ['Prefer small diffs'], sections: {} });

test('the prompt opens with Iris, keeps the tools and rules, and points at no pi manual', () => {
  const plain = buildSystemPrompt(options());
  assert.match(plain, /operating inside pi/, '(what Pi says on its own)');
  const opts = options();
  irisPrompt(opts);
  const prompt = buildSystemPrompt(opts);
  assert.ok(prompt.startsWith(IRIS_PREAMBLE));
  assert.doesNotMatch(prompt, /inside pi|Pi documentation/);
  for (const line of ['- read: Read file contents', '- present_files: Give the user finished files', '- Use bash for file operations like ls, rg, find', '- Call present_files for files the user keeps', '- Prefer small diffs', '- Be concise in your responses'])
    assert.ok(prompt.includes(line), line);
  // The same tools and rules Pi writes itself.
  const section = name => new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(prompt)?.[1];
  const pis = name => new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(plain)?.[1];
  assert.equal(section('tools'), pis('tools'));
  assert.equal(section('rules'), pis('rules'));
});

test('a prompt of the person’s own is left as it is', () => {
  const opts = { ...options(), customPrompt: 'You are my agent.' };
  irisPrompt(opts);
  assert.equal(opts.customPrompt, 'You are my agent.');
  assert.ok(buildSystemPrompt(opts).startsWith('You are my agent.'));
});
