import type {
  Counts,
  StatusIncidentPage,
  StatusSettings,
  StatusSettingsView,
  StatusView,
  FetchPageStatus,
  SavePageResult,
  SearchResponse,
  TagList,
  TagPage,
  TopicsData,
  SourceActivity,
  SourceDepthDetail,
  TopicSkips,
  GlanceInput,
  Address,
  AddressMonth,
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
  ItemKeySentences,
  ItemReferences,
  KeyStats,
  KeyUseEvent,
  LinkDetail,
  LinkSummary,
  StudyDetail,
  StudySummary,
  KeyFixInput,
  KeyMark,
  KeySentenceSettings,
  NewAskInput,
  NewFreeAskInput,
  NewAskResult,
  WebSearchSettings,
  WebSearchView,
  PcOffMode,
  Review,
  ReviewKind,
  ReviewListItem,
  ReviewQuality,
  CategorySuggestion,
  ReviewFinding,
  DiscoverResult,
  ItemKind,
  NewSourceInput,
  NewSourceResult,
  OpmlImportResult,
  StoryBanner,
  StoryList,
  StoryNear,
  StoryOverview,
  StoryPage,
  StoryStats,
  UnsubscribeResult,
  AiStatsRow,
  AiStatusView,
  AiBacklogView,
  AiUsageSettings,
  AiUsageView,
  AppSettings,
  SaveAddressInfo,
  PcHoldsView,
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
  SuggestLearntPage,
  SuggestionList,
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
  counts: () => get<Counts>('/api/counts'),

  // System status (service status pages)
  status: () => get<StatusView>('/api/status'),
  statusCheck: () => post<StatusView>('/api/status/check'),
  statusIncident: (id: string) => get<StatusIncidentPage>(`/api/status/incidents/${encodeURIComponent(id)}`),
  statusSettings: () => get<StatusSettingsView>('/api/status/settings'),
  saveStatusSettings: (patch: Partial<StatusSettings>) => put<StatusSettingsView>('/api/status/settings', patch),
  updateStatusService: (id: string, patch: { enabled?: boolean; only?: string[]; name?: string }) =>
    put<StatusSettingsView>(`/api/status/services/${encodeURIComponent(id)}`, patch),
  addStatusService: (name: string, url: string) => post<StatusSettingsView>('/api/status/services', { name, url }),
  removeStatusService: (id: string) => request<StatusSettingsView>(`/api/status/services/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listItems: (params: {
    view: ItemView;
    sort: ItemSort;
    source?: string | null;
    category?: string | null;
    kind?: string | null;
    cursor?: string | null;
    /** Include each row's key sentences. */
    keys?: boolean;
  }) => {
    const q = new URLSearchParams({ view: params.view, sort: params.sort });
    if (params.keys) q.set('keys', '1');
    if (params.kind) q.set('kind', params.kind);
    if (params.source) q.set('source', params.source);
    if (params.category) q.set('category', params.category);
    if (params.cursor) q.set('cursor', params.cursor);
    return get<ItemListResponse>(`/api/items?${q}`);
  },
  item: (id: string) => get<ItemSummary>(`/api/items/${id}`),
  // A replaced copy has its own address (?v=), so the week-long cache never serves the old one.
  itemBody: (id: string, version = 0) => get<ItemBody>(`/api/items/${id}/body${version ? `?v=${version}` : ''}`),
  fetchPage: (id: string) => post<FetchPageStatus>(`/api/items/${id}/fetch-page`),
  fetchPageStatus: (id: string) => get<FetchPageStatus>(`/api/items/${id}/fetch-page`),
  itemAction: (
    id: string,
    action: 'read' | 'unread' | 'save' | 'unsave' | 'interesting' | 'uninteresting' | 'archive' | 'unarchive' | 'not_interested' | 'interested',
  ) => post<ItemSummary>(`/api/items/${id}/${action}`, action === 'read' || action === 'not_interested' ? { device: isPhone() } : undefined),
  /** Seconds inbox rows sat at the reading line; keepalive so it survives leaving the page. */
  glances: (input: GlanceInput) => {
    if (!input.items.length) return;
    void fetch('/api/items/glances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      keepalive: true,
    }).catch(() => undefined);
  },
  sourceDepth: (id: string) => get<SourceDepthDetail>(`/api/sources/${id}/depth`),
  topicSkips: (fresh = false) => get<TopicSkips>(`/api/stats/topic-skips${fresh ? '?fresh=1' : ''}`),
  bulkRead: (input: BulkReadInput) => post<{ changed: number }>('/api/items/bulk-read', { ...input, device: isPhone() }),
  rawUrl: (id: string) => `/api/items/${id}/raw`,
  storyBanner: (id: string) => get<StoryBanner | null>(`/api/items/${id}/story`),
  stories: () => get<StoryList>('/api/stories'),
  story: (id: string) => get<StoryPage>(`/api/stories/${id}`),
  summariseStory: (id: string) => post<StoryOverview>(`/api/stories/${id}/summary`),
  storySummaryAuto: (id: string, on: boolean) => post<StoryOverview>(`/api/stories/${id}/summary/auto`, { on }),
  followStory: (id: string, on: boolean) => post<{ ok: boolean }>(`/api/stories/${id}/follow`, { on }),
  closeStory: (id: string, on: boolean) => post<{ ok: boolean }>(`/api/stories/${id}/close`, { on }),
  storyNear: (id: string) => get<StoryNear[]>(`/api/items/${id}/near`),
  joinStory: (itemId: string, withId: string) => post<{ ok: boolean; storyId: string }>('/api/stories/join', { itemId, withId }),
  splitFromStory: (itemId: string) => post<{ ok: boolean }>(`/api/stories/split/${itemId}`),
  recheckStories: (category: string) => post<{ ok: boolean; changed: number }>('/api/stories/recheck', { category }),
  resetStoryLearnt: () => post<{ ok: boolean }>('/api/stories/learnt/reset'),
  rebuildStories: () => post<{ ok: boolean; matched: number }>('/api/stories/rebuild'),
  storyStats: (days: number, fresh = false) => get<StoryStats>(`/api/stats/stories?days=${days}${fresh ? '&fresh=1' : ''}`),
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
  saveAddress: (id: string, p: { label?: string | null; note?: string | null }) => put<Address>(`/api/addresses/${id}`, p),
  addressMonths: (id: string) => get<AddressMonth[]>(`/api/addresses/${id}/months`),
  deleteAddress: (id: string) => request<{ ok: boolean }>(`/api/addresses/${id}`, { method: 'DELETE' }),

  /** With counts: each source's post count too (reads every item; only the source pages need it). */
  sources: (counts = false) => get<Source[]>(counts ? '/api/sources?counts=1' : '/api/sources'),
  suggestions: () => get<SuggestionList>('/api/suggestions'),
  suggestionsRun: () => post<{ ok: boolean }>('/api/suggestions/run'),
  suggestionFollowed: (site: string, sourceId: string | null) =>
    post<{ ok: boolean; sourceId: string | null }>(`/api/suggestions/${encodeURIComponent(site)}/follow`, { sourceId }),
  suggestionDismiss: (site: string) => post<{ ok: boolean }>(`/api/suggestions/${encodeURIComponent(site)}/dismiss`),
  suggestionUndo: (site: string) => post<{ ok: boolean }>(`/api/suggestions/${encodeURIComponent(site)}/undo`),
  suggestionIgnore: (site: string, on: boolean) => post<{ ok: boolean }>(`/api/suggestions/${encodeURIComponent(site)}/ignore`, { on }),
  suggestionsLearnt: () => get<SuggestLearntPage>('/api/suggestions/learnt'),
  suggestionsForget: (input: { kind?: 'topic' | 'source'; key?: string; all?: boolean }) => post<{ ok: boolean }>('/api/suggestions/learnt/forget', input),
  updateSource: (id: string, update: SourceUpdate) => post<Source>(`/api/sources/${id}`, update),
  sourceBulk: (id: string, action: 'read-all' | 'archive-all') => post<{ changed: number }>(`/api/sources/${id}/${action}`),
  discoverSource: (url: string) => post<DiscoverResult>('/api/sources/discover', { url }),
  addSource: (input: NewSourceInput) => post<NewSourceResult>('/api/sources', input),
  savePage: (url: string) => post<SavePageResult>('/api/pages', { url }),
  /** Add > Upload a file (a PDF, usually); sent as a form so the file goes as it is. */
  uploadFile: async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/pages/file', { method: 'POST', body: form, headers: { Accept: 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as SavePageResult & { error?: string };
    if (!res.ok) throw new ApiError(body.error ?? res.statusText, res.status);
    return body;
  },
  deleteItem: (id: string) => post<{ ok: boolean }>(`/api/items/${id}/delete`),
  undeleteItem: (id: string) => post<{ ok: boolean }>(`/api/items/${id}/undelete`),
  /** The app's own copy of a file added as a page (a PDF, a picture). */
  fileUrl: (id: string) => `/api/items/${id}/file`,
  importOpml: (opml: string, startWith?: number) => post<OpmlImportResult>('/api/sources/opml', { opml, startWith }),
  checkAllSources: () => post<{ due: number; cloud: number; queued: number; added: number }>('/api/sources/check-all'),
  exportMeta: () => get<{ exportedAt: number; sources: unknown[]; settings: unknown; highlights: unknown[] }>('/api/export/meta'),
  exportItems: (after: number) => get<{ items: Record<string, unknown>[]; next: number | null }>(`/api/export/items?after=${after}`),
  exportTable: (name: string, after: number) =>
    get<{ rows: Record<string, unknown>[]; next: number | null }>(`/api/export/table/${name}?after=${after}`),
  exportEvents: (after: number) => get<{ events: Record<string, unknown>[]; next: number | null }>(`/api/export/events?after=${after}`),
  search: (query: string) => get<SearchResponse>(`/api/search?${query}`),
  sourceActivity: () => get<SourceActivity[]>('/api/sources/activity'),
  checkSource: (id: string) => post<{ added: number; waitingForPc: boolean; source: Source }>(`/api/sources/${id}/check`),

  reviews: () => get<ReviewListItem[]>('/api/reviews'),
  review: (id: string) => get<Review>(`/api/reviews/${id}`),
  reviewQuality: () => get<ReviewQuality>('/api/reviews/quality'),
  buildReview: (kind: ReviewKind) => post<Review>('/api/reviews/build', { kind }),
  reviewDone: (id: string, markRead: boolean) =>
    post<{ readAt: number; itemsRead: number }>(`/api/reviews/${id}/done`, { markRead, device: isPhone() }),
  reviewUndone: (id: string) => post<{ readAt: null }>(`/api/reviews/${id}/undone`),
  reviewMore: (id: string) => post<{ status: string }>(`/api/reviews/${id}/more`),
  reviewRetry: (id: string) => post<{ status: string }>(`/api/reviews/${id}/retry`),
  reviewFinding: (id: string, fid: string, notUseful: boolean) => post<ReviewFinding>(`/api/reviews/${id}/findings/${fid}`, { notUseful }),
  reviewCategory: (id: string, sid: string, action: 'apply' | 'apply_old' | 'dismiss') =>
    post<{ suggestion: CategorySuggestion; message: string }>(`/api/reviews/${id}/categories/${encodeURIComponent(sid)}`, { action }),

  settings: () => get<AppSettings>('/api/settings'),
  pcHolds: () => get<PcHoldsView>('/api/pc-holds'),
  tag: (name: string, view: 'all' | 'unread', offset = 0) =>
    get<TagPage>(`/api/tag?name=${encodeURIComponent(name)}&view=${view}&offset=${offset}`),
  tags: (days: number) => get<TagList>(`/api/tags?days=${days}`),
  topics: (days: number, fresh = false) => get<TopicsData>(`/api/topics?days=${days}${fresh ? '&fresh=1' : ''}`),
  saveSettings: (settings: Partial<AppSettings>) => put<AppSettings>('/api/settings', settings),
  saveAddressInfo: () => get<SaveAddressInfo>('/api/save-address'),

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
  keySentences: (itemId: string) => get<ItemKeySentences>(`/api/items/${itemId}/key-sentences`),
  findKeySentences: (itemId: string) => post<{ ok: boolean }>(`/api/items/${itemId}/key-sentences`),
  fixKeySentence: (itemId: string, fix: KeyFixInput) => post<{ marks: KeyMark[] }>(`/api/items/${itemId}/key-sentences/fix`, fix),
  keySettings: () => get<KeySentenceSettings>('/api/key-sentences/settings'),
  saveKeySettings: (s: Partial<KeySentenceSettings>) => put<KeySentenceSettings>('/api/key-sentences/settings', s),
  keyBackdate: (days: number) => post<{ queued: number; refs?: number }>('/api/key-sentences/backdate', { days }),
  keyStats: (days: number) => get<KeyStats>(`/api/key-sentences/stats?days=${days}`),
  keyUse: (event: KeyUseEvent) => post<{ ok: boolean }>('/api/key-sentences/use', { event }),
  references: (itemId: string) => get<ItemReferences>(`/api/items/${itemId}/references`),
  studies: (q: { sort?: 'cited' | 'recent'; min?: 1 | 2; q?: string; differs?: boolean; page?: number }) => {
    const p = new URLSearchParams();
    if (q.sort) p.set('sort', q.sort);
    if (q.min === 2) p.set('min', '2');
    if (q.q) p.set('q', q.q);
    if (q.differs) p.set('differs', '1');
    if (q.page) p.set('page', String(q.page));
    return get<{ studies: StudySummary[]; more: boolean }>(`/api/studies?${p}`);
  },
  study: (id: string) => get<StudyDetail>(`/api/studies/${id}`),
  sameStudy: (id: string, other: string, same: boolean) => post<{ ok: boolean; id: string }>(`/api/studies/${id}/same`, { other, same }),
  links: (page = 0) => get<{ links: LinkSummary[]; more: boolean }>(`/api/links${page ? `?page=${page}` : ''}`),
  link: (id: string) => get<LinkDetail>(`/api/links/${id}`),
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
