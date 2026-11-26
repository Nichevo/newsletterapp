import type {
  CatchUp,
  CatchUpBanner,
  CatchUpItem,
  CatchUpJob,
  CatchUpJobItem,
  CatchUpLevel,
  CatchUpListItem,
  CatchUpResult,
  CatchUpSettings,
  CatchUpTagSuggestion,
  CatchUpTheme,
  CatchUpThemeRef,
} from '@newsletterapp/shared';
import { THEME_TAG_DAYS, THEME_TAG_MORNINGS, tagKey } from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { deviceOf, markRead } from './api';
import { isSavedPages, parseList, storyTitle } from './db';
import { levelSql, unreadCutoff } from './depth';
import { dayKey, localHour } from './digest';
import type { AppVariables, Env } from './env';
import { newId, now } from './ids';
import { addTagToItems } from './my-tags';
import { loadSettings } from './settings';

// Morning catch-up: a start-of-day review of what came in since your last
// visit, for the many items you would only skim and mark read. The hourly cron
// builds one at the morning hour (or after a long break with a big pile): the
// Worker picks the unread items, keeps the likely reads out (followed stories,
// Likely interesting, sources you usually read in full, saved pages), puts
// adverts and Probably not for you in a Probably skip pile, and groups the
// rest by category so the page works straight away. The PC then makes fresh
// themes from the embeddings and tags, names them, and writes one overview
// paragraph from the summaries it already has.
//
// Each item carries the lowest dial level that takes it in (Light 1, Normal 2,
// Deep 3, never 0), so the dial on the page re-cuts the catch-up at once.
// Cleared items are marked read with read_via 'catchup' (or Not interested
// from the Probably skip pile), so Source value counts them as skipped.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LEASE_MS = 20 * 60_000;
const MAX_ATTEMPTS = 3;
/** Most items one catch-up holds (newest first). */
const MAX_ITEMS = 400;
/** How far back a source's reading is looked at to place its items. */
const SOURCE_DAYS = 60;

interface Row {
  id: string;
  built_at: number;
  from_at: number;
  to_at: number;
  pack: string;
  written: string | null;
  status: CatchUp['status'];
  claimed_at: number | null;
  attempts: number;
  error: string | null;
  done_at: number | null;
  cleared: number;
  not_interested: number;
}

interface Pack {
  items: CatchUpItem[];
  /** Grouped by category: shown until the PC's themes arrive, and if it can't make them. */
  fallback: CatchUpTheme[];
}

