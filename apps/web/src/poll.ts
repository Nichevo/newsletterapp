import { useEffect } from 'react';

/** After this long with no taps, clicks, keys or scrolling, polling pauses until you're back. */
const IDLE_MS = 10 * 60_000;

let lastActive = Date.now();
const wakeups = new Set<() => void>();
if (typeof window !== 'undefined') {
  const mark = () => {
    const wasIdle = Date.now() - lastActive >= IDLE_MS;
    lastActive = Date.now();
    if (wasIdle) wakeups.forEach((f) => f());
  };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
    window.addEventListener(ev, mark, { passive: true, capture: true });
  }
}

const watching = () => document.visibilityState === 'visible' && Date.now() - lastActive < IDLE_MS;

/**
 * Calls `fn` now and every `ms` while the page is on screen and in use. A tab
 * left open in the background, an installed app that is not in front, or a
 * screen nobody has touched for 10 minutes stops asking, so the free database
 * allowance isn't spent on screens nobody is looking at. Coming back (showing
 * the tab, or the first tap after a pause) refreshes at once. `ms` null means
 * load once, with no repeats.
 */
export function useVisiblePolling(fn: () => void, ms: number | null): void {
  useEffect(() => {
    fn();
    if (ms === null) return;
    const t = window.setInterval(() => {
      if (watching()) fn();
    }, ms);
    const onVisible = () => {
      if (watching()) fn();
    };
    document.addEventListener('visibilitychange', onVisible);
    wakeups.add(fn);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      wakeups.delete(fn);
    };
  }, [fn, ms]);
}
