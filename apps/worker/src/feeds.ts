import {
  COMMON_FEED_PATHS,
  FETCH_HEADERS,
  attr,
  countWords,
  extractLinks,
  findFeedLinks,
  looksBlocked,
  looksScripted,
  pageTitle,
  parseFeed,
  type DiscoverResult,
  type DiscoveredFeed,
  type FeedEntry,
  type FetchJob,
  type FetchJobResult,
  type NewSourceInput,
  type NewSourceResult,
  type OpmlImportResult,
  type ParsedFeed,
} from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { toSource, type SourceRow } from './db';
import type { AppVariables, Env } from './env';
import { htmlToText, snippetOf } from './html';
import { newId, now } from './ids';
import { categoryFromRules, quickSummary } from './quick';
import { loadSettings } from './settings';

// Phase 3: RSS/Atom/JSON feeds and website watches.
//
// Feeds are checked by the Worker on the cron, a few per run with conditional
// requests, so the free plan's subrequest and CPU limits hold. Anything heavier
// goes to the PC helper as a fetch job: website watches (finding new article
// links and pulling each article out of its page), full articles for feeds
// that only carry teasers, feeds that turn Cloudflare away, and the overflow
// when more feeds are due than one run can take.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const MINUTE = 60_000;
const DEFAULT_MINUTES: Record<'feed' | 'site', number> = { feed: 60, site: 180 };
const CLOUD_BUDGET = 10; // feeds the Worker fetches itself per cron run
const FEED_LIMIT = 40; // posts read from the top of each feed
const FIRST_RUN_KEEP = 5; // a new source brings in its latest few posts, not its whole archive
const MAX_NEW_PER_CHECK = 25;
const TEASER_WORDS = 150; // fewer words than this and the full article is fetched (full text "auto")
const BLOCKED_TO_PC = 3; // turned away this many times in a row and the PC takes the feed over
const HELPER_ONLINE_MS = 10 * MINUTE;
const JOB_LEASE_MS = 15 * MINUTE;
const JOB_MAX_ATTEMPTS = 3;
const ARTICLE_WAIT_MS = 12 * 3_600_000; // after this the AI summarises the teaser rather than wait for the PC
const SOURCE_COLUMNS = 'sources.*';

// ---------- Fetching ----------

interface Fetched {
  ok: boolean;
  status: number;
  url: string;
  body: string;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
  blocked: boolean;
  error: string | null;
}

const MAX_BYTES = 8_000_000;

export async function fetchText(url: string, cond?: { etag?: string | null; lastModified?: string | null }): Promise<Fetched> {
  const base: Fetched = { ok: false, status: 0, url, body: '', etag: null, lastModified: null, notModified: false, blocked: false, error: null };
  try {
    const headers: Record<string, string> = { ...FETCH_HEADERS };
    if (cond?.etag) headers['If-None-Match'] = cond.etag;
    if (cond?.lastModified) headers['If-Modified-Since'] = cond.lastModified;
    const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    const out: Fetched = {
      ...base,
      status: res.status,
      url: res.url || url,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
    };
    if (res.status === 304) return { ...out, ok: true, notModified: true };
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) {
      await res.body?.cancel();
      return { ...out, error: 'The page is too big to fetch' };
    }
    out.body = await res.text();
    out.blocked = looksBlocked(res.status, out.body);
    out.ok = res.ok && !out.blocked;
    if (!out.ok) out.error = out.blocked ? `The site turned Cloudflare away (${res.status})` : `The site answered ${res.status}`;
    return out;
  } catch (err) {
    return { ...base, error: err instanceof Error && err.name === 'TimeoutError' ? 'The site took too long to answer' : 'Could not reach the site' };
  }
}

/** "example.com/blog" -> "https://example.com/blog"; null when it isn't a web address. */
export function normalizeUrl(input: string | null | undefined): string | null {
  const raw = input?.trim();
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// ---------- Storing new posts ----------

const interval = (s: Pick<SourceRow, 'kind' | 'check_minutes'>) =>
  (s.check_minutes ?? DEFAULT_MINUTES[s.kind === 'site' ? 'site' : 'feed']) * MINUTE;

async function seenKeys(env: Env, sourceId: string, keys: string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    const rows = await env.DB.prepare(`SELECT key FROM source_seen WHERE source_id = ? AND key IN (${chunk.map(() => '?').join(', ')})`)
      .bind(sourceId, ...chunk)
      .all<{ key: string }>();
    for (const r of rows.results) seen.add(r.key);
  }
  return seen;
}

