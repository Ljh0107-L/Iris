// The menus a CLI offered, as kept for the new-conversation screen.

// A CLI that does not say what each model has (Antigravity: only the model in use has its efforts listed) is
// learned from: the settings listed now are those of the model in use, and are kept with it (`sub`, as Codex's
// and Cursor's models carry theirs), beside what was learned of the others before (`before`, the menus kept
// last time). So picking another model on the new-conversation screen shows its efforts, once that model has
// been used on that machine. A CLI that does say is left as it is.
export function learnModelSettings(options, before = []) {
  const model = options.find(o => o.category === 'model');
  if (!model || model.options.some(choice => Array.isArray(choice.sub))) return options;
  const known = before.find(o => o.category === 'model')?.options ?? [];
  const learned = new Map(known.filter(choice => Array.isArray(choice.sub)).map(choice => [choice.value, choice.sub]));
  const own = options.filter(o => o !== model).slice(0, 6).map(({ id, name, category, currentValue, options: choices }) =>
    ({ id, name, category, currentValue, options: (choices ?? []).map(({ sub, ...choice }) => choice) }));
  learned.set(model.currentValue, own);
  return options.map(o => o !== model ? o : { ...o, options: o.options.map(choice => learned.has(choice.value) ? { ...choice, sub: learned.get(choice.value) } : choice) });
}
