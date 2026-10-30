// Types shared between the Worker API and the web app.
// Timestamps are Unix milliseconds.

import type { AiLimitHit } from './usage';
import type { Article, FeedEntry } from './web';

export * from './web';

export type ItemKind = 'newsletter' | 'feed' | 'site';

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
  sourceName: string | null;
  snippet: string | null;
  receivedAt: number;
  readAt: number | null;
  savedAt: number | null;
  archivedAt: number | null;
  hasHtml: boolean;
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
  thinContent: boolean;
  /** Who wrote the AI summary, for the italic attribution line. */
  ai: AiAttribution | null;
  /** 0-100, how worth your time this item looks; see scoring.ts. */
  score: number | null;
  /** How it came to be marked read: opened in the reader, swiped in the inbox, a bulk action, or a digest marked done. */
  readVia: ReadVia | null;
  /** Which kind of device it was read on. */
  readDevice: ReadDevice | null;
}

export type ReadVia = 'reader' | 'swipe' | 'bulk' | 'digest';
export type ReadDevice = 'phone' | 'desktop';

/** An older item that shares topics with the one being read. */
export interface RelatedItem {
  id: string;
  subject: string;
  sourceName: string | null;
  receivedAt: number;
  readAt: number | null;
  savedAt: number | null;
  /** The topics or words the two items share, for the "because" line. */
  shared: string[];
}

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
}

export type ItemView = 'inbox' | 'unread' | 'saved' | 'archived';

/** Per-source AI switch. "default" follows the setting for the source's kind. */
export type AiMode = 'default' | 'on' | 'off';
export type ItemSort = 'newest' | 'oldest' | 'top';

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
}

export type ReadingEventType =
  | 'open'
  | 'read_time' // value = seconds of active reading
  | 'finish' // value = furthest scroll percentage
  | 'mark_read'
  | 'save'
  | 'unsave'
  | 'archive'
  | 'unarchive'
  | 'link_click'
  | 'open_original';

export interface ReadingEventInput {
  type: ReadingEventType;
  value?: number;
  device?: 'phone' | 'desktop';
}

export interface Me {
  email: string;
  domain: string | null;
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
  aiByKind: Record<ItemKind, boolean>;
  /** A short line about the reader's interests, used by the summary prompt. */
  interests: string;
  /** Local hour (0-23) at which the daily digest is put together. */
  digestHour: number;
  /** IANA time zone the digest day and hour are measured in, e.g. "Australia/Sydney". */
  timezone: string;
  /** How the daily digest is put together. */
  digest: DigestOptions;
}

export interface DigestOptions {
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
  interests: '',
  digestHour: 7,
  timezone: 'UTC',
  digest: DEFAULT_DIGEST_OPTIONS,
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
  checkMinutes?: number;
  paused?: boolean;
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
}

/** Bump with every change to apps/helper; the helper updates itself when the app has a newer one. */
export const HELPER_VERSION = '0.2.1';

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
}

export interface TrialJob {
  trialId: string;
  models: ModelRef[];
  items: Omit<HelperJob, 'promptId' | 'promptVersion'>[];
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
  results: { itemId: string; provider: string; model: string; seconds: number; output: AiOutput | null; error: string | null }[];
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
  "topics": ["up to 3 specific names or subjects, e.g. Nvidia, interest rates"],
  "thin_content": true or false
}`;

export * from './usage';
