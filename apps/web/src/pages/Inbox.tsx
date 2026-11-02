import { SavedTabs } from './Highlights';
import { SOURCE_TYPES, type ItemListResponse, type ItemSummary, type ItemView, type Me, type SavedFilter, type Source, type SourceType } from '@newsletterapp/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { rememberList } from '../readingList';
import { api } from '../api';
import type { Counts } from '../App';
import { DensityToggle } from '../components/DensityToggle';
import { FilterBar, type Filters } from '../components/FilterBar';
import { ItemRow, type SwipeAction } from '../components/ItemRow';
import { getSwipeReadSide } from '../prefs';
import { todayLabel } from '../format';
import { IconPlus, IconRefresh, IconSearch, IconSparkle } from '../icons';

const VIEWS: ItemView[] = ['inbox', 'unread', 'saved', 'interesting', 'likely', 'archived'];

/** The inbox, or one of the Saved screens (Saved for later, Interesting), which show a fixed view. */
type Mode = 'inbox' | 'saved' | 'interesting';

/** The filter bar choices are remembered per screen on this device. */
function storageKey(mode: Mode) {
  return `filters:${mode}`;
}

function loadFilters(mode: Mode): Filters {
  const fallback: Filters = { view: mode === 'inbox' ? 'inbox' : mode, sort: 'newest', source: null, category: null, kind: null };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(mode)) ?? 'null') as Partial<Filters> | null;
    if (!saved) return fallback;
    return {
      view: mode !== 'inbox' ? mode : VIEWS.includes(saved.view as ItemView) ? (saved.view as ItemView) : fallback.view,
      sort: saved.sort === 'oldest' || saved.sort === 'top' ? saved.sort : 'newest',
      source: typeof saved.source === 'string' ? saved.source : null,
      category: typeof saved.category === 'string' ? saved.category : null,
      kind: SOURCE_TYPES.includes(saved.kind as SourceType) ? (saved.kind as SourceType) : null,
    };
  } catch {
    return fallback;
  }
}

function saveFilters(mode: Mode, filters: Filters) {
  try {
    localStorage.setItem(storageKey(mode), JSON.stringify(filters));
  } catch {
    // Storage can be unavailable (private browsing); the filters just won't be remembered.
  }
}

