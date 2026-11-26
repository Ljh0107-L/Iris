// Antigravity lists the efforts of the model in use only: what each model has is learned as it is used, so the
// new-conversation screen can show a model's efforts when it is picked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { learnModelSettings } from '../app/main/cli-menus.mjs';

const menus = (model, efforts) => [
  { id: 'model', name: 'Model', category: 'model', currentValue: model, options: [{ value: 'claude-opus', name: 'Claude Opus' }, { value: 'gemini-neon', name: 'Gemini Neon' }, { value: 'gemini-flash', name: 'Gemini Flash' }] },
  ...(efforts ? [{ id: 'thinking', name: 'Thinking', category: 'thought_level', currentValue: efforts[0], options: efforts.map(value => ({ value, name: value })) }] : []),
];
const subs = options => Object.fromEntries(options[0].options.map(choice => [choice.value, choice.sub?.map(o => o.options.map(c => c.value)) ?? null]));

test('the efforts of each model used are kept with it', () => {
  const first = learnModelSettings(menus('claude-opus', ['high', 'low']), []);
  assert.deepEqual(subs(first), { 'claude-opus': [['high', 'low']], 'gemini-neon': null, 'gemini-flash': null });
  const second = learnModelSettings(menus('gemini-neon', ['medium', 'minimal']), first);
  assert.deepEqual(subs(second), { 'claude-opus': [['high', 'low']], 'gemini-neon': [['medium', 'minimal']], 'gemini-flash': null });
  // A model with no efforts at all is known to have none (an empty list, not "not known").
  const third = learnModelSettings(menus('gemini-flash', null), second);
  assert.deepEqual(subs(third), { 'claude-opus': [['high', 'low']], 'gemini-neon': [['medium', 'minimal']], 'gemini-flash': [] });
});

test('a CLI that says what each model has is left as it is', () => {
  const said = menus('claude-opus', ['high']);
  said[0].options[1].sub = [];
  assert.equal(learnModelSettings(said, []), said);
});