async function runBatches(env: Env, stmts: D1PreparedStatement[]) {
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

/**
 * Turns posts the source hasn't seen before into inbox items, newest first.
 * On a source's first check only the latest few come in; everything else is
 * just remembered as seen. `alsoSeen` are keys to remember without an item
 * (article links on a watched page that weren't fetched).
 */
export async function storeEntries(env: Env, source: SourceRow, entries: FeedEntry[], alsoSeen: string[] = []): Promise<number> {
  const t = now();
  const unique = new Map<string, FeedEntry>();
  for (const e of entries) if (e.key && !unique.has(e.key)) unique.set(e.key, e);
  const allKeys = [...new Set([...unique.keys(), ...alsoSeen.filter(Boolean).map((k) => k.slice(0, 500))])];
  if (allKeys.length === 0) return 0;
  const seen = await seenKeys(env, source.id, allKeys);
  const fresh = [...unique.values()].filter((e) => !seen.has(e.key));
  // Newest first; posts without a date keep the feed's (or page's) own order.
  fresh.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  const take = fresh.slice(0, source.last_ok_at === null ? FIRST_RUN_KEEP : MAX_NEW_PER_CHECK);

  const settings = take.length ? await loadSettings(env) : null;
  const stmts: D1PreparedStatement[] = [];
  const puts: Promise<unknown>[] = [];
  for (const e of take) {
    const id = newId();
    const html = e.html;
    const text = e.text ?? (html ? htmlToText(html) : null);
    const quick = quickSummary(html, text);
    const needArticle =
      source.kind === 'feed' && e.url !== null && (source.full_text === 'always' || (source.full_text === 'auto' && quick.wordCount < TEASER_WORDS));
    const htmlKey = html ? `items/${id}/body.html` : null;
    if (html) puts.push(env.RAW.put(htmlKey!, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } }));
    stmts.push(
      env.DB.prepare(
        `INSERT INTO items (
           id, source_id, kind, status, subject, from_name, snippet, received_at, message_id, html_key, has_html,
           web_url, created_at, preheader, word_count, category, sponsored, ai_status
         ) VALUES (?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        source.id,
        source.kind,
        e.title.slice(0, 500),
        e.author ?? source.name,
        text ? snippetOf(text) : null,
        Math.min(e.publishedAt ?? t, t),
        e.key,
        htmlKey,
        html ? 1 : 0,
        e.url,
        t,
        quick.preheader,
        quick.wordCount,
        categoryFromRules(settings!.keywordRules, e.title, quick.preheader),
        quick.sponsored ? 1 : 0,
        // Teasers wait for the full article before going to the AI.
        needArticle ? null : 'pending',
      ),
    );
    if (needArticle) {
      stmts.push(
        env.DB.prepare("INSERT INTO fetch_jobs (id, kind, source_id, item_id, url, created_at) VALUES (?, 'article', ?, ?, ?, ?)").bind(
          newId(),
          source.id,
          id,
          e.url,
          t,
        ),
      );
    }
  }
  for (const key of allKeys) {
    if (!seen.has(key)) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO source_seen (source_id, key, at) VALUES (?, ?, ?)').bind(source.id, key, t));
  }
  await Promise.all(puts);
  await runBatches(env, stmts);
  return take.length;
}

// ---------- Checking one source ----------

async function recordOk(env: Env, source: SourceRow, f: { etag?: string | null; lastModified?: string | null }) {
  const t = now();
  await env.DB.prepare(
    `UPDATE sources SET last_checked_at = ?1, last_ok_at = ?1, next_check_at = ?2, last_error = NULL, error_count = 0,
       etag = COALESCE(?3, etag), last_modified = COALESCE(?4, last_modified) WHERE id = ?5`,
  )
    .bind(t, t + interval(source), f.etag ?? null, f.lastModified ?? null, source.id)
    .run();
}

async function recordFailure(env: Env, source: SourceRow, error: string, blocked: boolean) {
  const t = now();
  const errors = source.error_count + 1;
  if (blocked && source.fetch_via === 'cloud' && errors >= BLOCKED_TO_PC) {
    await env.DB.prepare(
      "UPDATE sources SET fetch_via = 'pc', last_checked_at = ?, next_check_at = ?, last_error = ?, error_count = 0 WHERE id = ?",
    )
      .bind(t, t, 'The site keeps turning Cloudflare away, so your PC fetches it now', source.id)
      .run();
    return;
  }
  // Back off: the usual interval, doubling with each failure up to eight times.
  const wait = interval(source) * Math.min(2 ** (errors - 1), 8);
  await env.DB.prepare('UPDATE sources SET last_checked_at = ?, next_check_at = ?, last_error = ?, error_count = ? WHERE id = ?')
    .bind(t, t + wait, error.slice(0, 300), errors, source.id)
    .run();
}

/** Fetches and stores one feed from Cloudflare. Returns how many posts came in. */
export async function checkCloudFeed(env: Env, source: SourceRow): Promise<number> {
  const url = source.feed_url ?? source.url;
  if (!url) return 0;
  const f = await fetchText(url, source.last_ok_at ? { etag: source.etag, lastModified: source.last_modified } : undefined);
  if (!f.ok) {
    await recordFailure(env, source, f.error ?? 'Fetch failed', f.blocked);
    return 0;
  }
  if (f.notModified) {
    await recordOk(env, source, f);
    return 0;
  }
  const feed = parseFeed(f.body, f.url, FEED_LIMIT);
  if (!feed) {
    await recordFailure(env, source, 'The address no longer returns a feed', false);
    return 0;
  }
  const added = await storeEntries(env, source, feed.entries);
  await recordOk(env, source, f);
  return added;
}

/** Puts a feed or page check in the PC's queue, unless one is already waiting. */
async function queueSourceForPc(env: Env, source: SourceRow) {
  const kind = source.kind === 'site' ? 'page' : 'feed';
  const url = kind === 'page' ? source.url : (source.feed_url ?? source.url);
  if (!url) return;
  const t = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO fetch_jobs (id, kind, source_id, url, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (
         SELECT 1 FROM fetch_jobs WHERE source_id = ?3 AND kind = ?2 AND status IN ('pending', 'working'))`,
    ).bind(newId(), kind, source.id, url, t),
    // Not due again until the PC has had its chance; its result sets the real next check.
    env.DB.prepare('UPDATE sources SET next_check_at = ? WHERE id = ?').bind(t + interval(source), source.id),
  ]);
}

