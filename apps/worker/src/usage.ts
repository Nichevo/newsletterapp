import {
  DEFAULT_USAGE_SETTINGS,
  type AiLimitHit,
  type AiUsageSettings,
  type AiUsageView,
  type UsageBucket,
  type UsageTotals,
} from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { readJson, writeJson } from './ai';
import type { AppVariables, Env } from './env';
import { now } from './ids';
import { loadSettings } from './settings';

// Local AI usage: caps on how long the PC spends summarising (per rolling
// hour, per local day, per session) and a rough running cost from the
// electricity it draws plus its share of the hardware's wear. Usage is the
// run time the helper reports for each summary and test run; hosted models
// (Claude) don't use the PC, so they don't count.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const KEY = 'ai_usage';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HOSTED = "'anthropic'";

// ---------- Settings ----------

export async function loadUsageSettings(env: Env): Promise<AiUsageSettings> {
  return normalizeUsageSettings((await readJson<Partial<AiUsageSettings>>(env, KEY)) ?? {});
}

const num = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback;

/** A cap in whole minutes, or null for none. Anything else keeps the old value. */
function cap(v: unknown, fallback: number | null): number | null {
  if (v === null) return null;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1440 ? v : fallback;
}

export function normalizeUsageSettings(
  input: { limits?: Partial<AiUsageSettings['limits']>; cost?: Partial<AiUsageSettings['cost']> },
  base: AiUsageSettings = DEFAULT_USAGE_SETTINGS,
): AiUsageSettings {
  const l = input.limits ?? {};
  const c = input.cost ?? {};
  const b = base.cost;
  return {
    limits: {
      perHourMinutes: cap(l.perHourMinutes, base.limits.perHourMinutes),
      perDayMinutes: cap(l.perDayMinutes, base.limits.perDayMinutes),
      perSessionMinutes: cap(l.perSessionMinutes, base.limits.perSessionMinutes),
      breakMinutes: Math.round(num(l.breakMinutes, 1, 240, base.limits.breakMinutes)),
    },
    cost: {
      currency: typeof c.currency === 'string' && c.currency.trim() ? c.currency.trim().slice(0, 4) : b.currency,
      electricityPerKwh: num(c.electricityPerKwh, 0, 10, b.electricityPerKwh),
      gpuWatts: num(c.gpuWatts, 0, 2000, b.gpuWatts),
      otherWatts: num(c.otherWatts, 0, 2000, b.otherWatts),
      hardwareCost: num(c.hardwareCost, 0, 100_000, b.hardwareCost),
      resaleValue: num(c.resaleValue, 0, 100_000, b.resaleValue),
      lifespanYears: num(c.lifespanYears, 0.5, 20, b.lifespanYears),
      busyHoursPerDay: num(c.busyHoursPerDay, 0.5, 24, b.busyHoursPerDay),
    },
  };
}

// ---------- Time zones ----------

/** Milliseconds the zone is ahead of UTC at this moment. */
function tzOffset(at: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return local - Math.floor(at / 60_000) * 60_000;
}

/** Local midnight at the start of the day `at` falls in. */
function startOfLocalDay(at: number, timezone: string): number {
  const local = at + tzOffset(at, timezone);
  const midnight = Math.floor(local / DAY) * DAY;
  return midnight - tzOffset(midnight - tzOffset(at, timezone), timezone);
}

/** Offsets only change a couple of times a year, so one lookup per UTC day is plenty. */
function offsetCache(timezone: string) {
  const seen = new Map<number, number>();
  return (at: number) => {
    const day = Math.floor(at / DAY);
    let off = seen.get(day);
    if (off === undefined) {
      off = tzOffset(day * DAY + DAY / 2, timezone);
      seen.set(day, off);
    }
    return off;
  };
}

// ---------- Run time ----------

interface RunRow {
  at: number;
  seconds: number;
}

const RUNS_SINCE = `SELECT at, seconds, watts FROM ai_runs WHERE at >= ?1 AND seconds > 0 AND provider != ${HOSTED}
  UNION ALL
  SELECT at, seconds, watts FROM trial_results WHERE at >= ?1 AND seconds > 0 AND provider != ${HOSTED}`;

export interface LimitState {
  hourSeconds: number;
  daySeconds: number;
  sessionSeconds: number;
  limited: AiLimitHit | null;
  /** Seconds left before the tightest cap; Infinity when there are none. */
  remainingSeconds: number;
}

const mins = (s: number) => Math.round(s / 60);

