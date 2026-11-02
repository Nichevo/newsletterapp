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

/**
 * The first real picture in a post (skipping tracking pixels, icons and data
 * URLs), with its hover text, e.g. a comic and its punchline. Looks at the first
 * 30 images at most, so a long page costs little.
 */
export function leadImage(html: string, base: string | null): { src: string; title: string | null } | null {
  const re = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  for (let n = 0; n < 30 && (m = re.exec(html)) !== null; n++) {
    const tag = m[0];
    const raw = attr(tag, 'src') ?? attr(tag, 'data-src');
    if (!raw || raw.startsWith('data:')) continue;
    const src = base ? absoluteUrl(raw, base) : /^https?:\/\//i.test(raw) ? raw : null;
    if (!src) continue;
    const w = Number(attr(tag, 'width') ?? 0);
    const h = Number(attr(tag, 'height') ?? 0);
    if ((w && w < 80) || (h && h < 60)) continue; // pixels, avatars, icons
    if (/pixel|tracking|spacer|avatar|gravatar|emoji|feeds\.feedburner|\/ads?\//i.test(src)) continue;
    const title = attr(tag, 'title') || attr(tag, 'alt') || null;
    return { src: src.slice(0, 1000), title: title ? title.slice(0, 500) : null };
  }
  return null;
}
