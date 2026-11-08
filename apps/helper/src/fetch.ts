import {
  FETCH_HEADERS,
  extractArticle,
  countWords,
  extractLinks,
  isRedditPost,
  leadImage,
  looksBlocked,
  looksBotCheck,
  botWalled,
  looksScripted,
  pageTitle,
  renderStoryLinks,
  storyLinkRows,
  type StoryLinkRow,
  parseFeed,
  type FeedEntry,
  type FetchJob,
  type Article,
  type FetchJobResult,
  type Picture,
  type PcHoldCount,
  type PcRest,
  HELPER_VERSION,
  articleText,
  fileKind,
  fileTypeLabel,
  kindFromType,
  textFileHtml,
  type FileKind,
} from '@newsletterapp/shared';
import { pdfArticle } from './pdf';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, type LocalConfig } from './config';
import { log } from './log';

// Fetches the app hands to the PC: feeds and websites that turn Cloudflare
// away, website watches (find new article links on a page, then pull each
// article out of its page), and full articles for feeds that only carry a
// teaser. The parsing code is shared with the Worker. Pages built by
// JavaScript are opened in Edge or Chrome without a window (--dump-dom), so
// nothing extra needs installing.

const FIRST_RUN_ARTICLES = 5;
const PICTURE_MAX_BYTES = 4_000_000;
const ARTICLES_PER_CHECK = 10;

interface Page {
  status: number;
  url: string;
  body: string;
  etag: string | null;
  lastModified: string | null;
  /** Set when the page was not fetched at all: why the PC is leaving the site alone. */
  held?: string;
  /** Set when the link was a file (a PDF, a picture, a Word file), which body is then empty for. */
  file?: { kind: FileKind; type: string | null; bytes: Uint8Array | null };
}

/** Biggest file the PC downloads to read (a PDF); bigger ones are left as a link. */
const FILE_MAX_BYTES = 60_000_000;

/** The app's own address: files you uploaded are fetched from there with the helper's service token. */
function appHeaders(url: string, cfg: LocalConfig): Record<string, string> {
  if (!cfg.appUrl || !url.startsWith(`${cfg.appUrl}/`)) return {};
  return {
    'CF-Access-Client-Id': cfg.clientId,
    'CF-Access-Client-Secret': cfg.clientSecret,
    // Local testing against `wrangler dev` with DEV_BYPASS_AUTH.
    ...(process.env.HELPER_DEV === '1' ? { 'X-Dev-Helper': '1' } : {}),
  };
}

