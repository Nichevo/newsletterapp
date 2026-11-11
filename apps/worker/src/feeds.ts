import {
  COMMON_FEED_PATHS,
  FETCH_HEADERS,
  attr,
  canonicalUrl,
  countWords,
  extractArticle,
  extractLinks,
  findFeedLinks,
  looksBlocked,
  looksBotCheck,
  looksScripted,
  pageTitle,
  parseFeed,
  type DiscoverResult,
  type DiscoveredFeed,
  type FeedEntry,
  type FetchJob,
  type FetchJobResult,
  type FetchPageStatus,
  type NewSourceInput,
  type NewSourceResult,
  type OpmlImportResult,
  type ParsedFeed,
  type Picture,
  type SavePageInput,
  type SavePageResult,
  type Article,
  type ArticleImage,
  type FileKind,
  KEEP_FILE_MAX_BYTES,
  fileKind,
  fileNameFromUrl,
  fileNoteHtml,
  fileTypeLabel,
  kindFromType,
  textFileHtml,
  titleFromFileName,
  DEFAULT_DAILY_CAP,
  normalizePostFilter,
  passesPostFilter,
  isRedditPost,
  isVideoPost,
  platformOf,
} from '@newsletterapp/shared';
import { Buffer } from 'node:buffer';
import type { Hono } from 'hono';
import { isSavedPages, sourcePostFilter, toSource, type SourceRow } from './db';
import type { AppVariables, Env } from './env';
import { htmlToText, junkImage, leadImage, snippetOf } from './html';
import { newId, now } from './ids';
import { categoryFromRules, quickSummary } from './quick';
import { loadSettings } from './settings';
import { nextCheckAt, refreshRhythm, rhythmStale } from './rhythm';

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

async function idsOf(stmt: D1PreparedStatement): Promise<string[]> {
  return (await stmt.all<{ item_id: string }>()).results.map((r) => r.item_id);
}

/** Sends these items to the AI as they are, looked up by id (a few at a time, never a scan). */
function pendingAgain(env: Env, ids: string[], extra: string): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    out.push(
      env.DB.prepare(`UPDATE items SET ai_status = 'pending' WHERE id IN (${part.map(() => '?').join(', ')}) AND ai_status IS NULL ${extra}`).bind(...part),
    );
  }
  return out;
}
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

/**
 * Keeps the PC's download of a post's picture in R2 and returns the address the
 * app serves it from; without a download, the picture's own address.
 */
function keepPicture(env: Env, itemId: string, p: Picture, puts: Promise<unknown>[]): { src: string; title: string | null; alt: string | null } {
  if (!p.data) return { src: p.src, title: p.title, alt: p.alt ?? null };
  puts.push(env.RAW.put(`items/${itemId}/picture`, Buffer.from(p.data, 'base64'), { httpMetadata: { contentType: p.type || 'image/jpeg' } }));
  return { src: `/api/items/${itemId}/picture`, title: p.title, alt: p.alt ?? null };
}

/** Stores the pictures that came with an article and points its html at them (pdf-image:N -> /api/items/<id>/images/N). */
async function keepArticleImages(env: Env, itemId: string, html: string, images: ArticleImage[]): Promise<string> {
  let out = html;
  const puts: Promise<unknown>[] = [];
  for (const [n, img] of images.slice(0, 60).entries()) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(img.type) || !img.data) continue;
    puts.push(env.RAW.put(`items/${itemId}/images/${n}`, Buffer.from(img.data, 'base64'), { httpMetadata: { contentType: img.type } }));
    out = out.split(`"${img.name}"`).join(`"/api/items/${itemId}/images/${n}"`);
  }
  await Promise.all(puts);
  // Any left unmatched would show as broken pictures.
  return out.replace(/<p><img src="pdf-image:\d+"[^>]*><\/p>/g, '');
}

/** The saved page shows the kept copy too, so the reader's picture doesn't break when the site's link expires. */
function swapPictureSrc(html: string, from: string, to: string): string {
  if (from === to) return html;
  return html.split(from).join(to).split(from.replace(/&/g, '&amp;')).join(to);
}

