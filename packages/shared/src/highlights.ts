// Highlights and "ask the AI" about highlighted text: shared between the
// Worker, the web app and the PC helper.

import type { ModelRef } from './index';

/** Where an answer goes: a note on the article, a new article from "AI notes", or both. */
export type AskOutput = 'note' | 'item' | 'both';

/** What the helper looks up before answering (lookups arrive in a later update). */
export type LookupMode = 'none' | 'wiki' | 'web' | 'both';

/** Enough of the article's text to find a highlight again after the page is drawn afresh. */
export interface HighlightAnchor {
  /** The highlighted text exactly as it appears in the article. */
  quote: string;
  /** About 32 characters just before and after, to pick the right copy when the quote repeats. */
  prefix: string;
  suffix: string;
  /** Rough position of the quote in the article's text, the last tie-breaker. */
  textOffset: number;
  /** The paragraph around the quote, for the AI. */
  context: string;
}

export interface Highlight extends HighlightAnchor {
  id: string;
  itemId: string;
  color: string;
  createdAt: number;
}

export type AskStatus = 'pending' | 'working' | 'done' | 'failed';

export interface AskSource {
  title: string;
  url: string;
}

export interface Ask {
  id: string;
  highlightId: string;
  itemId: string;
  presetId: string | null;
  /** "Define", "More info", or "Your question" for one you typed. */
  label: string;
  presetVersion: number | null;
  question: string | null;
  output: AskOutput;
  status: AskStatus;
  provider: string | null;
  model: string | null;
  /** Light Markdown: paragraphs, bold, italics, lists, links. */
  answer: string | null;
  sources: AskSource[];
  error: string | null;
  rating: -1 | 1 | null;
  seconds: number | null;
  /** Lookups that were wanted but couldn't be made, e.g. "web search: no key on the PC". */
  lookupNote: string | null;
  /** The "AI notes" article made from this answer, when the output included one. */
  newItemId: string | null;
  createdAt: number;
  doneAt: number | null;
}

/** GET /api/items/:id/highlights */
export interface ItemHighlights {
  highlights: Highlight[];
  asks: Ask[];
  /** When the PC helper last checked in; only filled in while an ask is waiting. */
  helperLastSeenAt: number | null;
}

export interface AskPreset {
  id: string;
  label: string;
  /** The instructions, with {quote} {context} {title} {source} {interests} slots. */
  body: string;
  output: AskOutput;
  lookups: LookupMode;
  position: number;
  enabled: boolean;
  version: number;
  updatedAt: number;
  /** One of the presets the app ships with (they can be edited and switched off, not deleted). */
  builtIn: boolean;
}

export interface AskPresetInput {
  label?: string;
  body?: string;
  output?: AskOutput;
  lookups?: LookupMode;
  enabled?: boolean;
}

/** POST /api/asks: ask about an existing highlight, or highlight and ask in one go. */
export interface NewAskInput {
  itemId: string;
  highlightId?: string;
  highlight?: HighlightAnchor;
  /** A preset, or null/absent with a question for "Ask your own". */
  presetId?: string | null;
  question?: string;
  /** 'default' (or absent) = the preset's own default. */
  output?: AskOutput | 'default';
}

/** A question on its own (Add > Ask the AI), answered as an "AI notes" article. */
export interface NewFreeAskInput {
  /** The text to ask about, e.g. a paragraph pasted from elsewhere. */
  text?: string;
  /** A preset, or null/absent with a question for "Ask your own". */
  presetId?: string | null;
  question?: string;
  /** Absent = the preset's own setting (Wikipedia and web for your own question). */
  lookups?: LookupMode;
}

/** GET /api/asks/free: your latest questions from the Ask the AI page, newest first. */
export interface FreeAskList {
  asks: (Ask & { text: string | null; lookups: LookupMode })[];
  helperLastSeenAt: number | null;
}

export interface NewAskResult {
  highlight: Highlight;
  ask: Ask;
}

/** One ask for the PC helper to answer. */
export interface AskJob {
  askId: string;
  itemId: string;
  subject: string;
  sourceName: string | null;
  fromName: string | null;
  html: string | null;
  text: string | null;
  /** The finished instructions (system prompt). */
  prompt: string;
  quote: string;
  context: string;
  question: string | null;
  lookups: LookupMode;
  /** Whether web search may be used for this one (the monthly budget isn't used up). */
  searchAllowed: boolean;
  /** The model to use when the work is split; otherwise the helper's first. */
  model?: ModelRef;
}