async function helperOnline(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'helper'").first<{ value: string }>();
  if (!row) return false;
  try {
    return now() - Number((JSON.parse(row.value) as { lastSeenAt?: number }).lastSeenAt ?? 0) < HELPER_ONLINE_MS;
  } catch {
    return false;
  }
}

/**
 * The cron's part: checks the feeds that are due. Cloudflare takes up to
 * `budget` of them; website watches, PC-only feeds and the overflow go to the
 * PC's queue (the overflow only while the helper is online, otherwise it
 * waits for the next run).
 */
export async function runFeedChecks(env: Env, budget = CLOUD_BUDGET): Promise<{ cloud: number; queued: number; added: number }> {
  const t = now();
  const due = await env.DB.prepare(
    `SELECT ${SOURCE_COLUMNS} FROM sources
     WHERE kind IN ('feed', 'site') AND paused_at IS NULL AND next_check_at IS NOT NULL AND next_check_at <= ?
     ORDER BY next_check_at LIMIT 60`,
  )
    .bind(t)
    .all<SourceRow>();
  const online = due.results.length > budget || due.results.some((s) => s.kind === 'site' || s.fetch_via === 'pc') ? await helperOnline(env) : false;
  const forCloud: SourceRow[] = [];
  let queued = 0;
  for (const s of due.results) {
    const pcOnly = s.kind === 'site' || s.fetch_via === 'pc';
    if (!pcOnly && forCloud.length < budget) forCloud.push(s);
    else if (pcOnly || online) {
      await queueSourceForPc(env, s);
      queued += 1;
    }
  }
  let added = 0;
  // A few at a time: waiting on the network costs no CPU, but each fetch is a subrequest.
  for (let i = 0; i < forCloud.length; i += 4) {
    const results = await Promise.allSettled(forCloud.slice(i, i + 4).map((s) => checkCloudFeed(env, s)));
    for (const r of results) {
      if (r.status === 'fulfilled') added += r.value;
      else console.error('feed check failed', r.reason);
    }
  }

  // Teasers whose full article never came (PC off for hours) go to the AI as they are.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE items SET ai_status = 'pending' WHERE ai_status IS NULL AND status = 'inbox' AND id IN (
         SELECT item_id FROM fetch_jobs WHERE kind = 'article' AND status = 'pending' AND created_at < ?)`,
    ).bind(t - ARTICLE_WAIT_MS),
    env.DB.prepare("DELETE FROM fetch_jobs WHERE kind = 'article' AND status = 'pending' AND created_at < ?").bind(t - ARTICLE_WAIT_MS),
    env.DB.prepare("DELETE FROM fetch_jobs WHERE status = 'failed' AND created_at < ?").bind(t - 7 * 86_400_000),
  ]);
  return { cloud: forCloud.length, queued, added };
}

/** Jobs the helper should pick up, for its heartbeat. */
export async function fetchJobsWaiting(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM fetch_jobs WHERE status = 'pending' OR (status = 'working' AND claimed_at < ?)",
  )
    .bind(now() - JOB_LEASE_MS)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------- Discovering a feed from a pasted address ----------

function toDiscovered(feedUrl: string, feed: ParsedFeed): DiscoveredFeed {
  const firstFive = feed.entries.slice(0, 5);
  const teasers = firstFive.filter((e) => countWords(e.html ? htmlToText(e.html) : '') < TEASER_WORDS).length;
  return {
    feedUrl,
    title: feed.title,
    siteUrl: feed.siteUrl,
    format: feed.format,
    sample: feed.entries.slice(0, 3).map((e) => ({ title: e.title, url: e.url, publishedAt: e.publishedAt })),
    teasers: firstFive.length > 0 && teasers * 2 > firstFive.length,
  };
}

async function tryFeed(url: string): Promise<DiscoveredFeed | null> {
  const f = await fetchText(url);
  if (!f.ok) return null;
  const feed = parseFeed(f.body, f.url, 10);
  return feed && feed.entries.length > 0 ? toDiscovered(f.url, feed) : null;
}

export async function discover(env: Env, input: string): Promise<DiscoverResult> {
  const url = normalizeUrl(input);
  const empty: DiscoverResult = { url: input, title: null, feeds: [], page: null, error: null, existingSourceId: null };
  if (!url) return { ...empty, error: "That doesn't look like a web address" };
  const f = await fetchText(url);
  const result: DiscoverResult = { ...empty, url: f.url || url };

  if (!f.ok) {
    // Cloudflare can't see the page, but the PC might.
    result.error = f.error;
    result.page = { url, title: null, sample: [], blocked: true, scripted: false };
  } else {
    const asFeed = parseFeed(f.body, f.url, 10);
    if (asFeed) {
      result.title = asFeed.title;
      result.feeds.push(toDiscovered(f.url, asFeed));
    } else {
      result.title = pageTitle(f.body);
      for (const link of findFeedLinks(f.body, f.url).slice(0, 3)) {
        const found = await tryFeed(link);
        if (found && !result.feeds.some((x) => x.feedUrl === found.feedUrl)) result.feeds.push(found);
      }
      if (result.feeds.length === 0) {
        for (const path of COMMON_FEED_PATHS) {
          const found = await tryFeed(new URL(path, f.url).toString());
          if (found) {
            result.feeds.push(found);
            break;
          }
        }
      }
      result.page = {
        url: f.url,
        title: result.title,
        sample: extractLinks(f.body, f.url).slice(0, 5),
        blocked: false,
        scripted: looksScripted(f.body),
      };
    }
  }

  const candidates = [...result.feeds.map((x) => x.feedUrl), url, result.url];
  const existing = await env.DB.prepare(
    `SELECT id FROM sources WHERE kind IN ('feed', 'site') AND (feed_url IN (${candidates.map(() => '?').join(', ')}) OR url IN (${candidates.map(() => '?').join(', ')})) LIMIT 1`,
  )
    .bind(...candidates, ...candidates)
    .first<{ id: string }>();
  result.existingSourceId = existing?.id ?? null;
  return result;
}

// ---------- Feedly (OPML) import ----------

interface OpmlFeed {
  feedUrl: string;
  siteUrl: string | null;
  title: string;
  folder: string | null;
}

export function parseOpml(opml: string): OpmlFeed[] {
  const out: OpmlFeed[] = [];
  const folders: (string | null)[] = [];
  const re = /<outline\b[^>]*?(\/?)>|<\/outline>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(opml)) !== null) {
    const tag = m[0];
    if (tag.startsWith('</')) {
      folders.pop();
      continue;
    }
    const selfClosing = m[1] === '/';
    const feedUrl = normalizeUrl(attr(tag, 'xmlUrl'));
    const title = attr(tag, 'title') || attr(tag, 'text') || '';
    if (feedUrl) {
      const folder = [...folders].reverse().find((x) => x) ?? null;
      out.push({ feedUrl, siteUrl: normalizeUrl(attr(tag, 'htmlUrl')), title: title || new URL(feedUrl).hostname, folder });
    }
    if (!selfClosing) folders.push(feedUrl ? null : title || null);
  }
  return out;
}

async function importOpml(env: Env, opml: string): Promise<OpmlImportResult> {
  const feeds = parseOpml(opml).slice(0, 1000);
  const existing = await env.DB.prepare('SELECT feed_url FROM sources WHERE feed_url IS NOT NULL').all<{ feed_url: string }>();
  const have = new Set(existing.results.map((r) => r.feed_url));
  const settings = await loadSettings(env);
  const categories = new Map(settings.categories.map((c) => [c.toLowerCase(), c]));
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  let skipped = 0;
  for (const f of feeds) {
    if (have.has(f.feedUrl)) {
      skipped += 1;
      continue;
    }
    have.add(f.feedUrl);
    // Spread the first checks out (one every 20 seconds) so no single cron run gets them all.
    stmts.push(
      env.DB.prepare(
        `INSERT INTO sources (id, kind, name, url, feed_url, folder, category, created_at, next_check_at)
         VALUES (?, 'feed', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        newId(),
        f.title.slice(0, 200),
        f.siteUrl,
        f.feedUrl,
        f.folder?.slice(0, 100) ?? null,
        (f.folder && categories.get(f.folder.toLowerCase())) ?? null,
        t,
        t + stmts.length * 20_000,
      ),
    );
  }
  await runBatches(env, stmts);
  return { added: stmts.length, skipped, total: feeds.length };
}