async function runBatches(env: Env, stmts: D1PreparedStatement[]) {
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Several new posts as one entry: titled after the newest ("… + 3 more"), each
 * post a section with its own heading and link, newest first.
 */
function bundleEntries(source: SourceRow, entries: FeedEntry[]): FeedEntry {
  const [first] = entries as [FeedEntry, ...FeedEntry[]];
  const html = entries
    .map((e) => {
      const heading = e.url ? `<a href="${escapeHtml(e.url)}">${escapeHtml(e.title)}</a>` : escapeHtml(e.title);
      return `<section><h2>${heading}</h2>${e.html ?? ''}</section>`;
    })
    .join('<hr>');
  const text = entries.map((e) => [e.title, e.text ?? (e.html ? htmlToText(e.html) : '')].filter(Boolean).join('\n\n')).join('\n\n');
  const dates = entries.map((e) => e.publishedAt).filter((d): d is number => d !== null);
  return {
    key: `bundle:${first.key}`.slice(0, 500),
    url: source.url ?? first.url,
    title: `${first.title} + ${entries.length - 1} more`,
    author: source.name,
    publishedAt: dates.length ? Math.max(...dates) : null,
    html,
    text,
    image: entries.find((e) => e.image)?.image ?? null,
    picture: entries.find((e) => e.picture)?.picture ?? null,
  };
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
  // Posts younger than the source's wait aren't taken (or remembered) yet; a later check brings them in.
  const waitUntil = (source.wait_hours ?? 0) > 0 ? t - source.wait_hours! * 3_600_000 : null;
  for (const e of entries) {
    if (!e.key || unique.has(e.key)) continue;
    if (waitUntil !== null && e.publishedAt !== null && e.publishedAt > waitUntil) continue;
    unique.set(e.key, e);
  }
  const allKeys = [...new Set([...unique.keys(), ...alsoSeen.filter(Boolean).map((k) => k.slice(0, 500))])];
  if (allKeys.length === 0) return 0;
  const seen = await seenKeys(env, source.id, allKeys);
  // Posts the source's filter leaves out are only remembered as seen.
  const filter = sourcePostFilter(source);
  const fresh = [...unique.values()].filter((e) => !seen.has(e.key) && passesPostFilter(e.title, filter, e.url));
  // Newest first; posts without a date keep the feed's (or page's) own order.
  fresh.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  let take = fresh.slice(0, source.last_ok_at === null ? (source.start_count ?? FIRST_RUN_KEEP) : MAX_NEW_PER_CHECK);
  // Sources that post in bursts can bring each check's new posts in as one item.
  const bundled = source.bundle === 1 && take.length > 1;
  if (bundled) take = [bundleEntries(source, take)];

  // Flood guard: past the source's daily limit, new posts go straight to Archived (still searchable).
  // 0 = no limit for this source.
  const cap = source.daily_cap ?? DEFAULT_DAILY_CAP;
  const today = take.length && cap > 0
    ? ((
        await env.DB.prepare('SELECT COUNT(*) AS n FROM items INDEXED BY items_source WHERE source_id = ? AND created_at >= ?')
          .bind(source.id, t - 86_400_000)
          .first<{ n: number }>()
      )?.n ?? 0)
    : 0;
  const room = cap > 0 ? Math.max(cap - today, 0) : take.length;
  const setAside = Math.max(take.length - room, 0);

  const settings = take.length ? await loadSettings(env) : null;
  const stmts: D1PreparedStatement[] = [];
  const puts: Promise<unknown>[] = [];
  for (const [index, e] of take.entries()) {
    // Past the limit with "bin them" chosen: only remembered as seen, so they never come back.
    if (index >= room && source.flood_skip === 1) continue;
    const id = newId();
    // Newest first, so the newest posts get the room left today.
    const status = index < room ? 'inbox' : 'archived';
    let html = e.html;
    const text = e.text ?? (html ? htmlToText(html) : null);
    const quick = quickSummary(html, text);
    const picture = e.picture
      ? keepPicture(env, id, e.picture, puts)
      : html || e.image
        ? leadImage(html ?? '', e.url ?? source.url, e.image)
        : null;
    if (html && e.picture && picture) html = swapPictureSrc(html, e.picture.src, picture.src);
    // Aggregators (Techmeme): the PC fetches the outside article the post links to.
    const outside = source.follow_link === 1 && html ? outsideLink(html, [e.url, source.url, source.feed_url]) : null;
    const articleUrl = outside ?? e.url;
    // Reddit posts always go to the PC, which brings in the post and its top comments.
    const needArticle =
      !bundled &&
      status === 'inbox' &&
      source.kind === 'feed' &&
      articleUrl !== null &&
      !isVideoPost(articleUrl) &&
      (outside !== null ||
        source.full_text === 'always' ||
        (source.full_text === 'auto' && (quick.wordCount < TEASER_WORDS || isRedditPost(e.url))));
    const htmlKey = html ? `items/${id}/body.html` : null;
    if (html) puts.push(env.RAW.put(htmlKey!, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } }));
    stmts.push(
      env.DB.prepare(
        `INSERT INTO items (
           id, source_id, kind, status, subject, from_name, snippet, received_at, message_id, html_key, has_html,
           web_url, created_at, preheader, word_count, category, sponsored, ai_status, lead_image, lead_image_title, lead_image_alt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        source.id,
        source.kind,
        status,
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
        picture?.src ?? null,
        picture?.title ?? null,
        picture?.alt ?? null,
      ),
    );
    if (needArticle) {
      stmts.push(
        env.DB.prepare("INSERT INTO fetch_jobs (id, kind, source_id, item_id, url, created_at) VALUES (?, 'article', ?, ?, ?, ?)").bind(
          newId(),
          source.id,
          id,
          articleUrl,
          t,
        ),
      );
    }
  }
  for (const key of allKeys) {
    if (!seen.has(key)) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO source_seen (source_id, key, at) VALUES (?, ?, ?)').bind(source.id, key, t));
  }
  if (setAside > 0) {
    // One running count per day, shown on the source page.
    stmts.push(
      env.DB.prepare(
        'UPDATE sources SET flood_count = CASE WHEN flood_at >= ? THEN flood_count + ? ELSE ? END, flood_at = ? WHERE id = ?',
      ).bind(t - 86_400_000, setAside, setAside, t, source.id),
    );
  }
  await Promise.all(puts);
  await runBatches(env, stmts);
  return take.length;
}

// ---------- Checking one source ----------

async function recordOk(env: Env, source: SourceRow, f: { etag?: string | null; lastModified?: string | null }, added = 0) {
  const t = now();
  let rhythm = source.rhythm;
  // Feeds re-learn when they post (and weekly otherwise): one small indexed read.
  if (source.kind === 'feed' && (added > 0 || rhythmStale(rhythm, t))) {
    const { timezone } = await loadSettings(env);
    rhythm = JSON.stringify(await refreshRhythm(env, source.id, timezone, t));
  }
  await env.DB.prepare(
    `UPDATE sources SET last_checked_at = ?1, last_ok_at = ?1, next_check_at = ?2, last_error = NULL, error_count = 0,
       etag = COALESCE(?3, etag), last_modified = COALESCE(?4, last_modified) WHERE id = ?5`,
  )
    .bind(t, nextCheckAt({ ...source, rhythm }, t, interval(source)), f.etag ?? null, f.lastModified ?? null, source.id)
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
  await recordOk(env, source, f, added);
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

export async function helperOnline(env: Env): Promise<boolean> {
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
  // Ids first (a small read of fetch_jobs): an UPDATE with a subquery can walk the whole inbox.
  const gaveUp = await idsOf(
    env.DB.prepare("SELECT item_id FROM fetch_jobs WHERE kind = 'article' AND status = 'pending' AND created_at < ? AND item_id IS NOT NULL").bind(
      t - ARTICLE_WAIT_MS,
    ),
  );
  await env.DB.batch([
    ...pendingAgain(env, gaveUp, "AND status = 'inbox'"),
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
    perDay: postsPerDay(feed.entries),
  };
}

/** Roughly how many posts a day, from the dates of the feed's posts (needs 3+ dated posts). */
function postsPerDay(entries: FeedEntry[]): number | null {
  const dates = entries
    .map((e) => e.publishedAt)
    .filter((d): d is number => d !== null)
    .slice(0, 50);
  if (dates.length < 3) return null;
  const days = (Math.max(...dates) - Math.min(...dates)) / 86_400_000;
  // A burst all at once (or no real dates) reads as "a lot".
  return days > 0 ? Math.round(((dates.length - 1) / days) * 10) / 10 : dates.length;
}

/** Sites that are discussion, not the story itself. */
const NOT_THE_STORY = /(^|\.)(twitter\.com|x\.com|bsky\.app|threads\.net|facebook\.com|linkedin\.com|reddit\.com|news\.ycombinator\.com|mastodon\.\w+)$/i;

/** The first link in a post that leads off the aggregator to the story itself. */
export function outsideLink(html: string, own: (string | null)[]): string | null {
  const hostOf = (u: string | null) => {
    try {
      return u ? new URL(u).hostname.replace(/^www\./, '').toLowerCase() : null;
    } catch {
      return null;
    }
  };
  const ownHosts = new Set(own.map(hostOf).filter((h): h is string => h !== null));
  const re = /<a\b[^>]*\bhref\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const url = m[1]!.replace(/&amp;/g, '&');
    const host = hostOf(url);
    if (!host || ownHosts.has(host) || [...ownHosts].some((h) => host.endsWith(`.${h}`)) || NOT_THE_STORY.test(host)) continue;
    return url;
  }
  return null;
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
      // A YouTube channel page: its feed is keyed by the channel id.
      const yt = /(^|\.)youtube\.com$/i.test(new URL(f.url).hostname)
        ? (/youtube\.com\/channel\/(UC[\w-]{22})/.exec(f.body) ?? /"(?:externalId|channelId)":"(UC[\w-]{22})"/.exec(f.body))?.[1]
        : undefined;
      if (yt) {
        const found = await tryFeed(`https://www.youtube.com/feeds/videos.xml?channel_id=${yt}`);
        if (found) result.feeds.push(found);
      }
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

/** How many latest posts a new source brings in: 0 to 50, the default when not given. */
export function startCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 0), 50) : null;
}

