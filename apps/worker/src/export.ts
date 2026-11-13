import type { Hono } from 'hono';
import type { AppVariables, Env } from './env';
import { loadSettings } from './settings';
import { now } from './ids';

// Exports: the feed list as OPML (for any other reader), newsletters as CSV,
// and a full data export the app assembles page by page in the browser, so no
// single request has to build a big file within the free plan's CPU limit.

const PAGE = 500;
/** Tables of the key sentences feature that go into the full export as they are. */
export const EXPORT_TABLES = ['key_sentences', 'studies', 'study_cites', 'study_maybe', 'links', 'link_cites', 'ks_runs', 'ks_daily'] as const;

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function attachment(body: string, type: string, name: string): Response {
  return new Response(body, { headers: { 'content-type': `${type}; charset=utf-8`, 'content-disposition': `attachment; filename="${name}"` } });
}

const day = () => new Date(now()).toISOString().slice(0, 10);

interface FollowRow {
  kind: string;
  name: string;
  url: string | null;
  feed_url: string | null;
  folder: string | null;
  paused_at: number | null;
}

export function registerExport(app: App) {
  app.get('/api/export/opml', async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT kind, name, url, feed_url, folder, paused_at FROM sources WHERE kind IN ('feed', 'site') AND NOT (kind = 'site' AND url IS NULL) ORDER BY folder, name",
    ).all<FollowRow>();
    const outline = (r: FollowRow) =>
      r.kind === 'feed'
        ? `<outline type="rss" text="${esc(r.name)}" title="${esc(r.name)}" xmlUrl="${esc(r.feed_url ?? r.url ?? '')}"${r.url ? ` htmlUrl="${esc(r.url)}"` : ''}/>`
        : `<outline type="link" text="${esc(r.name)}" title="${esc(r.name)}" htmlUrl="${esc(r.url ?? '')}"/>`;
    const groups = new Map<string, FollowRow[]>();
    for (const r of rows.results) {
      // Website watches have no feed, so other readers can't follow them; they get a folder of their own.
      const key = r.kind === 'site' ? 'Website watches (not feeds)' : (r.folder ?? '');
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const body = [...groups.entries()]
      .map(([folder, list]) =>
        folder
          ? `    <outline text="${esc(folder)}" title="${esc(folder)}">\n${list.map((r) => `      ${outline(r)}`).join('\n')}\n    </outline>`
          : list.map((r) => `    ${outline(r)}`).join('\n'),
      )
      .join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Newsletter app feeds</title>
    <dateCreated>${new Date(now()).toUTCString()}</dateCreated>
  </head>
  <body>
${body}
  </body>
</opml>
`;
    return attachment(xml, 'text/x-opml', `feeds-${day()}.opml`);
  });

  app.get('/api/export/newsletters.csv', async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT sources.name, sources.sender_email, addresses.local_part, sources.category, sources.unsubscribed_at, sources.paused_at
       FROM sources LEFT JOIN addresses ON addresses.id = sources.address_id WHERE sources.kind = 'newsletter' ORDER BY sources.name`,
    ).all<{ name: string; sender_email: string | null; local_part: string | null; category: string | null; unsubscribed_at: number | null; paused_at: number | null }>();
    const domain = c.env.MAIL_DOMAIN ?? '';
    const lines = [
      'name,sender_email,your_address,category,unsubscribed,paused',
      ...rows.results.map((r) =>
        [
          r.name,
          r.sender_email,
          r.local_part ? `${r.local_part}${domain ? `@${domain}` : ''}` : '',
          r.category,
          r.unsubscribed_at ? new Date(r.unsubscribed_at).toISOString() : '',
          r.paused_at ? 'yes' : '',
        ]
          .map(csvCell)
          .join(','),
      ),
    ];
    return attachment(lines.join('\n') + '\n', 'text/csv', `newsletters-${day()}.csv`);
  });

  // The pieces of the full export. Items and events come a page at a time, oldest first.
  app.get('/api/export/meta', async (c) => {
    const [sources, settings, highlights] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM sources ORDER BY created_at').all(),
      loadSettings(c.env),
      c.env.DB.prepare('SELECT * FROM highlights ORDER BY created_at LIMIT 5000').all().catch(() => ({ results: [] })),
    ]);
    return c.json({ exportedAt: now(), sources: sources.results, settings, highlights: highlights.results });
  });

  app.get('/api/export/items', async (c) => {
    const after = Number(c.req.query('after') ?? 0) || 0;
    // Paged by rowid: each page is a short walk of the table, never a sort of the whole inbox.
    const rows = await c.env.DB.prepare(
      `SELECT items.rowid AS n, items.id, items.kind, items.status, items.subject, sources.name AS source, items.from_name, items.from_email,
         items.to_address, items.received_at, items.read_at, items.read_via, items.read_device, items.saved_at, items.interesting_at,
         ir.glance_secs, ir.summary_secs, ir.article_secs, ir.read_secs, ir.scroll_pct, ir.live_opened,
         items.archived_at, COALESCE(items.category, sources.category) AS category, items.tags, items.summary, items.key_points,
         items.why_it_matters, items.preheader, items.word_count, items.web_url, items.score, items.sponsored
       FROM items LEFT JOIN sources ON sources.id = items.source_id LEFT JOIN item_reads ir ON ir.item_id = items.id
       WHERE items.rowid > ? AND items.status != 'dropped' ORDER BY items.rowid LIMIT ${PAGE}`,
    )
      .bind(after)
      .all<{ n: number } & Record<string, unknown>>();
    const last = rows.results[rows.results.length - 1];
    return c.json({ items: rows.results.map(({ n: _n, ...r }) => r), next: rows.results.length === PAGE && last ? last.n : null });
  });

  /**
   * Key sentences (with your corrections and the Index), studies, their cites,
   * source links and PC runs, a page at a time by rowid. Search's own index
   * (ks_fts) isn't exported: it is rebuilt from key_sentences.
   */
  app.get('/api/export/table/:name', async (c) => {
    const name = c.req.param('name');
    if (!EXPORT_TABLES.includes(name as (typeof EXPORT_TABLES)[number])) return c.json({ error: 'unknown table' }, 404);
    const after = Number(c.req.query('after') ?? 0) || 0;
    const rows = await c.env.DB.prepare(`SELECT rowid AS n, * FROM ${name} WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE}`)
      .bind(after)
      .all<{ n: number } & Record<string, unknown>>();
    const last = rows.results[rows.results.length - 1];
    return c.json({ rows: rows.results.map(({ n: _n, ...r }) => r), next: rows.results.length === PAGE && last ? last.n : null });
  });

  app.get('/api/export/events', async (c) => {
    const after = Number(c.req.query('after') ?? 0) || 0;
    const rows = await c.env.DB.prepare(`SELECT id, item_id, type, value, device, at FROM events WHERE id > ? ORDER BY id LIMIT ${PAGE * 4}`)
      .bind(after)
      .all<{ id: number }>();
    const last = rows.results[rows.results.length - 1];
    return c.json({ events: rows.results, next: rows.results.length === PAGE * 4 && last ? last.id : null });
  });
}
