import {
  SUGGEST_SKIP,
  linkTarget,
  siteKey,
  type LinkJob,
  type LinkResult,
  type SuggestCheckResult,
  type SuggestFollowed,
  type SuggestLearnt,
  type SuggestLearntPage,
  type SuggestRun,
  type Suggestion,
  type SuggestionList,
  type SuggestionStatus,
  type SuggestionWhy,
} from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { readJson, writeJson } from './ai';
import type { AppVariables, Env } from './env';
import { helperOnline } from './feeds';
import { now } from './ids';

/**
 * Feed suggestions. Three signals, all from the reader's own reading:
 *  - links: the PC counts the outside sites each item you read in the reader,
 *    save or star links to (stars count 3, saves 2, reads 1);
 *  - taps: links you open from the reader count double;
 *  - fit: the PC checks each top site for a feed and compares its latest posts
 *    with the items you marked Interesting, using the same local embeddings as
 *    Likely interesting.
 * Follow and Not interested teach it: the topics and the linking sources of a
 * followed site count up, a dismissed site's topics count down, and a followed
 * site you hardly open after three weeks counts as a soft no. All the heavy
 * work (reading item HTML, fetching sites, vector maths) happens on the PC;
 * the Worker only stores counts and does one grouped query a week.
 */

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const DAY = 86_400_000;
/** Reading that counts: the last six months. */
const WINDOW_MS = 180 * DAY;
/** A run once a week, or sooner when asked from the Suggested page. */
const RUN_EVERY_MS = 7 * DAY;
/** Sites checked per run, and how long a check stands before the site is looked at again. */
const CHECKS_PER_RUN = 20;
const RECHECK_MS = 30 * DAY;
const NOFEED_RECHECK_MS = 90 * DAY;
/** Candidate sites kept from the link counts each run. */
const CANDIDATES = 60;
/** A followed site is judged after this long. */
const SOFT_NO_AFTER_MS = 21 * DAY;
const MAX_LINK_CLAIM = 20;

/** Items whose links count: opened in the reader (or the digest), saved or starred. */
const ENGAGED = "(items.interesting_at IS NOT NULL OR items.saved_at IS NOT NULL OR items.read_via IN ('reader', 'digest'))";
const LINKS_WAITING = `items.links_at IS NULL AND items.html_key IS NOT NULL AND items.kind != 'ai' AND items.received_at > ? AND ${ENGAGED}`;

interface RunState {
  lastAt?: number | null;
  startedAt?: number | null;
  requestedAt?: number | null;
  linksCounted?: number;
  linksWaiting?: number;
}

interface Tunes {
  topics: Record<string, { label: string; net: number }>;
  sources: Record<string, number>;
}

const loadRun = async (env: Env): Promise<RunState> => (await readJson<RunState>(env, 'suggest_run')) ?? {};
const loadTunes = async (env: Env): Promise<Tunes> => {
  const t = await readJson<Partial<Tunes>>(env, 'suggest_tunes');
  return { topics: t?.topics ?? {}, sources: t?.sources ?? {} };
};

/** Called from the heartbeat: whether the PC should do a suggestions run now. */
export async function suggestHeartbeat(env: Env): Promise<{ suggestDue: boolean }> {
  const run = await loadRun(env);
  const last = run.lastAt ?? 0;
  return { suggestDue: now() - last >= RUN_EVERY_MS || (run.requestedAt ?? 0) > last };
}

/** Records a link tapped in the reader, by site. Tracking links that hide where they go are skipped. */
export async function recordLinkClick(env: Env, itemId: string, url: string): Promise<void> {
  const target = linkTarget(url);
  const site = target ? siteKey(target.url) : null;
  if (!site || SUGGEST_SKIP.has(site)) return;
  await env.DB.prepare('INSERT INTO link_clicks (item_id, site, at) VALUES (?, ?, ?)').bind(itemId, site.slice(0, 120), now()).run();
}

// ---------- Scoring ----------

interface Row {
  site: string;
  status: SuggestionStatus;
  title: string | null;
  feed_url: string | null;
  site_url: string | null;
  description: string | null;
  samples: string | null;
  posts_per_week: number | null;
  last_post_at: number | null;
  why: string | null;
  via: string | null;
  tags: string | null;
  link_score: number;
  fit: number | null;
  source_id: string | null;
  ignored: number;
  soft_no_at: number | null;
  checked_at: number | null;
  decided_at: number | null;
}

