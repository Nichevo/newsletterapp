import {
  tagKey,
  type StoryBanner,
  type StoryInfo,
  type StoryList,
  type StoryJob,
  type StoryMatch,
  type StoryNear,
  type StoryPage,
  type StoryResult,
  type StoryStats,
  type StoryStep,
  type StoryTune,
  type StoryWhy,
} from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { loadState, readJson, writeJson } from './ai';
import { NEAR_SHOW, parseList, storyTitle } from './db';
import type { AppVariables, Env } from './env';
import { newId, now } from './ids';
import { loadSettings } from './settings';
import { limitState } from './usage';

// Stories: items about the same chain of events, so the reader shows what's new
// since you last read about something rather than a list of old headlines.
//
// How links are made. The PC helper embeds every item and sends back its nearest
// older items with how close they are in meaning (embed.ts). Once an item has
// those, it is matched here, oldest first, against them:
//   - same news: very close in meaning, from another source, within 2 days;
//   - same story: close in meaning AND sharing a specific (rare) tag, within 30 days,
//     or very close in meaning on its own within 7 days.
// Broad tags (on more than 3% of items) don't count, so "AI" never links anything.
// The best match's story is joined, or a new story starts with the two of them.
// Items that only share a tag stay apart; the reader links to the tag page instead.
//
// Then the PC writes one line on what each new item adds and names the story
// (recent items only), the same way it answers highlight questions.
//
// Database reads: matching an item reads its queue row, up to 15 neighbours, its
// few tag counts and the story's items; opening an article reads the item, its
// story and the story's items. Inbox rows get their story with one lookup each.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const DAY = 86_400_000;
const MATCH: Record<StoryMatch, { news: number; story: number; alone: number }> = {
  loose: { news: 0.83, story: 0.72, alone: 0.8 },
  normal: { news: 0.86, story: 0.76, alone: 0.84 },
  strict: { news: 0.89, story: 0.8, alone: 0.88 },
};
const NEWS_DAYS = 2;
const STORY_DAYS = 30;
const ALONE_DAYS = 7;
/** Only items this recent get a note from the PC, so matching old items doesn't queue thousands. */
const NOTE_DAYS = 14;
const BROAD_SHARE = 0.03;
const BROAD_MIN = 25;
const NOTE_LEASE_MS = 15 * 60_000;
/** How far under the meaning line still counts as a near miss in Statistics > Stories. */
const NEAR_GAP = 0.06;
const STORY_ITEMS_MAX = 300;

// ---------- Learning from what you link by hand ----------
//
// Each "Same story" counts one link for the tags the two articles share and for both
// their sources; each "Not part of this story" counts one split for the tags the article
// shares with the story and for its source. Every net link moves the meaning line 0.01
// lower for articles with that tag or source (at most 0.06), every net split 0.01 higher
// (at most 0.04), so one busy topic loosens without the whole app going Loose. A broad
// tag with 2 net links starts counting as a specific one. Kept as one settings row,
// read once per matching run.

/** Extra closeness needed when both articles come from the same source (its headlines and wording look alike). */
const SAME_SOURCE_EXTRA = 0.03;
/** Extra closeness needed in a category set to Stricter, which also needs a shared specific tag. */
const STRICT_EXTRA = 0.06;

const TUNE_STEP = 0.01;
const TUNE_LOOSEN_MAX = 0.06;
const TUNE_TIGHTEN_MAX = 0.04;
const TUNE_SPECIFIC_AT = 2;
const TUNE_KEEP = 300;

interface TuneEntry {
  label: string;
  links: number;
  splits: number;
  at: number;
}
interface Tunes {
  tags: Record<string, TuneEntry>;
  sources: Record<string, TuneEntry>;
}

async function loadTunes(env: Env): Promise<Tunes> {
  const t = await readJson<Partial<Tunes>>(env, 'story_tunes');
  return { tags: t?.tags ?? {}, sources: t?.sources ?? {} };
}

const entryShift = (e: TuneEntry | undefined) => {
  if (!e) return 0;
  const net = e.links - e.splits;
  return net > 0 ? -Math.min(net * TUNE_STEP, TUNE_LOOSEN_MAX) : Math.min(-net * TUNE_STEP, TUNE_TIGHTEN_MAX);
};

/**
 * How far to move the meaning line for a pair of articles: the strongest loosening among the
 * tags they share and their two sources, plus the strongest tightening, within the limits.
 */
function lineShift(tunes: Tunes, sharedTags: string[], sources: (string | null)[]): number {
  const shifts = [...sharedTags.map((k) => entryShift(tunes.tags[k])), ...sources.map((s) => (s ? entryShift(tunes.sources[s]) : 0))];
  const loosen = Math.min(0, ...shifts);
  const tighten = Math.max(0, ...shifts);
  return Math.round((loosen + tighten) * 1000) / 1000;
}

/** An article's category as the app shows it: keyword rule, then the source's, then the AI's first. */
const CATEGORY_SQL = "COALESCE(items.category, sources.category, json_extract(items.ai_category, '$[0]'))";

/**
 * The meaning lines for a pair of articles: the setting's lines moved by what was learnt,
 * by sharing a source, and by a Stricter category (which also needs a shared tag).
 */
function pairLines(
  th: { story: number; alone: number },
  shift: number,
  sameSource: boolean,
  strict: boolean,
): { story: number; alone: number | null } {
  const extra = shift + (sameSource ? SAME_SOURCE_EXTRA : 0) + (strict ? STRICT_EXTRA : 0);
  return { story: th.story + extra, alone: strict ? null : th.alone + extra };
}

const learntSpecific = (tunes: Tunes, k: string) => {
  const e = tunes.tags[k];
  return Boolean(e && e.links - e.splits >= TUNE_SPECIFIC_AT);
};

/** Adds a hand link (+1) or split (-1) to these tags and sources, keeping the most recent entries. */
async function recordTune(env: Env, tags: { key: string; label: string }[], sources: { id: string; name: string }[], link: boolean) {
  if (!tags.length && !sources.length) return;
  const tunes = await loadTunes(env);
  const t = now();
  const bump = (map: Record<string, TuneEntry>, key: string, label: string) => {
    const e = map[key] ?? { label, links: 0, splits: 0, at: t };
    if (link) e.links += 1;
    else e.splits += 1;
    e.label = label || e.label;
    e.at = t;
    map[key] = e;
  };
  for (const x of tags) bump(tunes.tags, x.key, x.label);
  for (const x of sources) bump(tunes.sources, x.id, x.name);
  const trim = (map: Record<string, TuneEntry>) =>
    Object.fromEntries(Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, TUNE_KEEP));
  await writeJson(env, 'story_tunes', { tags: trim(tunes.tags), sources: trim(tunes.sources) });
}

