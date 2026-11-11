import { KEY_KINDS, KEY_USE_EVENTS, type KeyKind, type KeyMark, type KeyStats, type KeyUseEvent, type ReadThrough } from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { dayKey } from './digest';
import type { AppVariables, Env } from './env';
import { now } from './ids';
import { loadKeySettings } from './keysentences';
import { dayStart, shiftDay } from './reading';
import { loadSettings } from './settings';

// Statistics > Key sentences: how much the PC did, how often each colour
// appears (and where), how you use the colours in the reader, and signs of
// whether they help: corrections, kept highlights, and how far long articles
// get read with and without them.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const parseMarks = (raw: string | null): KeyMark[] => {
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v as KeyMark[]) : [];
  } catch {
    return [];
  }
};

export function registerKeyStats(app: App) {
  /** The reader counts each use once per article: a write to one small row a day. */
  app.post('/api/key-sentences/use', async (c) => {
    const input = (await c.req.json().catch(() => ({}))) as { event?: string };
    const event = KEY_USE_EVENTS.find((e) => e === input.event);
    if (!event) return c.json({ error: 'bad event' }, 400);
    const { timezone } = await loadSettings(c.env);
    const day = dayKey(now(), timezone);
    await c.env.DB.prepare(
      `INSERT INTO ks_daily (day, counts) VALUES (?1, json_object(?2, 1))
       ON CONFLICT(day) DO UPDATE SET counts = json_set(counts, '$.' || ?2, COALESCE(json_extract(counts, '$.' || ?2), 0) + 1)`,
    )
      .bind(day, event)
      .run();
    return c.json({ ok: true });
  });

  app.get('/api/key-sentences/stats', async (c) => {
    const days = [7, 30, 90].includes(Number(c.req.query('days'))) ? Number(c.req.query('days')) : 30;
    const [settings, ks] = await Promise.all([loadSettings(c.env), loadKeySettings(c.env)]);
    const today = dayKey(now(), settings.timezone);
    const firstDay = shiftDay(today, days - 1);
    const since = dayStart(firstDay, settings.timezone);

    const [runs, rows, daily, reads, studies] = await Promise.all([
      c.env.DB.prepare(
        `SELECT ok, skipped, manual, marks, seconds, model, at FROM ks_runs INDEXED BY ks_runs_at WHERE at >= ? AND task = 'key' LIMIT 20000`,
      )
        .bind(since)
        .all<{ ok: number; skipped: string | null; manual: number; marks: number | null; seconds: number | null; model: string; at: number }>(),
      c.env.DB.prepare(
        `SELECT key_sentences.marks, key_sentences.words, key_sentences.model, sources.name AS source,
           COALESCE(items.category, sources.category, json_extract(items.ai_category, '$[0]'), 'Other') AS category
         FROM key_sentences JOIN items ON items.id = key_sentences.item_id LEFT JOIN sources ON sources.id = items.source_id
         WHERE key_sentences.updated_at >= ? AND items.ks_status = 'done' LIMIT 5000`,
      )
        .bind(since)
        .all<{ marks: string; words: number | null; model: string | null; source: string | null; category: string }>(),
      c.env.DB.prepare('SELECT counts FROM ks_daily WHERE day >= ?').bind(firstDay).all<{ counts: string }>(),
      // Long articles that arrived in the period: how far they were read, with and without key sentences.
      c.env.DB.prepare(
        `SELECT items.ks_status = 'done' AS ks, items.read_via,
           MAX(CASE WHEN events.type = 'finish' THEN events.value END) AS fin,
           SUM(CASE WHEN events.type = 'read_time' THEN events.value END) AS secs,
           MAX(events.type = 'open') AS opened
         FROM items JOIN events ON events.item_id = items.id AND events.type IN ('open', 'finish', 'read_time')
         WHERE items.received_at >= ? AND items.word_count >= ? AND items.kind != 'ai' AND items.status != 'dropped'
         GROUP BY items.id LIMIT 5000`,
      )
        .bind(since, ks.minWords)
        .all<{ ks: number; read_via: string | null; fin: number | null; secs: number | null; opened: number }>(),
      c.env.DB.batch([
        c.env.DB.prepare('SELECT COUNT(*) AS n FROM studies WHERE cites > 0'),
        c.env.DB.prepare('SELECT COUNT(*) AS n FROM studies INDEXED BY studies_cited WHERE cites >= 2'),
        c.env.DB.prepare('SELECT COUNT(*) AS n FROM studies WHERE differs = 1 AND cites > 0'),
        c.env.DB.prepare('SELECT COUNT(*) AS n FROM links INDEXED BY links_cited WHERE cites >= 2'),
      ]),
    ]);

    // ----- What the PC did -----
    const done = runs.results.filter((r) => r.ok === 1 && !r.skipped);
    const perDay = new Map<string, number>();
    for (const r of done) perDay.set(dayKey(r.at, settings.timezone), (perDay.get(dayKey(r.at, settings.timezone)) ?? 0) + 1);
    const dailyPoints: KeyStats['daily'] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = shiftDay(today, i);
      dailyPoints.push({ at: dayStart(d, settings.timezone), treated: perDay.get(d) ?? 0 });
    }
    const secs = done.map((r) => r.seconds ?? 0).filter((s) => s > 0);
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

    // ----- Colours, by source and category, corrections and models -----
    const kindCount = new Map<KeyKind, number>();
    let words = 0;
    const group = () => new Map<string, { articles: number; marks: number; kinds: Partial<Record<KeyKind, number>> }>();
    const bySource = group();
    const byCategory = group();
    const corr = new Map<KeyKind, { marks: number; removed: number; recoloured: number }>();
    const byModel = new Map<string, { articles: number; marks: number; removed: number; recoloured: number }>();
    for (const row of rows.results) {
      const marks = parseMarks(row.marks);
      words += row.words ?? 0;
      const model = row.model ?? 'unknown';
      const m = byModel.get(model) ?? { articles: 0, marks: 0, removed: 0, recoloured: 0 };
      m.articles++;
      for (const g of [
        [bySource, row.source ?? 'Other'],
        [byCategory, row.category],
      ] as const) {
        const e = g[0].get(g[1]) ?? { articles: 0, marks: 0, kinds: {} };
        e.articles++;
        g[0].set(g[1], e);
      }
      for (const mark of marks) {
        // The model's choice, for judging the model; your colour (unless taken out), for what's shown.
        const original = mark.was ?? mark.kind;
        const c2 = corr.get(original) ?? { marks: 0, removed: 0, recoloured: 0 };
        c2.marks++;
        m.marks++;
        if (mark.fix === 'removed') {
          c2.removed++;
          m.removed++;
        } else if (mark.fix === 'kind') {
          c2.recoloured++;
          m.recoloured++;
        }
        corr.set(original, c2);
        if (mark.fix === 'removed') continue;
        kindCount.set(mark.kind, (kindCount.get(mark.kind) ?? 0) + 1);
        for (const [g, key] of [
          [bySource, row.source ?? 'Other'],
          [byCategory, row.category],
        ] as const) {
          const e = g.get(key)!;
          e.marks++;
          e.kinds[mark.kind] = (e.kinds[mark.kind] ?? 0) + 1;
        }
      }
      byModel.set(model, m);
    }
    const modelSeconds = new Map<string, number[]>();
    for (const r of done) if (r.seconds) modelSeconds.set(r.model, [...(modelSeconds.get(r.model) ?? []), r.seconds]);
    const top = (g: ReturnType<typeof group>) =>
      [...g.entries()]
        .map(([name, v]) => ({ name, ...v }))
        .sort((a, b) => b.articles - a.articles || b.marks - a.marks)
        .slice(0, 12);

    // ----- How it's used -----
    const use: KeyStats['use'] = {};
    for (const d of daily.results) {
      try {
        const counts = JSON.parse(d.counts) as Record<string, number>;
        for (const e of KEY_USE_EVENTS) if (typeof counts[e] === 'number') use[e as KeyUseEvent] = (use[e as KeyUseEvent] ?? 0) + counts[e];
      } catch {
        // A damaged row is skipped.
      }
    }

    // ----- Read-through -----
    const through = (list: typeof reads.results): ReadThrough => {
      const opened = list.filter((r) => r.opened);
      const minutes = opened.map((r) => (r.secs ?? 0) / 60).filter((m) => m > 0);
      return {
        opened: opened.length,
        finished: opened.filter((r) => (r.fin ?? 0) >= 90).length,
        avgMinutes: minutes.length ? Math.round((minutes.reduce((a, b) => a + b, 0) / minutes.length) * 10) / 10 : null,
      };
    };

    const n = (i: number) => ((studies[i]?.results[0] as { n: number } | undefined)?.n ?? 0);
    const body: KeyStats = {
      days,
      enabled: ks.enabled,
      treated: done.length,
      manual: done.filter((r) => r.manual === 1).length,
      skipped: {
        short: runs.results.filter((r) => r.skipped === 'short').length,
        roundup: runs.results.filter((r) => r.skipped === 'roundup').length,
        empty: runs.results.filter((r) => r.skipped === 'empty').length,
      },
      failed: runs.results.filter((r) => r.ok === 0).length,
      avgMarks: avg(done.map((r) => r.marks ?? 0)),
      avgSeconds: avg(secs),
      totalSeconds: Math.round(secs.reduce((a, b) => a + b, 0)),
      daily: dailyPoints,
      kinds: KEY_KINDS.map((k) => ({ kind: k, count: kindCount.get(k) ?? 0, per1000: words ? Math.round(((kindCount.get(k) ?? 0) * 10000) / words) / 10 : null })),
      bySource: top(bySource),
      byCategory: top(byCategory),
      corrections: KEY_KINDS.map((k) => ({ kind: k, ...(corr.get(k) ?? { marks: 0, removed: 0, recoloured: 0 }) })),
      byModel: [...byModel.entries()].map(([model, v]) => ({ model, ...v, avgSeconds: avg(modelSeconds.get(model) ?? []) })),
      use,
      readThrough: { with: through(reads.results.filter((r) => r.ks)), without: through(reads.results.filter((r) => !r.ks)) },
      studies: { seen: n(0), citedTwice: n(1), differs: n(2), links: n(3) },
    };
    return c.json(body);
  });
}
