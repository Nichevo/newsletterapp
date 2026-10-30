import type { Env } from './env';
import { now } from './ids';

// A 0-100 "worth your time" score for each recent item, used by the Top sort
// and the daily digest. Plain rules, no AI calls: how much you have engaged
// with the source lately, what the summary says about the issue, and how
// fresh it is. Recomputed by the hourly cron for the last week of items.

const DAY = 86_400_000;
const LOOKBACK_DAYS = 7; // items this old or newer get rescored
const AFFINITY_DAYS = 90; // reading history that counts towards a source's affinity

interface SourceStats {
  items: number;
  opened: number;
  saved: number;
  finished: number; // finish events at 70% or more
  readSeconds: number;
}

interface ScoreRow {
  id: string;
  source_id: string | null;
  received_at: number;
  why_it_matters: string | null;
  key_points: string | null;
  thin_content: number;
  sponsored: number;
  word_count: number | null;
  saved_at: number | null;
  ai_status: string | null;
}

/** How much you have engaged with each source lately: 0 (never open it) to 1 (read nearly everything). */
async function sourceAffinity(env: Env, since: number): Promise<Map<string, number>> {
  const rows = await env.DB.prepare(
    `SELECT items.source_id,
       COUNT(*) AS items,
       SUM(items.read_at IS NOT NULL) AS opened,
       SUM(items.saved_at IS NOT NULL) AS saved,
       SUM(EXISTS (SELECT 1 FROM events WHERE events.item_id = items.id AND events.type = 'finish' AND events.value >= 70)) AS finished,
       (SELECT COALESCE(SUM(value), 0) FROM events WHERE events.type = 'read_time'
          AND events.item_id IN (SELECT id FROM items i2 WHERE i2.source_id = items.source_id AND i2.received_at >= ?1)) AS read_seconds
     FROM items
     WHERE items.received_at >= ?1 AND items.status IN ('inbox', 'archived') AND items.source_id IS NOT NULL
     GROUP BY items.source_id`,
  )
    .bind(since)
    .all<{ source_id: string } & { items: number; opened: number; saved: number; finished: number; read_seconds: number }>();

  const out = new Map<string, number>();
  for (const r of rows.results) {
    const s: SourceStats = { items: r.items, opened: r.opened, saved: r.saved, finished: r.finished, readSeconds: r.read_seconds };
    if (s.items < 2) continue; // too new to judge; stays at the neutral default
    const openRate = s.opened / s.items;
    const finishRate = s.finished / s.items;
    const saveRate = s.saved / s.items;
    const minutesPerItem = s.readSeconds / 60 / s.items;
    const affinity = 0.45 * openRate + 0.3 * finishRate + 0.15 * Math.min(1, saveRate * 3) + 0.1 * Math.min(1, minutesPerItem / 3);
    out.set(r.source_id, Math.max(0, Math.min(1, affinity)));
  }
  return out;
}

function parseCount(json: string | null): number {
  if (!json) return 0;
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}

export function scoreFor(row: ScoreRow, affinity: number | undefined, at: number): number {
  let score = 50;
  // Source affinity moves the score by up to -20 .. +30; unknown sources sit in the middle.
  score += affinity === undefined ? 0 : Math.round(affinity * 50 - 20);
  if (row.ai_status === 'done') {
    if (row.why_it_matters) score += 10;
    if (parseCount(row.key_points) >= 3) score += 5;
    if (row.thin_content) score -= 15;
  }
  if (row.sponsored) score -= 5;
  if (row.saved_at) score += 10;
  if (row.word_count !== null && row.word_count < 120) score -= 10; // a teaser or a notice
  // Freshness: full marks for today, fading to -10 after a week.
  const ageDays = Math.max(0, (at - row.received_at) / DAY);
  score -= Math.round(Math.min(10, ageDays * 1.5));
  return Math.max(0, Math.min(100, score));
}

/** Rescores items from the last week. Cheap: one grouped query plus one small update per item. */
export async function scoreRecentItems(env: Env): Promise<number> {
  const at = now();
  const affinity = await sourceAffinity(env, at - AFFINITY_DAYS * DAY);
  const rows = await env.DB.prepare(
    `SELECT id, source_id, received_at, why_it_matters, key_points, thin_content, sponsored, word_count, saved_at, ai_status
     FROM items WHERE received_at >= ? AND status IN ('inbox', 'archived')`,
  )
    .bind(at - LOOKBACK_DAYS * DAY)
    .all<ScoreRow>();

  const updates = rows.results.map((row) => {
    const score = scoreFor(row, row.source_id ? affinity.get(row.source_id) : undefined, at);
    return env.DB.prepare('UPDATE items SET score = ?1 WHERE id = ?2 AND COALESCE(score, -1) != ?1').bind(score, row.id);
  });
  for (let i = 0; i < updates.length; i += 50) await env.DB.batch(updates.slice(i, i + 50));
  return rows.results.length;
}
