import type { ItemSummary, Me, Source } from '@newsletterapp/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { Counts } from '../App';
import { FilterBar, type Filters } from '../components/FilterBar';
import { ItemRow } from '../components/ItemRow';
import { todayLabel } from '../format';
import { IconPlus, IconRefresh } from '../icons';

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
  const [filters, setFilters] = useState<Filters>({ view: mode === 'saved' ? 'saved' : 'inbox', sort: 'newest', source: null });
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);

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
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  useEffect(() => {
    api.sources().then(setSources).catch(() => undefined);
  }, []);

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

  const total = mode === 'saved' ? counts.saved : filters.view === 'unread' ? counts.unread : filters.view === 'inbox' ? counts.inbox : null;

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles">
          <span className="topbar__eyebrow">{mode === 'saved' ? `${counts.saved} saved for later` : todayLabel()}</span>
          <h1>{mode === 'saved' ? 'Saved' : 'Inbox'}</h1>
        </div>
        <div className="topbar__actions">
          <button className="iconbtn" aria-label="Refresh" onClick={() => void load(false)}>
            <IconRefresh />
          </button>
          <Link to="/add" className="iconbtn iconbtn--primary" aria-label="Add a newsletter">
            <IconPlus />
          </Link>
        </div>
      </header>

      <FilterBar filters={filters} onChange={setFilters} sources={sources} count={total} fixedView={mode === 'saved'} />

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

      {error && <div className="error">{error}</div>}

      <div className="list">
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            onSwipeLeft={markRead}
            onSwipeRight={toggleSave}
            rightLabel={item.savedAt ? 'Remove from saved' : 'Save for later'}
          />
        ))}
      </div>

      {!loading && items.length === 0 && !error && (
        <div className="empty">
          {mode === 'saved' ? (
            <>
              <h2>Nothing saved yet</h2>
              <p>Swipe an item right in the inbox, or tap Save in the reader.</p>
            </>
          ) : filters.view !== 'inbox' || filters.source ? (
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
