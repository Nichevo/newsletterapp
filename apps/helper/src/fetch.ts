import {
  FETCH_HEADERS,
  extractArticle,
  countWords,
  extractLinks,
  isRedditPost,
  leadImage,
  looksBlocked,
  looksScripted,
  pageTitle,
  renderStoryLinks,
  storyLinkRows,
  parseFeed,
  type FeedEntry,
  type FetchJob,
  type Article,
  type FetchJobResult,
  type Picture,
} from '@newsletterapp/shared';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, type LocalConfig } from './config';

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
}

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

async function get(url: string, cfg: LocalConfig, opts: { render?: boolean; etag?: string | null; lastModified?: string | null } = {}): Promise<Page> {
  if (opts.render) return renderInBrowser(url, cfg);
  const headers: Record<string, string> = { ...FETCH_HEADERS };
  if (opts.etag) headers['If-None-Match'] = opts.etag;
  if (opts.lastModified) headers['If-Modified-Since'] = opts.lastModified;
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  return {
    status: res.status,
    url: res.url || url,
    body: res.status === 304 ? '' : await res.text(),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}

function failed(job: FetchJob, page: Page): FetchJobResult | null {
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
  const page = await get(job.url, cfg, { etag: job.etag, lastModified: job.lastModified });
  if (page.status === 304) return { jobId: job.id, ok: true, notModified: true, etag: page.etag, lastModified: page.lastModified };
  const bad = failed(job, page);
  if (bad) return bad;
  const feed = parseFeed(page.body, page.url, 60);
  if (!feed) return { jobId: job.id, ok: false, error: 'The address no longer returns a feed' };
  return { jobId: job.id, ok: true, title: feed.title, entries: feed.entries, etag: page.etag, lastModified: page.lastModified };
}

async function pageJob(job: FetchJob, cfg: LocalConfig): Promise<FetchJobResult> {
  const page = await get(job.url, cfg, { render: job.render });
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
      const art = await get(link.url, cfg, { render: job.render });
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

/** A page's headline (og:title, else <title>), for "More" links that come without one. */
async function headlineOf(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(8_000) });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) return '';
    const head = (await res.text()).slice(0, 300_000);
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
async function addStoryLinks(article: Article, postUrl: string, skip: string[], cfg: LocalConfig): Promise<void> {
  try {
    const post = await get(postUrl, cfg);
    if (post.status >= 400) return;
    const rows = storyLinkRows(post.body, postUrl, skip);
    const missing = rows.filter((r) => r.group === 'more' && !r.peek).slice(0, 12);
    for (let i = 0; i < missing.length; i += 4) {
      await Promise.all(
        missing.slice(i, i + 4).map(async (r) => {
          r.peek = await headlineOf(r.url);
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
    title?: string;
    author?: string;
    score?: number;
    created_utc?: number;
    selftext?: string;
    selftext_html?: string | null;
    body?: string;
    body_html?: string;
    url?: string;
    post_hint?: string;
    is_self?: boolean;
    stickied?: boolean;
    children?: RedditThing[];
  };
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A Reddit post plus its top comments, from Reddit's own JSON (comments are not in the feed). */
async function redditArticle(url: string): Promise<Article | null> {
  const u = new URL(url);
  u.hash = '';
  u.pathname = u.pathname.replace(/\/$/, '') + '.json';
  u.search = '?limit=12&depth=1&sort=top&raw_json=1';
  const res = await fetch(u.toString(), { headers: { ...FETCH_HEADERS, Accept: 'application/json' }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const json = (await res.json()) as RedditThing[] | unknown;
  if (!Array.isArray(json) || json.length < 2) return null;
  const post = (json[0] as RedditThing).data.children?.[0]?.data;
  if (!post) return null;
  const comments = ((json[1] as RedditThing).data.children ?? [])
    .filter((c) => c.kind === 't1' && !c.data.stickied && c.data.body && c.data.author !== 'AutoModerator')
    .slice(0, 8)
    .map((c) => c.data);
  const parts: string[] = [];
  const texts: string[] = [post.title ?? '', post.selftext ?? ''];
  if (post.selftext_html) parts.push(post.selftext_html);
  if (post.url && !post.is_self) {
    if (post.post_hint === 'image' || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(post.url)) parts.push(`<p><img src="${esc(post.url)}" alt=""></p>`);
    else parts.push(`<p><a href="${esc(post.url)}">${esc(post.url)}</a></p>`);
  }
  if (comments.length) {
    parts.push('<h2>Top comments</h2>');
    for (const c of comments) {
      parts.push(
        `<blockquote><p><strong>${esc(c.author ?? 'someone')}</strong> · ${c.score ?? 0} points</p>${c.body_html ?? `<p>${esc(c.body ?? '')}</p>`}</blockquote>`,
      );
      texts.push(c.body ?? '');
    }
  }
  const text = texts.filter(Boolean).join('\n\n');
  return {
    title: post.title ?? null,
    author: post.author ? `u/${post.author}` : null,
    publishedAt: post.created_utc ? post.created_utc * 1000 : null,
    html: parts.join('\n'),
    text,
    wordCount: countWords(text),
  };
}

async function articleJob(job: FetchJob, cfg: LocalConfig): Promise<FetchJobResult> {
  if (isRedditPost(job.url)) {
    // Falls back to the normal page fetch if Reddit's JSON is unavailable.
    const article = await redditArticle(job.url).catch(() => null);
    if (article) return { jobId: job.id, ok: true, article };
  }
  const page = await get(job.url, cfg, { render: job.render });
  const bad = failed(job, page);
  if (bad) {
    // The linked article is paywalled or blocked: the story's other links are still worth having.
    if (!job.postUrl) return bad;
    const article: Article = { title: null, author: null, publishedAt: null, html: '', text: '', wordCount: 0 };
    await addStoryLinks(article, job.postUrl, [job.url], cfg);
    return article.wordCount > 0 ? { jobId: job.id, ok: true, article } : bad;
  }
  const article = extractArticle(page.body, page.url);
  if (job.wantPicture) article.picture = await pagePicture(page.body, page.url, article.image);
  if (job.postUrl) await addStoryLinks(article, job.postUrl, [job.url, page.url], cfg);
  return { jobId: job.id, ok: true, article };
}

/** The readable text of a web page, for lookups. Opens it in a browser only when it was built by JavaScript. */
export async function fetchArticleText(url: string, cfg: LocalConfig): Promise<{ title: string | null; text: string; url: string }> {
  let page = await get(url, cfg);
  if (page.status >= 400 || looksBlocked(page.status, page.body)) throw new Error(`the site answered ${page.status}`);
  let article = extractArticle(page.body, page.url);
  if (article.wordCount < 80 && looksScripted(page.body)) {
    page = await get(url, cfg, { render: true });
    article = extractArticle(page.body, page.url);
  }
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