function tuneList(tunes: Tunes): StoryTune[] {
  const out: StoryTune[] = [];
  for (const [key, e] of Object.entries(tunes.tags))
    out.push({ kind: 'tag', key, label: e.label, links: e.links, splits: e.splits, shift: entryShift(e), specific: learntSpecific(tunes, key) });
  for (const [key, e] of Object.entries(tunes.sources))
    out.push({ kind: 'source', key, label: e.label, links: e.links, splits: e.splits, shift: entryShift(e), specific: false });
  return out.filter((x) => x.links + x.splits > 0).sort((a, b) => a.shift - b.shift || b.links + b.splits - (a.links + a.splits));
}

const LIVE = "items.status IN ('inbox', 'archived')";

// ---------- Matching ----------

interface QueueRow {
  id: string;
  source_id: string | null;
  received_at: number;
  tags: string | null;
  neighbours: string | null;
  story_split: number | null;
  status: string;
  story_note: string | null;
  category: string | null;
}

interface NeighbourRow {
  id: string;
  source_id: string | null;
  received_at: number;
  story_id: string | null;
  news_id: string | null;
  tags: string | null;
  status: string;
  story_split: number | null;
  category: string | null;
}

/** Matches up to `max` waiting items into stories, oldest first. Returns how many it looked at. */
export async function assignStories(env: Env, max: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT items.id, items.source_id, items.received_at, items.tags, items.neighbours, items.story_split, items.status, items.story_note,
       ${CATEGORY_SQL} AS category
     FROM items INDEXED BY items_story_queue LEFT JOIN sources ON sources.id = items.source_id
     WHERE items.story_at IS NULL AND items.embedded_at IS NOT NULL ORDER BY items.received_at LIMIT ?`,
  )
    .bind(max)
    .all<QueueRow>();
  if (rows.results.length === 0) return 0;
  const settings = (await loadSettings(env)).stories;
  const th = MATCH[settings.match];
  const tunes = await loadTunes(env);
  // The most any tag or source has lowered the line, so neighbours under the usual line are only read when they could pass.
  const maxLoosen = -Math.min(0, ...[...Object.values(tunes.tags), ...Object.values(tunes.sources)].map(entryShift));
  const total = (await env.DB.prepare('SELECT MAX(rowid) AS n FROM items').first<{ n: number | null }>())?.n ?? 0;
  const broadAt = Math.max(BROAD_MIN, Math.ceil(total * BROAD_SHARE));
  const tagN = new Map<string, number>();
  // Story and news ids set during this run, so later items in it see them.
  const changed = new Map<string, { story_id: string | null; news_id: string | null }>();

  for (const row of rows.results) {
    const t = now();
    let all: [string, number][] = [];
    try {
      all = (JSON.parse(row.neighbours ?? '[]') as [string, number][]).filter((n) => Array.isArray(n) && typeof n[0] === 'string' && Number.isFinite(n[1]));
    } catch {
      all = [];
    }
    // Left out, but the nearest item came within reach of the line: counted as a near miss.
    const top = all.reduce((m, n) => Math.max(m, n[1]), 0);
    const nearMiss = top >= th.story - NEAR_GAP ? Math.round(top * 1000) / 1000 : null;
    const mark = (miss: number | null = null) =>
      env.DB.prepare('UPDATE items SET story_at = ?, story_near = ? WHERE id = ?').bind(t, miss, row.id).run();
    const rowMode = row.category ? settings.categories[row.category] : undefined;
    if ((row.status !== 'inbox' && row.status !== 'archived') || row.story_split || rowMode === 'off') {
      await mark();
      continue;
    }
    // Neighbours that could pass with the most a tag or source can loosen the line; each pair is checked with its own line below.
    const near = all.filter((n) => n[1] >= th.story - maxLoosen).slice(0, 15);
    if (near.length === 0) {
      await mark(nearMiss);
      continue;
    }
    const sims = new Map(near);
    const others = await env.DB.prepare(
      `SELECT items.id, items.source_id, items.received_at, items.story_id, items.news_id, items.tags, items.status, items.story_split, ${CATEGORY_SQL} AS category
       FROM items LEFT JOIN sources ON sources.id = items.source_id WHERE items.id IN (${near.map(() => '?').join(', ')})`,
    )
      .bind(...near.map((n) => n[0]))
      .all<NeighbourRow>();

    // Which of this item's tags are specific enough to link on.
    const mine = new Map(parseList(row.tags).map((l) => [tagKey(l), l.trim()] as const).filter(([k]) => k));
    const unknown = [...mine.keys()].filter((k) => !tagN.has(k));
    if (unknown.length) {
      const counts = await env.DB.prepare(`SELECT tag, n FROM tag_counts WHERE tag IN (${unknown.map(() => '?').join(', ')})`)
        .bind(...unknown)
        .all<{ tag: string; n: number }>();
      for (const k of unknown) tagN.set(k, 0);
      for (const c of counts.results) tagN.set(c.tag, c.n);
    }
    const specific = new Set([...mine.keys()].filter((k) => ((tagN.get(k) ?? 0) >= 2 && (tagN.get(k) ?? 0) <= broadAt) || learntSpecific(tunes, k)));

    type Candidate = NeighbourRow & { sim: number; shared: string[]; news: boolean; score: number };
    let best: Candidate | null = null;
    for (const raw of others.results) {
      const n = { ...raw, ...(changed.get(raw.id) ?? {}) };
      // Taken out of a story by hand: it doesn't pull other items into one either.
      const theirMode = n.category ? settings.categories[n.category] : undefined;
      if ((n.status !== 'inbox' && n.status !== 'archived') || n.story_split || theirMode === 'off') continue;
      const sim = sims.get(n.id) ?? 0;
      const days = (row.received_at - n.received_at) / DAY;
      const theirs = [...new Set(parseList(n.tags).map(tagKey))];
      const sharedKeys = theirs.filter((k) => specific.has(k));
      const shared = sharedKeys.map((k) => mine.get(k)!);
      const shift = lineShift(tunes, theirs.filter((k) => mine.has(k)), [row.source_id, n.source_id]);
      const sameSource = Boolean(row.source_id && n.source_id === row.source_id);
      const lines = pairLines(th, shift, sameSource, rowMode === 'strict' || theirMode === 'strict');
      const news = sim >= th.news && days <= NEWS_DAYS && !sameSource && n.source_id !== row.source_id;
      const story =
        news || (days <= STORY_DAYS && sim >= lines.story && shared.length > 0) || (lines.alone !== null && days <= ALONE_DAYS && sim >= lines.alone);
      if (!story) continue;
      // Same news beats a later step; then closeness, shared tags and joining an existing story.
      const score = (news ? 1 : 0) + sim + 0.04 * shared.length + (n.story_id ? 0.02 : 0);
      if (!best || score > best.score) best = { ...n, sim, shared, news, score };
    }
    if (!best) {
      await mark(nearMiss);
      continue;
    }

    const stmts: D1PreparedStatement[] = [];
    let storyId = best.story_id;
    if (!storyId) {
      storyId = newId();
      stmts.push(
        env.DB.prepare(
          'INSERT INTO stories (id, first_at, last_at, items, sources, created_at, updated_at) VALUES (?, ?, ?, 2, 1, ?, ?)',
        ).bind(storyId, best.received_at, row.received_at, t, t),
        env.DB.prepare('UPDATE items SET story_id = ? WHERE id = ?').bind(storyId, best.id),
      );
      changed.set(best.id, { story_id: storyId, news_id: best.news_id });
    }
    let newsId: string | null = null;
    if (best.news) {
      newsId = best.news_id ?? best.id;
      if (!best.news_id) {
        stmts.push(env.DB.prepare('UPDATE items SET news_id = ? WHERE id = ?').bind(newsId, best.id));
        changed.set(best.id, { story_id: storyId, news_id: newsId });
      }
    }
    const why: StoryWhy = { with: best.id, sim: Math.round(best.sim * 1000) / 1000, tags: best.shared, kind: best.news ? 'news' : 'story' };
    const wantNote = settings.notes && !row.story_note && row.received_at >= t - NOTE_DAYS * DAY;
    stmts.push(
      env.DB.prepare(
        `UPDATE items SET story_id = ?, news_id = ?, story_at = ?, story_why = ?, story_near = NULL,
           story_note_status = CASE WHEN ? THEN 'pending' ELSE story_note_status END WHERE id = ?`,
      ).bind(storyId, newsId, t, JSON.stringify(why), wantNote ? 1 : 0, row.id),
    );
    changed.set(row.id, { story_id: storyId, news_id: newsId });
    await env.DB.batch(stmts);
    await refreshStory(env, storyId);
  }
  return rows.results.length;
}

/** Recounts a story's items, sources, dates and main tags; a story left with one item is taken apart. */
export async function refreshStory(env: Env, storyId: string): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, source_id, received_at, tags FROM items INDEXED BY items_story WHERE story_id = ? ORDER BY received_at LIMIT ${STORY_ITEMS_MAX}`,
  )
    .bind(storyId)
    .all<{ id: string; source_id: string | null; received_at: number; tags: string | null }>();
  const list = rows.results;
  if (list.length < 2) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM stories WHERE id = ?').bind(storyId),
      env.DB.prepare('UPDATE items SET story_id = NULL, news_id = NULL WHERE story_id = ?').bind(storyId),
    ]);
    return;
  }
  const counts = new Map<string, { label: string; n: number }>();
  for (const r of list) {
    for (const l of new Set(parseList(r.tags).map((x) => x.trim()).filter(Boolean))) {
      const k = tagKey(l);
      const e = counts.get(k) ?? { label: l, n: 0 };
      e.n += 1;
      counts.set(k, e);
    }
  }
  // Tags on at least two items and a third of the story, most common first.
  const need = Math.max(2, Math.ceil(list.length / 3));
  const tags = [...counts.values()]
    .filter((c) => c.n >= need)
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map((c) => c.label);
  const sources = new Set(list.map((r) => r.source_id ?? r.id)).size;
  await env.DB.prepare('UPDATE stories SET items = ?, sources = ?, first_at = ?, last_at = ?, tags = ?, updated_at = ? WHERE id = ?')
    .bind(list.length, sources, list[0]!.received_at, list[list.length - 1]!.received_at, JSON.stringify(tags), now(), storyId)
    .run();
}

