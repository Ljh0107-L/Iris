// Endless animations are moved on by one timer at a low rate, not by the compositor at every refresh.
import assert from 'node:assert/strict';
import test from 'node:test';
import { step } from '../app/renderer/src/slow-animations.js';

const animation = (fields, iterations) => ({ ...fields, playState: 'running', currentTime: 0, paused: 0, effect: { getTiming: () => ({ iterations }) }, pause() { this.playState = 'paused'; this.paused++; } });

test('an endless CSS animation is paused and set to the time; one that ends, and a transition, are left alone', () => {
  const dots = animation({ animationName: 'tumble-1' }, Infinity), pop = animation({ animationName: 'pop' }, 1), fade = animation({ transitionProperty: 'opacity' }, 1);
  step([dots, pop, fade], 1234);
  assert.deepEqual([dots.playState, dots.currentTime], ['paused', 1234]);
  assert.deepEqual([pop.playState, pop.currentTime, fade.playState], ['running', 0, 'running']);
  step([dots], 1300);
  assert.deepEqual([dots.currentTime, dots.paused], [1300, 1], 'paused once, then only moved on');
});
