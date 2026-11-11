// Key sentences: the PC marks the sentences that carry a long article (its
// main points, evidence, examples, caveats and takeaways) and the reader
// colours them. Kept apart from your own highlights: a key sentence only
// becomes a highlight when you tap "Keep as my highlight".

/** The five kinds, in legend order. Their names and meanings can be changed in Settings; the ids can't. */
export const KEY_KINDS = ['main', 'evidence', 'example', 'caveat', 'takeaway'] as const;
export type KeyKind = (typeof KEY_KINDS)[number];

export const isKeyKind = (v: unknown): v is KeyKind => typeof v === 'string' && (KEY_KINDS as readonly string[]).includes(v);

export interface KeyKindSetting {
  id: KeyKind;
  /** Shown in the legend and given to the model, e.g. "Main point". */
  name: string;
  /** What it marks, given to the model, e.g. "The claim a section is making". */
  meaning: string;
  on: boolean;
}

/** Auto: by length. Always: whatever the length. Never: skipped. */
export type KeyMode = 'auto' | 'always' | 'never';

export interface KeySentenceSettings {
  /** Off: no PC work, no colours, no filter, no inbox stripe. */
  enabled: boolean;
  /** Articles at least this long get key sentences automatically. */
  minWords: number;
  /** Roughly how many key sentences per section. */
  perSection: 1 | 2 | 3;
  /** At most this share of an article's sentences is coloured, in percent. */
  maxShare: number;
  /** Per category: Always or Never (missing = Auto). */
  categories: Record<string, Exclude<KeyMode, 'auto'>>;
  kinds: KeyKindSetting[];
  /** Open long articles with everything but the key sentences faded. */
  skimDefault: boolean;
  /** Link roundups (many links, short paragraphs) are skipped unless asked for by hand or set to Always. */
  roundupLinksPer100: number;
  roundupParagraphWords: number;
  /** The model to use, "provider:name"; empty = the first switched-on model. */
  model: string;
  /** Extra instructions added to the built-in prompt. */
  extraPrompt: string;
  /** Bumped whenever kinds, how many, or the prompt change, so runs can be compared. */
  promptVersion: number;
  /** When it was last switched on: only items summarised after this are done automatically. */
  since: number | null;
  /** Index of people, organisations, places and terms under articles with key sentences. */
  index: boolean;
  /** Collect studies and source links from every summarised article (not only long ones). */
  studies: boolean;
  /** Under an article, also list source links no other article has linked to. */
  linksAll: boolean;
}

export const DEFAULT_KEY_KINDS: KeyKindSetting[] = [
  { id: 'main', name: 'Main point', meaning: 'The claim or point this section is making', on: true },
  { id: 'evidence', name: 'Evidence', meaning: 'Numbers, studies, data or results that back a point up', on: true },
  { id: 'example', name: 'Example', meaning: 'A concrete case, story or telling quote', on: true },
  { id: 'caveat', name: 'Caveat', meaning: 'A limit, risk, doubt or the other side of the argument', on: true },
  { id: 'takeaway', name: 'Takeaway', meaning: 'What it means for the reader, or what happens next', on: true },
];

export const DEFAULT_KEY_SETTINGS: KeySentenceSettings = {
  enabled: false,
  minWords: 1500,
  perSection: 2,
  maxShare: 12,
  categories: {},
  kinds: DEFAULT_KEY_KINDS,
  skimDefault: false,
  roundupLinksPer100: 4,
  roundupParagraphWords: 18,
  model: '',
  extraPrompt: '',
  promptVersion: 1,
  since: null,
  index: true,
  studies: true,
  linksAll: false,
};

/** One coloured sentence. Found again in the article the way highlights are (the text, with a little either side). */
export interface KeyMark {
  kind: KeyKind;
  quote: string;
  prefix: string;
  suffix: string;
  /** Where the sentence started in the PC's copy of the text. */
  textOffset: number;
  /** Your corrections: 'removed' (Not key) hides it; a changed kind keeps the model's in `was`. */
  fix?: 'removed' | 'kind';
  was?: KeyKind;
  /** The article's own heading this sentence sits under, for the Outline (null = before the first heading). */
  section?: string | null;
}

