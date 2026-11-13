import { useEffect } from 'react';
import { api } from './api';

const READING_LINE = 0.33; // a third of the way down the screen
const IDLE_MS = 60_000; // no touch, scroll or key for this long: stop counting
const TITLE_ONLY_CAP = 14; // a row showing only its title can reach Glanced, not a read summary

/**
 * Counts the seconds each inbox row sits at the reading line (a third of the way
 * down the screen) while you are actually there: the tab is visible, you have
 * touched or scrolled in the last minute, and you aren't flicking past quickly.
 * Only one row collects at a time. Kept in memory and sent in one request when
 * you leave the inbox or switch away from the app.
 */
export function useGlanceTracker(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const secs = new Map<string, number>();
    let lastActivity = Date.now();
    let lastY = window.scrollY;

    const tick = window.setInterval(() => {
      const y = window.scrollY;
      const moved = Math.abs(y - lastY);
      lastY = y;
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastActivity > IDLE_MS) return;
      if (moved > window.innerHeight * 0.5) return; // flicking past, not reading
      const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight * READING_LINE);
      const row = hit instanceof Element ? hit.closest<HTMLElement>('[data-item-id]') : null;
      const id = row?.dataset.itemId;
      if (!id) return;
      const cap = row.dataset.glanceCap === 'title' ? TITLE_ONLY_CAP : 600;
      secs.set(id, Math.min(cap, (secs.get(id) ?? 0) + 1));
    }, 1000);

    const activity = () => {
      lastActivity = Date.now();
    };
    const flush = () => {
      const items = [...secs].filter(([, s]) => s >= 2).map(([id, s]) => ({ id, secs: s }));
      secs.clear();
      api.glances({ items });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };

    window.addEventListener('scroll', activity, { passive: true });
    window.addEventListener('pointerdown', activity, { passive: true });
    window.addEventListener('keydown', activity);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener('scroll', activity);
      window.removeEventListener('pointerdown', activity);
      window.removeEventListener('keydown', activity);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [enabled]);
}
