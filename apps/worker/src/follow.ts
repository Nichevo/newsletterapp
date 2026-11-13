import {
  siteKey,
  type FollowCandidate,
  type FollowJob,
  type FollowLookup,
  type FollowLookupListItem,
  type FollowResult,
  type FollowStatus,
  type FollowThing,
  type FollowThingKind,
  type NewFollowLookup,
} from '@newsletterapp/shared';
import type { Hono } from 'hono';
import { loadState, readJson } from './ai';
import type { AppVariables, Env } from './env';
import { newId, now } from './ids';
import { countSearches, searchAllowance } from './websearch';

// Find a way to follow. The owner gives a name, @handle, site, topic or link
// (Add > Find a way to follow, or a link shared into the app). The PC helper
// then works in two stages:
//  1. understand: the local model lists who and what it's about. When it
//     finds several things, the owner unticks the ones not wanted before any
//     searching (a screenshot of a Reddit post names everyone who replied);
//  2. search: free direct checks (GitHub, Bluesky, Substack, the site's own
//     feed, topic feeds) plus a few Brave searches from the monthly budget,
//     then each candidate is opened and checked, and the model weeds out
//     look-alikes and writes one line on each.
// The Worker only stores the lookup and marks ways you already follow.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const LEASE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3;
/** Web searches one lookup may use, at most. */
const SEARCHES_PER_LOOKUP = 6;
const KINDS: FollowThingKind[] = ['person', 'org', 'site', 'topic', 'subreddit'];

const UNDERSTAND_PROMPT = `You help someone find ways to keep following a person, organisation, website or topic in their reading app.
From what they gave you, list the people, organisations, websites, subreddits and topics they would most likely want to follow, most important first, at most 6.
- Give @handles without the @ when they are shown.
- Leave out people only mentioned in passing or just reacting (for example someone replying with an emoji), and leave out the platforms themselves (Reddit, X, YouTube).
- For a topic, use the short phrase someone would search for (2 to 4 words).
- A site is the website an article came from; give its address.
Reply with JSON only, in this shape:
{"things":[{"kind":"person|org|site|topic|subreddit","name":"...","handle":"...","url":"..."}]}`;

const RANK_PROMPT = `Someone wants to keep following: {about}.
Below are possible ways to follow, numbered, each with its title, address, a description and recent post titles where known.
For each one decide:
- keep: true if it really is this person's or organisation's own outlet, or is clearly about this topic; false if it is a different person with the same name, an unrelated site, a shop or spam.
- same: "high", "medium" or "low" for how sure you are it is the same person or organisation; "none" for topic coverage.
- why: one short plain sentence for the reader on what they would get, e.g. "His GitHub. New projects often show up here before he writes about them."
Reply with JSON only, in this shape:
{"ways":[{"n":1,"keep":true,"same":"high","why":"..."}]}`;

interface Row {
  id: string;
  query: string;
  url: string | null;
  stage: 'understand' | 'search';
  status: 'waiting' | 'working' | 'confirm' | 'done' | 'failed';
  things: string;
  candidates: string;
  error: string | null;
  searches: number;
  model: string | null;
  attempts: number;
  claimed_at: number | null;
  created_at: number;
  finished_at: number | null;
}

const parse = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

function statusOf(r: Pick<Row, 'stage' | 'status'>): FollowStatus {
  if (r.status === 'waiting' || r.status === 'working') return r.stage === 'understand' ? 'understanding' : 'searching';
  return r.status;
}

