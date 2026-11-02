import { absoluteUrl, attr } from '@newsletterapp/shared';

// Light-touch helpers for email bodies. The web app does the real
// sanitising (DOMPurify in a shadow root); here we only keep the Worker
// cheap and derive a plain-text snippet for list views.

// Zero-width and filler characters newsletters pad their preview text with.
const INVISIBLE = /[\u200b-\u200f\u2060\u034f\u00ad\ufeff\u2007]/g;

function safeChar(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return ' ';
  }
}

const BLOCK_TAGS = /<\/(p|div|br|li|tr|h[1-6]|blockquote|section|article|table)>/gi;

/** Strips tags and collapses whitespace. Good enough for snippets and search. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(BLOCK_TAGS, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&(zwnj|zwj|shy);/gi, '')
    .replace(/&#(\d+);/g, (_, n: string) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => safeChar(parseInt(n, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(INVISIBLE, '')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** First line or two of readable text, skipping typical preheader filler. */
export function snippetOf(text: string, max = 240): string {
  const cleaned = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^(view (this|in) (email|browser)|open in browser)/i.test(l))
    .join(' ');
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40)).trim() + '…';
}

/** Finds a "view in browser" style link, if the newsletter has one. */
export function findWebVersionUrl(html: string): string | null {
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const label = htmlToText(m[2] ?? '').toLowerCase();
    if (/(view|read|open)\b.*\b(browser|online|web)/.test(label) || /web version/.test(label)) {
      const href = m[1] ?? '';
      if (/^https?:\/\//i.test(href)) return href;
    }
  }
  return null;
}

const JUNK_IMAGE = /pixel|tracking|spacer|avatar|gravatar|emoji|logo|icon|sprite|badge|\/ads?\/|social/i;
const JUNK_HOST = /feeds\.feedburner|doubleclick|googlesyndication|gravatar/i;

/** Site furniture rather than the post's own picture: logos, icons, share buttons, tracking pixels. */
export function junkImage(src: string, alt?: string | null): boolean {
  let path = src;
  try {
    path = new URL(src).pathname; // a site called "iconic-comics.com" is still fine
  } catch {
    // keep the whole string
  }
  return JUNK_IMAGE.test(path) || JUNK_HOST.test(src) || /\blogo\b/i.test(alt ?? '');
}

/**
 * The post's picture (skipping tracking pixels, logos, icons and data URLs),
 * with its hover text, e.g. a comic and its punchline. A whole saved page can
 * hold a site logo before the strip, so among the first 40 images one with
 * hover text, a comic-like address or a big size wins over the first one.
 * `fallback` (a feed enclosure or the page's og:image) is used when the body
 * has no picture of its own.
 */
export function leadImage(html: string, base: string | null, fallback?: string | null): { src: string; title: string | null } | null {
  const re = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  let best: { src: string; title: string | null; score: number } | null = null;
  for (let n = 0; n < 40 && (m = re.exec(html)) !== null; n++) {
    const tag = m[0];
    const plain = attr(tag, 'src');
    // Lazy-loaded images keep a placeholder in src and the real address in data-src.
    const raw = plain && !plain.startsWith('data:') ? plain : attr(tag, 'data-src');
    if (!raw || raw.startsWith('data:')) continue;
    const src = base ? absoluteUrl(raw, base) : /^https?:\/\//i.test(raw) ? raw : null;
    if (!src) continue;
    const w = Number(attr(tag, 'width') ?? 0);
    const h = Number(attr(tag, 'height') ?? 0);
    if ((w && w < 80) || (h && h < 60)) continue; // pixels, avatars, icons
    const hover = attr(tag, 'title');
    const alt = attr(tag, 'alt');
    if (junkImage(src, alt)) continue;
    const where = `${src} ${attr(tag, 'id') ?? ''} ${attr(tag, 'class') ?? ''}`;
    const score = (hover ? 3 : 0) + (/comic|strip|cartoon/i.test(where) ? 3 : 0) + (w >= 300 || h >= 300 ? 1 : 0);
    if (!best || score > best.score) {
      const title = hover || alt || null;
      best = { src: src.slice(0, 1000), title: title ? title.slice(0, 500) : null, score };
      if (score >= 6) break;
    }
  }
  if (best) return { src: best.src, title: best.title };
  if (fallback && /^https?:\/\//i.test(fallback) && !junkImage(fallback)) return { src: fallback.slice(0, 1000), title: null };
  return null;
}
