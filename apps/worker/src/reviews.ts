import {
  markdownToHtml,
  type CategorySuggestion,
  type FindingKind,
  type Review,
  type ReviewComing,
  type ReviewFinding,
  type ReviewJob,
  type ReviewKind,
  type ReviewListItem,
  type ReviewPack,
  type ReviewQuality,
  type ReviewResult,
  type ReviewStatus,
  type ReviewWritten,
} from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { dayKey, localHour } from './digest';
import type { AppVariables, Env } from './env';
import { deviceOf, markRead } from './api';
import { aiSourceId } from './highlights';
import { newId, now } from './ids';
import { dayStart } from './reading';
import { gatherMonth, gatherWeek, monthStart } from './reviews-pack';
import { loadSettings, saveSettings } from './settings';
import { countSearches, searchAllowance } from './websearch';

// Weekly and monthly reviews. They replaced the daily digest. The hourly cron
// builds one when it is due (Settings > Reviews): the Worker gathers the facts
// (reviews-pack.ts) and stores them at once, so the Review tab has its charts
// and lists straight away; the PC helper then claims it, writes the opening,
// story lines and the stars' common thread with the local model, and runs a
// few web searches for new information and connections. Find more asks the
// PC for a few more searches on the same review.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const DAY = 86_400_000;
const LEASE_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;
const MORE_SEARCHES: Record<ReviewKind, number> = { week: 3, month: 5 };

interface ReviewRow {
  id: string;
  kind: ReviewKind;
  period: string;
  from_at: number;
  to_at: number;
  created_at: number;
  pack: string;
  written: string | null;
  status: ReviewStatus;
  claimed_at: number | null;
  attempts: number;
  error: string | null;
  more_wanted: number;
  seconds: number | null;
  read_at: number | null;
  inbox_item_id: string | null;
}

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

type StoredPack = ReviewPack & { skipParts?: Review['skipParts']; chartWeeks?: Review['chartWeeks'] };

function toReview(row: ReviewRow): Review {
  const pack = parse<StoredPack>(row.pack, {} as StoredPack);
  return {
    id: row.id,
    kind: row.kind,
    period: row.period,
    fromAt: row.from_at,
    toAt: row.to_at,
    createdAt: row.created_at,
    pack,
    written: parse<ReviewWritten>(row.written, {}),
    status: row.status,
    error: row.error,
    readAt: row.read_at,
    moreWanted: row.more_wanted,
    skipParts: pack.skipParts ?? [],
    chartWeeks: pack.chartWeeks ?? 12,
  };
}

// ---------- Building ----------

/** The local weekday (0 = Sunday) and day of the month at an instant. */
function localDate(at: number, timezone: string): { weekday: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', day: 'numeric' }).formatToParts(new Date(at));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value ?? 'Sun');
  return { weekday: Math.max(0, weekday), day: Number(parts.find((p) => p.type === 'day')?.value ?? 1) };
}

/** The window and key for a review built at `at`: the 7 local days ending now, or the calendar month before. */
export function reviewWindow(kind: ReviewKind, at: number, timezone: string): { from: number; to: number; period: string } {
  if (kind === 'week') {
    const today = dayKey(at, timezone);
    const [y = 1970, m = 1, d = 1] = today.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, d - 6)).toISOString().slice(0, 10);
    return { from: dayStart(first, timezone), to: at, period: today };
  }
  const from = monthStart(at, timezone, -1);
  return { from, to: monthStart(at, timezone, 0), period: dayKey(from + DAY, timezone).slice(0, 7) };
}

/** Builds (or rebuilds) a review and queues it for the PC. */
export async function buildReview(env: Env, kind: ReviewKind, at = now()): Promise<Review> {
  const settings = await loadSettings(env);
  const { from, to, period } = reviewWindow(kind, at, settings.timezone);
  const gathered = kind === 'week' ? await gatherWeek(env, from, to, settings) : await gatherMonth(env, from, to, settings);
  const pack: StoredPack = { ...gathered, skipParts: settings.reviews.skipParts, chartWeeks: settings.reviews.chartWeeks };
  const t = now();
  await env.DB.prepare(
    `INSERT INTO reviews (id, kind, period, from_at, to_at, created_at, pack, written, status, attempts, error, more_wanted, seconds, read_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, 'waiting', 0, NULL, 0, NULL, NULL)
     ON CONFLICT(kind, period) DO UPDATE SET from_at = ?4, to_at = ?5, created_at = ?6, pack = ?7, written = NULL, status = 'waiting',
       claimed_at = NULL, attempts = 0, error = NULL, more_wanted = 0, seconds = NULL, read_at = NULL`,
  )
    .bind(newId(), kind, period, from, to, t, JSON.stringify(pack))
    .run();
  const row = await env.DB.prepare('SELECT * FROM reviews WHERE kind = ? AND period = ?').bind(kind, period).first<ReviewRow>();
  return toReview(row!);
}

