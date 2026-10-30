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
  // Filled in from Phase 2 onwards.
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
export type ItemSort = 'newest' | 'oldest';

export interface Source {
  id: string;
  kind: ItemKind;
  name: string;
  senderEmail: string | null;
  addressId: string | null;
  folder: string | null;
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
