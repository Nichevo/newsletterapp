import { Hono } from 'hono';
import { registerDeleting } from './deleting';
import { KEY_FILTER_TOKEN as KEY_TOKEN, normalizePostFilter, parseFilterSet, tagKey, SAVE_LOCAL_PART, type FileFilter, type SaveAddressInfo } from '@newsletterapp/shared';
import type {
  Platform,
  AiMode,
  SearchResponse,
  SearchState,
  TagPage,
  SourceActivity,
  Address,
  AddressMonth,
  BulkReadInput,
  FullTextMode,
  AppSettings,
  Digest,
  ItemBody,
  ItemKind,
  SummaryKind,
  ItemListResponse,
  ItemSort,
  ItemSummary,
  ItemView,
  Me,
  ReadingEventInput,
  ReadingEventType,
  SourceUpdate,
  UnsubscribeResult,
  ReadDevice,
  ReadVia,
} from '@newsletterapp/shared';
import { registerAi } from './ai';
import { registerPcHolds } from './pcholds';
import { registerTagList, registerTopics } from './topics';
import { registerBacklog, unparkHeld } from './backlog';
import { AuthError, authenticate } from './auth';
import {
  isOneClick,
  isSavedPages,
  toAddress,
  parseList,
  toItemSummary,
  toSender,
  toSource,
  unsubscribeHttpUrl,
  unsubscribeMailto,
  type AddressRow,
  type ItemJoined,
  type ItemRow,
  type SenderRow,
  type SourceRow,
} from './db';
import { isSaveAddress, readSaveLog, signInEmails } from './saveinbox';
import { buildDigestIfDue } from './digest';
import { registerKeySentences, loadKeySettings } from './keysentences';
import { registerRefs } from './refs';
import { registerStories, toStoryInfo } from './stories';
import { registerEmbed } from './embed';
import { recordLinkClick, registerSuggest } from './suggest';
import { normalizeUrl, registerFeeds, startCount } from './feeds';
import { registerExport } from './export';
import { junkImage, leadImage } from './html';
import { registerHighlights } from './highlights';
import { registerHighlightPages } from './highlight-pages';
import { registerWebSearch } from './websearch';
import { registerReading } from './reading';
import type { AppVariables, Env } from './env';
import { newId, now, slugify } from './ids';
import { categoryFromRules, quickSummary } from './quick';
import { scoreRecentItems } from './scoring';
import { loadSettings, normalizeSettings, saveSettings } from './settings';
import { registerUsage } from './usage';

