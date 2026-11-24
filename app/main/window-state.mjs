// Where the window was and how large, so that it opens the same way next time (window.json in the profile).
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

export const DEFAULT_SIZE = { width: 1440, height: 900 };
export const MIN_SIZE = { width: 880, height: 640 };

const clamp = (value, low, high) => Math.max(low, Math.min(value, Math.max(low, high)));
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const fit = (size, area) => ({ width: clamp(Math.round(size.width), MIN_SIZE.width, area.width), height: clamp(Math.round(size.height), MIN_SIZE.height, area.height) });

// The bounds to open with. `areas` are the work areas of the displays connected now, the primary one first.
// A remembered window goes back where it was if that place is still on a display (the external monitor may
// be gone), moved and shrunk as far as needed to be wholly on it. Otherwise: the default size, or as much of
// it as the primary display has room for, centred there.
export function openingBounds(saved, areas) {
  const remembered = saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) && saved.width > 0 && saved.height > 0;
  if (remembered) {
    const area = [...areas].sort((a, b) => overlap(saved, b) - overlap(saved, a))[0];
    if (area && overlap(saved, area) > 0) {
      const size = fit(saved, area);
      return { ...size, x: clamp(Math.round(saved.x), area.x, area.x + area.width - size.width), y: clamp(Math.round(saved.y), area.y, area.y + area.height - size.height) };
    }
  }
  const area = areas[0] ?? { x: 0, y: 0, ...DEFAULT_SIZE }, size = fit(DEFAULT_SIZE, area);
  return { ...size, x: area.x + Math.round((area.width - size.width) / 2), y: area.y + Math.round((area.height - size.height) / 2) };
}

export function readWindowState(path) {
  try { const state = JSON.parse(readFileSync(path, 'utf8')); return state && typeof state === 'object' ? state : null; }
  catch { return null; } // first start, or unreadable: open with the default
}

// Remember `window` as it is moved and resized. Written a moment after the last change, and when it closes.
export function rememberWindow(window, path) {
  let timer = null, last = '';
  const write = () => {
    timer = null;
    if (window.isDestroyed()) return;
    // Full screen and minimized are states of the window, not its place: the place is where it returns to.
    const text = JSON.stringify({ ...window.getNormalBounds(), fullscreen: window.isFullScreen() });
    if (text === last) return;
    last = text;
    writeFile(path, text).catch(() => {}); // not worth an error: the window opens at the default next time
  };
  const soon = () => { clearTimeout(timer); timer = setTimeout(write, 400); };
  for (const event of ['resize', 'move', 'enter-full-screen', 'leave-full-screen']) window.on(event, soon);
  window.on('close', () => { clearTimeout(timer); write(); });
}
