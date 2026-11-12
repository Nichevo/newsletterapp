import {
  tagKey,
  type AppSettings,
  type CategorySuggestion,
  type ReviewArc,
  type ReviewBucket,
  type ReviewInterests,
  type ReviewKind,
  type ReviewMover,
  type ReviewPack,
  type ReviewSourceChange,
  type ReviewSourceRow,
  type ReviewStar,
  type ReviewStory,
  type ReviewTrends,
} from '@newsletterapp/shared';
import { storyTitle } from './db';
import { dayKey, leadStories } from './digest';
import type { Env } from './env';
import { dayStart, shiftDay } from './reading';

// The facts behind a review, gathered on the Worker in a handful of grouped
// queries when the review is built. Everything here is counting: no AI. The
// PC writes the words afterwards (reviews.ts hands it these facts as text).

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** One item, as the review counts it. */
interface Row {
  id: string;
  r: number; // received_at
  rd: number | null; // read_at
  st: number | null; // interesting_at
  s: string | null; // source_id
  sy: string | null; // story_id
  cat: string; // the category it shows under
  scat: string | null; // its source's category
  icat: string | null; // its own category (keyword rule or set by hand)
  acat: string | null; // the AI's first category
}

const ITEM_SQL = `SELECT items.id, items.received_at AS r, items.read_at AS rd, items.interesting_at AS st, items.source_id AS s, items.story_id AS sy,
    COALESCE(items.category, sources.category, json_extract(items.ai_category, '$[0]'), 'Other') AS cat,
    sources.category AS scat, items.category AS icat, json_extract(items.ai_category, '$[0]') AS acat
  FROM items INDEXED BY items_received LEFT JOIN sources ON sources.id = items.source_id
  WHERE items.received_at >= ? AND items.received_at < ? AND items.status != 'dropped' AND items.kind != 'ai'`;

interface SourceInfo {
  id: string;
  name: string;
  kind: string;
  category: string | null;
  created_at: number;
  paused_at: number | null;
  flood_at: number | null;
  flood_count: number;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round1 = (x: number) => Math.round(x * 10) / 10;
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const shortDate = (at: number, timezone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'short' }).format(new Date(at));
const monthName = (at: number, timezone: string, style: 'long' | 'short' = 'short') =>
  new Intl.DateTimeFormat('en-GB', { timeZone: timezone, month: style }).format(new Date(at));
const weekdayName = (at: number, timezone: string) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short' }).format(new Date(at));

/** "3 – 9 November" or "28 October – 3 November". */
function rangeLabel(from: number, to: number, timezone: string): string {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'long' });
  const a = f.formatToParts(new Date(from));
  const b = f.formatToParts(new Date(to - 1));
  const month = (p: Intl.DateTimeFormatPart[]) => p.find((x) => x.type === 'month')?.value;
  const day = (p: Intl.DateTimeFormatPart[]) => p.find((x) => x.type === 'day')?.value;
  return month(a) === month(b) ? `${day(a)} – ${day(b)} ${month(b)}` : `${f.format(new Date(from))} – ${f.format(new Date(to - 1))}`;
}

/** Start of the local month that holds `at`, and of the months around it. */
export function monthStart(at: number, timezone: string, shift = 0): number {
  const key = dayKey(at, timezone);
  const [y = 1970, m = 1] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + shift, 1));
  return dayStart(d.toISOString().slice(0, 10), timezone);
}

async function loadItems(env: Env, from: number, to: number): Promise<Row[]> {
  return (await env.DB.prepare(ITEM_SQL).bind(from, to).all<Row>()).results;
}

/** Read times in a window (whenever the items arrived), for counting reads per day or month. */
async function loadReads(env: Env, from: number, to: number): Promise<number[]> {
  const rows = await env.DB.prepare(
    "SELECT read_at FROM items WHERE status IN ('inbox', 'archived') AND read_at >= ? AND read_at < ? AND kind != 'ai'",
  )
    .bind(from, to)
    .all<{ read_at: number }>();
  return rows.results.map((r) => r.read_at);
}

async function loadStarTimes(env: Env, from: number, to: number): Promise<number[]> {
  const rows = await env.DB.prepare('SELECT interesting_at FROM items WHERE interesting_at >= ? AND interesting_at < ?').bind(from, to).all<{ interesting_at: number }>();
  return rows.results.map((r) => r.interesting_at);
}

async function loadSources(env: Env): Promise<Map<string, SourceInfo>> {
  const rows = await env.DB.prepare(
    "SELECT id, name, kind, category, created_at, paused_at, flood_at, flood_count FROM sources WHERE kind != 'ai'",
  ).all<SourceInfo>();
  return new Map(rows.results.map((s) => [s.id, s]));
}

async function loadStars(env: Env, from: number, to: number): Promise<ReviewStar[]> {
  const rows = await env.DB.prepare(
    `SELECT items.id, items.subject, sources.name AS source_name, items.interesting_at,
       (SELECT COUNT(*) FROM highlights WHERE highlights.item_id = items.id AND highlights.deleted_at IS NULL) AS highlights
     FROM items LEFT JOIN sources ON sources.id = items.source_id
     WHERE items.interesting_at >= ? AND items.interesting_at < ? AND items.status != 'dropped'
     ORDER BY items.interesting_at LIMIT 40`,
  )
    .bind(from, to)
    .all<{ id: string; subject: string; source_name: string | null; interesting_at: number; highlights: number }>();
  return rows.results.map((r) => ({ itemId: r.id, subject: r.subject, sourceName: r.source_name, at: r.interesting_at, highlights: r.highlights }));
}

