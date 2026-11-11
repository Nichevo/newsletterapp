import { parseRhythm } from './rhythm';
import { DEFAULT_DAILY_CAP, EMPTY_POST_FILTER, fileTypeLabel, normalizePostFilter, platformOf, type PostFilter } from '@newsletterapp/shared';
import type {
  AiMode,
  AiStatus,
  FetchVia,
  FullTextMode,
  Address,
  AuthResult,
  ItemKind,
  SummaryKind,
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
  note?: string | null;
  item_count?: number | null;
  last_item_at?: number | null;
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
  ai_since: number | null;
  unsubscribed_at: number | null;
  created_at: number;
  url: string | null;
  feed_url: string | null;
  fetch_via: FetchVia;
  render: number;
  full_text: FullTextMode;
  link_hint: string | null;
  check_minutes: number | null;
  etag: string | null;
  last_modified: string | null;
  last_checked_at: number | null;
  next_check_at: number | null;
  last_ok_at: number | null;
  last_error: string | null;
  error_count: number;
  paused_at: number | null;
  start_count: number | null;
  rhythm: string | null;
  show_picture?: number | null;
  bundle?: number | null;
  wait_hours?: number | null;
  follow_link?: number | null;
  key_sentences?: string | null;
  flood_skip?: number | null;
  post_filter?: string | null;
  daily_cap?: number | null;
  flood_at?: number | null;
  flood_count?: number | null;
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
  list_unsubscribe_post: string | null;
  auth_spf: AuthResult;
  auth_dkim: AuthResult;
  auth_dmarc: AuthResult;
  web_url: string | null;
  read_at: number | null;
  read_via: string | null;
  read_device: string | null;
  saved_at: number | null;
  interesting_at: number | null;
  likely: number | null;
  body_v?: number | null;
  lead_image?: string | null;
  lead_image_title?: string | null;
  lead_image_alt?: string | null;
  file_type?: string | null;
  file_key?: string | null;
  deleted_at?: number | null;
  archived_at: number | null;
  summary: string | null;
  key_points: string | null;
  tags: string | null;
  score: number | null;
  created_at: number;
  preheader: string | null;
  word_count: number | null;
  ks_status?: string | null;
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
  highlight_count?: number | null;
  note_count?: number | null;
  origin_item_id?: string | null;
  background?: string | null;
  coverage?: string | null;
  story_id?: string | null;
  news_id?: string | null;
  neighbours?: string | null;
}

/** Extra columns joined in by the item queries (source and the AI run that wrote the summary). */
export interface ItemJoined {
  source_name?: string | null;
  source_category?: string | null;
  source_ai_mode?: AiMode | null;
  source_ai_since?: number | null;
  source_show_picture?: number | null;
  source_feed_url?: string | null;
  source_kind?: string | null;
  source_url?: string | null;
  run_provider?: string | null;
  run_model?: string | null;
  run_prompt_version?: number | null;
  run_seconds?: number | null;
  run_rating?: number | null;
  story_title?: string | null;
  story_tags?: string | null;
  story_items?: number | null;
  story_followed_at?: number | null;
}

function parseCoverage(raw: string | null): { title: string; url: string }[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((c): c is { title: string; url: string } => Boolean(c) && typeof c.url === 'string') : [];
  } catch {
    return [];
  }
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

/** The name a story goes by: the PC's, else its main tags, else its first headline. */
export function storyTitle(row: { title: string | null; tags: string | null }, firstSubject?: string | null): string {
  if (row.title) return row.title;
  const tags = parseList(row.tags);
  if (tags.length) return tags.slice(0, 3).join(' · ');
  return firstSubject ?? 'Untitled story';
}

/** Picks the https link out of a List-Unsubscribe header, if there is one. */
export function unsubscribeHttpUrl(header: string | null): string | null {
  if (!header) return null;
  const m = /<(https?:\/\/[^>\s]+)>/i.exec(header);
  return m?.[1] ?? null;
}

/** Picks the mailto target out of a List-Unsubscribe header, if there is one. */
export function unsubscribeMailto(header: string | null): string | null {
  if (!header) return null;
  const m = /<(mailto:[^>\s]+)>/i.exec(header);
  return m?.[1] ?? null;
}

/** RFC 8058: an https link plus "List-Unsubscribe=One-Click" in List-Unsubscribe-Post. */
export function isOneClick(header: string | null, post: string | null): boolean {
  return unsubscribeHttpUrl(header) !== null && /one-click/i.test(post ?? '');
}

/**
 * With the AI switches passed in, an item whose source has AI off reports no
 * AI status, so the app doesn't show it as waiting for the PC. (Items stay
 * queued, so switching AI on later picks them up.)
 */