// ---------- Shapes ----------

interface StoryRow {
  id: string;
  title: string | null;
  summary: string | null;
  tags: string | null;
  first_at: number;
  last_at: number;
  items: number;
  sources: number;
  followed_at: number | null;
}

interface StepRow {
  id: string;
  subject: string;
  source_name: string | null;
  received_at: number;
  read_at: number | null;
  saved_at: number | null;
  story_note: string | null;
  summary: string | null;
  preheader: string | null;
  snippet: string | null;
  news_id: string | null;
  story_why: string | null;
}

const STEP_SELECT = `SELECT items.id, items.subject, COALESCE(sources.name, items.from_name, items.from_email) AS source_name, items.received_at,
    items.read_at, items.saved_at, items.story_note, items.summary, items.preheader, items.snippet, items.news_id, items.story_why
  FROM items INDEXED BY items_story LEFT JOIN sources ON sources.id = items.source_id`;

export function toStoryInfo(row: StoryRow, firstSubject?: string | null): StoryInfo {
  return {
    id: row.id,
    title: storyTitle(row, firstSubject),
    summary: row.summary,
    tags: parseList(row.tags).map((label) => ({ tag: tagKey(label), label })),
    firstAt: row.first_at,
    lastAt: row.last_at,
    items: row.items,
    sources: row.sources,
    followedAt: row.followed_at,
  };
}

function parseWhy(raw: string | null): StoryWhy | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StoryWhy;
    return v && typeof v.sim === 'number'
      ? { with: v.with ?? null, sim: v.sim, tags: Array.isArray(v.tags) ? v.tags : [], kind: v.kind === 'news' ? 'news' : 'story', ...(v.manual ? { manual: true } : {}) }
      : null;
  } catch {
    return null;
  }
}

/** The first sentence or so of a summary, for steps without a note. */
function shortSummary(text: string | null): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ').trim();
  const m = /^(.{40,220}?[.!?])(\s|$)/.exec(t);
  return m ? m[1]! : t.slice(0, 220);
}

function toStep(r: StepRow): StoryStep {
  return {
    id: r.id,
    subject: r.subject,
    sourceName: r.source_name,
    receivedAt: r.received_at,
    readAt: r.read_at,
    savedAt: r.saved_at,
    note: r.story_note,
    summary: shortSummary(r.summary ?? r.preheader ?? r.snippet),
    newsId: r.news_id,
    why: parseWhy(r.story_why),
  };
}