/** Called by the hourly cron: builds the weekly and monthly reviews when their time comes round. */
export async function buildReviewsIfDue(env: Env): Promise<void> {
  const settings = await loadSettings(env);
  const r = settings.reviews;
  if (!r.weekly && !r.monthly) return;
  const at = now();
  if (localHour(at, settings.timezone) !== r.hour) return;
  const { weekday, day } = localDate(at, settings.timezone);
  const due: ReviewKind[] = [];
  if (r.weekly && weekday === r.weekDay) due.push('week');
  if (r.monthly && day === 1) due.push('month');
  for (const kind of due) {
    const { period } = reviewWindow(kind, at, settings.timezone);
    const exists = await env.DB.prepare('SELECT 1 AS x FROM reviews WHERE kind = ? AND period = ?').bind(kind, period).first();
    if (!exists) await buildReview(env, kind, at).catch((err: unknown) => console.error(`building the ${kind} review failed`, err));
  }
}

/** For the helper's check-in: whether a review is waiting to be written. */
export async function reviewHeartbeat(env: Env, paused: boolean): Promise<{ reviewWaiting?: boolean }> {
  if (paused) return {};
  const row = await env.DB.prepare(
    "SELECT 1 AS x FROM reviews WHERE status IN ('waiting', 'working') AND (status = 'waiting' OR claimed_at < ?) LIMIT 1",
  )
    .bind(now() - LEASE_MS)
    .first();
  return row ? { reviewWaiting: true } : {};
}

// ---------- The PC's job ----------

const WRITE_RULES = `Reply with JSON only, in this shape:
{
  "opening": "...",
  "stories": [{"id": "story id from the facts", "line": "..."}],
  "thread": "...",
  {starsField}"coming": [{"date": "YYYY-MM-DD or YYYY-MM", "what": "...", "item": 0}],
  "questions": [{"q": "...", "kind": "...", "about": "..."}]
}
- "stories": one plain sentence per story listed in the facts on what changed in it {period}, from its recent items. Only use the story ids given.
- "thread": one sentence on what the starred items have in common; empty if fewer than 2 stars.
- "coming": dated events after {today} that the summaries mention (launches, votes, results, deadlines), at most 6; "item" is the number of the item that mentions it. [] if none.
- "questions": up to {n} questions worth a web search. Kinds: {kinds}
- Write plainly, like a well-read friend. No greetings, no lists inside strings, no markdown.`;

const KINDS_WEEK = `"new" (what has happened since the reader's sources were written), "link" (a possible connection between two of the reader's stories or topics: name both in "about" joined by " + "), "background" (a term or thing the reader may not know; keep "q" to the term itself, 1-4 words), "check" (a fact the sources might disagree on).`;
const KINDS_MONTH = `"next" (what happened next to an older starred item or a long-running story), "link" (a connection between two of the reader's stories or topics: name both in "about" joined by " + "), "background" (a new topic the reader may not know; keep "q" to the term itself, 1-4 words), "new" (the latest on a topic that grew this month).`;

const WRITE_PROMPT: Record<ReviewKind, string> = {
  week: `You write a short weekly review for one reader of their own newsletters, feeds and saved pages. You get facts gathered from their reading app: counts against their usual week, the top stories, stories that moved, topic trends, source changes, starred items and recent summaries.

"opening": 3 or 4 sentences on what the week was about for this reader: the main stories, the topics that rose or fell, what they starred. Use the numbers given.

${WRITE_RULES}`,
  month: `You write a monthly review for one reader of their own newsletters, feeds and saved pages. The monthly review takes the longer view: how stories ran over months, how the reader's interests are shifting, how their sources are doing. You get facts gathered from their reading app.

"opening": 4 or 5 sentences on the month in the context of the months before: which interests are growing or fading, which stories lasted, how much of what arrives gets read. Use the numbers given.
"stars_say": 2 sentences on what this month's stars say about where the reader's interests are going, compared with earlier months.

${WRITE_RULES}`,
};