/** Where usage stands against each cap right now. */
export async function limitState(env: Env, t = now()): Promise<LimitState> {
  const [{ limits }, { timezone }] = await Promise.all([loadUsageSettings(env), loadSettings(env)]);
  const dayStart = startOfLocalDay(t, timezone);
  const since = Math.min(dayStart, t - DAY);
  const rows = (await env.DB.prepare(`SELECT at, seconds FROM (${RUNS_SINCE}) ORDER BY at`).bind(since).all<RunRow>()).results;

  const hourRows = rows.filter((r) => r.at > t - HOUR);
  const hourSeconds = hourRows.reduce((s, r) => s + r.seconds, 0);
  const daySeconds = rows.filter((r) => r.at >= dayStart).reduce((s, r) => s + r.seconds, 0);

  // A session is work with no gap as long as the break; walk back from now until one turns up.
  const breakMs = limits.breakMinutes * 60_000;
  let sessionSeconds = 0;
  let edge = t;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (edge - r.at >= breakMs) break;
    sessionSeconds += r.seconds;
    edge = r.at - r.seconds * 1000;
  }
  const lastEnd = rows.at(-1)?.at ?? 0;

  const hits: AiLimitHit[] = [];
  const left: number[] = [];
  if (limits.perHourMinutes !== null) {
    const capS = limits.perHourMinutes * 60;
    left.push(capS - hourSeconds);
    if (hourSeconds >= capS) {
      // Wait until enough of the oldest runs in the window drop out of it.
      let over = hourSeconds - capS;
      let until = t + HOUR;
      for (const r of hourRows) {
        over -= r.seconds;
        if (over < 0) {
          until = r.at + HOUR;
          break;
        }
      }
      hits.push({ limit: 'hour', message: `${mins(hourSeconds)} of ${limits.perHourMinutes} minutes in the last hour`, until });
    }
  }
  if (limits.perDayMinutes !== null) {
    const capS = limits.perDayMinutes * 60;
    left.push(capS - daySeconds);
    if (daySeconds >= capS) {
      hits.push({
        limit: 'day',
        message: `${mins(daySeconds)} of ${limits.perDayMinutes} minutes today`,
        until: startOfLocalDay(dayStart + DAY + 2 * HOUR, timezone),
      });
    }
  }
  if (limits.perSessionMinutes !== null) {
    const capS = limits.perSessionMinutes * 60;
    left.push(capS - sessionSeconds);
    if (sessionSeconds >= capS) {
      hits.push({
        limit: 'session',
        message: `${mins(sessionSeconds)} of ${limits.perSessionMinutes} minutes this session; resting ${limits.breakMinutes} minutes`,
        until: lastEnd + breakMs,
      });
    }
  }
  // The cap that holds out longest is the one that matters.
  const limited = hits.sort((a, b) => b.until - a.until)[0] ?? null;
  return { hourSeconds, daySeconds, sessionSeconds, limited, remainingSeconds: Math.max(0, Math.min(Infinity, ...left)) };
}

/** How many items to hand out so a batch doesn't run far past a cap. */
export async function jobsThatFit(env: Env, remainingSeconds: number, max: number): Promise<number> {
  if (!Number.isFinite(remainingSeconds)) return max;
  const avg = await env.DB.prepare(
    `SELECT AVG(seconds) AS s FROM (SELECT seconds FROM ai_runs WHERE ok = 1 AND seconds > 0 AND provider != ${HOSTED} ORDER BY at DESC LIMIT 20)`,
  ).first<{ s: number | null }>();
  const per = avg?.s ?? 60;
  return Math.max(1, Math.min(max, Math.ceil(remainingSeconds / per)));
}

// ---------- Cost ----------

function costRates(settings: AiUsageSettings) {
  const c = settings.cost;
  const workingHours = c.lifespanYears * 365 * c.busyHoursPerDay;
  return {
    wearPerHour: workingHours > 0 ? Math.max(0, c.hardwareCost - c.resaleValue) / workingHours : 0,
    electricityPerKwh: c.electricityPerKwh,
  };
}

interface Agg {
  seconds: number;
  /** seconds x GPU watts (measured, or the setting when not measured) */
  wattSeconds: number;
  runs: number;
}

function totals(aggs: Agg[], settings: AiUsageSettings): UsageTotals {
  const { wearPerHour, electricityPerKwh } = costRates(settings);
  const seconds = aggs.reduce((s, a) => s + a.seconds, 0);
  const wattSeconds = aggs.reduce((s, a) => s + a.wattSeconds, 0) + seconds * settings.cost.otherWatts;
  const kwh = wattSeconds / 3600 / 1000;
  return {
    minutes: seconds / 60,
    runs: aggs.reduce((s, a) => s + a.runs, 0),
    kwh,
    electricity: kwh * electricityPerKwh,
    wear: (seconds / 3600) * wearPerHour,
  };
}

function bucket(at: number, label: string, aggs: Agg[], settings: AiUsageSettings): UsageBucket {
  const t = totals(aggs, settings);
  return { at, label, minutes: t.minutes, runs: t.runs, kwh: t.kwh, cost: t.electricity + t.wear };
}

const pad = (n: number) => String(n).padStart(2, '0');

// ---------- Routes ----------