// ---------- Routes ----------

async function loadSourceRow(env: Env, id: string): Promise<SourceRow | null> {
  return env.DB.prepare(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE id = ?`).bind(id).first<SourceRow>();
}

async function sourceView(env: Env, id: string) {
  const row = await env.DB.prepare(
    `SELECT sources.*,
       (SELECT COUNT(*) FROM items WHERE items.source_id = sources.id AND items.status IN ('inbox', 'archived')) AS item_count,
       (SELECT MAX(received_at) FROM items WHERE items.source_id = sources.id AND items.status IN ('inbox', 'archived')) AS last_received_at
     FROM sources WHERE id = ?`,
  )
    .bind(id)
    .first<SourceRow & { item_count: number; last_received_at: number | null }>();
  return row ? toSource(row) : null;
}

/** Checks a source now: Cloudflare fetches a cloud feed in place, anything else is queued for the PC. */
async function checkNow(env: Env, source: SourceRow): Promise<{ added: number; waitingForPc: boolean }> {
  if (source.kind === 'feed' && source.fetch_via === 'cloud') return { added: await checkCloudFeed(env, source), waitingForPc: false };
  await queueSourceForPc(env, source);
  return { added: 0, waitingForPc: true };
}

export function registerFeeds(app: App) {
  app.post('/api/sources/discover', async (c) => {
    const input = (await c.req.json().catch(() => null)) as { url?: string } | null;
    if (!input?.url) return c.json({ error: 'url required' }, 400);
    return c.json(await discover(c.env, input.url));
  });

  app.post('/api/sources/opml', async (c) => {
    const input = (await c.req.json().catch(() => null)) as { opml?: string } | null;
    if (!input?.opml || !/<opml[\s>]/i.test(input.opml)) return c.json({ error: "That file isn't an OPML export" }, 400);
    return c.json(await importOpml(c.env, input.opml));
  });

  /** Follows a feed, or watches a website that has none. */
  app.post('/api/sources', async (c) => {
    const input = (await c.req.json().catch(() => null)) as NewSourceInput | null;
    if (!input || (input.kind !== 'feed' && input.kind !== 'site')) return c.json({ error: 'kind must be feed or site' }, 400);
    const url = normalizeUrl(input.url);
    const feedUrl = input.kind === 'feed' ? normalizeUrl(input.feedUrl ?? input.url) : null;
    if (!url || (input.kind === 'feed' && !feedUrl)) return c.json({ error: 'A web address is required' }, 400);
    const dup = await c.env.DB.prepare(
      input.kind === 'feed' ? "SELECT id FROM sources WHERE kind = 'feed' AND feed_url = ?" : "SELECT id FROM sources WHERE kind = 'site' AND url = ?",
    )
      .bind(input.kind === 'feed' ? feedUrl : url)
      .first<{ id: string }>();
    if (dup) return c.json({ error: 'You already follow this', sourceId: dup.id }, 409);

    const id = newId();
    const t = now();
    const name = input.name?.trim().slice(0, 200) || new URL(url).hostname.replace(/^www\./, '');
    // Website watches always run on the PC: finding and extracting articles is too heavy for the free plan.
    const fetchVia = input.kind === 'site' || input.fetchVia === 'pc' ? 'pc' : 'cloud';
    await c.env.DB.prepare(
      `INSERT INTO sources (id, kind, name, url, feed_url, fetch_via, render, link_hint, category, created_at, next_check_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        input.kind,
        name,
        url,
        feedUrl,
        fetchVia,
        input.render ? 1 : 0,
        input.linkHint?.trim().slice(0, 200) || null,
        input.category?.trim().slice(0, 40) || null,
        t,
        t,
      )
      .run();
    const row = (await loadSourceRow(c.env, id))!;
    const result = await checkNow(c.env, row);
    const body: NewSourceResult = { source: (await sourceView(c.env, id))!, ...result };
    return c.json(body, 201);
  });

  app.post('/api/sources/:id/check', async (c) => {
    const row = await loadSourceRow(c.env, c.req.param('id'));
    if (!row || (row.kind !== 'feed' && row.kind !== 'site')) return c.json({ error: 'not found' }, 404);
    const result = await checkNow(c.env, row);
    return c.json({ ...result, source: await sourceView(c.env, row.id) });
  });

  // ----- Helper side -----

  app.post('/api/helper/fetch/claim', async (c) => {
    const input = (await c.req.json().catch(() => ({}))) as { max?: number };
    const max = Math.min(Math.max(Number(input.max) || 5, 1), 10);
    const t = now();
    const stale = t - JOB_LEASE_MS;
    // Jobs whose lease ran out too often are set aside; their items go to the AI as they are.
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE items SET ai_status = 'pending' WHERE ai_status IS NULL AND id IN (
           SELECT item_id FROM fetch_jobs WHERE status = 'working' AND claimed_at < ? AND attempts >= ?)`,
      ).bind(stale, JOB_MAX_ATTEMPTS),
      c.env.DB.prepare(
        "UPDATE fetch_jobs SET status = 'failed', error = COALESCE(error, 'Timed out on the PC') WHERE status = 'working' AND claimed_at < ? AND attempts >= ?",
      ).bind(stale, JOB_MAX_ATTEMPTS),
    ]);
    const claimed = await c.env.DB.prepare(
      `UPDATE fetch_jobs SET status = 'working', claimed_at = ?1, attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM fetch_jobs WHERE status = 'pending' OR (status = 'working' AND claimed_at < ?2)
         ORDER BY kind = 'article', created_at LIMIT ?3
       )
       RETURNING id, kind, source_id, item_id, url`,
    )
      .bind(t, stale, max)
      .all<{ id: string; kind: FetchJob['kind']; source_id: string | null; item_id: string | null; url: string }>();

    const jobs: FetchJob[] = [];
    for (const j of claimed.results) {
      const s = j.source_id ? await loadSourceRow(c.env, j.source_id) : null;
      const known =
        j.kind === 'page' && s
          ? await c.env.DB.prepare('SELECT key FROM source_seen WHERE source_id = ? ORDER BY at DESC LIMIT 500').bind(s.id).all<{ key: string }>()
          : { results: [] as { key: string }[] };
      jobs.push({
        id: j.id,
        kind: j.kind,
        url: j.url,
        sourceId: j.source_id,
        itemId: j.item_id,
        render: s?.render === 1,
        linkHint: s?.link_hint ?? null,
        etag: j.kind === 'feed' && s?.last_ok_at ? s.etag : null,
        lastModified: j.kind === 'feed' && s?.last_ok_at ? s.last_modified : null,
        knownKeys: known.results.map((r) => r.key),
        firstRun: s ? s.last_ok_at === null : false,
      });
    }
    return c.json({ jobs });
  });

  app.post('/api/helper/fetch/result', async (c) => {
    const r = (await c.req.json().catch(() => null)) as FetchJobResult | null;
    if (!r?.jobId) return c.json({ error: 'bad result' }, 400);
    const job = await c.env.DB.prepare('SELECT * FROM fetch_jobs WHERE id = ?').bind(r.jobId).first<{
      id: string;
      kind: FetchJob['kind'];
      source_id: string | null;
      item_id: string | null;
      attempts: number;
    }>();
    if (!job) return c.json({ error: 'not found' }, 404);
    const source = job.source_id ? await loadSourceRow(c.env, job.source_id) : null;
    const error = String(r.error || 'Fetch failed on the PC').slice(0, 300);

    if (job.kind === 'article') {
      const a = r.ok ? r.article : undefined;
      const item = job.item_id
        ? await c.env.DB.prepare('SELECT id, word_count FROM items WHERE id = ?').bind(job.item_id).first<{ id: string; word_count: number | null }>()
        : null;
      if (item && a && a.html && a.wordCount > Math.max(item.word_count ?? 0, 50)) {
        const quick = quickSummary(a.html, a.text);
        const key = `items/${item.id}/body.html`;
        await c.env.RAW.put(key, a.html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
        await c.env.DB.prepare(
          `UPDATE items SET html_key = ?, has_html = 1, word_count = ?, snippet = ?, preheader = COALESCE(preheader, ?), sponsored = ?,
             ai_status = COALESCE(ai_status, 'pending') WHERE id = ?`,
        )
          .bind(key, quick.wordCount, snippetOf(a.text), quick.preheader, quick.sponsored ? 1 : 0, item.id)
          .run();
      } else if (!r.ok && job.attempts < JOB_MAX_ATTEMPTS && !r.blocked) {
        await c.env.DB.prepare("UPDATE fetch_jobs SET status = 'pending', claimed_at = NULL, error = ? WHERE id = ?").bind(error, job.id).run();
        return c.json({ ok: true, retry: true });
      } else if (item) {
        // No better copy to be had: summarise what the feed gave.
        await c.env.DB.prepare("UPDATE items SET ai_status = 'pending' WHERE id = ? AND ai_status IS NULL").bind(item.id).run();
      }
      await c.env.DB.prepare('DELETE FROM fetch_jobs WHERE id = ?').bind(job.id).run();
      return c.json({ ok: true });
    }

    let added = 0;
    if (source) {
      if (!r.ok) await recordFailure(c.env, source, error, Boolean(r.blocked));
      else {
        if (!r.notModified) added = await storeEntries(c.env, source, (r.entries ?? []).slice(0, 60), (r.seenKeys ?? []).slice(0, 500));
        await recordOk(c.env, source, { etag: r.etag, lastModified: r.lastModified });
      }
    }
    await c.env.DB.prepare('DELETE FROM fetch_jobs WHERE id = ?').bind(job.id).run();
    return c.json({ ok: true, added });
  });
}