interface Written {
  overview?: string;
  themes?: CatchUpTheme[];
  model?: string;
}

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The summary's opening sentence or two, else the preview line. */
function lineOf(summary: string | null, preheader: string | null): string | null {
  const s = (summary ?? '').replace(/[#*_>`]/g, '').replace(/\s+/g, ' ').trim();
  if (s) {
    const m = /^(.{40,200}?[.!?])(\s|$)/.exec(s);
    return clip(m?.[1] ?? s, 200);
  }
  return preheader ? clip(preheader, 200) : null;
}

// ---------- Your last visit ----------

/**
 * When you last used the app: the latest time anything was marked read. Two
 * index seeks (the inbox and archive keep their own read_at order).
 */
export async function lastVisit(env: Env): Promise<number> {
  const rows = await env.DB.batch([
    env.DB.prepare("SELECT MAX(read_at) AS at FROM items WHERE status = 'inbox'"),
    env.DB.prepare("SELECT MAX(read_at) AS at FROM items WHERE status = 'archived'"),
  ]);
  const at = Math.max(...rows.map((r) => Number((r.results[0] as { at?: number | null } | undefined)?.at ?? 0)));
  return at > 0 ? at : now() - DAY;
}

async function unreadSince(env: Env, from: number): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM items INDEXED BY items_status_received WHERE status = 'inbox' AND received_at > ? AND read_at IS NULL AND kind != 'ai'",
  )
    .bind(from)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

// ---------- Building ----------

interface ItemRow {
  id: string;
  subject: string | null;
  source_id: string | null;
  source_name: string | null;
  source_kind: string | null;
  source_url: string | null;
  received_at: number;
  summary: string | null;
  preheader: string | null;
  category: string | null;
  story_id: string | null;
  story_title: string | null;
  story_tags: string | null;
  followed_at: number | null;
  likely: number | null;
  sponsored: number | null;
  tags: string | null;
}

interface SourceHabit {
  rated: number;
  full: number;
  skipped: number;
  notInterested: number;
}

/** How you treated each source's items over the last two months (before this catch-up). */
async function sourceHabits(env: Env, sourceIds: string[], before: number): Promise<Map<string, SourceHabit>> {
  const out = new Map<string, SourceHabit>();
  for (let i = 0; i < sourceIds.length; i += 80) {
    const chunk = sourceIds.slice(i, i + 80);
    const rows = await env.DB.prepare(
      `SELECT source_id, COUNT(*) AS rated, SUM(lvl >= 4) AS full, SUM(lvl <= 1) AS skipped, SUM(lvl = 0) AS ni
       FROM (SELECT items.source_id, ${levelSql('items', 'ir', unreadCutoff(before))} AS lvl
             FROM items INDEXED BY items_source LEFT JOIN item_reads ir ON ir.item_id = items.id
             WHERE items.source_id IN (${chunk.map(() => '?').join(',')}) AND items.received_at >= ? AND items.received_at < ?
               AND items.status IN ('inbox', 'archived'))
       WHERE lvl IS NOT NULL GROUP BY source_id`,
    )
      .bind(...chunk, before - SOURCE_DAYS * DAY, before)
      .all<{ source_id: string; rated: number; full: number | null; skipped: number | null; ni: number | null }>();
    for (const r of rows.results) out.set(r.source_id, { rated: r.rated, full: r.full ?? 0, skipped: r.skipped ?? 0, notInterested: r.ni ?? 0 });
  }
  return out;
}

/** Where an item sits on the dial, and why. */
function place(r: ItemRow, habit: SourceHabit | undefined): Pick<CatchUpItem, 'level' | 'keep' | 'skip'> {
  // Likely reads: never taken in, shown greyed in their theme.
  if (r.followed_at) return { level: 0, keep: 'followed' };
  if (r.likely === 1) return { level: 0, keep: 'likely' };
  if (r.source_kind && isSavedPages({ kind: r.source_kind, url: r.source_url })) return { level: 0, keep: 'saved' };
  // Probably skip: taken in even at Light.
  if (r.sponsored === 2) return { level: 1, skip: 'advert' };
  if (r.likely === -1) return { level: 1, skip: 'unlikely' };
  if (habit && habit.rated >= 5 && habit.notInterested / habit.rated >= 0.3) return { level: 1, skip: 'not_interested' };
  if (habit && habit.rated >= 4) {
    // A source you usually read in full stays out unless the dial is on Deep.
    if (habit.full / habit.rated >= 0.4) return { level: 3, keep: 'source' };
    // One you nearly always skip goes even at Light.
    if (habit.rated >= 5 && habit.skipped / habit.rated >= 0.85) return { level: 1 };
  }
  return { level: 2 };
}

/** Groups by category (your own, else the source's), largest first: the page's first view and the fallback. */
function byCategory(items: CatchUpItem[]): CatchUpTheme[] {
  const groups = new Map<string, string[]>();
  for (const it of items) {
    if (it.skip) continue;
    const name = it.category || 'Other';
    groups.set(name, [...(groups.get(name) ?? []), it.id]);
  }
  return [...groups]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, ids]) => ({ id: `cat:${name}`, name, gist: null, fromCategory: true, itemIds: ids }));
}

/**
 * Builds a catch-up and queues it for the PC: what arrived since your last visit,
 * or (scope 'all', on demand) everything still unread in the inbox, newest first.
 */