type StoredWhy = Omit<SuggestionWhy, 'learnt' | 'topics'>;
type Topic = SuggestionWhy['topics'][number];

function json<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/** What Follow and Not interested taught, applied to one site: about ±0.04 a step, at most ±0.25. */
function learntFor(tunes: Tunes, topics: Topic[], via: string[]): number {
  let n = 0;
  for (const t of topics) n += tunes.topics[t.tag]?.net ?? 0;
  for (const s of via.slice(0, 3)) n += tunes.sources[s] ?? 0;
  return clamp(n * 0.04, -0.25, 0.25);
}

/**
 * How good a match a site is, 0..99. Links and taps (log scale, so a site
 * linked 30 times isn't ten times a site linked 3 times), closeness to your
 * stars, whether it still posts, a nudge for topics you read a lot but have
 * few sources for, and what the app has learnt from your taps.
 */
function matchOf(r: Row, topics: Topic[], learnt: number, t: number): number {
  const linkPart = clamp(Math.log2(1 + r.link_score) / Math.log2(31), 0, 1);
  const fitPart = r.fit === null ? 0.4 : clamp((r.fit - 0.5) / 0.3, 0, 1);
  const age = r.last_post_at ? t - r.last_post_at : Infinity;
  const fresh = age < 14 * DAY ? 1 : age < 60 * DAY ? 0.5 : 0;
  const gap = topics.some((x) => x.sources <= 2) ? 0.05 : 0;
  return Math.round(clamp(0.45 * linkPart + 0.4 * fitPart + 0.1 * fresh + gap + learnt, 0, 0.99) * 100);
}

function toSuggestion(r: Row, tunes: Tunes, t: number): Suggestion {
  const stored = json<StoredWhy>(r.why, { items: 0, starred: 0, sources: 0, sourceNames: [], clicks: 0 });
  const topics = json<Topic[]>(r.tags, []);
  const via = json<string[]>(r.via, []);
  const learnt = learntFor(tunes, topics, via);
  return {
    site: r.site,
    status: r.status,
    title: r.title || r.site,
    feedUrl: r.feed_url,
    siteUrl: r.site_url,
    description: r.description,
    samples: json(r.samples, []),
    postsPerWeek: r.posts_per_week,
    lastPostAt: r.last_post_at,
    match: matchOf(r, topics, learnt, t),
    fit: r.fit === null ? null : Math.round(clamp((r.fit - 0.4) / 0.45, 0, 1) * 100),
    why: { ...stored, topics, learnt: Math.round(learnt * 100) },
    sourceId: r.source_id,
    checkedAt: r.checked_at,
    decidedAt: r.decided_at,
  };
}

// ---------- Learning ----------

/** Adds `step` to each of a site's topics and (for follows) its linking sources. */
async function learn(env: Env, r: Row, step: number, withSources: boolean): Promise<void> {
  const tunes = await loadTunes(env);
  for (const t of json<Topic[]>(r.tags, [])) {
    const cur = tunes.topics[t.tag] ?? { label: t.label, net: 0 };
    cur.net = Math.round((cur.net + step) * 10) / 10;
    if (cur.net === 0) delete tunes.topics[t.tag];
    else tunes.topics[t.tag] = cur;
  }
  if (withSources) {
    for (const s of json<string[]>(r.via, []).slice(0, 3)) {
      const net = Math.round(((tunes.sources[s] ?? 0) + step) * 10) / 10;
      if (net === 0) delete tunes.sources[s];
      else tunes.sources[s] = net;
    }
  }
  await writeJson(env, 'suggest_tunes', tunes);
}