export interface AskResultInput {
  askId: string;
  ok: boolean;
  provider: string;
  model: string;
  seconds: number;
  watts?: number;
  answer?: string;
  sources?: AskSource[];
  error?: string;
  /** Web searches made for this answer, for the monthly budget. */
  searches?: number;
  /** Lookups that were wanted but failed (no key, budget used up, site down), shown under the note. */
  lookupNote?: string;
}

// ---------- Web search ----------

/** Settings > AI > Web search. The search key itself stays on the PC. */
export interface WebSearchSettings {
  /** Searches allowed per calendar month (set it to your Brave plan's allowance). */
  monthlyBudget: number;
  /** Summaries of items in these categories, or from these sources, search the web too. */
  summaryCategories: string[];
  summarySources: string[];
}

export const DEFAULT_WEB_SEARCH: WebSearchSettings = { monthlyBudget: 1500, summaryCategories: [], summarySources: [] };

export interface WebSearchView {
  settings: WebSearchSettings;
  /** YYYY-MM, UTC. */
  month: string;
  used: number;
  /** Searches made this month for highlight questions and for summaries. */
  usedAsks: number;
  usedSummaries: number;
  /** Searches made for weekly and monthly reviews. */
  usedReviews: number;
  /** Searches made by Find a way to follow; older apps leave it out. */
  usedLookups?: number;
  /** What the helper said at its last check-in: null when it has no key, undefined when it hasn't said (older helper or never seen). */
  pcSearch: 'brave' | null | undefined;
  helperLastSeenAt: number | null;
}

/** What happens while the PC is off. Only waiting for now; a Cloudflare AI choice can join later. */
export type PcOffMode = 'wait';

// ---------- Built-in presets ----------

/** Added to every ask's instructions, so the answer comes back in the shape the app shows. */
export const ASK_RULES = `
Write for one reader on a phone. Answer in plain text with light Markdown only: short paragraphs, **bold**, simple "- " lists, [links](https://...). No JSON, no tables, no headings bigger than ###.
Keep it under 200 words unless the task asks for more. Lead with the answer, no preamble such as "Sure" or "In this article".
The user message holds the article; use it as context. Don't invent facts, names, numbers or links. When you aren't sure, say so plainly.`;

export interface PresetSeed {
  id: string;
  label: string;
  body: string;
  output: AskOutput;
  lookups: LookupMode;
}

export const DEFAULT_ASK_PRESETS: PresetSeed[] = [
  {
    id: 'define',
    label: 'Define',
    output: 'note',
    lookups: 'wiki',
    body: `The reader highlighted "{quote}" in "{title}" from {source}.
Paragraph it sits in: "{context}"

Define it in 1-3 plain sentences, in the sense it's used in this article. Then one line starting "Here:" on what it means for this article. If it's a person, company or product, say who or what it is instead.`,
  },
  {
    id: 'more',
    label: 'More info',
    output: 'item',
    lookups: 'both',
    body: `The reader highlighted "{quote}" in "{title}" from {source} and wants more background.
Paragraph it sits in: "{context}"

Give the background a well-read friend would: what it is, the key facts and recent history, and what the article leaves out or assumes you know. Finish with a short "Read more" list of good places to look, only ones you are sure exist. Say clearly where your knowledge may be out of date.`,
  },
  {
    id: 'example',
    label: 'Example',
    output: 'note',
    lookups: 'none',
    body: `The reader highlighted "{quote}" in "{title}" from {source}.
Paragraph it sits in: "{context}"

Give 1-2 concrete, real-world examples that show what this means, in the sense the article uses it. Keep each example to 2-3 sentences. Prefer well-known, checkable examples over made-up ones, and say if an example is hypothetical.`,
  },
  {
    id: 'simple',
    label: 'Explain simply',
    output: 'note',
    lookups: 'none',
    body: `The reader highlighted this passage in "{title}" from {source}: "{quote}"
Paragraph it sits in: "{context}"

Explain it for someone new to the subject: no jargon, short sentences, and an everyday analogy if one really helps.`,
  },
  {
    id: 'factcheck',
    label: 'Fact-check',
    output: 'note',
    lookups: 'web',
    body: `The reader highlighted this claim in "{title}" from {source}: "{quote}"
Paragraph it sits in: "{context}"

Is it right? Start with one word: **Likely true**, **Misleading**, **Likely false** or **Can't check**. Then say what supports it, what doesn't, and how sure anyone can be. If you can't check it from what you know, say "Can't check" rather than guessing.`,
  },
  {
    id: 'otherside',
    label: 'Other side',
    output: 'note',
    lookups: 'web',
    body: `The reader highlighted this in "{title}" from {source}: "{quote}"
Paragraph it sits in: "{context}"

Give the strongest fair counter-argument or other point of view, as its best supporters would put it. Then one line on where the two sides actually disagree.`,
  },
  {
    id: 'matters',
    label: 'Why it matters to me',
    output: 'note',
    lookups: 'none',
    body: `The reader highlighted this in "{title}" from {source}: "{quote}"
Paragraph it sits in: "{context}"
The reader is interested in: {interests}

In 2-4 sentences, say how this connects to those interests and whether there's anything they might want to do, watch or read next. If it doesn't really connect, say so.`,
  },
  {
    id: 'translate',
    label: 'Translate',
    output: 'note',
    lookups: 'none',
    body: `Translate this passage into English (if it's already English, into plain English): "{quote}"
Keep names, numbers and links exactly as they are. Give the translation first, then one line on anything that doesn't translate well.`,
  },
];