/** How many periods back a time falls, counting back from `from` in steps of `step` (0 = the review's own period). */
const bucketOf = (t: number, from: number, step: number) => (t >= from ? 0 : Math.floor((from - t - 1) / step) + 1);

// ---------- Weekly ----------

export async function gatherWeek(env: Env, from: number, to: number, settings: AppSettings): Promise<ReviewPack> {
  const tz = settings.timezone;
  const r = settings.reviews;
  const skip = new Set(r.skipParts);
  const LOOK = 12; // weeks before, for "usual"
  const lookFrom = from - LOOK * WEEK;
  const [items, reads, starTimes, stars, sources] = await Promise.all([
    loadItems(env, lookFrom, to),
    loadReads(env, lookFrom, to),
    loadStarTimes(env, from - 4 * WEEK, to),
    loadStars(env, from, to),
    loadSources(env),
  ]);

  const inPeriod = items.filter((i) => i.r >= from);
  const weekOf = (t: number) => bucketOf(t, from, WEEK);
  const per = (times: number[], weeks: number) => {
    const counts = new Array<number>(weeks + 1).fill(0);
    for (const t of times) {
      const w = weekOf(t);
      if (w <= weeks) counts[w]!++;
    }
    return counts;
  };
  const arrivedW = per(items.map((i) => i.r), 4);
  const readW = per(reads, 4);
  const starW = per(starTimes, 4);
  const storyWeeks = (w: number) => new Set(items.filter((i) => i.sy && weekOf(i.r) === w).map((i) => i.sy)).size;

  const pack: ReviewPack = {
    label: rangeLabel(from, to, tz),
    usualLabel: 'the 4 weeks before',
    counts: {
      arrived: { now: arrivedW[0]!, usual: round1(avg(arrivedW.slice(1))) },
      read: { now: readW[0]!, usual: round1(avg(readW.slice(1))) },
      stars: { now: starW[0]!, usual: round1(avg(starW.slice(1))) },
      stories: { now: storyWeeks(0), usual: round1(avg([1, 2, 3, 4].map(storyWeeks))) },
    },
    stars,
    reading: weekReading(items, reads, from, to, tz),
  };

  if (!skip.has('top')) pack.top = await leadStories(env, from, to, r.topStories, r.skipCategories);
  if (!skip.has('stories')) pack.stories = await weekStories(env, items, inPeriod, from, r.skipCategories);
  if (!skip.has('trends')) pack.trends = await weekTrends(env, from, to);
  if (!skip.has('sources')) pack.sources = weekSources(items, sources, stars, from, to, tz);
  return pack;
}

function weekReading(items: Row[], reads: number[], from: number, to: number, tz: string): ReviewPack['reading'] {
  const buckets: ReviewBucket[] = [];
  const first = dayKey(from, tz);
  for (let i = 0; i < 7; i++) {
    const day = shiftDay(first, -i);
    const start = dayStart(day, tz);
    if (start >= to) break;
    buckets.push({ at: start, label: weekdayName(start + DAY / 2, tz), arrived: 0, read: 0 });
  }
  const find = (t: number) => {
    for (let i = buckets.length - 1; i >= 0; i--) if (t >= buckets[i]!.at) return buckets[i];
    return undefined;
  };
  for (const it of items) if (it.r >= from) find(it.r)!.arrived++;
  for (const t of reads) if (t >= from) find(t)!.read++;
  // Read share of what arrived, week by week, for the last 4 weeks.
  const shares: number[] = [];
  for (let w = 3; w >= 0; w--) {
    const wk = items.filter((i) => bucketOf(i.r, from, WEEK) === w);
    shares.push(pct(wk.filter((i) => i.rd).length, wk.length));
  }
  const best = [...buckets].sort((a, b) => b.read - a.read)[0];
  const parts: string[] = [];
  if (best && best.read > 0) parts.push(`You read most on ${best.label}.`);
  if (shares.length === 4 && shares.some((s) => s > 0)) {
    const [a, , , d] = shares;
    parts.push(
      a === d
        ? `Your read share has held at ${d}% over the last month.`
        : `Week by week, the share of what arrives that you read went from ${a}% to ${d}% over the last month.`,
    );
  }
  return { buckets, note: parts.join(' ') };
}