async function storySteps(env: Env, storyId: string, limit = STORY_ITEMS_MAX): Promise<StoryStep[]> {
  const rows = await env.DB.prepare(`${STEP_SELECT} WHERE items.story_id = ? AND ${LIVE} ORDER BY items.received_at DESC LIMIT ?`)
    .bind(storyId, limit)
    .all<StepRow>();
  return rows.results.map(toStep);
}

// ---------- Story notes on the PC ----------

const NOTE_PROMPT = `You follow an ongoing news story for one reader. You get the earlier items in the story, oldest first, then a new item.
Reply with JSON only, no other text:
{"new": one sentence of at most 30 words saying what the new item adds that the earlier items did not have (new facts, events or numbers; not opinions about the article). If it adds nothing new, say so briefly.,
 "title": a short name for the whole story, 3 to 7 words, no dates,
 "so_far": two sentences summing up the whole story so far, including the new item}`;

function noteText(earlier: { subject: string; source: string | null; at: number; text: string | null }[], item: { subject: string; source: string | null; at: number; text: string | null }) {
  const line = (e: typeof item) => `- ${new Date(e.at).toISOString().slice(0, 10)} · ${e.source ?? 'unknown'} · ${e.subject}${e.text ? `\n  ${e.text.slice(0, 600)}` : ''}`;
  return ['Earlier items in the story:', ...earlier.map(line), '', 'New item:', line(item)].join('\n');
}