const QUESTION_PROMPT = `You help with a reader's {kind} review. From the facts, suggest up to {n} new questions worth a web search that are NOT already in the list of questions asked. Kinds: {kinds}
Reply with JSON only: {"questions": [{"q": "...", "kind": "...", "about": "..."}]}`;

const FIND_PROMPT = `You answer one question for a reader's {kind} review, using only the search results given. Reply with JSON only:
{"answer": "2 or 3 plain sentences: what is new, or how the things connect", "sources": [numbers of the results you used], "useful": true, "bridge": ["first story or topic", "what links them, 2 to 4 words", "second story or topic"]}
- "bridge" only for a "link" question; otherwise [].
- "useful": false when the results don't answer the question or only repeat what the reader already knows.
- Never invent facts or links that are not in the results.`;

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

interface ItemFact {
  id: string;
  subject: string;
  source_name: string | null;
  received_at: number;
  summary: string | null;
  preheader: string | null;
  story_note: string | null;
}

const FACT_SELECT = `SELECT items.id, items.subject, COALESCE(sources.name, items.from_name) AS source_name, items.received_at, items.summary, items.preheader, items.story_note
  FROM items LEFT JOIN sources ON sources.id = items.source_id`;

/** The facts for the model, with items numbered so it can point back at them. Returns the numbering too. */
async function jobText(env: Env, review: Review, timezone: string): Promise<{ text: string; numbered: string[] }> {
  const p = review.pack;
  const numbered: string[] = [];
  const num = (id: string) => {
    let i = numbered.indexOf(id);
    if (i < 0) i = numbered.push(id) - 1;
    return i + 1;
  };
  const date = (t: number) => dayKey(t, timezone);
  const line = (f: ItemFact) => `[${num(f.id)}] ${date(f.received_at)} ${clip(f.subject, 140)} (${f.source_name ?? 'unknown'}): ${clip(f.summary ?? f.preheader, 260)}`;
  const out: string[] = [];
  const c = p.counts;
  const vs = (x: { now: number; usual: number }) => `${x.now} (usual ${x.usual})`;
  out.push(
    `${review.kind === 'week' ? 'Week' : 'Month'}: ${p.label}. Today is ${date(now())}.`,
    `Counts, against ${p.usualLabel}: arrived ${vs(c.arrived)}, read ${vs(c.read)}, starred ${vs(c.stars)}, stories active ${vs(c.stories)}.`,
  );
  if (p.top?.length) {
    out.push('', 'Top stories:');
    for (const s of p.top)
      out.push(`[${num(s.itemId)}] ${clip(s.subject, 140)} (${s.sourceName ?? 'unknown'}): ${clip(s.summary, 260)}${s.more.length ? ` Also covered by: ${s.more.map((m) => m.sourceName ?? m.subject).join(', ')}` : ''}`);
  }
  if (p.stories?.length) {
    const ids = p.stories.map((s) => s.id);
    const rows = await env.DB.prepare(
      `${FACT_SELECT.replace('FROM items', 'FROM items INDEXED BY items_story')} WHERE items.story_id IS NOT NULL AND items.story_id IN (${ids.map(() => '?').join(',')})
         AND items.received_at >= ? AND items.received_at < ? ORDER BY items.received_at DESC LIMIT 60`,
    )
      .bind(...ids, review.fromAt, review.toAt)
      .all<ItemFact & { story_id?: string }>();
    const withStory = await env.DB.prepare(
      `SELECT id, story_id FROM items INDEXED BY items_story WHERE story_id IS NOT NULL AND story_id IN (${ids.map(() => '?').join(',')}) AND received_at >= ? AND received_at < ?`,
    )
      .bind(...ids, review.fromAt, review.toAt)
      .all<{ id: string; story_id: string }>();
    const storyOf = new Map(withStory.results.map((r) => [r.id, r.story_id]));
    out.push('', 'Stories that moved (id, title, items this period):');
    for (const s of p.stories) {
      out.push(`- story ${s.id}: "${s.title}", ${s.items} items from ${s.sources} sources${s.badges.length ? ` [${s.badges.join(', ')}]` : ''}`);
      for (const f of rows.results.filter((r) => storyOf.get(r.id) === s.id).slice(0, 5)) out.push(`  ${line(f)}${f.story_note ? ` New in it: ${clip(f.story_note, 160)}` : ''}`);
    }
  }
  if (p.trends) {
    const t = p.trends;
    const rising = t.movers.filter((m) => m.now > m.usual);
    const falling = t.movers.filter((m) => m.now < m.usual);
    out.push('', 'Topic trends (items per week; usual = average of the 12 weeks before):');
    if (rising.length) out.push(`Rising: ${rising.map((m) => `${m.label} ${m.now} vs ${m.usual}${m.note ? `, ${m.note}` : ''}`).join('; ')}`);
    if (falling.length) out.push(`Falling: ${falling.map((m) => `${m.label} ${m.now} vs ${m.usual}${m.note ? `, ${m.note}` : ''}`).join('; ')}`);
    if (t.newTags.length) out.push(`New tags: ${t.newTags.map((x) => x.label).join(', ')}`);
  }
  if (p.interests) {
    out.push('', 'Interests over the year (share of reading per tag, oldest month first):');
    for (const s of p.interests.tags) out.push(`- ${s.label}: ${s.shares.join('%, ')}%`);
    for (const n of p.interests.notes) out.push(`${n.label}: ${n.text}`);
  }
  if (p.arcs?.length) {
    out.push('', 'Stories over the last 6 months:');
    for (const a of p.arcs) out.push(`- "${a.title}": ${a.items} items, ${date(a.firstAt)} to ${date(a.lastAt)}, ${a.status}`);
  }
  const srcs = p.sources ?? p.sourceReview;
  if (srcs?.length) {
    out.push('', 'Sources:');
    for (const s of srcs) out.push(`- ${s.name} (${'kind' in s ? s.kind : s.verdict}): ${s.detail}`);
  }
  if (p.stars.length) {
    const ids = p.stars.map((s) => s.itemId).slice(0, 15);
    const rows = await env.DB.prepare(`${FACT_SELECT} WHERE items.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<ItemFact>();
    out.push('', 'Starred this period:');
    for (const f of rows.results) out.push(line(f));
  }
  if (review.kind === 'month') {
    // Older stars, for "what happened next".
    const rows = await env.DB.prepare(
      `${FACT_SELECT} WHERE items.interesting_at >= ? AND items.interesting_at < ? AND items.status != 'dropped' ORDER BY items.interesting_at DESC LIMIT 10`,
    )
      .bind(review.fromAt - 60 * DAY, review.fromAt)
      .all<ItemFact>();
    if (rows.results.length) {
      out.push('', 'Starred 1 to 3 months ago:');
      for (const f of rows.results) out.push(line(f));
    }
  }
  // Recent summaries with the most going for them, for spotting dates.
  const recent = await env.DB.prepare(
    `${FACT_SELECT} WHERE items.received_at >= ? AND items.received_at < ? AND items.status IN ('inbox', 'archived') AND items.kind != 'ai'
       AND items.summary IS NOT NULL ORDER BY COALESCE(items.score, 0) DESC LIMIT 30`,
  )
    .bind(Math.max(review.fromAt, review.toAt - 14 * DAY), review.toAt)
    .all<ItemFact>();
  out.push('', 'Recent summaries:');
  for (const f of recent.results) out.push(line(f));
  return { text: out.join('\n').slice(0, 40_000), numbered };
}

async function claimJob(env: Env): Promise<ReviewJob | null> {
  const t = now();
  // Leases that ran out go back in the queue, or are given up after a few tries.
  await env.DB.prepare(
    `UPDATE reviews SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'waiting' END,
       error = CASE WHEN attempts >= ? THEN COALESCE(error, 'Timed out on the PC') ELSE error END
     WHERE status = 'working' AND claimed_at < ?`,
  )
    .bind(MAX_ATTEMPTS, MAX_ATTEMPTS, t - LEASE_MS)
    .run();
  const row = await env.DB.prepare("SELECT * FROM reviews WHERE status = 'waiting' ORDER BY created_at DESC LIMIT 1").first<ReviewRow>();
  if (!row) return null;
  const claimed = await env.DB.prepare("UPDATE reviews SET status = 'working', claimed_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'waiting'")
    .bind(t, row.id)
    .run();
  if (!claimed.meta.changes) return null;
  const review = toReview(row);
  const settings = await loadSettings(env);
  const mode: ReviewJob['mode'] = row.written && review.written.writtenAt ? 'more' : 'write';
  const wanted = mode === 'more' ? row.more_wanted : review.kind === 'week' ? settings.reviews.weeklySearches : settings.reviews.monthlySearches;
  const allowed = review.skipParts.includes('further') && mode === 'write' ? 0 : Math.min(wanted, (await searchAllowance(env)).summaries);
  const { text, numbered } = await jobText(env, review, settings.timezone);
  await env.DB.prepare('UPDATE reviews SET written = ? WHERE id = ?')
    .bind(JSON.stringify({ ...review.written, numbered } satisfies ReviewWritten & { numbered: string[] }), row.id)
    .run();
  const kinds = review.kind === 'week' ? KINDS_WEEK : KINDS_MONTH;
  const fill = (s: string) =>
    s
      .replace('{starsField}', review.kind === 'month' ? '"stars_say": "...",\n  ' : '')
      .replace('{period}', review.kind === 'week' ? 'this week' : 'this month')
      .replace('{today}', dayKey(review.toAt, settings.timezone))
      .replace('{n}', String(Math.max(allowed, 3)))
      .replace('{kinds}', kinds)
      .replace(/\{kind\}/g, review.kind === 'week' ? 'weekly' : 'monthly');
  return {
    reviewId: row.id,
    kind: review.kind,
    mode,
    writePrompt: fill(WRITE_PROMPT[review.kind]),
    questionPrompt: fill(QUESTION_PROMPT),
    findPrompt: fill(FIND_PROMPT),
    text,
    searches: allowed,
    further: !review.skipParts.includes('further'),
    asked: (review.written.findings ?? []).map((f) => f.question),
  };
}

const KINDS: FindingKind[] = ['new', 'link', 'background', 'check', 'next'];

async function saveResult(env: Env, r: ReviewResult): Promise<void> {
  const row = await env.DB.prepare('SELECT * FROM reviews WHERE id = ?').bind(String(r.reviewId)).first<ReviewRow>();
  if (!row) return;
  const review = toReview(row);
  const old = review.written as ReviewWritten & { numbered?: string[] };
  const seconds = (row.seconds ?? 0) + (Number(r.seconds) || 0);
  if (!r.ok) {
    const failed = row.attempts >= MAX_ATTEMPTS;
    await env.DB.prepare('UPDATE reviews SET status = ?, error = ?, seconds = ?, claimed_at = NULL WHERE id = ?')
      .bind(failed ? 'failed' : 'waiting', clip(r.error ?? 'The PC could not write it', 300), seconds, row.id)
      .run();
    return;
  }
  const w = r.written ?? {};
  const storyIds = new Set((review.pack.stories ?? []).map((s) => s.id));
  const numbered = old.numbered ?? [];
  const coming: ReviewComing[] = (w.coming ?? [])
    .filter((x) => x && /^\d{4}-\d{2}(-\d{2})?$/.test(String(x.date)) && typeof x.what === 'string' && x.what.trim())
    .map((x) => {
      const n = Number((x as { item?: unknown }).item ?? x.itemId);
      const id = Number.isInteger(n) && n >= 1 ? numbered[n - 1] : undefined;
      return { date: String(x.date), what: clip(x.what, 160), ...(id ? { itemId: id } : {}) };
    })
    .filter((x) => x.date >= dayKey(review.fromAt, 'UTC').slice(0, x.date.length))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 6);
  const findings: ReviewFinding[] = [
    ...(old.findings ?? []),
    ...(r.findings ?? [])
      .filter((f) => f && typeof f.answer === 'string' && f.answer.trim() && KINDS.includes(f.kind))
      .slice(0, 25)
      .map((f) => ({
        id: newId(),
        kind: f.kind,
        question: clip(f.question, 200),
        answer: clip(f.answer, 700),
        sources: (Array.isArray(f.sources) ? f.sources : [])
          .filter((s) => s && /^https?:\/\//i.test(String(s.url)))
          .slice(0, 5)
          .map((s) => ({ title: clip(s.title || s.url, 140), url: String(s.url).slice(0, 1000) })),
        ...(Array.isArray(f.bridge) && f.bridge.length === 3 && f.bridge.every((b) => typeof b === 'string' && b.trim())
          ? { bridge: f.bridge.map((b) => clip(b, 60)) as [string, string, string] }
          : {}),
        ...(row.written && old.writtenAt ? { more: true } : {}),
      })),
  ];
  const first = !old.writtenAt;
  const written: ReviewWritten & { numbered: string[] } = {
    ...old,
    ...(first
      ? {
          opening: clip(w.opening, 1200) || undefined,
          storyLines: Object.fromEntries(Object.entries(w.storyLines ?? {}).filter(([id, v]) => storyIds.has(id) && typeof v === 'string' && v.trim()).map(([id, v]) => [id, clip(v, 300)])),
          thread: clip(w.thread, 400) || undefined,
          starsSay: clip(w.starsSay, 600) || undefined,
          coming,
          model: `${r.model} via ${r.provider}`,
          writtenAt: now(),
        }
      : {}),
    findings,
    searches: (old.searches ?? 0) + (Number(r.searches) || 0),
    note: r.note ? clip(r.note, 200) : first ? undefined : old.note,
    numbered,
  };
  await env.DB.prepare("UPDATE reviews SET written = ?, status = 'done', error = NULL, more_wanted = 0, seconds = ?, claimed_at = NULL WHERE id = ?")
    .bind(JSON.stringify(written), seconds, row.id)
    .run();
  await countSearches(env, 'reviews', r.searches);
  if (first && !row.inbox_item_id) await putInInbox(env, { ...review, written }).catch((err: unknown) => console.error('review inbox item failed', err));
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** With Settings > Reviews "Also put each review in the inbox": a short article with the opening and a link to the review. */
async function putInInbox(env: Env, review: Review): Promise<void> {
  const settings = await loadSettings(env);
  if (!settings.reviews.inInbox) return;
  const sourceId = await aiSourceId(env);
  const id = newId();
  const key = `ai/${id}.html`;
  const title = `${review.kind === 'week' ? 'Your week' : 'Your month'}: ${review.pack.label}`;
  const opening = review.written.opening ?? '';
  const html = [
    opening ? markdownToHtml(opening) : '',
    review.written.thread ? `<p><em>${esc(review.written.thread)}</em></p>` : '',
    `<p><a href="/review/${review.id}">Open the whole review</a></p>`,
  ].join('\n');
  await env.RAW.put(key, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  const t = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO items (id, source_id, kind, status, subject, from_name, snippet, received_at, html_key, has_html, created_at, preheader, word_count)
       VALUES (?, ?, 'ai', 'inbox', ?, 'Reviews', ?, ?, ?, 1, ?, ?, ?)`,
    ).bind(id, sourceId, title, clip(opening, 300), t, key, t, clip(opening, 200), opening.split(/\s+/).filter(Boolean).length),
    env.DB.prepare('UPDATE reviews SET inbox_item_id = ? WHERE id = ?').bind(id, review.id),
  ]);
}

