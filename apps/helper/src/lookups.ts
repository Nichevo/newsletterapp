import { HELPER_VERSION, type AskJob, type AskSource, type HelperJob } from '@newsletterapp/shared';
import type { LocalConfig } from './config';
import { fetchArticleText } from './fetch';
import { log } from './log';
import { htmlToText } from './text';

// Lookups before the model answers: Wikipedia, the links in the highlighted
// paragraph, and web search with the Brave key in this PC's config. The
// results go into the message to the model, and their pages are listed as
// sources under the answer. A lookup that fails is skipped; the model still
// answers, and the note says what was missing.

const UA = `NewsletterAppHelper/${HELPER_VERSION} (personal newsletter reader; PC helper)`;
const EXCERPT = 1500; // characters from each page
const TOTAL = 6000; // characters of lookups in all
// Only for testing against a stand-in; the real helper always talks to Brave.
const BRAVE_URL = (process.env.HELPER_DEV && process.env.HELPER_BRAVE_URL) || 'https://api.search.brave.com';

export interface Found {
  title: string;
  url: string;
  text: string;
}

export interface Lookups {
  found: Found[];
  searches: number;
  /** What couldn't be looked up, for the note. */
  missing: string[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : s);
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
  return (await res.json()) as T;
}

/** The query to search for: the highlighted words, kept short. */
export function queryFor(quote: string, maxWords = 12): string {
  const words = squash(quote.replace(/[“”"]/g, '')).split(' ');
  return words.slice(0, maxWords).join(' ');
}

// ---------- Brave ----------

interface BraveResult {
  title: string;
  url: string;
  description?: string;
  extra_snippets?: string[];
}

export async function braveSearch(query: string, key: string, count = 5): Promise<BraveResult[]> {
  const q = new URLSearchParams({ q: query, count: String(count), safesearch: 'moderate', text_decorations: 'false' });
  const r = await getJson<{ web?: { results?: BraveResult[] } }>(`${BRAVE_URL}/res/v1/web/search?${q}`, {
    'X-Subscription-Token': key,
    'Accept-Encoding': 'gzip',
  });
  return (r.web?.results ?? []).filter((x) => /^https?:\/\//i.test(x.url));
}

const stripTags = (s: string) => squash(s.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'));

// ---------- Wikipedia ----------

export async function wikipedia(term: string): Promise<Found | null> {
  const search = await getJson<{ pages?: { key: string; title: string }[] }>(
    `https://en.wikipedia.org/w/rest.php/v1/search/page?${new URLSearchParams({ q: term, limit: '1' })}`,
  );
  const page = search.pages?.[0];
  if (!page) return null;
  const summary = await getJson<{ title: string; extract?: string; content_urls?: { desktop?: { page?: string } } }>(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.key)}`,
  );
  if (!summary.extract) return null;
  return {
    title: `${summary.title} (Wikipedia)`,
    url: summary.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(page.key)}`,
    text: clip(summary.extract, EXCERPT),
  };
}

// ---------- Links next to the highlight ----------

const SKIP_LINK = /unsubscribe|manage.?(preferences|subscription)|privacy|terms|mailto:|twitter\.com\/intent|facebook\.com\/sharer|linkedin\.com\/share|\/share\?|view.?(in|online)|forward/i;

/** The links in the block of the email that holds the highlighted words (newsletters link the story right there). */
export function paragraphLinks(html: string | null, quote: string, max = 2): string[] {
  if (!html) return [];
  const needle = squash(quote).toLowerCase().slice(0, 60);
  if (!needle) return [];
  // Split into blocks at closing block tags, smallest first, and take the first block that holds the words.
  const blocks = html.split(/<\/(?:p|li|h[1-6]|blockquote|td|div)>/i);
  for (const block of blocks) {
    const text = squash(htmlToText(block)).toLowerCase();
    if (!text.includes(needle)) continue;
    const links: string[] = [];
    for (const m of block.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
      const href = m[1]!.replace(/&amp;/g, '&');
      if (/^https?:\/\//i.test(href) && !SKIP_LINK.test(href) && !links.includes(href)) links.push(href);
      if (links.length >= max) break;
    }
    return links;
  }
  return [];
}

async function pageFound(url: string, cfg: LocalConfig): Promise<Found | null> {
  const page = await fetchArticleText(url, cfg);
  const text = squash(page.text);
  if (text.length < 200) return null;
  return { title: page.title ?? new URL(page.url).hostname, url: page.url, text: clip(text, EXCERPT) };
}

// ---------- For a highlight question ----------

export async function askLookups(job: AskJob, cfg: LocalConfig): Promise<Lookups> {
  const out: Lookups = { found: [], searches: 0, missing: [] };
  const wantWiki = job.lookups === 'wiki' || job.lookups === 'both';
  const wantWeb = job.lookups === 'web' || job.lookups === 'both';
  const seen = new Set<string>();
  const add = (f: Found | null) => {
    if (f && !seen.has(f.url)) {
      seen.add(f.url);
      out.found.push(f);
    }
  };

  if (wantWiki) {
    try {
      add(await wikipedia(queryFor(job.quote, 8)));
    } catch (err) {
      out.missing.push(`Wikipedia (${err instanceof Error ? err.message : String(err)})`);
    }
    for (const url of paragraphLinks(job.html, job.quote)) {
      try {
        add(await pageFound(url, cfg));
      } catch (err) {
        log(`lookup: couldn't open ${url.slice(0, 80)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (wantWeb) {
    if (!cfg.braveApiKey) out.missing.push('web search (no Brave key on the PC)');
    else if (!job.searchAllowed) out.missing.push("web search (this month's search budget is used up)");
    else {
      try {
        out.searches += 1;
        const results = await braveSearch(queryFor(job.quote), cfg.braveApiKey);
        // The top two pages in full (well, the start of them); the rest as their search snippets.
        for (const [i, r] of results.slice(0, 5).entries()) {
          if (seen.has(r.url)) continue;
          let page: Found | null = null;
          if (i < 2) page = await pageFound(r.url, cfg).catch(() => null);
          add(page ?? { title: stripTags(r.title), url: r.url, text: stripTags([r.description ?? '', ...(r.extra_snippets ?? [])].join(' ')) });
        }
      } catch (err) {
        out.missing.push(`web search (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }
  return out;
}

// ---------- For a summary ----------

/** Searches the headline; the results go to the model so it can add background and other coverage. */
export async function summaryLookups(job: HelperJob, cfg: LocalConfig): Promise<Lookups> {
  const out: Lookups = { found: [], searches: 0, missing: [] };
  if (!job.search) return out;
  if (!cfg.braveApiKey) {
    out.missing.push('web search (no Brave key on the PC)');
    return out;
  }
  try {
    out.searches += 1;
    const results = await braveSearch(queryFor(job.subject, 14), cfg.braveApiKey, 6);
    for (const r of results) {
      out.found.push({ title: stripTags(r.title), url: r.url, text: clip(stripTags([r.description ?? '', ...(r.extra_snippets ?? [])].join(' ')), 600) });
    }
  } catch (err) {
    out.missing.push(`web search (${err instanceof Error ? err.message : String(err)})`);
  }
  return out;
}

/** The lookups as a block for the model's message, numbered so it can refer to them. */
export function lookupsText(found: Found[]): string {
  if (found.length === 0) return '';
  let total = 0;
  const parts: string[] = [];
  for (const [i, f] of found.entries()) {
    const text = clip(f.text, Math.max(200, Math.min(EXCERPT, TOTAL - total)));
    total += text.length;
    parts.push(`[${i + 1}] ${f.title} (${f.url})\n${text}`);
    if (total >= TOTAL) break;
  }
  return parts.join('\n\n');
}

export const toSources = (found: Found[]): AskSource[] => found.map((f) => ({ title: f.title, url: f.url }));