export async function buildCatchUp(env: Env, at = now(), scope: 'since' | 'all' = 'since'): Promise<CatchUp | null> {
  const from = scope === 'all' ? 0 : await lastVisit(env);
  const rows = await env.DB.prepare(
    `SELECT items.id, items.subject, items.source_id, sources.name AS source_name, sources.kind AS source_kind, sources.url AS source_url,
            items.received_at, items.summary, items.preheader, COALESCE(items.category, sources.category) AS category,
            items.story_id, stories.title AS story_title, stories.tags AS story_tags, stories.followed_at,
            items.likely, items.sponsored, items.tags
     FROM items INDEXED BY items_status_received
       LEFT JOIN sources ON sources.id = items.source_id
       LEFT JOIN stories ON stories.id = items.story_id
     WHERE items.status = 'inbox' AND items.received_at > ? AND items.read_at IS NULL AND items.kind != 'ai'
     ORDER BY items.received_at DESC LIMIT ?`,
  )
    .bind(from, MAX_ITEMS)
    .all<ItemRow>();
  if (rows.results.length === 0) return null;
  const sourceIds = [...new Set(rows.results.map((r) => r.source_id).filter((s): s is string => !!s))];
  // Habits come from before the oldest item here, so this pile doesn't count against itself.
  const habits = await sourceHabits(env, sourceIds, Math.min(...rows.results.map((r) => r.received_at)));
  const items: CatchUpItem[] = rows.results.map((r) => ({
    id: r.id,
    subject: clip(r.subject || '(no subject)', 200),
    sourceId: r.source_id,
    sourceName: r.source_name,
    receivedAt: r.received_at,
    line: lineOf(r.summary, r.preheader),
    category: r.category,
    storyId: r.story_id,
    storyTitle: r.story_id ? storyTitle({ title: r.story_title, tags: r.story_tags }) : null,
    ...place(r, r.source_id ? habits.get(r.source_id) : undefined),
  }));
  const pack: Pack = { items, fallback: byCategory(items) };
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO catchups (id, built_at, from_at, to_at, pack, written, status, attempts, cleared, not_interested)
     VALUES (?, ?, ?, ?, ?, NULL, 'waiting', 0, 0, 0)`,
  )
    .bind(id, at, from, at, JSON.stringify(pack))
    .run();
  // An older catch-up nobody finished is covered by this one.
  await env.DB.prepare("UPDATE catchups SET done_at = ?, replaced = 1 WHERE id != ? AND done_at IS NULL").bind(at, id).run();
  return loadCatchUp(env, id);
}

/**
 * Called by the hourly cron: builds one at the morning hour when enough came in
 * since your last visit, or after a long break with a big pile.
 */
export async function buildCatchUpIfDue(env: Env): Promise<void> {
  const settings = await loadSettings(env);
  const c = settings.reviews.catchUp;
  if (!c.on) return;
  const at = now();
  const latest = await env.DB.prepare('SELECT built_at FROM catchups ORDER BY built_at DESC LIMIT 1').first<{ built_at: number }>();
  const from = await lastVisit(env);
  // You haven't been in since the last one was built: it still covers the pile (until it is most of a day old).
  if (latest && latest.built_at > from && at - latest.built_at < 20 * HOUR) return;
  const morning = localHour(at, settings.timezone) === c.hour && (!latest || dayKey(latest.built_at, settings.timezone) !== dayKey(at, settings.timezone));
  const away = c.afterBreak > 0 && at - from >= c.breakHours * HOUR && (!latest || at - latest.built_at >= c.breakHours * HOUR);
  if (!morning && !away) return;
  const n = await unreadSince(env, from);
  if ((morning && n >= c.minNew) || (away && n >= c.afterBreak)) await buildCatchUp(env, at);
}

async function rowOf(env: Env, id: string): Promise<Row | null> {
  return env.DB.prepare('SELECT * FROM catchups WHERE id = ?').bind(id).first<Row>();
}

/** The catch-up as the page shows it, with what has been read or moved since. */
async function loadCatchUp(env: Env, id: string, settings?: CatchUpSettings): Promise<CatchUp | null> {
  const row = await rowOf(env, id);
  if (!row) return null;
  const c = settings ?? (await loadSettings(env)).reviews.catchUp;
  const pack = parse<Pack>(row.pack, { items: [], fallback: [] });
  const written = parse<Written>(row.written, {});
  const ids = pack.items.map((i) => i.id);
  const still = new Set<string>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const r = await env.DB.prepare(`SELECT id FROM items WHERE id IN (${chunk.map(() => '?').join(',')}) AND status = 'inbox' AND read_at IS NULL`)
      .bind(...chunk)
      .all<{ id: string }>();
    for (const x of r.results) still.add(x.id);
  }
  return {
    id: row.id,
    builtAt: row.built_at,
    fromAt: row.from_at,
    toAt: row.to_at,
    items: pack.items,
    themes: written.themes?.length ? written.themes : pack.fallback,
    overview: written.overview ?? null,
    model: written.model ?? null,
    status: row.status,
    error: row.error,
    doneAt: row.done_at,
    goneIds: ids.filter((x) => !still.has(x)),
    cleared: row.cleared,
    notInterested: row.not_interested,
    startLevel: c.startLevel,
    skipPile: c.skipPile,
    tagSuggestions: await tagSuggestions(env),
  };
}

/**
 * Themes the PC named on THEME_TAG_MORNINGS or more mornings in the last
 * THEME_TAG_DAYS, not answered before and not already a tag: offered once each.
 */
async function tagSuggestions(env: Env): Promise<CatchUpTagSuggestion[]> {
  const rows = await env.DB.prepare(
    `SELECT key, MAX(name) AS name, COUNT(DISTINCT catchup_id) AS mornings, SUM(items) AS items
     FROM catchup_themes INDEXED BY catchup_themes_recent
     WHERE built_at >= ? AND key NOT IN (SELECT key FROM theme_tag_choices)
     GROUP BY key HAVING mornings >= ? ORDER BY mornings DESC, items DESC LIMIT 6`,
  )
    .bind(now() - THEME_TAG_DAYS * DAY, THEME_TAG_MORNINGS)
    .all<{ key: string; name: string; mornings: number; items: number }>();
  if (!rows.results.length) return [];
  const tags = rows.results.map((r) => tagKey(r.name));
  const have = await env.DB.prepare(`SELECT tag FROM tag_counts WHERE tag IN (${tags.map(() => '?').join(',')})`)
    .bind(...tags)
    .all<{ tag: string }>();
  const exists = new Set(have.results.map((r) => r.tag));
  return rows.results
    .filter((r) => !exists.has(tagKey(r.name)))
    .slice(0, 2)
    .map((r) => ({ key: r.key, name: r.name, tag: r.name.toLowerCase(), mornings: r.mornings, items: r.items }));
}

/** For /api/me: the inbox banner, when a catch-up is ready and not done. Reads one row. */
export async function catchUpBanner(env: Env, c: CatchUpSettings): Promise<CatchUpBanner | null> {
  if (!c.on || !c.banner) return null;
  const row = await env.DB.prepare(
    'SELECT id, pack, cleared, not_interested FROM catchups WHERE done_at IS NULL AND built_at > ? ORDER BY built_at DESC LIMIT 1',
  )
    .bind(now() - DAY)
    .first<{ id: string; pack: string; cleared: number; not_interested: number }>();
  if (!row) return null;
  const pack = parse<Pack>(row.pack, { items: [], fallback: [] });
  const toSkim = pack.items.filter((i) => i.level !== 0 && i.level <= c.startLevel).length - row.cleared - row.not_interested;
  if (toSkim <= 0) return null;
  return { id: row.id, toSkim, kept: pack.items.length - toSkim - row.cleared - row.not_interested };
}

// ---------- The PC's job ----------

const PROMPT = `You help one reader skim the pile of newsletters, feeds and posts that arrived while they were away. These are the items they would mostly mark read without opening. The items have already been grouped into themes on their PC; each group lists its items as "[number] headline (source): summary".

Reply with JSON only:
{"overview": "...", "themes": [{"group": 1, "name": "...", "gist": "..."}]}
- "overview": 3 or 4 plain sentences on what the pile holds: which stories took up the most items and what happened in them, and what the rest is. Say plainly when nothing in it looks important. Use the numbers of items where it helps ("Nvidia's results filled 14 items").
- "themes": one entry per group, in the order given. "name": 2 to 5 words naming what the group is about, specific to its items (not just "Technology"); for a group marked [category], keep the category name unless a more specific name fits all its items. "gist": one sentence (at most 25 words) on what happened in this group, the main news first.
- Write plainly, like a well-read friend. No greetings, no lists inside strings, no markdown.`;

async function claimJob(env: Env): Promise<CatchUpJob | null> {
  const t = now();
  await env.DB.prepare(
    `UPDATE catchups SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'waiting' END,
       error = CASE WHEN attempts >= ? THEN COALESCE(error, 'Timed out on the PC') ELSE error END
     WHERE status = 'working' AND claimed_at < ?`,
  )
    .bind(MAX_ATTEMPTS, MAX_ATTEMPTS, t - LEASE_MS)
    .run();
  const row = await env.DB.prepare("SELECT * FROM catchups WHERE status = 'waiting' AND done_at IS NULL ORDER BY built_at DESC LIMIT 1").first<Row>();
  if (!row) return null;
  const claimed = await env.DB.prepare("UPDATE catchups SET status = 'working', claimed_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'waiting'")
    .bind(t, row.id)
    .run();
  if (!claimed.meta.changes) return null;
  const pack = parse<Pack>(row.pack, { items: [], fallback: [] });
  const grouped = pack.items.filter((i) => !i.skip);
  // Tags and summaries for the PC (the pack keeps only the opening line).
  const extra = new Map<string, { tags: string[]; summary: string | null }>();
  for (let i = 0; i < grouped.length; i += 90) {
    const chunk = grouped.slice(i, i + 90).map((x) => x.id);
    const r = await env.DB.prepare(`SELECT id, tags, summary, preheader FROM items WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<{ id: string; tags: string | null; summary: string | null; preheader: string | null }>();
    for (const x of r.results) extra.set(x.id, { tags: parseList(x.tags).slice(0, 8), summary: x.summary ?? x.preheader });
  }
  const items: CatchUpJobItem[] = grouped.map((it, n) => ({
    n: n + 1,
    id: it.id,
    text: `${clip(it.subject, 140)} (${it.sourceName ?? 'unknown'}): ${clip(extra.get(it.id)?.summary ?? it.line, 300)}`,
    tags: extra.get(it.id)?.tags ?? [],
    category: it.category,
    storyId: it.storyId,
  }));
  const settings = await loadSettings(env);
  const recent = await env.DB.prepare(
    'SELECT MAX(name) AS name FROM catchup_themes INDEXED BY catchup_themes_recent WHERE built_at >= ? GROUP BY key ORDER BY MAX(built_at) DESC LIMIT 40',
  )
    .bind(now() - THEME_TAG_DAYS * DAY)
    .all<{ name: string }>();
  const recentThemes = recent.results.map((r) => r.name);
  const prompt = recentThemes.length
    ? `${PROMPT}\n- Themes from earlier mornings: ${recentThemes.map((n) => `"${n.replace(/"/g, "'")}"`).join(', ')}. When a group is about the same thing as one of these, use that exact name, so a theme that keeps coming back keeps its name.`
    : PROMPT;
  return { catchUpId: row.id, prompt, items, categories: settings.categories, recentThemes };
}

