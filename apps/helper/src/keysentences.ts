import {
  INDEX_TYPES,
  isKeyKind,
  type IndexTerm,
  type IndexType,
  type KeyJob,
  type KeyKind,
  type KeyMark,
  type KeyResult,
  type LinkIn,
  type StudyCiteIn,
} from '@newsletterapp/shared';
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
  /** The heading it sits under (null before the first one). */
  section: string | null;
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
      const s: Sentence = { n: 0, text: sentence, start: lineStart + skip + seg.index + lead, section: blocks[blocks.length - 1]!.heading };
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

/** The JSON object in a model reply, tolerating thinking, prose and code fences. */
export function replyJson(reply: string): Record<string, unknown> {
  const cleaned = reply
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON');
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

/** The marks out of a model reply: {"marks": [{"s": 12, "k": "main"}]}. */
export function parseKeyReply(reply: string, valid: Set<number>, kinds: KeyKind[]): { n: number; kind: KeyKind }[] {
  const parsed = replyJson(reply);
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

/** The Index terms the model named: {"terms": [{"t": "Leeds", "y": "place"}]}. */
export function parseTermsReply(reply: string): { term: string; type: IndexType }[] {
  const parsed = replyJson(reply);
  const list = Array.isArray(parsed.terms) ? parsed.terms : [];
  const out: { term: string; type: IndexType }[] = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const v = t as Record<string, unknown>;
    const term = String(v.t ?? v.term ?? '').replace(/\s+/g, ' ').trim();
    const y = String(v.y ?? v.type ?? '').toLowerCase().trim();
    const type = (INDEX_TYPES as readonly string[]).includes(y) ? (y as IndexType) : y === 'organisation' || y === 'organization' ? 'org' : 'term';
    if (term.length >= 2 && term.length <= 80) out.push({ term, type });
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Index entries that really are in the text, with how often they appear; the most mentioned first. */
export function countTerms(text: string, named: { term: string; type: IndexType }[], max = 60): IndexTerm[] {
  const out: IndexTerm[] = [];
  const seen = new Set<string>();
  for (const { term, type } of named) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Whole words only; names keep their capitals, ordinary terms don't need to.
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, type === 'term' ? 'giu' : 'gu');
    const count = (text.match(re) ?? []).length;
    if (count > 0) out.push({ term, type, count });
  }
  return out.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term)).slice(0, max);
}

const MARKS_SCHEMA = {
  type: 'array',
  items: { type: 'object', properties: { s: { type: 'integer' }, k: { type: 'string' } }, required: ['s', 'k'] },
};

export const KEY_SCHEMA = {
  type: 'object',
  properties: { marks: MARKS_SCHEMA },
  required: ['marks'],
};

/** With the Index on: terms too. */
export const KEY_TERMS_SCHEMA = {
  type: 'object',
  properties: {
    marks: MARKS_SCHEMA,
    terms: { type: 'array', items: { type: 'object', properties: { t: { type: 'string' }, y: { type: 'string' } }, required: ['t', 'y'] } },
  },
  required: ['marks', 'terms'],
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
      quote: tidy(s.text),
      prefix: split.text.slice(Math.max(0, s.start - PAD), s.start),
      suffix: split.text.slice(s.start + s.text.length, s.start + s.text.length + PAD),
      textOffset: s.start,
      section: s.section,
    }));
}

const tidy = (text: string) => text.replace(/\s+([.,;:!?)\]])/g, '$1').replace(/([(\[])\s+/g, '$1');

// ---------- Studies and links ----------

/** Sentences that might cite a study: the only ones the model needs to see. */
const CUE =
  /\b(stud(y|ies)|research(ers)?|report(ed|s)?|survey(ed|s)?|poll(ed|s|ing)?|paper|journal|published|according to|data (from|show)|analysis|found that|finds|estimate[sd]?|census|statistic|meta-analysis|trial|preprint|working paper|institute|university|universit(y|ies)|bureau|office for|department of|commission|agency|think tank|white paper|dataset|index|findings|doi\.org|et al)\b/i;

export function citeCandidates(split: SplitArticle, maxSentences = 120): Sentence[] {
  return split.sentences.filter((s) => CUE.test(s.text)).slice(0, maxSentences);
}

export const refsPromptText = (cands: Sentence[]) => cands.map((s) => `[${s.n}] ${s.text}`).join('\n');

export const REFS_SCHEMA = {
  type: 'object',
  properties: {
    studies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          s: { type: 'integer' },
          title: { type: 'string' },
          publisher: { type: ['string', 'null'] },
          year: { type: ['integer', 'null'] },
          claim: { type: ['string', 'null'] },
        },
        required: ['s', 'title'],
      },
    },
  },
  required: ['studies'],
};

