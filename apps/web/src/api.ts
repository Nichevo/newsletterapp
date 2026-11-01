import type {
  Address,
  AskPreset,
  AskPresetInput,
  BulkReadInput,
  FreeAskList,
  Highlight,
  HighlightAnchor,
  HighlightList,
  HighlightListQuery,
  HighlightStats,
  ItemHighlights,
  NewAskInput,
  NewFreeAskInput,
  NewAskResult,
  WebSearchSettings,
  WebSearchView,
  PcOffMode,
  Digest,
  DiscoverResult,
  ItemKind,
  NewSourceInput,
  NewSourceResult,
  OpmlImportResult,
  RelatedItem,
  UnsubscribeResult,
  AiStatsRow,
  AiStatusView,
  AiBacklogView,
  AiUsageSettings,
  AiUsageView,
  AppSettings,
  ModelInfo,
  ModelMode,
  ModelRating,
  ModelRef,
  PromptInfo,
  PromptScope,
  TrialView,
  ItemBody,
  ItemListResponse,
  ItemSort,
  ItemSummary,
  ItemView,
  Me,
  ReadingEventInput,
  ReadingStats,
  Sender,
  SenderStatus,
  Source,
  SourceUpdate,
} from '@newsletterapp/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // not JSON
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

const get = <T>(path: string) => request<T>(path);
const put = <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  me: () => get<Me>('/api/me'),
  counts: () => get<{ inbox: number; unread: number; saved: number; pendingSenders: number }>('/api/counts'),

  listItems: (params: {
    view: ItemView;
    sort: ItemSort;
    source?: string | null;
    category?: string | null;
    kind?: ItemKind | null;
    cursor?: string | null;
  }) => {
    const q = new URLSearchParams({ view: params.view, sort: params.sort });
    if (params.kind) q.set('kind', params.kind);
    if (params.source) q.set('source', params.source);
    if (params.category) q.set('category', params.category);
    if (params.cursor) q.set('cursor', params.cursor);
    return get<ItemListResponse>(`/api/items?${q}`);
  },
  item: (id: string) => get<ItemSummary>(`/api/items/${id}`),
  itemBody: (id: string) => get<ItemBody>(`/api/items/${id}/body`),
  itemAction: (id: string, action: 'read' | 'unread' | 'save' | 'unsave' | 'archive' | 'unarchive') =>
    post<ItemSummary>(`/api/items/${id}/${action}`, action === 'read' ? { device: isPhone() } : undefined),
  bulkRead: (input: BulkReadInput) => post<{ changed: number }>('/api/items/bulk-read', { ...input, device: isPhone() }),
  rawUrl: (id: string) => `/api/items/${id}/raw`,
  related: (id: string) => get<RelatedItem[]>(`/api/items/${id}/related`),
  unsubscribe: (id: string) => post<UnsubscribeResult>(`/api/items/${id}/unsubscribe`),

  /** Fire-and-forget reading event; uses keepalive so it survives page unloads. */
  event: (id: string, input: ReadingEventInput) => {
    void fetch(`/api/items/${id}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      keepalive: true,
    }).catch(() => undefined);
  },

  senders: (status: SenderStatus) => get<Sender[]>(`/api/senders?status=${status}`),
  decideSender: (id: string, decision: 'allow' | 'block') => post<Sender>(`/api/senders/${id}/${decision}`),

  addresses: () => get<Address[]>('/api/addresses'),
  createAddress: (label: string) => post<Address>('/api/addresses', { label }),
  addressAction: (id: string, action: 'block' | 'unblock') => post<Address>(`/api/addresses/${id}/${action}`),

  sources: () => get<Source[]>('/api/sources'),
  updateSource: (id: string, update: SourceUpdate) => post<Source>(`/api/sources/${id}`, update),
  sourceBulk: (id: string, action: 'read-all' | 'archive-all') => post<{ changed: number }>(`/api/sources/${id}/${action}`),
  discoverSource: (url: string) => post<DiscoverResult>('/api/sources/discover', { url }),
  addSource: (input: NewSourceInput) => post<NewSourceResult>('/api/sources', input),
  importOpml: (opml: string, startWith?: number) => post<OpmlImportResult>('/api/sources/opml', { opml, startWith }),
  checkAllSources: () => post<{ due: number; cloud: number; queued: number; added: number }>('/api/sources/check-all'),
  checkSource: (id: string) => post<{ added: number; waitingForPc: boolean; source: Source }>(`/api/sources/${id}/check`),

  digests: () => get<Digest[]>('/api/digests'),
  buildDigest: () => post<Digest | { empty: true }>('/api/digests/build'),
  digestDone: (day: string, markRead: boolean) =>
    post<{ readAt: number; itemsRead: number }>(`/api/digests/${day}/done`, { markRead, device: isPhone() }),
  digestUndone: (day: string) => post<{ readAt: null }>(`/api/digests/${day}/undone`),

  settings: () => get<AppSettings>('/api/settings'),
  saveSettings: (settings: Partial<AppSettings>) => put<AppSettings>('/api/settings', settings),

  // AI summaries (written by the PC helper)
  aiStatus: () => get<AiStatusView>('/api/ai/status'),
  aiPause: () => post<{ ok: boolean }>('/api/ai/pause'),
  aiResume: () => post<{ ok: boolean }>('/api/ai/resume'),
  aiRetryFailed: () => post<{ requeued: number }>('/api/ai/retry-failed'),
  aiModels: () => get<ModelInfo[]>('/api/ai/models'),
  saveAiModels: (list: (ModelRef & { enabled: boolean })[]) => put<{ ok: boolean }>('/api/ai/models', list),
  aiRedoModel: (m: ModelRef) => post<{ requeued: number }>('/api/ai/redo', m),
  aiPrompts: () => get<PromptInfo[]>('/api/ai/prompts'),
  saveAiPrompt: (p: { scope: PromptScope; scopeValue?: string | null; body: string }) => put<PromptInfo>('/api/ai/prompts', p),
  deleteAiPrompt: (id: string) => request<{ ok: boolean }>(`/api/ai/prompts/${id}`, { method: 'DELETE' }),
  aiStats: (by: 'model' | 'source' | 'prompt') => get<AiStatsRow[]>(`/api/ai/stats?by=${by}`),
  readingStats: (days: number) => get<ReadingStats>(`/api/reading/stats?days=${days}`),
  highlightList: (query: HighlightListQuery) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') q.set(k, String(v));
    return get<HighlightList>(`/api/highlights?${q}`);
  },
  highlightStats: (days: number) => get<HighlightStats>(`/api/highlights/stats?days=${days}`),
  aiUsage: () => get<AiUsageView>('/api/ai/usage'),
  aiBacklog: () => get<AiBacklogView>('/api/ai/backlog'),
  saveAiUsageSettings: (s: Partial<AiUsageSettings>) => put<AiUsageSettings>('/api/ai/usage/settings', s),
  startTrial: (models: ModelRef[], count = 20) => post<{ id: string }>('/api/ai/trials', { models, count }),
  latestTrial: () => get<TrialView | null>('/api/ai/trials/latest'),
  clearTrial: (id: string) => post<{ ok: true }>(`/api/ai/trials/${id}/clear`),
  rateTrial: (trialId: string, r: { itemId: string; provider: string; model: string; rating: 1 | -1 | 0 }) =>
    post<{ ok: boolean }>(`/api/ai/trials/${trialId}/rate`, r),
  modelMode: () => get<{ mode: ModelMode }>('/api/ai/model-mode'),
  saveModelMode: (mode: ModelMode) => put<{ mode: ModelMode }>('/api/ai/model-mode', { mode }),
  aiRatings: (days = 182) => get<ModelRating[]>(`/api/ai/ratings?days=${days}`),
  rateItem: (id: string, rating: 1 | -1 | 0) => post<{ ok: boolean }>(`/api/items/${id}/rate`, { rating }),
  redoItem: (id: string) => post<{ ok: boolean }>(`/api/items/${id}/redo`),
  aiAdvice: (id: string) => get<{ suggestOff: boolean }>(`/api/items/${id}/ai-advice`),

  // Highlights and questions to the AI about them
  highlights: (itemId: string) => get<ItemHighlights>(`/api/items/${itemId}/highlights`),
  addHighlight: (itemId: string, anchor: HighlightAnchor) => post<Highlight>(`/api/items/${itemId}/highlights`, anchor),
  deleteHighlight: (id: string) => request<{ ok: boolean }>(`/api/highlights/${id}`, { method: 'DELETE' }),
  ask: (input: NewAskInput) => post<NewAskResult>('/api/asks', input),
  freeAsks: () => get<FreeAskList>('/api/asks/free'),
  askFree: (input: NewFreeAskInput) => post<{ id: string }>('/api/asks/free', input),
  retryAsk: (id: string) => post<{ ok: boolean }>(`/api/asks/${id}/retry`),
  rateAsk: (id: string, rating: 1 | -1 | 0) => post<{ ok: boolean }>(`/api/asks/${id}/rate`, { rating }),
  deleteAsk: (id: string) => request<{ ok: boolean }>(`/api/asks/${id}`, { method: 'DELETE' }),
  askPresets: () => get<AskPreset[]>('/api/ask-presets'),
  saveAskPreset: (id: string, p: AskPresetInput) => put<AskPreset>(`/api/ask-presets/${id}`, p),
  addAskPreset: (p: AskPresetInput) => post<AskPreset>('/api/ask-presets', p),
  resetAskPreset: (id: string) => post<AskPreset>(`/api/ask-presets/${id}/reset`),
  deleteAskPreset: (id: string) => request<{ ok: boolean }>(`/api/ask-presets/${id}`, { method: 'DELETE' }),
  orderAskPresets: (ids: string[]) => put<AskPreset[]>('/api/ask-presets/order', ids),
  webSearch: () => get<WebSearchView>('/api/ai/web-search'),
  saveWebSearch: (s: Partial<WebSearchSettings>) => put<WebSearchSettings>('/api/ai/web-search', s),
  pcOffMode: () => get<{ mode: PcOffMode }>('/api/ai/pc-off'),

  quickBackfill: () => post<{ done: number; remaining: number }>('/api/maintenance/quick-backfill'),
};

export function isPhone(): 'phone' | 'desktop' {
  return window.matchMedia('(max-width: 720px)').matches ? 'phone' : 'desktop';
}
