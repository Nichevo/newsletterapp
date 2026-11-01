import type {
  AskOutput,
  HighlightList,
  HighlightListRow,
  HighlightPromptStats,
  HighlightStats,
  HighlightStatsGroup,
} from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { dayKey } from './digest';
import type { AppVariables, Env } from './env';
import { now } from './ids';
import { CATEGORY_SQL, dayStart, shiftDay } from './reading';
import { loadSettings } from './settings';
import { loadUsage, loadWebSearch } from './websearch';

// The Highlights page (every highlight, newest first, with filters) and the
// highlight statistics shown on Reading statistics and AI statistics. Both
// pages are opened by hand, never polled; the list walks the highlights_created
// index 50 at a time.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const DAY = 86_400_000;
const PAGE = 50;
const ASKED = 'EXISTS (SELECT 1 FROM asks WHERE asks.item_id = h.item_id AND asks.highlight_id = h.id AND asks.deleted_at IS NULL)';

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function registerHighlightPages(app: App) {
  app.get('/api/highlights', async (c) => {
    const db = c.env.DB;
    const before = Number(c.req.query('before')) || now() + 1;
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    const kind = c.req.query('kind');
    const sourceId = c.req.query('sourceId');
    const category = c.req.query('category');

    const where = ['h.deleted_at IS NULL', 'h.created_at < ?'];
    const binds: (string | number)[] = [before];
    if (q) {
      // Escape LIKE wildcards so "50%" means 50%.
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push("(h.quote LIKE ? ESCAPE '\\' OR h.context LIKE ? ESCAPE '\\' OR items.subject LIKE ? ESCAPE '\\')");
      binds.push(like, like, like);
    }
    if (sourceId) {
      where.push('items.source_id = ?');
      binds.push(sourceId);
    }
    if (category) {
      where.push(`${CATEGORY_SQL} = ?`);
      binds.push(category);
    }
    if (kind === 'asked') where.push(ASKED);
    if (kind === 'plain') where.push(`NOT ${ASKED}`);

    const rows = await db
      .prepare(
        `SELECT h.id, h.item_id, h.quote, h.created_at, items.subject, items.source_id, sources.name AS source_name, ${CATEGORY_SQL} AS cat,
                (SELECT group_concat(label, char(31)) FROM
                   (SELECT label FROM asks WHERE asks.item_id = h.item_id AND asks.highlight_id = h.id AND asks.deleted_at IS NULL ORDER BY asks.created_at)) AS labels
         FROM highlights h INDEXED BY highlights_created
         JOIN items ON items.id = h.item_id
         LEFT JOIN sources ON sources.id = items.source_id
         WHERE ${where.join(' AND ')}
         ORDER BY h.created_at DESC LIMIT ${PAGE + 1}`,
      )
      .bind(...binds)
      .all<{
        id: string;
        item_id: string;
        quote: string;
        created_at: number;
        subject: string | null;
        source_id: string | null;
        source_name: string | null;
        cat: string;
        labels: string | null;
      }>();

    const page = rows.results.slice(0, PAGE);
    const highlights: HighlightListRow[] = page.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      quote: r.quote,
      createdAt: r.created_at,
      itemTitle: r.subject || '(no subject)',
      sourceId: r.source_id,
      sourceName: r.source_name,
      category: r.cat,
      asks: r.labels ? r.labels.split('\u001f') : [],
    }));

    // The filter choices, only with the first page.
    let sources: HighlightList['sources'] = [];
    let categories: HighlightList['categories'] = [];
    if (!c.req.query('before')) {
      const groups = await db
        .prepare(
          `SELECT items.source_id AS sid, sources.name AS name, ${CATEGORY_SQL} AS cat, COUNT(*) AS n
           FROM highlights h JOIN items ON items.id = h.item_id LEFT JOIN sources ON sources.id = items.source_id
           WHERE h.deleted_at IS NULL GROUP BY sid, cat`,
        )
        .all<{ sid: string | null; name: string | null; cat: string; n: number }>();
      const bySource = new Map<string, { id: string; name: string; count: number }>();
      const byCat = new Map<string, number>();
      for (const g of groups.results) {
        if (g.sid) {
          const s = bySource.get(g.sid) ?? { id: g.sid, name: g.name ?? 'Unknown', count: 0 };
          s.count += g.n;
          bySource.set(g.sid, s);
        }
        byCat.set(g.cat, (byCat.get(g.cat) ?? 0) + g.n);
      }
      sources = [...bySource.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      categories = [...byCat.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
    }

    const out: HighlightList = {
      highlights,
      next: rows.results.length > PAGE ? page[page.length - 1]!.created_at : null,
      sources,
      categories,
    };
    return c.json(out);
  });

  app.get('/api/highlights/stats', async (c) => {
    const days = Math.min(Math.max(Number(c.req.query('days')) || 90, 7), 3650);
    const db = c.env.DB;
    const { timezone } = await loadSettings(c.env);
    const at = now();
    const today = dayKey(at, timezone);
    const dailyDays = 28;
    const dailyFrom = dayStart(shiftDay(today, dailyDays - 1), timezone);
    const tableFrom = at - days * DAY;
    const from = Math.min(dailyFrom, tableFrom);

    const [hlRows, askRows, readRow, usage, webSearch] = await Promise.all([
      db
        .prepare(
          `SELECT h.id, h.item_id, h.created_at, items.subject, items.source_id, sources.name AS source_name, ${CATEGORY_SQL} AS cat
           FROM highlights h INDEXED BY highlights_created
           JOIN items ON items.id = h.item_id LEFT JOIN sources ON sources.id = items.source_id
           WHERE h.deleted_at IS NULL AND h.created_at >= ?`,
        )
        .bind(from)
        .all<{
          id: string;
          item_id: string;
          created_at: number;
          subject: string | null;
          source_id: string | null;
          source_name: string | null;
          cat: string;
        }>(),
      db
        .prepare(
          `SELECT highlight_id, label, status, rating, seconds, provider, model, output, created_at
           FROM asks WHERE deleted_at IS NULL AND created_at >= ?`,
        )
        .bind(from)
        .all<{
          highlight_id: string;
          label: string;
          status: string;
          rating: number | null;
          seconds: number | null;
          provider: string | null;
          model: string | null;
          output: AskOutput;
          created_at: number;
        }>(),
      db
        .prepare("SELECT COUNT(*) AS n FROM items WHERE read_at IS NOT NULL AND read_at >= ? AND kind != 'ai'")
        .bind(tableFrom)
        .first<{ n: number }>(),
      loadUsage(c.env),
      loadWebSearch(c.env),
    ]);

    // Daily, last four weeks.
    const dayHl = new Map<string, number>();
    const dayAsk = new Map<string, number>();
    for (const h of hlRows.results) if (h.created_at >= dailyFrom) bump(dayHl, dayKey(h.created_at, timezone));
    for (const a of askRows.results) if (a.created_at >= dailyFrom) bump(dayAsk, dayKey(a.created_at, timezone));
    const daily: HighlightStats['daily'] = [];
    for (let i = dailyDays - 1; i >= 0; i--) {
      const day = shiftDay(today, i);
      daily.push({ day, at: dayStart(day, timezone), highlights: dayHl.get(day) ?? 0, asks: dayAsk.get(day) ?? 0 });
    }

    // Everything else over the chosen period.
    const hls = hlRows.results.filter((h) => h.created_at >= tableFrom);
    const asks = askRows.results.filter((a) => a.created_at >= tableFrom);
    const asksPerHl = new Map<string, number>();
    for (const a of asks) bump(asksPerHl, a.highlight_id);
    const asked = hls.filter((h) => asksPerHl.has(h.id)).length;

    const group = (keyOf: (h: (typeof hls)[number]) => [string, string]) => {
      const m = new Map<string, HighlightStatsGroup>();
      for (const h of hls) {
        const [key, name] = keyOf(h);
        const g = m.get(key) ?? { key, name, highlights: 0, asks: 0 };
        g.highlights += 1;
        g.asks += asksPerHl.get(h.id) ?? 0;
        m.set(key, g);
      }
      return [...m.values()].sort((a, b) => b.highlights - a.highlights || b.asks - a.asks).slice(0, 15);
    };

    const promptStats = (keyOf: (a: (typeof asks)[number]) => string | null) => {
      const m = new Map<string, { row: HighlightPromptStats; secs: number[] }>();
      for (const a of asks) {
        const key = keyOf(a);
        if (!key) continue;
        const e = m.get(key) ?? { row: { label: key, asks: 0, failed: 0, up: 0, down: 0, medianSeconds: null }, secs: [] };
        e.row.asks += 1;
        if (a.status === 'failed') e.row.failed += 1;
        if (a.rating === 1) e.row.up += 1;
        if (a.rating === -1) e.row.down += 1;
        if (a.status === 'done' && a.seconds !== null) e.secs.push(a.seconds);
        m.set(key, e);
      }
      return [...m.values()].map((e) => ({ ...e.row, medianSeconds: median(e.secs) })).sort((a, b) => b.asks - a.asks);
    };

    const perItem = new Map<string, { itemId: string; title: string; sourceName: string | null; highlights: number }>();
    for (const h of hls) {
      const e = perItem.get(h.item_id) ?? { itemId: h.item_id, title: h.subject || '(no subject)', sourceName: h.source_name, highlights: 0 };
      e.highlights += 1;
      perItem.set(h.item_id, e);
    }

    const output: Record<AskOutput, number> = { note: 0, item: 0, both: 0 };
    for (const a of asks) if (a.output in output) output[a.output] += 1;

    const read = readRow?.n ?? 0;
    const out: HighlightStats = {
      days,
      totals: {
        highlights: hls.length,
        plain: hls.length - asked,
        asked,
        asks: asks.length,
        articles: perItem.size,
        per100Read: read > 0 ? Math.round((1000 * hls.length) / read) / 10 : null,
      },
      daily,
      bySource: group((h) => [h.source_id ?? '-', h.source_name ?? 'Unknown']),
      byCategory: group((h) => [h.cat, h.cat]),
      byPrompt: promptStats((a) => a.label),
      byModel: promptStats((a) => (a.model ? a.model : null)),
      output,
      mostHighlighted: [...perItem.values()].sort((a, b) => b.highlights - a.highlights).slice(0, 5),
      searches: {
        month: usage.month,
        used: usage.asks + usage.summaries,
        budget: webSearch.monthlyBudget,
        asks: usage.asks,
        summaries: usage.summaries,
      },
    };
    return c.json(out);
  });
}

function bump(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1);
}
