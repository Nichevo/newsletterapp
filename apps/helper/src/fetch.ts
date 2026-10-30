import {
  FETCH_HEADERS,
  extractArticle,
  extractLinks,
  looksBlocked,
  looksScripted,
  pageTitle,
  parseFeed,
  type FeedEntry,
  type FetchJob,
  type FetchJobResult,
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
    execFile(browser, args, { timeout: 90_000, maxBuffer: 40_000_000, windowsHide: true }, (err, stdout) => {
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
        entry = { ...entry, title: a.title || link.title, author: a.author, publishedAt: a.publishedAt, html: a.html || null, text: a.text };
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

async function articleJob(job: FetchJob, cfg: LocalConfig): Promise<FetchJobResult> {
  const page = await get(job.url, cfg, { render: job.render });
  const bad = failed(job, page);
  if (bad) return bad;
  return { jobId: job.id, ok: true, article: extractArticle(page.body, page.url) };
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
