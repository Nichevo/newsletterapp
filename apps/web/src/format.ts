import type { FeedRhythm, SourceActivity } from '@newsletterapp/shared';
import { getReadingSpeed } from './prefs';

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

/** "Fri, 30 Oct 2026, 9:15 pm": the full date with the year, for the reader. */
export function longDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

/** Rough reading time from the item's word count, or from its text. */
export function readingMinutes(source: number | string | null | undefined): number {
  const words = typeof source === 'number' ? source : source ? source.trim().split(/\s+/).length : 0;
  return Math.max(1, Math.round(words / getReadingSpeed()));
}

const PROVIDER_LABEL: Record<string, string> = { ollama: 'Ollama on your PC', anthropic: 'Claude (hosted)' };

/** "Summary by qwen3:32b via Ollama on your PC, prompt v2, 12 s" */
export function aiAttribution(ai: { provider: string; model: string; promptVersion: number | null; seconds: number | null }): string {
  const parts = [`Summary by ${ai.model} via ${PROVIDER_LABEL[ai.provider] ?? ai.provider}`];
  if (ai.promptVersion) parts.push(`prompt v${ai.promptVersion}`);
  if (ai.seconds !== null) parts.push(`${Math.round(ai.seconds)} s`);
  return parts.join(', ');
}

export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

/** "3 pm", or "Tue 9 am" when it's not today: when the next check is due. */
export function nextTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function hourLabel(h: number): string {
  const n = h % 12 === 0 ? 12 : h % 12;
  return `${n} ${h < 12 ? 'am' : 'pm'}`;
}

/** Usual hours as runs: [8, 9, 10, 17] -> "8–10 am, 5 pm". */
function hoursText(hours: number[]): string {
  const runs: [number, number][] = [];
  for (const h of [...hours].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && h === last[1] + 1) last[1] = h;
    else runs.push([h, h]);
  }
  return runs
    .map(([a, b]) => {
      if (a === b) return hourLabel(a);
      const sameHalf = a < 12 === b < 12;
      return sameHalf ? `${hourLabel(a).split(' ')[0]}–${hourLabel(b)}` : `${hourLabel(a)}–${hourLabel(b)}`;
    })
    .join(', ');
}

function daysText(days: number[]): string {
  const key = [...days].sort((a, b) => a - b).join('');
  if (key === '12345') return 'weekdays';
  if (key === '06') return 'weekends';
  return [...days].sort((a, b) => a - b).map((d) => DAY_NAMES[d]).join(', ');
}

export function gapText(hours: number): string {
  if (hours < 1.5) return 'about every hour';
  if (hours < 36) return `about every ${Math.round(hours)} hours`;
  const days = Math.round(hours / 24);
  return days === 7 ? 'about once a week' : `about every ${days} days`;
}

/**
 * What the app has learnt about when a feed posts, in words. `scheduled` says
 * whether checks follow it (the feed has no fixed "Check every" of its own).
 */
export function rhythmText(r: FeedRhythm | null, scheduled: boolean): { summary: string; checking: string } {
  if (!r) return { summary: 'Not learnt yet; the next check works it out.', checking: '' };
  const fixed = 'You set a fixed interval, so it is checked on that instead.';
  if (!r.pattern) {
    if (r.posts < 6) return { summary: `Still learning: ${r.posts} post${r.posts === 1 ? '' : 's'} in the last 6 months, 6 needed.`, checking: scheduled ? 'Checked every hour meanwhile.' : fixed };
    if (r.gapHours !== null) return { summary: `Busy feed, posts ${gapText(r.gapHours)}.`, checking: scheduled ? 'Checked every hour.' : fixed };
    return { summary: 'No clear pattern in when it posts.', checking: scheduled ? 'Checked every hour.' : fixed };
  }
  const when = [r.days ? `on ${daysText(r.days)}` : '', r.hours ? `around ${hoursText(r.hours)}` : ''].filter(Boolean).join(' ');
  const summary = `Usually posts ${when ? `${when}, ` : ''}${gapText(r.gapHours ?? 24)}.`;
  if (!scheduled) return { summary, checking: fixed };
  if (!r.hours && !r.days) {
    const every = Math.min(Math.max((r.gapHours ?? 24) / 4, 1), 24);
    return { summary, checking: `No set time, so checked about every ${Math.round(every)} hour${Math.round(every) === 1 ? '' : 's'}.` };
  }
  return { summary, checking: 'Checked every hour around then, every 8 hours otherwise.' };
}

/** "3 days ago", "6 weeks ago", "4 months ago". */
export function agoText(at: number, now = Date.now()): string {
  const days = Math.floor((now - at) / DAY);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

function rate(n: number): string {
  if (n === 0) return '0';
  if (n < 0.1) return 'under 0.1';
  return n < 10 ? n.toFixed(1).replace(/\.0$/, '') : String(Math.round(n));
}

export interface ActivityView {
  perMonth: number;
  readsPerMonth: number;
  /** Nothing new for 30+ days and well past its usual gap. */
  quiet: boolean;
  /** Items in the last 90 days, none of them read. */
  unread: boolean;
  /** "4.3 / month · read 1 / month · ★ 2 · last 3 days ago" */
  line: string;
  /** The warning, when quiet or unread. */
  flag: string | null;
}

/** A source's activity over the last 90 days, in numbers and words. */
export function activityView(
  a: SourceActivity | undefined,
  source: { lastReceivedAt: number | null; createdAt: number; kind: string; rhythm?: FeedRhythm | null },
  now = Date.now(),
): ActivityView {
  const days = a?.days ?? 90;
  const items = a?.items ?? 0;
  const perMonth = (items / days) * 30;
  const readsPerMonth = ((a?.reads ?? 0) / days) * 30;
  const noun = source.kind === 'newsletter' ? 'issue' : 'post';
  const gapHours = source.rhythm?.gapHours ?? (items >= 2 ? (days * 24) / items : null);
  const since = source.lastReceivedAt ?? source.createdAt;
  const silent = now - since;
  const quiet = silent > 30 * DAY && (gapHours === null || silent > 3 * gapHours * 3_600_000);
  const unread = items > 0 && (a?.reads ?? 0) === 0;
  const line = [
    `${rate(perMonth)} / month`,
    `looked at ${rate(readsPerMonth)} / month`,
    a?.stars ? `★ ${a.stars}` : '',
    source.lastReceivedAt ? `last ${agoText(source.lastReceivedAt, now)}` : `no ${noun}s yet`,
  ]
    .filter(Boolean)
    .join(' · ');
  const flag = quiet
    ? source.lastReceivedAt
      ? `Quiet: no ${noun}s for ${agoText(source.lastReceivedAt, now).replace(' ago', '')}`
      : `Quiet: nothing since it was added`
    : unread
      ? `Unread: you haven't looked at any of the last ${items} ${noun}${items === 1 ? '' : 's'}`
      : null;
  return { perMonth, readsPerMonth, quiet, unread, line, flag };
}
