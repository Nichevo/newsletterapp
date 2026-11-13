import { DEPTH_LEVELS, DEPTH_SECONDS, DEPTH_UNREAD_DAYS, emptyDepth, type DepthCounts, type GlanceInput, type ReadingEventType, type SourceDepthDetail } from '@newsletterapp/shared';
import type { Hono } from 'hono';
import type { AppVariables, Env } from './env';
import { now } from './ids';

// How far you went with each item: Not interested, Skipped, Glanced, Read the
// summary, Read the article, Kept. Worked out from small counters kept per item
// in item_reads (seconds at the inbox reading line, seconds on the AI summary and
// in the article, furthest scroll, Live page opened), so a source's picture is
// one grouped read of its items, with no join to the events table. item_reads is
// its own table because items is at D1's 100-columns-per-result limit.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const DAY = 86_400_000;
const { glance: GLANCE, summary: SUMMARY, article: ARTICLE } = DEPTH_SECONDS;
const FINISHED_AT = 70; // scrolled at least this far through the article

/**
 * An item's level as an index into DEPTH_LEVELS (0 = Not interested .. 5 = Kept), or
 * NULL for an item you haven't looked at yet. `i` is the items table's name in the
 * query and `r` its LEFT JOINed item_reads row; `unreadBefore` is the time before which
 * a still-unread item counts as skipped. Visits from before summary and article time
 * were kept apart (summary_secs NULL) count their reader time as article time, as the
 * app used to.
 */
export function levelSql(i: string, r: string, unreadBefore: number): string {
  return `(CASE
    WHEN ${i}.read_via = 'not_interested' THEN 0
    WHEN ${i}.saved_at IS NOT NULL OR ${i}.interesting_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM highlights h WHERE h.item_id = ${i}.id AND h.deleted_at IS NULL) THEN 5
    WHEN COALESCE(${r}.article_secs, 0) >= ${ARTICLE} OR ${r}.live_opened = 1
      OR (${r}.summary_secs IS NULL AND COALESCE(${r}.read_secs, 0) >= ${ARTICLE})
      OR (COALESCE(${r}.scroll_pct, 0) >= ${FINISHED_AT} AND COALESCE(${r}.article_secs, ${r}.read_secs, 0) >= 10) THEN 4
    WHEN COALESCE(${r}.summary_secs, 0) + COALESCE(${r}.glance_secs, 0) >= ${SUMMARY} THEN 3
    WHEN COALESCE(${r}.glance_secs, 0) + COALESCE(${r}.read_secs, 0) >= ${GLANCE} THEN 2
    WHEN ${i}.read_at IS NOT NULL OR ${i}.status = 'archived' OR ${i}.received_at < ${Math.floor(unreadBefore)} THEN 1
  END)`;
}

export const unreadCutoff = (at: number) => at - DEPTH_UNREAD_DAYS * DAY;

export interface SourceDepthRow {
  items: number;
  first: number;
  reads: number; // glanced or more
  stars: number;
  depth: DepthCounts;
}

/** Each source's items since `since`, counted by level: one grouped read of those items. */
export async function depthBySource(env: Env, since: number, at = now()): Promise<Map<string, SourceDepthRow>> {
  const sums = DEPTH_LEVELS.map((_, n) => `SUM(lvl = ${n}) AS d${n}`).join(', ');
  const rows = await env.DB.prepare(
    `SELECT source_id, COUNT(*) AS items, MIN(received_at) AS first, SUM(lvl >= 2) AS reads, SUM(interesting_at IS NOT NULL) AS stars, ${sums}
     FROM (SELECT items.source_id, items.received_at, items.interesting_at, ${levelSql('items', 'ir', unreadCutoff(at))} AS lvl
           FROM items LEFT JOIN item_reads ir ON ir.item_id = items.id
           WHERE items.status IN ('inbox', 'archived') AND items.received_at >= ? AND items.source_id IS NOT NULL)
     GROUP BY source_id`,
  )
    .bind(since)
    .all<Record<string, number | string | null>>();
  const out = new Map<string, SourceDepthRow>();
  for (const r of rows.results) {
    const depth = emptyDepth();
    DEPTH_LEVELS.forEach((l, n) => (depth[l] = Number(r[`d${n}`] ?? 0)));
    out.set(String(r.source_id), {
      items: Number(r.items),
      first: Number(r.first),
      reads: Number(r.reads ?? 0),
      stars: Number(r.stars ?? 0),
      depth,
    });
  }
  return out;
}

/**
 * Keeps the item's counters up to date as reading events arrive (one small UPDATE).
 * Returns nothing; an event that says nothing about depth is ignored.
 */
