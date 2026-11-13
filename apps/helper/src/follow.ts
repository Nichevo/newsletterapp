import {
  HELPER_VERSION,
  SUGGEST_SKIP,
  cantFollow,
  findFeedLinks,
  parseFeed,
  siteKey,
  stripTags,
  topicFeeds,
  type FollowCandidate,
  type FollowJob,
  type FollowResult,
  type FollowThing,
  type FollowThingKind,
  type FollowVia,
  type HelperConfig,
  type ParsedFeed,
} from '@newsletterapp/shared';
import type { AppClient } from './app';
import type { LocalConfig } from './config';
import { fetchArticleText, getPage } from './fetch';
import { log } from './log';
import { braveSearch } from './lookups';
import { findProvider, type Provider } from './providers';
import { description, findFeed, postsPerWeek } from './suggest';

// Find a way to follow (the app's follow.ts has the outline). Stage 1 works
// out who and what a lookup is about; stage 2 looks for every way to follow
// each ticked thing, opens each one to check it works and is still active,
// and has the model drop look-alikes and write a line on each.

type Candidate = Omit<FollowCandidate, 'state' | 'sourceId'> & {
  /** Hard evidence it's the same person (their GitHub names their X handle, say): the model can't drop it. */
  sure?: boolean;
  /** Text the same-person check and the model look at. */
  blurb?: string;
};

const UA = `NewsletterAppHelper/${HELPER_VERSION} (personal newsletter reader; PC helper)`;
/** Time allowed for one lookup's search stage, so other work isn't held up for long. */
const SEARCH_MS = 6 * 60_000;
const MAX_BEST = 10;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
/** A page's host without www: personal sites often live on a shared domain (someone.notion.site), so the whole host is kept. */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^(www\d?|m)\./, '') || null;
  } catch {
    return null;
  }
}