async function saveResult(env: Env, r: CatchUpResult): Promise<void> {
  const row = await rowOf(env, String(r.catchUpId));
  if (!row) return;
  if (!r.ok) {
    const failed = row.attempts >= MAX_ATTEMPTS;
    await env.DB.prepare('UPDATE catchups SET status = ?, error = ?, claimed_at = NULL WHERE id = ?')
      .bind(failed ? 'failed' : 'waiting', clip(r.error ?? 'The PC could not make the themes', 300), row.id)
      .run();
    return;
  }
  const pack = parse<Pack>(row.pack, { items: [], fallback: [] });
  const known = new Set(pack.items.filter((i) => !i.skip).map((i) => i.id));
  const used = new Set<string>();
  const themes: CatchUpTheme[] = [];
  for (const t of Array.isArray(r.themes) ? r.themes : []) {
    const ids = (Array.isArray(t?.itemIds) ? t.itemIds : []).map(String).filter((id) => known.has(id) && !used.has(id));
    if (!ids.length) continue;
    ids.forEach((id) => used.add(id));
    themes.push({ id: `t${themes.length + 1}`, name: clip(t.name, 60) || 'Other', gist: clip(t.gist, 300) || null, fromCategory: t.fromCategory === true, itemIds: ids });
  }
  // Anything the PC left out goes under its category, so nothing goes missing.
  const left = pack.items.filter((i) => known.has(i.id) && !used.has(i.id));
  for (const g of byCategory(left)) {
    const same = themes.find((t) => t.fromCategory && t.name.toLowerCase() === g.name.toLowerCase());
    if (same) same.itemIds.push(...g.itemIds);
    else themes.push(g);
  }
  const written: Written = { overview: clip(r.overview, 1200) || undefined, themes, model: `${r.model} via ${r.provider}` };
  await env.DB.prepare("UPDATE catchups SET written = ?, status = 'done', error = NULL, claimed_at = NULL, seconds = ? WHERE id = ?")
    .bind(JSON.stringify(written), Number(r.seconds) || null, row.id)
    .run();
  await storeThemes(env, row, themes.filter((t) => !t.fromCategory));
}