/** Followed sites you hardly open after three weeks teach a soft no, once each. */
async function softNos(env: Env): Promise<void> {
  const t = now();
  const rows = await env.DB.prepare(
    "SELECT * FROM suggestions WHERE status = 'followed' AND ignored = 0 AND soft_no_at IS NULL AND source_id IS NOT NULL AND decided_at < ?",
  )
    .bind(t - SOFT_NO_AFTER_MS)
    .all<Row>();
  for (const r of rows.results) {
    const c = await env.DB.prepare('SELECT COUNT(*) AS n, COUNT(read_at) AS r FROM items WHERE source_id = ? AND received_at >= ?')
      .bind(r.source_id, r.decided_at ?? 0)
      .first<{ n: number; r: number }>();
    if (!c || c.n < 5) continue;
    if (c.r / c.n < 0.1) await learn(env, r, -1, false);
    await env.DB.prepare('UPDATE suggestions SET soft_no_at = ? WHERE site = ?').bind(t, r.site).run();
  }
}

// ---------- The weekly run ----------

/** Sites of everything already followed or received, so they're never suggested. */
async function followedSites(env: Env): Promise<{ sites: Set<string>; names: Map<string, string>; feeds: Map<string, string> }> {
  const rows = await env.DB.prepare('SELECT id, name, kind, url, feed_url, sender_email FROM sources').all<{
    id: string;
    name: string;
    kind: string;
    url: string | null;
    feed_url: string | null;
    sender_email: string | null;
  }>();
  const sites = new Set<string>();
  const names = new Map<string, string>();
  const feeds = new Map<string, string>();
  for (const s of rows.results) {
    names.set(s.id, s.name);
    if (s.feed_url) feeds.set(s.feed_url, s.id);
    for (const u of [s.url, s.feed_url]) {
      const k = u ? siteKey(u) : null;
      if (k) sites.add(k);
    }
    // A newsletter's own site, from its sender (news@example.com), unless that's a mail service.
    const domain = s.sender_email?.split('@')[1];
    const k = domain ? siteKey(`https://${domain}/`) : null;
    if (k && !SUGGEST_SKIP.has(k)) sites.add(k);
  }
  return { sites, names, feeds };
}