/** Whether story notes are waiting, for the helper's check-in (an index probe). */
async function notesWaiting(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS w FROM items INDEXED BY items_story_notes
     WHERE story_note_status IN ('pending', 'working') AND (story_note_status = 'pending' OR story_note_at < ?) AND story_id IS NOT NULL LIMIT 1`,
  )
    .bind(now() - NOTE_LEASE_MS)
    .first<{ w: number }>();
  return Boolean(row);
}

/**
 * Called from the helper's check-in: matches a few waiting items (so a backlog of old
 * items is worked through a minute at a time) and says whether notes are waiting.
 */
export async function storyHeartbeat(env: Env, paused: boolean): Promise<{ storyWaiting: boolean }> {
  await assignStories(env, 25).catch((err: unknown) => console.error('story matching failed', err));
  return { storyWaiting: !paused && (await notesWaiting(env)) };
}

// ---------- Routes ----------

export function registerStories(app: App) {
  /** The story banner for an article; null when it isn't part of a story. */
  app.get('/api/items/:id/story', async (c) => {
    const item = await c.env.DB.prepare('SELECT id, story_id, news_id, story_note, story_note_status, tags, received_at FROM items WHERE id = ?')
      .bind(c.req.param('id'))
      .first<{ id: string; story_id: string | null; news_id: string | null; story_note: string | null; story_note_status: string | null; tags: string | null; received_at: number }>();
    if (!item) return c.json({ error: 'not found' }, 404);
    if (!item.story_id) return c.json(null);
    const keys = [...new Set(parseList(item.tags).map(tagKey).filter(Boolean))].slice(0, 6);
    const [story, steps, tagRows] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM stories WHERE id = ?').bind(item.story_id).first<StoryRow>(),
      storySteps(c.env, item.story_id, 200),
      keys.length
        ? c.env.DB.prepare(`SELECT tag, label, n FROM tag_counts WHERE tag IN (${keys.map(() => '?').join(', ')})`)
            .bind(...keys)
            .all<{ tag: string; label: string; n: number }>()
        : null,
    ]);
    if (!story) return c.json(null);
    const others = steps.filter((s) => s.id !== item.id);
    const sameNews = item.news_id ? others.filter((s) => s.newsId === item.news_id) : [];
    const sameIds = new Set(sameNews.map((s) => s.id));
    const earlier = others.filter((s) => s.receivedAt <= item.received_at && !sameIds.has(s.id));
    const reads = others.filter((s) => s.readAt);
    const body: StoryBanner = {
      story: toStoryInfo(story, steps[steps.length - 1]?.subject),
      read: reads.length,
      unreadIds: others
        .filter((s) => !s.readAt)
        .sort((a, b) => a.receivedAt - b.receivedAt)
        .map((s) => s.id),
      lastRead: earlier.find((s) => s.readAt) ?? reads[0] ?? null,
      note: item.story_note,
      notePending: !item.story_note && (item.story_note_status === 'pending' || item.story_note_status === 'working'),
      earlier: earlier.slice(0, 4),
      sameNews,
      tags: (tagRows?.results ?? []).filter((t) => t.n > 1).sort((a, b) => b.n - a.n),
    };
    return c.json(body);
  });

  /**
   * "Close, but not linked": for an article not in a story, the up to 3 older items
   * nearest in meaning and why each wasn't linked. Reads the item, 3 items, their stories and a few tag counts.
   */
  app.get('/api/items/:id/near', async (c) => {
    const item = await c.env.DB.prepare(
      `SELECT items.id, items.source_id, items.received_at, items.tags, items.neighbours, items.story_id, items.story_split, ${CATEGORY_SQL} AS category
       FROM items LEFT JOIN sources ON sources.id = items.source_id WHERE items.id = ?`,
    )
      .bind(c.req.param('id'))
      .first<{
        id: string; source_id: string | null; received_at: number; tags: string | null; neighbours: string | null; story_id: string | null;
        story_split: number | null; category: string | null;
      }>();
    if (!item) return c.json({ error: 'not found' }, 404);
    if (item.story_id) return c.json([]);
    let all: [string, number][] = [];
    try {
      all = (JSON.parse(item.neighbours ?? '[]') as [string, number][]).filter((n) => Array.isArray(n) && typeof n[0] === 'string' && Number.isFinite(n[1]));
    } catch {
      all = [];
    }
    const near = all.filter((n) => n[1] >= NEAR_SHOW).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (!near.length) return c.json([]);
    const [settings, tunes] = await Promise.all([loadSettings(c.env), loadTunes(c.env)]);
    const th = MATCH[settings.stories.match];
    const rows = await c.env.DB.prepare(
      `SELECT items.id, items.subject, COALESCE(sources.name, items.from_name, items.from_email) AS source_name, items.source_id, items.received_at,
         items.read_at, items.tags, items.status, items.story_split, items.story_id, stories.title AS story_title, stories.tags AS story_tags,
         ${CATEGORY_SQL} AS category
       FROM items LEFT JOIN sources ON sources.id = items.source_id LEFT JOIN stories ON stories.id = items.story_id
       WHERE items.id IN (${near.map(() => '?').join(', ')})`,
    )
      .bind(...near.map((n) => n[0]))
      .all<{
        id: string; subject: string; source_name: string | null; source_id: string | null; received_at: number; read_at: number | null; tags: string | null;
        status: string; story_split: number | null; story_id: string | null; story_title: string | null; story_tags: string | null; category: string | null;
      }>();
    const mine = new Map(parseList(item.tags).map((l) => [tagKey(l), l.trim()] as const).filter(([k]) => k));
    const keys = [...mine.keys()].slice(0, 8);
    const [total, counts] = await Promise.all([
      c.env.DB.prepare('SELECT MAX(rowid) AS n FROM items').first<{ n: number | null }>(),
      keys.length
        ? c.env.DB.prepare(`SELECT tag, n FROM tag_counts WHERE tag IN (${keys.map(() => '?').join(', ')})`).bind(...keys).all<{ tag: string; n: number }>()
        : null,
    ]);
    const broadAt = Math.max(BROAD_MIN, Math.ceil((total?.n ?? 0) * BROAD_SHARE));
    const tagN = new Map((counts?.results ?? []).map((r) => [r.tag, r.n]));
    const specific = new Set(keys.filter((k) => ((tagN.get(k) ?? 0) >= 2 && (tagN.get(k) ?? 0) <= broadAt) || learntSpecific(tunes, k)));
    const byId = new Map(rows.results.map((r) => [r.id, r]));
    const f = (v: number) => v.toFixed(2);
    const out: StoryNear[] = [];
    for (const [id, sim] of near) {
      const n = byId.get(id);
      if (!n || (n.status !== 'inbox' && n.status !== 'archived')) continue;
      const days = Math.abs(item.received_at - n.received_at) / DAY;
      const shared = [...new Set(parseList(n.tags).map(tagKey))].filter((k) => specific.has(k));
      const sharedAny = [...new Set(parseList(n.tags).map(tagKey))].filter((k) => mine.has(k));
      const sameSource = Boolean(item.source_id && n.source_id === item.source_id);
      const shift = lineShift(tunes, sharedAny, [item.source_id, n.source_id]);
      const modes = [item.category, n.category].map((cat) => (cat ? { cat, mode: settings.stories.categories[cat] } : null));
      const off = modes.find((m) => m?.mode === 'off');
      const strict = modes.find((m) => m?.mode === 'strict');
      const lines = pairLines(th, shift, sameSource, Boolean(strict));
      const news = sim >= th.news && days <= NEWS_DAYS && !sameSource;
      const storyLine = lines.story;
      let reason: string;
      if (off) reason = `Stories are off for ${off.cat}`;
      else if (item.story_split || n.story_split) reason = 'One of them was taken out of a story by hand';
      else if (days > STORY_DAYS) reason = `Meaning ${f(sim)}, but more than ${STORY_DAYS} days apart`;
      else if (sim < storyLine) reason = `Meaning ${f(sim)}; a story needs ${f(storyLine)} plus a shared specific tag`;
      else if (shared.length === 0)
        reason =
          lines.alone === null
            ? `Meaning ${f(sim)}, no shared specific tag, which ${strict?.cat ?? 'a Stricter category'} always needs`
            : days <= ALONE_DAYS
            ? `Meaning ${f(sim)}, no shared specific tag${sharedAny.length ? ' (only broad ones)' : ''}; on its own it needs ${f(lines.alone)}`
            : `Meaning ${f(sim)}, no shared specific tag${sharedAny.length ? ' (only broad ones)' : ''}, and over a week apart`;
      else reason = news ? 'Would count as the same news with today’s setting' : 'Would link with today’s setting (matched before a change)';
      out.push({
        id: n.id,
        subject: n.subject,
        sourceName: n.source_name,
        receivedAt: n.received_at,
        readAt: n.read_at,
        sim: Math.round(sim * 1000) / 1000,
        reason: [
          reason,
          ...(off ? [] : [
            sameSource ? 'same source, so it needs 0.03 more' : '',
            strict ? `${strict.cat} is set to Stricter` : '',
            shift < 0 ? `line lowered ${f(-shift)} by your links` : shift > 0 ? `line raised ${f(shift)} by your take-outs` : '',
          ]),
        ]
          .filter(Boolean)
          .join(' · '),
        story: n.story_id ? { id: n.story_id, title: storyTitle({ title: n.story_title, tags: n.story_tags }, n.subject) } : null,
      });
    }
    return c.json(out);
  });

  /** "Same story": puts an article in the story of an older item it came close to, or starts one with the two. */
  app.post('/api/stories/join', async (c) => {
    const input = (await c.req.json().catch(() => ({}))) as { itemId?: string; withId?: string };
    if (!input.itemId || !input.withId || input.itemId === input.withId) return c.json({ error: 'itemId and withId needed' }, 400);
    const rows = await c.env.DB.prepare(
      `SELECT items.id, items.received_at, items.story_id, items.story_note, items.neighbours, items.tags, items.source_id,
         COALESCE(sources.name, items.from_name, items.from_email) AS source_name
       FROM items LEFT JOIN sources ON sources.id = items.source_id WHERE items.id IN (?, ?)`,
    )
      .bind(input.itemId, input.withId)
      .all<{
        id: string; received_at: number; story_id: string | null; story_note: string | null; neighbours: string | null;
        tags: string | null; source_id: string | null; source_name: string | null;
      }>();
    const item = rows.results.find((r) => r.id === input.itemId);
    const other = rows.results.find((r) => r.id === input.withId);
    if (!item || !other) return c.json({ error: 'not found' }, 404);
    const t = now();
    const stmts: D1PreparedStatement[] = [];
    let storyId = other.story_id;
    if (!storyId) {
      storyId = newId();
      stmts.push(
        c.env.DB.prepare('INSERT INTO stories (id, first_at, last_at, items, sources, created_at, updated_at) VALUES (?, ?, ?, 2, 1, ?, ?)').bind(
          storyId,
          Math.min(item.received_at, other.received_at),
          Math.max(item.received_at, other.received_at),
          t,
          t,
        ),
        c.env.DB.prepare('UPDATE items SET story_id = ?, story_split = NULL, story_at = COALESCE(story_at, ?) WHERE id = ?').bind(storyId, t, other.id),
      );
    }
    let sim = 0;
    try {
      sim = (JSON.parse(item.neighbours ?? '[]') as [string, number][]).find((n) => n[0] === other.id)?.[1] ?? 0;
    } catch {
      sim = 0;
    }
    const why: StoryWhy = { with: other.id, sim: Math.round(sim * 1000) / 1000, tags: [], kind: 'story', manual: true };
    const settings = (await loadSettings(c.env)).stories;
    const wantNote = settings.notes && !item.story_note && item.received_at >= t - NOTE_DAYS * DAY;
    stmts.push(
      c.env.DB.prepare(
        `UPDATE items SET story_id = ?, news_id = NULL, story_at = ?, story_why = ?, story_split = NULL, story_near = NULL,
           story_note_status = CASE WHEN ? THEN 'pending' ELSE story_note_status END WHERE id = ?`,
      ).bind(storyId, t, JSON.stringify(why), wantNote ? 1 : 0, item.id),
      c.env.DB.prepare("INSERT INTO events (item_id, type, value, device, at) VALUES (?, 'story_join', NULL, NULL, ?)").bind(item.id, t),
    );
    await c.env.DB.batch(stmts);
    await refreshStory(c.env, storyId);
    if (item.story_id && item.story_id !== storyId) await refreshStory(c.env, item.story_id);
    // Learn from it: the tags the two share and both sources link a little more easily from now on.
    const theirs = new Set(parseList(other.tags).map(tagKey));
    const tags = [...new Map(parseList(item.tags).map((l) => [tagKey(l), l.trim()] as const)).entries()]
      .filter(([k]) => k && theirs.has(k))
      .map(([key, label]) => ({ key, label }));
    const sources = [...new Map([item, other].filter((r) => r.source_id).map((r) => [r.source_id!, r.source_name ?? 'Source'] as const)).entries()].map(([id, name]) => ({ id, name }));
    await recordTune(c.env, tags, sources, true);
    return c.json({ ok: true, storyId });
  });

  /** Saved > Stories: followed stories, then the 40 most recently active (each with its unread count). */
  app.get('/api/stories', async (c) => {
    const [followed, recent] = await c.env.DB.batch([
      c.env.DB.prepare('SELECT * FROM stories INDEXED BY stories_followed WHERE followed_at IS NOT NULL ORDER BY last_at DESC LIMIT 100'),
      c.env.DB.prepare('SELECT * FROM stories INDEXED BY stories_last ORDER BY last_at DESC LIMIT 40'),
    ]);
    const f = (followed?.results ?? []) as StoryRow[];
    const r = ((recent?.results ?? []) as StoryRow[]).filter((x) => !x.followed_at);
    const ids = [...new Set([...f, ...r].map((x) => x.id))];
    const unread = new Map<string, number>();
    if (ids.length) {
      const rows = await c.env.DB.prepare(
        `SELECT story_id, SUM(read_at IS NULL) AS n FROM items INDEXED BY items_story
         WHERE story_id IS NOT NULL AND story_id IN (${ids.map(() => '?').join(', ')}) AND status = 'inbox' GROUP BY story_id`,
      )
        .bind(...ids)
        .all<{ story_id: string; n: number }>();
      for (const x of rows.results) unread.set(x.story_id, x.n ?? 0);
    }
    const shape = (x: StoryRow) => ({ ...toStoryInfo(x), unread: unread.get(x.id) ?? 0 });
    const body: StoryList = { followed: f.map(shape), recent: r.map(shape) };
    return c.json(body);
  });

  app.get('/api/stories/:id', async (c) => {
    const story = await c.env.DB.prepare('SELECT * FROM stories WHERE id = ?').bind(c.req.param('id')).first<StoryRow>();
    if (!story) return c.json({ error: 'not found' }, 404);
    const steps = await storySteps(c.env, story.id);
    const read = steps.filter((s) => s.readAt).length;
    const body: StoryPage = { ...toStoryInfo(story, steps[steps.length - 1]?.subject), read, unread: steps.length - read, steps };
    return c.json(body);
  });

  app.post('/api/stories/:id/follow', async (c) => {
    const input = (await c.req.json().catch(() => ({}))) as { on?: boolean };
    await c.env.DB.prepare('UPDATE stories SET followed_at = ? WHERE id = ?')
      .bind(input.on === false ? null : now(), c.req.param('id'))
      .run();
    return c.json({ ok: true });
  });

  /** "Not part of this story": takes the item out, and it never joins a story again. */
  app.post('/api/stories/split/:itemId', async (c) => {
    const id = c.req.param('itemId');
    const row = await c.env.DB.prepare(
      `SELECT items.story_id, items.tags, items.source_id, COALESCE(sources.name, items.from_name, items.from_email) AS source_name, stories.tags AS story_tags
       FROM items LEFT JOIN sources ON sources.id = items.source_id LEFT JOIN stories ON stories.id = items.story_id WHERE items.id = ?`,
    )
      .bind(id)
      .first<{ story_id: string | null; tags: string | null; source_id: string | null; source_name: string | null; story_tags: string | null }>();
    if (!row) return c.json({ error: 'not found' }, 404);
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE items SET story_id = NULL, news_id = NULL, story_split = 1, story_note_status = CASE WHEN story_note_status = 'done' THEN 'done' ELSE NULL END WHERE id = ?",
      ).bind(id),
      c.env.DB.prepare("INSERT INTO events (item_id, type, value, device, at) VALUES (?, 'story_split', NULL, NULL, ?)").bind(id, now()),
    ]);
    if (row.story_id) {
      await refreshStory(c.env, row.story_id);
      // Learn from it: the tags it shared with the story and its source need a closer match from now on.
      const storyTags = new Set(parseList(row.story_tags).map(tagKey));
      const tags = [...new Map(parseList(row.tags).map((l) => [tagKey(l), l.trim()] as const)).entries()]
        .filter(([k]) => k && storyTags.has(k))
        .map(([key, label]) => ({ key, label }));
      await recordTune(c.env, tags, row.source_id ? [{ id: row.source_id, name: row.source_name ?? 'Source' }] : [], false);
    }
    return c.json({ ok: true });
  });

  /**
   * After a category is set to Stricter or Off: takes its articles out of their stories and
   * queues them to be matched again under the new rule (Off ones are then left out).
   * Reads the story items once (index), up to 500 changed per call.
   */
  app.post('/api/stories/recheck', async (c) => {
    const input = (await c.req.json().catch(() => ({}))) as { category?: string };
    const cat = String(input.category ?? '').trim();
    if (!cat) return c.json({ error: 'category needed' }, 400);
    const rows = await c.env.DB.prepare(
      `SELECT items.id, items.story_id FROM items INDEXED BY items_story LEFT JOIN sources ON sources.id = items.source_id
       WHERE items.story_id IS NOT NULL AND ${CATEGORY_SQL} = ? LIMIT 500`,
    )
      .bind(cat)
      .all<{ id: string; story_id: string }>();
    if (!rows.results.length) return c.json({ ok: true, changed: 0 });
    const ids = rows.results.map((r) => r.id);
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50);
      stmts.push(
        c.env.DB.prepare(
          `UPDATE items SET story_id = NULL, news_id = NULL, story_why = NULL, story_at = NULL, story_near = NULL,
             story_note_status = CASE WHEN story_note_status IN ('pending', 'working') THEN NULL ELSE story_note_status END
           WHERE id IN (${part.map(() => '?').join(', ')})`,
        ).bind(...part),
      );
    }
    await c.env.DB.batch(stmts);
    for (const id of new Set(rows.results.map((r) => r.story_id))) await refreshStory(c.env, id);
    return c.json({ ok: true, changed: ids.length });
  });

  /** Forgets what matching learnt from your links and splits. */
  app.post('/api/stories/learnt/reset', async (c) => {
    await writeJson(c.env, 'story_tunes', { tags: {}, sources: {} });
    return c.json({ ok: true });
  });

  /**
   * Matches every item again, e.g. after changing how strict matching is. Notes already
   * written are kept; follows are lost with the old stories. Writes each item once.
   */
  app.post('/api/stories/rebuild', async (c) => {
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM stories'),
      c.env.DB.prepare(
        "UPDATE items SET story_id = NULL, news_id = NULL, story_why = NULL, story_at = NULL, story_near = NULL, story_note_status = CASE WHEN story_note_status IN ('pending', 'working') THEN NULL ELSE story_note_status END WHERE story_at IS NOT NULL OR story_id IS NOT NULL",
      ),
    ]);
    const matched = await assignStories(c.env, 50);
    return c.json({ ok: true, matched });
  });

  app.get('/api/stats/stories', async (c) => {
    const days = [7, 30, 90].find((d) => d === Number(c.req.query('days'))) ?? 30;
    const key = new Request(`https://stories.cache/v1/${days}`);
    const cache = (caches as unknown as { default: Cache }).default;
    // What's learnt changes with each tap, so it's read fresh (one row) and added to the cached numbers.
    const learnt = tuneList(await loadTunes(c.env));
    if (c.req.query('fresh') !== '1') {
      const hit = (await cache.match(key).catch(() => undefined)) as Response | undefined;
      if (hit) {
        const cached = (await hit.json()) as StoryStats;
        return c.json({ ...cached, learnt }, 200, { 'Cache-Control': 'no-store' });
      }
    }
    const stats = await storyStats(c.env, days);
    c.executionCtx.waitUntil(
      cache.put(key, new Response(JSON.stringify(stats), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=600' } })).catch(() => undefined),
    );
    return c.json({ ...stats, learnt }, 200, { 'Cache-Control': 'no-store' });
  });

  // ----- Helper side -----

  /** Story notes for the PC, oldest first, each with the story so far. */
  app.post('/api/helper/story/claim', async (c) => {
    const state = await loadState(c.env);
    if (state.paused) return c.json({ jobs: [] });
    const usage = await limitState(c.env, now(), true);
    if (usage.limited) return c.json({ jobs: [] });
    const input = (await c.req.json().catch(() => ({}))) as { max?: number };
    const max = Math.min(Math.max(Number(input.max) || 3, 1), 10);
    const t = now();
    const claimed = await c.env.DB.prepare(
      `UPDATE items SET story_note_status = 'working', story_note_at = ?1
       WHERE id IN (
         SELECT id FROM items INDEXED BY items_story_notes
         WHERE story_note_status IN ('pending', 'working') AND (story_note_status = 'pending' OR story_note_at < ?2) AND story_id IS NOT NULL
         ORDER BY received_at LIMIT ?3
       )
       RETURNING id, story_id, subject, summary, preheader, snippet, received_at, source_id, from_name`,
    )
      .bind(t, t - NOTE_LEASE_MS, max)
      .all<{ id: string; story_id: string; subject: string; summary: string | null; preheader: string | null; snippet: string | null; received_at: number; source_id: string | null; from_name: string | null }>();
    // Items whose story was taken apart meanwhile need no note.
    await c.env.DB.prepare(
      `UPDATE items SET story_note_status = NULL WHERE id IN (
         SELECT id FROM items INDEXED BY items_story_notes WHERE story_note_status IN ('pending', 'working') AND story_id IS NULL LIMIT 50)`,
    ).run();
    const jobs: StoryJob[] = [];
    for (const r of claimed.results) {
      const earlier = await c.env.DB.prepare(
        `${STEP_SELECT} WHERE items.story_id = ? AND items.received_at < ? AND items.id != ? AND ${LIVE} ORDER BY items.received_at DESC LIMIT 5`,
      )
        .bind(r.story_id, r.received_at, r.id)
        .all<StepRow>();
      const source = r.source_id
        ? ((await c.env.DB.prepare('SELECT name FROM sources WHERE id = ?').bind(r.source_id).first<{ name: string }>())?.name ?? r.from_name)
        : r.from_name;
      jobs.push({
        itemId: r.id,
        storyId: r.story_id,
        prompt: NOTE_PROMPT,
        text: noteText(
          earlier.results.reverse().map((e) => ({ subject: e.subject, source: e.source_name, at: e.received_at, text: e.story_note ?? e.summary ?? e.preheader ?? e.snippet })),
          { subject: r.subject, source, at: r.received_at, text: r.summary ?? r.preheader ?? r.snippet },
        ),
      });
    }
    return c.json({ jobs });
  });

  app.post('/api/helper/story/result', async (c) => {
    const r = (await c.req.json().catch(() => null)) as StoryResult | null;
    if (!r?.itemId || !r.model) return c.json({ error: 'bad result' }, 400);
    const item = await c.env.DB.prepare('SELECT story_id, received_at FROM items WHERE id = ?').bind(r.itemId).first<{ story_id: string | null; received_at: number }>();
    if (!item) return c.json({ error: 'not found' }, 404);
    const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
    const note = r.ok ? clean(r.output?.new, 400) : '';
    const ok = note.length > 0;
    const t = now();
    const seconds = Number.isFinite(r.seconds) ? Math.round(r.seconds * 10) / 10 : null;
    const watts = Number.isFinite(r.watts) && r.watts! > 0 ? Math.round(r.watts!) : null;
    const stmts = [
      c.env.DB.prepare('INSERT INTO story_runs (id, item_id, story_id, provider, model, seconds, watts, ok, error, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
        newId(),
        r.itemId,
        item.story_id,
        String(r.provider ?? '').slice(0, 40),
        String(r.model).slice(0, 120),
        seconds,
        watts,
        ok ? 1 : 0,
        ok ? null : String(r.error || 'The model returned an unusable answer').slice(0, 500),
        t,
      ),
      c.env.DB.prepare('UPDATE items SET story_note = ?, story_note_status = ?, story_note_at = ? WHERE id = ?').bind(ok ? note : null, ok ? 'done' : 'failed', t, r.itemId),
    ];
    // The newest item names the story and sums it up.
    const title = clean(r.output?.title, 80);
    const soFar = clean(r.output?.so_far, 600);
    if (ok && item.story_id && (title || soFar)) {
      stmts.push(
        c.env.DB.prepare(
          'UPDATE stories SET title = COALESCE(NULLIF(?, \'\'), title), summary = COALESCE(NULLIF(?, \'\'), summary), updated_at = ? WHERE id = ? AND last_at <= ?',
        ).bind(title, soFar, t, item.story_id, item.received_at),
      );
    }
    await c.env.DB.batch(stmts);
    return c.json({ ok });
  });
}

