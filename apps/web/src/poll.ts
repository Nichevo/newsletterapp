import { useEffect } from 'react';

/**
 * Calls `fn` now and every `ms` while the page is on screen. A tab left open in
 * the background, or an installed app that is not in front, stops asking, so
 * the free database allowance isn't spent on screens nobody is looking at.
 */
export function useVisiblePolling(fn: () => void, ms: number): void {
  useEffect(() => {
    fn();
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') fn();
    }, ms);
    const onVisible = () => {
      if (document.visibilityState === 'visible') fn();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fn, ms]);
}