async function weekStories(env: Env, items: Row[], inPeriod: Row[], from: number, skipCategories: string[]): Promise<ReviewStory[]> {
  const skip = new Set(skipCategories.map((c) => c.toLowerCase()));
  const byStory = new Map<string, Row[]>();
  for (const it of inPeriod) {
    if (!it.sy || skip.has(it.cat.toLowerCase())) continue;
    const list = byStory.get(it.sy) ?? [];
    list.push(it);
    byStory.set(it.sy, list);
  }
  const ids = [...byStory.entries()]
    .filter(([, l]) => l.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8)
    .map(([id]) => id);
  // Followed stories always show if anything happened in them.
  const followed = await env.DB.prepare(
    `SELECT id FROM stories WHERE followed_at IS NOT NULL AND last_at >= ? AND id NOT IN (${ids.map(() => '?').join(',') || "''"}) LIMIT 4`,
  )
    .bind(from, ...ids)
    .all<{ id: string }>();
  for (const f of followed.results) if (byStory.has(f.id)) ids.push(f.id);
  if (ids.length === 0) return [];
  const rows = await env.DB.prepare(
    `SELECT stories.id, stories.title, stories.tags, stories.first_at, stories.last_at, stories.items, stories.followed_at, stories.closed_at,
       (SELECT subject FROM items WHERE items.story_id = stories.id ORDER BY received_at LIMIT 1) AS first_subject
     FROM stories WHERE id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(...ids)
    .all<{ id: string; title: string | null; tags: string | null; first_at: number; last_at: number; items: number; followed_at: number | null; closed_at: number | null; first_subject: string | null }>();
  const busiest = ids[0];
  const out: ReviewStory[] = [];
  for (const s of rows.results) {
    const list = byStory.get(s.id) ?? [];
    const perDay = new Array<number>(7).fill(0);
    for (const it of list) perDay[Math.min(6, Math.max(0, Math.floor((it.r - from) / DAY)))]!++;
    const before = items.filter((i) => i.sy === s.id && i.r < from);
    const badges: ReviewStory['badges'] = [];
    if (s.first_at >= from) badges.push('new');
    if (s.id === busiest && list.length >= 3) badges.push('busiest');
    if (s.followed_at) badges.push('followed');
    let gapWeeks: number | undefined;
    const recentBefore = before.filter((i) => i.r >= from - 4 * WEEK);
    if (s.first_at < from - 4 * WEEK && recentBefore.length === 0) {
      badges.push('back');
      gapWeeks = before.length ? Math.floor((from - Math.max(...before.map((i) => i.r))) / WEEK) : 12;
    }
    if (perDay.slice(4).every((n) => n === 0) && perDay.slice(0, 4).some((n) => n > 0)) badges.push('quiet');
    out.push({
      id: s.id,
      title: storyTitle(s, s.first_subject),
      items: list.length,
      sources: new Set(list.map((i) => i.s)).size,
      totalItems: s.items,
      firstAt: s.first_at,
      lastAt: s.last_at,
      badges,
      perDay,
      gapWeeks,
    });
  }
  return out.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
}

/** Tag counts per week over the last year, for the most active tags and the biggest movers. */
async function weekTrends(env: Env, from: number, to: number): Promise<ReviewTrends> {
  const WEEKS = 52;
  const yearFrom = from - (WEEKS - 1) * WEEK;
  const [recent, now] = await Promise.all([
    env.DB.prepare('SELECT tag, MAX(label) AS label, COUNT(*) AS n FROM item_tags WHERE received_at >= ? AND received_at < ? GROUP BY tag ORDER BY n DESC LIMIT 30')
      .bind(from - 12 * WEEK, from)
      .all<{ tag: string; label: string; n: number }>(),
    env.DB.prepare('SELECT tag, MAX(label) AS label, COUNT(*) AS n FROM item_tags WHERE received_at >= ? AND received_at < ? GROUP BY tag ORDER BY n DESC LIMIT 40')
      .bind(from, to)
      .all<{ tag: string; label: string; n: number }>(),
  ]);
  const labels = new Map<string, string>();
  for (const t of [...recent.results, ...now.results]) labels.set(t.tag, t.label);
  const tags = [...labels.keys()];
  const counts = new Map<string, number[]>(tags.map((t) => [t, new Array<number>(WEEKS).fill(0)]));
  if (tags.length) {
    const rows = await env.DB.prepare(
      `SELECT tag, CASE WHEN received_at >= ?1 THEN -1 ELSE CAST((?1 - received_at - 1) / ${WEEK} AS INTEGER) END AS ago, COUNT(*) AS n
       FROM item_tags WHERE tag IN (${tags.map((_, i) => `?${i + 4}`).join(',')}) AND received_at >= ?2 AND received_at < ?3 GROUP BY tag, ago`,
    )
      .bind(from, yearFrom, to, ...tags)
      .all<{ tag: string; ago: number; n: number }>();
    for (const r of rows.results) {
      // ago < 0 is the review's own week (after `from`).
      const idx = r.ago < 0 ? WEEKS - 1 : WEEKS - 2 - r.ago;
      const list = counts.get(r.tag);
      if (list && idx >= 0 && idx < WEEKS) list[idx]! += r.n;
    }
  }
  // Weeks before any tag existed show as empty; trim leading weeks where nothing at all was tagged.
  let firstWeek = 0;
  while (firstWeek < WEEKS - 12 && [...counts.values()].every((c) => c[firstWeek] === 0)) firstWeek++;
  const weeks = Array.from({ length: WEEKS - firstWeek }, (_, i) => from - (WEEKS - 1 - firstWeek - i) * WEEK);
  const series = tags.map((tag) => ({ tag, label: labels.get(tag)!, counts: counts.get(tag)!.slice(firstWeek) }));

  // The chart: the 6 tags with most items in the last 12 weeks plus this one.
  const recentSum = (c: number[]) => c.slice(-13).reduce((a, b) => a + b, 0);
  const top = [...series].sort((a, b) => recentSum(b.counts) - recentSum(a.counts)).slice(0, 6);

  // Movers: this week against the 12 weeks before, scaled so small tags can still show.
  const movers: (ReviewMover & { score: number })[] = [];
  for (const s of series) {
    const c = s.counts;
    const nowN = c[c.length - 1]!;
    const prior = c.slice(-13, -1);
    const usual = avg(prior);
    if (nowN + usual < 3) continue;
    const score = (nowN - usual) / Math.sqrt(usual + 1);
    movers.push({ tag: s.tag, label: s.label, now: nowN, usual: round1(usual), note: moverNote(c), score });
  }
  movers.sort((a, b) => b.score - a.score);
  const rising = movers.filter((m) => m.score > 0.8).slice(0, 5);
  const falling = movers.filter((m) => m.score < -0.8).slice(-3).reverse();

  // New tags: at least 2 items this week and none before it in the last year.
  const fresh = now.results.filter((t) => t.n >= 2 && (counts.get(t.tag) ?? []).slice(0, -1).every((n) => n === 0)).slice(0, 8);
  let newTags = fresh.map((t) => ({ tag: t.tag, label: t.label, n: t.n }));
  if (fresh.length) {
    const older = await env.DB.prepare(
      `SELECT DISTINCT tag FROM item_tags WHERE tag IN (${fresh.map(() => '?').join(',')}) AND received_at < ?`,
    )
      .bind(...fresh.map((t) => t.tag), yearFrom)
      .all<{ tag: string }>();
    const seen = new Set(older.results.map((r) => r.tag));
    newTags = newTags.filter((t) => !seen.has(t.tag));
  }
  return {
    weeks,
    tags: top,
    movers: [...rising, ...falling].map(({ score: _s, ...m }) => m),
    newTags,
  };
}

/** "4 weeks rising", "highest in a year"… from a tag's weekly counts (the last is this week). */
function moverNote(c: number[]): string | undefined {
  const n = c.length;
  const nowN = c[n - 1]!;
  let up = 0;
  while (up + 1 < n && c[n - 1 - up]! > c[n - 2 - up]!) up++;
  let down = 0;
  while (down + 1 < n && c[n - 1 - down]! < c[n - 2 - down]!) down++;
  if (up >= 3) return `${up} weeks rising`;
  if (down >= 3) return `${down} weeks falling`;
  const before = c.slice(0, -1);
  if (before.length >= 26 && before.some((x) => x > 0)) {
    if (nowN > Math.max(...before)) return n >= 52 ? 'highest in a year' : `highest in ${n} weeks`;
    if (nowN < Math.min(...before.slice(-26)) ) return 'lowest in 6 months';
  }
  const last12 = before.slice(-12);
  if (last12.length === 12 && nowN > Math.max(...last12)) return 'highest in 12 weeks';
  // Back after a gap: nothing for 4+ weeks before this one.
  if (nowN > 0 && before.slice(-4).every((x) => x === 0) && before.some((x) => x > 0)) return 'back after a gap';
  return undefined;
}

function weekSources(items: Row[], sources: Map<string, SourceInfo>, stars: ReviewStar[], from: number, to: number, tz: string): ReviewSourceChange[] {
  const bySource = new Map<string, Row[]>();
  for (const it of items) {
    if (!it.s) continue;
    const list = bySource.get(it.s) ?? [];
    list.push(it);
    bySource.set(it.s, list);
  }
  const out: (ReviewSourceChange & { rank: number })[] = [];
  const starsBySource = new Map<string, number>();
  for (const s of stars) if (s.sourceName) starsBySource.set(s.sourceName, (starsBySource.get(s.sourceName) ?? 0) + 1);

  for (const src of sources.values()) {
    if (src.paused_at) continue;
    const list = bySource.get(src.id) ?? [];
    const week = list.filter((i) => i.r >= from);
    const read = week.filter((i) => i.rd).length;
    const prior = new Array<number>(12).fill(0);
    for (const i of list) {
      const w = bucketOf(i.r, from, WEEK);
      if (w >= 1 && w <= 12) prior[w - 1]!++;
    }
    const usual = avg(prior);
    if (src.created_at >= from && src.created_at < to) {
      out.push({ id: src.id, name: src.name, kind: 'new', rank: 0, detail: `Added ${shortDate(src.created_at, tz)}. ${plural(week.length, 'post')} so far, you read ${read}.` });
      continue;
    }
    if (src.created_at < from - 4 * WEEK) {
      if (week.length >= Math.max(2 * usual, usual + 5) && usual >= 1) {
        const flood = src.flood_at && src.flood_at >= from ? ` Flood guard archived ${src.flood_count} on ${weekdayName(src.flood_at, tz)}.` : '';
        out.push({ id: src.id, name: src.name, kind: 'busier', rank: 2, detail: `${week.length} posts against a usual ${round1(usual)} a week.${flood}` });
        continue;
      }
      const last2 = list.filter((i) => i.r >= to - 2 * WEEK).length;
      if (usual >= 0.75 && last2 === 0) {
        const last = list.length ? Math.max(...list.map((i) => i.r)) : null;
        out.push({
          id: src.id,
          name: src.name,
          kind: 'quiet',
          rank: 3,
          detail: `Usually about ${round1(usual)} a week; ${last ? `nothing since ${shortDate(last, tz)}` : 'nothing for two weeks'}.`,
        });
        continue;
      }
      const month = list.filter((i) => i.r >= from - 3 * WEEK);
      if (month.length >= 6 && month.every((i) => !i.rd)) {
        out.push({ id: src.id, name: src.name, kind: 'unopened', rank: 4, detail: `${week.length} of its posts this week and ${month.length} in 4 weeks; none read.` });
        continue;
      }
    }
    const starred = starsBySource.get(src.name) ?? 0;
    if (starred >= 2) out.push({ id: src.id, name: src.name, kind: 'starred', rank: 1, detail: `${starred} of your ${stars.length} stars this week.` });
  }
  return out
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 10)
    .map(({ rank: _r, ...c }) => c);
}

// ---------- Monthly ----------

export async function gatherMonth(env: Env, from: number, to: number, settings: AppSettings): Promise<ReviewPack> {
  const tz = settings.timezone;
  const skip = new Set(settings.reviews.skipParts);
  const yearFrom = monthStart(from, tz, -11);
  const [items, reads, starTimes, stars, sources] = await Promise.all([
    loadItems(env, yearFrom, to),
    loadReads(env, monthStart(from, tz, -5), to),
    loadStarTimes(env, monthStart(from, tz, -3), to),
    loadStars(env, from, to),
    loadSources(env),
  ]);
  const months = Array.from({ length: 12 }, (_, i) => monthStart(from, tz, i - 11));
  const monthOf = (t: number) => {
    for (let i = months.length - 1; i >= 0; i--) if (t >= months[i]!) return i;
    return -1;
  };
  const countBy = (times: number[]) => {
    const c = new Array<number>(12).fill(0);
    for (const t of times) {
      const m = monthOf(t);
      if (m >= 0 && t < to) c[m]!++;
    }
    return c;
  };
  const arrivedM = countBy(items.map((i) => i.r));
  const readM = countBy(reads);
  const starM = countBy(starTimes);
  const storiesIn = (m: number) => new Set(items.filter((i) => i.sy && monthOf(i.r) === m).map((i) => i.sy)).size;
  const usual3 = (c: number[]) => round1(avg(c.slice(8, 11)));

  const buckets: ReviewBucket[] = months.slice(6).map((at, i) => ({ at, label: monthName(at + 15 * DAY, tz), arrived: arrivedM[6 + i]!, read: readM[6 + i]! }));
  const share = (b: ReviewBucket) => pct(b.read, b.arrived);
  const shares = buckets.map(share);
  const lowest = Math.min(...shares.filter((s, i) => buckets[i]!.arrived > 0));
  const last = buckets[buckets.length - 1]!;
  const firstB = buckets.find((b) => b.arrived > 0);
  let note = '';
  if (firstB && firstB !== last) {
    note = `${last.arrived} arrived and ${last.read} read in ${monthName(last.at + DAY, tz, 'long')}, against ${firstB.arrived} and ${firstB.read} in ${monthName(firstB.at + DAY, tz, 'long')}.`;
    if (share(last) === lowest && shares.filter((s) => s > 0).length >= 3) note += ` Read share is at a ${buckets.length}-month low of ${share(last)}%.`;
    else note += ` You read ${share(last)}% of what arrived.`;
  }

  const pack: ReviewPack = {
    label: new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: 'long', year: 'numeric' }).format(new Date(from + DAY)),
    usualLabel: 'the 3 months before',
    counts: {
      arrived: { now: arrivedM[11]!, usual: usual3(arrivedM) },
      read: { now: readM[11]!, usual: usual3(readM) },
      stars: { now: starM[11]!, usual: usual3(starM) },
      stories: { now: storiesIn(11), usual: round1(avg([8, 9, 10].map(storiesIn))) },
    },
    stars,
    reading: { buckets, note },
  };
  if (!skip.has('arcs')) pack.arcs = await monthArcs(env, to);
  if (!skip.has('interests')) pack.interests = await monthInterests(env, months, to, tz);
  if (!skip.has('sourceReview')) pack.sourceReview = monthSources(items, sources, from, to, tz);
  if (!skip.has('categories')) pack.categories = await monthCategories(env, items, sources, settings, from, to);
  return pack;
}

/** Every story active in the last 26 weeks, as a run of weekly counts. */
async function monthArcs(env: Env, to: number): Promise<ReviewArc[]> {
  const WEEKS = 26;
  const start = to - WEEKS * WEEK;
  const stories = await env.DB.prepare(
    `SELECT stories.id, stories.title, stories.tags, stories.first_at, stories.last_at, stories.items, stories.closed_at,
       (SELECT subject FROM items WHERE items.story_id = stories.id ORDER BY received_at LIMIT 1) AS first_subject
     FROM stories INDEXED BY stories_last WHERE last_at >= ? AND items >= 4 ORDER BY items DESC LIMIT 10`,
  )
    .bind(start)
    .all<{ id: string; title: string | null; tags: string | null; first_at: number; last_at: number; items: number; closed_at: number | null; first_subject: string | null }>();
  if (stories.results.length === 0) return [];
  const ids = stories.results.map((s) => s.id);
  const rows = await env.DB.prepare(
    `SELECT story_id, received_at FROM items INDEXED BY items_story WHERE story_id IS NOT NULL AND story_id IN (${ids.map(() => '?').join(',')}) AND received_at >= ? AND status != 'dropped'`,
  )
    .bind(...ids, start)
    .all<{ story_id: string; received_at: number }>();
  return stories.results
    .map((s) => {
      const perWeek = new Array<number>(WEEKS).fill(0);
      for (const r of rows.results) if (r.story_id === s.id) perWeek[Math.min(WEEKS - 1, Math.floor((r.received_at - start) / WEEK))]!++;
      const firstW = perWeek.findIndex((n) => n > 0);
      const active = perWeek.slice(firstW < 0 ? 0 : firstW);
      let gap = 0;
      let run = 0;
      for (const n of active) {
        run = n === 0 ? run + 1 : 0;
        if (n > 0) continue;
        gap = Math.max(gap, run);
      }
      const ended = Boolean(s.closed_at) || s.last_at < to - 30 * DAY;
      // A gap counts only when the story picked up again after it.
      const lastActive = perWeek.length - 1 - [...perWeek].reverse().findIndex((n) => n > 0);
      const gapClosed = gap >= 4 && active.slice(0, lastActive - (firstW < 0 ? 0 : firstW)).some((n) => n === 0);
      const status: ReviewArc['status'] = ended ? 'ended' : gapClosed ? 'back' : 'running';
      return { id: s.id, title: storyTitle(s, s.first_subject), firstAt: s.first_at, lastAt: s.last_at, perWeek, status, items: s.items };
    })
    .sort((a, b) => a.firstAt - b.firstAt);
}

/** Share of what you read carrying each of your top tags, month by month, plus where reading and stars disagree. */
async function monthInterests(env: Env, months: number[], to: number, tz: string): Promise<ReviewInterests> {
  const yearFrom = months[0]!;
  const top = await env.DB.prepare(
    `SELECT t.tag, MAX(t.label) AS label, COUNT(*) AS n FROM item_tags t JOIN items i ON i.id = t.item_id
     WHERE t.received_at >= ? AND t.received_at < ? AND i.read_at IS NOT NULL GROUP BY t.tag ORDER BY n DESC LIMIT 6`,
  )
    .bind(yearFrom, to)
    .all<{ tag: string; label: string; n: number }>();
  const tags = top.results;
  const notes: ReviewInterests['notes'] = [];
  if (tags.length === 0) return { months, tags: [], notes };
  const [rows, readItems, gapRows] = await Promise.all([
    env.DB.prepare(
      `SELECT t.tag, t.received_at FROM item_tags t JOIN items i ON i.id = t.item_id
       WHERE t.tag IN (${tags.map(() => '?').join(',')}) AND t.received_at >= ? AND t.received_at < ? AND i.read_at IS NOT NULL`,
    )
      .bind(...tags.map((t) => t.tag), yearFrom, to)
      .all<{ tag: string; received_at: number }>(),
    env.DB.prepare("SELECT received_at FROM items INDEXED BY items_received WHERE received_at >= ? AND received_at < ? AND read_at IS NOT NULL AND kind != 'ai'")
      .bind(yearFrom, to)
      .all<{ received_at: number }>(),
    env.DB.prepare(
      `SELECT t.tag, MAX(t.label) AS label, SUM(i.read_at IS NOT NULL) AS reads, SUM(i.interesting_at IS NOT NULL) AS stars
       FROM item_tags t JOIN items i ON i.id = t.item_id WHERE t.received_at >= ? AND t.received_at < ? GROUP BY t.tag
       HAVING SUM(i.interesting_at IS NOT NULL) >= 1 OR SUM(i.read_at IS NOT NULL) >= 8`,
    )
      .bind(months[9]!, to)
      .all<{ tag: string; label: string; reads: number; stars: number }>(),
  ]);
  const monthOf = (t: number) => {
    for (let i = months.length - 1; i >= 0; i--) if (t >= months[i]!) return i;
    return -1;
  };
  const totals = new Array<number>(12).fill(0);
  for (const r of readItems.results) totals[monthOf(r.received_at)]!++;
  const series = tags.map((t) => {
    const c = new Array<number>(12).fill(0);
    for (const r of rows.results) if (r.tag === t.tag) c[monthOf(r.received_at)]!++;
    return { tag: t.tag, label: t.label, shares: c.map((n, i) => pct(n, totals[i]!)) };
  });
  // Trimmed to months with any reading.
  const first = totals.findIndex((n) => n > 0);
  const keep = first < 0 ? 0 : Math.min(first, 9);
  const trimmed = series.map((s) => ({ ...s, shares: s.shares.slice(keep) }));

  const streak = (xs: number[], dir: 1 | -1) => {
    let n = 0;
    for (let i = xs.length - 1; i > 0 && dir * (xs[i]! - xs[i - 1]!) > 0; i--) n++;
    return n;
  };
  const rising = trimmed.filter((s) => streak(s.shares, 1) >= 3).map((s) => s.label);
  const fading = trimmed.filter((s) => streak(s.shares, -1) >= 3).map((s) => s.label);
  if (rising.length) notes.push({ label: 'Rising for 3+ months', text: rising.join(', ') });
  if (fading.length) notes.push({ label: 'Fading for 3+ months', text: fading.join(', ') });

  const sums = await env.DB.prepare(
    "SELECT SUM(read_at IS NOT NULL) AS reads, SUM(interesting_at IS NOT NULL) AS stars FROM items INDEXED BY items_received WHERE received_at >= ? AND received_at < ? AND kind != 'ai'",
  )
    .bind(months[9]!, to)
    .first<{ reads: number | null; stars: number | null }>();
  const readSum = sums?.reads ?? 0;
  const starSum = sums?.stars ?? 0;
  if (starSum >= 5 && readSum > 0) {
    const g = gapRows.results.map((r) => ({ label: r.label, read: pct(r.reads, readSum), star: pct(r.stars, starSum) }));
    const readMore = [...g].sort((a, b) => b.read - b.star - (a.read - a.star))[0];
    const starMore = [...g].sort((a, b) => b.star - b.read - (a.star - a.read))[0];
    if (readMore && readMore.read - readMore.star >= 5)
      notes.push({ label: 'Read a lot, starred little', text: `${readMore.label} (${readMore.read}% of reading, ${readMore.star}% of stars)` });
    if (starMore && starMore.star - starMore.read >= 5)
      notes.push({ label: 'Starred a lot, read little', text: `${starMore.label} (${starMore.read}% of reading, ${starMore.star}% of stars)` });
  }
  void tz;
  return { months: months.slice(keep), tags: trimmed, notes };
}

function monthSources(items: Row[], sources: Map<string, SourceInfo>, from: number, to: number, tz: string): ReviewSourceRow[] {
  const threeFrom = to - 91 * DAY;
  const bySource = new Map<string, Row[]>();
  for (const it of items) {
    if (!it.s || it.r < threeFrom) continue;
    const list = bySource.get(it.s) ?? [];
    list.push(it);
    bySource.set(it.s, list);
  }
  let allPosts = 0;
  let allRead = 0;
  for (const l of bySource.values()) {
    allPosts += l.length;
    allRead += l.filter((i) => i.rd).length;
  }
  const avgShare = pct(allRead, allPosts);
  const rows: (ReviewSourceRow & { rank: number })[] = [];
  const starTop = [...bySource.entries()]
    .map(([id, l]) => ({ id, stars: l.filter((i) => i.st).length }))
    .sort((a, b) => b.stars - a.stars)[0];
  for (const [id, list] of bySource) {
    const src = sources.get(id);
    if (!src || src.paused_at) continue;
    const posts = list.length;
    const read = list.filter((i) => i.rd).length;
    const stars = list.filter((i) => i.st).length;
    const lastMonth = list.filter((i) => i.r >= from).length;
    const share = pct(read, posts);
    const base = `${plural(posts, 'post')}, read ${read} (${share}%), ${plural(stars, 'star')}.`;
    if (starTop && starTop.id === id && stars >= 3) rows.push({ id, name: src.name, verdict: 'best', rank: 0, detail: `${base} Your most starred source.` });
    else if (src.created_at >= to - 60 * DAY && posts >= 3 && share > avgShare)
      rows.push({ id, name: src.name, verdict: 'settling', rank: 1, detail: `Added ${shortDate(src.created_at, tz)}. Read share ${share}%, above your ${avgShare}% average.` });
    else if (posts >= 10 && read === 0) rows.push({ id, name: src.name, verdict: 'unopened', rank: 3, detail: `${base} Pause it, or add a post filter?` });
    else if (posts >= 60 && share < 10 && stars === 0) rows.push({ id, name: src.name, verdict: 'low', rank: 2, detail: `${base} Pause it, or add a post filter?` });
    else if (lastMonth === 0 && posts >= 4) {
      const last = Math.max(...list.map((i) => i.r));
      rows.push({ id, name: src.name, verdict: 'quiet', rank: 4, detail: `Last post ${shortDate(last, tz)}; it had ${posts} in the two months before. Check it still arrives.` });
    }
  }
  return rows
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 10)
    .map(({ rank: _r, ...r }) => r);
}

/** Suggestions where the categories don't seem to fit: worked out from the AI's own category per item and the tags. */
async function monthCategories(
  env: Env,
  items: Row[],
  sources: Map<string, SourceInfo>,
  settings: AppSettings,
  from: number,
  to: number,
): Promise<CategorySuggestion[]> {
  const threeFrom = to - 91 * DAY;
  const recent = items.filter((i) => i.r >= threeFrom);
  const out: CategorySuggestion[] = [];
  const known = new Set(settings.categories.map((c) => c.toLowerCase()));
  const same = (a: string | null, b: string | null) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

  // A source whose posts the AI mostly puts in another category; or a share of them that would fit elsewhere.
  const bySource = new Map<string, Row[]>();
  for (const it of recent) if (it.s && it.scat) bySource.set(it.s, [...(bySource.get(it.s) ?? []), it]);
  for (const [id, list] of bySource) {
    const src = sources.get(id);
    if (!src?.category) continue;
    const judged = list.filter((i) => i.acat && !i.icat);
    if (judged.length < 10) continue;
    const counts = new Map<string, number>();
    for (const i of judged) counts.set(i.acat!, (counts.get(i.acat!) ?? 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const [topCat, topN] = ranked[0]!;
    const mix = ranked.slice(0, 4).map(([label, n]) => ({ label, n }));
    if (!same(topCat, src.category) && topN / judged.length >= 0.6) {
      out.push({
        id: `move:${id}`,
        kind: 'move_source',
        title: `Move "${src.name}" from ${src.category} to ${topCat}?`,
        why: `The AI put ${topN} of its ${judged.length} posts in the last 3 months in ${topCat}; only ${counts.get(src.category) ?? 0} in ${src.category}.`,
        sourceId: id,
        from: src.category,
        to: topCat,
        mix,
      });
      continue;
    }
    const other = ranked.find(([c, n]) => !same(c, src.category) && n >= 8 && n / judged.length >= 0.3);
    if (other) {
      const moving = judged.filter((i) => same(i.acat, other[0]) && i.r >= from);
      if (moving.length >= 4)
        out.push({
          id: `else:${id}:${other[0]}`,
          kind: 'elsewhere',
          title: `${moving.length} of last month's ${src.category} items from "${src.name}" look like ${other[0]}`,
          why: `Over 3 months the AI put ${other[1]} of its ${judged.length} posts in ${other[0]}. Moving them changes only these items; its new posts stay in ${src.category}.`,
          sourceId: id,
          from: src.category,
          to: other[0],
          itemIds: moving.slice(0, 200).map((i) => i.id),
          mix,
        });
    }
  }

  // A tag spread across several categories, big enough to be a category of its own.
  const spread = await env.DB.prepare(
    `SELECT t.tag, MAX(t.label) AS label, COALESCE(i.category, s.category, json_extract(i.ai_category, '$[0]'), 'Other') AS cat, COUNT(*) AS n
     FROM item_tags t JOIN items i ON i.id = t.item_id LEFT JOIN sources s ON s.id = i.source_id
     WHERE t.received_at >= ? AND t.received_at < ? AND t.tag IN (
       SELECT tag FROM item_tags WHERE received_at >= ? AND received_at < ? GROUP BY tag HAVING COUNT(*) >= 15 ORDER BY COUNT(*) DESC LIMIT 25)
     GROUP BY t.tag, cat`,
  )
    .bind(threeFrom, to, threeFrom, to)
    .all<{ tag: string; label: string; cat: string; n: number }>();
  const byTag = new Map<string, { label: string; cats: { label: string; n: number }[] }>();
  for (const r of spread.results) {
    const e = byTag.get(r.tag) ?? { label: r.label, cats: [] };
    e.cats.push({ label: r.cat, n: r.n });
    byTag.set(r.tag, e);
  }
  const fresh = [...byTag.entries()]
    .map(([tag, e]) => ({ tag, ...e, total: e.cats.reduce((a, c) => a + c.n, 0) }))
    .filter((e) => e.cats.length >= 3 && Math.max(...e.cats.map((c) => c.n)) / e.total < 0.5 && !known.has(e.label.toLowerCase()) && !known.has(e.tag))
    .sort((a, b) => b.total - a.total)
    .slice(0, 2);
  for (const e of fresh) {
    const name = titleCase(e.label).slice(0, 40);
    const cats = [...e.cats].sort((a, b) => b.n - a.n);
    out.push({
      id: `new:${e.tag}`,
      kind: 'new_category',
      title: `Start a category "${name}"?`,
      why: `${e.total} items tagged ${e.label} in 3 months are spread over ${cats
        .slice(0, 4)
        .map((c) => `${c.label} (${c.n})`)
        .join(', ')}. Adding it lets the AI pick it for new items from sources that have no category of their own.`,
      tag: e.tag,
      to: name,
      mix: cats.slice(0, 4),
    });
  }

  // Categories that have almost emptied.
  const monthCount = new Map<string, number>();
  const earlierCount = new Map<string, number>();
  for (const it of recent) {
    const key = it.cat.toLowerCase();
    (it.r >= from ? monthCount : earlierCount).set(key, ((it.r >= from ? monthCount : earlierCount).get(key) ?? 0) + 1);
  }
  for (const c of settings.categories) {
    if (c.toLowerCase() === 'other') continue;
    const now = monthCount.get(c.toLowerCase()) ?? 0;
    const before = (earlierCount.get(c.toLowerCase()) ?? 0) / 2;
    if (now <= 4 && before >= 10)
      out.push({
        id: `empty:${c}`,
        kind: 'near_empty',
        title: `"${c}" had ${plural(now, 'item')} this month`,
        why: `Down from about ${Math.round(before)} a month before. Taking it off the list stops the AI choosing it; items already in it keep their category.`,
        from: c,
      });
  }
  void tagKey;
  // The clearest first, and no more than two of the item-by-item kind.
  const order: CategorySuggestion['kind'][] = ['move_source', 'new_category', 'near_empty', 'elsewhere'];
  const elsewhere = out.filter((x) => x.kind === 'elsewhere').sort((a, b) => (b.itemIds?.length ?? 0) - (a.itemIds?.length ?? 0)).slice(0, 2);
  return [...out.filter((x) => x.kind !== 'elsewhere'), ...elsewhere].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, 6);
}
