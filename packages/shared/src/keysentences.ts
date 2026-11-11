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
}

/** CSS colour for each kind: [tint, line] in light and dark. Yellow is left for your own highlights. */
export const KEY_COLOURS: Record<KeyKind, { light: [string, string]; dark: [string, string] }> = {
  main: { light: ['#dbe8ff', '#2f62c9'], dark: ['#1c2b47', '#7aa5ff'] },
  evidence: { light: ['#d9f2e1', '#1f8a46'], dark: ['#173323', '#6fd393'] },
  example: { light: ['#ece4fb', '#7148c4'], dark: ['#2a2342', '#b79cf5'] },
  caveat: { light: ['#fde2e2', '#c23b3b'], dark: ['#3d1f22', '#f08a8a'] },
  takeaway: { light: ['#ffe6cc', '#c8650f'], dark: ['#3d2a15', '#f5a85c'] },
};
