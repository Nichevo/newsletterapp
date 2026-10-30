import type {
  AiMode,
  AiStatus,
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
  ai_status: AiStatus | null;
  ai_attempts: number;
  ai_claimed_at: number | null;
  ai_error: string | null;
  ai_category: string | null;
  why_it_matters: string | null;
  thin_content: number;
  ai_run_id: string | null;
}

/** Extra columns joined in by the item queries (source and the AI run that wrote the summary). */
export interface ItemJoined {
  source_name?: string | null;
  source_category?: string | null;
  run_provider?: string | null;
  run_model?: string | null;
  run_prompt_version?: number | null;
  run_seconds?: number | null;
  run_rating?: number | null;
}

export function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export function toItemSummary(row: ItemRow & ItemJoined): ItemSummary {
  const aiCategory = parseList(row.ai_category)[0] ?? null;
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
    category: row.category ?? row.source_category ?? aiCategory,
    sponsored: row.sponsored === 1,
    aiStatus: row.ai_status,
    summary: row.summary,
    keyPoints: parseList(row.key_points),
    whyItMatters: row.why_it_matters,
    tags: parseList(row.tags),
    thinContent: row.thin_content === 1,
    ai:
      row.ai_run_id && row.run_model
        ? {
            runId: row.ai_run_id,
            provider: row.run_provider ?? '',
            model: row.run_model,
            promptVersion: row.run_prompt_version ?? null,
            seconds: row.run_seconds ?? null,
            rating: row.run_rating === 1 || row.run_rating === -1 ? row.run_rating : null,
          }
        : null,
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
