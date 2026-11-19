// Morning catch-up: a start-of-day review of the pile that built up while you
// were away, made for the many items you would only skim and mark read. Items
// you are likely to read in full (followed stories, Likely interesting, sources
// you usually read) stay in the inbox. The rest is grouped into themes the PC
// makes fresh each time (falling back to your categories), with one short
// overview written from the summaries it already has, so a theme can be
// cleared in one tap.

/** How much the catch-up takes in: 1 Light, 2 Normal, 3 Deep. */
export type CatchUpLevel = 1 | 2 | 3;

export const CATCH_UP_LEVELS: { level: CatchUpLevel; label: string; text: string }[] = [
  { level: 1, label: 'Light', text: 'Just the top: Probably skip, plus sources you nearly always skip.' },
  { level: 2, label: 'Normal', text: 'Everything except what you would likely read.' },
  { level: 3, label: 'Deep', text: 'Catches more: also sources you read in full some of the time.' },
];

export interface CatchUpSettings {
  /** Build a morning catch-up. */
  on: boolean;
  /** Local hour it is built (0-23). */
  hour: number;
  /** Only build when at least this many came in since your last visit. */
  minNew: number;
  /** Also build after a break: when this many arrive while you are away breakHours or more (0 = off). */
  afterBreak: number;
  breakHours: number;
  /** Show a banner at the top of the inbox when one is ready. */
  banner: boolean;
  /** Where the dial starts. */
  startLevel: CatchUpLevel;
  /** Clear the Probably skip pile (adverts, Probably not for you, sources you mark Not interested) as Not interested, which teaches the app; off clears it as plain read. */
  skipPile: boolean;
}

export const DEFAULT_CATCH_UP: CatchUpSettings = {
  on: true,
  hour: 6,
  minNew: 25,
  afterBreak: 40,
  breakHours: 6,
  banner: true,
  startLevel: 2,
  skipPile: true,
};

/** Why an item is kept out of the catch-up at some levels. */
export type CatchUpKeep = 'followed' | 'likely' | 'saved' | 'source';
/** Why an item is in the Probably skip pile. */
export type CatchUpSkip = 'advert' | 'unlikely' | 'not_interested';

export interface CatchUpItem {
  id: string;
  subject: string;
  sourceId: string | null;
  sourceName: string | null;
  receivedAt: number;
  /** The AI summary's first sentence or so, else the preview line. */
  line: string | null;
  category: string | null;
  storyId: string | null;
  storyTitle: string | null;
  /**
   * The lowest dial level that takes this item in: 1 = Light and up, 2 = Normal
   * and up, 3 = Deep only, 0 = never (it stays in the inbox and shows greyed).
   */
  level: 0 | CatchUpLevel;
  keep?: CatchUpKeep;
  skip?: CatchUpSkip;
}

export interface CatchUpTheme {
  id: string;
  name: string;
  /** One line on what the theme holds (the PC writes it). */
  gist: string | null;
  /** Grouped by your own category rather than a theme the PC made. */
  fromCategory: boolean;
  itemIds: string[];
}

export interface CatchUp {
  id: string;
  builtAt: number;
  /** Your last visit: the catch-up covers what arrived after it. */
  fromAt: number;
  toAt: number;
  items: CatchUpItem[];
  themes: CatchUpTheme[];
  overview: string | null;
  model: string | null;
  /** waiting / working: the PC is making the themes; done; failed (themes are by category). */
  status: 'waiting' | 'working' | 'done' | 'failed';
  error: string | null;
  doneAt: number | null;
  /** Ids from the catch-up that are now read or gone (cleared here or elsewhere). */
  goneIds: string[];
  /** Cleared from this catch-up, by how: themes and Clear all, or the Probably skip pile. */
  cleared: number;
  notInterested: number;
  startLevel: CatchUpLevel;
  skipPile: boolean;
}

export interface CatchUpListItem {
  id: string;
  builtAt: number;
  total: number;
  cleared: number;
  doneAt: number | null;
}

export interface CatchUpBanner {
  id: string;
  /** Items the catch-up would clear at the starting level, still unread. */
  toSkim: number;
  /** Likely reads kept in the inbox. */
  kept: number;
}

// ---------- PC job ----------

export interface CatchUpJobItem {
  /** Number used in the prompt. */
  n: number;
  id: string;
  text: string;
  tags: string[];
  category: string | null;
  storyId: string | null;
}

export interface CatchUpJob {
  catchUpId: string;
  prompt: string;
  items: CatchUpJobItem[];
  /** The owner's categories, for the fallback groups. */
  categories: string[];
}

export interface CatchUpResult {
  catchUpId: string;
  ok: boolean;
  provider: string;
  model: string;
  seconds: number;
  watts?: number;
  error?: string;
  overview?: string;
  themes?: { name: string; gist: string; fromCategory: boolean; itemIds: string[] }[];
}
