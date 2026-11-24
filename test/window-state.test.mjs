import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SIZE, MIN_SIZE, openingBounds } from '../app/main/window-state.mjs';

const laptop = { x: 0, y: 25, width: 1470, height: 890 }, external = { x: 1470, y: 0, width: 2560, height: 1415 };

test('a first start opens at the default size, or what the display has room for, centred', () => {
  assert.deepEqual(openingBounds(null, [external]), { ...DEFAULT_SIZE, x: 1470 + 560, y: 258 });
  // 1440 x 900 does not fit a 13-inch display's work area: the window is no taller than the room there is.
  assert.deepEqual(openingBounds(null, [laptop]), { width: 1440, height: 890, x: 15, y: 25 });
  assert.deepEqual(openingBounds({ x: 'left', width: 800 }, [laptop]), openingBounds(null, [laptop]));
  assert.deepEqual(openingBounds(undefined, []), { ...DEFAULT_SIZE, x: 0, y: 0 });
});

test('a remembered window opens where it was', () => {
  const saved = { x: 200, y: 100, width: 1100, height: 700 };
  assert.deepEqual(openingBounds(saved, [laptop, external]), saved);
  const onExternal = { x: 2000, y: 200, width: 1600, height: 1000 };
  assert.deepEqual(openingBounds({ ...onExternal, fullscreen: true }, [laptop, external]), onExternal);
});

test('a window whose display is gone, or that hangs off the edge, is brought wholly onto a display', () => {
  // The external monitor was unplugged: back to the default place on the display that is left.
  assert.deepEqual(openingBounds({ x: 2000, y: 200, width: 1600, height: 1000 }, [laptop]), openingBounds(null, [laptop]));
  // Mostly on the laptop but past its right and bottom edges: moved in, same size.
  assert.deepEqual(openingBounds({ x: 900, y: 500, width: 1000, height: 700 }, [laptop]), { x: 470, y: 215, width: 1000, height: 700 });
  // Larger than the display it is on: shrunk to it.
  assert.deepEqual(openingBounds({ x: -50, y: 0, width: 3000, height: 2000 }, [laptop]), { x: 0, y: 25, width: 1470, height: 890 });
  // Never below the size the interface needs.
  const tiny = openingBounds({ x: 10, y: 30, width: 200, height: 100 }, [laptop]);
  assert.deepEqual([tiny.width, tiny.height], [MIN_SIZE.width, MIN_SIZE.height]);
});
