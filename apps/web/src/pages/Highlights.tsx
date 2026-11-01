import type { HighlightList, HighlightListQuery, HighlightListRow } from '@newsletterapp/shared';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { shortTime } from '../format';
import { IconSparkle } from '../icons';

// Saved > Highlights: every highlight, newest first. Search the highlighted
// words (and the article titles), filter by just-highlighted or asked, by
// source or category, and tap one to open the article scrolled to it.

type Kind = '' | 'asked' | 'plain';
const KIND_LABEL: Record<Kind, string> = { '': 'All', asked: 'Asked the AI', plain: 'Just highlighted' };

/** The Saved | Highlights switch at the top of both pages. */
export function SavedTabs({ current }: { current: 'saved' | 'interesting' | 'highlights' }) {
  return (
    <div className="tabs" role="tablist" aria-label="Saved">
      <Link to="/saved" className="pill" role="tab" aria-selected={current === 'saved'} aria-pressed={current === 'saved'}>
        Saved
      </Link>
      <Link
        to="/saved/interesting"
        className="pill"
        role="tab"
        aria-selected={current === 'interesting'}
        aria-pressed={current === 'interesting'}
      >
        Interesting
      </Link>
      <Link
        to="/saved/highlights"
        className="pill"
        role="tab"
        aria-selected={current === 'highlights'}
        aria-pressed={current === 'highlights'}
      >
        Highlights
      </Link>
    </div>
  );
}

export function HighlightsPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState<HighlightListQuery>({});
  const [rows, setRows] = useState<HighlightListRow[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [choices, setChoices] = useState<Pick<HighlightList, 'sources' | 'categories'>>({ sources: [], categories: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const t = window.setTimeout(() => setQuery((cur) => (cur.q === q.trim() ? cur : { ...cur, q: q.trim() || undefined })), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    api
      .highlightList(query)
      .then((r) => {
        if (mine !== seq.current) return;
        setRows(r.highlights);
        setNext(r.next);
        if (r.sources.length || r.categories.length) setChoices({ sources: r.sources, categories: r.categories });
        setError(null);
      })
      .catch((err: unknown) => mine === seq.current && setError(err instanceof Error ? err.message : 'Could not load'))
      .finally(() => mine === seq.current && setLoading(false));
  }, [query]);

  async function more() {
    if (next === null) return;
    setLoading(true);
    try {
      const r = await api.highlightList({ ...query, before: next });
      setRows((cur) => [...cur, ...r.highlights]);
      setNext(r.next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load');
    } finally {
      setLoading(false);
    }
  }

  async function remove(h: HighlightListRow) {
    const notes = h.asks.length ? ` and its ${h.asks.length === 1 ? 'note' : `${h.asks.length} notes`}` : '';
    if (!window.confirm(`Remove this highlight${notes}?`)) return;
    setRows((cur) => cur.filter((x) => x.id !== h.id));
    await api.deleteHighlight(h.id).catch(() => setError('Could not remove it'));
  }

  const kind = (query.kind ?? '') as Kind;
  const filtered = Boolean(query.q || query.kind || query.sourceId || query.category);

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles">
          <span className="topbar__eyebrow">Everything you've highlighted</span>
          <h1>Highlights</h1>
        </div>
      </header>
      <SavedTabs current="highlights" />

      <div className="section" style={{ gap: 8 }}>
        <input
          className="input"
          type="search"
          placeholder="Search highlights and article titles…"
          aria-label="Search highlights"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="pills">
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <button key={k || 'all'} className="pill" aria-pressed={kind === k} onClick={() => setQuery({ ...query, kind: k || undefined })}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        {(choices.sources.length > 1 || choices.categories.length > 1) && (
          <div className="inline" style={{ gap: 8, flexWrap: 'wrap' }}>
            {choices.sources.length > 1 && (
              <select
                className="input"
                style={{ flex: '1 1 150px' }}
                aria-label="Source"
                value={query.sourceId ?? ''}
                onChange={(e) => setQuery({ ...query, sourceId: e.target.value || undefined })}
              >
                <option value="">All sources</option>
                {choices.sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.count})
                  </option>
                ))}
              </select>
            )}
            {choices.categories.length > 1 && (
              <select
                className="input"
                style={{ flex: '1 1 120px' }}
                aria-label="Category"
                value={query.category ?? ''}
                onChange={(e) => setQuery({ ...query, category: e.target.value || undefined })}
              >
                <option value="">All categories</option>
                {choices.categories.map((c) => (
                  <option key={c.category} value={c.category}>
                    {c.category} ({c.count})
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      <div className="section" style={{ gap: 10 }}>
        {rows.map((h) => (
          <article key={h.id} className="card hlcard">
            <button className="hlcard__open" onClick={() => navigate(`/item/${h.itemId}?hl=${encodeURIComponent(h.id)}`)}>
              <blockquote className="hlcard__quote">
                <mark>{h.quote}</mark>
              </blockquote>
              <span className="cardrow__title">{h.itemTitle}</span>
              <span className="cardrow__sub">
                {[h.sourceName, h.category, shortTime(h.createdAt)].filter(Boolean).join(' · ')}
              </span>
            </button>
            <div className="hlcard__foot">
              {h.asks.length > 0 ? (
                <span className="hlcard__asks">
                  <IconSparkle size={14} /> {h.asks.join(', ')}
                </span>
              ) : (
                <span className="cardrow__sub">Highlight only</span>
              )}
              <button className="btn btn--ghost btn--small" onClick={() => void remove(h)}>
                Remove
              </button>
            </div>
          </article>
        ))}
        {next !== null && (
          <button className="btn btn--ghost" disabled={loading} onClick={() => void more()}>
            {loading ? 'Loading…' : 'Show more'}
          </button>
        )}
      </div>

      {loading && rows.length === 0 && <div className="spinner">Loading…</div>}
      {!loading && rows.length === 0 && !error && (
        <div className="empty">
          {filtered ? (
            <>
              <h2>No highlights match</h2>
              <p>Try other words or clear the filters.</p>
            </>
          ) : (
            <>
              <h2>No highlights yet</h2>
              <p>Select some words in any article, then tap Highlight, or pick a prompt to ask the AI about them.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
