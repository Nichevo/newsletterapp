// Reading feeds and web pages: RSS, Atom and JSON Feed parsing, finding a
// site's feed, finding article links on a page, and pulling the readable
// article out of a page. Plain regex and string work with no dependencies, so
// the same code runs in the Worker (feed checks, the Add screen) and in the PC
// helper (website pulls and full articles).

/** One post from a feed, or one article found on a watched page. */
export interface FeedEntry {
  /** Stable id used to tell new posts from ones already seen: the guid, else the link. */
  key: string;
  url: string | null;
  title: string;
  author: string | null;
  publishedAt: number | null;
  /** Post body as HTML (absolute links), or null when the feed has none. */
  html: string | null;
  /** Plain text of the body, when the sender already worked it out (the PC helper does). */
  text?: string | null;
}

export interface ParsedFeed {
  format: 'rss' | 'atom' | 'json';
  title: string | null;
  siteUrl: string | null;
  entries: FeedEntry[];
}

export interface Article {
  title: string | null;
  author: string | null;
  publishedAt: number | null;
  html: string;
  text: string;
  wordCount: number;
}

export interface PageLink {
  url: string;
  title: string;
}

/** Paths tried when a page doesn't say where its feed is. */
export const COMMON_FEED_PATHS = ['/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml'];

/** Browser-like headers; plenty of sites turn away anything that looks like a bot. */
export const FETCH_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5',
  'Accept-Language': 'en;q=0.9',
};

// ---------- Text helpers ----------

const NAMED: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
  zwnj: '',
  zwj: '',
  shy: '',
};

function safeChar(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return ' ';
  }
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => safeChar(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED[name.toLowerCase()] ?? m);
}

/** Tags out, entities decoded, whitespace collapsed to single spaces. */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

const BLOCK_END = /<\/(p|div|li|tr|h[1-6]|blockquote|section|article|table|figure|pre)>|<br\s*\/?>/gi;

/** Readable plain text with paragraph breaks. */
export function articleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(BLOCK_END, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[\u200b-\u200f\u2060\uFEFF]/g, '')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function countWords(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

/** An attribute's value from one tag, entity-decoded. */
export function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!m) return null;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim();
}

export function absoluteUrl(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|source)$/i;