async function importOpml(env: Env, opml: string, startWith: number | null): Promise<OpmlImportResult> {
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
        `INSERT INTO sources (id, kind, name, url, feed_url, folder, category, created_at, next_check_at, start_count)
         VALUES (?, 'feed', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        newId(),
        f.title.slice(0, 200),
        f.siteUrl,
        f.feedUrl,
        f.folder?.slice(0, 100) ?? null,
        (f.folder && categories.get(f.folder.toLowerCase())) ?? null,
        t,
        t + stmts.length * 20_000,
        startWith,
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

// ---------- Single pages ----------

const SAVED_PAGES_NAME = 'Saved pages';
const GOOD_COPY_WORDS = 50; // fewer words than this from Cloudflare and the PC fetches the page instead

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The source single pages are kept under; made the first time a page is added. */
async function savedPagesSource(env: Env): Promise<SourceRow> {
  const sql = `SELECT ${SOURCE_COLUMNS} FROM sources WHERE kind = 'site' AND url IS NULL ORDER BY created_at LIMIT 1`;
  const row = await env.DB.prepare(sql).first<SourceRow>();
  if (row) return row;
  // Never checked (no next check, no page to watch); no daily limit, since every page is one you chose.
  await env.DB.prepare("INSERT INTO sources (id, kind, name, fetch_via, created_at, daily_cap) VALUES (?, 'site', ?, 'pc', ?, 0)")
    .bind(newId(), SAVED_PAGES_NAME, now())
    .run();
  return (await env.DB.prepare(sql).first<SourceRow>())!;
}

interface FetchedLink extends Fetched {
  /** What the link turned out to be: a web page, plain text, a PDF, a picture or some other file. */
  fileKind: FileKind;
  contentType: string | null;
  /** The file itself, for PDFs and pictures small enough to keep. */
  bytes: Uint8Array | null;
}

/**
 * Fetches a link that may be a file rather than a page. Pages and text come
 * back as text, as fetchText does; anything else is never decoded as text
 * (that turned a PDF into a screenful of junk characters).
 */
async function fetchLink(url: string): Promise<FetchedLink> {
  const base: FetchedLink = {
    ok: false,
    status: 0,
    url,
    body: '',
    etag: null,
    lastModified: null,
    notModified: false,
    blocked: false,
    error: null,
    fileKind: 'page',
    contentType: null,
    bytes: null,
  };
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    const out: FetchedLink = { ...base, status: res.status, url: res.url || url, contentType: res.headers.get('content-type') };
    const size = Number(res.headers.get('content-length') ?? 0);
    const typed = kindFromType(out.contentType);
    if (size > MAX_BYTES) {
      await res.body?.cancel();
      // Too big to read here; the PC can still fetch a big PDF.
      return { ...out, fileKind: typed ?? 'other', ok: res.ok, error: res.ok ? null : `The site answered ${res.status}` };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    out.fileKind = res.ok ? fileKind(out.contentType, bytes.subarray(0, 4096)) : 'page';
    if (out.fileKind === 'page' || out.fileKind === 'text') {
      out.body = new TextDecoder().decode(bytes);
      out.blocked = looksBlocked(res.status, out.body);
    } else if (bytes.length <= KEEP_FILE_MAX_BYTES && (out.fileKind === 'pdf' || out.fileKind === 'image')) {
      out.bytes = bytes;
    }
    out.ok = res.ok && !out.blocked;
    if (!out.ok) out.error = out.blocked ? `The site turned Cloudflare away (${res.status})` : `The site answered ${res.status}`;
    return out;
  } catch (err) {
    return { ...base, error: err instanceof Error && err.name === 'TimeoutError' ? 'The site took too long to answer' : 'Could not reach the site' };
  }
}

/** The stored type for a file: what the server said, else what the bytes showed. */
function fileTypeOf(f: FetchedLink): string {
  const t = (f.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (f.fileKind === 'pdf') return 'application/pdf';
  if (f.fileKind === 'image') return t.startsWith('image/') ? t : 'image/jpeg';
  return t && t !== 'application/octet-stream' && t !== 'binary/octet-stream' ? t : 'application/octet-stream';
}

/**
 * Adds one web page to the inbox without following its site. Cloudflare tries
 * first; when it is turned away, or the page is built by JavaScript or has too
 * little text, the item goes in straight away and the PC fetches a clean copy
 * (the same job as the reader's Fetch full page).
 *
 * Links to files are handled by what they are: a PDF is kept and the PC reads
 * its text; a picture is kept and shown; plain text is shown as it is; any other
 * file (Word, zip, video) gets a short note and a link, never its bytes as text.
 */
export async function savePage(env: Env, url: string): Promise<SavePageResult> {
  const source = await savedPagesSource(env);
  const key = canonicalUrl(url).slice(0, 500);
  const earlier = await env.DB.prepare(
    "SELECT id, subject FROM items INDEXED BY items_source WHERE source_id = ? AND message_id = ? AND status != 'dropped' LIMIT 1",
  )
    .bind(source.id, key)
    .first<{ id: string; subject: string }>();
  if (earlier) return { itemId: earlier.id, already: true, waitingForPc: false, helperOnline: await helperOnline(env), title: earlier.subject };

  const f = await fetchLink(url);
  const pageUrl = f.ok || f.fileKind !== 'page' ? f.url || url : url;
  const host = new URL(pageUrl).hostname.replace(/^www\./, '');
  const fileName = fileNameFromUrl(pageUrl);
  const id = newId();
  // Plain text reads as it is, like a page; anything else is kept as a file the reader can open.
  const isFile = f.fileKind !== 'page' && f.fileKind !== 'text';
  const fileType = isFile ? fileTypeOf(f) : null;
  const fileKey = f.bytes ? `items/${id}/file` : null;
  const fileHref = fileKey ? `/api/items/${id}/file` : pageUrl;

  let article: Article | null = null;
  let html: string;
  let text: string | null = null;
  let good = false;
  let toPc = false;
  let title: string;
  let picture: { src: string; title: string | null; alt: string | null } | null = null;
  if (f.fileKind === 'page') {
    article = f.ok ? extractArticle(f.body, pageUrl) : null;
    good = article !== null && article.wordCount >= GOOD_COPY_WORDS && !looksScripted(f.body);
    title = article?.title ?? (f.ok ? pageTitle(f.body) : null) ?? `${host}${new URL(pageUrl).pathname.replace(/\/$/, '')}`;
    // Until the PC's copy arrives the reader shows a short note with a link to the page.
    html = good
      ? article!.html
      : `<p><em>Your PC is fetching a clean copy of this page.</em></p><p><a href="${escapeAttr(pageUrl)}">Open ${escapeAttr(host)}</a></p>`;
    text = good ? article!.text : null;
    toPc = !good;
    picture = article ? leadImage(article.html, pageUrl, article.image) : null;
  } else if (f.fileKind === 'text') {
    html = textFileHtml(f.body);
    text = f.body.replace(/\s+/g, ' ').trim();
    good = countWords(text) > 0;
    title = titleFromFileName(fileName);
  } else if (f.fileKind === 'pdf') {
    // The Worker has too little time to read a PDF; the PC turns it into text.
    title = titleFromFileName(fileName);
    html = `<p><em>Your PC is reading the text out of this PDF.</em></p><p><a href="${escapeAttr(fileHref)}">Open the PDF</a></p>`;
    toPc = true;
  } else if (f.fileKind === 'image') {
    title = titleFromFileName(fileName);
    html = `<p><img src="${escapeAttr(fileHref)}" alt="${escapeAttr(title)}"></p>`;
    picture = { src: fileHref, title: null, alt: title };
  } else {
    title = titleFromFileName(fileName);
    html = fileNoteHtml(fileTypeLabel(f.contentType, pageUrl), pageUrl);
  }
  title = title.slice(0, 500);

  return storeSavedItem(env, source, {
    id,
    key,
    title,
    author: article?.author ?? host,
    html,
    text,
    good,
    webUrl: pageUrl,
    jobUrl: toPc ? pageUrl : null,
    picture,
    fileType,
    file: fileKey && f.bytes ? f.bytes : null,
  });
}

interface SavedItemInput {
  id: string;
  /** Tells a page added twice apart from a new one (its canonical address, or the uploaded file's name and size). */
  key: string;
  title: string;
  author: string | null;
  html: string;
  text: string | null;
  /** The copy is readable as it is: goes to the AI straight away. */
  good: boolean;
  webUrl: string | null;
  /** The PC fetches (or reads) this address to make the copy. */
  jobUrl: string | null;
  picture: { src: string; title: string | null; alt: string | null } | null;
  fileType: string | null;
  /** The file itself, kept at items/<id>/file. */
  file: Uint8Array | null;
}

/** Stores a page or file added on its own under Saved pages, and queues the PC's job when there is one. */
async function storeSavedItem(env: Env, source: SourceRow, it: SavedItemInput): Promise<SavePageResult> {
  const { id, html, text, good } = it;
  const t = now();
  const title = it.title.slice(0, 500);
  const quick = good ? quickSummary(html, text) : { preheader: null, wordCount: 0, sponsored: false };
  const settings = await loadSettings(env);
  const htmlKey = `items/${id}/body.html`;
  const fileKey = it.file ? `items/${id}/file` : null;
  await Promise.all([
    env.RAW.put(htmlKey, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } }),
    fileKey && it.file ? env.RAW.put(fileKey, it.file, { httpMetadata: { contentType: it.fileType ?? 'application/octet-stream' } }) : null,
  ]);
  const stmts = [
    env.DB.prepare(
      `INSERT INTO items (
         id, source_id, kind, status, subject, from_name, snippet, received_at, message_id, html_key, has_html,
         web_url, created_at, preheader, word_count, category, sponsored, ai_status, lead_image, lead_image_title, lead_image_alt,
         file_type, file_key
       ) VALUES (?, ?, 'site', 'inbox', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      source.id,
      title,
      it.author,
      text ? snippetOf(text) : null,
      // When you added it, so it sits at the top of the inbox.
      t,
      it.key,
      htmlKey,
      it.webUrl,
      t,
      quick.preheader,
      quick.wordCount,
      categoryFromRules(settings.keywordRules, title, quick.preheader),
      quick.sponsored ? 1 : 0,
      // Waits for the PC's copy before going to the AI; pictures and other files have no words for it.
      good ? 'pending' : null,
      it.picture?.src ?? null,
      it.picture?.title ?? null,
      it.picture?.alt ?? null,
      it.fileType,
      fileKey,
    ),
  ];
  if (it.jobUrl) {
    stmts.push(
      env.DB.prepare("INSERT INTO fetch_jobs (id, kind, source_id, item_id, url, created_at, force) VALUES (?, 'article', ?, ?, ?, ?, 1)").bind(
        newId(),
        source.id,
        id,
        it.jobUrl,
        t,
      ),
    );
  }
  await env.DB.batch(stmts);
  const waitingForPc = it.jobUrl !== null;
  return { itemId: id, already: false, waitingForPc, helperOnline: waitingForPc ? await helperOnline(env) : true, title };
}

