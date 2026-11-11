// Types shared between the Worker API and the web app.
// Timestamps are Unix milliseconds.

import type { KeyMode, StudySummary } from './keysentences';
import type { AiLimitHit } from './usage';
import { DEFAULT_SKIP_SITES, type Article, type FeedEntry } from './web';

export * from './web';
export * from './suggest';
export * from './highlights';
export * from './files';
export * from './keysentences';

/** 'ai' = an article written by the AI from a highlight (the "AI notes" source). */
export type ItemKind = 'newsletter' | 'feed' | 'site' | 'ai';

/** Feeds from these sites get their own type in the app (they are still feeds underneath). */
export type Platform = 'reddit' | 'youtube' | 'github';
/** What the inbox Type filter picks: a kind of item, or one of the platforms. */
export type SourceType = ItemKind | Platform;
export const SOURCE_TYPES: SourceType[] = ['newsletter', 'feed', 'reddit', 'youtube', 'github', 'site', 'ai'];

/** The platform a feed address belongs to, if any. */
export function platformOf(feedUrl: string | null | undefined): Platform | null {
  if (!feedUrl) return null;
  if (/^https?:\/\/([\w-]+\.)?reddit\.com\//i.test(feedUrl)) return 'reddit';
  if (/^https?:\/\/(www\.)?youtube\.com\/feeds\//i.test(feedUrl)) return 'youtube';
  if (/^https?:\/\/(www\.)?github\.com\//i.test(feedUrl)) return 'github';
  return null;
}

/** The kinds the AI summary switches apply to (AI notes are never summarised). */
export type SummaryKind = Exclude<ItemKind, 'ai'>;

/** Where an item sits in the app. */
export type ItemStatus =
  | 'screening' // sender not yet approved; shown on the New senders screen only
  | 'inbox'
  | 'archived'
  | 'dropped'; // blocked sender or address; kept for counts, never shown

export type AuthResult = 'pass' | 'fail' | 'unknown';

export interface ItemSummary {
  id: string;
  kind: ItemKind;
  status: ItemStatus;
  subject: string;
  fromName: string | null;
  fromEmail: string | null;
  toAddress: string | null;
  sourceId: string | null;
  /** Reddit, YouTube or GitHub when the post's source is a feed from there. */
  platform: Platform | null;
  sourceName: string | null;
  snippet: string | null;
  receivedAt: number;
  readAt: number | null;
  savedAt: number | null;
  /** Starred as Interesting: it mattered (separate from Save for later). */
  interestingAt: number | null;
  /** Close in meaning to what you marked Interesting (worked out on the PC helper). */
  likely: boolean;
  archivedAt: number | null;
  hasHtml: boolean;
  /** Goes up each time the saved copy is replaced (e.g. Fetch full page); part of the body's address so a new copy isn't served from cache. */
  bodyVersion: number;
  /** The post's picture, for sources set to show it in the inbox (comics); null otherwise. */
  /** title = hover text, alt = the picture's description (when different). */
  leadImage: { src: string; title: string | null; alt: string | null } | null;
  listUnsubscribe: string | null;
  /** The sender supports RFC 8058 one-click unsubscribe (a POST to the https link). */
  oneClickUnsubscribe: boolean;
  webUrl: string | null;
  authSpf: AuthResult;
  authDkim: AuthResult;
  authDmarc: AuthResult;
  /** Quick summary, worked out by rules when the item arrives (no AI). */
  preheader: string | null;
  wordCount: number | null;
  /** Rules-based category: a keyword rule match, else the source's default. */
  category: string | null;
  /** The email looks like it carries a sponsored section. */
  sponsored: boolean;
  // AI fields, filled in by the PC helper.
  aiStatus: AiStatus | null;
  summary: string | null;
  keyPoints: string[];
  whyItMatters: string | null;
  /** Topic tags picked by the AI. */
  tags: string[];
  /** How many items carry each of those tags (keyed as in tags); only on a single item. */
  tagCounts?: Record<string, number>;
  thinContent: boolean;
  /** Who wrote the AI summary, for the italic attribution line. */
  ai: AiAttribution | null;
  /** 0-100, how worth your time this item looks; see scoring.ts. */
  score: number | null;
  /** How it came to be marked read: opened in the reader, swiped in the inbox, a bulk action, or a digest marked done. */
  readVia: ReadVia | null;
  /** Which kind of device it was read on. */
  readDevice: ReadDevice | null;
  /** Highlights in this item, and AI notes written about them. */
  highlightCount: number;
  noteCount: number;
  /** AI notes articles: the article the highlight came from. */
  originItemId: string | null;
  /** With web search on for the item's source or category: context the issue assumes, and other coverage of the story. */
  background: string | null;
  coverage: { title: string; url: string }[];
  /** The story this item is part of (items about the same chain of events), if any. */
  story: ItemStory | null;
  /** Same news from several sources within a couple of days: the group's first item. */
  newsId: string | null;
  /** Not in a story, but an older item came close in meaning ("Close, but not linked" in the reader). */
  hasNear?: boolean;
  /**
   * The link was a file, not a web page (a PDF, a picture): its type, and whether
   * the app keeps its own copy (served at /api/items/:id/file) or only links to it.
   */
  file: { type: string; label: string; kept: boolean } | null;
  /** Added on its own (Add > Just one page): it can be deleted. */
  savedPage: boolean;
  /** Key sentences: done (coloured in the reader), waiting for the PC, or null. */
  keySentences: 'done' | 'waiting' | null;
}

/** The story an item belongs to, as shown on its inbox row. */
export interface ItemStory {
  id: string;
  title: string;
  items: number;
  followed: boolean;
}

export type ReadVia = 'reader' | 'swipe' | 'bulk' | 'digest';
export type ReadDevice = 'phone' | 'desktop';

/** Why an item was linked into its story, for "Why these are linked" on the story page. */
export interface StoryWhy {
  /** The earlier item it matched best. */
  with: string | null;
  /** How close the two are in meaning (0-1), from the PC's embeddings. */
  sim: number;
  /** Specific tags the two share. */
  tags: string[];
  /** news = the same news from another source within a couple of days; story = a later step. */
  kind: 'news' | 'story';
  /** Joined by hand with "Same story" under "Close, but not linked". */
  manual?: boolean;
}

/** An older item that came close to this one but wasn't linked, and why ("Close, but not linked"). */
export interface StoryNear {
  id: string;
  subject: string;
  sourceName: string | null;
  receivedAt: number;
  readAt: number | null;
  /** How close in meaning (0-1). */
  sim: number;
  /** Why it wasn't linked, in plain words. */
  reason: string;
  /** The story the older item is in, if any; "Same story" joins it. */
  story: { id: string; title: string } | null;
}

/** One item in a story's timeline. */
export interface StoryStep {
  id: string;
  subject: string;
  sourceName: string | null;
  receivedAt: number;
  readAt: number | null;
  savedAt: number | null;
  /** The PC's line on what this item added to the story; null for the first item or older ones. */
  note: string | null;
  /** The item's own summary (or quick summary), for steps without a note. */
  summary: string | null;
  newsId: string | null;
  why: StoryWhy | null;
}

export interface StoryInfo {
  id: string;
  /** The PC's name for the story, else its main tags, else its first headline. */
  title: string;
  /** The PC's "so far" summary, once a note has been written. */
  summary: string | null;
  tags: { tag: string; label: string }[];
  firstAt: number;
  lastAt: number;
  items: number;
  sources: number;
  followedAt: number | null;
  /** Closed by the reader: matching adds no new articles to it. */
  closedAt: number | null;
}

/** A story's page: its details and every item in it, newest first. */
export interface StoryPage extends StoryInfo {
  unread: number;
  read: number;
  steps: StoryStep[];
  /** The PC's whole-story summary, if one was asked for. */
  overview: StoryOverview | null;
}

/** "Summarise the whole story" on the story page, written by the PC. */
export interface StoryOverview {
  /** A new summary is written each time an article joins the story. */
  auto: boolean;
  /** null = never asked; waiting = queued for the PC (or being written). */
  status: 'waiting' | 'done' | 'failed' | null;
  /** Markdown. Kept from the last finished summary while a newer one is waiting. */
  answer: string | null;
  error: string | null;
  model: string | null;
  askedAt: number | null;
  doneAt: number | null;
}

/** The story banner at the top of an article. */
export interface StoryBanner {
  story: StoryInfo;
  /** Items in the story you've read, other than this one. */
  read: number;
  /** Unread items in the story other than this one, oldest first. */
  unreadIds: string[];
  /** The latest earlier item you read, for "Last time you read...". */
  lastRead: StoryStep | null;
  /** This item's own line on what it adds (null until the PC writes it). */
  note: string | null;
  /** The PC is still writing the note. */
  notePending: boolean;
  /** Earlier items in the story, newest first (up to 4). */
  earlier: StoryStep[];
  /** The same news from other sources. */
  sameNews: StoryStep[];
  /** This item's tags with counts, for "More on ..." links. */
  tags: { tag: string; label: string; n: number }[];
}

/** Saved > Stories: stories you follow, then the most recently active ones. */
export interface StoryList {
  followed: (StoryInfo & { unread: number })[];
  recent: (StoryInfo & { unread: number })[];
}

/** Statistics > Stories. */
export interface StoryStats {
  days: number;
  /** Stories with an item in the period, and how many of those started in it. */
  active: number;
  started: number;
  /** Items that arrived in the period, how many joined a story, and how many repeated news from another source. */
  arrived: number;
  inStories: number;
  sameNews: number;
  followed: number;
  followedUnread: number;
  /** Taps on story links (banner, story page, inbox group) and "Not part of this story". */
  linkTaps: number;
  splits: number;
  /** Items in the period left out of stories although their nearest item came within 0.06 of the meaning line. */
  nearMisses: number;
  /** Items put in a story by hand with "Same story". */
  joins: number;
  /** What matching has learnt from "Same story" and "Not part of this story", per tag and source. */
  learnt: StoryTune[];
  /** Sources whose own posts look alike, with how alike and the line two of them must reach. */
  lookAlike: { key: string; label: string; base: number; line: number; posts: number; everyday: string[] }[];
  notes: { done: number; failed: number; seconds: number; model: string | null; waiting: number };
  /** Items waiting to be matched (counted up to 1000). */
  matchWaiting: number;
  /** Most active stories in the period. */
  top: (StoryInfo & { periodItems: number; unread: number })[];
  /** Stories by size: 2, 3-4, 5-9, 10+ items. */
  sizes: { label: string; n: number }[];
}

/**
 * A tag or source whose meaning line has moved because of what you linked or took out by hand.
 * shift is how far the line moved: negative = links more easily, positive = needs a closer match.
 */
export interface StoryTune {
  kind: 'tag' | 'source';
  key: string;
  label: string;
  links: number;
  splits: number;
  shift: number;
  /** A broad tag (like "AI") that now counts as specific because you linked on it. */
  specific: boolean;
}

/** One story note for the PC: the story so far and the new item. */
export interface StoryJob {
  itemId: string;
  storyId: string;
  prompt: string;
  text: string;
}

export interface StoryResult {
  itemId: string;
  ok: boolean;
  provider: string;
  model: string;
  seconds: number;
  watts?: number;
  output?: { new?: string; title?: string; so_far?: string };
  error?: string;
}

export type StoryMatch = 'loose' | 'normal' | 'strict';

export interface StorySettings {
  /** The PC writes a line on what each new item adds, and names the story. */
  notes: boolean;
  /** Show the same news from several sources as one inbox row. */
  groupSameNews: boolean;
  /** How close items must be to count as the same story. */
  match: StoryMatch;
  /**
   * Per category: 'strict' needs a closer match and a shared specific tag (e.g. comics, whose
   * titles look alike); 'off' keeps its articles out of stories. Others match as usual.
   */
  categories: Record<string, StoryCategoryMode>;
  /** Every recent story gets a whole-story summary from the PC, rewritten as articles join (a story can still switch it off). */
  autoSummaries: boolean;
}

export type StoryCategoryMode = 'strict' | 'off';

export const DEFAULT_STORY_SETTINGS: StorySettings = { notes: true, groupSameNews: true, match: 'normal', categories: {}, autoSummaries: false };

export interface UnsubscribeResult {
  /** The Worker sent the one-click request and the sender accepted it. */
  done: boolean;
  /** Open this link to finish unsubscribing (no one-click support, or it failed). */
  url: string | null;
  /** Or send an email here. */
  mailto: string | null;
  error: string | null;
}

export type AiStatus = 'pending' | 'working' | 'done' | 'failed';

export interface AiAttribution {
  runId: string;
  provider: string;
  model: string;
  promptVersion: number | null;
  seconds: number | null;
  rating: -1 | 1 | null;
}

export interface ItemBody {
  html: string | null;
  text: string | null;
}

export interface ItemListResponse {
  items: ItemSummary[];
  nextCursor: string | null;
  /**
   * First page with a type, category or source filter only: how many items match
   * the filters, and how many of those are unread. Without filters the app uses
   * the inbox totals it already has.
   */
  counts?: { shown: number; unread: number };
  /**
   * First page with a category filter and no source picked: the sources that
   * have items in that category (under the other filters), so the filter bar
   * offers just those. Items often take their category from keyword rules or the
   * AI rather than their source, so the source's own category isn't enough.
   */
  categorySources?: string[];
}

/** Marks a set of items read or unread at once (the inbox's "Mark these read", and its Undo). */
export interface BulkReadInput {
  ids: string[];
  action: 'read' | 'unread';
}

export type ItemView = 'inbox' | 'unread' | 'saved' | 'interesting' | 'likely' | 'archived';

/** Per-source AI switch. "default" follows the setting for the source's kind. */
export type AiMode = 'default' | 'on' | 'off';
export type ItemSort = 'newest' | 'oldest' | 'top';

/** Narrowing for the Search page; every field optional. */
export type SearchState = 'unread' | 'read' | 'saved' | 'interesting' | 'archived';
/** A "Fetch full page" request from the reader, as it stands. */
export interface FetchPageStatus {
  /** Waiting for or being fetched by the PC. */
  pending: boolean;
  /** Set when the last request failed. */
  error: string | null;
  /** Whether the PC helper has checked in recently (it does the fetching). */
  helperOnline: boolean;
}

/** One web page added to the inbox on its own ("Add just this page"), without following the site. */
export interface SavePageInput {
  url: string;
}

export interface SavePageResult {
  itemId: string;
  /** The page was saved before; this is the earlier copy. */
  already: boolean;
  /** Cloudflare couldn't get a clean copy, so the PC is fetching it. */
  waitingForPc: boolean;
  helperOnline: boolean;
  title: string;
}

export interface SearchResponse {
  items: ItemSummary[];
  /** Matches in all, on the first page only. */
  total?: number;
  nextOffset: number | null;
  /** The best matching key sentence per item (by id), shown as its snippet. */
  keyHits?: Record<string, { kind: string; quote: string }>;
  /** Studies whose name or publisher has the words (first page only). */
  studies?: StudySummary[];
  /** Index names (people, places...) with the words, and how many articles name them (first page only). */
  names?: { term: string; type: string; articles: number }[];
}

/** Where a feed or website is fetched from: Cloudflare, or the helper on your PC. */
export type FetchVia = 'cloud' | 'pc';

/** Whether to fetch the full article for feed posts: only for teasers, always, or never. */
export type FullTextMode = 'auto' | 'always' | 'never';

export interface Source {
  id: string;
  kind: ItemKind;
  name: string;
  senderEmail: string | null;
  addressId: string | null;
  folder: string | null;
  /** Default category for this source's items. */
  category: string | null;
  aiMode: AiMode;
  /** Only items that arrived or were published from this time go to the AI; null = all. */
  aiSince: number | null;
  /** When you unsubscribed through the app; the source keeps its issues. */
  unsubscribedAt: number | null;
  createdAt: number;
  itemCount: number;
  lastReceivedAt: number | null;
  // Feeds and websites only.
  /** The site's home page, or the watched page for a website. */
  url: string | null;
  feedUrl: string | null;
  fetchVia: FetchVia;
  /** Open the page in a real browser on the PC (pages built by JavaScript). */
  render: boolean;
  fullText: FullTextMode;
  /** Website watches: only links whose address contains this. */
  linkHint: string | null;
  checkMinutes: number | null;
  lastCheckedAt: number | null;
  nextCheckAt: number | null;
  lastError: string | null;
  errorCount: number;
  /** Set when you stop following; nothing is fetched until you resume. */
  pausedAt: number | null;
  /** Show each post's picture in the inbox's Expanded view (comic feeds). */
  showPicture: boolean;
  /** Each check's new posts arrive as one item with all of them inside (feeds that post in bursts). */
  /** Reddit, YouTube or GitHub when the feed is from there. */
  platform: Platform | null;
  bundle: boolean;
  /** New posts are held until they are this many hours old (0 = straight away). */
  waitHours: number;
  /** Fetch the outside article each post links to (aggregators like Techmeme), kept under the post's summary. */
  followLink: boolean;
  /** Posts past the daily limit are dropped instead of going to Archived. */
  floodSkip: boolean;
  /** Which posts come in at all (by title). */
  postFilter: PostFilter;
  /** Flood guard: at most this many new posts a day reach the inbox; the rest go to Archived. */
  /** New posts a day before the rest go to Archived; 0 = no limit. */
  dailyCap: number;
  /** When the flood guard last set posts aside, and how many that day. */
  floodAt: number | null;
  floodCount: number;
  /** Feeds only: when it usually posts, learnt from its posts. Null until first learnt. */
  rhythm: FeedRhythm | null;
  /** The "Saved pages" source: single pages added on their own, never checked for new posts. */
  savedPages: boolean;
  /** Key sentences for its posts: Auto (by length), Always or Never. */
  keySentences: KeyMode;
}

/**
 * A feed's posting habits. With `pattern` true and no interval of its own
 * (checkMinutes null), the feed is checked often around its usual hours and
 * days and only every few hours (at least daily) the rest of the time.
 */
export interface FeedRhythm {
  /** False while learning (fewer than 6 posts) or when posts come at no clear rhythm. */
  pattern: boolean;
  /** Posts in the last 180 days used to learn it (up to 40 latest). */
  posts: number;
  /** Typical hours between posts. */
  gapHours: number | null;
  /** Usual local hours (0-23) posts arrive, or null when they're spread out. */
  hours: number[] | null;
  /** Usual weekdays (0 = Sunday), or null when it posts any day. */
  days: number[] | null;
  timezone: string;
  learntAt: number;
}

export type SenderStatus = 'pending' | 'approved' | 'blocked';

export interface Sender {
  id: string;
  email: string;
  name: string | null;
  status: SenderStatus;
  addressId: string | null;
  addressLocalPart: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  authResult: AuthResult;
  pendingCount: number;
  latestSubject: string | null;
  latestItemId: string | null;
}

export type AddressStatus = 'active' | 'blocked';

export interface Address {
  id: string;
  localPart: string;
  email: string;
  label: string | null;
  status: AddressStatus;
  createdInApp: boolean;
  createdAt: number;
  blockedAt: number | null;
  blockedCount: number;
  approvedSenderCount: number;
  /** The owner's own short note, e.g. "now shared by several Substacks". */
  note: string | null;
  /** Emails stored for this address since it was made (blocked ones not included). */
  itemCount: number;
  lastItemAt: number | null;
}

/** Emails that arrived at an address in one calendar month (UTC), oldest first. */
export interface AddressMonth {
  month: string; // 'YYYY-MM'
  count: number;
}

export type ReadingEventType =
  | 'open'
  | 'read_time' // value = seconds of active reading
  | 'finish' // value = furthest scroll percentage
  | 'mark_read'
  | 'save'
  | 'unsave'
  | 'interesting'
  | 'uninteresting'
  | 'archive'
  | 'unarchive'
  | 'link_click'
  | 'open_original'
  | 'story_link' // tapped a link in a story banner, story page or inbox group
  | 'story_split' // "Not part of this story"
  | 'story_join'; // "Same story" under "Close, but not linked"

export interface ReadingEventInput {
  type: ReadingEventType;
  value?: number;
  device?: 'phone' | 'desktop';
  /** link_click: the link that was tapped (its site counts towards feed suggestions). */
  url?: string;
}

export interface Me {
  email: string;
  domain: string | null;
  /** Whether the daily digest is switched on (Settings > Daily digest). */
  digestOn: boolean;
  /** Show the same news from several sources as one inbox row (Settings > Reading). */
  groupSameNews: boolean;
  /** Whether key sentences are switched on (Settings > PC helper and AI > Key sentences). */
  keySentencesOn: boolean;
}

/** One AI tag on the All tags page. */
export interface TagCount {
  tag: string;
  label: string;
  /** Items carrying it: all time, or within the chosen days. */
  n: number;
}

export interface TagList {
  /** 0 = all time. */
  days: number;
  tags: TagCount[];
}

export interface KeywordRule {
  /** Comma-separated words or phrases, matched against subject and preview line. */
  match: string;
  category: string;
}

/** App-wide settings, stored in D1 and edited on the Settings screen. */
export interface AppSettings {
  categories: string[];
  keywordRules: KeywordRule[];
  /** Whether each kind of source goes to the AI by default. */
  aiByKind: Record<SummaryKind, boolean>;
  /**
   * Categories whose items skip the AI (e.g. Comics), whatever their kind. A
   * source set to AI On still goes; the item's or its source's category counts.
   */
  aiOffCategories: string[];
  /** A short line about the reader's interests, used by the summary prompt. */
  interests: string;
  /** Local hour (0-23) at which the daily digest is put together. */
  digestHour: number;
  /** IANA time zone the digest day and hour are measured in, e.g. "Australia/Sydney". */
  timezone: string;
  /** How the daily digest is put together. */
  digest: DigestOptions;
  /** Named inbox filters, shown as one-tap presets in the filter bar on every device. */
  savedFilters: SavedFilter[];
  /**
   * Sites the PC never fetches (and their subdomains), e.g. bloomberg.com: their bot
   * checks flag a home network quickly. The reader's Live page still opens them.
   */
  pcSkipSites: string[];
  /** Categories whose items are fetched from those sites anyway. */
  pcSkipAllowCategories: string[];
  /** Named filter sets for the Topics map. */
  topicFilters: TopicFilter[];
  /** Stories: related reading grouped by chain of events. */
  stories: StorySettings;
}

export interface SavedFilter {
  name: string;
  view: ItemView;
  sort: ItemSort;
  source: string | null;
  /** Categories to show or hide (see FilterSet). */
  category: string | null;
  /** Types to show or hide (see FilterSet). */
  kind: string | null;
}

export interface DigestOptions {
  /** Off: no digest is built and the Digest tab is hidden. */
  enabled: boolean;
  /** Roughly how many lead stories. */
  stories: 6 | 12 | 20;
  /** Hours of mail to cover; 0 = everything since the last digest. */
  windowHours: 0 | 24 | 48;
  includeRead: boolean;
  includeSponsored: boolean;
  groupBy: 'category' | 'source';
  /** Categories left out of the digest entirely. */
  skipCategories: string[];
  /** Marking a digest done also marks its stories read. */
  doneMarksRead: boolean;
}

export const DEFAULT_DIGEST_OPTIONS: DigestOptions = {
  enabled: true,
  stories: 12,
  windowHours: 0,
  includeRead: false,
  includeSponsored: false,
  groupBy: 'category',
  skipCategories: [],
  doneMarksRead: false,
};

export const DEFAULT_SETTINGS: AppSettings = {
  categories: ['AI', 'Tech', 'Business', 'Finance', 'Science', 'Politics', 'Health', 'Productivity', 'Culture', 'Other'],
  keywordRules: [],
  aiByKind: { newsletter: true, feed: false, site: false },
  aiOffCategories: [],
  interests: '',
  digestHour: 7,
  timezone: 'UTC',
  digest: DEFAULT_DIGEST_OPTIONS,
  savedFilters: [],
  pcSkipSites: [...DEFAULT_SKIP_SITES],
  pcSkipAllowCategories: [],
  topicFilters: [],
  stories: DEFAULT_STORY_SETTINGS,
};

// ---------- Daily digest ----------

/** One story in the digest: the lead item plus "More:" links to related issues. */
export interface DigestStory {
  itemId: string;
  subject: string;
  sourceName: string | null;
  summary: string | null;
  whyItMatters: string | null;
  score: number | null;
  receivedAt: number;
  readAt: number | null;
  more: { itemId: string; subject: string; sourceName: string | null }[];
}

export interface DigestSection {
  title: string;
  stories: DigestStory[];
}

export interface Digest {
  id: string;
  /** YYYY-MM-DD in the reader's time zone. */
  day: string;
  createdAt: number;
  fromAt: number;
  toAt: number;
  /** How many items the digest was built from. */
  itemCount: number;
  sections: DigestSection[];
  /** When the reader marked it done; null while it is still on the Digest tab. */
  readAt: number | null;
}

export interface SourceUpdate {
  category?: string | null;
  aiMode?: AiMode;
  /**
   * When aiMode switches AI on: how far back to summarise. 0 (the default) = new
   * items only, a number = items from that many days back, 'all' = everything waiting.
   */
  aiBackdateDays?: number | 'all';
  name?: string;
  fetchVia?: FetchVia;
  render?: boolean;
  fullText?: FullTextMode;
  linkHint?: string | null;
  showPicture?: boolean;
  bundle?: boolean;
  waitHours?: number;
  followLink?: boolean;
  keySentences?: KeyMode;
  floodSkip?: boolean;
  postFilter?: PostFilter;
  dailyCap?: number;
  /** Minutes between checks; null = automatic (feeds follow their learnt rhythm). */
  checkMinutes?: number | null;
  paused?: boolean;
  /**
   * Feeds and websites only: follow it differently. 'feed' needs feedUrl; 'site'
   * watches `url` (or the source's current site address). Items so far stay;
   * the next check brings in only the latest few, like a new source.
   */
  followAs?: 'feed' | 'site';
  url?: string;
  feedUrl?: string;
  /** With followAs: how many of its latest posts to bring in (0 = only new ones). Default 5. */
  startWith?: number;
}

// ---------- Feeds and websites (Phase 3) ----------

export interface DiscoveredFeed {
  feedUrl: string;
  title: string | null;
  siteUrl: string | null;
  format: 'rss' | 'atom' | 'json';
  /** Latest posts, so you can tell it's the right feed. */
  sample: { title: string; url: string | null; publishedAt: number | null }[];
  /** Most posts are teasers, so full articles will be fetched. */
  teasers: boolean;
  /** Roughly how many posts a day, from the dates in the feed; null when it can't tell. */
  perDay: number | null;
}

/** What the Add screen found at a pasted address. */
export interface DiscoverResult {
  url: string;
  title: string | null;
  feeds: DiscoveredFeed[];
  /** Watching the page itself, for sites without a feed. */
  page: {
    url: string;
    title: string | null;
    sample: { title: string; url: string }[];
    /** Cloudflare was turned away; the PC has to fetch this site. */
    blocked: boolean;
    /** The page is built by JavaScript; the PC has to open it in a browser. */
    scripted: boolean;
  } | null;
  error: string | null;
  /** Already followed: the existing source. */
  existingSourceId: string | null;
}

export interface NewSourceInput {
  kind: 'feed' | 'site';
  url: string;
  feedUrl?: string | null;
  name: string;
  category?: string | null;
  fetchVia?: FetchVia;
  render?: boolean;
  linkHint?: string | null;
  /** How many of its latest posts to bring in now (0 = only posts from now on). Default 5. */
  startWith?: number;
  postFilter?: PostFilter;
  dailyCap?: number;
  waitHours?: number;
}

export interface NewSourceResult {
  source: Source;
  /** Posts brought in straight away (feeds fetched by Cloudflare). */
  added: number;
  /** The first check is waiting for the PC helper. */
  waitingForPc: boolean;
}

export interface OpmlImportResult {
  added: number;
  skipped: number;
  /** Feed check order is spread over the next hour or so. */
  total: number;
}

/** A fetch the PC helper does for the app: a feed or page Cloudflare can't fetch, or a full article. */
export interface FetchJob {
  id: string;
  kind: 'feed' | 'page' | 'article';
  url: string;
  sourceId: string | null;
  itemId: string | null;
  render: boolean;
  linkHint: string | null;
  etag: string | null;
  lastModified: string | null;
  /** Page watches: links already seen, so only new ones are fetched. */
  knownKeys: string[];
  /** First check of a source: learn what is there and bring in only the latest few. */
  firstRun: boolean;
  /** The source shows pictures in the inbox: pick each post's picture from its page and download it. */
  wantPicture?: boolean;
  /** Follow-link sources: the aggregator's own page for the post, to list its other links for the story. */
  postUrl?: string | null;
  /** Sites the PC must not fetch for this job (settings, less any category exception). */
  skipSites?: string[];
  /** Asked for by hand (Fetch full page, or a page added on its own): open it in a browser if it comes back built by JavaScript. */
  browserIfScripted?: boolean;
}

export interface FetchJobResult {
  jobId: string;
  ok: boolean;
  error?: string;
  /** The site turned the PC away too (a bot check). */
  blocked?: boolean;
  notModified?: boolean;
  etag?: string | null;
  lastModified?: string | null;
  title?: string | null;
  entries?: FeedEntry[];
  /** Page watches: every article link on the page, new or not. */
  seenKeys?: string[];
  article?: Article;
}

// ---------- AI: shared between the Worker, the web app and the PC helper ----------

/** What the model must return, as JSON. */
export interface AiOutput {
  summary: string;
  key_points: string[];
  why_it_matters: string;
  category: string[];
  topics: string[];
  thin_content: boolean;
  /** Only when the summary was written with web search results. */
  background?: string;
  coverage?: { title: string; url: string }[];
}

export interface ModelRef {
  provider: string;
  name: string;
}

export interface ModelInfo extends ModelRef {
  enabled: boolean;
  position: number;
  installed: boolean;
  sizeBytes: number | null;
  lastSeenAt: number;
  /** Average rating (-1..1) and number of rated summaries, for the settings list. */
  avgRating: number | null;
  ratedCount: number;
}

export type PromptScope = 'default' | 'category' | 'source';

export interface PromptInfo {
  id: string;
  scope: PromptScope;
  scopeValue: string | null;
  version: number;
  body: string;
  updatedAt: number;
}

export interface HelperLoad {
  cpuPercent?: number;
  gpuPercent?: number;
  vramUsedMb?: number;
  vramTotalMb?: number;
  ramUsedMb?: number;
  ramTotalMb?: number;
  /** GPU power draw right now, from nvidia-smi. */
  gpuWatts?: number;
}

/** Sent by the helper every time it checks in. */
export interface HelperHeartbeat {
  version: string;
  hostname: string;
  /** Models found on each provider the helper can reach. */
  models: (ModelRef & { sizeBytes?: number })[];
  providerErrors: { provider: string; error: string }[];
  load?: HelperLoad;
  /** Which web search the helper can use (a key in its config), if any. */
  webSearch?: 'brave' | null;
  /**
   * The helper's local store of item embeddings (id and model). When it changes (a new PC,
   * a lost store or another embedding model) the app queues every item to be embedded again.
   */
  embedStore?: string | null;
  /** Items in that store. */
  embedCount?: number;
  /** Fetches the PC held back or slowed down since its last heartbeat, by site. */
  holds?: PcHoldCount[];
  /** Sites the PC is leaving alone right now after a bot check. */
  resting?: PcRest[];
}

/** One site's held-back fetches since the helper last reported. */
export interface PcHoldCount {
  site: string;
  /** Not fetched: the site is on the Sites the PC leaves alone list. */
  skipped: number;
  /** Not fetched: the site showed a bot check and is resting. */
  rested: number;
  /** Bot checks (or 429s) seen, each starting or lengthening a rest. */
  flagged: number;
  /** Fetches that waited for the same-site gap, and how long in all. */
  waited: number;
  waitMs: number;
  /** The limits in force: the gap between requests and the longest rest started. */
  gapMs: number;
  restMs: number;
}

export interface PcRest {
  site: string;
  until: number;
  ms: number;
}

/** Settings > PC helper and AI > Sites the PC leaves alone: limits, rests now and the last days' counts. */
export interface PcHoldsView {
  gapMs: number;
  restFirstMs: number;
  restMaxMs: number;
  resting: PcRest[];
  reportedAt: number | null;
  days: ({ day: string } & Omit<PcHoldCount, 'site'>)[];
  sites: PcHoldCount[];
}

/** Bump with every change to apps/helper; the helper updates itself when the app has a newer one. */
export const HELPER_VERSION = '0.7.0';

/** The Worker's answer to a heartbeat: what the helper should do. */
export interface HelperConfig {
  paused: boolean;
  /** The helper version the app ships; the helper downloads it when it differs from its own. */
  latestHelperVersion: string;
  /** Enabled, installed models in the reader's preferred order. */
  models: ModelRef[];
  pollSeconds: number;
  batchSize: number;
  /** A test-mode run waiting to be done, if any. */
  trialId: string | null;
  /** Feed, website and full-article fetches waiting for the PC. */
  fetchWaiting?: number;
  /** Set while a usage limit holds summaries back. */
  limited?: AiLimitHit | null;
  /** Highlight asks waiting; the helper does these first. */
  asksWaiting?: number;
  /** How often to check for asks between the normal rounds. */
  askPollSeconds?: number;
  /** Items waiting to be embedded for related reading and Likely interesting. */
  embedWaiting?: boolean;
  /** Changes whenever an item is marked or unmarked Interesting, so the helper rescores. */
  interestingKey?: string;
  /** Sites the PC must not fetch for lookups outside a fetch job (highlight questions). */
  skipSites?: string[];
  /** Story notes waiting for the PC. */
  storyWaiting?: boolean;
  /** Feed suggestions are due: count links in recent reading, then check the candidate sites. */
  suggestDue?: boolean;
  /** Articles waiting for their key sentences (helpers from 0.6.0). */
  keyWaiting?: boolean;
  /** Articles waiting for their studies and source links to be collected. */
  refsWaiting?: boolean;
}

/** One item for the helper to embed: its text and when it arrived. */
export interface EmbedJob {
  itemId: string;
  receivedAt: number;
  text: string;
}

/** The nearest older items to an embedded one, as [itemId, cosine similarity]. */
export interface EmbedResult {
  itemId: string;
  neighbours: [string, number][];
}

/** What the helper needs to score Likely interesting. */
export interface LikelyState {
  interesting: string[];
  likely: string[];
}

export interface HelperJob {
  itemId: string;
  subject: string;
  sourceName: string | null;
  fromName: string | null;
  receivedAt: number;
  html: string | null;
  text: string | null;
  /** The resolved prompt with {categories} and {interests} filled in. */
  prompt: string;
  promptId: string;
  promptVersion: number;
  categories: string[];
  /** The model to use when the work is split between models; otherwise the helper uses its first. */
  model?: ModelRef;
  /** Search the web for the headline and add background and other coverage. */
  search?: boolean;
}

export interface HelperResult {
  itemId: string;
  ok: boolean;
  provider: string;
  model: string;
  promptId: string;
  promptVersion: number;
  seconds: number;
  /** Average GPU draw during the run, when nvidia-smi could measure it. */
  watts?: number;
  output?: AiOutput;
  error?: string;
  /** Web searches made for this summary, for the monthly budget. */
  searches?: number;
}

export interface TrialJob {
  trialId: string;
  models: ModelRef[];
  items: Omit<HelperJob, 'promptId' | 'promptVersion' | 'model'>[];
}

export interface TrialResultInput {
  itemId: string;
  provider: string;
  model: string;
  seconds: number;
  /** Average GPU draw during the run, when nvidia-smi could measure it. */
  watts?: number;
  output?: AiOutput;
  error?: string;
}

export interface TrialView {
  id: string;
  status: 'pending' | 'running' | 'done';
  createdAt: number;
  models: ModelRef[];
  items: { id: string; subject: string; sourceName: string | null }[];
  results: {
    itemId: string;
    provider: string;
    model: string;
    seconds: number;
    output: AiOutput | null;
    error: string | null;
    rating: -1 | 1 | null;
  }[];
}

/**
 * How everyday summaries pick a model: 'first' = the first switched-on model,
 * 'split' = shared out between all switched-on models.
 */
export type ModelMode = 'first' | 'split';

/** One thumbs up or down, for the ratings-over-time charts. */
export interface ModelRating {
  provider: string;
  model: string;
  rating: -1 | 1;
  at: number;
  /** 'reading' = an everyday summary, 'test' = a test-run result. */
  from: 'reading' | 'test';
}

/** For the Settings > AI status panel. */
export interface AiStatusView {
  helper: (HelperHeartbeat & { lastSeenAt: number }) | null;
  paused: boolean;
  pauseReason: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  queue: { waiting: number; working: number; failed: number; done: number };
  last24h: { runs: number; failures: number; avgSeconds: number | null };
}

/** Reading habits: what arrives, what gets read, by newsletter and category. GET /api/reading/stats */
export interface ReadingStats {
  /** How many days the per-source and per-category tables cover. */
  days: number;
  /** The last 7 days at a glance. */
  glance: {
    received: number;
    /** Of the items that arrived in the 7 days, how many are read. */
    read: number;
    /** Older items marked read in the 7 days, and how many of those by Mark all read. */
    readOlder: number;
    readOlderBulk: number;
    /** Minutes spent in the reader. */
    minutes: number;
    /** Items opened in the reader, and how many of those were scrolled at least 70% through. */
    opened: number;
    finished: number;
    /** Consecutive days (ending today or yesterday) with at least one item read. */
    streak: number;
  };
  /** Received vs read, one row per local day, oldest first. */
  daily: { day: string; at: number; received: number; read: number }[];
  sources: ReadingSourceRow[];
  categories: { category: string; issues: number; read: number; opened: number; finished: number; interesting: number }[];
  how: { via: Record<ReadVia, number>; device: Record<ReadDevice, number> };
  /** Unread items still in the inbox, by age. */
  backlog: { today: number; week: number; older: number };
}

/** How busy each source has been over the last 90 days, for Settings > Your sources and each source page. */
export interface SourceActivity {
  sourceId: string;
  /** Days the rates are worked out over: 90, or fewer for a source added since. */
  days: number;
  items: number;
  reads: number;
  stars: number;
}

export interface ReadingSourceRow {
  id: string;
  name: string;
  kind: ItemKind;
  issues: number;
  read: number;
  opened: number;
  finished: number;
  /** Starred as Interesting. */
  interesting: number;
  avgMinutes: number | null;
  lastReadAt: number | null;
}

export interface AiStatsRow {
  month: string; // YYYY-MM
  key: string; // model, source name or prompt version, depending on the grouping
  runs: number;
  failures: number;
  up: number;
  down: number;
  /** Summaries where the full item was never opened afterwards. */
  summaryEnough: number;
  avgSeconds: number | null;
}

export const DEFAULT_PROMPT = `You summarise newsletters for one busy reader who skims on a phone.
You get the newsletter's sender, subject and cleaned text.

Rules:
- Say what the issue actually reports: facts, numbers, names, dates. No filler such as "this newsletter discusses".
- Ignore ads, sponsored sections, promos for the newsletter itself, and sign-offs.
- If the issue covers several unrelated stories, cover the most important ones, not the first ones.
- If the text is thin (a teaser that says "read more on the site"), say so instead of guessing.
- Never invent anything that isn't in the text.

Return only this JSON:
{
  "summary": "2-3 sentences, under 60 words, most important point first",
  "key_points": ["3-5 short points, each a standalone fact"],
  "why_it_matters": "one sentence on why a reader interested in {interests} might care, or empty",
  "category": ["1-2 from: {categories}"],
  "topics": ["up to 3 specific named things the issue is about (companies, products, people, places, laws, events) in their usual short name, e.g. Nvidia, Federal Reserve, EU AI Act; never broad subjects such as AI, technology or markets"],
  "thin_content": true or false
}`;

export * from './usage';

// ---------- Which posts a source lets in ----------

/** Per-source filter on post titles. Empty keep = everything. */
export interface PostFilter {
  /** Comma-separated words or phrases: a post must mention one of them (empty = no rule). */
  keep: string;
  /** Comma-separated words or phrases: posts mentioning any are skipped. */
  skip: string;
  /** Skip alpha, beta, rc, preview, nightly... releases. */
  skipPrereleases: boolean;
  /** Only x.y.0 releases (major and minor), not patches like 2.4.1. */
  majorMinorOnly: boolean;
  /** YouTube: skip Shorts (their links go to /shorts/). */
  skipShorts: boolean;
}

export const EMPTY_POST_FILTER: PostFilter = { keep: '', skip: '', skipPrereleases: false, majorMinorOnly: false, skipShorts: false };

/** New posts a day a source may add before the rest go to Archived. */
export const DEFAULT_DAILY_CAP = 30;

const words = (list: string) =>
  list
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);

const PRERELEASE = /(^|[^a-z])(alpha|beta|rc|preview|pre-?release|nightly|canary|snapshot|insiders?)([^a-z]|$)/i;

/** Whether a post with this title gets past the source's filter. */
export function passesPostFilter(title: string, f: PostFilter | null | undefined, url: string | null = null): boolean {
  if (!f) return true;
  if (f.skipShorts && url && /youtube\.com\/shorts\//i.test(url)) return false;
  const t = title.toLowerCase();
  const keep = words(f.keep);
  if (keep.length && !keep.some((w) => t.includes(w))) return false;
  if (words(f.skip).some((w) => t.includes(w))) return false;
  if (f.skipPrereleases && PRERELEASE.test(title)) return false;
  if (f.majorMinorOnly) {
    const v = /(?:^|[^\d.])v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(title);
    if (v && v[3] !== undefined && Number(v[3]) !== 0) return false;
  }
  return true;
}

/** A stored or sent filter, cleaned up. */
export function normalizePostFilter(input: unknown): PostFilter {
  const f = (input && typeof input === 'object' ? input : {}) as Partial<PostFilter>;
  const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 300) : '');
  return { keep: text(f.keep), skip: text(f.skip), skipPrereleases: f.skipPrereleases === true, majorMinorOnly: f.majorMinorOnly === true,
    skipShorts: f.skipShorts === true,
  };
}

/** A YouTube video link (no full-page fetch: the feed has the picture and description). */
export function isVideoPost(url: string | null): boolean {
  return url !== null && /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch|shorts\/)|youtu\.be\/)/i.test(url);
}

