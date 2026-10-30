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
  summary: string | null;
  tags: string[];
  score: number | null;
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