// ---------- Statistics ----------

async function storyStats(env: Env, days: number): Promise<Omit<StoryStats, 'learnt'>> {
  const since = now() - days * DAY;
  const [active, arrived, followed, followedUnread, events, notes, notesWaitingRow, matchWaiting, top, sizes] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n, SUM(first_at >= ?1) AS started FROM stories WHERE last_at >= ?1').bind(since),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, SUM(story_id IS NOT NULL) AS in_story, SUM(news_id IS NOT NULL AND news_id != id) AS same_news,
         SUM(story_id IS NULL AND story_near IS NOT NULL) AS near_miss
       FROM items INDEXED BY items_status_received WHERE status IN ('inbox', 'archived') AND received_at >= ?`,
    ).bind(since),
    env.DB.prepare('SELECT COUNT(*) AS n FROM stories INDEXED BY stories_followed WHERE followed_at IS NOT NULL'),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM items INDEXED BY items_story
       WHERE story_id IS NOT NULL AND story_id IN (SELECT id FROM stories INDEXED BY stories_followed WHERE followed_at IS NOT NULL)
         AND read_at IS NULL AND status = 'inbox'`,
    ),
    env.DB.prepare("SELECT type, COUNT(*) AS n FROM events INDEXED BY events_at WHERE at >= ? AND type IN ('story_link', 'story_split', 'story_join') GROUP BY type").bind(since),
    env.DB.prepare(
      `SELECT SUM(ok) AS done, SUM(1 - ok) AS failed, COALESCE(SUM(seconds), 0) AS seconds,
         (SELECT model FROM story_runs WHERE at >= ?1 AND ok = 1 GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1) AS model
       FROM story_runs WHERE at >= ?1`,
    ).bind(since),
    env.DB.prepare("SELECT COUNT(*) AS n FROM (SELECT 1 FROM items INDEXED BY items_story_notes WHERE story_note_status IN ('pending', 'working') LIMIT 1000)"),
    env.DB.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM items INDEXED BY items_story_queue WHERE story_at IS NULL AND embedded_at IS NOT NULL LIMIT 1000)'),
    env.DB.prepare(
      `SELECT story_id, COUNT(*) AS n, SUM(read_at IS NULL) AS unread FROM items INDEXED BY items_status_received
       WHERE status IN ('inbox', 'archived') AND received_at >= ? AND story_id IS NOT NULL GROUP BY story_id ORDER BY n DESC LIMIT 10`,
    ).bind(since),
    env.DB.prepare(
      `SELECT CASE WHEN items < 3 THEN '2' WHEN items < 5 THEN '3-4' WHEN items < 10 THEN '5-9' ELSE '10+' END AS label, COUNT(*) AS n
       FROM stories WHERE last_at >= ? GROUP BY label`,
    ).bind(since),
  ]);
  const one = <T>(r: D1Result | undefined) => (r?.results[0] ?? {}) as T;
  const a = one<{ n: number; started: number | null }>(active);
  const ar = one<{ n: number; in_story: number | null; same_news: number | null; near_miss: number | null }>(arrived);
  const ev = new Map(((events?.results ?? []) as { type: string; n: number }[]).map((e) => [e.type, e.n]));
  const no = one<{ done: number | null; failed: number | null; seconds: number; model: string | null }>(notes);
  const topRows = (top?.results ?? []) as { story_id: string; n: number; unread: number }[];
  const stories = topRows.length
    ? await env.DB.prepare(`SELECT * FROM stories WHERE id IN (${topRows.map(() => '?').join(', ')})`)
        .bind(...topRows.map((r) => r.story_id))
        .all<StoryRow>()
    : null;
  const byId = new Map((stories?.results ?? []).map((s) => [s.id, s]));
  const sizeMap = new Map(((sizes?.results ?? []) as { label: string; n: number }[]).map((s) => [s.label, s.n]));
  return {
    days,
    active: a.n ?? 0,
    started: a.started ?? 0,
    arrived: ar.n ?? 0,
    inStories: ar.in_story ?? 0,
    sameNews: ar.same_news ?? 0,
    followed: one<{ n: number }>(followed).n ?? 0,
    followedUnread: one<{ n: number }>(followedUnread).n ?? 0,
    linkTaps: ev.get('story_link') ?? 0,
    splits: ev.get('story_split') ?? 0,
    nearMisses: ar.near_miss ?? 0,
    joins: ev.get('story_join') ?? 0,
    notes: { done: no.done ?? 0, failed: no.failed ?? 0, seconds: Math.round(no.seconds ?? 0), model: no.model ?? null, waiting: one<{ n: number }>(notesWaitingRow).n ?? 0 },
    matchWaiting: one<{ n: number }>(matchWaiting).n ?? 0,
    top: topRows
      .filter((r) => byId.has(r.story_id))
      .map((r) => ({ ...toStoryInfo(byId.get(r.story_id)!), periodItems: r.n, unread: r.unread })),
    sizes: ['2', '3-4', '5-9', '10+'].map((label) => ({ label, n: sizeMap.get(label) ?? 0 })),
  };
}
