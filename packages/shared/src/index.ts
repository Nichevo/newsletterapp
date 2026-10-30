// Types shared between the Worker API and the web app.
// Timestamps are Unix milliseconds.

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
  score: number | null;
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
export type ItemSort = 'newest' | 'oldest';

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
  createdAt: number;
  itemCount: number;
  lastReceivedAt: number | null;
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
}

export const DEFAULT_SETTINGS: AppSettings = {
  categories: ['AI', 'Tech', 'Business', 'Finance', 'Science', 'Politics', 'Health', 'Productivity', 'Culture', 'Other'],
  keywordRules: [],
  aiByKind: { newsletter: true, feed: false, site: false },
  interests: '',
};

export interface SourceUpdate {
  category?: string | null;
  aiMode?: AiMode;
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
export const HELPER_VERSION = '0.1.2';

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