/** "Ask your own": the reader's typed question about the highlighted text. */
export const CUSTOM_ASK_PROMPT = `The reader highlighted "{quote}" in "{title}" from {source}.
Paragraph it sits in: "{context}"

Their question: {question}

Answer that question directly.`;

/** Fills a preset's slots. {question} is only used by "Ask your own". */
export function fillAskPrompt(
  body: string,
  v: { quote: string; context: string; title: string; source: string; interests: string; question?: string | null },
): string {
  return (
    body
      .replaceAll('{quote}', v.quote)
      .replaceAll('{context}', v.context || v.quote)
      .replaceAll('{title}', v.title || 'an article')
      .replaceAll('{source}', v.source || 'an unknown source')
      .replaceAll('{interests}', v.interests || 'general news')
      .replaceAll('{question}', v.question ?? '') + `\n${ASK_RULES}`
  );
}

// ---------- Light Markdown to safe HTML ----------

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Bold, italics, code and http(s) links, on text that is already escaped. */
function inline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer nofollow">$1</a>');
}

/**
 * The model's light Markdown as HTML. Everything is escaped first, so the only
 * tags that come out are the handful made here, and links are http(s) only.
 */
export function markdownToHtml(md: string): string {
  const lines = md
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\r/g, '')
    .split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map((l) => inline(escapeHtml(l))).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(escapeHtml(i))}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      out.push(`<h4>${inline(escapeHtml(heading[1]!))}</h4>`);
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return out.join('\n');
}

/** Plain text of the Markdown, for previews. */
export function markdownToText(md: string): string {
  return md
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*([-*•]|\d+[.)])\s+/gm, '')
    .replace(/[*`#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Highlights page and statistics ----------

/** One highlight on the Highlights page, with the article it's in. */
export interface HighlightListRow {
  id: string;
  itemId: string;
  quote: string;
  createdAt: number;
  itemTitle: string;
  sourceId: string | null;
  sourceName: string | null;
  category: string;
  /** The prompts asked about it, oldest first ("Ask your own" shows as its question's label). */
  asks: string[];
}

export interface HighlightListQuery {
  /** Highlights made before this time (the `next` of the previous page). */
  before?: number;
  q?: string;
  /** 'asked' = with at least one question; 'plain' = just highlighted. */
  kind?: 'asked' | 'plain';
  sourceId?: string;
  category?: string;
}

export interface HighlightList {
  highlights: HighlightListRow[];
  /** Pass as `before` for the next page; null when there are no more. */
  next: number | null;
  /** Sources and categories that have highlights, for the filters. */
  sources: { id: string; name: string; count: number }[];
  categories: { category: string; count: number }[];
}

export interface HighlightStatsGroup {
  key: string;
  name: string;
  highlights: number;
  asks: number;
}

export interface HighlightPromptStats {
  label: string;
  asks: number;
  failed: number;
  up: number;
  down: number;
  medianSeconds: number | null;
}

export interface HighlightStats {
  days: number;
  totals: {
    highlights: number;
    /** Highlights with no question asked. */
    plain: number;
    asked: number;
    asks: number;
    /** Articles with at least one highlight. */
    articles: number;
    /** Highlights per 100 items read in the period, null when nothing was read. */
    per100Read: number | null;
  };
  /** Last 28 days, by local day. */
  daily: { day: string; at: number; highlights: number; asks: number }[];
  bySource: HighlightStatsGroup[];
  byCategory: HighlightStatsGroup[];
  byPrompt: HighlightPromptStats[];
  byModel: HighlightPromptStats[];
  /** Where answers went. */
  output: Record<AskOutput, number>;
  mostHighlighted: { itemId: string; title: string; sourceName: string | null; highlights: number }[];
  searches: { month: string; used: number; budget: number; asks: number; summaries: number };
}
