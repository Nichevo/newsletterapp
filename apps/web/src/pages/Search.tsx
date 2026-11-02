import type { ItemSummary, SearchResponse, SearchState, Source } from '@newsletterapp/shared';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ItemRow, type SwipeAction } from '../components/ItemRow';
import { IconBack } from '../icons';
import { getSwipeReadSide } from '../prefs';
import { rememberList } from '../readingList';

// Search everything ever received: words in the subject, sender, preview, AI
// summary, key points and tags (a full-text index, ranked), narrowed by date,
// state, category and source. The query lives in the address, so Back from an
// article returns to the same results.

const DAY = 86_400_000;
const WHEN: { key: string; label: string; since: () => number }[] = [
  { key: '', label: 'Any time', since: () => 0 },
  { key: '7', label: '7 days', since: () => Date.now() - 7 * DAY },
  { key: '30', label: '30 days', since: () => Date.now() - 30 * DAY },
  { key: 'year', label: 'This year', since: () => new Date(new Date().getFullYear(), 0, 1).getTime() },
];
const STATES: { key: SearchState | ''; label: string }[] = [
  { key: '', label: 'Anything' },
  { key: 'unread', label: 'Unread' },
  { key: 'interesting', label: '★ Starred' },
  { key: 'saved', label: 'Saved' },
  { key: 'archived', label: 'Archived' },
];
const RECENT_KEY = 'search:recent';

function recentSearches(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
}

function remember(q: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...recentSearches().filter((x) => x !== q)].slice(0, 6)));
  } catch {
    // Not remembered on this device.
  }
}

export function SearchPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const when = params.get('when') ?? '';
  const state = (params.get('state') ?? '') as SearchState | '';
  const category = params.get('category') ?? '';
  const source = params.get('source') ?? '';
  const sort = params.get('sort') === 'newest' ? 'newest' : 'relevance';

  const [text, setText] = useState(q);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [recent, setRecent] = useState(recentSearches);
  const inputRef = useRef<HTMLInputElement>(null);
  const readSide = getSwipeReadSide();

  useEffect(() => {
    api.sources().then(setSources).catch(() => undefined);
    api
      .settings()
      .then((s) => setCategories(s.categories))
      .catch(() => undefined);
    if (!q) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setParam(key: string, value: string) {
    const nextParams = new URLSearchParams(params);
    if (value) nextParams.set(key, value);
    else nextParams.delete(key);
    setParams(nextParams, { replace: true });
  }

  // Typing settles for a moment before the search runs.
  useEffect(() => {
    if (text.trim() === q) return;
    const t = setTimeout(() => setParam('q', text.trim()), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const active = Boolean(q || state || category || source || when);
  const query = () => {
    const sp = new URLSearchParams();
    if (q) sp.set('q', q);
    if (state) sp.set('state', state);
    if (category) sp.set('category', category);
    if (source) sp.set('source', source);
    const since = WHEN.find((w) => w.key === when)?.since() ?? 0;
    if (since) sp.set('since', String(since));
    sp.set('sort', sort);
    return sp;
  };

  async function run(offset: number) {
    const sp = query();
    sp.set('offset', String(offset));
    setLoading(true);
    setError(null);
    try {
      const r: SearchResponse = await api.search(sp.toString());
      const all = offset === 0 ? r.items : [...items, ...r.items];
      setItems(all);
      if (r.total !== undefined) setTotal(r.total);
      setNext(r.nextOffset);
      rememberList(all.map((i) => i.id));
      if (offset === 0 && q && r.items.length) {
        remember(q);
        setRecent(recentSearches());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!active) {
      setItems([]);
      setTotal(null);
      setNext(null);
      return;
    }
    void run(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, when, state, category, source, sort]);

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

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <input
            ref={inputRef}
            className="input"
            type="search"
            enterKeyHint="search"
            placeholder="Search everything"
            aria-label="Search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && setParam('q', text.trim())}
            style={{ flex: 1 }}
          />
        </div>
      </header>

      <div className="section">
        <div className="pills">
          {WHEN.map((w) => (
            <button key={w.key} className="pill" aria-pressed={when === w.key} onClick={() => setParam('when', w.key)}>
              {w.label}
            </button>
          ))}
        </div>
        <div className="pills">
          {STATES.map((s) => (
            <button key={s.key} className="pill" aria-pressed={state === s.key} onClick={() => setParam('state', s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="inline">
          <select className="input" aria-label="Category" value={category} onChange={(e) => setParam('category', e.target.value)}>
            <option value="">Any category</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
          <select className="input" aria-label="Source" value={source} onChange={(e) => setParam('source', e.target.value)}>
            <option value="">Any source</option>
            {[...sources]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </div>
        {q && (
          <div className="pills">
            <button className="pill" aria-pressed={sort === 'relevance'} onClick={() => setParam('sort', '')}>
              Best match
            </button>
            <button className="pill" aria-pressed={sort === 'newest'} onClick={() => setParam('sort', 'newest')}>
              Newest
            </button>
          </div>
        )}
      </div>

      {!active && recent.length > 0 && (
        <div className="section">
          <span className="label">Recent searches</span>
          <div className="pills">
            {recent.map((r) => (
              <button
                key={r}
                className="pill"
                onClick={() => {
                  setText(r);
                  setParam('q', r);
                }}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      )}
      {!active && (
        <p className="hint" style={{ padding: '0 16px' }}>
          Searches subjects, senders, previews, AI summaries, key points and tags, including archived items. Words match their beginnings
          ("rate" finds "rates"); put words in quotes to find them together.
        </p>
      )}

      {error && <div className="error">{error}</div>}
      {active && total !== null && !loading && (
        <p className="hint" style={{ padding: '0 16px' }}>
          {total === 0 ? 'Nothing matches.' : `${total} match${total === 1 ? '' : 'es'}`}
        </p>
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
      {loading && <div className="spinner">Searching…</div>}
      {!loading && next !== null && (
        <div className="loadmore">
          <button className="btn" onClick={() => void run(next)}>
            More results
          </button>
        </div>
      )}
    </div>
  );
}