export const INDEX_TYPES = ['person', 'org', 'place', 'term'] as const;
export type IndexType = (typeof INDEX_TYPES)[number];
export const INDEX_TYPE_NAMES: Record<IndexType, string> = { person: 'People', org: 'Organisations', place: 'Places', term: 'Terms' };

/** One Index entry: named in the article this many times. */
export interface IndexTerm {
  term: string;
  type: IndexType;
  count: number;
}

/** null = never looked at; none = checked and skipped (too short, a link roundup, nothing found). */
export type KeyStatus = 'pending' | 'working' | 'done' | 'none' | 'failed';

/** GET /api/items/:id/key-sentences */
export interface ItemKeySentences {
  status: KeyStatus | null;
  /** Why it was skipped or failed, in plain words. */
  note: string | null;
  marks: KeyMark[];
  /** Sentences in the PC's copy, for "12 of 140 sentences". */
  sentences: number | null;
  model: string | null;
  kinds: KeyKindSetting[];
  skimDefault: boolean;
  /** When the PC last checked in; shown while waiting. */
  helperLastSeenAt: number | null;
  /** The Index (empty when switched off or not done). */
  terms: IndexTerm[];
}

/** POST /api/items/:id/key-sentences/fix */
export interface KeyFixInput {
  /** Position in the marks list. */
  index: number;
  action: 'remove' | 'kind' | 'restore';
  kind?: KeyKind;
}

/** The inbox Type filter's token for "has key sentences". */
export const KEY_FILTER_TOKEN = 'keysent';

// ----- PC helper side -----

export interface KeyJob {
  itemId: string;
  subject: string;
  sourceName: string | null;
  html: string | null;
  text: string | null;
  /** The instructions, kinds and their meanings filled in. */
  prompt: string;
  kinds: KeyKind[];
  /** Skip when the PC's copy is shorter than this (0 when asked for by hand or set to Always). */
  minWords: number;
  /** Skip link roundups (false when asked for by hand or set to Always). */
  skipRoundups: boolean;
  roundupLinksPer100: number;
  roundupParagraphWords: number;
  perSection: number;
  maxShare: number;
  /** The model the settings ask for, if any. */
  model: { provider: string; name: string } | null;
  /** Ask for Index terms too. */
  index?: boolean;
}

export interface KeyResult {
  itemId: string;
  ok: boolean;
  provider: string;
  model: string;
  seconds: number;
  watts?: number;
  error?: string;
  /** Checked, but not done: why. */
  skipped?: 'short' | 'roundup' | 'empty';
  marks?: KeyMark[];
  sentences?: number;
  words?: number;
  terms?: IndexTerm[];
}

// ----- Studies and source links -----
// Studies, reports and surveys an article cites go into one shared collection,
// so the same study can be seen across articles (and when they quote it
// differently). Source links are collected quietly and only shown once two or
// more articles point to the same one.

/** A study as one article cites it, from the PC. */
export interface StudyCiteIn {
  title: string;
  publisher: string | null;
  year: number | null;
  doi: string | null;
  url: string | null;
  /** What the article says the study found, in a few words. */
  claim: string | null;
  /** The sentence that cites it, anchored like key sentences. */
  quote: string;
  prefix: string;
  suffix: string;
  textOffset: number;
  /** Numbers in that sentence ("40%", "1.2 million"), for spotting articles that quote it differently. */
  numbers: string[];
}

export interface LinkIn {
  url: string;
  text: string;
}

export interface RefJob {
  itemId: string;
  subject: string;
  sourceName: string | null;
  /** The article's own web address, so links back to the same site are left out. */
  url: string | null;
  html: string | null;
  text: string | null;
  prompt: string;
  model: { provider: string; name: string } | null;
}

export interface RefResult {
  itemId: string;
  ok: boolean;
  provider: string;
  model: string;
  seconds: number;
  watts?: number;
  error?: string;
  studies?: StudyCiteIn[];
  links?: LinkIn[];
}

export interface StudySummary {
  id: string;
  title: string;
  publisher: string | null;
  year: number | null;
  url: string | null;
  doi: string | null;
  /** How many articles cite it. */
  cites: number;
  /** Articles quote it with different numbers. */
  differs: boolean;
  lastSeen: number;
}

