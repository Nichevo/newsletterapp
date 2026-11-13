import { readJson, writeJson } from './ai';
import { loadSettings } from './settings';
import { depthTotal, depthValue, type TopLean } from '@newsletterapp/shared';
import { depthBySource } from './depth';
import type { Env } from './env';
import { now } from './ids';

// A 0-100 "worth your time" score for each recent item, used by the Top sort
// and the daily digest. Plain rules, no AI calls: how much you have engaged
// with the source lately, what the summary says about the issue, and how
// fresh it is. Recomputed by the hourly cron for the last week of items.

const DAY = 86_400_000;
const LOOKBACK_DAYS = 7; // items this old or newer get rescored
const AFFINITY_DAYS = 90; // reading history that counts towards a source's affinity

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
  interesting_at: number | null;
  ai_status: string | null;
  likely?: number | null;
}

/**
 * How much you have engaged with each source lately: 0 (always skip it) to 1 (keep or
 * read nearly everything). Its value from how far you went with each item (see
 * depth.ts), so a swipe without looking no longer counts as reading it.
 */
async function sourceAffinity(env: Env, since: number): Promise<Map<string, number>> {
  const rows = await depthBySource(env, since);
  const out = new Map<string, number>();
  for (const [id, r] of rows) {
    if (depthTotal(r.depth) < 2) continue; // too new to judge; stays at the neutral default
    out.set(id, Math.max(0, Math.min(1, (depthValue(r.depth) ?? 0) / 100)));
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

/**
 * What the Top sort leans towards (Settings > Reading). Balanced is the original mix;
 * Newest lets age count for much more; My favourite sources lets source affinity count more.
 */
const LEAN: Record<TopLean, { affinity: number; agePerDay: number; ageMax: number }> = {
  newest: { affinity: 0.5, agePerDay: 4.5, ageMax: 30 },
  balanced: { affinity: 1, agePerDay: 1.5, ageMax: 10 },
  favourites: { affinity: 1.6, agePerDay: 0.75, ageMax: 5 },
};

export function scoreFor(row: ScoreRow, affinity: number | undefined, at: number, lean: TopLean = 'balanced'): number {
  const w = LEAN[lean];
  let score = 50;
  // Source affinity moves the score by up to -20 .. +30 (Balanced); unknown sources sit in the middle.
  score += affinity === undefined ? 0 : Math.round((affinity * 50 - 20) * w.affinity);
  if (row.ai_status === 'done') {
    if (row.why_it_matters) score += 10;
    if (parseCount(row.key_points) >= 3) score += 5;
    if (row.thin_content) score -= 15;
  }
  if (row.sponsored) score -= 5;
  if (row.saved_at) score += 10;
  if (row.interesting_at) score += 15;
  // Close to what you marked Not interested (and not to your stars): pushed down the Top sort.
  if (row.likely === -1) score -= 15;
  if (row.word_count !== null && row.word_count < 120) score -= 10; // a teaser or a notice
  // Freshness: full marks for today, fading (Balanced: to -10 after a week).
  const ageDays = Math.max(0, (at - row.received_at) / DAY);
  score -= Math.round(Math.min(w.ageMax, ageDays * w.agePerDay));
  return Math.max(0, Math.min(100, score));
}

/**
 * Source affinity looks back 90 days, so it barely moves within a day: work it out
 * once a day and keep it, rather than reading 90 days of items and events every hour.
 */
async function cachedAffinity(env: Env, at: number): Promise<Map<string, number>> {
  const saved = await readJson<{ at: number; affinity: Record<string, number> }>(env, 'source_affinity_v2');
  if (saved && at - saved.at < DAY) return new Map(Object.entries(saved.affinity));
  const fresh = await sourceAffinity(env, at - AFFINITY_DAYS * DAY);
  await writeJson(env, 'source_affinity_v2', { at, affinity: Object.fromEntries(fresh) });
  return fresh;
}

/** Rescores items from the last week. Cheap: one grouped query plus one small update per item. */
export async function scoreRecentItems(env: Env): Promise<number> {
  const at = now();
  const [affinity, settings] = await Promise.all([cachedAffinity(env, at), loadSettings(env)]);
  const rows = await env.DB.prepare(
    `SELECT id, source_id, received_at, why_it_matters, key_points, thin_content, sponsored, word_count, saved_at, interesting_at, ai_status, likely
     FROM items WHERE received_at >= ? AND status IN ('inbox', 'archived')`,
  )
    .bind(at - LOOKBACK_DAYS * DAY)
    .all<ScoreRow>();

  const updates = rows.results.map((row) => {
    const score = scoreFor(row, row.source_id ? affinity.get(row.source_id) : undefined, at, settings.tuning.topLean);
    return env.DB.prepare('UPDATE items SET score = ?1 WHERE id = ?2 AND COALESCE(score, -1) != ?1').bind(score, row.id);
  });
  for (let i = 0; i < updates.length; i += 50) await env.DB.batch(updates.slice(i, i + 50));
  return rows.results.length;
}