/** A Reddit post's comments page: the PC pulls in the post and its top comments. */
export function isRedditPost(url: string | null): boolean {
  return url !== null && /^https?:\/\/(www\.|old\.|new\.)?reddit\.com\/r\/[^/]+\/comments\//i.test(url);
}

// ---------- Include / exclude filter values ----------

/**
 * A filter on several values at once, kept as one string so saved filters and
 * the address bar stay simple: "reddit|github" shows only those, "!reddit|!github"
 * hides them (both can mix). Empty or null = no filter. A single plain value is
 * the old one-choice filter, so older saved filters keep working.
 */
export interface FilterSet {
  include: string[];
  exclude: string[];
}

export const FILTER_SEP = '|';

export function parseFilterSet(value: string | null | undefined): FilterSet {
  const set: FilterSet = { include: [], exclude: [] };
  for (const raw of (value ?? '').split(FILTER_SEP)) {
    const token = raw.trim();
    if (!token || token === '!') continue;
    if (token.startsWith('!')) set.exclude.push(token.slice(1));
    else set.include.push(token);
  }
  return set;
}

export function formatFilterSet(set: FilterSet): string | null {
  const tokens = [...set.include, ...set.exclude.map((v) => `!${v}`)];
  return tokens.length ? tokens.join(FILTER_SEP) : null;
}

