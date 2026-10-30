import type { AiBacklogView, BacklogPoint, WaitBucket } from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { eligibleSql } from './ai';
import type { AppVariables, Env } from './env';
import { now } from './ids';
import { loadSettings } from './settings';
import { offsetCache, pad } from './usage';

// Is the PC keeping up? Every cron run (four times an hour) records how many
// items are waiting for the AI and how long the oldest has waited; each
// summary records how long its item waited. The AI statistics screen charts
// both by hour and by day.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEEP_DAYS = 120;

async function queueNow(env: Env) {
  const { aiByKind } = await loadSettings(env);
  return env.DB.prepare(
    `SELECT SUM(items.ai_status = 'pending') AS waiting, SUM(items.ai_status = 'working') AS working,
       MIN(COALESCE(items.ai_queued_at, items.created_at)) AS oldest_at
     FROM items LEFT JOIN sources ON sources.id = items.source_id
     WHERE items.status = 'inbox' AND items.ai_status IN ('pending', 'working') AND ${eligibleSql(aiByKind)}`,
  ).first<{ waiting: number | null; working: number | null; oldest_at: number | null }>();
}

/** Called from the cron: one row per run, kept for four months. */
export async function snapshotBacklog(env: Env): Promise<void> {
  const t = now();
  const q = await queueNow(env);
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO ai_backlog (at, waiting, working, oldest_at) VALUES (?, ?, ?, ?)').bind(
      t,
      q?.waiting ?? 0,
      q?.working ?? 0,
      q?.oldest_at ?? null,
    ),
    env.DB.prepare('DELETE FROM ai_backlog WHERE at < ?').bind(t - KEEP_DAYS * DAY),
  ]);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export function registerBacklog(app: App) {
  app.get('/api/ai/backlog', async (c) => {
    const t = now();
    const since = t - 91 * DAY;
    const settings = await loadSettings(c.env);
    const offset = offsetCache(settings.timezone);
    const [q, snaps, waits, arrivals] = await Promise.all([
      queueNow(c.env),
      c.env.DB.prepare('SELECT at, waiting + working AS waiting, oldest_at FROM ai_backlog WHERE at >= ? ORDER BY at')
        .bind(since)
        .all<{ at: number; waiting: number; oldest_at: number | null }>(),
      c.env.DB.prepare('SELECT at, wait_seconds FROM ai_runs WHERE ok = 1 AND wait_seconds IS NOT NULL AND at >= ?')
        .bind(since)
        .all<{ at: number; wait_seconds: number }>(),
      // Items that joined the queue, grouped by UTC hour to keep the rows few.
      c.env.DB.prepare(
        `SELECT COALESCE(items.ai_queued_at, items.created_at) / ${HOUR} AS h, COUNT(*) AS n
         FROM items LEFT JOIN sources ON sources.id = items.source_id
         WHERE items.ai_status IS NOT NULL AND COALESCE(items.ai_queued_at, items.created_at) >= ? AND ${eligibleSql(settings.aiByKind)}
         GROUP BY h`,
      )
        .bind(since)
        .all<{ h: number; n: number }>(),
    ]);

    const localHour = (at: number) => Math.floor((at + offset(at)) / HOUR);
    const localDay = (at: number) => Math.floor((at + offset(at)) / DAY);

    // Snapshots: the peak in each period, so a backlog that built up and cleared still shows.
    const peak = (key: (at: number) => number) => {
      const m = new Map<number, { waiting: number; oldest: number | null }>();
      for (const s of snaps.results) {
        const k = key(s.at);
        const age = s.oldest_at !== null ? (s.at - s.oldest_at) / 60_000 : null;
        const cur = m.get(k);
        m.set(k, {
          waiting: Math.max(cur?.waiting ?? 0, s.waiting),
          oldest: age === null ? (cur?.oldest ?? null) : Math.max(cur?.oldest ?? 0, age),
        });
      }
      return m;
    };
    const waitsBy = (key: (at: number) => number) => {
      const m = new Map<number, number[]>();
      for (const w of waits.results) {
        const k = key(w.at);
        m.set(k, [...(m.get(k) ?? []), w.wait_seconds / 60]);
      }
      return m;
    };
    const arrivalsBy = (key: (at: number) => number) => {
      const m = new Map<number, number>();
      for (const a of arrivals.results) m.set(key(a.h * HOUR), (m.get(key(a.h * HOUR)) ?? 0) + a.n);
      return m;
    };

    function series(unit: number, count: number, key: (at: number) => number, label: (d: Date) => string) {
      const peaks = peak(key);
      const w = waitsBy(key);
      const arr = arrivalsBy(key);
      const last = key(t);
      const points: BacklogPoint[] = [];
      const buckets: WaitBucket[] = [];
      for (let k = last - count + 1; k <= last; k++) {
        const at = k * unit - offset(k * unit);
        const text = label(new Date(k * unit));
        const p = peaks.get(k);
        points.push({ at, label: text, waiting: p?.waiting ?? null, oldestMinutes: p?.oldest ?? null });
        const sorted = (w.get(k) ?? []).sort((a, b) => a - b);
        buckets.push({
          at,
          label: text,
          arrived: arr.get(k) ?? 0,
          done: sorted.length,
          medianMinutes: percentile(sorted, 0.5),
          p90Minutes: percentile(sorted, 0.9),
        });
      }
      return { points, buckets };
    }

    const hourly = series(HOUR, 7 * 24, localHour, (d) => `${pad(d.getUTCHours())}:00`);
    const daily = series(DAY, 90, localDay, (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);

    const view: AiBacklogView = {
      now: { waiting: q?.waiting ?? 0, working: q?.working ?? 0, oldestAt: q?.oldest_at ?? null },
      hourly: hourly.points,
      daily: daily.points,
      waitsHourly: hourly.buckets,
      waitsDaily: daily.buckets,
      snapshotsSince: snaps.results[0]?.at ?? null,
    };
    return c.json(view);
  });
}
