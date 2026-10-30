import type { ItemKind, ReadDevice, ReadingSourceRow, ReadingStats, ReadVia } from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { dayKey } from './digest';
import type { AppVariables, Env } from './env';
import { now } from './ids';
import { loadSettings } from './settings';

// Reading statistics: what arrives, what gets read, by newsletter and category.
// Days are counted in the reader's time zone (Settings > Daily digest), so
// "today" means today where Jeff is, not UTC.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const DAY = 86_400_000;
const FINISHED_AT = 70; // scrolled at least this far = finished

/** Offset of a zone from UTC at an instant, in ms. */
function tzOffsetMs(at: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant a local day (YYYY-MM-DD) starts. */
export function dayStart(day: string, timezone: string): number {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let start = guess - tzOffsetMs(guess, timezone);
  const again = guess - tzOffsetMs(start, timezone); // once more in case the guess straddled a DST change
  if (again !== start) start = again;
  return start;
}

/** The day key `n` days before a given day key. */
function shiftDay(day: string, n: number): string {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

const CATEGORY_SQL = "COALESCE(items.category, sources.category, json_extract(items.ai_category, '$[0]'), 'Other')";

export function registerReading(app: App) {
  app.get('/api/reading/stats', async (c) => {
    const days = Math.min(Math.max(Number(c.req.query('days')) || 90, 7), 3650);
    const { timezone } = await loadSettings(c.env);
    const at = now();
    const today = dayKey(at, timezone);
    const dailyDays = 28;
    const dailyFrom = dayStart(shiftDay(today, dailyDays - 1), timezone);
    const weekFrom = dayStart(shiftDay(today, 6), timezone);
    const todayFrom = dayStart(today, timezone);
    const tableFrom = at - days * DAY;
    const db = c.env.DB;

    // --- Per-day received vs read, plus the streak, all bucketed in JS by local day.
    const [arrived, readTimes] = await Promise.all([
      db.prepare('SELECT received_at FROM items WHERE received_at >= ? AND status != ?').bind(dailyFrom, 'dropped').all<{ received_at: number }>(),
      db.prepare('SELECT read_at FROM items WHERE read_at IS NOT NULL AND read_at >= ?').bind(at - 400 * DAY).all<{ read_at: number }>(),
    ]);
    const received = new Map<string, number>();
    const read = new Map<string, number>();
    for (const r of arrived.results) {
      const k = dayKey(r.received_at, timezone);
      received.set(k, (received.get(k) ?? 0) + 1);
    }
    for (const r of readTimes.results) {
      const k = dayKey(r.read_at, timezone);
      read.set(k, (read.get(k) ?? 0) + 1);
    }
    const daily: ReadingStats['daily'] = [];
    for (let i = dailyDays - 1; i >= 0; i--) {
      const day = shiftDay(today, i);
      daily.push({ day, at: dayStart(day, timezone), received: received.get(day) ?? 0, read: read.get(day) ?? 0 });
    }
    // Streak: consecutive days with a read, ending today (or yesterday if nothing read yet today).
    let streak = 0;
    for (let i = read.get(today) ? 0 : 1; read.get(shiftDay(today, i)); i++) streak++;

    // --- The week at a glance.
    const [week, timeRow, openRow] = await Promise.all([
      db
        .prepare(
          `SELECT SUM(received_at >= ?1 AND status != 'dropped') AS received, SUM(read_at >= ?1) AS read FROM items WHERE received_at >= ?1 OR read_at >= ?1`,
        )
        .bind(weekFrom)
        .first<{ received: number | null; read: number | null }>(),
      db.prepare("SELECT SUM(value) AS seconds FROM events WHERE type = 'read_time' AND at >= ?").bind(weekFrom).first<{ seconds: number | null }>(),
      db
        .prepare(
          `SELECT COUNT(DISTINCT CASE WHEN type = 'open' THEN item_id END) AS opened,
                  COUNT(DISTINCT CASE WHEN type = 'finish' AND value >= ${FINISHED_AT} THEN item_id END) AS finished
           FROM events WHERE at >= ? AND type IN ('open', 'finish')`,
        )
        .bind(weekFrom)
        .first<{ opened: number | null; finished: number | null }>(),
    ]);

    // --- By newsletter and by category, over the chosen window.
    const perItem = `
      LEFT JOIN (
        SELECT item_id,
               MAX(type = 'open') AS opened,
               MAX(type = 'finish' AND value >= ${FINISHED_AT}) AS finished,
               SUM(CASE WHEN type = 'read_time' THEN value END) AS seconds
        FROM events GROUP BY item_id
      ) ev ON ev.item_id = items.id`;
    const [sourceRows, categoryRows, viaRows, backlogRow] = await Promise.all([
      db
        .prepare(
          `SELECT sources.id, sources.name, sources.kind, COUNT(items.id) AS issues,
                  SUM(items.read_at IS NOT NULL) AS read, SUM(COALESCE(ev.opened, 0)) AS opened, SUM(COALESCE(ev.finished, 0)) AS finished,
                  AVG(CASE WHEN ev.seconds >= 2 THEN ev.seconds END) AS avg_seconds, MAX(items.read_at) AS last_read
           FROM sources
           LEFT JOIN items ON items.source_id = sources.id AND items.received_at >= ?1 AND items.status != 'dropped'
           ${perItem}
           GROUP BY sources.id ORDER BY issues DESC, sources.name`,
        )
        .bind(tableFrom)
        .all<{
          id: string;
          name: string;
          kind: ItemKind;
          issues: number;
          read: number | null;
          opened: number | null;
          finished: number | null;
          avg_seconds: number | null;
          last_read: number | null;
        }>(),
      db
        .prepare(
          `SELECT ${CATEGORY_SQL} AS cat, COUNT(*) AS issues, SUM(items.read_at IS NOT NULL) AS read,
                  SUM(COALESCE(ev.opened, 0)) AS opened, SUM(COALESCE(ev.finished, 0)) AS finished
           FROM items LEFT JOIN sources ON sources.id = items.source_id ${perItem}
           WHERE items.received_at >= ?1 AND items.status != 'dropped'
           GROUP BY cat ORDER BY issues DESC`,
        )
        .bind(tableFrom)
        .all<{ cat: string; issues: number; read: number | null; opened: number | null; finished: number | null }>(),
      db
        .prepare('SELECT read_via, read_device, COUNT(*) AS n FROM items WHERE read_at >= ? GROUP BY read_via, read_device')
        .bind(tableFrom)
        .all<{ read_via: ReadVia | null; read_device: ReadDevice | null; n: number }>(),
      db
        .prepare(
          `SELECT SUM(received_at >= ?1) AS today, SUM(received_at < ?1 AND received_at >= ?2) AS week, SUM(received_at < ?2) AS older
           FROM items WHERE status = 'inbox' AND read_at IS NULL`,
        )
        .bind(todayFrom, weekFrom)
        .first<{ today: number | null; week: number | null; older: number | null }>(),
    ]);

    const sources: ReadingSourceRow[] = sourceRows.results
      .filter((r) => r.issues > 0)
      .map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        issues: r.issues,
        read: r.read ?? 0,
        opened: r.opened ?? 0,
        finished: r.finished ?? 0,
        avgMinutes: r.avg_seconds === null ? null : r.avg_seconds / 60,
        lastReadAt: r.last_read,
      }))
      // Most-read first; never-opened newsletters sink to the bottom where they are easy to spot.
      .sort((a, b) => (b.opened > 0 ? 1 : 0) - (a.opened > 0 ? 1 : 0) || b.read - a.read || b.issues - a.issues);

    const via: Record<ReadVia, number> = { reader: 0, swipe: 0, bulk: 0, digest: 0 };
    const device: Record<ReadDevice, number> = { phone: 0, desktop: 0 };
    for (const r of viaRows.results) {
      if (r.read_via && r.read_via in via) via[r.read_via] += r.n;
      if (r.read_device && r.read_device in device) device[r.read_device] += r.n;
    }

    const out: ReadingStats = {
      days,
      glance: {
        received: week?.received ?? 0,
        read: week?.read ?? 0,
        minutes: Math.round((timeRow?.seconds ?? 0) / 60),
        opened: openRow?.opened ?? 0,
        finished: openRow?.finished ?? 0,
        streak,
      },
      daily,
      sources,
      categories: categoryRows.results.map((r) => ({
        category: r.cat,
        issues: r.issues,
        read: r.read ?? 0,
        opened: r.opened ?? 0,
        finished: r.finished ?? 0,
      })),
      how: { via, device },
      backlog: { today: backlogRow?.today ?? 0, week: backlogRow?.week ?? 0, older: backlogRow?.older ?? 0 },
    };
    return c.json(out);
  });
}
