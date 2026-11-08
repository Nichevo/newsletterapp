import {
  COMMON_FEED_PATHS,
  attr,
  findFeedLinks,
  looksBlocked,
  outboundSites,
  pageTitle,
  parseFeed,
  platformOf,
  siteKey,
  stripTags,
  type FeedEntry,
  type HelperConfig,
  type LinkResult,
  type ParsedFeed,
  type SuggestCheckResult,
} from '@newsletterapp/shared';
import type { AppClient } from './app';
import type { LocalConfig } from './config';
import type { Embeddings } from './embed';
import { getPage } from './fetch';
import { log } from './log';

// Feed suggestions, once a week (or when asked from the Suggested page):
//  1. count the outside sites each item you read, saved or starred links to
//     (the first run works through the last six months, a few hundred a round);
//  2. ask the app which of the most-linked sites to check;
//  3. for each, find its feed, read the latest posts and compare them with
//     your Interesting stars using the local embeddings.
// Mail-tracking links are only counted when their destination is written into
// the link; they are never opened, since that would count as a click to the
// sender.

const LINK_BATCH = 10;
/** Time allowed per round for each part, so other work isn't held up; the rest carries on next round. */
const LINKS_MS = 3 * 60_000;
const CHECKS_MS = 6 * 60_000;

function description(html: string): string | null {
  const head = html.slice(0, 100_000);
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = (attr(tag, 'name') ?? attr(tag, 'property') ?? '').toLowerCase();
    if (name === 'description' || name === 'og:description') {
      const v = attr(tag, 'content');
      if (v) return v.slice(0, 300);
    }
  }
  return null;
}

function postsPerWeek(entries: FeedEntry[]): number | null {
  const times = entries.map((e) => e.publishedAt).filter((t): t is number => typeof t === 'number' && t > 0).sort((a, b) => b - a);
  if (times.length < 2) return null;
  // Up to the newest 20 posts; the span runs to now, so a site that stopped posting reads as slow.
  const recent = times.slice(0, 20);
  const weeks = Math.max((Date.now() - recent[recent.length - 1]!) / (7 * 86_400_000), 1 / 7);
  return Math.round((recent.length / weeks) * 10) / 10;
}

/** Finds a site's feed: the ones its home page advertises, else the usual addresses. */
async function findFeed(site: string, cfg: LocalConfig): Promise<{ feedUrl: string; feed: ParsedFeed; home: string; homeHtml: string } | string> {
  const home = await getPage(`https://${site}/`, cfg).catch((err: unknown) => ({ status: 0, url: `https://${site}/`, body: '', held: String(err) }));
  if ('held' in home && home.held) return home.held;
  if (home.status >= 400 || home.status === 0) return `The site answered ${home.status || 'nothing'}`;
  if (looksBlocked(home.status, home.body)) return 'The site turned the PC away';
  const advertised = findFeedLinks(home.body, home.url).filter((u) => !platformOf(u));
  const tries = advertised.length ? advertised.slice(0, 3) : COMMON_FEED_PATHS.slice(0, 4).map((p) => new URL(p, home.url).toString());
  for (const url of tries) {
    const page = await getPage(url, cfg).catch(() => null);
    if (!page || page.held || page.status >= 400) continue;
    const feed = parseFeed(page.body, page.url, 20);
    if (feed && feed.entries.length > 0) return { feedUrl: page.url, feed, home: home.url, homeHtml: home.body };
  }
  return 'No feed found';
}

async function check(site: string, cfg: LocalConfig, embeddings: Embeddings, interesting: string[]): Promise<SuggestCheckResult> {
  const empty: SuggestCheckResult = {
    site,
    feedUrl: null,
    siteUrl: null,
    title: null,
    description: null,
    samples: [],
    postsPerWeek: null,
    lastPostAt: null,
    fit: null,
    near: [],
  };
  const found = await findFeed(site, cfg);
  if (typeof found === 'string') return { ...empty, error: found };
  const { feed, feedUrl } = found;
  const entries = feed.entries;
  const texts = entries.slice(0, 8).map((e) => `${e.title}\n${e.text ?? stripTags(e.html ?? '').slice(0, 600)}`.slice(0, 1200));
  const { fit, near } = await embeddings.closeness(texts, interesting).catch((err: unknown) => {
    log(`suggestions: could not score ${site}:`, err);
    return { fit: null, near: [] as string[] };
  });
  const times = entries.map((e) => e.publishedAt ?? 0);
  return {
    site,
    feedUrl,
    // The feed's own idea of its site, unless that points somewhere else entirely.
    siteUrl: feed.siteUrl && siteKey(feed.siteUrl) === site ? feed.siteUrl : found.home,
    title: feed.title?.trim() || pageTitle(found.homeHtml) || site,
    description: description(found.homeHtml),
    samples: entries.slice(0, 3).map((e) => ({ title: e.title, url: e.url })),
    postsPerWeek: postsPerWeek(entries),
    lastPostAt: Math.max(...times) || null,
    fit,
    near,
  };
}

/** One round of the weekly run. Returns once its time is up; the app keeps it due until it's finished. */
export async function runSuggestions(
  config: HelperConfig,
  app: AppClient,
  cfg: LocalConfig,
  embeddings: Embeddings,
  between: () => Promise<void>,
): Promise<void> {
  if (!config.suggestDue) return;

  // 1. Links in what you read.
  const linksUntil = Date.now() + LINKS_MS;
  let counted = 0;
  for (;;) {
    if (Date.now() > linksUntil) {
      log(`suggestions: counted links in ${counted} items; more next round`);
      return;
    }
    const { jobs } = await app.linksClaim(LINK_BATCH);
    if (jobs.length === 0) break;
    const results: LinkResult[] = jobs.map((j) => {
      const own = new Set<string>();
      const k = j.webUrl ? siteKey(j.webUrl) : null;
      if (k) own.add(k);
      return { itemId: j.itemId, sites: outboundSites(j.html, own) };
    });
    await app.linksResult(results);
    counted += jobs.length;
    await between();
  }
  if (counted) log(`suggestions: counted links in ${counted} items`);

  // 2. Which sites to check.
  const run = await app.suggestStart();
  if (run.checks.length === 0) {
    await app.suggestResult([], true);
    log('suggestions: nothing new to check');
    return;
  }
  const { interesting } = await app.likelyState();

  // 3. Check each one, sending results as they come.
  const checksUntil = Date.now() + CHECKS_MS;
  let found = 0;
  for (let i = 0; i < run.checks.length; i++) {
    if (Date.now() > checksUntil) {
      log(`suggestions: checked ${i} sites (${found} with feeds); the rest next round`);
      return;
    }
    const site = run.checks[i]!.site;
    const r = await check(site, cfg, embeddings, interesting).catch((err: unknown) => ({
      site,
      feedUrl: null,
      siteUrl: null,
      title: null,
      description: null,
      samples: [],
      postsPerWeek: null,
      lastPostAt: null,
      fit: null,
      near: [],
      error: String(err).slice(0, 200),
    }));
    if (r.feedUrl) found += 1;
    await app.suggestResult([r], i === run.checks.length - 1);
    await between();
  }
  log(`suggestions: checked ${run.checks.length} sites, ${found} with feeds`);
}
