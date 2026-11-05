import type { ItemSummary, TagPage } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { BarChart, shortDate } from '../components/BarChart';
import { ItemRow, type SwipeAction } from '../components/ItemRow';
import { TagChip } from '../components/TagChip';
import { IconBack } from '../icons';
import { agoText } from '../format';
import { getSwipeReadSide } from '../prefs';
import { rememberList } from '../readingList';

// One AI tag: how many items carry it, how that's moved week by week, the tags
// it turns up with, who writes about it, and the items themselves, newest first.

export function TagPagePage() {
  const navigate = useNavigate();
  const params = useParams();
  const name = decodeURIComponent(params['*'] ?? '').trim();
  const [view, setView] = useState<'all' | 'unread'>('all');
  const [page, setPage] = useState<TagPage | null>(null);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readSide = getSwipeReadSide();

  useEffect(() => {
    if (!name) return;
    let gone = false;
    setLoading(true);
    setError(null);
    api
      .tag(name, view)
      .then((p) => {
        if (gone) return;
        setPage(p);
        setItems(p.items);
        setNext(p.nextOffset);
        rememberList(p.items.map((i) => i.id));
      })
      .catch((err: unknown) => !gone && setError(err instanceof Error ? err.message : 'Could not load'))
      .finally(() => !gone && setLoading(false));
    return () => {
      gone = true;
    };
  }, [name, view]);

  async function more() {
    if (next === null) return;
    setLoading(true);
    try {
      const p = await api.tag(name, view, next);
      const all = [...items, ...p.items];
      setItems(all);
      setNext(p.nextOffset);
      rememberList(all.map((i) => i.id));
    } catch {
      // The button stays for another go.
    } finally {
      setLoading(false);
    }
  }

  function patch(updated: ItemSummary) {
    setItems((list) => list.map((i) => (i.id === updated.id ? updated : i)));
  }
  async function toggle(item: ItemSummary, on: 'read' | 'save') {
    const action = on === 'read' ? (item.readAt ? 'unread' : 'read') : item.savedAt ? 'unsave' : 'save';
    try {
      patch(await api.itemAction(item.id, action));
    } catch {
      // Left as it was.
    }
  }
  const readAction = (item: ItemSummary): SwipeAction => ({
    run: (i) => toggle(i, 'read'),
    label: item.readAt ? 'Mark unread' : 'Mark read',
    kind: 'read',
  });
  const saveAction = (item: ItemSummary): SwipeAction => ({
    run: (i) => toggle(i, 'save'),
    label: item.savedAt ? 'Remove from saved' : 'Save for later',
    kind: 'save',
  });

  const weeks = page?.weeks.map((w) => ({ ...w, at: w.start })) ?? [];

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{page?.label ?? name}</h1>
        </div>
        {page && (
          <Link className="btn btn--small" to={`/stats/topics?tag=${encodeURIComponent(page.tag)}`}>
            See on map
          </Link>
        )}
      </header>

      {error && <div className="error">{error}</div>}
      {!page && !error && <div className="spinner">Loading…</div>}
      {page && (
        <>
          <div className="section">
            <div className="statgrid">
              <div className="stat">
                <span className="label">Items</span>
                <strong>{page.total}</strong>
              </div>
              <div className="stat">
                <span className="label">Unread</span>
                <strong>{page.unread}</strong>
              </div>
              <div className="stat">
                <span className="label">Sources</span>
                <strong>{page.sources.length}</strong>
              </div>
              <div className="stat">
                <span className="label">First seen</span>
                <strong>{page.firstAt ? shortDate(page.firstAt) : '–'}</strong>
              </div>
            </div>
            {page.total > 0 && (
              <BarChart
                points={weeks}
                value={(w) => w.n}
                unit="items"
                summary={`${weeks.reduce((a, w) => a + w.n, 0)} in the last ${weeks.length} weeks`}
                describe={(w) => `Week from ${shortDate(w.start)}: ${w.n} item${w.n === 1 ? '' : 's'}`}
                tick={(w, i) => (i % 2 === 0 ? shortDate(w.start) : null)}
                label={`Items tagged ${page.label} per week`}
              />
            )}
          </div>
          {(page.stories?.length ?? 0) > 0 && (
            <div className="section">
              <span className="label">Stories in this tag</span>
              <div className="card card--list">
                {page.stories!.map((st) => (
                  <Link key={st.id} className="cardrow" to={`/story/${st.id}`}>
                    <div className="cardrow__main">
                      <span className="cardrow__title">{st.title}</span>
                      <span className="cardrow__sub">
                        {st.items} items · updated {agoText(st.lastAt)}
                        {st.unread > 0 ? ` · ${st.unread} unread` : ' · all read'}
                        {st.followedAt ? ' · following' : ''}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
          {page.seenWith.length > 0 && (
            <div className="section">
              <span className="label">Often seen with</span>
              <div className="row__tags">
                {page.seenWith.map((t) => (
                  <TagChip key={t.tag} tag={t.label} count={t.n} />
                ))}
              </div>
            </div>
          )}
          {page.sources.length > 0 && (
            <div className="section">
              <span className="label">From</span>
              <div className="row__tags">
                {page.sources.map((s) =>
                  s.id ? (
                    <Link key={s.id} className="chip chip--outline" to={`/source/${s.id}`}>
                      {s.name}&nbsp;<span className="chip__n">{s.n}</span>
                    </Link>
                  ) : (
                    <span key={s.name} className="chip chip--outline">
                      {s.name}&nbsp;<span className="chip__n">{s.n}</span>
                    </span>
                  ),
                )}
              </div>
            </div>
          )}
          <div className="section">
            <div className="pills">
              <button className="pill" aria-pressed={view === 'all'} onClick={() => setView('all')}>
                All {page.total}
              </button>
              <button className="pill" aria-pressed={view === 'unread'} onClick={() => setView('unread')}>
                Unread {page.unread}
              </button>
            </div>
          </div>
        </>
      )}

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
      {page && !loading && items.length === 0 && (
        <p className="hint" style={{ padding: '0 16px' }}>
          {view === 'unread' ? 'Nothing unread with this tag.' : 'Nothing has this tag yet.'}
        </p>
      )}
      {loading && page && <div className="spinner">Loading…</div>}
      {!loading && next !== null && (
        <div className="loadmore">
          <button className="btn" onClick={() => void more()}>
            More
          </button>
        </div>
      )}
    </div>
  );
}
