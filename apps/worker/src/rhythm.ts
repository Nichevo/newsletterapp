import type { FeedRhythm } from '@newsletterapp/shared';
import type { SourceRow } from './db';
import type { Env } from './env';

// When a feed usually posts, learnt from the dates of the posts it has brought
// in, so it can be checked around those times instead of every hour. Every
// feed is still checked at least once a day, so a feed that changes its habits
// is never more than a day late, and its rhythm re-learns itself as new posts
// arrive.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN_POSTS = 6; // fewer than this and there's no rhythm to speak of
const LOOK_BACK = 180 * DAY;
const SAMPLE = 40; // most recent posts used
const BUSY_GAP_HOURS = 6; // posting more often than this: keep the usual interval
const HOUR_SHARE = 0.75; // the hours that hold this share of posts...
const MAX_HOURS = 6; // ...count as a pattern if there are no more than this many
const QUIET_HOURS = 8; // outside its usual hours, a feed is checked this often
const RELEARN_MS = 7 * DAY; // a rhythm with no new posts is re-learnt weekly

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function local(at: number, timezone: string): { hour: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(
    new Date(at),
  );
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const day = WEEKDAYS.indexOf(parts.find((p) => p.type === 'weekday')?.value ?? 'Sun');
  return { hour, day: day < 0 ? 0 : day };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/** Works out a rhythm from post times. Always returns one, with `pattern` false when there isn't a usable one. */
export function learnRhythm(times: number[], timezone: string, at: number): FeedRhythm {
  const posts = times.filter((t) => t > at - LOOK_BACK && t <= at).sort((a, b) => a - b);
  const base: FeedRhythm = { pattern: false, posts: posts.length, gapHours: null, hours: null, days: null, timezone, learntAt: at };
  if (posts.length < MIN_POSTS) return base;
  const gaps: number[] = [];
  for (let i = 1; i < posts.length; i++) {
    const g = posts[i]! - posts[i - 1]!;
    if (g > 5 * 60_000) gaps.push(g / HOUR); // posts minutes apart are one batch
  }
  if (gaps.length < MIN_POSTS - 1) return base;
  const gapHours = Math.round(median(gaps) * 10) / 10;
  const out: FeedRhythm = { ...base, gapHours };
  if (gapHours < BUSY_GAP_HOURS) return out; // busy feed: hourly checks are right

  const byHour = new Array<number>(24).fill(0);
  const byDay = new Array<number>(7).fill(0);
  for (const t of posts) {
    const l = local(t, timezone);
    byHour[l.hour]!++;
    byDay[l.day]!++;
  }
  const ranked = byHour.map((n, h) => ({ h, n })).sort((a, b) => b.n - a.n);
  const hours: number[] = [];
  let covered = 0;
  for (const { h, n } of ranked) {
    if (covered >= HOUR_SHARE * posts.length || n === 0) break;
    hours.push(h);
    covered += n;
  }
  const days = byDay.map((n, d) => (n > 0 ? d : -1)).filter((d) => d >= 0);
  return {
    ...out,
    pattern: true,
    hours: hours.length <= MAX_HOURS ? hours.sort((a, b) => a - b) : null,
    // Only a weekday pattern when there are enough posts to say some days never get one.
    days: posts.length >= 8 && days.length <= 5 ? days : null,
  };
}

export function parseRhythm(raw: string | null | undefined): FeedRhythm | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FeedRhythm;
  } catch {
    return null;
  }
}

/** In or next to (one hour either side of) the feed's usual posting hours, on a usual day. */
function inWindow(r: FeedRhythm, at: number): boolean {
  const l = local(at, r.timezone);
  if (r.days && !r.days.includes(l.day)) {
    // A post near midnight can land on the next day; let the first hour of a day follow a posting day.
    const prev = local(at - HOUR, r.timezone);
    if (!(r.days.includes(prev.day) && l.hour === 0)) return false;
  }
  if (!r.hours) return true;
  return r.hours.some((h) => Math.min((l.hour - h + 24) % 24, (h - l.hour + 24) % 24) <= 1);
}

/**
 * When to check a source next. Feeds with no interval of their own and a
 * learnt rhythm are checked at their usual interval inside their posting
 * window and every few hours outside it; everything else keeps its interval.
 */
export function nextCheckAt(source: Pick<SourceRow, 'kind' | 'check_minutes' | 'rhythm'>, at: number, intervalMs: number): number {
  const r = source.kind === 'feed' && source.check_minutes === null ? parseRhythm(source.rhythm) : null;
  if (!r || !r.pattern || r.gapHours === null) return at + intervalMs;
  if (!r.hours && !r.days) {
    // Regular but at no particular hour: about four checks per usual gap, at most a day apart.
    return at + Math.min(Math.max((r.gapHours * HOUR) / 4, intervalMs), DAY);
  }
  if (inWindow(r, at)) return at + intervalMs;
  // Outside the window: the start of the next window, or a quiet check, whichever is first.
  const quiet = at + Math.min(QUIET_HOURS * HOUR, DAY);
  const hourStart = at - (at % HOUR);
  for (let t = hourStart + HOUR; t < quiet; t += HOUR) if (inWindow(r, t)) return Math.max(t, at + intervalMs);
  return quiet;
}

/** Re-learns a feed's rhythm from its latest posts and stores it. One small indexed read. */
export async function refreshRhythm(env: Env, sourceId: string, timezone: string, at: number): Promise<FeedRhythm> {
  const rows = await env.DB.prepare('SELECT received_at FROM items INDEXED BY items_source WHERE source_id = ? ORDER BY received_at DESC LIMIT ?')
    .bind(sourceId, SAMPLE)
    .all<{ received_at: number }>();
  const r = learnRhythm(
    rows.results.map((x) => x.received_at),
    timezone,
    at,
  );
  await env.DB.prepare('UPDATE sources SET rhythm = ? WHERE id = ?').bind(JSON.stringify(r), sourceId).run();
  return r;
}

/** Whether a stored rhythm is missing or over a week old (a change of time zone is picked up then too). */
export function rhythmStale(raw: string | null | undefined, at: number): boolean {
  const r = parseRhythm(raw);
  return !r || at - r.learntAt > RELEARN_MS;
}