export async function applyDepthEvent(env: Env, itemId: string, type: ReadingEventType, value: number | undefined): Promise<void> {
  const v = Math.max(0, Math.min(3600, Math.round(Number(value) || 0)));
  const set: Partial<Record<ReadingEventType, string>> = {
    read_time: 'read_secs = COALESCE(read_secs, 0) + excluded.read_secs',
    summary_time: 'summary_secs = COALESCE(summary_secs, 0) + excluded.summary_secs',
    article_time: 'article_secs = COALESCE(article_secs, 0) + excluded.article_secs',
    finish: 'scroll_pct = MAX(COALESCE(scroll_pct, 0), excluded.scroll_pct)',
    open_original: 'live_opened = 1',
  };
  const column: Partial<Record<ReadingEventType, string>> = {
    read_time: 'read_secs',
    summary_time: 'summary_secs',
    article_time: 'article_secs',
    finish: 'scroll_pct',
    open_original: 'live_opened',
  };
  const col = column[type];
  if (!col) return;
  await env.DB.prepare(`INSERT INTO item_reads (item_id, ${col}) VALUES (?1, ?2) ON CONFLICT(item_id) DO UPDATE SET ${set[type]}`)
    .bind(itemId, type === 'open_original' ? 1 : v)
    .run();
}

export function registerDepth(app: App) {
  /** Seconds inbox rows sat at the reading line, sent once when you leave the inbox. */
  app.post('/api/items/glances', async (c) => {
    const input = (await c.req.json().catch(() => null)) as GlanceInput | null;
    const list = (Array.isArray(input?.items) ? input.items : [])
      .filter((g) => g && typeof g.id === 'string' && Number(g.secs) >= 1)
      .slice(0, 200)
      .map((g) => ({ id: g.id, secs: Math.min(600, Math.round(Number(g.secs))) }));
    if (!list.length) return c.json({ ok: true, changed: 0 });
    const stmts = list.map((g) =>
      c.env.DB.prepare(
        `INSERT INTO item_reads (item_id, glance_secs) SELECT ?2, ?1 WHERE EXISTS (SELECT 1 FROM items WHERE id = ?2)
         ON CONFLICT(item_id) DO UPDATE SET glance_secs = MIN(COALESCE(glance_secs, 0) + excluded.glance_secs, 3600)`,
      ).bind(g.secs, g.id),
    );
    for (let i = 0; i < stmts.length; i += 50) await c.env.DB.batch(stmts.slice(i, i + 50));
    return c.json({ ok: true, changed: list.length });
  });

  /** One source's reading over the last 90 days in 30-day steps, for its own page. */
  app.get('/api/sources/:id/depth', async (c) => {
    const at = now();
    const from = at - 90 * DAY;
    const [levels, sums] = await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT MIN(2, CAST((?1 - received_at) / ${30 * DAY} AS INTEGER)) AS b, lvl, COUNT(*) AS n
         FROM (SELECT items.received_at, ${levelSql('items', 'ir', unreadCutoff(at))} AS lvl
               FROM items LEFT JOIN item_reads ir ON ir.item_id = items.id
               WHERE items.source_id = ?2 AND items.status IN ('inbox', 'archived') AND items.received_at >= ?3)
         WHERE lvl IS NOT NULL GROUP BY b, lvl`,
      ).bind(at, c.req.param('id'), from),
      c.env.DB.prepare(
        `SELECT COALESCE(SUM(ir.summary_secs), 0) AS summary, COALESCE(SUM(ir.article_secs), 0) AS article, COALESCE(SUM(ir.glance_secs), 0) AS glance,
           SUM(ir.glance_secs >= ?2) AS inbox, SUM(ir.summary_secs >= ?2) AS reader, SUM(ir.live_opened = 1) AS live
         FROM items JOIN item_reads ir ON ir.item_id = items.id
         WHERE items.source_id = ?1 AND items.status IN ('inbox', 'archived') AND items.received_at >= ?3`,
      ).bind(c.req.param('id'), SUMMARY, from),
    ]);
    const buckets = [emptyDepth(), emptyDepth(), emptyDepth()];
    for (const r of (levels?.results ?? []) as { b: number; lvl: number; n: number }[]) {
      const level = DEPTH_LEVELS[r.lvl];
      const bucket = buckets[Math.max(0, Math.min(2, r.b))];
      if (level && bucket) bucket[level] += r.n;
    }
    const s = ((sums?.results ?? [])[0] ?? {}) as Record<string, number | null>;
    const out: SourceDepthDetail = {
      buckets,
      summarySecs: s.summary ?? 0,
      articleSecs: s.article ?? 0,
      glanceSecs: s.glance ?? 0,
      summaryInInbox: s.inbox ?? 0,
      summaryInReader: s.reader ?? 0,
      liveOpened: s.live ?? 0,
    };
    return c.json(out);
  });
}
