const KEY = 'iris.appearance';

const systemQuery = () => { try { return window.matchMedia('(prefers-color-scheme: dark)'); } catch { return null; } };
const systemTheme = () => systemQuery()?.matches === false ? 'light' : 'dark';

// 'light' or 'dark' once the person picked one. Until then the app follows the system.
export function chosenAppearance() {
  try { const value = localStorage.getItem(KEY); return value === 'light' || value === 'dark' ? value : null; }
  catch { return null; }
}

export function readAppearance() { return chosenAppearance() ?? systemTheme(); }

// `persist: false` shows a theme without recording it as the person's choice.
export function applyAppearance(value, { persist = true } = {}) {
  const theme = value === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  if (persist) { try { localStorage.setItem(KEY, theme); } catch { /* Appearance still works without storage. */ } }
  return theme;
}

// Calls back with the system's theme whenever it changes while no choice has been made.
export function watchSystemAppearance(onChange) {
  const query = systemQuery();
  if (!query?.addEventListener) return () => {};
  const listener = () => { if (!chosenAppearance()) onChange(systemTheme()); };
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
