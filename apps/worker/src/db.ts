import type {
  AiMode,
  Address,
  AuthResult,
  ItemKind,
  ItemStatus,
  ItemSummary,
  Sender,
  SenderStatus,
  Source,
} from '@newsletterapp/shared';

// Row shapes as they come out of D1 (snake_case, integers for booleans).

export interface AddressRow {
  id: string;
  local_part: string;
  label: string | null;
  status: 'active' | 'blocked';
  created_in_app: number;
  created_at: number;
  blocked_at: number | null;
  blocked_count: number;
}

export interface SenderRow {
  id: string;
  email: string;
  address_id: string | null;
  name: string | null;
  status: SenderStatus;
  first_seen_at: number;
  last_seen_at: number;
  decided_at: number | null;
  auth_result: AuthResult;
  blocked_count: number;
}

export interface SourceRow {
  id: string;
  kind: ItemKind;
  name: string;
  sender_email: string | null;
  address_id: string | null;
  folder: string | null;
  category: string | null;
  ai_mode: AiMode;
  created_at: number;
}

export interface ItemRow {
  id: string;
  source_id: string | null;
  sender_id: string | null;
  address_id: string | null;
  kind: ItemKind;
  status: ItemStatus;
  subject: string;
  from_name: string | null;
  from_email: string | null;
  to_address: string | null;
  snippet: string | null;
  received_at: number;
  message_id: string | null;
  raw_key: string | null;
  html_key: string | null;
  text_key: string | null;
  raw_size: number | null;
  has_html: number;
  list_unsubscribe: string | null;
  auth_spf: AuthResult;
  auth_dkim: AuthResult;
  auth_dmarc: AuthResult;
  web_url: string | null;
  read_at: number | null;
  saved_at: number | null;
  archived_at: number | null;
  summary: string | null;
  key_points: string | null;
  tags: string | null;
  score: number | null;
  created_at: number;
  preheader: string | null;
  word_count: number | null;
  category: string | null;
  sponsored: number;
}

export function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export function toItemSummary(
  row: ItemRow & { source_name?: string | null; source_category?: string | null },
): ItemSummary {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    subject: row.subject,
    fromName: row.from_name,
    fromEmail: row.from_email,
    toAddress: row.to_address,
    sourceId: row.source_id,
    sourceName: row.source_name ?? null,
    snippet: row.snippet,
    receivedAt: row.received_at,
    readAt: row.read_at,
    savedAt: row.saved_at,
    archivedAt: row.archived_at,
    hasHtml: row.has_html === 1,
    listUnsubscribe: row.list_unsubscribe,
    webUrl: row.web_url,
    authSpf: row.auth_spf,
    authDkim: row.auth_dkim,
    authDmarc: row.auth_dmarc,
    preheader: row.preheader,
    wordCount: row.word_count,
    category: row.category ?? row.source_category ?? null,
    sponsored: row.sponsored === 1,
    summary: row.summary,
    tags: parseTags(row.tags),
    score: row.score,
  };
}

export function toAddress(
  row: AddressRow & { approved_sender_count?: number | null },
  domain: string | null,
): Address {
  return {
    id: row.id,
    localPart: row.local_part,
    email: domain ? `${row.local_part}@${domain}` : row.local_part,
    label: row.label,
    status: row.status,
    createdInApp: row.created_in_app === 1,
    createdAt: row.created_at,
    blockedAt: row.blocked_at,
    blockedCount: row.blocked_count,
    approvedSenderCount: row.approved_sender_count ?? 0,
  };
}

export function toSender(
  row: SenderRow & {
    address_local_part?: string | null;
    pending_count?: number | null;
    latest_subject?: string | null;
    latest_item_id?: string | null;
  },
): Sender {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    addressId: row.address_id,
    addressLocalPart: row.address_local_part ?? null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    authResult: row.auth_result,
    pendingCount: row.pending_count ?? 0,
    latestSubject: row.latest_subject ?? null,
    latestItemId: row.latest_item_id ?? null,
  };
}

export function toSource(
  row: SourceRow & { item_count?: number | null; last_received_at?: number | null },
): Source {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    senderEmail: row.sender_email,
    addressId: row.address_id,
    folder: row.folder,
    category: row.category,
    aiMode: row.ai_mode,
    createdAt: row.created_at,
    itemCount: row.item_count ?? 0,
    lastReceivedAt: row.last_received_at ?? null,
  };
}