/** The link without #fragments and tracking parameters, so one article has one key. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

/** Turns relative src/href attributes into absolute ones, so the saved copy works anywhere. */
export function absolutizeHtml(html: string, base: string): string {
  return html.replace(/(\s(?:src|href|poster)\s*=\s*)(["'])([^"']*)\2/gi, (m, pre: string, q: string, value: string) => {
    if (/^(https?:|mailto:|tel:|data:|#)/i.test(value.trim())) return m;
    const abs = absoluteUrl(decodeEntities(value), base);
    return abs ? `${pre}${q}${abs.replace(/"/g, '&quot;')}${q}` : m;
  });
}

function parseDate(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  return Number.isFinite(t) ? t : null;
}

// ---------- Feeds ----------

/** Inner text of the first <name> element in a block; CDATA is kept as-is, anything else entity-decoded. */
function tagValue(block: string, names: string[]): string | null {
  for (const name of names) {
    const escaped = name.replace(':', '\\:');
    const m = new RegExp(`<${escaped}(\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i').exec(block);
    if (!m) continue;
    const inner = (m[2] ?? '').trim();
    const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
    if (cdata) return cdata[1] ?? '';
    // Atom xhtml content is markup already; everything else is escaped text.
    if (/type\s*=\s*["']xhtml["']/i.test(m[1] ?? '')) return inner;
    return decodeEntities(inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
  }
  return null;
}

/** Titles are text, but some feeds put inline HTML in them; only real formatting tags go, so "Why <div> is bad" survives. */
function cleanTitle(raw: string | null): string {
  if (!raw) return '';
  return decodeEntities(raw.replace(/<\/?(a|b|i|u|em|strong|span|code|br|p|div|sup|sub|small|mark|abbr|q|s)\b[^>]*>/gi, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** The channel-level part of a feed: everything before the first item or entry. */
function headOf(xml: string, itemTag: string): string {
  const i = xml.search(new RegExp(`<${itemTag}[\\s>]`, 'i'));
  return i < 0 ? xml : xml.slice(0, i);
}

function atomLink(block: string): string | null {
  const links = block.match(/<link\b[^>]*>/gi) ?? [];
  let fallback: string | null = null;
  for (const tag of links) {
    const rel = (attr(tag, 'rel') ?? 'alternate').toLowerCase();
    const href = attr(tag, 'href');
    if (!href) continue;
    if (rel === 'alternate') return href;
    if (!fallback && rel !== 'self' && rel !== 'enclosure' && rel !== 'replies') fallback = href;
  }
  return fallback;
}

function entryKey(guid: string | null, url: string | null, title: string, publishedAt: number | null): string {
  const k = guid?.trim() || (url ? canonicalUrl(url) : '') || `${title}|${publishedAt ?? ''}`;
  return k.slice(0, 500);
}

function finishEntry(
  base: string,
  e: { guid: string | null; link: string | null; title: string; author: string | null; date: string | null; html: string | null },
): FeedEntry {
  const url = absoluteUrl(e.link, base);
  const publishedAt = parseDate(e.date);
  const html = e.html?.trim() ? absolutizeHtml(e.html.trim(), url ?? base) : null;
  const title = e.title || (html ? stripTags(html).slice(0, 80) : '') || '(untitled)';
  return { key: entryKey(e.guid, url, title, publishedAt), url, title, author: e.author ? stripTags(e.author).slice(0, 120) : null, publishedAt, html };
}

/** The first `limit` blocks of one element; feeds list the newest first, and big ones hold years of posts. */
function blocks(xml: string, tag: string, limit: number): string[] {
  const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while (out.length < limit && (m = re.exec(xml)) !== null) out.push(m[0]);
  return out;
}

function parseRss(xml: string, base: string, limit: number): ParsedFeed {
  const head = headOf(xml, 'item');
  const entries = blocks(xml, 'item', limit).map((block) => {
    const content = tagValue(block, ['content:encoded']);
    const description = tagValue(block, ['description']);
    return finishEntry(base, {
      guid: tagValue(block, ['guid']),
      link: tagValue(block, ['link']) || atomLink(block),
      title: cleanTitle(tagValue(block, ['title'])),
      author: tagValue(block, ['dc:creator', 'author']),
      date: tagValue(block, ['pubDate', 'dc:date', 'published', 'updated']),
      // The longer of the two: some feeds put the full post in description.
      html: content && content.length >= (description?.length ?? 0) ? content : description,
    });
  });
  return { format: 'rss', title: cleanTitle(tagValue(head, ['title'])) || null, siteUrl: absoluteUrl(tagValue(head, ['link']) || atomLink(head), base), entries };
}

function parseAtom(xml: string, base: string, limit: number): ParsedFeed {
  const head = headOf(xml, 'entry');
  const entries = blocks(xml, 'entry', limit).map((block) => {
    const content = tagValue(block, ['content']);
    const summary = tagValue(block, ['summary']);
    const authorBlock = /<author\b[\s\S]*?<\/author>/i.exec(block)?.[0] ?? '';
    return finishEntry(base, {
      guid: tagValue(block, ['id']),
      link: atomLink(block),
      title: cleanTitle(tagValue(block, ['title'])),
      author: authorBlock ? tagValue(authorBlock, ['name']) : null,
      date: tagValue(block, ['published', 'updated', 'issued']),
      html: content && content.length >= (summary?.length ?? 0) ? content : summary,
    });
  });
  return { format: 'atom', title: cleanTitle(tagValue(head, ['title'])) || null, siteUrl: absoluteUrl(atomLink(head), base), entries };
}

interface JsonFeedItem {
  id?: unknown;
  url?: unknown;
  external_url?: unknown;
  title?: unknown;
  content_html?: unknown;
  content_text?: unknown;
  summary?: unknown;
  date_published?: unknown;
  date_modified?: unknown;
  author?: { name?: unknown };
  authors?: { name?: unknown }[];
}

const s = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);
const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function parseJsonFeed(body: string, base: string, limit: number): ParsedFeed | null {
  let data: { version?: unknown; title?: unknown; home_page_url?: unknown; items?: unknown };
  try {
    data = JSON.parse(body) as typeof data;
  } catch {
    return null;
  }
  if (!s(data.version)?.includes('jsonfeed.org') || !Array.isArray(data.items)) return null;
  const entries = (data.items as JsonFeedItem[]).slice(0, limit).map((it) => {
    const text = s(it.content_text);
    return finishEntry(base, {
      guid: s(it.id),
      link: s(it.url) ?? s(it.external_url),
      title: cleanTitle(s(it.title)),
      author: s(it.authors?.[0]?.name) ?? s(it.author?.name),
      date: s(it.date_published) ?? s(it.date_modified),
      html: s(it.content_html) ?? (text ? `<p>${escapeHtml(text).replace(/\n\n+/g, '</p><p>')}</p>` : s(it.summary)),
    });
  });
  return { format: 'json', title: cleanTitle(s(data.title)) || null, siteUrl: absoluteUrl(s(data.home_page_url), base), entries };
}

/** Parses RSS (0.9x, 1.0/RDF, 2.0), Atom or JSON Feed, newest `limit` posts. Null when the body isn't a feed. */
export function parseFeed(body: string, baseUrl: string, limit = 50): ParsedFeed | null {
  const start = body.slice(0, 2000).replace(/^\uFEFF/, '').trimStart();
  if (start.startsWith('{')) return parseJsonFeed(body, baseUrl, limit);
  if (/<html[\s>]/i.test(start) && !/<(rss|feed|rdf:RDF)[\s>]/i.test(start)) return null;
  if (/<rss[\s>]|<rdf:RDF[\s>]/i.test(start) || /<channel[\s>]/i.test(body.slice(0, 5000))) return parseRss(body, baseUrl, limit);
  if (/<feed[\s>]/i.test(start)) return parseAtom(body, baseUrl, limit);
  return null;
}

// ---------- Web pages ----------

/** Feeds a page advertises with <link rel="alternate">, best first. */
export function findFeedLinks(html: string, baseUrl: string): string[] {
  const head = html.slice(0, 200_000);
  const out: string[] = [];
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase();
    const type = (attr(tag, 'type') ?? '').toLowerCase();
    if (!rel.split(/\s+/).includes('alternate')) continue;
    if (!/(rss|atom|feed)\+xml|feed\+json|application\/json/.test(type)) continue;
    // Comment feeds are rarely what anyone wants.
    if (/comments?/i.test(attr(tag, 'title') ?? '') || /\/comments\/feed/i.test(attr(tag, 'href') ?? '')) continue;
    const url = absoluteUrl(attr(tag, 'href'), baseUrl);
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

export function pageTitle(html: string): string | null {
  const og = /<meta\b[^>]*property\s*=\s*["']og:(?:site_name|title)["'][^>]*>/i.exec(html);
  const fromOg = og ? attr(og[0], 'content') : null;
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = fromOg || (t ? stripTags(t) : '');
  return title ? title.slice(0, 200) : null;
}

/** The page with scripts, styles and the usual site chrome (menus, headers, footers, sidebars) removed. */
function withoutChrome(html: string, dropHeaders = true): string {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const out = body
    .replace(/<(script|style|noscript|svg|template|form|iframe|button|select)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  // Listing pages often put each headline link in a card's <header>, so links keep them.
  return dropHeaders ? out.replace(/<header\b[\s\S]*?<\/header>/gi, ' ') : out;
}

const ASSET = /\.(jpe?g|png|gif|webp|svg|pdf|zip|mp3|mp4|css|js|xml|json|ico)(\?|$)/i;
const NOT_ARTICLE = /\/(tag|tags|category|categories|author|authors|page|search|login|signin|signup|register|account|cart|about|contact|privacy|terms|subscribe|feed|rss)(\/|$|\?)/i;

/**
 * Links on a listing page that look like articles: same site, a real path,
 * and a headline-length link text. With a hint, only links whose address
 * contains it (e.g. "/blog/"), whatever their text. In page order.
 */
export function extractLinks(html: string, pageUrl: string, hint?: string | null): PageLink[] {
  const page = new URL(pageUrl);
  const content = withoutChrome(html, false);
  const found = new Map<string, PageLink>();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const url = absoluteUrl(attr(`<a ${m[1] ?? ''}>`, 'href'), pageUrl);
    if (!url) continue;
    const u = new URL(url);
    const key = canonicalUrl(url);
    // A card link often wraps the headline and a blurb; the headline is the title.
    const heading = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(m[2] ?? '')?.[1];
    const text = stripTags(heading ?? m[2] ?? '') || attr(`<a ${m[1] ?? ''}>`, 'title') || '';
    if (hint) {
      if (!url.includes(hint)) continue;
    } else {
      if (u.hostname.replace(/^www\./, '') !== page.hostname.replace(/^www\./, '')) continue;
      if (u.pathname === '/' || ASSET.test(u.pathname) || NOT_ARTICLE.test(u.pathname)) continue;
      if (canonicalUrl(pageUrl) === key) continue;
      if (text.length < 20 || text.split(' ').length < 3) continue;
    }
    const existing = found.get(key);
    if (!existing) found.set(key, { url: key, title: text.slice(0, 300) || key });
    else if (text.length > existing.title.length && text.length <= 300) existing.title = text;
  }
  return [...found.values()].slice(0, 150);
}

function metaContent(html: string, keys: string[]): string | null {
  for (const key of keys) {
    const re = new RegExp(`<meta\\b[^>]*(?:property|name|itemprop)\\s*=\\s*["']${key}["'][^>]*>`, 'i');
    const tag = re.exec(html)?.[0];
    const v = tag ? attr(tag, 'content') : null;
    if (v) return v;
  }
  return null;
}

/** The block (article, main, or the whole body) with the most paragraph text. */
function mainBlock(content: string): string {
  const candidates = [
    ...(content.match(/<article\b[\s\S]*?<\/article>/gi) ?? []),
    ...(content.match(/<main\b[\s\S]*?<\/main>/gi) ?? []),
  ];
  let best = content;
  let bestScore = paragraphText(content) * 0.6; // prefer a marked-up article when it holds most of the text
  for (const c of candidates) {
    const score = paragraphText(c);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

const PARA = /<p\b[^>]*>[\s\S]*?<\/p>/gi;

function paragraphText(html: string): number {
  let total = 0;
  for (const p of html.match(PARA) ?? []) {
    const len = stripTags(p).length;
    if (len >= 40) total += len;
  }
  return total;
}

/**
 * Readability-lite: finds the run of real paragraphs that makes up the
 * article (dropping comment sections and link lists far from it), with the
 * headings, images and lists in between.
 */
function articleRange(block: string): string {
  const paras: { start: number; end: number; len: number }[] = [];
  PARA.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PARA.exec(block)) !== null) {
    const len = stripTags(m[0]).length;
    if (len >= 40) paras.push({ start: m.index, end: m.index + m[0].length, len });
  }
  if (paras.length < 2) return block;
  // Clusters of paragraphs close to each other; the article is the biggest one.
  const GAP = 6000;
  let best = { start: paras[0]!.start, end: paras[0]!.end, len: 0 };
  let cur = { ...best };
  for (const p of paras) {
    if (p.start - cur.end > GAP) {
      if (cur.len > best.len) best = cur;
      cur = { start: p.start, end: p.end, len: 0 };
    }
    cur.end = p.end;
    cur.len += p.len;
  }
  if (cur.len > best.len) best = cur;
  // Pull in a heading or image just before the first paragraph.
  const before = block.slice(Math.max(0, best.start - 1500), best.start);
  const lead = /<(h[1-6]|figure|img|picture)\b[\s\S]*$/i.exec(before);
  return (lead ? lead[0] : '') + block.slice(best.start, best.end);
}

/** The readable article in a page, as clean HTML and text. */
export function extractArticle(html: string, pageUrl: string): Article {
  const title =
    metaContent(html, ['og:title', 'twitter:title']) ??
    (/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ? stripTags(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)![1]!) : null) ??
    pageTitle(html);
  const published =
    metaContent(html, ['article:published_time', 'datePublished', 'pubdate', 'date', 'og:updated_time']) ??
    /"datePublished"\s*:\s*"([^"]+)"/.exec(html)?.[1] ??
    attr(/<time\b[^>]*datetime[^>]*>/i.exec(html)?.[0] ?? '', 'datetime');
  const author = metaContent(html, ['author', 'article:author', 'parsely-author']) ?? /"author"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/.exec(html)?.[1] ?? null;

  const body = articleRange(mainBlock(withoutChrome(html)))
    // Inline handlers and styles go; the reader sanitises again anyway.
    .replace(/\s(on[a-z]+|style|class|id)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // Lazy-loaded images keep their real address in data-src.
    .replace(/<img\b([^>]*?)\sdata-src\s*=\s*(["'])([^"']+)\2/gi, '<img$1 src=$2$3$2');
  const clean = absolutizeHtml(body, pageUrl).trim();
  const text = articleText(clean);
  return {
    title: title ? title.slice(0, 300) : null,
    author: author && !/^https?:/i.test(author) ? stripTags(author).slice(0, 120) : null,
    publishedAt: parseDate(published),
    html: clean,
    text,
    wordCount: countWords(text),
  };
}

/** A response that is a bot check or a block rather than the real page. */
export function looksBlocked(status: number, body: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  const head = body.slice(0, 6000);
  return /<title>\s*(just a moment|attention required|access denied|are you a robot|security check)/i.test(head) || /cf-chl-|captcha-delivery|px-captcha/i.test(head);
}

/** Pages that render their content with JavaScript: lots of script and almost no text. */
export function looksScripted(html: string): boolean {
  const text = stripTags(withoutChrome(html)).length;
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  return text < 400 && (scripts >= 3 || /<div id=["'](root|app|__next)["']>\s*<\/div>/i.test(html));
}