// ---------- Category check ----------

async function applyCategory(env: Env, review: Review, s: CategorySuggestion, action: 'apply' | 'apply_old' | 'dismiss'): Promise<string> {
  if (action === 'dismiss') return 'Left as it is.';
  const settings = await loadSettings(env);
  const addCategory = async (name: string) => {
    if (!settings.categories.some((c) => c.toLowerCase() === name.toLowerCase())) {
      settings.categories = [...settings.categories, name].slice(0, 40);
      await saveSettings(env, settings);
    }
  };
  switch (s.kind) {
    case 'move_source': {
      if (!s.sourceId || !s.to) throw new Error('Nothing to move');
      await addCategory(s.to);
      if (action === 'apply') {
        // New posts only: earlier ones keep the category they show under now.
        await env.DB.batch([
          env.DB.prepare('UPDATE items SET category = ? WHERE source_id = ? AND category IS NULL').bind(s.from ?? null, s.sourceId),
          env.DB.prepare('UPDATE sources SET category = ? WHERE id = ?').bind(s.to, s.sourceId),
        ]);
        return `New posts go to ${s.to}; earlier ones stay in ${s.from}.`;
      }
      const r = await env.DB.batch([
        env.DB.prepare('UPDATE sources SET category = ? WHERE id = ?').bind(s.to, s.sourceId),
        env.DB.prepare('UPDATE items SET category = NULL WHERE source_id = ? AND category = ?').bind(s.sourceId, s.from ?? ''),
      ]);
      void r;
      return `Moved to ${s.to}, earlier posts too.`;
    }
    case 'elsewhere': {
      if (!s.to || !s.itemIds?.length) throw new Error('Nothing to move');
      await addCategory(s.to);
      let moved = 0;
      for (let i = 0; i < s.itemIds.length; i += 50) {
        const chunk = s.itemIds.slice(i, i + 50);
        const r = await env.DB.prepare(`UPDATE items SET category = ? WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(s.to, ...chunk).run();
        moved += r.meta.changes ?? 0;
      }
      return `Moved ${moved} items to ${s.to}.`;
    }
    case 'new_category': {
      if (!s.to) throw new Error('No name');
      await addCategory(s.to);
      if (action === 'apply_old' && s.tag) {
        const r = await env.DB.prepare(
          'UPDATE items SET category = ? WHERE category IS NULL AND id IN (SELECT item_id FROM item_tags WHERE tag = ? AND received_at >= ?)',
        )
          .bind(s.to, s.tag, review.toAt - 91 * DAY)
          .run();
        return `Added ${s.to} and moved ${r.meta.changes ?? 0} items tagged ${s.tag} into it.`;
      }
      return `Added ${s.to}. The AI can pick it for new items.`;
    }
    case 'near_empty': {
      if (!s.from) throw new Error('No category');
      settings.categories = settings.categories.filter((c) => c.toLowerCase() !== s.from!.toLowerCase());
      await saveSettings(env, settings);
      return `Took ${s.from} off the list. Items already in it keep it.`;
    }
  }
}

// ---------- Routes ----------

export function registerReviews(app: App) {
  app.get('/api/reviews', async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT id, kind, period, json_extract(pack, '$.label') AS label, read_at, status FROM reviews INDEXED BY reviews_recent ORDER BY created_at DESC LIMIT 40",
    ).all<{ id: string; kind: ReviewKind; period: string; label: string | null; read_at: number | null; status: ReviewStatus }>();
    const list: ReviewListItem[] = rows.results.map((r) => ({ id: r.id, kind: r.kind, period: r.period, label: r.label ?? r.period, readAt: r.read_at, status: r.status }));
    return c.json(list);
  });

  app.get('/api/reviews/quality', async (c) => {
    const rows = await c.env.DB.prepare('SELECT written FROM reviews INDEXED BY reviews_recent WHERE created_at >= ?')
      .bind(now() - 56 * DAY)
      .all<{ written: string | null }>();
    const q: ReviewQuality = { findings: 0, notUseful: 0, searches: 0 };
    for (const r of rows.results) {
      const w = parse<ReviewWritten>(r.written, {});
      q.findings += w.findings?.length ?? 0;
      q.notUseful += w.findings?.filter((f) => f.notUseful).length ?? 0;
      q.searches += w.searches ?? 0;
    }
    return c.json(q);
  });

  app.get('/api/reviews/:id', async (c) => {
    const row = await c.env.DB.prepare('SELECT * FROM reviews WHERE id = ?').bind(c.req.param('id')).first<ReviewRow>();
    if (!row) return c.json({ error: 'not found' }, 404);
    const review = toReview(row);
    delete (review.written as { numbered?: unknown }).numbered;
    return c.json(review);
  });

  /** Builds (or rebuilds) this week's review, or last month's, now. */
  app.post('/api/reviews/build', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { kind?: unknown };
    const kind: ReviewKind = body.kind === 'month' ? 'month' : 'week';
    return c.json(await buildReview(c.env, kind));
  });

  app.post('/api/reviews/:id/done', async (c) => {
    const row = await c.env.DB.prepare('SELECT * FROM reviews WHERE id = ?').bind(c.req.param('id')).first<ReviewRow>();
    if (!row) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => null)) as { markRead?: unknown; device?: unknown } | null;
    const t = now();
    await c.env.DB.prepare('UPDATE reviews SET read_at = ? WHERE id = ?').bind(t, row.id).run();
    let itemsRead = 0;
    if (body?.markRead === true) {
      const review = toReview(row);
      const ids = (review.pack.top ?? []).flatMap((s) => [s.itemId, ...s.more.map((m) => m.itemId)]);
      const storyIds = (review.pack.stories ?? []).map((s) => s.id);
      if (storyIds.length) {
        const rows = await c.env.DB.prepare(
          `SELECT id FROM items INDEXED BY items_story WHERE story_id IS NOT NULL AND story_id IN (${storyIds.map(() => '?').join(',')}) AND received_at >= ? AND received_at < ?`,
        )
          .bind(...storyIds, row.from_at, row.to_at)
          .all<{ id: string }>();
        ids.push(...rows.results.map((r) => r.id));
      }
      itemsRead = await markRead(c.env, [...new Set(ids)], 'digest', deviceOf(c, body.device), t);
    }
    return c.json({ readAt: t, itemsRead });
  });

  app.post('/api/reviews/:id/undone', async (c) => {
    await c.env.DB.prepare('UPDATE reviews SET read_at = NULL WHERE id = ?').bind(c.req.param('id')).run();
    return c.json({ readAt: null });
  });

  /** Find more: a few extra searches on the same review. */
  app.post('/api/reviews/:id/more', async (c) => {
    const row = await c.env.DB.prepare('SELECT kind, status FROM reviews WHERE id = ?').bind(c.req.param('id')).first<{ kind: ReviewKind; status: ReviewStatus }>();
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row.status !== 'done') return c.json({ error: 'The PC is still writing this review' }, 409);
    const left = (await searchAllowance(c.env)).summaries;
    if (left <= 0) return c.json({ error: "This month's web search budget is used up" }, 409);
    await c.env.DB.prepare("UPDATE reviews SET more_wanted = ?, status = 'waiting', attempts = 0 WHERE id = ?")
      .bind(Math.min(MORE_SEARCHES[row.kind], left), c.req.param('id'))
      .run();
    return c.json({ status: 'waiting' });
  });

  /** Writes it again from scratch (a failed review, or one written while the PC had no model). */
  app.post('/api/reviews/:id/retry', async (c) => {
    await c.env.DB.prepare("UPDATE reviews SET written = NULL, status = 'waiting', attempts = 0, error = NULL, claimed_at = NULL WHERE id = ?")
      .bind(c.req.param('id'))
      .run();
    return c.json({ status: 'waiting' });
  });

  app.post('/api/reviews/:id/findings/:fid', async (c) => {
    const row = await c.env.DB.prepare('SELECT written FROM reviews WHERE id = ?').bind(c.req.param('id')).first<{ written: string | null }>();
    if (!row) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { notUseful?: unknown };
    const w = parse<ReviewWritten>(row.written, {});
    const f = w.findings?.find((x) => x.id === c.req.param('fid'));
    if (!f) return c.json({ error: 'not found' }, 404);
    f.notUseful = body.notUseful === true;
    await c.env.DB.prepare('UPDATE reviews SET written = ? WHERE id = ?').bind(JSON.stringify(w), c.req.param('id')).run();
    return c.json(f);
  });

  app.post('/api/reviews/:id/categories/:sid', async (c) => {
    const row = await c.env.DB.prepare('SELECT * FROM reviews WHERE id = ?').bind(c.req.param('id')).first<ReviewRow>();
    if (!row) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { action?: unknown };
    const action = body.action === 'apply' || body.action === 'apply_old' || body.action === 'dismiss' ? body.action : null;
    if (!action) return c.json({ error: 'action must be apply, apply_old or dismiss' }, 400);
    const pack = parse<StoredPack>(row.pack, {} as StoredPack);
    const s = pack.categories?.find((x) => x.id === c.req.param('sid'));
    if (!s) return c.json({ error: 'not found' }, 404);
    if (s.status) return c.json({ error: 'Already done' }, 409);
    let message: string;
    try {
      message = await applyCategory(c.env, toReview(row), s, action);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Could not apply it' }, 400);
    }
    s.status = action === 'dismiss' ? 'dismissed' : action === 'apply' ? 'applied' : 'applied_old';
    await c.env.DB.prepare('UPDATE reviews SET pack = ? WHERE id = ?').bind(JSON.stringify(pack), row.id).run();
    return c.json({ suggestion: s, message });
  });

  // ----- Helper side -----

  app.post('/api/helper/review/claim', async (c) => c.json({ job: await claimJob(c.env) }));

  app.post('/api/helper/review/result', async (c) => {
    const r = (await c.req.json().catch(() => null)) as ReviewResult | null;
    if (!r || typeof r.reviewId !== 'string') return c.json({ error: 'bad result' }, 400);
    await saveResult(c.env, r);
    return c.json({ ok: true });
  });
}