/**
 * An email sent to the save address that is worth keeping as it is (a forwarded
 * email, or a note with no link in it). Kept under Saved pages like a page.
 */
export async function saveEmailCopy(
  env: Env,
  email: { key: string; title: string; author: string | null; html: string; text: string | null },
): Promise<SavePageResult> {
  const source = await savedPagesSource(env);
  const key = email.key.slice(0, 500);
  const earlier = await env.DB.prepare(
    "SELECT id, subject FROM items INDEXED BY items_source WHERE source_id = ? AND message_id = ? AND status != 'dropped' LIMIT 1",
  )
    .bind(source.id, key)
    .first<{ id: string; subject: string }>();
  if (earlier) return { itemId: earlier.id, already: true, waitingForPc: false, helperOnline: true, title: earlier.subject };
  return storeSavedItem(env, source, {
    id: newId(),
    key,
    title: email.title,
    author: email.author,
    html: email.html,
    text: email.text,
    good: email.text !== null && countWords(email.text) > 0,
    webUrl: null,
    jobUrl: null,
    picture: null,
    fileType: null,
    file: null,
  });
}

/** Most an uploaded or shared file may be. */
const UPLOAD_MAX_BYTES = 25_000_000;

/**
 * A file you uploaded or shared from the phone (a PDF, usually). The app keeps
 * it; a PDF goes to the PC to be read into text, fetched back from the app.
 */
