import { isKeyKind, type KeyJob, type KeyKind, type KeyMark, type KeyResult } from '@newsletterapp/shared';
import { htmlToText } from './text';

// Key sentences on the PC: the article is split into sentences and numbered,
// the model answers with sentence numbers and a kind for each ("main",
// "evidence"...), never quoted text, so its answer is short and can't misquote
// the article. The numbers are then turned back into the sentence plus a
// little text either side, the way highlights are stored, so the reader can
// find them again.

export interface Sentence {
  /** 1-based number given to the model; 0 for fragments too short to be worth marking. */
  n: number;
  text: string;
  /** Where it starts in the article text. */
  start: number;
}

export interface Block {
  heading: string | null;
  sentences: Sentence[];
}

export interface SplitArticle {
  text: string;
  blocks: Block[];
  /** Numbered sentences, in order. */
  sentences: Sentence[];
  words: number;
  paragraphs: number;
}

const PAD = 32;
const MIN_WORDS_IN_SENTENCE = 4;
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Splits the article text (from htmlToText: one paragraph per line, headings
 * as "# ...") into sentences with their place in the text.
 */
export function splitArticle(text: string): SplitArticle {
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const blocks: Block[] = [{ heading: null, sentences: [] }];
  const sentences: Sentence[] = [];
  let paragraphs = 0;
  let pos = 0;
  for (const line of text.split('\n')) {
    const lineStart = pos;
    pos += line.length + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(trimmed);
    if (heading) {
      blocks.push({ heading: heading[1]!.trim(), sentences: [] });
      continue;
    }
    paragraphs++;
    // A list item's "- " isn't part of its sentence.
    const skip = line.length - line.trimStart().length + (/^- /.test(trimmed) ? 2 : 0);
    const body = line.slice(skip);
    for (const seg of segmenter.segment(body)) {
      const raw = seg.segment;
      const lead = raw.length - raw.trimStart().length;
      const sentence = raw.trim();
      if (!sentence) continue;
      const s: Sentence = { n: 0, text: sentence, start: lineStart + skip + seg.index + lead };
      if (wordCount(sentence) >= MIN_WORDS_IN_SENTENCE && /\p{L}/u.test(sentence)) {
        s.n = sentences.length + 1;
        sentences.push(s);
      }
      blocks[blocks.length - 1]!.sentences.push(s);
    }
  }
  return { text, blocks: blocks.filter((b) => b.sentences.length > 0), sentences, words: wordCount(text), paragraphs };
}

/** Outside links in the HTML, per 100 words of text: a link roundup has lots. */
export function linksPer100(html: string | null, words: number): number {
  if (!html || words === 0) return 0;
  const links = (html.match(/<a\b[^>]*\bhref\s*=\s*["']?https?:/gi) ?? []).length;
  return (links / words) * 100;
}

/** What the model reads, cut into pieces of at most `maxChars` at paragraph boundaries. */
export function promptPieces(split: SplitArticle, maxChars: number): string[] {
  const pieces: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) pieces.push(current.trim());
    current = '';
  };
  for (const block of split.blocks) {
    const lines: string[] = block.heading ? [`## ${block.heading}`] : [];
    for (const s of block.sentences) if (s.n > 0) lines.push(`[${s.n}] ${s.text}`);
    if (lines.length === (block.heading ? 1 : 0)) continue;
    const chunk = lines.join('\n') + '\n\n';
    if (current.length + chunk.length > maxChars && current) push();
    if (chunk.length > maxChars) {
      // One huge section: cut it by lines.
      for (const line of lines) {
        if (current.length + line.length + 1 > maxChars && current) push();
        current += line + '\n';
      }
      current += '\n';
    } else {
      current += chunk;
    }
  }
  push();
  return pieces;
}

/** The marks out of a model reply: {"marks": [{"s": 12, "k": "main"}]}, tolerating prose and code fences. */
export function parseKeyReply(reply: string, valid: Set<number>, kinds: KeyKind[]): { n: number; kind: KeyKind }[] {
  const cleaned = reply
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON');
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { marks?: unknown };
  const list = Array.isArray(parsed.marks) ? parsed.marks : [];
  const out: { n: number; kind: KeyKind }[] = [];
  const seen = new Set<number>();
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const v = m as Record<string, unknown>;
    const n = Number(v.s ?? v.sentence ?? v.n);
    const kind = String(v.k ?? v.kind ?? '')
      .toLowerCase()
      .trim();
    if (!Number.isInteger(n) || !valid.has(n) || seen.has(n) || !isKeyKind(kind) || !kinds.includes(kind)) continue;
    seen.add(n);
    out.push({ n, kind });
  }
  return out;
}

export const KEY_SCHEMA = {
  type: 'object',
  properties: {
    marks: {
      type: 'array',
      items: { type: 'object', properties: { s: { type: 'integer' }, k: { type: 'string' } }, required: ['s', 'k'] },
    },
  },
  required: ['marks'],
};

/** Turns chosen sentence numbers into stored marks: the sentence and a little text either side. */
export function toMarks(split: SplitArticle, picks: { n: number; kind: KeyKind }[]): KeyMark[] {
  const byN = new Map(split.sentences.map((s) => [s.n, s]));
  return picks
    .map((p) => ({ p, s: byN.get(p.n)! }))
    .filter((x) => x.s)
    .sort((a, b) => a.s.start - b.s.start)
    .map(({ p, s }) => ({
      kind: p.kind,
      // A link or bold word becomes " word " in the plain text; tidy the space before punctuation for the quote shown.
      quote: s.text.replace(/\s+([.,;:!?)\]])/g, '$1').replace(/([(\[])\s+/g, '$1'),
      prefix: split.text.slice(Math.max(0, s.start - PAD), s.start),
      suffix: split.text.slice(s.start + s.text.length, s.start + s.text.length + PAD),
      textOffset: s.start,
    }));
}

/** The article text the same way summaries see it, but not cut short. */
export function articleText(job: Pick<KeyJob, 'html' | 'text'>): string {
  return job.html ? htmlToText(job.html) : (job.text ?? '');
}

/** Checks before asking the model: long enough, not a link roundup. */
export function skipReason(job: KeyJob, split: SplitArticle): KeyResult['skipped'] | null {
  if (split.sentences.length < 3) return 'short';
  if (job.minWords > 0 && split.words < job.minWords) return 'short';
  if (job.skipRoundups) {
    if (linksPer100(job.html, split.words) >= job.roundupLinksPer100) return 'roundup';
    if (job.roundupParagraphWords > 0 && split.paragraphs > 0 && split.words / split.paragraphs < job.roundupParagraphWords) return 'roundup';
  }
  return null;
}

/** At most this many marks for the whole article (and a share of that for each piece). */
export const maxMarks = (sentences: number, maxShare: number) => Math.max(3, Math.floor((sentences * maxShare) / 100));