/** Links in the article's HTML with their words, in order (images and mail links left out). */
export function htmlLinks(html: string | null): LinkIn[] {
  if (!html) return [];
  const out: LinkIn[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const url = (m[1] ?? m[2] ?? m[3] ?? '').replace(/&amp;/g, '&').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const text = htmlToText(m[4] ?? '').replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
    out.push({ url, text: text.slice(0, 200) });
    if (out.length >= 400) break;
  }
  return out;
}

const DOI = /\b(10\.\d{4,9}\/[^\s"'<>,;)]+[^\s"'<>,;).])/i;

/** Numbers in a sentence, written one way: "40%", "40 percent" -> "40%"; "1.2 million" -> "1.2m". Same as the Worker's. */
export function numbersIn(text: string): string[] {
  const out = new Set<string>();
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(%|per ?cent|percent|million|billion|trillion|bn|m\b|k\b)?/gi;
  for (const m of text.matchAll(re)) {
    const n = m[1]!.replace(/,/g, '');
    const unit = (m[2] ?? '').toLowerCase();
    if (!unit && /^(19|20)\d\d$/.test(n)) continue;
    if (!unit && Number(n) < 10) continue;
    const u = unit.startsWith('per') || unit === '%' ? '%' : unit === 'million' || unit === 'm' ? 'm' : unit === 'billion' || unit === 'bn' ? 'bn' : unit === 'trillion' ? 'tn' : unit;
    out.add(`${n}${u}`);
  }
  return [...out].slice(0, 12);
}

/** The studies out of the model's reply, anchored to their sentences, with a link when the sentence carries one. */
export function parseRefsReply(reply: string, split: SplitArticle, valid: Set<number>, links: LinkIn[]): StudyCiteIn[] {
  const parsed = replyJson(reply);
  const list = Array.isArray(parsed.studies) ? parsed.studies : [];
  const byN = new Map(split.sentences.map((s) => [s.n, s]));
  const out: StudyCiteIn[] = [];
  const seen = new Set<string>();
  for (const raw of list.slice(0, 25)) {
    if (!raw || typeof raw !== 'object') continue;
    const v = raw as Record<string, unknown>;
    const n = Number(v.s ?? v.sentence);
    const s = byN.get(n);
    const title = typeof v.title === 'string' ? v.title.replace(/\s+/g, ' ').trim() : '';
    if (!s || !valid.has(n) || title.length < 4 || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const str = (x: unknown) => (typeof x === 'string' && x.trim() && x.trim().toLowerCase() !== 'null' ? x.trim() : null);
    const year = Number(v.year);
    // A link whose words are in the citing sentence is the study's link.
    const link = links.find((l) => l.text.length >= 3 && s.text.includes(l.text));
    const doi = DOI.exec(s.text)?.[1] ?? (link ? DOI.exec(link.url)?.[1] : undefined) ?? null;
    out.push({
      title: title.slice(0, 200),
      publisher: str(v.publisher)?.slice(0, 120) ?? null,
      year: Number.isInteger(year) && year >= 1800 && year <= 2100 ? year : null,
      doi: doi ? doi.toLowerCase() : null,
      url: link?.url ?? null,
      claim: str(v.claim)?.slice(0, 300) ?? null,
      quote: tidy(s.text),
      prefix: split.text.slice(Math.max(0, s.start - PAD), s.start),
      suffix: split.text.slice(s.start + s.text.length, s.start + s.text.length + PAD),
      textOffset: s.start,
      numbers: numbersIn(s.text),
    });
  }
  return out;
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