export async function saveUpload(env: Env, origin: string, file: File): Promise<SavePageResult> {
  if (file.size > UPLOAD_MAX_BYTES) throw new Error('That file is bigger than 25 MB');
  const source = await savedPagesSource(env);
  const name = (file.name || 'file').slice(0, 200);
  const key = `upload:${name}:${file.size}`;
  const earlier = await env.DB.prepare(
    "SELECT id, subject FROM items INDEXED BY items_source WHERE source_id = ? AND message_id = ? AND status != 'dropped' LIMIT 1",
  )
    .bind(source.id, key)
    .first<{ id: string; subject: string }>();
  if (earlier) return { itemId: earlier.id, already: true, waitingForPc: false, helperOnline: await helperOnline(env), title: earlier.subject };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = fileKind(file.type || null, bytes.subarray(0, 4096));
  const id = newId();
  const href = `/api/items/${id}/file`;
  const title = titleFromFileName(name);
  const typed = (file.type || '').toLowerCase();
  const fileType =
    kind === 'pdf' ? 'application/pdf' : kind === 'image' ? (typed.startsWith('image/') ? typed : 'image/jpeg') : kind === 'page' ? 'text/html' : typed || 'application/octet-stream';
  const base = { id, key, title, author: null, webUrl: null, fileType, file: bytes, picture: null, text: null, good: false, jobUrl: null };
  if (kind === 'pdf') {
    return storeSavedItem(env, source, {
      ...base,
      html: `<p><em>Your PC is reading the text out of this PDF.</em></p><p><a href="${escapeAttr(href)}">Open the PDF</a></p>`,
      // The PC fetches it from the app (helper-only address, with its service token).
      jobUrl: `${origin}/api/helper/files/${id}`,
    });
  }
  if (kind === 'image') {
    return storeSavedItem(env, source, {
      ...base,
      html: `<p><img src="${escapeAttr(href)}" alt="${escapeAttr(title)}"></p>`,
      picture: { src: href, title: null, alt: title },
    });
  }
  if (kind === 'text' || kind === 'page') {
    const raw = new TextDecoder().decode(bytes);
    const article = kind === 'page' ? extractArticle(raw, `${origin}${href}`) : null;
    const html = article ? article.html : textFileHtml(raw);
    const text = article ? article.text : raw.replace(/\s+/g, ' ').trim();
    return storeSavedItem(env, source, { ...base, title: article?.title ?? title, html, text, good: countWords(text) > 0 });
  }
  return storeSavedItem(env, source, { ...base, html: fileNoteHtml(fileTypeLabel(file.type, name), href) });
}