/** Keeps the PC's themes (not the category fallbacks) for the reader's theme chip and the tag suggestions. */
async function storeThemes(env: Env, row: Row, themes: CatchUpTheme[]): Promise<void> {
  const stmts = [env.DB.prepare('DELETE FROM catchup_themes WHERE catchup_id = ?').bind(row.id)];
  for (const t of themes) {
    stmts.push(
      env.DB.prepare('INSERT INTO catchup_themes (catchup_id, theme_id, name, key, built_at, items) VALUES (?, ?, ?, ?, ?, ?)').bind(
        row.id,
        t.id,
        t.name,
        t.name.toLowerCase().replace(/\s+/g, ' ').trim(),
        row.built_at,
        t.itemIds.length,
      ),
    );
    for (let i = 0; i < t.itemIds.length; i += 30) {
      const chunk = t.itemIds.slice(i, i + 30);
      stmts.push(
        env.DB.prepare(
          `INSERT INTO catchup_item_themes (item_id, catchup_id, theme_id) VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}
           ON CONFLICT(item_id) DO UPDATE SET catchup_id = excluded.catchup_id, theme_id = excluded.theme_id`,
        ).bind(...chunk.flatMap((id) => [id, row.id, t.id])),
      );
    }
  }
  await env.DB.batch(stmts);
}

