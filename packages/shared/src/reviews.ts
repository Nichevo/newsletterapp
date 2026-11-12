// Weekly and monthly reviews: they replace the daily digest. The Worker
// gathers the period's facts (stories, tag trends, sources, stars, reading)
// into a "pack" when the review is due; the PC helper then writes the text
// with the local model and runs a few web searches for new information and
// connections. A review with no PC still shows its charts and lists.

import type { DigestStory } from './index';

export type ReviewKind = 'week' | 'month';

/** Parts of a review that can be switched off in Settings > Reviews. */
export type ReviewPart =
  | 'top'
  | 'stories'
  | 'trends'
  | 'sources'
  | 'stars'
  | 'further'
  | 'reading'
  | 'coming'
  | 'arcs'
  | 'interests'
  | 'sourceReview'
  | 'categories';

export const REVIEW_PARTS: { part: ReviewPart; label: string; kinds: ReviewKind[] }[] = [
  { part: 'top', label: 'Top of the week', kinds: ['week'] },
  { part: 'stories', label: 'Stories that moved', kinds: ['week'] },
  { part: 'trends', label: 'Topic trends', kinds: ['week'] },
  { part: 'sources', label: 'Source changes', kinds: ['week'] },
  { part: 'arcs', label: 'How your stories ran', kinds: ['month'] },
  { part: 'interests', label: 'Your interests over the year', kinds: ['month'] },
  { part: 'sourceReview', label: 'Source review', kinds: ['month'] },
  { part: 'categories', label: 'Category check', kinds: ['month'] },
  { part: 'stars', label: 'What you starred', kinds: ['week', 'month'] },
  { part: 'further', label: 'Looking further (web search)', kinds: ['week', 'month'] },
  { part: 'reading', label: 'How you read', kinds: ['week', 'month'] },
  { part: 'coming', label: 'Coming up', kinds: ['week', 'month'] },
];

export const REVIEW_CHART_WEEKS = [12, 26, 52] as const;
export type ReviewChartWeeks = (typeof REVIEW_CHART_WEEKS)[number];

export interface ReviewSettings {
  /** Build a review every week. */
  weekly: boolean;
  /** Build a review on the 1st of each month for the month before. */
  monthly: boolean;
  /** Day of the week the weekly review is built, 0 = Sunday. */
  weekDay: number;
  /** Local hour (0-23) reviews are built, in Settings' time zone. */
  hour: number;
  /** Web searches the PC may make for each weekly review (0-20). */
  weeklySearches: number;
  /** Web searches for each monthly review (0-20). */
  monthlySearches: number;
  /** How far back the topic trend chart opens. */
  chartWeeks: ReviewChartWeeks;
  /** Lead stories in Top of the week. */
  topStories: number;
  /** Parts left out. */
  skipParts: ReviewPart[];
  /** Categories left out of the lead stories and story lists. */
  skipCategories: string[];
  /** Done also marks the review's lead stories and story items read, by default. */
  doneMarksRead: boolean;
  /** Also put each finished review in the inbox as an item. */
  inInbox: boolean;
}

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  weekly: true,
  monthly: false,
  weekDay: 0,
  hour: 18,
  weeklySearches: 6,
  monthlySearches: 15,
  chartWeeks: 12,
  topStories: 3,
  skipParts: [],
  skipCategories: [],
  doneMarksRead: false,
  inInbox: false,
};

export const MAX_REVIEW_SEARCHES = 20;

// ---------- The pack: facts gathered by the Worker ----------

/** A count for the period and the usual (average of the periods before). */
export interface ReviewCount {
  now: number;
  usual: number;
}

export type ReviewStoryBadge = 'new' | 'busiest' | 'followed' | 'quiet' | 'back';

export interface ReviewStory {
  id: string;
  title: string;
  /** Items that joined in the period. */
  items: number;
  sources: number;
  totalItems: number;
  firstAt: number;
  lastAt: number;
  badges: ReviewStoryBadge[];
  /** Items per day of the period (7 days). */
  perDay: number[];
  /** Weeks with nothing before it came back. */
  gapWeeks?: number;
}

export interface ReviewTagSeries {
  tag: string;
  label: string;
  /** Items per week, oldest first; the last one is the review's own week. */
  counts: number[];
}

export interface ReviewMover {
  tag: string;
  label: string;
  now: number;
  /** Average per week over the 12 weeks before. */
  usual: number;
  /** "4 weeks rising", "highest in a year"… */
  note?: string;
}

export interface ReviewTrends {
  /** Start of each week, oldest first (52 or fewer). */
  weeks: number[];
  tags: ReviewTagSeries[];
  movers: ReviewMover[];
  newTags: { tag: string; label: string; n: number }[];
}

export type ReviewSourceKind = 'new' | 'busier' | 'quiet' | 'unopened' | 'starred';

export interface ReviewSourceChange {
  id: string;
  name: string;
  kind: ReviewSourceKind;
  detail: string;
}

export interface ReviewStar {
  itemId: string;
  subject: string;
  sourceName: string | null;
  at: number;
  highlights: number;
}