/** Big platforms and reference sites are never someone's own outlet. */
const skipped = (url: string) => {
  const k = siteKey(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  const h = hostOf(url);
  return !k || !h || (SUGGEST_SKIP.has(k) && h === k) || SUGGEST_SKIP.has(h);
};

const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

function jsonOf(reply: string): Record<string, unknown> {
  const cleaned = stripThinking(reply).replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON');
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

async function getJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res || !res.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

// ---------- Is it the same person? ----------

/** How well a page's text matches a name or handle: the whole name or the handle is high, the surname alone medium. */
export function nameMatch(text: string, name: string, handle?: string | null): 'high' | 'medium' | 'low' {
  const t = ` ${norm(text)} `;
  const n = norm(name);
  if (n && t.includes(` ${n} `)) return 'high';
  if (handle && t.includes(` ${norm(handle)} `)) return 'high';
  // Squashed together: "willdepue" in a URL or handle.
  const squashed = t.replace(/ /g, '');
  if (n.includes(' ') && n.replace(/ /g, '').length >= 6 && squashed.includes(n.replace(/ /g, ''))) return 'high';
  const last = n.split(' ').pop() ?? '';
  if (n.includes(' ') && last.length >= 4 && t.includes(` ${last} `)) return 'medium';
  return 'low';
}

// ---------- Checking a feed ----------

function feedFacts(feed: ParsedFeed) {
  const entries = feed.entries;
  const times = entries.map((e) => e.publishedAt ?? 0);
  return {
    postsPerWeek: postsPerWeek(entries),
    lastPostAt: Math.max(0, ...times) || null,
    samples: entries.slice(0, 3).map((e) => ({ title: squash(e.title).slice(0, 200), url: e.url })),
    text: entries
      .slice(0, 5)
      .map((e) => e.title)
      .join(' · '),
  };
}

async function readFeed(url: string, cfg: LocalConfig): Promise<ParsedFeed | null> {
  const page = await getPage(url, cfg).catch(() => null);
  if (!page || page.held || page.status >= 400 || page.status === 0) return null;
  return parseFeed(page.body, page.url, 20);
}

/** A newsletter sign-up on a page: an email box in a form that talks about subscribing, or a newsletter platform's own page. */
export function looksLikeSignup(html: string, url: string): boolean {
  if (/(\.substack\.com|beehiiv\.com|buttondown\.(email|com)|ghost\.io|kit\.com|convertkit\.com|mailchi\.mp)/i.test(url)) return true;
  for (const form of html.match(/<form\b[\s\S]{0,4000}?<\/form>/gi) ?? []) {
    if (/type\s*=\s*["']?email/i.test(form) && /subscri|newsletter|sign\s*up|join/i.test(form)) return true;
  }
  return false;
}

// ---------- The ways to follow ----------

class Finder {
  readonly found = new Map<string, Candidate>();
  searches = 0;
  private sitesChecked = new Set<string>();
  private githubChecked = new Set<string>();

  constructor(
    private job: FollowJob,
    private cfg: LocalConfig,
    private until: number,
  ) {}

  get timeUp() {
    return Date.now() > this.until;
  }

  private add(c: Candidate) {
    const prev = this.found.get(c.key);
    // Keep the surer one when two routes find the same thing.
    const rank = (x: Candidate) => (x.sure ? 3 : x.same === 'high' ? 2 : x.same === 'medium' ? 1 : 0);
    if (!prev || rank(c) > rank(prev)) this.found.set(c.key, c);
  }

  private async search(q: string): Promise<{ title: string; url: string; text: string }[]> {
    if (!this.cfg.braveApiKey || this.searches >= this.job.searchesAllowed) return [];
    this.searches += 1;
    const results = await braveSearch(q, this.cfg.braveApiKey, 10).catch((err: unknown) => {
      log(`follow: search failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    });
    return results.map((r) => ({
      title: stripTags(r.title),
      url: r.url,
      text: stripTags([r.description ?? '', ...(r.extra_snippets ?? [])].join(' ')),
    }));
  }

  /** A site's own feed; else a newsletter sign-up; else (when asked) the page to watch. */
  async site(site: string, about: FollowThing, opts: { watchIfNoFeed: boolean; why?: string; sure?: boolean } = { watchIfNoFeed: true }) {
    if (this.sitesChecked.has(site) || this.timeUp) return;
    this.sitesChecked.add(site);
    const via: FollowVia = site.endsWith('.substack.com') ? 'substack' : 'website';
    const found = await findFeed(site, this.cfg).catch((err: unknown) => String(err));
    if (typeof found !== 'string') {
      const f = feedFacts(found.feed);
      const desc = description(found.homeHtml) ?? '';
      const title = found.feed.title?.trim() || site;
      this.add({
        key: found.feedUrl,
        group: 'best',
        via,
        title,
        url: found.home,
        feedUrl: found.feedUrl,
        why: opts.why ?? (desc ? desc.slice(0, 200) : `Posts from ${site}.`),
        about: about.name,
        same: about.kind === 'person' || about.kind === 'org' ? nameMatch(`${title} ${desc} ${site}`, about.name, about.handle) : null,
        sure: opts.sure,
        postsPerWeek: f.postsPerWeek,
        lastPostAt: f.lastPostAt,
        samples: f.samples,
        blurb: desc,
        signupUrl: looksLikeSignup(found.homeHtml, found.home) ? found.home : null,
      });
      return;
    }
    // No feed: a newsletter you can sign up to by email, or a page the PC can watch.
    const home = await getPage(`https://${site}/`, this.cfg).catch(() => null);
    if (!home || home.held || home.status >= 400 || home.status === 0) return;
    const desc = description(home.body) ?? '';
    const title = (/<title[^>]*>([^<]{1,200})/i.exec(home.body)?.[1] ?? site).trim();
    const same = about.kind === 'person' || about.kind === 'org' ? nameMatch(`${title} ${desc} ${site}`, about.name, about.handle) : null;
    if (looksLikeSignup(home.body, home.url)) {
      this.add({
        key: `newsletter:${site}`,
        group: 'best',
        via: 'newsletter',
        title,
        url: home.url,
        feedUrl: null,
        signupUrl: home.url,
        why: opts.why ?? 'A newsletter with no feed: sign up with an address of its own and issues arrive in your inbox.',
        about: about.name,
        same,
        sure: opts.sure,
        postsPerWeek: null,
        lastPostAt: null,
        samples: [],
        blurb: desc,
      });
    } else if (opts.watchIfNoFeed) {
      this.add({
        key: `watch:${home.url}`,
        group: 'best',
        via: 'website',
        title,
        url: home.url,
        feedUrl: null,
        watch: true,
        why: opts.why ?? 'No feed, so the PC would watch the page for new articles.',
        about: about.name,
        same,
        sure: opts.sure,
        postsPerWeek: null,
        lastPostAt: null,
        samples: [],
        blurb: desc,
      });
    }
  }

  /** A GitHub account: its public activity feed. Kept only when it's plainly the same person. */
  async github(login: string, about: FollowThing) {
    const key = login.toLowerCase();
    if (this.githubChecked.has(key) || this.timeUp) return;
    this.githubChecked.add(key);
    const u = await getJson<{ login: string; name: string | null; bio: string | null; blog: string | null; twitter_username: string | null; html_url: string; type: string }>(
      `https://api.github.com/users/${encodeURIComponent(login)}`,
    );
    if (!u) return;
    const handle = about.handle?.toLowerCase();
    const sure = !!handle && (u.twitter_username?.toLowerCase() === handle || u.login.toLowerCase() === handle) && nameMatch(`${u.name ?? ''} ${u.bio ?? ''}`, about.name) !== 'low';
    const same = sure ? 'high' : nameMatch(`${u.name ?? ''} ${u.login}`, about.name, about.handle);
    if (same === 'low') return;
    const feedUrl = `https://github.com/${u.login}.atom`;
    const feed = await readFeed(feedUrl, this.cfg);
    const f = feed ? feedFacts(feed) : null;
    this.add({
      key: feedUrl,
      group: 'best',
      via: 'github',
      title: `${u.name || u.login} on GitHub`,
      url: u.html_url,
      feedUrl,
      why: u.type === 'Organization' ? 'Their GitHub: new projects and releases.' : 'Their GitHub activity: new projects, releases and code they publish.',
      about: about.name,
      same,
      sure,
      postsPerWeek: f?.postsPerWeek ?? null,
      lastPostAt: f?.lastPostAt ?? null,
      samples: f?.samples ?? [],
      blurb: `${u.bio ?? ''} ${u.blog ?? ''}`,
    });
    // Their own website, from the profile.
    if (u.blog) {
      const site = hostOf(u.blog);
      if (site && !skipped(u.blog)) await this.site(site, about, { watchIfNoFeed: true, why: 'Their own website, linked from their GitHub.', sure });
    }
  }

  /** Bluesky has a feed for every profile. */
  async bluesky(about: FollowThing) {
    if (this.timeUp) return;
    const q = about.handle || about.name;
    const r = await getJson<{ actors?: { handle: string; displayName?: string; description?: string }[] }>(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors?q=${encodeURIComponent(q)}&limit=5`,
    );
    for (const a of r?.actors ?? []) {
      const nameSame = nameMatch(a.displayName ?? '', about.name);
      const handleSame = !!about.handle && a.handle.toLowerCase().split('.')[0] === about.handle.toLowerCase();
      if (nameSame !== 'high' && !handleSame) continue;
      const feedUrl = `https://bsky.app/profile/${a.handle}/rss`;
      const feed = await readFeed(feedUrl, this.cfg);
      if (!feed || feed.entries.length === 0) continue;
      const f = feedFacts(feed);
      this.add({
        key: feedUrl,
        group: 'best',
        via: 'bluesky',
        title: `${a.displayName || a.handle} on Bluesky`,
        url: `https://bsky.app/profile/${a.handle}`,
        feedUrl,
        why: 'Their Bluesky posts. Bluesky gives every profile a feed.',
        about: about.name,
        same: nameSame === 'high' && handleSame ? 'high' : 'medium',
        postsPerWeek: f.postsPerWeek,
        lastPostAt: f.lastPostAt,
        samples: f.samples,
        blurb: `${a.description ?? ''} Recent: ${f.text}`,
      });
      break;
    }
  }

  /** A YouTube channel page: its feed is linked from the page. */
  async youtube(url: string, about: FollowThing, title: string) {
    if (this.timeUp) return;
    const page = await getPage(url, this.cfg).catch(() => null);
    if (!page || page.held || page.status >= 400) return;
    const feedUrl = findFeedLinks(page.body, page.url).find((u) => /youtube\.com\/feeds\/videos\.xml\?channel_id=/i.test(u));
    if (!feedUrl) return;
    const feed = await readFeed(feedUrl, this.cfg);
    const f = feed ? feedFacts(feed) : null;
    const channel = feed?.title?.trim() || title.replace(/\s*-\s*YouTube\s*$/i, '');
    this.add({
      key: feedUrl,
      group: 'best',
      via: 'youtube',
      title: channel,
      url: page.url,
      feedUrl,
      why: 'Their YouTube channel: each new video.',
      about: about.name,
      same: nameMatch(`${channel} ${url}`, about.name, about.handle),
      postsPerWeek: f?.postsPerWeek ?? null,
      lastPostAt: f?.lastPostAt ?? null,
      samples: f?.samples ?? [],
      blurb: f?.text ?? '',
    });
  }

  /** News coverage that mentions a person, or a topic followed through news, Hacker News and Reddit search feeds. */
  async topic(name: string, about: FollowThing, only?: FollowVia[]) {
    for (const t of topicFeeds(name)) {
      if (this.timeUp) return;
      if (only && !only.includes(t.via)) continue;
      const feed = await readFeed(t.feedUrl, this.cfg);
      if (!feed || feed.entries.length === 0) continue;
      const f = feedFacts(feed);
      this.add({
        key: t.feedUrl,
        group: 'topic',
        via: t.via,
        title: t.title,
        url: t.url,
        feedUrl: t.feedUrl,
        viaPc: t.viaPc,
        why:
          t.via === 'news'
            ? `News stories that mention ${name}.`
            : t.via === 'hackernews'
              ? `New Hacker News posts that mention ${name}.`
              : `New Reddit posts that mention ${name}, from any subreddit.`,
        about: about.name,
        same: null,
        postsPerWeek: f.postsPerWeek,
        lastPostAt: f.lastPostAt,
        samples: f.samples,
      });
    }
  }

  cant(url: string, about: FollowThing) {
    const c = cantFollow(url);
    if (!c) return;
    const key = `cant:${c.via}:${(c.handle ?? about.name).toLowerCase()}`;
    this.add({
      key,
      group: 'cant',
      via: c.via,
      title: c.handle && c.via === 'x' ? `@${c.handle} on ${c.name}` : `${about.name} on ${c.name}`,
      url,
      feedUrl: null,
      why: c.why,
      about: about.name,
      same: null,
      postsPerWeek: null,
      lastPostAt: null,
      samples: [],
    });
  }

  async person(t: FollowThing, context: string) {
    if (t.url) {
      if (cantFollow(t.url)) this.cant(t.url, t);
      else {
        const k = hostOf(t.url);
        if (k && !skipped(t.url)) await this.site(k, t, { watchIfNoFeed: true });
      }
    }
    // Free checks first: they need no search.
    if (t.handle) {
      await this.github(t.handle, t);
      if (!this.timeUp) await this.site(`${t.handle.toLowerCase()}.substack.com`, t, { watchIfNoFeed: false });
    }
    await this.bluesky(t);

    // Then the web: where else they write.
    const queries = [`"${t.name}"${t.handle ? ` OR "${t.handle}"` : ''} blog OR newsletter OR substack OR github`];
    if (context) queries.push(`"${t.name}" ${context}`);
    const sites: string[] = [];
    for (const q of queries) {
      if (this.timeUp) break;
      for (const r of await this.search(q)) {
        const text = `${r.title} ${r.text} ${r.url}`;
        if (cantFollow(r.url)) {
          if (nameMatch(text, t.name, t.handle) !== 'low') this.cant(r.url, t);
          continue;
        }
        const gh = /^https?:\/\/(www\.)?github\.com\/([\w-]+)\/?$/i.exec(r.url);
        if (gh) {
          await this.github(gh[2]!, t);
          continue;
        }
        if (/^https?:\/\/(www\.)?youtube\.com\/(@[\w.-]+|channel\/[\w-]+|c\/[\w-]+)\/?$/i.test(r.url)) {
          if (nameMatch(text, t.name, t.handle) !== 'low') await this.youtube(r.url, t, r.title);
          continue;
        }
        const k = hostOf(r.url);
        if (!k || skipped(r.url) || sites.includes(k)) continue;
        // Only sites that look like theirs: the name or handle in the result.
        if (nameMatch(text, t.name, t.handle) === 'low') continue;
        sites.push(k);
      }
    }
    for (const k of sites.slice(0, 5)) {
      if (this.timeUp) break;
      await this.site(k, t, { watchIfNoFeed: nameMatch(k, t.name, t.handle) !== 'low' });
    }
    // Coverage of them in the news.
    if (!this.timeUp) await this.topic(t.name, t, ['news']);
  }

  async run(things: FollowThing[]) {
    const topics = things.filter((t) => t.on && t.kind === 'topic').map((t) => t.name);
    // Sites first, so the site an article came from is listed as itself rather than as someone's look-alike.
    const order: Record<FollowThingKind, number> = { site: 0, subreddit: 1, person: 2, org: 2, topic: 3 };
    for (const t of things.filter((x) => x.on).sort((a, b) => order[a.kind] - order[b.kind])) {
      if (this.timeUp) break;
      if (t.kind === 'person' || t.kind === 'org') await this.person(t, topics[0] ?? '');
      else if (t.kind === 'site') {
        const k = hostOf(t.url ?? (t.name.includes('.') ? t.name : ''));
        const article = !!t.url && /^https?:\/\/[^/]+\/[^?#]+/i.test(t.url);
        if (k)
          await this.site(k, t, {
            watchIfNoFeed: true,
            why: article ? 'Where the page you gave was published: everything the site puts out.' : 'The site itself: everything it publishes.',
          });
      } else if (t.kind === 'topic') await this.topic(t.name, t);
      else if (t.kind === 'subreddit') {
        const sub = t.name.replace(/^\/?r\//i, '').split(/[/\s]/)[0]!;
        const feedUrl = `https://www.reddit.com/r/${sub}/top/.rss?t=day`;
        const feed = await readFeed(feedUrl, this.cfg);
        if (feed) {
          const f = feedFacts(feed);
          this.add({
            key: feedUrl,
            group: 'best',
            via: 'reddit',
            title: `r/${sub}`,
            url: `https://www.reddit.com/r/${sub}/`,
            feedUrl,
            viaPc: true,
            why: 'The top posts of the day from this subreddit.',
            about: t.name,
            same: null,
            postsPerWeek: f.postsPerWeek,
            lastPostAt: f.lastPostAt,
            samples: f.samples,
          });
        }
      }
    }
  }
}

// ---------- The model ----------

const UNDERSTAND_SCHEMA = {
  type: 'object',
  properties: {
    things: {
      type: 'array',
      items: {
        type: 'object',
        properties: { kind: { type: 'string' }, name: { type: 'string' }, handle: { type: 'string' }, url: { type: 'string' } },
        required: ['kind', 'name'],
      },
    },
  },
  required: ['things'],
};

const RANK_SCHEMA = {
  type: 'object',
  properties: {
    ways: {
      type: 'array',
      items: {
        type: 'object',
        properties: { n: { type: 'number' }, keep: { type: 'boolean' }, same: { type: 'string' }, why: { type: 'string' } },
        required: ['n', 'keep'],
      },
    },
  },
  required: ['ways'],
};

/** What a link is about, for the model: an X post through X's own embed service, anything else read by the PC. */
async function linkContext(url: string, cfg: LocalConfig): Promise<string> {
  if (/^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\/[^/]+\/status\/\d+/i.test(url)) {
    const o = await getJson<{ author_name?: string; author_url?: string; html?: string }>(
      `https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(url)}`,
    );
    if (o) return `An X post by ${o.author_name ?? '?'} (${o.author_url ?? ''}): ${stripTags(o.html ?? '').slice(0, 1500)}`;
  }
  const page = await fetchArticleText(url, cfg).catch(() => null);
  if (!page) return `A link: ${url}`;
  return `A page at ${page.url}${page.title ? `, titled "${page.title}"` : ''}:\n${squash(page.text).slice(0, 4000)}`;
}

/** Without a model: an @handle is a person, a link is its site (or the person on X), anything short is a topic. */
export function guessThings(query: string, url: string | null): FollowThing[] {
  const q = query.trim();
  const out: FollowThing[] = [];
  const handle = /^@([\w.]{2,40})$/.exec(q)?.[1];
  if (handle) out.push({ kind: 'person', name: handle, handle, url: null, on: true });
  if (url) {
    const c = cantFollow(url);
    if (c?.handle) out.push({ kind: 'person', name: c.handle, handle: c.handle, url, on: true });
    else if (!c) {
      const k = hostOf(url);
      if (k && !skipped(url)) out.push({ kind: 'site', name: k, url, on: true });
    }
  }
  if (out.length === 0 && q && !/^https?:\/\//i.test(q) && q.split(/\s+/).length <= 6) out.push({ kind: 'topic', name: q, url: null, on: true });
  return out;
}

async function understand(job: FollowJob, cfg: LocalConfig, provider: Provider | null, model: string | null): Promise<FollowThing[]> {
  const parts = [job.query !== job.url ? `They typed: ${job.query}` : ''];
  if (job.url) parts.push(await linkContext(job.url, cfg));
  const user = parts.filter(Boolean).join('\n\n');
  let things: FollowThing[] = [];
  if (provider && model) {
    try {
      const reply = await provider.complete(model, job.understandPrompt, user, { json: true, schema: UNDERSTAND_SCHEMA });
      const raw = jsonOf(reply).things;
      things = (Array.isArray(raw) ? raw : []).map((t) => {
        const x = t as Record<string, unknown>;
        const handle = typeof x.handle === 'string' ? x.handle.replace(/^@/, '').trim() : '';
        const url = typeof x.url === 'string' ? x.url.trim() : '';
        return {
          kind: String(x.kind ?? '').toLowerCase() as FollowThingKind,
          name: String(x.name ?? '').trim(),
          handle: handle || null,
          url: /^https?:\/\//i.test(url) ? url : null,
          on: true,
        };
      });
    } catch (err) {
      log(`follow: the model couldn't read "${job.query.slice(0, 60)}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const guessed = guessThings(job.query, job.url);
  if (things.length === 0) return guessed;
  // A link to an article: make sure the site it came from is in the list.
  const site = guessed.find((g) => g.kind === 'site');
  if (site && !things.some((t) => t.kind === 'site' && (t.url ? hostOf(t.url) : t.name.toLowerCase()) === site.name)) things.push({ ...site, on: true });
  return things;
}

const SAME_ORDER = { high: 0, medium: 1, low: 2 } as const;

/** One model call per person or organisation: drop look-alikes, set how sure, write the line. */
async function rank(job: FollowJob, things: FollowThing[], found: Candidate[], provider: Provider | null, model: string | null): Promise<Candidate[]> {
  let list = found;
  if (provider && model) {
    for (const t of things.filter((x) => x.on && (x.kind === 'person' || x.kind === 'org'))) {
      const mine = list.filter((c) => c.group === 'best' && c.about === t.name);
      if (mine.length === 0) continue;
      const user = mine
        .map((c, i) => `${i + 1}. ${c.title} (${c.url})${c.blurb ? `\n   ${squash(c.blurb).slice(0, 400)}` : ''}${c.samples.length ? `\n   Recent: ${c.samples.map((s) => s.title).join(' · ')}` : ''}`)
        .join('\n');
      try {
        const reply = await provider.complete(
          model,
          job.rankPrompt.replace('{about}', `${t.name}${t.handle ? ` (@${t.handle})` : ''}, a ${t.kind === 'org' ? 'company or organisation' : 'person'}`),
          user,
          { json: true, schema: RANK_SCHEMA },
        );
        const ways = jsonOf(reply).ways;
        const drop = new Set<string>();
        for (const w of Array.isArray(ways) ? ways : []) {
          const x = w as { n?: number; keep?: boolean; same?: string; why?: string };
          const c = mine[(Number(x.n) || 0) - 1];
          if (!c) continue;
          if (x.keep === false && !c.sure) drop.add(c.key);
          if (!c.sure && (x.same === 'high' || x.same === 'medium' || x.same === 'low')) c.same = x.same;
          if (typeof x.why === 'string' && x.why.trim()) c.why = x.why.trim().slice(0, 300);
        }
        list = list.filter((c) => !drop.has(c.key));
      } catch (err) {
        log(`follow: couldn't rank the ways to follow ${t.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // Best first: surest, then ones with a feed, then the most recently active.
  const best = list
    .filter((c) => c.group === 'best')
    .sort(
      (a, b) =>
        SAME_ORDER[a.same ?? 'high'] - SAME_ORDER[b.same ?? 'high'] ||
        Number(!!b.feedUrl) - Number(!!a.feedUrl) ||
        (b.lastPostAt ?? 0) - (a.lastPostAt ?? 0),
    )
    .slice(0, MAX_BEST);
  return [...best, ...list.filter((c) => c.group === 'topic'), ...list.filter((c) => c.group === 'cant')];
}

// ---------- The round ----------

export async function runFollow(config: HelperConfig, app: AppClient, cfg: LocalConfig, providers: Provider[], doing: (what: string) => void): Promise<void> {
  if (!config.followWaiting) return;
  const ref = config.models.find((m) => findProvider(providers, m));
  const provider = ref ? findProvider(providers, ref)! : null;
  const model = ref?.name ?? null;
  for (let n = 0; n < 3; n++) {
    const { job } = await app.followClaim();
    if (!job) return;
    const started = performance.now();
    const base = { lookupId: job.lookupId, stage: job.stage, provider: ref?.provider, model: model ?? undefined };
    try {
      if (job.stage === 'understand') {
        doing('finding a way to follow: working out what to look for');
        const things = await understand(job, cfg, provider, model);
        await app.followResult({ ...base, ok: true, things, searches: 0, seconds: (performance.now() - started) / 1000 });
        log(`follow: "${job.query.slice(0, 60)}" is about ${things.map((t) => `${t.kind} ${t.name}`).join(', ') || 'nothing I could tell'}`);
      } else {
        doing('finding a way to follow: searching');
        const finder = new Finder(job, cfg, Date.now() + SEARCH_MS);
        await finder.run(job.things);
        const candidates = (await rank(job, job.things, [...finder.found.values()], provider, model)).map(({ sure: _s, blurb: _b, ...c }) => c);
        await app.followResult({ ...base, ok: true, candidates, searches: finder.searches, seconds: (performance.now() - started) / 1000 });
        log(`follow: found ${candidates.length} ways to follow "${job.query.slice(0, 60)}" with ${finder.searches} searches`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log(`follow: lookup failed: ${error}`);
      await app.followResult({ ...base, ok: false, error: error.slice(0, 300), searches: 0 }).catch(() => undefined);
    }
  }
}
