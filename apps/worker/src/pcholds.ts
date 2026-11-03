import type { PcHoldCount, PcHoldsView, PcRest } from '@newsletterapp/shared';
import { readJson } from './ai';
import { dayKey } from './digest';
import type { Hono } from 'hono';
import type { AppVariables, Env } from './env';
import { now } from './ids';
import { loadSettings } from './settings';

// Fetches the PC held back or slowed down so a site's bot check doesn't flag the
// home network: counted on the PC, sent with each heartbeat, added up here by day and site.

/** The PC's limits (apps/helper/src/fetch.ts), shown next to the counts. */
export const PC_GAP_MS = 3_000;
export const PC_REST_FIRST_MS = 3 * 3_600_000;
export const PC_REST_MAX_MS = 24 * 3_600_000;
const DAYS_SHOWN = 14;

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const n = (v: unknown, max = 1e9) => Math.min(Math.max(Math.round(Number(v) || 0), 0), max);

/** Adds a heartbeat's counts to today's rows (one upsert per site). */
export async function recordHolds(env: Env, holds: PcHoldCount[], timezone: string): Promise<void> {
  const day = dayKey(now(), timezone);
  const stmts = holds
    .filter((h) => h && typeof h.site === 'string' && h.site)
    .slice(0, 50)
    .map((h) =>
      env.DB.prepare(
        `INSERT INTO pc_holds (day, site, skipped, rested, flagged, waited, wait_ms, gap_ms, rest_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(day, site) DO UPDATE SET
           skipped = skipped + ?3, rested = rested + ?4, flagged = flagged + ?5, waited = waited + ?6,
           wait_ms = wait_ms + ?7, gap_ms = MAX(gap_ms, ?8), rest_ms = MAX(rest_ms, ?9)`,
      ).bind(
        day,
        h.site.slice(0, 120),
        n(h.skipped),
        n(h.rested),
        n(h.flagged),
        n(h.waited),
        n(h.waitMs),
        n(h.gapMs, 3_600_000),
        n(h.restMs, 7 * 86_400_000),
      ),
    );
  if (stmts.length) await env.DB.batch(stmts);
}

export function registerPcHolds(app: App) {
  app.get('/api/pc-holds', async (c) => {
    const settings = await loadSettings(c.env);
    const t = now();
    const since = dayKey(t - (DAYS_SHOWN - 1) * 86_400_000, settings.timezone);
    const [rows, helper] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM pc_holds WHERE day >= ? ORDER BY day').bind(since).all<{
        day: string;
        site: string;
        skipped: number;
        rested: number;
        flagged: number;
        waited: number;
        wait_ms: number;
        gap_ms: number;
        rest_ms: number;
      }>(),
      readJson<{ resting?: PcRest[]; holdsReportedAt?: number }>(c.env, 'helper'),
    ]);
    const blank = () => ({ skipped: 0, rested: 0, flagged: 0, waited: 0, waitMs: 0, gapMs: 0, restMs: 0 });
    const byDay = new Map<string, ReturnType<typeof blank>>();
    const bySite = new Map<string, ReturnType<typeof blank>>();
    for (let i = DAYS_SHOWN - 1; i >= 0; i--) byDay.set(dayKey(t - i * 86_400_000, settings.timezone), blank());
    for (const r of rows.results) {
      for (const [map, key] of [
        [byDay, r.day],
        [bySite, r.site],
      ] as const) {
        const a = map.get(key) ?? blank();
        a.skipped += r.skipped;
        a.rested += r.rested;
        a.flagged += r.flagged;
        a.waited += r.waited;
        a.waitMs += r.wait_ms;
        a.gapMs = Math.max(a.gapMs, r.gap_ms);
        a.restMs = Math.max(a.restMs, r.rest_ms);
        map.set(key, a);
      }
    }
    const view: PcHoldsView = {
      gapMs: PC_GAP_MS,
      restFirstMs: PC_REST_FIRST_MS,
      restMaxMs: PC_REST_MAX_MS,
      resting: (helper?.resting ?? []).filter((r) => r.until > t),
      reportedAt: helper?.holdsReportedAt ?? null,
      days: [...byDay].map(([day, a]) => ({ day, ...a })),
      sites: [...bySite]
        .map(([site, a]) => ({ site, ...a }))
        .sort((x, y) => y.skipped + y.rested + y.flagged + y.waited - (x.skipped + x.rested + x.flagged + x.waited)),
    };
    return c.json(view);
  });
}
