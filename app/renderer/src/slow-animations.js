// Animations that never end (the dots of something under way, text that breathes, a pulsing dot) are moved on
// fifteen times a second by one timer, not by the compositor at the screen's refresh rate.
//
// While any of them ran, the window was composited anew on every refresh (60 or 120 times a second), on a large
// screen a sixth of a core or more in the GPU process for a few dots, all the time an agent worked. Paused and
// moved on here, a frame is drawn only when one of them has changed. Animations that end (a menu appearing, words
// fading in) are left to run as they are.
export const STEPS_PER_SECOND = 15;

// (A CSS animation has a name; a transition, a script's animation, has none.)
const looping = animation => typeof animation.animationName === 'string' && animation.effect?.getTiming?.().iterations === Infinity;

export function step(animations, now) {
  for (const animation of animations) {
    if (!looping(animation)) continue;
    if (animation.playState !== 'paused') animation.pause();
    animation.currentTime = now; // (endless: where it is in its loop follows from the time)
  }
}

export function slowLoopingAnimations(doc = document, interval = 1000 / STEPS_PER_SECOND) {
  if (typeof doc.getAnimations !== 'function') return () => {};
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return () => {};
  const timer = setInterval(() => { if (!doc.hidden) step(doc.getAnimations(), performance.now()); }, interval);
  return () => clearInterval(timer);
}