export const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use('/api/*', async (c, next) => {
  try {
    const who = await authenticate(c.req.raw, c.env);
    // The helper's service token only opens the helper endpoints, and only the helper uses them.
    const helperPath = c.req.path.startsWith('/api/helper/');
    if (who.kind === 'helper' && !helperPath) return c.json({ error: 'not for the helper' }, 403);
    if (who.kind === 'user' && helperPath) return c.json({ error: 'helper only' }, 403);
    c.set('userEmail', who.kind === 'user' ? who.email : '');
  } catch (err) {
    if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  await next();
});

app.get('/api/me', async (c) => {
  const settings = await loadSettings(c.env);
  const me: Me = {
    email: c.get('userEmail'),
    domain: c.env.MAIL_DOMAIN || null,
    digestOn: settings.digest.enabled,
    groupSameNews: settings.stories.groupSameNews,
    keySentencesOn: (await loadKeySettings(c.env)).enabled,
  };
  return c.json(me);
});

// AI queue, helper endpoints and AI settings. Registered before the generic
// item action route so /api/items/:id/rate and friends match first.
registerAi(app);
registerEmbed(app);
registerSuggest(app);
// Highlights and highlight asks; before the generic item action route too.
registerHighlights(app);
registerHighlightPages(app);
registerWebSearch(app);
// Feeds and websites: discovery, following, the Feedly import and the PC's fetch jobs.
registerFeeds(app);
registerExport(app);
registerUsage(app);
registerBacklog(app);
registerReading(app);
registerPcHolds(app);
registerTopics(app);
registerTagList(app);
registerStories(app);
registerKeySentences(app);
registerRefs(app);
registerDeleting(app);

// ---------- Items ----------

const ITEM_SELECT = `SELECT items.*, sources.name AS source_name, sources.category AS source_category, sources.ai_mode AS source_ai_mode, sources.ai_since AS source_ai_since, sources.show_picture AS source_show_picture, sources.feed_url AS source_feed_url, sources.kind AS source_kind, sources.url AS source_url,
    ai_runs.provider AS run_provider, ai_runs.model AS run_model, ai_runs.prompt_version AS run_prompt_version,
    ai_runs.seconds AS run_seconds, ai_runs.rating AS run_rating,
    stories.title AS story_title, stories.tags AS story_tags, stories.items AS story_items, stories.followed_at AS story_followed_at
  FROM items LEFT JOIN sources ON sources.id = items.source_id LEFT JOIN ai_runs ON ai_runs.id = items.ai_run_id
    LEFT JOIN stories ON stories.id = items.story_id`;
type ItemSelectRow = ItemRow & ItemJoined;

const VIEW_WHERE: Record<ItemView, string> = {
  inbox: "items.status = 'inbox'",
  unread: "items.status = 'inbox' AND items.read_at IS NULL",
  saved: "items.saved_at IS NOT NULL AND items.status != 'dropped'",
  interesting: "items.interesting_at IS NOT NULL AND items.status != 'dropped'",
  // Matches the partial index items_likely.
  likely: "items.likely = 1 AND items.status = 'inbox' AND items.read_at IS NULL",
  archived: "items.status = 'archived'",
};

async function loadItem(env: Env, id: string): Promise<ItemSummary | null> {
  const row = await env.DB.prepare(`${ITEM_SELECT} WHERE items.id = ?`)
    .bind(id)
    .first<ItemSelectRow>();
  if (!row) return null;
  const settings = await loadSettings(env);
  return toItemSummary(row, settings.aiByKind, settings.aiOffCategories);
}

/** The Type filter: Reddit, YouTube and GitHub feeds have their own types; "feed" is every other feed. */
const PLATFORM_SQL: Record<Platform, string> = {
  reddit: "COALESCE(sources.feed_url, '') LIKE '%reddit.com/%'",
  youtube: "COALESCE(sources.feed_url, '') LIKE '%youtube.com/feeds/%'",
  github: "COALESCE(sources.feed_url, '') LIKE '%github.com/%'",
};
/** Items kept as files (PDFs, pictures...), by the file type stored with them. */
const FILE_TYPE = "COALESCE(items.file_type, '')";
const FILE_SQL: Record<FileFilter, string> = {
  pdf: `${FILE_TYPE} LIKE '%pdf%'`,
  picture: `${FILE_TYPE} LIKE 'image/%'`,
  textfile: `(${FILE_TYPE} LIKE 'text/%' AND ${FILE_TYPE} <> 'text/html')`,
  otherfile: `(${FILE_TYPE} <> '' AND NOT (${FILE_TYPE} LIKE '%pdf%' OR ${FILE_TYPE} LIKE 'image/%' OR (${FILE_TYPE} LIKE 'text/%' AND ${FILE_TYPE} <> 'text/html')))`,
};
function typeSql(kind: string): string | null {
  if (kind in FILE_SQL) return FILE_SQL[kind as FileFilter];
  if (kind in PLATFORM_SQL) return `(items.kind = 'feed' AND ${PLATFORM_SQL[kind as Platform]})`;
  if (kind === 'feed') return `(items.kind = 'feed' AND NOT (${Object.values(PLATFORM_SQL).join(' OR ')}))`;
  if (kind === 'newsletter' || kind === 'site' || kind === 'ai') return `items.kind = '${kind}'`;
  return null;
}
/** Types to show and/or hide, e.g. "reddit|github" or "!reddit|!github". */
function typeWhere(value: string, _binds: unknown[]): string[] {
  const all = parseFilterSet(value);
  // "Key sentences" is about the item, not its type: it narrows whatever types are picked.
  const ks = [
    ...(all.include.includes(KEY_TOKEN) ? [KEY_SQL] : []),
    ...(all.exclude.includes(KEY_TOKEN) ? [`NOT ${KEY_SQL}`] : []),
  ];
  const set = { include: all.include.filter((k) => k !== KEY_TOKEN), exclude: all.exclude.filter((k) => k !== KEY_TOKEN) };
  const inc = set.include.map(typeSql).filter((s): s is string => s !== null);
  const exc = set.exclude.map(typeSql).filter((s): s is string => s !== null);
  return [...(inc.length ? [`(${inc.join(' OR ')})`] : []), ...exc.map((s) => `NOT ${s}`), ...ks];
}
const KEY_SQL = "COALESCE(items.ks_status, '') = 'done'";
const CATEGORY_SQL = "COALESCE(items.category, sources.category, json_extract(items.ai_category, '$[0]'))";
/** Sources to show and/or hide (ids, e.g. "a|b" or "!a"). */
function sourceWhere(value: string, binds: unknown[]): string[] {
  const set = parseFilterSet(value);
  const out: string[] = [];
  if (set.include.length) {
    out.push(`items.source_id IN (${set.include.map(() => '?').join(', ')})`);
    binds.push(...set.include);
  }
  if (set.exclude.length) {
    out.push(`COALESCE(items.source_id, '') NOT IN (${set.exclude.map(() => '?').join(', ')})`);
    binds.push(...set.exclude);
  }
  return out;
}
/** Categories to show and/or hide. */
function categoryWhere(value: string, binds: unknown[]): string[] {
  const set = parseFilterSet(value);
  const out: string[] = [];
  if (set.include.length) {
    out.push(`${CATEGORY_SQL} IN (${set.include.map(() => '?').join(', ')})`);
    binds.push(...set.include);
  }
  if (set.exclude.length) {
    out.push(`COALESCE(${CATEGORY_SQL}, '') NOT IN (${set.exclude.map(() => '?').join(', ')})`);
    binds.push(...set.exclude);
  }
  return out;
}

app.get('/api/items', async (c) => {
  const view = (c.req.query('view') ?? 'inbox') as ItemView;
  const sort = (c.req.query('sort') ?? 'newest') as ItemSort;
  const sourceId = c.req.query('source');
  const category = c.req.query('category');
  const kind = c.req.query('kind');
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
  const cursor = c.req.query('cursor');
  if (!(view in VIEW_WHERE)) return c.json({ error: 'bad view' }, 400);

  const where: string[] = [VIEW_WHERE[view]];
  const binds: unknown[] = [];
  if (sourceId) where.push(...sourceWhere(sourceId, binds));
  if (kind) where.push(...typeWhere(kind, binds));
  if (category) where.push(...categoryWhere(category, binds));
  // Counts for the inbox header, before the cursor narrows the query: only when filtered
  // (the unfiltered totals come from /api/counts) and only on the first page.
  const countSql =
    !cursor && (sourceId || kind || category || view === 'interesting' || view === 'likely')
      ? `SELECT COUNT(*) AS shown, SUM(items.read_at IS NULL) AS unread FROM items LEFT JOIN sources ON sources.id = items.source_id WHERE ${where.join(' AND ')}`
      : null;
  const countBinds = [...binds];
  const sourcesSql =
    !cursor && category && !(sourceId && parseFilterSet(sourceId).include.length)
      ? `SELECT DISTINCT items.source_id AS id FROM items LEFT JOIN sources ON sources.id = items.source_id
         WHERE ${where.join(' AND ')} AND items.source_id IS NOT NULL LIMIT 500`
      : null;
  // Cursors are "<received_at>:<id>", or "<score>:<received_at>:<id>" for the Top sort.
  if (cursor) {
    const parts = cursor.split(':');
    const id = parts.pop() ?? '';
    const at = Number(parts.pop());
    const score = Number(parts.pop());
    if (Number.isFinite(at) && id) {
      if (sort === 'top' && Number.isFinite(score)) {
        where.push(
          '(COALESCE(items.score, 0) < ? OR (COALESCE(items.score, 0) = ? AND (items.received_at < ? OR (items.received_at = ? AND items.id < ?))))',
        );
        binds.push(score, score, at, at, id);
      } else {
        where.push(
          sort === 'oldest'
            ? '(items.received_at > ? OR (items.received_at = ? AND items.id > ?))'
            : '(items.received_at < ? OR (items.received_at = ? AND items.id < ?))',
        );
        binds.push(at, at, id);
      }
    }
  }
  const order = sort === 'oldest' ? 'ASC' : 'DESC';
  const orderBy =
    sort === 'top'
      ? 'COALESCE(items.score, 0) DESC, items.received_at DESC, items.id DESC'
      : `items.received_at ${order}, items.id ${order}`;
  const [rows, settings, counted, catSources] = await Promise.all([
    c.env.DB.prepare(`${ITEM_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ?`)
      .bind(...binds, limit + 1)
      .all<ItemSelectRow>(),
    loadSettings(c.env),
    countSql ? c.env.DB.prepare(countSql).bind(...countBinds).first<{ shown: number; unread: number | null }>() : null,
    sourcesSql ? c.env.DB.prepare(sourcesSql).bind(...countBinds).all<{ id: string }>() : null,
  ]);

  const page = rows.results.slice(0, limit);
  const last = page[page.length - 1];
  const body: ItemListResponse = {
    items: page.map((r) => toItemSummary(r, settings.aiByKind, settings.aiOffCategories)),
    nextCursor:
      rows.results.length > limit && last
        ? sort === 'top'
          ? `${last.score ?? 0}:${last.received_at}:${last.id}`
          : `${last.received_at}:${last.id}`
        : null,
    ...(counted ? { counts: { shown: counted.shown, unread: counted.unread ?? 0 } } : {}),
    ...(catSources ? { categorySources: catSources.results.map((r) => r.id) } : {}),
  };
  return c.json(body);
});

// ---------- Search ----------

/** Turns what was typed into an FTS5 query: every word must match (as a prefix), "quoted words" as a phrase. */
export function ftsQuery(q: string): string | null {
  const parts: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    const words = (m[1] ?? m[2] ?? '').replace(/[^\p{L}\p{N}\s'-]+/gu, ' ').trim();
    if (!words) continue;
    parts.push(m[1] ? `"${words.replace(/"/g, '')}"` : words.split(/\s+/).map((w) => `"${w.replace(/"/g, '')}"*`).join(' '));
  }
  return parts.length ? parts.slice(0, 12).join(' ') : null;
}

const SEARCH_STATE: Record<SearchState, string> = {
  unread: "items.status = 'inbox' AND items.read_at IS NULL",
  read: 'items.read_at IS NOT NULL',
  saved: 'items.saved_at IS NOT NULL',
  interesting: 'items.interesting_at IS NOT NULL',
  archived: "items.status = 'archived'",
};
const SEARCH_PAGE = 30;

app.get('/api/search', async (c) => {
  const match = ftsQuery(c.req.query('q') ?? '');
  const category = c.req.query('category');
  const sourceId = c.req.query('source');
  const kind = c.req.query('kind');
  const state = c.req.query('state') as SearchState | undefined;
  const since = Number(c.req.query('since') ?? 0) || 0;
  const until = Number(c.req.query('until') ?? 0) || 0;
  const sort = c.req.query('sort') === 'newest' || !match ? 'newest' : 'relevance';
  const offset = Math.min(Math.max(Number(c.req.query('offset') ?? 0) || 0, 0), 600);
  if (!match && !category && !sourceId && !state && !since) return c.json({ items: [], total: 0, nextOffset: null } satisfies SearchResponse);

  const where: string[] = ["items.status IN ('inbox', 'archived')"];
  const binds: unknown[] = [];
  if (match) {
    where.push('items_fts MATCH ?');
    binds.push(match);
  }
  if (sourceId) where.push(...sourceWhere(sourceId, binds));
  if (kind) where.push(...typeWhere(kind, binds));
  if (category) where.push(...categoryWhere(category, binds));
  if (state && state in SEARCH_STATE) where.push(SEARCH_STATE[state]);
  if (since) {
    where.push('items.received_at >= ?');
    binds.push(since);
  }
  if (until) {
    where.push('items.received_at < ?');
    binds.push(until);
  }
  const from = match ? `${ITEM_SELECT} JOIN items_fts ON items_fts.rowid = items.rowid` : ITEM_SELECT;
  // Subject counts most, then the AI summary, tags and key points.
  const orderBy =
    sort === 'relevance' ? 'bm25(items_fts, 10, 3, 2, 2, 4, 3, 2, 3), items.received_at DESC' : 'items.received_at DESC, items.id DESC';
  const countFrom = match
    ? 'FROM items JOIN items_fts ON items_fts.rowid = items.rowid LEFT JOIN sources ON sources.id = items.source_id'
    : 'FROM items LEFT JOIN sources ON sources.id = items.source_id';
  try {
    const [rows, settings, counted] = await Promise.all([
      c.env.DB.prepare(`${from} WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
        .bind(...binds, SEARCH_PAGE + 1, offset)
        .all<ItemSelectRow>(),
      loadSettings(c.env),
      offset === 0
        ? c.env.DB.prepare(`SELECT COUNT(*) AS n ${countFrom} WHERE ${where.join(' AND ')}`)
            .bind(...binds)
            .first<{ n: number }>()
        : null,
    ]);
    const body: SearchResponse = {
      items: rows.results.slice(0, SEARCH_PAGE).map((r) => toItemSummary(r, settings.aiByKind, settings.aiOffCategories)),
      ...(counted ? { total: counted.n } : {}),
      nextOffset: rows.results.length > SEARCH_PAGE && offset + SEARCH_PAGE <= 600 ? offset + SEARCH_PAGE : null,
    };
    return c.json(body);
  } catch (err) {
    console.error('search failed', match, err);
    return c.json({ error: 'That search could not be run; try plainer words' }, 400);
  }
});

app.get('/api/items/:id', async (c) => {
  const item = await loadItem(c.env, c.req.param('id'));
  if (!item) return c.json({ error: 'not found' }, 404);
  // The numbers on the tag chips: one tag_counts row per tag.
  const keys = [...new Set(item.tags.map(tagKey).filter(Boolean))].slice(0, 10);
  if (keys.length) {
    const rows = await c.env.DB.prepare(`SELECT tag, n FROM tag_counts WHERE tag IN (${keys.map(() => '?').join(', ')})`)
      .bind(...keys)
      .all<{ tag: string; n: number }>();
    const n = new Map(rows.results.map((r) => [r.tag, r.n]));
    item.tagCounts = Object.fromEntries(item.tags.map((t) => [t, n.get(tagKey(t)) ?? 1]));
  }
  return c.json(item);
});

// ---------- Tags ----------

const TAG_PAGE = 30;
const TAG_WEEKS = 8;
const TAG_SELECT = ITEM_SELECT.replace('FROM items LEFT JOIN', 'FROM item_tags it JOIN items ON items.id = it.item_id LEFT JOIN');

/** A tag's page: its items (newest first, a page at a time) and, on the first page, its numbers. */
app.get('/api/tag', async (c) => {
  const tag = tagKey(c.req.query('name') ?? '').slice(0, 120);
  if (!tag) return c.json({ error: 'which tag?' }, 400);
  const unreadOnly = c.req.query('view') === 'unread';
  const offset = Math.min(Math.max(Number(c.req.query('offset') ?? 0) || 0, 0), 2000);
  const where = `it.tag = ? AND items.status IN ('inbox', 'archived')${unreadOnly ? ' AND items.read_at IS NULL' : ''}`;
  const first = offset === 0;
  const [rows, settings, stats, seenWith] = await Promise.all([
    c.env.DB.prepare(`${TAG_SELECT} WHERE ${where} ORDER BY it.received_at DESC LIMIT ? OFFSET ?`)
      .bind(tag, TAG_PAGE + 1, offset)
      .all<ItemSelectRow>(),
    loadSettings(c.env),
    first
      ? c.env.DB.prepare(
          `SELECT items.source_id, COALESCE(sources.name, items.from_name, items.from_email) AS name, items.read_at IS NULL AS unread,
             it.received_at, it.label, items.story_id
           FROM item_tags it JOIN items ON items.id = it.item_id LEFT JOIN sources ON sources.id = items.source_id
           WHERE it.tag = ? AND items.status IN ('inbox', 'archived') ORDER BY it.received_at DESC LIMIT 3000`,
        )
          .bind(tag)
          .all<{ source_id: string | null; name: string | null; unread: number; received_at: number; label: string; story_id: string | null }>()
      : null,
    first
      ? c.env.DB.prepare(
          `SELECT t2.tag, MAX(t2.label) AS label, COUNT(*) AS n FROM item_tags t1 JOIN item_tags t2 ON t2.item_id = t1.item_id
           WHERE t1.tag = ?1 AND t2.tag != ?1 GROUP BY t2.tag ORDER BY n DESC, t2.tag LIMIT 12`,
        )
          .bind(tag)
          .all<{ tag: string; label: string; n: number }>()
      : null,
  ]);
  const s = stats?.results ?? [];
  const t = now();
  const weeks = Array.from({ length: TAG_WEEKS }, (_, i) => ({ start: t - (TAG_WEEKS - i) * 7 * 86_400_000, n: 0 }));
  const bySource = new Map<string, { id: string | null; name: string; n: number }>();
  const labels = new Map<string, number>();
  for (const r of s) {
    const w = Math.floor((t - r.received_at) / (7 * 86_400_000));
    if (w >= 0 && w < TAG_WEEKS) weeks[TAG_WEEKS - 1 - w]!.n++;
    const k = r.source_id ?? `name:${r.name ?? ''}`;
    const e = bySource.get(k) ?? { id: r.source_id, name: r.name ?? 'Unknown', n: 0 };
    e.n++;
    bySource.set(k, e);
    labels.set(r.label, (labels.get(r.label) ?? 0) + 1);
  }
  const label = [...labels].sort((a, b) => b[1] - a[1])[0]?.[0] ?? labelFrom(rows.results[0]?.tags ?? null, tag);
  // Stories among the tag's items, most recent first (the rows are newest first), from rows already read.
  const storyUnread = new Map<string, number>();
  for (const r of s) if (r.story_id) storyUnread.set(r.story_id, (storyUnread.get(r.story_id) ?? 0) + (r.unread ? 1 : 0));
  const storyIds = [...storyUnread.keys()].slice(0, 8);
  const storyRows = storyIds.length
    ? await c.env.DB.prepare(`SELECT * FROM stories WHERE id IN (${storyIds.map(() => '?').join(', ')})`)
        .bind(...storyIds)
        .all<Parameters<typeof toStoryInfo>[0]>()
    : null;
  const body: TagPage = {
    tag,
    label,
    total: s.length,
    unread: s.filter((r) => r.unread).length,
    firstAt: s.length ? s[s.length - 1]!.received_at : null,
    weeks,
    seenWith: seenWith?.results ?? [],
    sources: [...bySource.values()].sort((a, b) => b.n - a.n).slice(0, 12),
    items: rows.results.slice(0, TAG_PAGE).map((r) => toItemSummary(r, settings.aiByKind, settings.aiOffCategories)),
    nextOffset: rows.results.length > TAG_PAGE ? offset + TAG_PAGE : null,
    ...(first
      ? {
          stories: (storyRows?.results ?? [])
            .map((r) => ({ ...toStoryInfo(r), unread: storyUnread.get(r.id) ?? 0 }))
            .sort((a, b) => b.lastAt - a.lastAt),
        }
      : {}),
  };
  return c.json(body);
});

/** The tag as the AI wrote it on an item, for later pages that skip the numbers. */
function labelFrom(raw: string | null, tag: string): string {
  return parseList(raw).find((l) => tagKey(l) === tag)?.trim() ?? tag;
}

app.get('/api/items/:id/body', async (c) => {
  const row = await c.env.DB.prepare('SELECT html_key, text_key, status FROM items WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ html_key: string | null; text_key: string | null; status: string }>();
  if (!row || row.status === 'dropped') return c.json({ error: 'not found' }, 404);
  const [html, text] = await Promise.all([
    row.html_key ? c.env.RAW.get(row.html_key).then((o) => o?.text() ?? null) : null,
    row.text_key ? c.env.RAW.get(row.text_key).then((o) => o?.text() ?? null) : null,
  ]);
  const body: ItemBody = { html, text };
  return c.json(body, 200, { 'Cache-Control': 'private, max-age=604800' });
});

// A post's picture as the PC downloaded it (comics whose own picture links expire).
app.get('/api/items/:id/picture', async (c) => {
  const id = c.req.param('id');
  const obj = /^[\w-]{1,64}$/.test(id) ? await c.env.RAW.get(`items/${id}/picture`) : null;
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(obj.body, {
    headers: { 'Content-Type': obj.httpMetadata?.contentType ?? 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' },
  });
});

app.get('/api/items/:id/raw', async (c) => {
  const row = await c.env.DB.prepare('SELECT raw_key FROM items WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ raw_key: string | null }>();
  const obj = row?.raw_key ? await c.env.RAW.get(row.raw_key) : null;
  if (!obj) return c.json({ error: 'not found' }, 404);
  return new Response(obj.body, {
    headers: { 'Content-Type': 'message/rfc822', 'Content-Disposition': `attachment; filename="${c.req.param('id')}.eml"` },
  });
});

/** Phone or desktop, from the client's own say-so or, failing that, its user agent. */
function deviceOf(c: { req: { header: (name: string) => string | undefined } }, claimed?: unknown): ReadDevice {
  if (claimed === 'phone' || claimed === 'desktop') return claimed;
  return /Mobi|Android|iPhone/i.test(c.req.header('user-agent') ?? '') ? 'phone' : 'desktop';
}

/** Marks items read once, remembering how and where; items already read keep their original record. */
async function markRead(env: Env, ids: string[], via: ReadVia, device: ReadDevice, at = now()): Promise<number> {
  let changed = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await env.DB.prepare(
      `UPDATE items SET read_at = ?1, read_via = ?2, read_device = ?3 WHERE read_at IS NULL AND id IN (${chunk.map(() => '?').join(',')})`,
    )
      .bind(at, via, device, ...chunk)
      .run();
    changed += r.meta.changes ?? 0;
  }
  return changed;
}

async function logEvent(env: Env, itemId: string, type: ReadingEventType, value?: number, device?: string) {
  await env.DB.prepare('INSERT INTO events (item_id, type, value, device, at) VALUES (?, ?, ?, ?, ?)')
    .bind(itemId, type, value ?? null, device ?? null, now())
    .run();
}

// ---------- One-tap unsubscribe ----------

/**
 * Unsubscribes from the item's newsletter. With RFC 8058 one-click support the
 * Worker posts the request itself; otherwise the app gets the link or mailto to
 * open. Either way the source is marked so the app can say so.
 */
app.post('/api/items/:id/unsubscribe', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT source_id, list_unsubscribe, list_unsubscribe_post FROM items WHERE id = ?')
    .bind(id)
    .first<{ source_id: string | null; list_unsubscribe: string | null; list_unsubscribe_post: string | null }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  const url = unsubscribeHttpUrl(row.list_unsubscribe);
  const mailto = unsubscribeMailto(row.list_unsubscribe);
  const result: UnsubscribeResult = { done: false, url, mailto, error: null };
  if (url && isOneClick(row.list_unsubscribe, row.list_unsubscribe_post)) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'newsletterapp (one-click unsubscribe)' },
        body: 'List-Unsubscribe=One-Click',
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
      });
      result.done = res.ok;
      if (!res.ok) result.error = `The sender answered ${res.status}`;
    } catch (err) {
      result.error = err instanceof Error ? err.message : 'Request failed';
    }
  }
  if (row.source_id && (result.done || url || mailto)) {
    await c.env.DB.prepare('UPDATE sources SET unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE id = ?').bind(now(), row.source_id).run();
  }
  return c.json(result);
});

type ItemAction = 'read' | 'unread' | 'save' | 'unsave' | 'interesting' | 'uninteresting' | 'archive' | 'unarchive';
// ?1 is the current time, ?2 the item id.
const ITEM_ACTIONS: Record<ItemAction, { sql: string; event: ReadingEventType | null }> = {
  read: { sql: 'SELECT 1 WHERE ?1 > 0 AND ?2 != ?2', event: 'mark_read' }, // handled by markRead below
  unread: { sql: 'UPDATE items SET read_at = NULL, read_via = NULL, read_device = NULL WHERE id = ?2 AND ?1 > 0', event: null },
  save: { sql: 'UPDATE items SET saved_at = COALESCE(saved_at, ?1) WHERE id = ?2', event: 'save' },
  unsave: { sql: 'UPDATE items SET saved_at = NULL WHERE id = ?2 AND ?1 > 0', event: 'unsave' },
  interesting: { sql: 'UPDATE items SET interesting_at = COALESCE(interesting_at, ?1) WHERE id = ?2', event: 'interesting' },
  uninteresting: { sql: 'UPDATE items SET interesting_at = NULL WHERE id = ?2 AND ?1 > 0', event: 'uninteresting' },
  archive: { sql: "UPDATE items SET status = 'archived', archived_at = ?1 WHERE id = ?2 AND status = 'inbox'", event: 'archive' },
  unarchive: { sql: "UPDATE items SET status = 'inbox', archived_at = NULL WHERE id = ?2 AND ?1 > 0 AND status = 'archived'", event: 'unarchive' },
};

/** Marks the listed items read (as "bulk") or unread again, e.g. the inbox's "Mark these read" and its Undo. */
app.post('/api/items/bulk-read', async (c) => {
  const input = (await c.req.json().catch(() => null)) as (BulkReadInput & { device?: unknown }) | null;
  const ids = Array.isArray(input?.ids) ? input.ids.filter((x): x is string => typeof x === 'string').slice(0, 500) : [];
  if (!ids.length || (input!.action !== 'read' && input!.action !== 'unread')) return c.json({ error: 'ids and action required' }, 400);
  if (input!.action === 'read') return c.json({ changed: await markRead(c.env, ids, 'bulk', deviceOf(c, input!.device)) });
  let changed = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await c.env.DB.prepare(
      `UPDATE items SET read_at = NULL, read_via = NULL, read_device = NULL WHERE read_at IS NOT NULL AND id IN (${chunk.map(() => '?').join(',')})`,
    )
      .bind(...chunk)
      .run();
    changed += r.meta.changes ?? 0;
  }
  return c.json({ changed });
});

app.post('/api/items/:id/:action', async (c) => {
  const action = c.req.param('action') as ItemAction | 'events';
  const id = c.req.param('id');

  if (action === 'events') {
    const input = (await c.req.json().catch(() => null)) as ReadingEventInput | null;
    if (!input?.type) return c.json({ error: 'type required' }, 400);
    await logEvent(c.env, id, input.type, input.value, input.device);
    if (input.type === 'link_click' && typeof input.url === 'string') {
      await recordLinkClick(c.env, id, input.url.slice(0, 2000)).catch((err: unknown) => console.error('link click not recorded', err));
    }
    if (input.type === 'open') await markRead(c.env, [id], 'reader', deviceOf(c, input.device));
    return c.json({ ok: true });
  }

  const def = ITEM_ACTIONS[action];
  if (!def) return c.json({ error: 'unknown action' }, 404);
  if (action === 'read') {
    const body = (await c.req.json().catch(() => null)) as { device?: unknown } | null;
    await markRead(c.env, [id], 'swipe', deviceOf(c, body?.device));
  } else {
    await c.env.DB.prepare(def.sql).bind(now(), id).run();
  }
  if (def.event) await logEvent(c.env, id, def.event);
  const item = await loadItem(c.env, id);
  return item ? c.json(item) : c.json({ error: 'not found' }, 404);
});

// ---------- Counts for badges ----------

app.get('/api/counts', async (c) => {
  // Inbox and unread in one pass over the inbox_read index (index only, no table reads).
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM items INDEXED BY items_inbox_read WHERE status = 'inbox') AS inbox,
       (SELECT COUNT(*) FROM items INDEXED BY items_inbox_read WHERE status = 'inbox' AND read_at IS NULL) AS unread,
       (SELECT COUNT(*) FROM items INDEXED BY items_saved WHERE saved_at IS NOT NULL AND status != 'dropped') AS saved,
       (SELECT COUNT(*) FROM items INDEXED BY items_interesting WHERE interesting_at IS NOT NULL AND status != 'dropped') AS interesting,
       (SELECT COUNT(*) FROM senders WHERE status = 'pending') AS pendingSenders`,
  ).first<{ inbox: number; unread: number; saved: number; interesting: number; pendingSenders: number }>();
  return c.json(row ?? { inbox: 0, unread: 0, saved: 0, interesting: 0, pendingSenders: 0 });
});

// ---------- Senders (New senders screen) ----------

const SENDER_SELECT = `
  SELECT senders.*, addresses.local_part AS address_local_part,
    (SELECT COUNT(*) FROM items WHERE items.sender_id = senders.id AND items.status = 'screening') AS pending_count,
    (SELECT subject FROM items WHERE items.sender_id = senders.id ORDER BY received_at DESC LIMIT 1) AS latest_subject,
    (SELECT id FROM items WHERE items.sender_id = senders.id ORDER BY received_at DESC LIMIT 1) AS latest_item_id
  FROM senders LEFT JOIN addresses ON addresses.id = senders.address_id`;

app.get('/api/senders', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  if (!['pending', 'approved', 'blocked'].includes(status)) return c.json({ error: 'bad status' }, 400);
  const rows = await c.env.DB.prepare(`${SENDER_SELECT} WHERE senders.status = ? ORDER BY senders.last_seen_at DESC LIMIT 200`)
    .bind(status)
    .all<SenderRow & { address_local_part: string | null; pending_count: number; latest_subject: string | null; latest_item_id: string | null }>();
  return c.json(rows.results.map(toSender));
});

app.post('/api/senders/:id/:decision', async (c) => {
  const id = c.req.param('id');
  const decision = c.req.param('decision');
  const t = now();
  if (decision === 'allow') {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE senders SET status = 'approved', decided_at = ? WHERE id = ?").bind(t, id),
      c.env.DB.prepare(
        "UPDATE items SET status = 'inbox', ai_status = COALESCE(ai_status, 'pending') WHERE sender_id = ? AND status = 'screening'",
      ).bind(id),
    ]);
  } else if (decision === 'block') {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE senders SET status = 'blocked', decided_at = ? WHERE id = ?").bind(t, id),
      c.env.DB.prepare("UPDATE items SET status = 'dropped' WHERE sender_id = ? AND status IN ('screening', 'inbox')").bind(id),
    ]);
  } else {
    return c.json({ error: 'unknown decision' }, 404);
  }
  const row = await c.env.DB.prepare(`${SENDER_SELECT} WHERE senders.id = ?`).bind(id).first<SenderRow>();
  return row ? c.json(toSender(row)) : c.json({ error: 'not found' }, 404);
});

