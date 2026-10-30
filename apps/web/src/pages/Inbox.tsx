import type { ItemKind, ItemSummary, ItemView, Me, Source } from '@newsletterapp/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { rememberList } from '../readingList';
import { api } from '../api';
import type { Counts } from '../App';
import { DensityToggle } from '../components/DensityToggle';
import { FilterBar, type Filters } from '../components/FilterBar';
import { ItemRow, type SwipeAction } from '../components/ItemRow';
import { getSwipeReadSide } from '../prefs';
import { todayLabel } from '../format';
import { IconPlus, IconRefresh } from '../icons';

const VIEWS: ItemView[] = ['inbox', 'unread', 'saved', 'archived'];
const KINDS: ItemKind[] = ['newsletter', 'feed', 'site'];

/** The filter bar choices are remembered per screen on this device. */
function storageKey(mode: 'inbox' | 'saved') {
  return `filters:${mode}`;
}

function loadFilters(mode: 'inbox' | 'saved'): Filters {
  const fallback: Filters = { view: mode === 'saved' ? 'saved' : 'inbox', sort: 'newest', source: null, category: null, kind: null };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(mode)) ?? 'null') as Partial<Filters> | null;
    if (!saved) return fallback;
    return {
      view: mode === 'saved' ? 'saved' : VIEWS.includes(saved.view as ItemView) ? (saved.view as ItemView) : fallback.view,
      sort: saved.sort === 'oldest' || saved.sort === 'top' ? saved.sort : 'newest',
      source: typeof saved.source === 'string' ? saved.source : null,
      category: typeof saved.category === 'string' ? saved.category : null,
      kind: KINDS.includes(saved.kind as ItemKind) ? (saved.kind as ItemKind) : null,
    };
  } catch {
    return fallback;
  }
}

function saveFilters(mode: 'inbox' | 'saved', filters: Filters) {
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
  mode: 'inbox' | 'saved';
  me: Me;
  counts: Counts;
  onChanged: () => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => {
    // A link like /?source=<id> (from Settings) opens the inbox on that source.
    const linked = searchParams.get('source');
    const stored = loadFilters(mode);
    return linked ? { ...stored, view: mode === 'saved' ? 'saved' : 'inbox', source: linked, category: null, kind: null } : stored;
  });
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [aiPaused, setAiPaused] = useState<string | null>(null);

  const load = useCallback(
    async (append: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.listItems({ ...filters, cursor: append ? cursor : null });
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        setCursor(res.nextCursor);
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
      .then((s) => setCategories(s.categories))
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

  const readSide = getSwipeReadSide();
  const readAction: SwipeAction = { run: markRead, label: 'Mark read', kind: 'read' };
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

  const total = mode === 'saved' ? counts.saved : filters.view === 'unread' ? counts.unread : filters.view === 'inbox' ? counts.inbox : null;

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles">
          <span className="topbar__eyebrow">{mode === 'saved' ? `${counts.saved} saved for later` : todayLabel()}</span>
          <h1>{mode === 'saved' ? 'Saved' : 'Inbox'}</h1>
        </div>
        <div className="topbar__actions">
          <DensityToggle />
          <button className="iconbtn" aria-label="Refresh" onClick={() => void load(false)}>
            <IconRefresh />
          </button>
          <Link to="/add" className="iconbtn iconbtn--primary" aria-label="Add a newsletter, feed or website">
            <IconPlus />
          </Link>
        </div>
      </header>

      <FilterBar
        filters={filters}
        onChange={setFilters}
        sources={sources}
        categories={categories}
        count={total}
        fixedView={mode === 'saved'}
        onBulk={bulk}
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
            left={readSide === 'left' ? readAction : saveAction(item)}
            right={readSide === 'right' ? readAction : saveAction(item)}
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
      {!loading && cursor && (
        <div className="loadmore">
          <button className="btn" onClick={() => void load(true)}>
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
