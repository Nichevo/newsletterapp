const DAY = 86_400_000;

/** "7:02", "Yesterday", "Mon", "14 Oct" style timestamps for list rows. */
export function shortTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((startOfToday.getTime() - ms) / DAY) + (ms < startOfToday.getTime() ? 1 : 0);
  if (ms >= startOfToday.getTime()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  if (d.getFullYear() === new Date(now).getFullYear()) {
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function longDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

const WORDS_PER_MINUTE = 230;

/** Rough reading time from the item's word count, or from its text. */
export function readingMinutes(source: number | string | null | undefined): number {
  const words = typeof source === 'number' ? source : source ? source.trim().split(/\s+/).length : 0;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}