const looksLikeFile = (url: string) => /\.(pdf|png|jpe?g|gif|webp|docx?|xlsx?|pptx?|epub|zip|mp3|mp4)([?#]|$)/i.test(url);

function browserCandidates(cfg: LocalConfig): string[] {
  const env = process.env;
  const list = [cfg.browserPath ?? ''];
  if (process.platform === 'win32') {
    for (const base of [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.LOCALAPPDATA]) {
      if (!base) continue;
      list.push(join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return list.filter((p) => p && existsSync(p));
}

/** The page after its scripts have run, from a windowless Edge or Chrome with its own profile. */
function renderInBrowser(url: string, cfg: LocalConfig): Promise<Page> {
  const browser = browserCandidates(cfg)[0];
  if (!browser) return Promise.reject(new Error('No Edge or Chrome found for pages that need a browser (set browserPath in config.json)'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    `--user-data-dir=${join(dataDir(), 'browser')}`,
    '--virtual-time-budget=15000',
    '--dump-dom',
    url,
  ];
  return new Promise((resolve, reject) => {
    // execFile's own timeout only kills the first browser process; the browser's helper
    // processes can keep the output pipe open so the callback never comes. So give up
    // on our own after a while too, or the whole helper waits forever.
    const giveUp = setTimeout(() => {
      child.kill();
      reject(new Error('The browser took too long to open the page'));
    }, 100_000);
    const child = execFile(browser, args, { timeout: 90_000, maxBuffer: 40_000_000, windowsHide: true }, (err, stdout) => {
      clearTimeout(giveUp);
      if (err && !stdout) return reject(new Error(`The browser could not open the page: ${err.message}`.slice(0, 300)));
      resolve({ status: 200, url, body: stdout, etag: null, lastModified: null });
    });
  });
}

// ---------- Being polite to sites from your home network ----------
// Fetching many pages from one site in a burst, or carrying on after it shows a
// "prove you're not a robot" page, gets the home network flagged, and then you
// see the check in your own browser too. So: a gap between requests to the same
// site, and after a site turns the PC away, a rest from it (doubling, up to a day).

const SAME_SITE_GAP_MS = 3_000;
const REST_FIRST_MS = 3 * 3_600_000;
const REST_MAX_MS = 24 * 3_600_000;

const nextTurn = new Map<string, number>();
const resting = new Map<string, { until: number; ms: number }>();

/** Sites on the app's "leave alone" list, from the last heartbeat (fetch jobs bring their own). */
let appSkipSites: string[] | null = null;
export function setSkipSites(sites: string[] | undefined): void {
  if (Array.isArray(sites)) appSkipSites = sites;
}
const skipFor = (job?: { skipSites?: string[] }) => job?.skipSites ?? appSkipSites ?? undefined;

/** Held-back and slowed fetches since the last heartbeat, by site (sent to the app, then cleared). */
const holds = new Map<string, PcHoldCount>();
function count(site: string, add: Partial<Omit<PcHoldCount, 'site'>>): void {
  if (!site) return;
  const h = holds.get(site) ?? { site, skipped: 0, rested: 0, flagged: 0, waited: 0, waitMs: 0, gapMs: SAME_SITE_GAP_MS, restMs: 0 };
  h.skipped += add.skipped ?? 0;
  h.rested += add.rested ?? 0;
  h.flagged += add.flagged ?? 0;
  h.waited += add.waited ?? 0;
  h.waitMs += add.waitMs ?? 0;
  h.restMs = Math.max(h.restMs, add.restMs ?? 0);
  holds.set(site, h);
}

/** What to send with the heartbeat. Call holdsSent() once the app has them. */
export function holdReport(): { holds: PcHoldCount[]; resting: PcRest[] } {
  const t = Date.now();
  return {
    holds: [...holds.values()],
    resting: [...resting].filter(([, r]) => r.until > t).map(([site, r]) => ({ site, until: r.until, ms: r.ms })),
  };
}
export function holdsSent(sent: PcHoldCount[]): void {
  for (const h of sent) if (holds.get(h.site) === h) holds.delete(h.site);
}

function siteOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Waits until it is this site's turn again. */
async function waitTurn(url: string): Promise<void> {
  const site = siteOf(url);
  if (!site) return;
  const t = Date.now();
  const slot = Math.max(t, nextTurn.get(site) ?? 0);
  nextTurn.set(site, slot + SAME_SITE_GAP_MS);
  if (slot > t) {
    count(site, { waited: 1, waitMs: slot - t });
    await new Promise((r) => setTimeout(r, slot - t));
  }
}

/** Why the PC leaves this address alone for now, or null when it may fetch it. */
function holdOff(url: string, skip: string[] | undefined): string | null {
  if (botWalled(url, skip)) {
    count(siteOf(url), { skipped: 1 });
    return `${siteOf(url)} is on your Sites the PC leaves alone list (Settings > PC helper and AI), so the PC leaves it to your browser`;
  }
  const rest = resting.get(siteOf(url));
  if (rest && rest.until > Date.now()) {
    count(siteOf(url), { rested: 1 });
    return `${siteOf(url)} showed a bot check, so the PC is leaving it alone until ${new Date(rest.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return null;
}

function noteAnswer(url: string, blocked: boolean): void {
  const site = siteOf(url);
  if (!site) return;
  if (!blocked) {
    resting.delete(site);
    return;
  }
  const ms = Math.min((resting.get(site)?.ms ?? REST_FIRST_MS / 2) * 2, REST_MAX_MS);
  resting.set(site, { until: Date.now() + ms, ms });
  count(site, { flagged: 1, restMs: ms });
  log(`${site} turned the PC away (bot check or block); leaving it alone for ${Math.round(ms / 3_600_000)}h`);
}

/** A page that was never fetched, because the PC is leaving that site alone. */
const heldOff = (url: string, why: string): Page => ({ status: 429, url, body: '', etag: null, lastModified: null, held: why });

async function get(
  url: string,
  cfg: LocalConfig,
  opts: { render?: boolean; etag?: string | null; lastModified?: string | null; skip?: string[]; files?: boolean } = {},
): Promise<Page> {
  const fromApp = Object.keys(appHeaders(url, cfg)).length > 0;
  const why = fromApp ? null : holdOff(url, opts.skip);
  if (why) return heldOff(url, why);
  if (!fromApp) await waitTurn(url);
  let page: Page;
  // A browser shows a PDF in its viewer, which --dump-dom gives back empty: files are always downloaded.
  if (opts.render && !fromApp && !(opts.files && looksLikeFile(url))) page = await renderInBrowser(url, cfg);
  else {
    const headers: Record<string, string> = { ...FETCH_HEADERS, ...appHeaders(url, cfg) };
    if (opts.etag) headers['If-None-Match'] = opts.etag;
    if (opts.lastModified) headers['If-Modified-Since'] = opts.lastModified;
    const res = await fetch(url, { headers, redirect: fromApp ? 'manual' : 'follow', signal: AbortSignal.timeout(opts.files ? 90_000 : 30_000) });
    const base = { status: res.status, url: res.url || url, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
    if (opts.files && res.ok) {
      // Article fetches: a link may be a file, which must never be read as text.
      const type = res.headers.get('content-type');
      const size = Number(res.headers.get('content-length') ?? 0);
      if (size > FILE_MAX_BYTES) {
        await res.body?.cancel();
        page = { ...base, body: '', file: { kind: kindFromType(type) ?? 'other', type, bytes: null } };
      } else {
        const bytes = new Uint8Array(await res.arrayBuffer());
        const kind = fileKind(type, bytes.subarray(0, 4096));
        page =
          kind === 'page'
            ? { ...base, body: new TextDecoder().decode(bytes) }
            : { ...base, body: kind === 'text' ? new TextDecoder().decode(bytes) : '', file: { kind, type, bytes } };
      }
    } else {
      page = { ...base, body: res.status === 304 ? '' : await res.text() };
    }
  }
  if (fromApp) return page;
  // A plain 403 is often just "no programs here"; a 429 or a bot-check page is the network being flagged.
  const flagged = page.status === 429 || (page.status !== 403 && page.status !== 304 && looksBlocked(page.status, page.body));
  noteAnswer(url, flagged);
  if (page.url !== url && siteOf(page.url) !== siteOf(url)) noteAnswer(page.url, flagged);
  return page;
}

function failed(job: FetchJob, page: Page): FetchJobResult | null {
  if (page.held) return { jobId: job.id, ok: false, blocked: true, error: page.held };
  if (looksBlocked(page.status, page.body)) {
    return { jobId: job.id, ok: false, blocked: true, error: `The site turned the PC away too (${page.status})` };
  }
  if (page.status >= 400) return { jobId: job.id, ok: false, error: `The site answered ${page.status}` };
  return null;
}

/**
 * The post's picture for sources that show pictures in the inbox: picked from
 * the whole page (the cleaned-up article can lose a comic that sits outside the
 * text), then downloaded straight away, because some sites' picture links stop
 * working after a day or two. Without the download the app still gets the address.
 */
async function pagePicture(body: string, pageUrl: string, fallback: string | null | undefined): Promise<Picture | null> {
  const pick = leadImage(body, pageUrl, fallback);
  if (!pick) return null;
  try {
    const res = await fetch(pick.src, { headers: { ...FETCH_HEADERS, Accept: 'image/*', Referer: pageUrl }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!res.ok || !type.startsWith('image/')) return pick;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > PICTURE_MAX_BYTES) return pick;
    return { ...pick, data: bytes.toString('base64'), type };
  } catch {
    return pick;
  }
}

async function feedJob(job: FetchJob, cfg: LocalConfig): Promise<FetchJobResult> {
  const page = await get(job.url, cfg, { etag: job.etag, lastModified: job.lastModified, skip: skipFor(job) });
  if (page.status === 304) return { jobId: job.id, ok: true, notModified: true, etag: page.etag, lastModified: page.lastModified };
  const bad = failed(job, page);
  if (bad) return bad;
  const feed = parseFeed(page.body, page.url, 60);
  if (!feed) return { jobId: job.id, ok: false, error: 'The address no longer returns a feed' };
  return { jobId: job.id, ok: true, title: feed.title, entries: feed.entries, etag: page.etag, lastModified: page.lastModified };
}

async function pageJob(job: FetchJob, cfg: LocalConfig): Promise<FetchJobResult> {
  const page = await get(job.url, cfg, { render: job.render, skip: skipFor(job) });
  const bad = failed(job, page);
  if (bad) return bad;
  const asFeed = parseFeed(page.body, page.url, 60);
  if (asFeed) return { jobId: job.id, ok: true, title: asFeed.title, entries: asFeed.entries };

  const links = extractLinks(page.body, page.url, job.linkHint);
  if (links.length === 0) {
    const tip = !job.render && looksScripted(page.body) ? ' The page looks built by JavaScript: switch on "Needs a browser".' : '';
    return { jobId: job.id, ok: false, error: `No article links found on the page.${tip}` };
  }
  const known = new Set(job.knownKeys);
  const fresh = links.filter((l) => !known.has(l.url)).slice(0, job.firstRun ? FIRST_RUN_ARTICLES : ARTICLES_PER_CHECK);
  const entries: FeedEntry[] = [];
  // One at a time, to be polite to the site.
  for (const link of fresh) {
    let entry: FeedEntry = { key: link.url, url: link.url, title: link.title, author: null, publishedAt: null, html: null };
    try {
      const art = await get(link.url, cfg, { render: job.render, skip: skipFor(job) });
      if (!failed(job, art)) {
        const a = extractArticle(art.body, art.url);
        entry = { ...entry, title: a.title || link.title, author: a.author, publishedAt: a.publishedAt, html: a.html || null, text: a.text, image: a.image ?? null };
        if (job.wantPicture) entry.picture = await pagePicture(art.body, art.url, a.image);
      }
    } catch {
      // The headline and link still come in; the reader can open the live page.
    }
    entries.push(entry);
  }
  // On the first check everything on the page counts as seen; later, links not
  // fetched this time stay new for the next check.
  return { jobId: job.id, ok: true, title: pageTitle(page.body), entries, seenKeys: job.firstRun ? links.map((l) => l.url) : [] };
}

const isXPost = (url: string) => /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\/[^/]+\/status\/\d+/i.test(url);

/** An X post's text, from X's public embed service (no sign-in needed). */
async function xPostText(url: string): Promise<string> {
  try {
    const res = await fetch(`https://publish.twitter.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(url)}`, {
      headers: { ...FETCH_HEADERS, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return '';
    const html = ((await res.json()) as { html?: string }).html ?? '';
    const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1] ?? '';
    const text = p
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 300 ? `${text.slice(0, 299).trimEnd()}…` : text;
  } catch {
    return '';
  }
}

/** A page's headline (og:title, else <title>), for "More" links that come without one. */
async function headlineOf(url: string, skip: string[] | undefined): Promise<string> {
  if (holdOff(url, skip)) return '';
  try {
    await waitTurn(url);
    const res = await fetch(url, { headers: FETCH_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(8_000) });
    if (res.status === 429) noteAnswer(url, true);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) return '';
    const head = (await res.text()).slice(0, 300_000);
    if (looksBlocked(res.status, head)) {
      noteAnswer(url, true);
      return '';
    }
    const og = /<meta[^>]+property\s*=\s*["']og:title["'][^>]*>/i.exec(head)?.[0];
    const content = og ? /\bcontent\s*=\s*["']([^"']+)["']/i.exec(og)?.[1] : null;
    return (content ?? pageTitle(head) ?? '').trim().slice(0, 300);
  } catch {
    return '';
  }
}

/**
 * Aggregators (Techmeme): the other links the post's own page lists for the
 * story, laid out like Techmeme under the article. "More" links without hover
 * text get their headline from the page itself (a few at a time).
 */
async function addStoryLinks(article: Article, postUrl: string, seen: string[], cfg: LocalConfig, skip: string[] | undefined): Promise<void> {
  try {
    // The post's own page; if the site turns the PC away, try a browser, then the site's front page
    // (the story is found there by its main article's link).
    let rows: StoryLinkRow[] = [];
    for (const attempt of [
      () => get(postUrl, cfg, { skip }),
      () => get(postUrl, cfg, { render: true, skip }),
      () => get(new URL('/', postUrl).toString(), cfg, { skip }),
    ]) {
      const post = await attempt().catch(() => null);
      // Held off or flagged: no browser or front-page tries, they only make it worse.
      if (post?.held || post?.status === 429) break;
      if (!post || post.status >= 400 || looksBlocked(post.status, post.body)) continue;
      rows = storyLinkRows(post.body, postUrl, seen);
      if (rows.length) break;
    }
    // Headlines for coverage links, and the post's words for X posts, when the page gave none.
    const missing = rows.filter((r) => !r.peek && (r.group === 'more' || isXPost(r.url))).slice(0, 16);
    for (let i = 0; i < missing.length; i += 4) {
      await Promise.all(
        missing.slice(i, i + 4).map(async (r) => {
          r.peek = r.group === 'more' ? await headlineOf(r.url, skip) : await xPostText(r.url);
        }),
      );
    }
    const links = renderStoryLinks(rows);
    if (!links) return;
    article.html += `\n${links.html}`;
    article.text += `\n\n${links.text}`;
    article.wordCount = countWords(article.text);
  } catch {
    // The article alone is still worth keeping.
  }
}

interface RedditThing {
  kind: string;
  data: {
    author?: string;
    score?: number;
    body?: string;
    body_html?: string;
    stickied?: boolean;
    children?: RedditThing[];
  };
}

interface RedditComment {
  author: string;
  score: number | null;
  html: string;
  text: string;
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const TOP_COMMENTS = 8;

/**
 * Reddit turns away programs that pretend to be a browser more often than ones
 * that say who they are (its own rules ask for a descriptive name), so that goes first.
 */
const REDDIT_UA = `windows:newsletterapp-helper:${HELPER_VERSION} (personal reader)`;
const REDDIT_AGENTS = [REDDIT_UA, FETCH_HEADERS['User-Agent']!];

/** Why the last Reddit attempts failed, for the helper's log. */
let redditTrail: string[] = [];

/** Top comments from Reddit's JSON (www, then old.reddit.com). */
async function redditJsonComments(url: string): Promise<RedditComment[] | null> {
  const u = new URL(url);
  u.hash = '';
  u.pathname = u.pathname.replace(/\/$/, '') + '.json';
  u.search = '?limit=15&depth=1&sort=top&raw_json=1';
  for (const agent of REDDIT_AGENTS) {
    for (const host of ['www.reddit.com', 'old.reddit.com']) {
      u.hostname = host;
      try {
        const res = await fetch(u.toString(), {
          headers: { ...FETCH_HEADERS, 'User-Agent': agent, Accept: 'application/json' },
          redirect: 'follow',
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
          redditTrail.push(`json ${host} ${res.status}`);
          continue;
        }
        const json = (await res.json()) as unknown;
        if (!Array.isArray(json) || json.length < 2) {
          redditTrail.push(`json ${host} not a thread`);
          continue;
        }
        return ((json[1] as RedditThing).data.children ?? [])
          .filter((c) => c.kind === 't1' && !c.data.stickied && c.data.body && c.data.author !== 'AutoModerator')
          .slice(0, TOP_COMMENTS)
          .map((c) => ({
            author: c.data.author ?? 'someone',
            score: c.data.score ?? null,
            html: c.data.body_html ?? `<p>${esc(c.data.body ?? '')}</p>`,
            text: c.data.body ?? '',
          }));
      } catch (err) {
        redditTrail.push(`json ${host} ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return null;
}

/**
 * Top comments from the thread's own feed (…/comments/<id>/.rss). The same kind
 * of address the subreddit's posts already come from, so it gets through when the JSON doesn't.
 * The feed has no scores; its first entry is the post itself.
 */
async function redditFeedComments(url: string): Promise<RedditComment[] | null> {
  const u = new URL(url);
  u.hash = '';
  u.hostname = 'www.reddit.com';
  u.pathname = u.pathname.replace(/\/$/, '') + '/.rss';
  u.search = '?sort=top&depth=1&limit=15';
  for (const agent of REDDIT_AGENTS) {
    try {
      const res = await fetch(u.toString(), { headers: { ...FETCH_HEADERS, 'User-Agent': agent }, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      if (!res.ok) {
        redditTrail.push(`rss ${res.status}`);
        continue;
      }
      const feed = parseFeed(await res.text(), u.toString(), 30);
      if (!feed) {
        redditTrail.push('rss not a feed');
        continue;
      }
      return feed.entries
        .filter((e) => /(^|_)t1_/.test(e.key) || /\/comments\/[^/]+\/[^/]*\/[a-z0-9]+\/?$/i.test(e.url ?? ''))
        .map((e) => ({ author: (e.author ?? 'someone').replace(/^\/?u\//, ''), score: null, html: e.html ?? '', text: e.text ?? (e.html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }))
        .filter((c) => c.text && c.author !== 'AutoModerator')
        .slice(0, TOP_COMMENTS);
    } catch (err) {
      redditTrail.push(`rss ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

/** Top comments read from old.reddit.com's page (when the JSON is refused). */
function oldRedditComments(html: string): RedditComment[] {
  const out: RedditComment[] = [];
  // Each top-level comment: <div class=" thing ... comment ..." data-author="name" ...> ... <div class="md">...</div>
  const parts = html.split(/<div\b(?=[^>]*\bdata-type="comment")/i).slice(1);
  for (const part of parts) {
    const author = /\bdata-author="([^"]+)"/i.exec(part)?.[1] ?? 'someone';
    if (author === 'AutoModerator' || /\bstickied\b/.test(part.slice(0, 400))) continue;
    const score = /<span class="score unvoted"[^>]*title="(-?\d+)"/i.exec(part)?.[1];
    const md = /<div class="md">([\s\S]*?)<\/div>/i.exec(part)?.[1];
    if (!md) continue;
    const text = md.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    out.push({ author, score: score ? Number(score) : null, html: md, text });
    if (out.length >= TOP_COMMENTS) break;
  }
  return out;
}

/**
 * A Reddit post's top comments (the post itself comes from the feed and stays
 * on top). Reddit's JSON first; if Reddit turns that away, old.reddit.com's
 * page sorted by top, then the same in a browser.
 */
async function redditComments(url: string, cfg: LocalConfig): Promise<Article | null> {
  redditTrail = [];
  let comments = await redditJsonComments(url);
  if (!comments?.length) comments = await redditFeedComments(url);
  if (!comments?.length) {
    const page = new URL(url);
    page.hostname = 'old.reddit.com';
    page.search = '?sort=top&depth=1';
    for (const render of [false, true]) {
      const got = await get(page.toString(), cfg, { render }).catch(() => null);
      if (!got || got.status >= 400) {
        redditTrail.push(`old.reddit${render ? ' browser' : ''} ${got?.status ?? 'failed'}`);
        continue;
      }
      comments = oldRedditComments(got.body);
      if (comments.length) break;
      redditTrail.push(`old.reddit${render ? ' browser' : ''} no comments found`);
    }
  }
  if (!comments?.length) {
    log(`Reddit comments for ${url}: none (${redditTrail.join('; ')})`);
    return null;
  }
  const html = `<h2>Top comments</h2>\n${comments
    .map((c) => `<blockquote><p><strong>${esc(c.author)}</strong>${c.score !== null ? ` · ${c.score} points` : ''}</p>${c.html}</blockquote>`)
    .join('\n')}`;
  const text = comments.map((c) => `${c.author}: ${c.text}`).join('\n\n');
  return { title: null, author: null, publishedAt: null, html, text, wordCount: countWords(text) };
}

async function articleJob(job: FetchJob, cfg: LocalConfig): Promise<FetchJobResult> {
  if (isRedditPost(job.url)) {
    // Only the comments: the post itself is already in the app from the feed.
    const article = await redditComments(job.url, cfg).catch(() => null);
    return article ? { jobId: job.id, ok: true, article } : { jobId: job.id, ok: false, error: `Reddit gave no comments (or turned the PC away): ${redditTrail.join('; ')}`.slice(0, 300) };
  }
  const page = await get(job.url, cfg, { render: job.render, skip: skipFor(job), files: true });
  if (page.file && page.status < 400) return await fileJob(job, page);
  const bad = failed(job, page);
  if (bad) {
    // The linked article is paywalled or blocked: the story's other links are still worth having.
    if (!job.postUrl) return bad;
    const article: Article = { title: null, author: null, publishedAt: null, html: '', text: '', wordCount: 0 };
    await addStoryLinks(article, job.postUrl, [job.url], cfg, skipFor(job));
    return article.wordCount > 0 ? { jobId: job.id, ok: true, article } : bad;
  }
  let article = extractArticle(page.body, page.url);
  if (looksBotCheck(article.text)) {
    // A bot check that got past the page checks: never kept as the article.
    noteAnswer(page.url, true);
    if (!job.postUrl) return { jobId: job.id, ok: false, blocked: true, error: 'The site showed a bot check instead of the article' };
    const links: Article = { title: null, author: null, publishedAt: null, html: '', text: '', wordCount: 0 };
    await addStoryLinks(links, job.postUrl, [job.url, page.url], cfg, skipFor(job));
    return links.wordCount > 0 ? { jobId: job.id, ok: true, article: links } : { jobId: job.id, ok: false, blocked: true, error: 'The site showed a bot check instead of the article' };
  }
  if (job.browserIfScripted && !job.render && article.wordCount < 80 && looksScripted(page.body)) {
    // Asked for by hand and built by JavaScript: worth opening in the browser.
    const rendered = await get(job.url, cfg, { render: true }).catch(() => null);
    if (rendered && !failed(job, rendered)) {
      const again = extractArticle(rendered.body, rendered.url);
      if (again.wordCount > article.wordCount) article = again;
    }
  }
  if (job.wantPicture) article.picture = await pagePicture(page.body, page.url, article.image);
  if (job.postUrl) await addStoryLinks(article, job.postUrl, [job.url, page.url], cfg, skipFor(job));
  return { jobId: job.id, ok: true, article };
}

/** A link that was a file: a PDF is read into text, plain text is kept as it is, anything else is said plainly. */
async function fileJob(job: FetchJob, page: Page): Promise<FetchJobResult> {
  const f = page.file!;
  if (f.kind === 'pdf') {
    if (!f.bytes) return { jobId: job.id, ok: false, error: 'The PDF is too big for the PC to read (over 60 MB)' };
    const article = await pdfArticle(f.bytes);
    log(`PDF ${job.url.slice(0, 80)}: ${article.pages} pages, ${article.wordCount} words, ${article.images?.length ?? 0} pictures (${article.drawn} charts or tables drawn)`);
    if (article.wordCount === 0 && !article.images?.length) {
      return { jobId: job.id, ok: false, error: 'The PDF has no text in it (probably scanned pages), so there is nothing to read out of it' };
    }
    const { pages: _pages, drawn: _drawn, ...rest } = article;
    return { jobId: job.id, ok: true, article: rest };
  }
  if (f.kind === 'text') {
    const html = textFileHtml(page.body);
    const text = articleText(html);
    return { jobId: job.id, ok: true, article: { title: null, author: null, publishedAt: null, html, text, wordCount: countWords(text), fileType: 'text/plain' } };
  }
  return { jobId: job.id, ok: false, error: `This link is a ${fileTypeLabel(f.type, job.url)}, not a web page` };
}

/** The readable text of a web page, for lookups. Opens it in a browser only when it was built by JavaScript. */
export async function fetchArticleText(url: string, cfg: LocalConfig): Promise<{ title: string | null; text: string; url: string }> {
  let page = await get(url, cfg, { skip: skipFor() });
  if (page.held) throw new Error(page.held);
  if (page.status >= 400 || looksBlocked(page.status, page.body)) throw new Error(`the site answered ${page.status}`);
  let article = extractArticle(page.body, page.url);
  if (article.wordCount < 80 && looksScripted(page.body)) {
    page = await get(url, cfg, { render: true, skip: skipFor() });
    article = extractArticle(page.body, page.url);
  }
  if (looksBotCheck(article.text)) throw new Error('the site showed a bot check');
  return { title: article.title, text: article.text, url: page.url };
}

export async function runFetchJob(job: FetchJob, cfg: LocalConfig): Promise<FetchJobResult> {
  try {
    if (job.kind === 'feed') return await feedJob(job, cfg);
    if (job.kind === 'page') return await pageJob(job, cfg);
    return await articleJob(job, cfg);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return { jobId: job.id, ok: false, error: e.name === 'TimeoutError' ? 'The site took too long to answer' : e.message.slice(0, 300) };
  }
}