/** Counts links per site over the last six months and picks the sites to check this run. */
async function startRun(env: Env, fresh: boolean): Promise<SuggestRun> {
  const t = now();
  const since = t - WINDOW_MS;
  const [agg, clicks, followed] = await Promise.all([
    env.DB.prepare(
      `SELECT l.site, COUNT(*) AS items,
         SUM(CASE WHEN items.interesting_at IS NOT NULL THEN 3 WHEN items.saved_at IS NOT NULL THEN 2 ELSE 1 END) AS w,
         SUM(CASE WHEN items.interesting_at IS NOT NULL THEN 1 ELSE 0 END) AS starred,
         COUNT(DISTINCT items.source_id) AS sources,
         GROUP_CONCAT(DISTINCT items.source_id) AS via
       FROM item_links l JOIN items ON items.id = l.item_id
       WHERE items.received_at > ? AND ${ENGAGED}
       GROUP BY l.site HAVING COUNT(*) >= 2
       ORDER BY w DESC LIMIT 200`,
    )
      .bind(since)
      .all<{ site: string; items: number; w: number; starred: number; sources: number; via: string | null }>(),
    env.DB.prepare('SELECT site, COUNT(*) AS n FROM link_clicks WHERE at > ? GROUP BY site').bind(since).all<{ site: string; n: number }>(),
    followedSites(env),
  ]);
  const clickBy = new Map(clicks.results.map((r) => [r.site, r.n]));
  const bySite = new Map(agg.results.map((r) => [r.site, r]));
  const all = new Set([...bySite.keys(), ...clickBy.keys()]);
  const scored = [...all]
    .filter((site) => !followed.sites.has(site) && !SUGGEST_SKIP.has(site))
    .map((site) => {
      const a = bySite.get(site);
      const n = clickBy.get(site) ?? 0;
      // A site only one source links to (often its sponsor or its parent company) counts half.
      const w = (a?.w ?? 0) * ((a?.sources ?? 0) >= 2 ? 1 : 0.5) + 2 * n;
      const via = (a?.via ?? '').split(',').filter(Boolean);
      const why: StoredWhy = {
        items: a?.items ?? 0,
        starred: a?.starred ?? 0,
        sources: a?.sources ?? 0,
        sourceNames: via.map((id) => followed.names.get(id)).filter((x): x is string => Boolean(x)).slice(0, 3),
        clicks: n,
      };
      return { site, w, why, via: via.slice(0, 10) };
    })
    .filter((x) => x.w >= 2)
    .sort((a, b) => b.w - a.w)
    .slice(0, CANDIDATES);

  // A new run lets sites that dropped out of the counts fade; a run carrying on from last round doesn't.
  const stmts = fresh ? [env.DB.prepare("UPDATE suggestions SET link_score = link_score * 0.5 WHERE status IN ('new', 'nofeed')")] : [];
  for (const c of scored) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO suggestions (site, status, link_score, why, via, created_at) VALUES (?1, 'new', ?2, ?3, ?4, ?5)
         ON CONFLICT(site) DO UPDATE SET link_score = ?2, why = ?3, via = ?4`,
      ).bind(c.site.slice(0, 120), Math.round(c.w * 10) / 10, JSON.stringify(c.why), JSON.stringify(c.via), t),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));

  const checks = await env.DB.prepare(
    `SELECT site FROM suggestions
     WHERE link_score >= 2 AND ((status = 'new' AND (checked_at IS NULL OR checked_at < ?1)) OR (status = 'nofeed' AND checked_at < ?2))
     ORDER BY link_score DESC LIMIT ?3`,
  )
    .bind(t - RECHECK_MS, t - NOFEED_RECHECK_MS, CHECKS_PER_RUN)
    .all<{ site: string }>();
  return { checks: checks.results.map((r) => ({ site: r.site })) };
}

/** The topics the posts share with your reading: tags of the items closest to them, with how many sources cover each. */
async function topicsFor(env: Env, near: string[]): Promise<Topic[]> {
  const ids = near.filter((x) => typeof x === 'string').slice(0, 12);
  if (ids.length === 0) return [];
  const rows = await env.DB.prepare(
    `SELECT tag, MAX(label) AS label, COUNT(*) AS n FROM item_tags WHERE item_id IN (${ids.map(() => '?').join(',')}) GROUP BY tag ORDER BY n DESC LIMIT 3`,
  )
    .bind(...ids)
    .all<{ tag: string; label: string; n: number }>();
  const picked = rows.results.filter((r, i) => r.n >= 2 || i === 0);
  const since = now() - 90 * DAY;
  return Promise.all(
    picked.map(async (r) => {
      const c = await env.DB.prepare(
        'SELECT COUNT(DISTINCT items.source_id) AS n FROM item_tags JOIN items ON items.id = item_tags.item_id WHERE item_tags.tag = ? AND item_tags.received_at > ?',
      )
        .bind(r.tag, since)
        .first<{ n: number }>();
      return { tag: r.tag, label: r.label, sources: c?.n ?? 0 };
    }),
  );
}

async function saveCheck(env: Env, r: SuggestCheckResult, feeds: Map<string, string>): Promise<void> {
  const t = now();
  const site = String(r.site).slice(0, 120);
  if (!r.feedUrl) {
    await env.DB.prepare("UPDATE suggestions SET status = CASE WHEN status = 'new' THEN 'nofeed' ELSE status END, checked_at = ? WHERE site = ?")
      .bind(t, site)
      .run();
    return;
  }
  const feedUrl = String(r.feedUrl).slice(0, 500);
  // Already followed under another address: note it, so it isn't suggested.
  const existing = feeds.get(feedUrl);
  const topics = await topicsFor(env, Array.isArray(r.near) ? r.near : []);
  const samples = (Array.isArray(r.samples) ? r.samples : [])
    .slice(0, 3)
    .map((s) => ({ title: String(s.title ?? '').slice(0, 200), url: s.url ? String(s.url).slice(0, 500) : null }));
  await env.DB.prepare(
    `UPDATE suggestions SET status = CASE WHEN ?1 IS NOT NULL THEN 'followed' WHEN status = 'nofeed' THEN 'new' ELSE status END,
       source_id = COALESCE(source_id, ?1), feed_url = ?2, site_url = ?3, title = ?4, description = ?5, samples = ?6, posts_per_week = ?7,
       last_post_at = ?8, fit = ?9, tags = ?10, checked_at = ?11, ignored = CASE WHEN ?1 IS NOT NULL THEN 1 ELSE ignored END
     WHERE site = ?12`,
  )
    .bind(
      existing ?? null,
      feedUrl,
      r.siteUrl ? String(r.siteUrl).slice(0, 500) : null,
      r.title ? String(r.title).slice(0, 200) : null,
      r.description ? String(r.description).slice(0, 300) : null,
      JSON.stringify(samples),
      Number.isFinite(r.postsPerWeek) ? Math.round(Number(r.postsPerWeek) * 10) / 10 : null,
      Number.isFinite(r.lastPostAt) ? Number(r.lastPostAt) : null,
      Number.isFinite(r.fit) ? Math.round(Number(r.fit) * 1000) / 1000 : null,
      JSON.stringify(topics),
      t,
      site,
    )
    .run();
}

async function loadRow(env: Env, site: string): Promise<Row | null> {
  return env.DB.prepare('SELECT * FROM suggestions WHERE site = ?').bind(site).first<Row>();
}

// ---------- Routes ----------

export function registerSuggest(app: App) {
  // ----- Helper side -----

  /** Items whose links haven't been counted yet, newest first, with their HTML. */
  app.post('/api/helper/suggest/links/claim', async (c) => {
    const input = (await c.req.json().catch(() => ({}))) as { max?: number };
    const max = Math.min(Math.max(Number(input.max) || 10, 1), MAX_LINK_CLAIM);
    const since = now() - WINDOW_MS;
    const rows = await c.env.DB.prepare(`SELECT id, html_key, web_url FROM items WHERE ${LINKS_WAITING} ORDER BY received_at DESC LIMIT ?`)
      .bind(since, max)
      .all<{ id: string; html_key: string; web_url: string | null }>();
    const jobs: LinkJob[] = [];
    const empty: string[] = [];
    for (const r of rows.results) {
      const html = await (await c.env.RAW.get(r.html_key))?.text();
      if (html) jobs.push({ itemId: r.id, html: html.slice(0, 600_000), webUrl: r.web_url });
      else empty.push(r.id);
    }
    if (empty.length) {
      await c.env.DB.prepare(`UPDATE items SET links_at = ? WHERE id IN (${empty.map(() => '?').join(',')})`)
        .bind(now(), ...empty)
        .run();
    }
    return c.json({ jobs });
  });

  app.post('/api/helper/suggest/links/result', async (c) => {
    const input = (await c.req.json().catch(() => null)) as { results?: LinkResult[] } | null;
    const results = (Array.isArray(input?.results) ? input.results : []).filter((r) => typeof r?.itemId === 'string').slice(0, MAX_LINK_CLAIM);
    const t = now();
    const stmts: D1PreparedStatement[] = [];
    for (const r of results) {
      stmts.push(c.env.DB.prepare('DELETE FROM item_links WHERE item_id = ?').bind(r.itemId));
      for (const s of (Array.isArray(r.sites) ? r.sites : []).slice(0, 40)) {
        if (typeof s?.site !== 'string' || !s.site) continue;
        stmts.push(
          c.env.DB.prepare('INSERT OR REPLACE INTO item_links (item_id, site, n) VALUES (?, ?, ?)').bind(
            r.itemId,
            s.site.slice(0, 120),
            Math.min(Math.max(Math.round(Number(s.n) || 1), 1), 50),
          ),
        );
      }
      stmts.push(c.env.DB.prepare('UPDATE items SET links_at = ? WHERE id = ?').bind(t, r.itemId));
    }
    for (let i = 0; i < stmts.length; i += 100) await c.env.DB.batch(stmts.slice(i, i + 100));
    if (results.length) {
      const run = await loadRun(c.env);
      await writeJson(c.env, 'suggest_run', { ...run, linksCounted: (run.linksCounted ?? 0) + results.length });
    }
    return c.json({ ok: true, saved: results.length });
  });

  /** Starts a run once the links are counted: picks the sites to check. */
  app.post('/api/helper/suggest/start', async (c) => {
    const since = now() - WINDOW_MS;
    const waiting = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM items WHERE ${LINKS_WAITING} LIMIT 2000)`)
      .bind(since)
      .first<{ n: number }>();
    const run = await loadRun(c.env);
    const fresh = (run.lastAt ?? 0) >= (run.startedAt ?? 0);
    await writeJson(c.env, 'suggest_run', { ...run, linksWaiting: waiting?.n ?? 0, ...(fresh ? { startedAt: now() } : {}) });
    return c.json(await startRun(c.env, fresh));
  });

  /** What the PC found; `done` closes the run. */
  app.post('/api/helper/suggest/result', async (c) => {
    const input = (await c.req.json().catch(() => null)) as { results?: SuggestCheckResult[]; done?: boolean } | null;
    const results = (Array.isArray(input?.results) ? input.results : []).filter((r) => typeof r?.site === 'string').slice(0, CHECKS_PER_RUN);
    if (results.length) {
      const { feeds } = await followedSites(c.env);
      for (const r of results) await saveCheck(c.env, r, feeds);
    }
    if (input?.done) {
      await softNos(c.env).catch((err: unknown) => console.error('suggestion soft nos failed', err));
      const run = await loadRun(c.env);
      await writeJson(c.env, 'suggest_run', { ...run, lastAt: now() });
    }
    return c.json({ ok: true });
  });

  // ----- App side -----

  app.get('/api/suggestions', async (c) => {
    const t = now();
    const [rows, run, tunes, online, stars] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM suggestions WHERE status = 'new' AND feed_url IS NOT NULL ORDER BY link_score DESC LIMIT 150").all<Row>(),
      loadRun(c.env),
      loadTunes(c.env),
      helperOnline(c.env),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE interesting_at IS NOT NULL').first<{ n: number }>(),
    ]);
    const suggestions = rows.results
      .map((r) => toSuggestion(r, tunes, t))
      .filter((s) => s.match >= 15)
      .sort((a, b) => b.match - a.match)
      .slice(0, 30);
    const body: SuggestionList = {
      suggestions,
      lastRunAt: run.lastAt ?? null,
      runWaiting: (run.requestedAt ?? 0) > (run.lastAt ?? 0),
      helperOnline: online,
      linksCounted: run.linksCounted ?? 0,
      linksWaiting: run.linksWaiting ?? 0,
      stars: stars?.n ?? 0,
    };
    return c.json(body);
  });

  /** Asks the PC for a run at its next check-in. */
  app.post('/api/suggestions/run', async (c) => {
    const run = await loadRun(c.env);
    await writeJson(c.env, 'suggest_run', { ...run, requestedAt: now() });
    return c.json({ ok: true });
  });

  /** Marks a suggestion followed (the app has just added the feed) and learns from it. */
  app.post('/api/suggestions/:site/follow', async (c) => {
    const site = c.req.param('site');
    const input = (await c.req.json().catch(() => ({}))) as { sourceId?: string | null };
    const r = await loadRow(c.env, site);
    if (!r) return c.json({ error: 'not found' }, 404);
    let sourceId = typeof input.sourceId === 'string' ? input.sourceId : null;
    if (!sourceId && r.feed_url) {
      sourceId = (await c.env.DB.prepare('SELECT id FROM sources WHERE feed_url = ?').bind(r.feed_url).first<{ id: string }>())?.id ?? null;
    }
    if (r.status !== 'followed') await learn(c.env, r, 1, true);
    await c.env.DB.prepare("UPDATE suggestions SET status = 'followed', source_id = ?, decided_at = ?, ignored = 0, soft_no_at = NULL WHERE site = ?")
      .bind(sourceId, now(), site)
      .run();
    return c.json({ ok: true, sourceId });
  });

  app.post('/api/suggestions/:site/dismiss', async (c) => {
    const site = c.req.param('site');
    const r = await loadRow(c.env, site);
    if (!r) return c.json({ error: 'not found' }, 404);
    if (r.status === 'new') await learn(c.env, r, -1, false);
    await c.env.DB.prepare("UPDATE suggestions SET status = 'dismissed', decided_at = ? WHERE site = ?").bind(now(), site).run();
    return c.json({ ok: true });
  });

  /** Undoes Follow or Not interested: back on the list, and what it taught is taken back. */
  app.post('/api/suggestions/:site/undo', async (c) => {
    const site = c.req.param('site');
    const r = await loadRow(c.env, site);
    if (!r) return c.json({ error: 'not found' }, 404);
    if (r.status === 'followed' && !r.ignored) await learn(c.env, r, r.soft_no_at ? 0 : -1, true);
    if (r.status === 'dismissed') await learn(c.env, r, 1, false);
    await c.env.DB.prepare(
      "UPDATE suggestions SET status = CASE WHEN feed_url IS NULL THEN 'nofeed' ELSE 'new' END, source_id = NULL, decided_at = NULL, ignored = 0, soft_no_at = NULL WHERE site = ?",
    )
      .bind(site)
      .run();
    return c.json({ ok: true });
  });

  /** Keeps a followed site but stops it teaching the list (its follow is taken back). */
  app.post('/api/suggestions/:site/ignore', async (c) => {
    const site = c.req.param('site');
    const input = (await c.req.json().catch(() => ({}))) as { on?: boolean };
    const r = await loadRow(c.env, site);
    if (!r || r.status !== 'followed') return c.json({ error: 'not found' }, 404);
    const on = input.on !== false;
    if (on && !r.ignored) await learn(c.env, r, r.soft_no_at ? 0 : -1, true);
    if (!on && r.ignored) await learn(c.env, r, 1, true);
    await c.env.DB.prepare('UPDATE suggestions SET ignored = ?, soft_no_at = NULL WHERE site = ?').bind(on ? 1 : 0, site).run();
    return c.json({ ok: true });
  });

  app.get('/api/suggestions/learnt', async (c) => {
    const [tunes, followedRows, hiddenRows, sources] = await Promise.all([
      loadTunes(c.env),
      c.env.DB.prepare("SELECT * FROM suggestions WHERE status = 'followed' AND source_id IS NOT NULL AND decided_at IS NOT NULL ORDER BY decided_at DESC LIMIT 50").all<Row>(),
      c.env.DB.prepare("SELECT site, title, decided_at FROM suggestions WHERE status = 'dismissed' ORDER BY decided_at DESC LIMIT 100").all<{
        site: string;
        title: string | null;
        decided_at: number | null;
      }>(),
      c.env.DB.prepare('SELECT id, name FROM sources').all<{ id: string; name: string }>(),
    ]);
    const names = new Map(sources.results.map((s) => [s.id, s.name]));
    const learnt: SuggestLearnt[] = [
      ...Object.entries(tunes.topics).map(([key, v]) => ({ key, label: v.label, kind: 'topic' as const, net: v.net })),
      ...Object.entries(tunes.sources)
        .filter(([id]) => names.has(id))
        .map(([key, net]) => ({ key, label: names.get(key)!, kind: 'source' as const, net })),
    ].sort((a, b) => b.net - a.net);
    const t = now();
    const followed: SuggestFollowed[] = [];
    for (const r of followedRows.results) {
      const c2 = await c.env.DB.prepare(
        'SELECT COUNT(*) AS n, COUNT(read_at) AS r, COUNT(interesting_at) AS s FROM items WHERE source_id = ? AND received_at >= ?',
      )
        .bind(r.source_id, r.decided_at ?? 0)
        .first<{ n: number; r: number; s: number }>();
      const n = c2?.n ?? 0;
      const read = c2?.r ?? 0;
      const old = t - (r.decided_at ?? t) >= SOFT_NO_AFTER_MS;
      followed.push({
        site: r.site,
        title: names.get(r.source_id!) ?? r.title ?? r.site,
        sourceId: r.source_id!,
        followedAt: r.decided_at!,
        items: n,
        read,
        starred: c2?.s ?? 0,
        verdict: n >= 5 && (old || read / n >= 0.3) ? (read / n < 0.1 ? 'not-opening' : 'reading') : null,
        ignored: r.ignored === 1,
      });
    }
    const body: SuggestLearntPage = {
      learnt,
      followed,
      hidden: hiddenRows.results.map((h) => ({ site: h.site, title: h.title ?? h.site, decidedAt: h.decided_at })),
    };
    return c.json(body);
  });

  /** Forgets one learnt topic or source, or everything. */
  app.post('/api/suggestions/learnt/forget', async (c) => {
    const input = (await c.req.json().catch(() => ({}))) as { kind?: string; key?: string; all?: boolean };
    const tunes = await loadTunes(c.env);
    if (input.all) {
      tunes.topics = {};
      tunes.sources = {};
    } else if (input.kind === 'topic' && input.key) delete tunes.topics[input.key];
    else if (input.kind === 'source' && input.key) delete tunes.sources[input.key];
    await writeJson(c.env, 'suggest_tunes', tunes);
    return c.json({ ok: true });
  });
}
