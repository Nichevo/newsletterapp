import type {
  Address,
  AppSettings,
  ItemBody,
  ItemListResponse,
  ItemSort,
  ItemSummary,
  ItemView,
  Me,
  ReadingEventInput,
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
    cursor?: string | null;
  }) => {
    const q = new URLSearchParams({ view: params.view, sort: params.sort });
    if (params.source) q.set('source', params.source);
    if (params.category) q.set('category', params.category);
    if (params.cursor) q.set('cursor', params.cursor);
    return get<ItemListResponse>(`/api/items?${q}`);
  },
  item: (id: string) => get<ItemSummary>(`/api/items/${id}`),
  itemBody: (id: string) => get<ItemBody>(`/api/items/${id}/body`),
  itemAction: (id: string, action: 'read' | 'unread' | 'save' | 'unsave' | 'archive' | 'unarchive') =>
    post<ItemSummary>(`/api/items/${id}/${action}`),
  rawUrl: (id: string) => `/api/items/${id}/raw`,

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

  settings: () => get<AppSettings>('/api/settings'),
  saveSettings: (settings: Partial<AppSettings>) => put<AppSettings>('/api/settings', settings),

  quickBackfill: () => post<{ done: number; remaining: number }>('/api/maintenance/quick-backfill'),
};

export function isPhone(): 'phone' | 'desktop' {
  return window.matchMedia('(max-width: 720px)').matches ? 'phone' : 'desktop';
}