export interface ReviewBucket {
  at: number;
  label: string;
  arrived: number;
  read: number;
}

export interface ReviewArc {
  id: string;
  title: string;
  firstAt: number;
  lastAt: number;
  /** Items per week over the 26 weeks shown, oldest first. */
  perWeek: number[];
  status: 'running' | 'ended' | 'back';
  items: number;
}

export interface ReviewInterests {
  /** Start of each month, oldest first. */
  months: number[];
  /** Percent of read items carrying each tag, per month. */
  tags: { tag: string; label: string; shares: number[] }[];
  notes: { label: string; text: string }[];
}

export type ReviewSourceVerdict = 'best' | 'settling' | 'low' | 'unopened' | 'quiet';

export interface ReviewSourceRow {
  id: string;
  name: string;
  verdict: ReviewSourceVerdict;
  detail: string;
}

export type CategorySuggestionKind = 'move_source' | 'elsewhere' | 'new_category' | 'near_empty';

export interface CategorySuggestion {
  id: string;
  kind: CategorySuggestionKind;
  title: string;
  why: string;
  sourceId?: string;
  from?: string;
  to?: string;
  /** new_category: the tag it was spotted from. */
  tag?: string;
  /** elsewhere: the items that would move. */
  itemIds?: string[];
  /** Share of the source's (or tag's) items per category, for the bar. */
  mix?: { label: string; n: number }[];
  status?: 'applied' | 'applied_old' | 'dismissed';
}

export interface ReviewPack {
  label: string;
  counts: { arrived: ReviewCount; read: ReviewCount; stars: ReviewCount; stories: ReviewCount };
  /** "the 4 weeks before" / "the 3 months before" */
  usualLabel: string;
  top?: DigestStory[];
  stories?: ReviewStory[];
  trends?: ReviewTrends;
  sources?: ReviewSourceChange[];
  stars: ReviewStar[];
  reading: { buckets: ReviewBucket[]; note: string };
  arcs?: ReviewArc[];
  interests?: ReviewInterests;
  sourceReview?: ReviewSourceRow[];
  categories?: CategorySuggestion[];
}

// ---------- What the PC writes ----------

export type FindingKind = 'new' | 'link' | 'background' | 'check' | 'next';

export interface ReviewFinding {
  id: string;
  kind: FindingKind;
  question: string;
  answer: string;
  sources: { title: string; url: string }[];
  /** A connection: [one story or topic, what links them, the other]. */
  bridge?: [string, string, string];
  notUseful?: boolean;
  /** Came from a "Find more". */
  more?: boolean;
}

export interface ReviewComing {
  /** YYYY-MM-DD, or YYYY-MM when only the month is known. */
  date: string;
  what: string;
  itemId?: string;
}

export interface ReviewWritten {
  opening?: string;
  /** One line per story: what changed in the period. */
  storyLines?: Record<string, string>;
  /** What the stars have in common. */
  thread?: string;
  /** Monthly: what the stars say about where interests are going. */
  starsSay?: string;
  coming?: ReviewComing[];
  findings?: ReviewFinding[];
  model?: string;
  writtenAt?: number;
  searches?: number;
  /** Something the PC couldn't do, e.g. no Brave key. */
  note?: string;
}

export type ReviewStatus = 'waiting' | 'working' | 'done' | 'failed';

export interface Review {
  id: string;
  kind: ReviewKind;
  period: string;
  fromAt: number;
  toAt: number;
  createdAt: number;
  pack: ReviewPack;
  written: ReviewWritten;
  status: ReviewStatus;
  error: string | null;
  readAt: number | null;
  /** Extra searches asked for with Find more, not yet done. */
  moreWanted: number;
  /** Parts switched off when it was built. */
  skipParts: ReviewPart[];
  chartWeeks: ReviewChartWeeks;
}

export interface ReviewListItem {
  id: string;
  kind: ReviewKind;
  period: string;
  label: string;
  readAt: number | null;
  status: ReviewStatus;
}

export interface ReviewQuality {
  /** Findings in the last 8 weeks of reviews, and how many were marked Not useful. */
  findings: number;
  notUseful: number;
  searches: number;
}

// ---------- PC job ----------

export interface ReviewJob {
  reviewId: string;
  kind: ReviewKind;
  /** 'write': the text and questions; 'more': only new questions (Find more). */
  mode: 'write' | 'more';
  writePrompt: string;
  questionPrompt: string;
  findPrompt: string;
  /** The facts for the model, as text. */
  text: string;
  /** Web searches allowed for this job. */
  searches: number;
  /** Look things up at all (Looking further is switched on). */
  further: boolean;
  /** Questions already asked, so Find more doesn't repeat them. */
  asked: string[];
}

export interface ReviewResult {
  reviewId: string;
  ok: boolean;
  provider: string;
  model: string;
  seconds: number;
  watts?: number;
  error?: string;
  searches: number;
  written?: Omit<ReviewWritten, 'findings' | 'model' | 'writtenAt' | 'searches'>;
  findings?: Omit<ReviewFinding, 'id'>[];
  note?: string;
}
