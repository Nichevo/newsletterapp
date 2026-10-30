// Light-touch helpers for email bodies. The web app does the real
// sanitising (DOMPurify in a shadow root); here we only keep the Worker
// cheap and derive a plain-text snippet for list views.

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
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
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