export function registerFeeds(app: App) {
  app.post('/api/sources/discover', async (c) => {
    const input = (await c.req.json().catch(() => null)) as { url?: string } | null;
    if (!input?.url) return c.json({ error: 'url required' }, 400);
    return c.json(await discover(c.env, input.url));
  });

  app.post('/api/sources/opml', async (c) => {
    const input = (await c.req.json().catch(() => null)) as { opml?: string; startWith?: number } | null;
    if (!input?.opml || !/<opml[\s>]/i.test(input.opml)) return c.json({ error: "That file isn't an OPML export" }, 400);
    return c.json(await importOpml(c.env, input.opml, startCount(input.startWith)));
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
      `INSERT INTO sources (id, kind, name, url, feed_url, fetch_via, render, link_hint, category, created_at, next_check_at, start_count,
         post_filter, daily_cap, wait_hours)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        startCount(input.startWith),
        input.postFilter ? JSON.stringify(normalizePostFilter(input.postFilter)) : null,
        typeof input.dailyCap === 'number' ? Math.min(Math.max(Math.round(input.dailyCap), 0), 500) : null,
        // Reddit posts wait a few hours by default, so votes and comments have built up.
        typeof input.waitHours === 'number'
          ? Math.min(Math.max(Math.round(input.waitHours), 0), 72)
          : platformOf(feedUrl) === 'reddit'
            ? 6
            : 0,
      )
      .run();
    const row = (await loadSourceRow(c.env, id))!;
    const result = await checkNow(c.env, row);
    const body: NewSourceResult = { source: (await sourceView(c.env, id))!, ...result };
    return c.json(body, 201);
  });

  // Every feed and website is due now: this run checks the first batch and the rest follow over the next few runs.
  app.post('/api/sources/check-all', async (c) => {
    const t = now();
    const r = await c.env.DB.prepare("UPDATE sources SET next_check_at = ? WHERE kind IN ('feed', 'site') AND paused_at IS NULL AND NOT (kind = 'site' AND url IS NULL)").bind(t).run();
    const result = await runFeedChecks(c.env);
    return c.json({ due: r.meta.changes ?? 0, ...result });
  });

  // ----- Fetch full page, from the reader -----

  app.get('/api/items/:id/fetch-page', async (c) => {
    const [job, online] = await Promise.all([
      c.env.DB.prepare(
        "SELECT status, error FROM fetch_jobs WHERE item_id = ? AND kind = 'article' AND force = 1 ORDER BY created_at DESC LIMIT 1",
      )
        .bind(c.req.param('id'))
        .first<{ status: string; error: string | null }>(),
      helperOnline(c.env),
    ]);
    const status: FetchPageStatus = {
      pending: job?.status === 'pending' || job?.status === 'working',
      error: job?.status === 'failed' ? (job.error ?? 'Fetch failed') : null,
      helperOnline: online,
    };
    return c.json(status);
  });

  app.post('/api/items/:id/fetch-page', async (c) => {
    const id = c.req.param('id');
    const item = await c.env.DB.prepare(
      'SELECT items.id, items.source_id, items.web_url, items.html_key, sources.follow_link, sources.url AS source_url, sources.feed_url FROM items LEFT JOIN sources ON sources.id = items.source_id WHERE items.id = ?',
    )
      .bind(id)
      .first<{
        id: string;
        source_id: string | null;
        web_url: string | null;
        html_key: string | null;
        follow_link: number | null;
        source_url: string | null;
        feed_url: string | null;
      }>();
    if (!item) return c.json({ error: 'not found' }, 404);
    if (!item.web_url) return c.json({ error: 'This item has no web page to fetch' }, 400);
    // Aggregators: fetch the article the post links to (and the story's other links), not the aggregator's page.
    let url = item.web_url;
    if (item.follow_link === 1 && item.html_key) {
      const body = await (await c.env.RAW.get(item.html_key))?.text();
      const feedPart = body?.split('<hr data-linked-article>')[0];
      url = (feedPart && outsideLink(feedPart, [item.web_url, item.source_url, item.feed_url])) || url;
    }
    const t = now();
    await c.env.DB.batch([
      // Any earlier request for this item (waiting or failed) gives way to this one.
      c.env.DB.prepare("DELETE FROM fetch_jobs WHERE item_id = ? AND kind = 'article' AND status != 'working'").bind(id),
      c.env.DB.prepare(
        `INSERT INTO fetch_jobs (id, kind, source_id, item_id, url, created_at, force)
         SELECT ?1, 'article', ?2, ?3, ?4, ?5, 1 WHERE NOT EXISTS (SELECT 1 FROM fetch_jobs WHERE item_id = ?3 AND kind = 'article')`,
      ).bind(newId(), item.source_id, id, url, t),
    ]);
    const status: FetchPageStatus = { pending: true, error: null, helperOnline: await helperOnline(c.env) };
    return c.json(status);
  });

  // ----- One page on its own ("Add just this page", or shared from another app) -----

  app.post('/api/pages', async (c) => {
    const input = (await c.req.json().catch(() => null)) as SavePageInput | null;
    // A shared link may be a whole sentence; take the first web address in it.
    const raw = input?.url?.trim() ?? '';
    const url = normalizeUrl(raw.match(/https?:\/\/\S+/)?.[0] ?? raw);
    if (!url) return c.json({ error: "That doesn't look like a web address" }, 400);
    return c.json(await savePage(c.env, url), 201);
  });

  /** Add > Upload a file: a PDF (or any file) from this device. */
  app.post('/api/pages/file', async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    if (!file || typeof file === 'string') return c.json({ error: 'Choose a file to upload' }, 400);
    try {
      return c.json(await saveUpload(c.env, new URL(c.req.url).origin, file), 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Upload failed' }, 400);
    }
  });

  /**
   * The phone's share sheet (installed app): a shared file is kept and opened in
   * the reader; a shared link opens Add with "Just one page" filled in, as before.
   */
  app.post('/api/share', async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.getAll('file').find((f): f is File => typeof f !== 'string' && f.size > 0);
    if (file) {
      try {
        const saved = await saveUpload(c.env, new URL(c.req.url).origin, file);
        return c.redirect(`/item/${saved.itemId}`, 303);
      } catch (err) {
        return c.redirect(`/add?share_error=${encodeURIComponent(err instanceof Error ? err.message : 'Upload failed')}`, 303);
      }
    }
    const q = new URLSearchParams();
    for (const k of ['shared_url', 'shared_text', 'shared_title']) {
      const v = form?.get(k);
      if (typeof v === 'string' && v) q.set(k, v);
    }
    return c.redirect(`/add?${q.toString()}`, 303);
  });

  /** Pictures that came with an article read from a PDF (its pictures, charts and tables). */
  app.get('/api/items/:id/images/:n', async (c) => {
    const id = c.req.param('id');
    const n = c.req.param('n');
    const obj = /^[\w-]{1,64}$/.test(id) && /^\d{1,3}$/.test(n) ? await c.env.RAW.get(`items/${id}/images/${n}`) : null;
    if (!obj) return c.json({ error: 'not found' }, 404);
    return new Response(obj.body, {
      headers: { 'Content-Type': obj.httpMetadata?.contentType ?? 'image/png', 'Cache-Control': 'private, max-age=31536000, immutable' },
    });
  });

  /** The PC's way to an uploaded file it reads (a PDF shared from the phone). */
  app.get('/api/helper/files/:id', async (c) => {
    const id = c.req.param('id');
    const row = /^[\w-]{1,64}$/.test(id)
      ? await c.env.DB.prepare('SELECT file_key, file_type FROM items WHERE id = ?').bind(id).first<{ file_key: string | null; file_type: string | null }>()
      : null;
    const obj = row?.file_key ? await c.env.RAW.get(row.file_key) : null;
    if (!row || !obj) return c.json({ error: 'not found' }, 404);
    return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType ?? row.file_type ?? 'application/octet-stream' } });
  });

  /** The app's own copy of a file added as a page (a PDF, a picture). */
  app.get('/api/items/:id/file', async (c) => {
    const id = c.req.param('id');
    const row = /^[\w-]{1,64}$/.test(id)
      ? await c.env.DB.prepare('SELECT file_key, file_type, subject, web_url FROM items WHERE id = ?')
          .bind(id)
          .first<{ file_key: string | null; file_type: string | null; subject: string; web_url: string | null }>()
      : null;
    const obj = row?.file_key ? await c.env.RAW.get(row.file_key) : null;
    if (!row || !obj) return c.json({ error: 'not found' }, 404);
    const name = (row.web_url ? fileNameFromUrl(row.web_url) : row.subject).replace(/["\\\r\n]/g, '').slice(0, 150) || 'file';
    return new Response(obj.body, {
      headers: {
        'Content-Type': obj.httpMetadata?.contentType ?? row.file_type ?? 'application/octet-stream',
        // Opens in the browser's own viewer (PDFs, pictures) rather than downloading straight away.
        'Content-Disposition': `inline; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  app.post('/api/sources/:id/check', async (c) => {
    const row = await loadSourceRow(c.env, c.req.param('id'));
    if (!row || (row.kind !== 'feed' && row.kind !== 'site') || isSavedPages(row)) return c.json({ error: 'not found' }, 404);
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
    const timedOut = await idsOf(
      c.env.DB.prepare("SELECT item_id FROM fetch_jobs WHERE status = 'working' AND claimed_at < ? AND attempts >= ? AND item_id IS NOT NULL").bind(
        stale,
        JOB_MAX_ATTEMPTS,
      ),
    );
    await c.env.DB.batch([
      ...pendingAgain(c.env, timedOut, ''),
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
       RETURNING id, kind, source_id, item_id, url, force`,
    )
      .bind(t, stale, max)
      .all<{ id: string; kind: FetchJob['kind']; source_id: string | null; item_id: string | null; url: string; force: number | null }>();

    const jobs: FetchJob[] = [];
    const settings = claimed.results.length ? await loadSettings(c.env) : null;
    const allow = settings?.pcSkipAllowCategories ?? [];
    for (const j of claimed.results) {
      const s = j.source_id ? await loadSourceRow(c.env, j.source_id) : null;
      const post =
        j.item_id && ((j.kind === 'article' && s?.follow_link === 1) || allow.length)
          ? await c.env.DB.prepare('SELECT web_url, category FROM items WHERE id = ?')
              .bind(j.item_id)
              .first<{ web_url: string | null; category: string | null }>()
          : null;
      // Sites the PC leaves alone, unless the item's (or its source's) category is an exception.
      const category = post?.category ?? s?.category ?? null;
      const skipSites = category && allow.includes(category) ? [] : (settings?.pcSkipSites ?? []);
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
        wantPicture: s?.show_picture === 1,
        postUrl: s?.follow_link === 1 ? (post?.web_url ?? null) : null,
        skipSites,
        browserIfScripted: j.kind === 'article' && j.force === 1,
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
      force: number | null;
      url: string;
    }>();
    if (!job) return c.json({ error: 'not found' }, 404);
    // Reddit: the PC sends only the top comments, which go under the post from the feed.
    const comments = isRedditPost(job.url);
    const source = job.source_id ? await loadSourceRow(c.env, job.source_id) : null;
    const error = String(r.error || 'Fetch failed on the PC').slice(0, 300);

    if (job.kind === 'article') {
      // A bot-check page ("unusual activity from your computer network") is never kept as the article.
      const a = r.ok && r.article && !looksBotCheck(r.article.text) ? r.article : undefined;
      const item = job.item_id
        ? await c.env.DB.prepare('SELECT id, word_count, lead_image, html_key FROM items WHERE id = ?')
            .bind(job.item_id)
            .first<{ id: string; word_count: number | null; lead_image: string | null; html_key: string | null }>()
        : null;
      // Asked for from the reader: the page as it is now replaces the saved copy, whatever its length.
      const wanted =
        job.force || comments ? Boolean(a?.html && (a.wordCount > 0 || (a.images?.length ?? 0) > 0)) : Boolean(a?.html && a.wordCount > Math.max(item?.word_count ?? 0, 50));
      // The post's picture: a copy the PC downloaded always wins (some sites' picture links expire);
      // otherwise the feed's own picture stays, and a post with none (or only a logo) takes the page's.
      let picture: { src: string; title: string | null; alt?: string | null } | null = null;
      if (item && a) {
        const puts: Promise<unknown>[] = [];
        if (a.picture?.data) picture = keepPicture(c.env, item.id, a.picture, puts);
        else if (!item.lead_image || junkImage(item.lead_image)) picture = a.picture ?? (a.html ? leadImage(a.html, null, a.image) : null);
        await Promise.all(puts);
        if (picture) {
          await c.env.DB.prepare('UPDATE items SET lead_image = ?, lead_image_title = ?, lead_image_alt = ? WHERE id = ?')
            .bind(picture.src, picture.title, picture.alt ?? null, item.id)
            .run();
        }
      }
      if (item && a && a.html && wanted) {
        const quick = quickSummary(a.html, a.text);
        const key = `items/${item.id}/body.html`;
        let html = a.picture && picture ? swapPictureSrc(a.html, a.picture.src, picture.src) : a.html;
        // A PDF's pictures (and its charts and tables, drawn by the PC): kept here, under their own addresses.
        if (a.images?.length) html = await keepArticleImages(c.env, item.id, html, a.images);
        if ((source?.follow_link === 1 || comments) && item.html_key) {
          // The aggregator's own summary stays on top, the linked article under it (replaced on a re-fetch).
          const feedCopy = (await (await c.env.RAW.get(item.html_key))?.text())?.split('<hr data-linked-article>')[0];
          if (feedCopy) html = `${feedCopy}\n<hr data-linked-article>\n${html}`;
        }
        await c.env.RAW.put(key, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
        // Asked for by hand (or a page added on its own): the copy is new, so its quick summary is
        // worked out again and the AI summarises it again; otherwise a feed's own preview line stays.
        const fresh = Boolean(job.force) && !comments;
        await c.env.DB.prepare(
          `UPDATE items SET html_key = ?, has_html = 1, word_count = ?, snippet = COALESCE(?, snippet),
             preheader = ${fresh ? '?' : 'COALESCE(preheader, ?)'}, sponsored = ?,
             ai_status = ${fresh ? "CASE WHEN ai_status IN ('done', 'failed') THEN 'pending' ELSE COALESCE(ai_status, 'pending') END" : "COALESCE(ai_status, 'pending')"},
             ${fresh ? 'ai_attempts = 0, ai_error = NULL,' : ''} body_v = body_v + 1 WHERE id = ?`,
        )
          .bind(
            key,
            // Comments add to the post's own words; the post keeps its own snippet.
            comments ? (item.word_count ?? 0) + a.wordCount : quick.wordCount,
            comments ? null : snippetOf(a.text),
            quick.preheader,
            quick.sponsored ? 1 : 0,
            item.id,
          )
          .run();
        // The link was a file the PC read the text out of (a PDF): the reader offers the file itself too.
        if (a.fileType) {
          await c.env.DB.prepare('UPDATE items SET file_type = COALESCE(file_type, ?) WHERE id = ?').bind(a.fileType.slice(0, 100), item.id).run();
        }
        // A page added on its own: the PC's copy gives it its real title and author.
        if (source && isSavedPages(source) && (a.title || a.author)) {
          await c.env.DB.prepare('UPDATE items SET subject = COALESCE(?, subject), from_name = COALESCE(?, from_name) WHERE id = ?')
            .bind(a.title?.slice(0, 500) ?? null, a.author ?? null, item.id)
            .run();
        }
      } else if (!r.ok && job.attempts < JOB_MAX_ATTEMPTS && !r.blocked) {
        await c.env.DB.prepare("UPDATE fetch_jobs SET status = 'pending', claimed_at = NULL, error = ? WHERE id = ?").bind(error, job.id).run();
        return c.json({ ok: true, retry: true });
      } else if (job.force) {
        // A page added on its own that only has the waiting note: say what went wrong instead.
        if (source && isSavedPages(source) && item?.html_key && !item.word_count) {
          const why = r.ok ? 'The page came back with no readable article.' : error;
          await c.env.RAW.put(
            item.html_key,
            job.url.includes('/api/helper/files/')
              ? `<p><em>Your PC couldn't read this file: ${escapeAttr(why)}</em></p><p><a href="/api/items/${escapeAttr(item.id)}/file">Open the file</a></p>`
              : `<p><em>Couldn't get a copy of this page: ${escapeAttr(why)}</em></p><p><a href="${escapeAttr(job.url)}">Open the page</a></p>`,
            { httpMetadata: { contentType: 'text/html; charset=utf-8' } },
          );
          await c.env.DB.prepare('UPDATE items SET body_v = body_v + 1 WHERE id = ?').bind(item.id).run();
        }
        // Kept (as failed) so the reader can say what went wrong; cleared after a week like other failures.
        await c.env.DB.prepare("UPDATE fetch_jobs SET status = 'failed', error = ? WHERE id = ?")
          .bind(r.ok ? 'The page came back with no readable article' : error, job.id)
          .run();
        return c.json({ ok: true });
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
        await recordOk(c.env, source, { etag: r.etag, lastModified: r.lastModified }, added);
      }
    }
    await c.env.DB.prepare('DELETE FROM fetch_jobs WHERE id = ?').bind(job.id).run();
    return c.json({ ok: true, added });
  });
}
