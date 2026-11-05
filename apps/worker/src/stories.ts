import {
  tagKey,
  type StoryBanner,
  type StoryInfo,
  type StoryJob,
  type StoryMatch,
  type StoryPage,
  type StoryResult,
  type StoryStats,
  type StoryStep,
  type StoryWhy,
} from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { loadState } from './ai';
import { parseList, storyTitle } from './db';
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
const STORY_ITEMS_MAX = 300;

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
}

/** Matches up to `max` waiting items into stories, oldest first. Returns how many it looked at. */
export async function assignStories(env: Env, max: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id, source_id, received_at, tags, neighbours, story_split, status, story_note FROM items INDEXED BY items_story_queue
     WHERE story_at IS NULL AND embedded_at IS NOT NULL ORDER BY received_at LIMIT ?`,
  )
    .bind(max)
    .all<QueueRow>();
  if (rows.results.length === 0) return 0;
  const settings = (await loadSettings(env)).stories;
  const th = MATCH[settings.match];
  const total = (await env.DB.prepare('SELECT MAX(rowid) AS n FROM items').first<{ n: number | null }>())?.n ?? 0;
  const broadAt = Math.max(BROAD_MIN, Math.ceil(total * BROAD_SHARE));
  const tagN = new Map<string, number>();
  // Story and news ids set during this run, so later items in it see them.
  const changed = new Map<string, { story_id: string | null; news_id: string | null }>();

  for (const row of rows.results) {
    const t = now();
    const mark = () => env.DB.prepare('UPDATE items SET story_at = ? WHERE id = ?').bind(t, row.id).run();
    if ((row.status !== 'inbox' && row.status !== 'archived') || row.story_split) {
      await mark();
      continue;
    }
    let near: [string, number][] = [];
    try {
      near = (JSON.parse(row.neighbours ?? '[]') as [string, number][])
        .filter((n) => Array.isArray(n) && typeof n[0] === 'string' && n[1] >= th.story)
        .slice(0, 15);
    } catch {
      near = [];
    }
    if (near.length === 0) {
      await mark();
      continue;
    }
    const sims = new Map(near);
    const others = await env.DB.prepare(
      `SELECT id, source_id, received_at, story_id, news_id, tags, status, story_split FROM items WHERE id IN (${near.map(() => '?').join(', ')})`,
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
    const specific = new Set([...mine.keys()].filter((k) => (tagN.get(k) ?? 0) >= 2 && (tagN.get(k) ?? 0) <= broadAt));

    type Candidate = NeighbourRow & { sim: number; shared: string[]; news: boolean; score: number };
    let best: Candidate | null = null;
    for (const raw of others.results) {
      const n = { ...raw, ...(changed.get(raw.id) ?? {}) };
      // Taken out of a story by hand: it doesn't pull other items into one either.
      if ((n.status !== 'inbox' && n.status !== 'archived') || n.story_split) continue;
      const sim = sims.get(n.id) ?? 0;
      const days = (row.received_at - n.received_at) / DAY;
      const shared = [...new Set(parseList(n.tags).map(tagKey))].filter((k) => specific.has(k)).map((k) => mine.get(k)!);
      const news = sim >= th.news && days <= NEWS_DAYS && n.source_id !== row.source_id;
      const story = news || (days <= STORY_DAYS && sim >= th.story && shared.length > 0) || (days <= ALONE_DAYS && sim >= th.alone);
      if (!story) continue;
      // Same news beats a later step; then closeness, shared tags and joining an existing story.
      const score = (news ? 1 : 0) + sim + 0.04 * shared.length + (n.story_id ? 0.02 : 0);
      if (!best || score > best.score) best = { ...n, sim, shared, news, score };
    }
    if (!best) {
      await mark();
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
        `UPDATE items SET story_id = ?, news_id = ?, story_at = ?, story_why = ?,
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
    return v && typeof v.sim === 'number' ? { with: v.with ?? null, sim: v.sim, tags: Array.isArray(v.tags) ? v.tags : [], kind: v.kind === 'news' ? 'news' : 'story' } : null;
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
    const row = await c.env.DB.prepare('SELECT story_id FROM items WHERE id = ?').bind(id).first<{ story_id: string | null }>();
    if (!row) return c.json({ error: 'not found' }, 404);
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE items SET story_id = NULL, news_id = NULL, story_split = 1, story_note_status = CASE WHEN story_note_status = 'done' THEN 'done' ELSE NULL END WHERE id = ?",
      ).bind(id),
      c.env.DB.prepare("INSERT INTO events (item_id, type, value, device, at) VALUES (?, 'story_split', NULL, NULL, ?)").bind(id, now()),
    ]);
    if (row.story_id) await refreshStory(c.env, row.story_id);
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
        "UPDATE items SET story_id = NULL, news_id = NULL, story_why = NULL, story_at = NULL, story_note_status = CASE WHEN story_note_status IN ('pending', 'working') THEN NULL ELSE story_note_status END WHERE story_at IS NOT NULL OR story_id IS NOT NULL",
      ),
    ]);
    const matched = await assignStories(c.env, 50);
    return c.json({ ok: true, matched });
  });

  app.get('/api/stats/stories', async (c) => {
    const days = [7, 30, 90].find((d) => d === Number(c.req.query('days'))) ?? 30;
    const key = new Request(`https://stories.cache/v1/${days}`);
    const cache = (caches as unknown as { default: Cache }).default;
    if (c.req.query('fresh') !== '1') {
      const hit = await cache.match(key).catch(() => undefined);
      if (hit) return new Response(hit.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    const body = JSON.stringify(await storyStats(c.env, days));
    c.executionCtx.waitUntil(
      cache.put(key, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=600' } })).catch(() => undefined),
    );
    return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
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

async function storyStats(env: Env, days: number): Promise<StoryStats> {
  const since = now() - days * DAY;
  const [active, arrived, followed, followedUnread, events, notes, notesWaitingRow, matchWaiting, top, sizes] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n, SUM(first_at >= ?1) AS started FROM stories WHERE last_at >= ?1').bind(since),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, SUM(story_id IS NOT NULL) AS in_story, SUM(news_id IS NOT NULL AND news_id != id) AS same_news
       FROM items INDEXED BY items_status_received WHERE status IN ('inbox', 'archived') AND received_at >= ?`,
    ).bind(since),
    env.DB.prepare('SELECT COUNT(*) AS n FROM stories INDEXED BY stories_followed WHERE followed_at IS NOT NULL'),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM items INDEXED BY items_story
       WHERE story_id IS NOT NULL AND story_id IN (SELECT id FROM stories INDEXED BY stories_followed WHERE followed_at IS NOT NULL)
         AND read_at IS NULL AND status = 'inbox'`,
    ),
    env.DB.prepare("SELECT type, COUNT(*) AS n FROM events INDEXED BY events_at WHERE at >= ? AND type IN ('story_link', 'story_split') GROUP BY type").bind(since),
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
  const ar = one<{ n: number; in_story: number | null; same_news: number | null }>(arrived);
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
    notes: { done: no.done ?? 0, failed: no.failed ?? 0, seconds: Math.round(no.seconds ?? 0), model: no.model ?? null, waiting: one<{ n: number }>(notesWaitingRow).n ?? 0 },
    matchWaiting: one<{ n: number }>(matchWaiting).n ?? 0,
    top: topRows
      .filter((r) => byId.has(r.story_id))
      .map((r) => ({ ...toStoryInfo(byId.get(r.story_id)!), periodItems: r.n, unread: r.unread })),
    sizes: ['2', '3-4', '5-9', '10+'].map((label) => ({ label, n: sizeMap.get(label) ?? 0 })),
  };
}