// ---------- Addresses (sign-up aliases) ----------

const ADDRESS_SELECT = `
  SELECT addresses.*,
    (SELECT COUNT(*) FROM senders WHERE senders.address_id = addresses.id AND senders.status = 'approved') AS approved_sender_count
  FROM addresses`;

app.get('/api/addresses', async (c) => {
  const rows = await c.env.DB.prepare(`${ADDRESS_SELECT} ORDER BY created_at DESC`).all<AddressRow & { approved_sender_count: number }>();
  const domain = c.env.MAIL_DOMAIN || null;
  const body: Address[] = rows.results.map((r) => toAddress(r, domain));
  return c.json(body);
});

app.post('/api/addresses', async (c) => {
  const input = (await c.req.json().catch(() => null)) as { label?: string; localPart?: string } | null;
  const label = input?.label?.trim() || null;
  let localPart = slugify(input?.localPart?.trim() || label || '');
  if (!localPart) return c.json({ error: 'label or localPart required' }, 400);

  // Keep the slug unique: money-matters, money-matters-2, ...
  const base = localPart;
  for (let n = 2; n < 50; n++) {
    // save@ is the save address, never a newsletter's.
    const taken = isSaveAddress(localPart) || (await c.env.DB.prepare('SELECT 1 FROM addresses WHERE local_part = ?').bind(localPart).first());
    if (!taken) break;
    localPart = `${base}-${n}`;
  }
  const id = newId();
  const t = now();
  await c.env.DB.prepare(
    'INSERT INTO addresses (id, local_part, label, status, created_in_app, created_at) VALUES (?, ?, ?, ?, 1, ?)',
  )
    .bind(id, localPart, label, 'active', t)
    .run();
  const row = await c.env.DB.prepare(`${ADDRESS_SELECT} WHERE addresses.id = ?`).bind(id).first<AddressRow & { approved_sender_count: number }>();
  return c.json(toAddress(row!, c.env.MAIL_DOMAIN || null), 201);
});