export function InboxPage({
  mode,
  me,
  counts,
  onChanged,
}: {
  mode: Mode;
  me: Me;
  counts: Counts;
  onChanged: () => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => {
    // A link like /?source=<id> (from Settings) opens the inbox on that source.
    const linked = searchParams.get('source');
    const stored = loadFilters(mode);
    const linkedView = VIEWS.find((v) => v === searchParams.get('view'));
    return linked ? { ...stored, view: linkedView ?? (mode === 'inbox' ? 'inbox' : mode), source: linked, category: null, kind: null } : stored;
  });
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [savedFilters, setSavedFilters] = useState<SavedFilter[] | null>(null);
  async function storeFilters(list: SavedFilter[]) {
    const before = savedFilters;
    setSavedFilters(list);
    try {
      setSavedFilters((await api.saveSettings({ savedFilters: list })).savedFilters);
    } catch {
      setSavedFilters(before);
    }
  }
  const [aiPaused, setAiPaused] = useState<string | null>(null);
  const [listCounts, setListCounts] = useState<ItemListResponse['counts'] | null>(null);
  // Sources with items in the chosen category, kept while a source is then picked so the others stay on offer.
  const [catSources, setCatSources] = useState<{ category: string; ids: string[] } | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  function showToast(text: string, undo?: () => void) {
    window.clearTimeout(toastTimer.current);
    setToast({ text, undo });
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  }
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const load = useCallback(
    async (append: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.listItems({ ...filters, cursor: append ? cursor : null });
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        setCursor(res.nextCursor);
        if (!append) setListCounts(res.counts ?? null);
        if (!append && filters.category && res.categorySources) setCatSources({ category: filters.category, ids: res.categorySources });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load');
      } finally {
        setLoading(false);
      }
    },
    [filters, cursor],
  );

  useEffect(() => {
    saveFilters(mode, filters);
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  useEffect(() => {
    if (searchParams.has('source')) setSearchParams({}, { replace: true });
    api.sources().then(setSources).catch(() => undefined);
    api
      .settings()
      .then((s) => {
        setCategories(s.categories);
        setSavedFilters(s.savedFilters);
      })
      .catch(() => undefined);
    api
      .aiStatus()
      .then((s) => setAiPaused(s.paused ? (s.pauseReason ?? 'Paused') : null))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Items that arrived before quick summaries existed get them filled in, a few at a time.
  const needsBackfill = items.some((i) => i.wordCount === null);
  useEffect(() => {
    if (!needsBackfill) return;
    let cancelled = false;
    void (async () => {
      for (let round = 0; round < 40 && !cancelled; round++) {
        const res = await api.quickBackfill().catch(() => null);
        if (!res || res.remaining === 0 || res.done === 0) break;
      }
      if (!cancelled) void load(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsBackfill]);

  useEffect(() => {
    rememberList(items.map((i) => i.id));
  }, [items]);

  function patch(updated: ItemSummary) {
    setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
  }

  function remove(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  async function markRead(item: ItemSummary) {
    if (item.readAt) return;
    patch({ ...item, readAt: Date.now() });
    try {
      patch(await api.itemAction(item.id, 'read'));
      onChanged();
    } catch {
      patch(item);
    }
  }

  async function markUnread(item: ItemSummary) {
    if (!item.readAt) return;
    patch({ ...item, readAt: null });
    try {
      patch(await api.itemAction(item.id, 'unread'));
      onChanged();
    } catch {
      patch(item);
    }
  }

  /** Marks every loaded, unread item read, with an Undo that puts back exactly those. */
  async function markShownRead() {
    const ids = items.filter((i) => !i.readAt).map((i) => i.id);
    if (!ids.length) return;
    const before = items;
    const at = Date.now();
    setItems((prev) => prev.map((i) => (ids.includes(i.id) ? { ...i, readAt: at } : i)));
    try {
      await api.bulkRead({ ids, action: 'read' });
      onChanged();
      showToast(`Marked ${ids.length} read`, () => {
        setToast(null);
        setItems((prev) => prev.map((i) => (ids.includes(i.id) ? { ...i, readAt: null } : i)));
        api
          .bulkRead({ ids, action: 'unread' })
          .then(() => {
            onChanged();
            void load(false);
          })
          .catch(() => showToast('Could not undo'));
      });
      if (filters.view === 'unread') void load(false);
    } catch (err) {
      setItems(before);
      setError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  const readSide = getSwipeReadSide();
  // On an item already read, the read swipe flips to Mark unread.
  const readAction = (item: ItemSummary): SwipeAction =>
    item.readAt ? { run: markUnread, label: 'Mark unread', kind: 'read' } : { run: markRead, label: 'Mark read', kind: 'read' };
  const saveAction = (item: ItemSummary): SwipeAction => ({
    run: toggleSave,
    label: item.savedAt ? 'Remove from saved' : 'Save for later',
    kind: 'save',
  });

  async function toggleSave(item: ItemSummary) {
    const action = item.savedAt ? 'unsave' : 'save';
    patch({ ...item, savedAt: item.savedAt ? null : Date.now() });
    try {
      const updated = await api.itemAction(item.id, action);
      if (mode === 'saved' && !updated.savedAt) remove(item.id);
      else patch(updated);
      onChanged();
    } catch {
      patch(item);
    }
  }

  async function bulk(sourceId: string, action: 'read-all' | 'archive-all') {
    const name = sources.find((s) => s.id === sourceId)?.name ?? 'this source';
    if (action === 'archive-all' && !window.confirm(`Archive every inbox issue from ${name}?`)) return;
    try {
      await api.sourceBulk(sourceId, action);
      onChanged();
      void load(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  const total = listCounts
    ? listCounts.shown
    : mode === 'saved'
      ? counts.saved
      : mode === 'interesting'
        ? counts.interesting
        : filters.view === 'unread'
        ? counts.unread
        : filters.view === 'inbox'
          ? counts.inbox
          : null;
  // Header: unread and shown for what the filters pick out (filtered figures come with the list).
  const unreadShown = listCounts ? listCounts.unread : mode === 'inbox' && (filters.view === 'inbox' || filters.view === 'unread') ? counts.unread : null;
  const eyebrow =
    mode === 'saved'
      ? `${counts.saved} saved for later`
      : mode === 'interesting'
        ? `${counts.interesting} marked interesting`
        : unreadShown !== null && total !== null
        ? filters.view === 'unread'
          ? `${unreadShown} unread`
          : `${unreadShown} unread · ${total} shown`
        : todayLabel();
  const unreadLoaded = items.filter((i) => !i.readAt).length;

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles">
          <span className="topbar__eyebrow">{eyebrow}</span>
          <h1>{mode === 'inbox' ? 'Inbox' : 'Saved'}</h1>
        </div>
        <div className="topbar__actions">
          <DensityToggle />
          <button className="iconbtn" aria-label="Refresh" onClick={() => void load(false)}>
            <IconRefresh />
          </button>
          <Link to="/search" className="iconbtn" aria-label="Search" title="Search">
            <IconSearch />
          </Link>
          <Link to="/ask" className="iconbtn" aria-label="Ask the AI" title="Ask the AI">
            <IconSparkle />
          </Link>
          <Link to="/add" className="iconbtn iconbtn--primary" aria-label="Add a newsletter, feed or website">
            <IconPlus />
          </Link>
        </div>
      </header>
      {mode !== 'inbox' && <SavedTabs current={mode} />}

      <FilterBar
        filters={filters}
        onChange={setFilters}
        sources={sources}
        categorySources={filters.category && catSources?.category === filters.category ? catSources.ids : null}
        categories={categories}
        count={total}
        fixedView={mode !== 'inbox'}
        onBulk={bulk}
        saved={mode === 'inbox' ? (savedFilters ?? undefined) : undefined}
        onSaved={mode === 'inbox' && savedFilters ? (list) => void storeFilters(list) : undefined}
      />

      {mode === 'inbox' && counts.pendingSenders > 0 && (
        <Link to="/senders" className="notice notice--amber">
          <div className="notice__text">
            <span className="notice__title">
              {counts.pendingSenders} new sender{counts.pendingSenders === 1 ? '' : 's'} waiting
            </span>
            <span className="notice__sub">Nothing reaches the inbox until you allow it</span>
          </div>
          <span className="btn btn--small" style={{ background: 'var(--amber-ink)', color: '#fff', borderColor: 'transparent' }}>
            Review
          </span>
        </Link>
      )}

      {mode === 'inbox' && aiPaused && (
        <Link to="/settings/ai" className="notice notice--amber">
          <div className="notice__text">
            <span className="notice__title">AI summaries paused</span>
            <span className="notice__sub">{aiPaused}. Quick summaries carry on.</span>
          </div>
          <span className="btn btn--small">Check</span>
        </Link>
      )}

      {error && <div className="error">{error}</div>}

      <div className="list">
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            left={readSide === 'left' ? readAction(item) : saveAction(item)}
            right={readSide === 'right' ? readAction(item) : saveAction(item)}
          />
        ))}
      </div>

      {!loading && items.length === 0 && !error && (
        <div className="empty">
          {mode === 'saved' ? (
            <>
              <h2>Nothing saved yet</h2>
              <p>Swipe an item {readSide === 'right' ? 'left' : 'right'} in the inbox, or tap Save in the reader.</p>
            </>
          ) : mode === 'interesting' ? (
            <>
              <h2>Nothing starred yet</h2>
              <p>Tap the star in the reader when something was worth it. Stars help the Top sort and the digest learn what you value.</p>
            </>
          ) : filters.view === 'likely' && !filters.source && !filters.category ? (
            <>
              <h2>Nothing likely interesting yet</h2>
              <p>
                The PC helper picks out unread items close in meaning to the ones you starred as Interesting. It needs at least five
                stars and the helper running, and gets better with more.
              </p>
            </>
          ) : filters.view !== 'inbox' || filters.source || filters.category ? (
            <>
              <h2>Nothing here</h2>
              <p>Try a different filter.</p>
            </>
          ) : (
            <>
              <h2>Your inbox is empty</h2>
              <p>
                Create a sign-up address for a newsletter and paste it into the newsletter's form.
                {me.domain ? ` Anything sent to @${me.domain} lands here.` : ''}
              </p>
              <Link to="/add" className="btn btn--primary">
                <IconPlus size={18} /> Add a newsletter
              </Link>
            </>
          )}
        </div>
      )}

      {loading && <div className="spinner">Loading…</div>}
      {!loading && (cursor || (mode === 'inbox' && unreadLoaded > 1)) && (
        <div className="loadmore">
          {mode === 'inbox' && unreadLoaded > 1 && (
            <button className="btn" onClick={() => void markShownRead()}>
              Mark these {unreadLoaded} read
            </button>
          )}
          {cursor && (
            <button className="btn" onClick={() => void load(true)}>
              Load more
            </button>
          )}
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast.text}
          {toast.undo && (
            <button className="toast__undo" onClick={toast.undo}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
