import type { KeywordRule } from '@newsletterapp/shared';
import { htmlToText } from './html';

// The quick summary: what can be worked out by plain rules, with no AI and
// no PC. Kept to a few cheap regex passes for the free plan's CPU budget.
// The richer "In this issue" list is built in the browser from the HTML.

export interface QuickSummary {
  preheader: string | null;
  wordCount: number;
  sponsored: boolean;
}

const PREVIEW_MAX = 240;

// Hidden preview text sits near the top of the email in an element that is
// display:none / zero-height / invisible, or has a "preheader"/"preview" class.
const HIDDEN_BLOCK =
  /<(div|span|td|p)\b([^>]*(?:display\s*:\s*none|max-height\s*:\s*0|opacity\s*:\s*0|visibility\s*:\s*hidden|class=["'][^"']*\b(?:preheader|preview)[^"']*["'])[^>]*)>([\s\S]*?)<\/\1>/i;

const FILLER_LINE =
  /^(view (this|in|it in|email in|online)|open in browser|read (it )?online|having trouble|if you can.?t see|forwarded this|was this (email )?forwarded|hi\b|hello\b|hey\b|good (morning|afternoon|evening)|dear\b|welcome to|presented by|brought to you by|sponsored by|together with|in partnership with|unsubscribe)/i;

const SPONSORED =
  /\b(sponsored( by| content| post)?|presented by|brought to you by|in partnership with|together with our partner|paid partnership|advertisement|from our partners?)\b/i;

function clip(text: string, max = PREVIEW_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40)).trim() + '…';
}

/** The sender's own one-line pitch for the issue, if the email has one. */
export function findPreheader(html: string | null): string | null {
  if (!html) return null;
  const head = html.slice(0, 40_000);
  const m = HIDDEN_BLOCK.exec(head);
  if (!m) return null;
  const text = htmlToText(m[3] ?? '').replace(/\s+/g, ' ').trim();
  return text.length >= 15 ? clip(text) : null;
}

/** First real paragraph of the text, skipping "view in browser", greetings and sponsor lines. */
export function firstParagraph(text: string | null): string | null {
  if (!text) return null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length < 60 || FILLER_LINE.test(line) || /^https?:\/\//i.test(line)) continue;
    return clip(line);
  }
  return null;
}

export function quickSummary(html: string | null, text: string | null): QuickSummary {
  const words = text ? text.match(/\S+/g)?.length ?? 0 : 0;
  return {
    preheader: findPreheader(html) ?? firstParagraph(text),
    wordCount: words,
    sponsored: text ? SPONSORED.test(text) : false,
  };
}

/** First keyword rule whose words appear in the subject or preview line. */
export function categoryFromRules(rules: KeywordRule[], subject: string, preheader: string | null): string | null {
  const haystack = `${subject} ${preheader ?? ''}`.toLowerCase();
  for (const rule of rules) {
    const words = rule.match
      .split(',')
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);
    for (const w of words) {
      const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(haystack)) return rule.category;
    }
  }
  return null;
}