/** One tap on a value: off → show only → hide → off. */
export function cycleFilterValue(value: string | null | undefined, token: string): string | null {
  const set = parseFilterSet(value);
  const include = set.include.filter((v) => v !== token);
  const exclude = set.exclude.filter((v) => v !== token);
  if (set.include.includes(token)) exclude.push(token);
  else if (!set.exclude.includes(token)) include.push(token);
  return formatFilterSet({ include, exclude });
}

export function filterState(value: string | null | undefined, token: string): 'include' | 'exclude' | null {
  const set = parseFilterSet(value);
  return set.include.includes(token) ? 'include' : set.exclude.includes(token) ? 'exclude' : null;
}

/** Whether a value gets through: it must be one of the shown values (if any) and none of the hidden ones. */
export function matchesFilterSet(value: string | null | undefined, set: FilterSet): boolean {
  if (set.include.length && !set.include.includes(value ?? '')) return false;
  return !set.exclude.includes(value ?? '');
}

// ---------- Tags and the Topics map ----------

/** The key a tag is grouped under: "Tinybuild" and "tinybuild " are the same tag. */
export function tagKey(label: string): string {
  return label.trim().toLowerCase();
}

/** Everything about one tag: its numbers and its items, newest first. */
export interface TagPage {
  tag: string;
  label: string;
  /** Items with the tag (inbox and archived), and how many are unread. Counted on the first page only. */
  total: number;
  unread: number;
  firstAt: number | null;
  /** Items per week, oldest first, ending with the current week. */
  weeks: { start: number; n: number }[];
  /** Other tags on the same items, most often first. */
  seenWith: { tag: string; label: string; n: number }[];
  sources: { id: string | null; name: string; n: number }[];
  items: ItemSummary[];
  nextOffset: number | null;
  /** Stories with items carrying the tag, most recent first (first page only). */
  stories?: (StoryInfo & { unread: number })[];
}

export type TopicsDays = 7 | 30 | 90;
export const TOPICS_DAYS: TopicsDays[] = [7, 30, 90];

/**
 * One item on the Topics map, packed small: source and category are indexes into
 * TopicsData.sources / categories (-1 = none), flags bit 1 = read, bit 2 = starred,
 * then when it arrived and the indexes of its tags.
 */
export type TopicsItem = [source: number, category: number, flags: number, receivedAt: number, tags: number[]];

/** The Topics map's data for one period. Filters are applied in the app, so changing them costs no reads. */
export interface TopicsData {
  days: TopicsDays;
  generatedAt: number;
  sources: { id: string; name: string; type: SourceType }[];
  categories: string[];
  tags: { key: string; label: string }[];
  items: TopicsItem[];
}

export type TopicsRead = 'all' | 'unread' | 'read' | 'starred';

/** A saved set of Topics map filters. */
export interface TopicFilter {
  name: string;
  days: TopicsDays;
  categories: string[];
  /** Source ids. */
  sources: string[];
  types: SourceType[];
  read: TopicsRead;
  /** How many tags to show, most common first; 0 = all. */
  top: number;
  /** Only tags on at least this many items. */
  min: number;
  showSources: boolean;
}