export function registerUsage(app: App) {
  app.get('/api/ai/usage', async (c) => {
    const t = now();
    const [settings, { timezone }, state] = await Promise.all([loadUsageSettings(c.env), loadSettings(c.env), limitState(c.env, t)]);
    const offset = offsetCache(timezone);

    // Hour-sized groups for 90 days keep the rows few, whatever the number of runs.
    const groups = await c.env.DB.prepare(
      `SELECT at / ${HOUR} AS h, SUM(seconds) AS seconds, SUM(seconds * COALESCE(watts, ?2)) AS wattSeconds, COUNT(*) AS runs
       FROM (${RUNS_SINCE}) GROUP BY h`,
    )
      .bind(t - 91 * DAY, settings.cost.gpuWatts)
      .all<Agg & { h: number }>();

    // Clock hours in the reader's zone (whole-hour zones line up exactly; others to the nearest UTC hour).
    const byLocalHour = new Map<number, Agg[]>();
    const byLocalDay = new Map<number, Agg[]>();
    for (const g of groups.results) {
      const local = g.h * HOUR + offset(g.h * HOUR);
      const hourKey = Math.floor(local / HOUR);
      const dayKey = Math.floor(local / DAY);
      byLocalHour.set(hourKey, [...(byLocalHour.get(hourKey) ?? []), g]);
      byLocalDay.set(dayKey, [...(byLocalDay.get(dayKey) ?? []), g]);
    }

    const nowLocal = t + offset(t);
    const thisHour = Math.floor(nowLocal / HOUR);
    const hourly: UsageBucket[] = [];
    for (let h = thisHour - 7 * 24 + 1; h <= thisHour; h++) {
      const d = new Date(h * HOUR);
      hourly.push(bucket(h * HOUR - offset(h * HOUR), `${pad(d.getUTCHours())}:00`, byLocalHour.get(h) ?? [], settings));
    }
    const today = Math.floor(nowLocal / DAY);
    const daily: UsageBucket[] = [];
    for (let day = today - 89; day <= today; day++) {
      const d = new Date(day * DAY);
      daily.push(
        bucket(
          day * DAY - offset(day * DAY),
          `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
          byLocalDay.get(day) ?? [],
          settings,
        ),
      );
    }

    const days = (n: number) => [...byLocalDay.entries()].filter(([d]) => d > today - n).flatMap(([, a]) => a);
    const sumSince = (since: number) =>
      c.env.DB.prepare(
        `SELECT COALESCE(SUM(seconds), 0) AS seconds, COALESCE(SUM(seconds * COALESCE(watts, ?2)), 0) AS wattSeconds, COUNT(*) AS runs FROM (${RUNS_SINCE})`,
      )
        .bind(since, settings.cost.gpuWatts)
        .first<Agg>();
    const [year, all, watts] = await Promise.all([
      sumSince(t - 365 * DAY),
      sumSince(0),
      c.env.DB.prepare(`SELECT AVG(watts) AS w FROM ai_runs WHERE watts IS NOT NULL AND at >= ?`)
        .bind(t - 30 * DAY)
        .first<{ w: number | null }>(),
    ]);
    const rates = costRates(settings);
    const hourWatts = (watts?.w ?? settings.cost.gpuWatts) + settings.cost.otherWatts;

    const view: AiUsageView = {
      settings,
      timezone,
      now: {
        hourMinutes: state.hourSeconds / 60,
        dayMinutes: state.daySeconds / 60,
        sessionMinutes: state.sessionSeconds / 60,
        limited: state.limited,
      },
      hourly,
      daily,
      totals: {
        today: totals(days(1), settings),
        last7Days: totals(days(7), settings),
        last30Days: totals(days(30), settings),
        last365Days: totals(year ? [year] : [], settings),
        allTime: totals(all ? [all] : [], settings),
      },
      avgWatts: watts?.w ?? null,
      costPerHour: { electricity: (hourWatts / 1000) * rates.electricityPerKwh, wear: rates.wearPerHour },
    };
    return c.json(view);
  });

  app.put('/api/ai/usage/settings', async (c) => {
    const input = (await c.req.json().catch(() => null)) as Partial<AiUsageSettings> | null;
    if (!input || typeof input !== 'object') return c.json({ error: 'settings required' }, 400);
    const next = normalizeUsageSettings(input, await loadUsageSettings(c.env));
    await writeJson(c.env, KEY, next);
    return c.json(next);
  });

  /** The helper hands back items it claimed but won't run because a cap was reached. */
  app.post('/api/helper/release', async (c) => {
    const input = (await c.req.json().catch(() => null)) as { itemIds?: string[] } | null;
    const ids = (input?.itemIds ?? []).filter((id) => typeof id === 'string').slice(0, 20);
    if (ids.length === 0) return c.json({ released: 0 });
    const res = await c.env.DB.prepare(
      `UPDATE items SET ai_status = 'pending', ai_claimed_at = NULL, ai_attempts = MAX(ai_attempts - 1, 0)
       WHERE ai_status = 'working' AND id IN (${ids.map(() => '?').join(', ')})`,
    )
      .bind(...ids)
      .run();
    return c.json({ released: res.meta.changes ?? 0 });
  });
}