export function toItemSummary(row: ItemRow & ItemJoined, aiByKind?: Record<SummaryKind, boolean>, aiOffCategories: string[] = []): ItemSummary {
  const aiCategory = parseList(row.ai_category)[0] ?? null;
  const mode = row.source_ai_mode ?? 'default';
  const beforeCutoff = row.source_ai_since != null && Math.max(row.created_at, row.received_at) < row.source_ai_since;
  const offByCategory = aiOffCategories.includes(row.category ?? row.source_category ?? '');
  const aiOff =
    aiByKind !== undefined && (mode === 'off' || (mode === 'default' && (!aiByKind[row.kind as SummaryKind] || offByCategory)) || beforeCutoff);
  // 'held' = parked in the database while the AI switch is off; to the app it's still waiting.
  const stored = (row.ai_status as string | null) === 'held' ? 'pending' : row.ai_status;
  const aiStatus = aiOff && (stored === 'pending' || stored === null) ? null : stored;
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
    readVia: (row.read_via as ItemSummary['readVia']) ?? null,
    readDevice: (row.read_device as ItemSummary['readDevice']) ?? null,
    savedAt: row.saved_at,
    interestingAt: row.interesting_at ?? null,
    likely: row.likely === 1,
    archivedAt: row.archived_at,
    hasHtml: row.has_html === 1,
    bodyVersion: row.body_v ?? 0,
    platform: platformOf(row.source_feed_url),
    leadImage: row.source_show_picture === 1 && row.lead_image ? { src: row.lead_image, title: row.lead_image_title ?? null, alt: row.lead_image_alt ?? null } : null,
    listUnsubscribe: row.list_unsubscribe,
    oneClickUnsubscribe: isOneClick(row.list_unsubscribe, row.list_unsubscribe_post),
    webUrl: row.web_url,
    authSpf: row.auth_spf,
    authDkim: row.auth_dkim,
    authDmarc: row.auth_dmarc,
    preheader: row.preheader,
    wordCount: row.word_count,
    category: row.category ?? row.source_category ?? aiCategory,
    sponsored: row.sponsored === 1,
    aiStatus,
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
    highlightCount: row.highlight_count ?? 0,
    noteCount: row.note_count ?? 0,
    originItemId: row.origin_item_id ?? null,
    background: row.background ?? null,
    coverage: parseCoverage(row.coverage ?? null),
    story:
      row.story_id && row.story_items
        ? {
            id: row.story_id,
            title: storyTitle({ title: row.story_title ?? null, tags: row.story_tags ?? null }, 'Story'),
            items: row.story_items,
            followed: row.story_followed_at != null,
          }
        : null,
    newsId: row.news_id ?? null,
    hasNear: !row.story_id && nearestSim(row.neighbours ?? null) >= NEAR_SHOW,
    file: row.file_type ? { type: row.file_type, label: fileTypeLabel(row.file_type, row.web_url ?? ''), kept: Boolean(row.file_key) } : null,
    savedPage: row.source_kind != null && isSavedPages({ kind: row.source_kind, url: row.source_url }),
    keySentences: row.ks_status === 'done' ? 'done' : row.ks_status === 'pending' || row.ks_status === 'working' ? 'waiting' : null,
  };
}

/** The least closeness in meaning shown under "Close, but not linked" in the reader. */
export const NEAR_SHOW = 0.62;

/** The closest neighbour's similarity from an item's neighbours JSON ([[id, sim], ...]); 0 when none. */
export function nearestSim(raw: string | null): number {
  if (!raw) return 0;
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return 0;
    let top = 0;
    for (const n of list) if (Array.isArray(n) && typeof n[1] === 'number' && n[1] > top) top = n[1];
    return top;
  } catch {
    return 0;
  }
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
    note: row.note ?? null,
    itemCount: row.item_count ?? 0,
    lastItemAt: row.last_item_at ?? null,
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
    aiSince: row.ai_since ?? null,
    unsubscribedAt: row.unsubscribed_at ?? null,
    createdAt: row.created_at,
    itemCount: row.item_count ?? 0,
    lastReceivedAt: row.last_received_at ?? null,
    url: row.url ?? null,
    feedUrl: row.feed_url ?? null,
    fetchVia: row.fetch_via ?? 'cloud',
    render: row.render === 1,
    fullText: row.full_text ?? 'auto',
    linkHint: row.link_hint ?? null,
    checkMinutes: row.check_minutes ?? null,
    lastCheckedAt: row.last_checked_at ?? null,
    nextCheckAt: row.next_check_at ?? null,
    lastError: row.last_error ?? null,
    errorCount: row.error_count ?? 0,
    pausedAt: row.paused_at ?? null,
    rhythm: row.kind === 'feed' ? parseRhythm(row.rhythm) : null,
    showPicture: row.show_picture === 1,
    bundle: row.bundle === 1,
    waitHours: row.wait_hours ?? 0,
    platform: platformOf(row.feed_url),
    followLink: row.follow_link === 1,
    floodSkip: row.flood_skip === 1,
    postFilter: sourcePostFilter(row),
    dailyCap: row.daily_cap ?? DEFAULT_DAILY_CAP,
    floodAt: row.flood_at ?? null,
    floodCount: row.flood_count ?? 0,
    savedPages: isSavedPages(row),
    keySentences: row.key_sentences === 'always' || row.key_sentences === 'never' ? row.key_sentences : 'auto',
  };
}

/** The "Saved pages" source: a website source with no page to watch (single pages added on their own). */
export function isSavedPages(row: { kind: string; url?: string | null }): boolean {
  return row.kind === 'site' && !row.url;
}

/** A source's stored post filter. */
export function sourcePostFilter(row: { post_filter?: string | null }): PostFilter {
  if (!row.post_filter) return EMPTY_POST_FILTER;
  try {
    return normalizePostFilter(JSON.parse(row.post_filter));
  } catch {
    return EMPTY_POST_FILTER;
  }
}