/** A study under one article (References tab). */
export interface ItemStudy extends StudySummary {
  citeId: string;
  claim: string | null;
  quote: string;
  prefix: string;
  suffix: string;
  textOffset: number;
  /** This article's numbers differ from another article's. */
  citeDiffers: boolean;
  /** A study that may be the same one, waiting for Same / Different. */
  maybe: { id: string; title: string; cites: number } | null;
}

export interface LinkSummary {
  id: string;
  url: string;
  host: string;
  title: string | null;
  cites: number;
  lastSeen: number;
}

/** GET /api/items/:id/references */
export interface ItemReferences {
  status: KeyStatus | null;
  studies: ItemStudy[];
  /** Links 2+ articles point to (all of them when "show links seen once" is on). */
  links: LinkSummary[];
  /** Links only this article points to, left out to avoid clutter. */
  hiddenLinks: number;
}

export interface StudyCite {
  id: string;
  itemId: string;
  subject: string;
  sourceName: string | null;
  receivedAt: number;
  claim: string | null;
  quote: string;
  numbers: string[];
  /** The other cite this one disagrees with. */
  differsFrom: string | null;
}

/** GET /api/studies/:id */
export interface StudyDetail extends StudySummary {
  citedBy: StudyCite[];
  maybe: { id: string; title: string; publisher: string | null; year: number | null; cites: number }[];
}

export interface LinkDetail extends LinkSummary {
  items: { itemId: string; subject: string; sourceName: string | null; receivedAt: number; text: string }[];
}

/** CSS colour for each kind: [tint, line] in light and dark. Yellow is left for your own highlights. */
export const KEY_COLOURS: Record<KeyKind, { light: [string, string]; dark: [string, string] }> = {
  main: { light: ['#dbe8ff', '#2f62c9'], dark: ['#1c2b47', '#7aa5ff'] },
  evidence: { light: ['#d9f2e1', '#1f8a46'], dark: ['#173323', '#6fd393'] },
  example: { light: ['#ece4fb', '#7148c4'], dark: ['#2a2342', '#b79cf5'] },
  caveat: { light: ['#fde2e2', '#c23b3b'], dark: ['#3d1f22', '#f08a8a'] },
  takeaway: { light: ['#ffe6cc', '#c8650f'], dark: ['#3d2a15', '#f5a85c'] },
};

// ----- Statistics -----

/** What the reader counts (once per article each), for Statistics > Key sentences. */
export const KEY_USE_EVENTS = ['open', 'off', 'skim', 'step', 'legend', 'outline', 'index', 'refs', 'jump', 'keep', 'find'] as const;
export type KeyUseEvent = (typeof KEY_USE_EVENTS)[number];

export interface KeyStats {
  days: number;
  enabled: boolean;
  /** Articles given key sentences in the period, and how many of them by hand. */
  treated: number;
  manual: number;
  skipped: { short: number; roundup: number; empty: number };
  failed: number;
  avgMarks: number | null;
  avgSeconds: number | null;
  totalSeconds: number;
  /** One point a day: articles treated. */
  daily: { at: number; treated: number }[];
  /** How often each colour appears. */
  kinds: { kind: KeyKind; count: number; per1000: number | null }[];
  bySource: { name: string; articles: number; marks: number; kinds: Partial<Record<KeyKind, number>> }[];
  byCategory: { name: string; articles: number; marks: number; kinds: Partial<Record<KeyKind, number>> }[];
  /** Your Not key / Wrong colour per kind (as the model chose it) and per model. */
  corrections: { kind: KeyKind; marks: number; removed: number; recoloured: number }[];
  byModel: { model: string; articles: number; marks: number; removed: number; recoloured: number; avgSeconds: number | null }[];
  /** Counted in the reader, per article opened. */
  use: Partial<Record<KeyUseEvent, number>>;
  /** Long articles opened in the period, with and without key sentences. */
  readThrough: { with: ReadThrough; without: ReadThrough };
  studies: { seen: number; citedTwice: number; differs: number; links: number };
}

export interface ReadThrough {
  opened: number;
  /** Scrolled to 90% or more. */
  finished: number;
  avgMinutes: number | null;
}