/** For the helper's check-in: whether a catch-up is waiting for its themes. */
export async function catchUpHeartbeat(env: Env, paused: boolean): Promise<{ catchUpWaiting?: boolean }> {
  if (paused) return {};
  const row = await env.DB.prepare(
    "SELECT 1 AS x FROM catchups WHERE done_at IS NULL AND (status = 'waiting' OR (status = 'working' AND claimed_at < ?)) LIMIT 1",
  )
    .bind(now() - LEASE_MS)
    .first();
  return row ? { catchUpWaiting: true } : {};
}

// ---------- Routes ----------

const idList = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))].slice(0, MAX_ITEMS) : []);

export function registerCatchUp(app: App) {
  /** The latest catch-up (or null), and the ones before it. */
  app.get('/api/catchup', async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT id, built_at, done_at, cleared + not_interested AS cleared, json_array_length(pack, '$.items') AS total FROM catchups ORDER BY built_at DESC LIMIT 8",
    ).all<{ id: string; built_at: number; done_at: number | null; cleared: number; total: number }>();
    const list: CatchUpListItem[] = rows.results.map((r) => ({ id: r.id, builtAt: r.built_at, total: r.total, cleared: r.cleared, doneAt: r.done_at }));
    const first = rows.results[0];
    const latest = first ? await loadCatchUp(c.env, first.id) : null;
    return c.json({ latest, list });
  });

  /** The inbox banner: a catch-up that is ready and not done. */
  app.get('/api/catchup/banner', async (c) => c.json({ banner: await catchUpBanner(c.env, (await loadSettings(c.env)).reviews.catchUp) }));

  /** The reader's theme chip: the catch-up theme this article was last grouped under. */
  app.get('/api/items/:id/catchup-theme', async (c) => {
    const r = await c.env.DB.prepare(
      `SELECT t.catchup_id, t.theme_id, t.name, t.built_at FROM catchup_item_themes it
       JOIN catchup_themes t ON t.catchup_id = it.catchup_id AND t.theme_id = it.theme_id WHERE it.item_id = ?`,
    )
      .bind(c.req.param('id'))
      .first<{ catchup_id: string; theme_id: string; name: string; built_at: number }>();
    const ref: CatchUpThemeRef | null = r ? { catchUpId: r.catchup_id, themeId: r.theme_id, name: r.name, builtAt: r.built_at } : null;
    return c.json({ theme: ref });
  });

  /** Answers "make this theme a tag?": tag puts it on every article grouped under it; no stops asking. */
  app.post('/api/catchup/theme-tag', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { key?: unknown; tag?: unknown; action?: unknown };
    const key = typeof body.key === 'string' ? body.key.slice(0, 120) : '';
    if (!key) return c.json({ error: 'no theme' }, 400);
    const t = now();
    if (body.action !== 'tag') {
      await c.env.DB.prepare("INSERT INTO theme_tag_choices (key, choice, tag, at) VALUES (?, 'no', NULL, ?) ON CONFLICT(key) DO UPDATE SET choice = 'no', at = ?")
        .bind(key, t, t)
        .run();
      return c.json({ tagged: 0 });
    }
    const label = typeof body.tag === 'string' ? body.tag : '';
    if (!tagKey(label)) return c.json({ error: 'Type a tag first' }, 400);
    const ids = await c.env.DB.prepare(
      `SELECT DISTINCT it.item_id FROM catchup_themes t INDEXED BY catchup_themes_key
       JOIN catchup_item_themes it ON it.catchup_id = t.catchup_id AND it.theme_id = t.theme_id WHERE t.key = ? LIMIT 1000`,
    )
      .bind(key)
      .all<{ item_id: string }>();
    const tagged = await addTagToItems(c.env, ids.results.map((r) => r.item_id), label);
    await c.env.DB.prepare("INSERT INTO theme_tag_choices (key, choice, tag, at) VALUES (?, 'tag', ?, ?) ON CONFLICT(key) DO UPDATE SET choice = 'tag', tag = ?, at = ?")
      .bind(key, label, t, label, t)
      .run();
    return c.json({ tagged });
  });

  app.get('/api/catchup/:id', async (c) => {
    const r = await loadCatchUp(c.env, c.req.param('id'));
    return r ? c.json(r) : c.json({ error: 'not found' }, 404);
  });

  /** Builds one now: since your last visit, or { scope: 'all' } for everything unread in the inbox. */
  app.post('/api/catchup/build', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { scope?: unknown };
    const scope = body.scope === 'all' ? 'all' : 'since';
    const r = await buildCatchUp(c.env, now(), scope);
    return r ? c.json(r) : c.json({ error: scope === 'all' ? 'Nothing unread in your inbox' : 'Nothing has come in since your last visit' }, 409);
  });

  /** Clears items: marked read as "cleared in catch-up", or Not interested (the Probably skip pile). */
  app.post('/api/catchup/:id/clear', async (c) => {
    const row = await rowOf(c.env, c.req.param('id'));
    if (!row) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown; notInterested?: unknown; device?: unknown };
    const pack = parse<Pack>(row.pack, { items: [], fallback: [] });
    const inPack = new Set(pack.items.map((i) => i.id));
    const ids = idList(body.ids).filter((id) => inPack.has(id));
    const ni = body.notInterested === true;
    const n = await markRead(c.env, ids, ni ? 'not_interested' : 'catchup', deviceOf(c, body.device));
    await c.env.DB.prepare(`UPDATE catchups SET ${ni ? 'not_interested = not_interested' : 'cleared = cleared'} + ? WHERE id = ?`)
      .bind(n, row.id)
      .run();
    return c.json({ cleared: n });
  });

  /** Undo: puts back items this catch-up cleared (only those it marked read). */
  app.post('/api/catchup/:id/unclear', async (c) => {
    const row = await rowOf(c.env, c.req.param('id'));
    if (!row) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    const pack = parse<Pack>(row.pack, { items: [], fallback: [] });
    const inPack = new Set(pack.items.map((i) => i.id));
    const ids = idList(body.ids).filter((id) => inPack.has(id));
    let cleared = 0;
    let ni = 0;
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const marks = chunk.map(() => '?').join(',');
      const counts = await c.env.DB.prepare(
        `SELECT SUM(read_via = 'catchup') AS c, SUM(read_via = 'not_interested') AS n FROM items WHERE id IN (${marks}) AND read_at >= ?`,
      )
        .bind(...chunk, row.built_at)
        .first<{ c: number | null; n: number | null }>();
      cleared += counts?.c ?? 0;
      ni += counts?.n ?? 0;
      await c.env.DB.prepare(
        `UPDATE items SET read_at = NULL, read_via = NULL, read_device = NULL WHERE id IN (${marks}) AND read_via IN ('catchup', 'not_interested') AND read_at >= ?`,
      )
        .bind(...chunk, row.built_at)
        .run();
    }
    await c.env.DB.prepare('UPDATE catchups SET cleared = MAX(0, cleared - ?), not_interested = MAX(0, not_interested - ?), done_at = NULL, replaced = 0 WHERE id = ?')
      .bind(cleared, ni, row.id)
      .run();
    return c.json({ restored: cleared + ni });
  });

  app.post('/api/catchup/:id/done', async (c) => {
    const t = now();
    await c.env.DB.prepare('UPDATE catchups SET done_at = COALESCE(done_at, ?) WHERE id = ?').bind(t, c.req.param('id')).run();
    return c.json({ doneAt: t });
  });

  /** Undo for Done: the catch-up shows again. */
  app.post('/api/catchup/:id/undone', async (c) => {
    await c.env.DB.prepare('UPDATE catchups SET done_at = NULL, replaced = 0 WHERE id = ?').bind(c.req.param('id')).run();
    return c.json({ doneAt: null });
  });

  app.post('/api/catchup/:id/retry', async (c) => {
    await c.env.DB.prepare("UPDATE catchups SET written = NULL, status = 'waiting', attempts = 0, error = NULL, claimed_at = NULL WHERE id = ?")
      .bind(c.req.param('id'))
      .run();
    return c.json({ status: 'waiting' });
  });

  // ----- Helper side -----

  app.post('/api/helper/catchup/claim', async (c) => c.json({ job: await claimJob(c.env) }));

  app.post('/api/helper/catchup/result', async (c) => {
    const r = (await c.req.json().catch(() => null)) as CatchUpResult | null;
    if (!r || typeof r.catchUpId !== 'string') return c.json({ error: 'bad result' }, 400);
    await saveResult(c.env, r);
    return c.json({ ok: true });
  });
}