function toLookup(r: Row): FollowLookup {
  return {
    id: r.id,
    query: r.query,
    url: r.url,
    status: statusOf(r),
    things: parse<FollowThing[]>(r.things, []),
    candidates: parse<FollowCandidate[]>(r.candidates, []),
    error: r.error,
    searches: r.searches,
    model: r.model,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

function cleanThings(v: unknown): FollowThing[] {
  const out: FollowThing[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(v) ? v : []) {
    const kind = clean((t as FollowThing)?.kind, 20) as FollowThingKind;
    const name = clean((t as FollowThing)?.name, 120);
    if (!KINDS.includes(kind) || !name) continue;
    const key = `${kind}:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const handle = clean((t as FollowThing)?.handle, 60).replace(/^@/, '') || null;
    const url = clean((t as FollowThing)?.url, 500);
    out.push({ kind, name, handle, url: /^https?:\/\//i.test(url) ? url : null, on: (t as FollowThing)?.on !== false });
    if (out.length >= 8) break;
  }
  return out;
}

const VIAS = new Set([
  'website', 'newsletter', 'substack', 'github', 'youtube', 'reddit', 'bluesky', 'mastodon', 'podcast', 'news', 'hackernews',
  'x', 'linkedin', 'threads', 'instagram', 'facebook', 'tiktok',
]);

function cleanCandidates(v: unknown): FollowCandidate[] {
  const out: FollowCandidate[] = [];
  const seen = new Set<string>();
  for (const c of Array.isArray(v) ? v.slice(0, 60) : []) {
    const x = c as Partial<FollowCandidate>;
    const key = clean(x.key, 500);
    const url = clean(x.url, 1000);
    if (!key || seen.has(key) || !/^https?:\/\//i.test(url) || !VIAS.has(String(x.via))) continue;
    seen.add(key);
    const feedUrl = clean(x.feedUrl, 1000);
    const signupUrl = clean(x.signupUrl, 1000);
    out.push({
      key,
      group: x.group === 'topic' || x.group === 'cant' ? x.group : 'best',
      via: x.via as FollowCandidate['via'],
      title: clean(x.title, 200) || url,
      url,
      feedUrl: /^https?:\/\//i.test(feedUrl) ? feedUrl : null,
      watch: x.watch === true,
      signupUrl: /^https?:\/\//i.test(signupUrl) ? signupUrl : null,
      why: clean(x.why, 300),
      about: clean(x.about, 120) || undefined,
      same: x.same === 'high' || x.same === 'medium' || x.same === 'low' ? x.same : null,
      postsPerWeek: typeof x.postsPerWeek === 'number' && Number.isFinite(x.postsPerWeek) ? Math.round(x.postsPerWeek * 10) / 10 : null,
      lastPostAt: typeof x.lastPostAt === 'number' && x.lastPostAt > 0 ? x.lastPostAt : null,
      samples: (Array.isArray(x.samples) ? x.samples : [])
        .slice(0, 3)
        .map((s) => ({ title: clean(s?.title, 200), url: /^https?:\/\//i.test(String(s?.url)) ? clean(s?.url, 1000) : null }))
        .filter((s) => s.title),
      viaPc: x.viaPc === true,
      state: 'new',
      sourceId: null,
    });
  }
  return out;
}

/** Marks the ways you already follow, by feed address or by site, and keeps what you did with ones found before. */
async function markFollowed(env: Env, list: FollowCandidate[], before: FollowCandidate[]): Promise<FollowCandidate[]> {
  const sources = await env.DB.prepare("SELECT id, kind, url, feed_url FROM sources WHERE kind IN ('feed', 'site')").all<{
    id: string;
    kind: string;
    url: string | null;
    feed_url: string | null;
  }>();
  const byFeed = new Map<string, string>();
  const bySite = new Map<string, string>();
  for (const s of sources.results) {
    if (s.feed_url) byFeed.set(s.feed_url.toLowerCase(), s.id);
    // Sites only count for blogs and news sites: following one subreddit isn't following all of Reddit.
    const k = s.url ? siteKey(s.url) : null;
    if (k && s.kind === 'site') bySite.set(k, s.id);
  }
  const old = new Map(before.map((c) => [c.key, c]));
  return list.map((c) => {
    const prev = old.get(c.key);
    if (prev && prev.state !== 'new') return { ...c, state: prev.state, sourceId: prev.sourceId ?? null };
    if (c.group === 'cant') return c;
    const id = (c.feedUrl && byFeed.get(c.feedUrl.toLowerCase())) || (c.watch && siteKey(c.url) ? bySite.get(siteKey(c.url)!) : undefined);
    return id ? { ...c, state: 'already' as const, sourceId: id } : c;
  });
}

async function load(env: Env, id: string): Promise<Row | null> {
  return env.DB.prepare('SELECT * FROM follow_lookups WHERE id = ?').bind(id).first<Row>();
}

export async function followHeartbeat(env: Env, paused: boolean): Promise<{ followWaiting?: boolean }> {
  if (paused) return {};
  const row = await env.DB.prepare(
    "SELECT 1 AS x FROM follow_lookups WHERE status = 'waiting' OR (status = 'working' AND claimed_at < ?) LIMIT 1",
  )
    .bind(now() - LEASE_MS)
    .first();
  return row ? { followWaiting: true } : {};
}

async function claimJob(env: Env): Promise<FollowJob | null> {
  const t = now();
  await env.DB.prepare(
    `UPDATE follow_lookups SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'waiting' END,
       error = CASE WHEN attempts >= ? THEN COALESCE(error, 'Timed out on the PC') ELSE error END
     WHERE status = 'working' AND claimed_at < ?`,
  )
    .bind(MAX_ATTEMPTS, MAX_ATTEMPTS, t - LEASE_MS)
    .run();
  const row = await env.DB.prepare("SELECT * FROM follow_lookups WHERE status = 'waiting' ORDER BY created_at LIMIT 1").first<Row>();
  if (!row) return null;
  const claimed = await env.DB.prepare(
    "UPDATE follow_lookups SET status = 'working', claimed_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'waiting'",
  )
    .bind(t, row.id)
    .run();
  if (!claimed.meta.changes) return null;
  const allowance = row.stage === 'search' ? (await searchAllowance(env)).summaries : 0;
  return {
    lookupId: row.id,
    stage: row.stage,
    query: row.query,
    url: row.url,
    things: parse<FollowThing[]>(row.things, []),
    searchesAllowed: Math.max(0, Math.min(SEARCHES_PER_LOOKUP, allowance)),
    understandPrompt: UNDERSTAND_PROMPT,
    rankPrompt: RANK_PROMPT,
  };
}

async function saveResult(env: Env, r: FollowResult): Promise<void> {
  const row = await load(env, r.lookupId);
  if (!row || row.status !== 'working') return;
  await countSearches(env, 'lookups', r.searches);
  const t = now();
  const model = r.model ? clean(r.model, 120) : row.model;
  if (!r.ok) {
    await env.DB.prepare("UPDATE follow_lookups SET status = 'failed', error = ?, model = ?, finished_at = ?, searches = searches + ? WHERE id = ?")
      .bind(clean(r.error, 300) || 'The PC could not finish this lookup', model, t, Math.max(0, Math.round(r.searches || 0)), row.id)
      .run();
    return;
  }
  if (r.stage === 'understand') {
    const things = cleanThings(r.things);
    if (things.length === 0) {
      await env.DB.prepare("UPDATE follow_lookups SET status = 'failed', error = ?, model = ?, finished_at = ? WHERE id = ?")
        .bind("Couldn't tell who or what to look for. Try a name, an @handle or a link.", model, t, row.id)
        .run();
      return;
    }
    // One thing: nothing to choose, so search straight away. Several: the owner picks first.
    const next = things.length === 1 ? "stage = 'search', status = 'waiting', attempts = 0" : "status = 'confirm'";
    await env.DB.prepare(`UPDATE follow_lookups SET things = ?, model = ?, ${next} WHERE id = ?`).bind(JSON.stringify(things), model, row.id).run();
    return;
  }
  const candidates = await markFollowed(env, cleanCandidates(r.candidates), parse<FollowCandidate[]>(row.candidates, []));
  await env.DB.prepare(
    "UPDATE follow_lookups SET status = 'done', candidates = ?, error = NULL, model = ?, finished_at = ?, searches = searches + ? WHERE id = ?",
  )
    .bind(JSON.stringify(candidates), model, t, Math.max(0, Math.round(r.searches || 0)), row.id)
    .run();
}

async function view(env: Env, row: Row): Promise<FollowLookup> {
  const lookup = toLookup(row);
  if (lookup.status === 'understanding' || lookup.status === 'searching') {
    const [helper, state] = await Promise.all([readJson<{ lastSeenAt?: number }>(env, 'helper'), loadState(env)]);
    lookup.helperLastSeenAt = helper?.lastSeenAt ?? null;
    lookup.aiPaused = state.paused;
  }
  return lookup;
}

export function registerFollow(app: App) {
  // ----- The owner's side -----

  app.get('/api/follow', async (c) => {
    const rows = await c.env.DB.prepare(
      'SELECT id, query, stage, status, candidates, created_at FROM follow_lookups ORDER BY created_at DESC LIMIT 50',
    ).all<Pick<Row, 'id' | 'query' | 'stage' | 'status' | 'candidates' | 'created_at'>>();
    const list: FollowLookupListItem[] = rows.results.map((r) => {
      const cands = parse<FollowCandidate[]>(r.candidates, []);
      return {
        id: r.id,
        query: r.query,
        status: statusOf(r),
        createdAt: r.created_at,
        found: cands.filter((x) => x.group !== 'cant').length,
        followed: cands.filter((x) => x.state === 'followed').length,
      };
    });
    return c.json(list);
  });

  app.post('/api/follow', async (c) => {
    const input = (await c.req.json().catch(() => null)) as NewFollowLookup | null;
    const query = clean(input?.query, 2000);
    const urlIn = clean(input?.url, 1000) || (/^https?:\/\/\S+$/i.test(query) ? query : '');
    if (!query && !urlIn) return c.json({ error: 'Type a name, @handle, site or topic, or paste a link' }, 400);
    const id = newId();
    await c.env.DB.prepare('INSERT INTO follow_lookups (id, query, url, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, query || urlIn, /^https?:\/\//i.test(urlIn) ? urlIn : null, now())
      .run();
    return c.json(await view(c.env, (await load(c.env, id))!), 201);
  });

  app.get('/api/follow/:id', async (c) => {
    const row = await load(c.env, c.req.param('id'));
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json(await view(c.env, row));
  });

  // Look for the ticked things (from the "What the PC found" list), or look again.
  app.put('/api/follow/:id/things', async (c) => {
    const row = await load(c.env, c.req.param('id'));
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row.status === 'waiting' || row.status === 'working') return c.json({ error: 'Still working on it' }, 409);
    const body = (await c.req.json().catch(() => null)) as { things?: unknown } | null;
    const things = cleanThings(body?.things);
    if (!things.some((t) => t.on)) return c.json({ error: 'Tick at least one thing to look for' }, 400);
    await c.env.DB.prepare(
      "UPDATE follow_lookups SET things = ?, stage = 'search', status = 'waiting', attempts = 0, error = NULL, finished_at = NULL WHERE id = ?",
    )
      .bind(JSON.stringify(things), row.id)
      .run();
    return c.json(await view(c.env, (await load(c.env, row.id))!));
  });

  // Try again after a failure (from the start if the PC never understood it).
  app.post('/api/follow/:id/again', async (c) => {
    const row = await load(c.env, c.req.param('id'));
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row.status === 'waiting' || row.status === 'working') return c.json(await view(c.env, row));
    const stage = parse<FollowThing[]>(row.things, []).length ? 'search' : 'understand';
    await c.env.DB.prepare("UPDATE follow_lookups SET stage = ?, status = 'waiting', attempts = 0, error = NULL, finished_at = NULL WHERE id = ?")
      .bind(stage, row.id)
      .run();
    return c.json(await view(c.env, (await load(c.env, row.id))!));
  });

  // Followed, Not now, or back to new (Undo).
  app.post('/api/follow/:id/candidates', async (c) => {
    const row = await load(c.env, c.req.param('id'));
    if (!row) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => null)) as { key?: string; state?: string; sourceId?: string | null } | null;
    const state = body?.state;
    if (!body?.key || (state !== 'new' && state !== 'followed' && state !== 'dismissed')) return c.json({ error: 'bad request' }, 400);
    const list = parse<FollowCandidate[]>(row.candidates, []);
    const i = list.findIndex((x) => x.key === body.key);
    if (i < 0) return c.json({ error: 'not found' }, 404);
    list[i] = { ...list[i]!, state, sourceId: state === 'followed' ? clean(body.sourceId, 40) || null : null };
    await c.env.DB.prepare('UPDATE follow_lookups SET candidates = ? WHERE id = ?').bind(JSON.stringify(list), row.id).run();
    return c.json(list[i]);
  });

  app.delete('/api/follow/:id', async (c) => {
    await c.env.DB.prepare('DELETE FROM follow_lookups WHERE id = ?').bind(c.req.param('id')).run();
    return c.json({ ok: true });
  });

  // ----- The PC's side -----

  app.post('/api/helper/follow/claim', async (c) => {
    const state = await loadState(c.env);
    if (state.paused) return c.json({ job: null, paused: true });
    return c.json({ job: await claimJob(c.env) });
  });

  app.post('/api/helper/follow/result', async (c) => {
    const r = (await c.req.json().catch(() => null)) as FollowResult | null;
    if (!r || typeof r.lookupId !== 'string' || (r.stage !== 'understand' && r.stage !== 'search')) return c.json({ error: 'bad result' }, 400);
    await saveResult(c.env, r);
    return c.json({ ok: true });
  });
}