app.post('/api/addresses/:id/:action', async (c) => {
  const id = c.req.param('id');
  const action = c.req.param('action');
  if (action === 'block') {
    await c.env.DB.prepare("UPDATE addresses SET status = 'blocked', blocked_at = ? WHERE id = ?").bind(now(), id).run();
  } else if (action === 'unblock') {
    await c.env.DB.prepare("UPDATE addresses SET status = 'active', blocked_at = NULL WHERE id = ?").bind(id).run();
  } else {
    return c.json({ error: 'unknown action' }, 404);
  }
  const row = await c.env.DB.prepare(`${ADDRESS_SELECT} WHERE addresses.id = ?`).bind(id).first<AddressRow & { approved_sender_count: number }>();
  return row ? c.json(toAddress(row, c.env.MAIL_DOMAIN || null)) : c.json({ error: 'not found' }, 404);
});

// The owner's own name and note for an address.
app.put('/api/addresses/:id', async (c) => {
  const id = c.req.param('id');
  const input = (await c.req.json().catch(() => null)) as { label?: string | null; note?: string | null } | null;
  if (!input) return c.json({ error: 'nothing to save' }, 400);
  const sets: string[] = [];
  const binds: (string | null)[] = [];
  if (input.label !== undefined) {
    sets.push('label = ?');
    binds.push(input.label?.trim().slice(0, 120) || null);
  }
  if (input.note !== undefined) {
    sets.push('note = ?');
    binds.push(input.note?.trim().slice(0, 500) || null);
  }
  if (sets.length) await c.env.DB.prepare(`UPDATE addresses SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
  const row = await c.env.DB.prepare(`${ADDRESS_SELECT} WHERE addresses.id = ?`).bind(id).first<AddressRow & { approved_sender_count: number }>();
  return row ? c.json(toAddress(row, c.env.MAIL_DOMAIN || null)) : c.json({ error: 'not found' }, 404);
});

// Emails per month for one address, from the stored counts (one row per month).
app.get('/api/addresses/:id/months', async (c) => {
  const rows = await c.env.DB.prepare('SELECT month, n FROM address_months WHERE address_id = ? ORDER BY month')
    .bind(c.req.param('id'))
    .all<{ month: string; n: number }>();
  const body: AddressMonth[] = rows.results.map((r) => ({ month: r.month, count: r.n }));
  return c.json(body);
});

// Only an address that never received anything can go; one that did is blocked instead,
// so its newsletters keep their history.
app.delete('/api/addresses/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT item_count FROM addresses WHERE id = ?').bind(id).first<{ item_count: number }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  if (row.item_count > 0) return c.json({ error: 'This address has received emails, so it can only be blocked.' }, 409);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM address_months WHERE address_id = ?').bind(id),
    c.env.DB.prepare("DELETE FROM sources WHERE address_id = ? AND kind = 'newsletter'").bind(id),
    c.env.DB.prepare('DELETE FROM senders WHERE address_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM addresses WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// ---------- Sources ----------

app.get('/api/sources', async (c) => {
  // Post counts read every item a source has, so only the source pages ask for them (?counts=1);
  // the inbox, search and settings lists need just the names, in latest-post order.
  const counts = c.req.query('counts') === '1';
  const latest = `(SELECT received_at FROM items INDEXED BY items_source
       WHERE items.source_id = sources.id AND items.status IN ('inbox', 'archived') ORDER BY received_at DESC LIMIT 1)`;
  const itemCount = counts
    ? "(SELECT COUNT(*) FROM items WHERE items.source_id = sources.id AND items.status IN ('inbox', 'archived'))"
    : `(${latest} IS NOT NULL)`;
  const rows = await c.env.DB.prepare(
    `SELECT * FROM (
       SELECT sources.*, ${itemCount} AS item_count, ${latest} AS last_received_at
       FROM sources
     ) WHERE item_count > 0 OR kind != 'newsletter' ORDER BY kind = 'newsletter' DESC, COALESCE(last_received_at, created_at) DESC`,
  ).all<SourceRow & { item_count: number; last_received_at: number | null }>();
  return c.json(rows.results.map((r) => toSource(counts ? r : { ...r, item_count: 0 })));
});

/**
 * Picks out the picture for a source's latest posts that came in before
 * pictures were looked for, so switching "show the picture" on fills the
 * inbox straight away. A handful of saved copies, read once.
 */
async function backfillPictures(env: Env, sourceId: string) {
  const rows = await env.DB.prepare(
    `SELECT id, html_key, web_url, lead_image FROM items INDEXED BY items_source
     WHERE source_id = ? AND html_key IS NOT NULL ORDER BY received_at DESC LIMIT 12`,
  )
    .bind(sourceId)
    .all<{ id: string; html_key: string; web_url: string | null; lead_image: string | null }>();
  // Posts with a good picture keep it; ones with none, or a site logo picked by an earlier version, look again.
  const found = await Promise.all(
    rows.results.filter((r) => !r.lead_image || junkImage(r.lead_image)).map(async (r) => {
      const html = await env.RAW.get(r.html_key).then((o) => o?.text() ?? null);
      return { id: r.id, picture: html ? leadImage(html, r.web_url) : null };
    }),
  );
  const updates = found
    .filter((f) => f.picture)
    .map((f) =>
      env.DB.prepare('UPDATE items SET lead_image = ?, lead_image_title = ?, lead_image_alt = ? WHERE id = ?').bind(f.picture!.src, f.picture!.title, f.picture!.alt, f.id),
    );
  if (updates.length) await env.DB.batch(updates);

  // The latest few posts also go back to the PC once, which picks the picture from the whole
  // page and keeps a copy: saved copies can miss the comic, and some sites' picture links expire.
  const t = now();
  const recent = await env.DB.prepare(
    `SELECT items.id, items.web_url FROM items INDEXED BY items_source JOIN sources ON sources.id = items.source_id
     WHERE items.source_id = ? AND sources.kind IN ('feed', 'site') AND items.web_url IS NOT NULL
       AND (items.lead_image IS NULL OR items.lead_image NOT LIKE '/api/%')
     ORDER BY items.received_at DESC LIMIT 5`,
  )
    .bind(sourceId)
    .all<{ id: string; web_url: string }>();
  const jobs = recent.results.map((r) =>
    env.DB.prepare(
      `INSERT INTO fetch_jobs (id, kind, source_id, item_id, url, created_at)
       SELECT ?1, 'article', ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM fetch_jobs WHERE item_id = ?3 AND kind = 'article')`,
    ).bind(newId(), sourceId, r.id, r.web_url, t),
  );
  if (jobs.length) await env.DB.batch(jobs);
}

// Items, reads and stars per source over the last 90 days: one grouped read of
// those 90 days' items, only when Your sources or a source page is open.
app.get('/api/sources/activity', async (c) => {
  const t = now();
  const from = t - 90 * 86_400_000;
  const [rows, created] = await Promise.all([
    c.env.DB.prepare(
      `SELECT source_id, COUNT(*) AS items, SUM(read_at IS NOT NULL) AS reads, SUM(interesting_at IS NOT NULL) AS stars, MIN(received_at) AS first
       FROM items WHERE status IN ('inbox', 'archived') AND received_at >= ? AND source_id IS NOT NULL GROUP BY source_id`,
    )
      .bind(from)
      .all<{ source_id: string; items: number; reads: number | null; stars: number | null; first: number }>(),
    c.env.DB.prepare('SELECT id, created_at FROM sources').all<{ id: string; created_at: number }>(),
  ]);
  const byId = new Map(rows.results.map((r) => [r.source_id, r]));
  const out: SourceActivity[] = created.results.map((s) => {
    const r = byId.get(s.id);
    return {
      sourceId: s.id,
      // A new source counts from when it was added, or from its first post if it brought older ones in.
      days: Math.max(1, Math.min(90, Math.round((t - Math.max(from, Math.min(s.created_at, r?.first ?? s.created_at))) / 86_400_000))),
      items: r?.items ?? 0,
      reads: r?.reads ?? 0,
      stars: r?.stars ?? 0,
    };
  });
  return c.json(out);
});

// Mark all read / archive all for one newsletter.
app.post('/api/sources/:id/read-all', async (c) => {
  const r = await c.env.DB.prepare("UPDATE items SET read_at = ?, read_via = 'bulk', read_device = ? WHERE source_id = ? AND status = 'inbox' AND read_at IS NULL")
    .bind(now(), deviceOf(c), c.req.param('id'))
    .run();
  return c.json({ changed: r.meta.changes ?? 0 });
});

app.post('/api/sources/:id/archive-all', async (c) => {
  const t = now();
  const r = await c.env.DB.prepare(
    "UPDATE items SET status = 'archived', archived_at = ?, read_via = COALESCE(read_via, 'bulk'), read_device = COALESCE(read_device, ?), read_at = COALESCE(read_at, ?) WHERE source_id = ? AND status = 'inbox'",
  )
    .bind(t, deviceOf(c), t, c.req.param('id'))
    .run();
  return c.json({ changed: r.meta.changes ?? 0 });
});

const AI_MODES: AiMode[] = ['default', 'on', 'off'];
const FULL_TEXT: FullTextMode[] = ['auto', 'always', 'never'];

app.post('/api/sources/:id', async (c) => {
  const id = c.req.param('id');
  const input = (await c.req.json().catch(() => null)) as SourceUpdate | null;
  if (!input) return c.json({ error: 'body required' }, 400);
  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (sql: string, value: unknown) => {
    sets.push(sql);
    binds.push(value);
  };
  if (input.category !== undefined) {
    set('category = ?', typeof input.category === 'string' && input.category.trim() ? input.category.trim().slice(0, 40) : null);
  }
  let switchedOnSince: number | null = null;
  if (input.aiMode !== undefined) {
    if (!AI_MODES.includes(input.aiMode)) return c.json({ error: 'bad aiMode' }, 400);
    set('ai_mode = ?', input.aiMode);
    // Switching AI on only summarises new items, unless asked to go back a few days
    // (or through everything), so a feed's old posts don't flood the PC.
    const current = await c.env.DB.prepare('SELECT kind, ai_mode FROM sources WHERE id = ?').bind(id).first<{ kind: ItemKind; ai_mode: AiMode }>();
    if (current) {
      const { aiByKind } = await loadSettings(c.env);
      const isOn = (mode: AiMode) => mode === 'on' || (mode === 'default' && aiByKind[current.kind as SummaryKind]);
      if (!isOn(current.ai_mode) && isOn(input.aiMode)) {
        const back = input.aiBackdateDays;
        const t = now();
        switchedOnSince = back === 'all' ? 0 : t - Math.min(Math.max(Number(back) || 0, 0), 365) * 86_400_000;
        set('ai_since = ?', switchedOnSince);
      }
    }
  }
  if (typeof input.name === 'string' && input.name.trim()) set('name = ?', input.name.trim().slice(0, 200));
  if (input.keySentences === 'auto' || input.keySentences === 'always' || input.keySentences === 'never')
    set('key_sentences = ?', input.keySentences === 'auto' ? null : input.keySentences);
  // The rest only mean something for feeds and websites.
  if (input.fetchVia === 'cloud' || input.fetchVia === 'pc') set("fetch_via = CASE WHEN kind = 'feed' THEN ? ELSE 'pc' END", input.fetchVia);
  if (typeof input.render === 'boolean') set('render = ?', input.render ? 1 : 0);
  if (typeof input.showPicture === 'boolean') set('show_picture = ?', input.showPicture ? 1 : 0);
  if (typeof input.waitHours === 'number') set('wait_hours = ?', Math.min(Math.max(Math.round(input.waitHours), 0), 72));
  if (typeof input.bundle === 'boolean') set('bundle = ?', input.bundle ? 1 : 0);
  if (typeof input.floodSkip === 'boolean') set('flood_skip = ?', input.floodSkip ? 1 : 0);
  if (typeof input.followLink === 'boolean') set('follow_link = ?', input.followLink ? 1 : 0);
  if (input.postFilter !== undefined) set('post_filter = ?', JSON.stringify(normalizePostFilter(input.postFilter)));
  if (typeof input.dailyCap === 'number') set('daily_cap = ?', Math.min(Math.max(Math.round(input.dailyCap), 0), 500));
  if (input.fullText !== undefined) {
    if (!FULL_TEXT.includes(input.fullText)) return c.json({ error: 'bad fullText' }, 400);
    set('full_text = ?', input.fullText);
  }
  if (input.linkHint !== undefined) set('link_hint = ?', input.linkHint?.trim().slice(0, 200) || null);
  if (typeof input.checkMinutes === 'number' && input.checkMinutes >= 15 && input.checkMinutes <= 10_080) {
    set('check_minutes = ?', Math.round(input.checkMinutes));
  } else if (input.checkMinutes === null) set('check_minutes = ?', null);
  if (input.followAs !== undefined || input.url !== undefined || input.feedUrl !== undefined) {
    // Change how a feed or website is followed: switch between the two, or point it at a new address.
    const cur = await c.env.DB.prepare('SELECT kind, url, feed_url FROM sources WHERE id = ?')
      .bind(id)
      .first<{ kind: ItemKind; url: string | null; feed_url: string | null }>();
    if (!cur || (cur.kind !== 'feed' && cur.kind !== 'site') || isSavedPages(cur))
      return c.json({ error: 'Only feeds and websites can change how they are followed' }, 400);
    const kind = input.followAs ?? cur.kind;
    if (kind !== 'feed' && kind !== 'site') return c.json({ error: 'bad followAs' }, 400);
    const url = input.url !== undefined ? normalizeUrl(input.url) : cur.url;
    const feedUrl = kind === 'feed' ? (input.feedUrl !== undefined ? normalizeUrl(input.feedUrl) : cur.feed_url) : cur.feed_url;
    if (kind === 'site' && !url) return c.json({ error: 'A web address is required' }, 400);
    if (kind === 'feed' && !feedUrl) return c.json({ error: 'A feed address is required' }, 400);
    const dup = await c.env.DB.prepare(
      kind === 'feed' ? "SELECT id FROM sources WHERE kind = 'feed' AND feed_url = ? AND id != ?" : "SELECT id FROM sources WHERE kind = 'site' AND url = ? AND id != ?",
    )
      .bind(kind === 'feed' ? feedUrl : url, id)
      .first<{ id: string }>();
    if (dup) return c.json({ error: 'You already follow this', sourceId: dup.id }, 409);
    const changed = kind !== cur.kind || url !== cur.url || (kind === 'feed' && feedUrl !== cur.feed_url);
    if (changed) {
      set('kind = ?', kind);
      set('url = ?', url);
      set('feed_url = ?', feedUrl);
      // Websites always run on the PC; a feed starts on Cloudflare again (it moves itself if turned away).
      if (input.fetchVia === undefined) set('fetch_via = ?', kind === 'site' ? 'pc' : 'cloud');
      // Start over like a new source: latest few posts only, checked straight away.
      set('last_ok_at = ?', null);
      set('etag = ?', null);
      set('last_modified = ?', null);
      set('last_error = ?', null);
      set('error_count = ?', 0);
      set('next_check_at = ?', now());
      set('start_count = ?', startCount(input.startWith));
    }
  }
  if (typeof input.paused === 'boolean') {
    // Resuming makes it due straight away.
    if (input.paused) set('paused_at = COALESCE(paused_at, ?)', now());
    else set("paused_at = NULL, next_check_at = CASE WHEN kind = 'newsletter' OR (kind = 'site' AND url IS NULL) THEN NULL ELSE ? END", now());
  }
  if (sets.length > 0) {
    await c.env.DB.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
  }
  // Items parked while this source's AI was off rejoin the queue; the cron parks any still off.
  if (input.aiMode !== undefined) await unparkHeld(c.env, id);
  if (input.showPicture === true) await backfillPictures(c.env, id);
  if (switchedOnSince !== null) {
    // Older items brought in by the backdate join the queue now, for the waiting-time stats.
    await c.env.DB.prepare(
      `UPDATE items SET ai_queued_at = ? WHERE source_id = ? AND ai_status = 'pending' AND MAX(created_at, received_at) >= ?`,
    )
      .bind(now(), id, switchedOnSince)
      .run();
  }
  const row = await c.env.DB.prepare(
    `SELECT sources.*,
       (SELECT COUNT(*) FROM items WHERE items.source_id = sources.id AND items.status IN ('inbox', 'archived')) AS item_count,
       (SELECT MAX(received_at) FROM items WHERE items.source_id = sources.id AND items.status IN ('inbox', 'archived')) AS last_received_at
     FROM sources WHERE id = ?`,
  )
    .bind(id)
    .first<SourceRow & { item_count: number; last_received_at: number | null }>();
  return row ? c.json(toSource(row)) : c.json({ error: 'not found' }, 404);
});

// ---------- Settings ----------

app.get('/api/settings', async (c) => c.json(await loadSettings(c.env)));

/** Settings > Send pages from anywhere: the save address, who may always use it, and the last emails it got. */
app.get('/api/save-address', async (c) => {
  const domain = c.env.MAIL_DOMAIN?.trim();
  const info: SaveAddressInfo = {
    address: domain ? `${SAVE_LOCAL_PART}@${domain}` : null,
    signInEmails: signInEmails(c.env),
    log: await readSaveLog(c.env),
  };
  return c.json(info);
});

app.put('/api/settings', async (c) => {
  const input = (await c.req.json().catch(() => null)) as Partial<AppSettings> | null;
  if (!input) return c.json({ error: 'body required' }, 400);
  const before = await loadSettings(c.env);
  const settings = normalizeSettings(input, before);
  await saveSettings(c.env, settings);
  // A kind switched on here starts with new items only; a source's own page can go further back.
  const switchedOn = (Object.keys(settings.aiByKind) as SummaryKind[]).filter((k) => settings.aiByKind[k] && !before.aiByKind[k]);
  const categoriesChanged = settings.aiOffCategories.join('\n') !== before.aiOffCategories.join('\n');
  if (categoriesChanged || (Object.keys(settings.aiByKind) as SummaryKind[]).some((k) => settings.aiByKind[k] !== before.aiByKind[k])) {
    await unparkHeld(c.env);
  }
  if (switchedOn.length) {
    await c.env.DB.batch(
      switchedOn.map((k) => c.env.DB.prepare("UPDATE sources SET ai_since = ? WHERE kind = ? AND ai_mode = 'default'").bind(now(), k)),
    );
  }
  return c.json(settings);
});

// ---------- Daily digest ----------

/** Stored digests carry their read state in a column so marking one done needs no JSON rewrite. */
function digestFromRow(row: { body: string; read_at: number | null }): Digest {
  return { ...(JSON.parse(row.body) as Digest), readAt: row.read_at };
}

app.get('/api/digests', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 14) || 14, 60);
  const rows = await c.env.DB.prepare('SELECT body, read_at FROM digests ORDER BY day DESC LIMIT ?')
    .bind(limit)
    .all<{ body: string; read_at: number | null }>();
  return c.json(rows.results.map(digestFromRow));
});

app.get('/api/digests/:day', async (c) => {
  const row = await c.env.DB.prepare('SELECT body, read_at FROM digests WHERE day = ?')
    .bind(c.req.param('day'))
    .first<{ body: string; read_at: number | null }>();
  return row ? c.json(digestFromRow(row)) : c.json({ error: 'not found' }, 404);
});

/** Marks a digest done (hidden from the Digest tab); with markRead, its stories are marked read too. */
app.post('/api/digests/:day/done', async (c) => {
  const day = c.req.param('day');
  const row = await c.env.DB.prepare('SELECT body FROM digests WHERE day = ?').bind(day).first<{ body: string }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  const body = (await c.req.json().catch(() => null)) as { markRead?: unknown; device?: unknown } | null;
  const t = now();
  await c.env.DB.prepare('UPDATE digests SET read_at = ? WHERE day = ?').bind(t, day).run();
  let itemsRead = 0;
  if (body?.markRead === true) {
    const digest = JSON.parse(row.body) as Digest;
    const ids = digest.sections.flatMap((s) => s.stories.flatMap((st) => [st.itemId, ...st.more.map((m) => m.itemId)]));
    itemsRead = await markRead(c.env, ids, 'digest', deviceOf(c, body.device), t);
  }
  return c.json({ readAt: t, itemsRead });
});

app.post('/api/digests/:day/undone', async (c) => {
  await c.env.DB.prepare('UPDATE digests SET read_at = NULL WHERE day = ?').bind(c.req.param('day')).run();
  return c.json({ readAt: null });
});

/** Builds (or rebuilds) today's digest now, whatever the scheduled hour says. */
app.post('/api/digests/build', async (c) => {
  const digest = await buildDigestIfDue(c.env, true);
  return c.json(digest ?? { empty: true });
});

/** Rescores the last week of items; the Top sort and the digest read the result. */
app.post('/api/maintenance/rescore', async (c) => c.json({ scored: await scoreRecentItems(c.env) }));

// ---------- Quick summaries for items that arrived before they existed ----------

const BACKFILL_BATCH = 5;

/**
 * Fills in the quick summary for a few older items per call; the web app
 * calls it until nothing remains. Small batches keep each request inside
 * the free plan's CPU budget.
 */
app.post('/api/maintenance/quick-backfill', async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, subject, html_key, text_key FROM items WHERE word_count IS NULL AND status != 'dropped' LIMIT ?",
  )
    .bind(BACKFILL_BATCH)
    .all<{ id: string; subject: string; html_key: string | null; text_key: string | null }>();
  const settings = rows.results.length > 0 ? await loadSettings(c.env) : null;
  for (const row of rows.results) {
    const [html, text] = await Promise.all([
      row.html_key ? c.env.RAW.get(row.html_key).then((o) => o?.text() ?? null) : null,
      row.text_key ? c.env.RAW.get(row.text_key).then((o) => o?.text() ?? null) : null,
    ]);
    const quick = quickSummary(html, text);
    const category = categoryFromRules(settings!.keywordRules, row.subject, quick.preheader);
    await c.env.DB.prepare(
      'UPDATE items SET preheader = ?, word_count = ?, sponsored = ?, category = COALESCE(category, ?) WHERE id = ?',
    )
      .bind(quick.preheader, quick.wordCount, quick.sponsored ? 1 : 0, category, row.id)
      .run();
  }
  const left = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE word_count IS NULL AND status != 'dropped'").first<{
    n: number;
  }>();
  return c.json({ done: rows.results.length, remaining: left?.n ?? 0 });
});

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'not found' }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal error' }, 500);
});
