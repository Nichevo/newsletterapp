import type { TagList } from '@newsletterapp/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { TagChip } from '../components/TagChip';
import { IconBack } from '../icons';

// Every AI tag in one place, so a tag's page can be reached without first
// finding an article that carries it. One request per period (cached on the
// Worker); searching and sorting happen here in the app.

const PERIODS = [
  { days: 0, label: 'All time' },
  { days: 90, label: '90 days' },
  { days: 30, label: '30 days' },
  { days: 7, label: '7 days' },
] as const;

const SHOW_STEP = 300;

export function TagsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const days = PERIODS.find((p) => String(p.days) === params.get('days'))?.days ?? 0;
  const sort = params.get('sort') === 'az' ? 'az' : 'count';
  const [text, setText] = useState(params.get('q') ?? '');
  const [list, setList] = useState<TagList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(SHOW_STEP);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  useEffect(() => {
    let gone = false;
    setError(null);
    api
      .tags(days)
      .then((l) => !gone && setList(l))
      .catch((err: unknown) => !gone && setError(err instanceof Error ? err.message : 'Could not load the tags'));
    return () => {
      gone = true;
    };
  }, [days]);

  // Keep the search in the address so Back from a tag page lands on the same list.
  useEffect(() => {
    const t = setTimeout(() => setParam('q', text.trim()), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  useEffect(() => setShown(SHOW_STEP), [days, sort, text]);

  const tags = useMemo(() => {
    const q = text.trim().toLowerCase();
    const all = (list?.tags ?? []).filter((t) => !q || t.tag.includes(q));
    return all.sort((a, b) =>
      sort === 'az' ? a.tag.localeCompare(b.tag) : b.n - a.n || a.tag.localeCompare(b.tag),
    );
  }, [list, text, sort]);

  const loading = !list || list.days !== days;

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <input
            className="input"
            type="search"
            enterKeyHint="search"
            placeholder="Find a tag"
            aria-label="Find a tag"
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ flex: 1 }}
          />
        </div>
      </header>

      <div className="section">
        <div className="pills">
          {PERIODS.map((p) => (
            <button key={p.days} className="pill" aria-pressed={days === p.days} onClick={() => setParam('days', p.days ? String(p.days) : '')}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="pills">
          <button className="pill" aria-pressed={sort === 'count'} onClick={() => setParam('sort', '')}>
            Most items
          </button>
          <button className="pill" aria-pressed={sort === 'az'} onClick={() => setParam('sort', 'az')}>
            A to Z
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && !error && <div className="spinner">Loading…</div>}
      {!loading && (
        <div className="section">
          <span className="label">
            {tags.length} tag{tags.length === 1 ? '' : 's'}
            {days ? ` in the last ${days} days` : ''}
          </span>
          {tags.length === 0 ? (
            <p className="hint">
              {text.trim() ? 'No tag matches that.' : 'No tags yet. The AI adds them when it summarises an item.'}
            </p>
          ) : (
            <div className="row__tags">
              {tags.slice(0, shown).map((t) => (
                <TagChip key={t.tag} tag={t.label} count={t.n} />
              ))}
            </div>
          )}
          {tags.length > shown && (
            <div className="loadmore">
              <button className="btn" onClick={() => setShown((n) => n + SHOW_STEP)}>
                Show more ({tags.length - shown} left)
              </button>
            </div>
          )}
          <p className="hint">
            Counts may be up to 10 minutes behind. To see how tags link to your sources, open the{' '}
            <Link to="/stats/topics">Topics map</Link>.
          </p>
        </div>
      )}
    </div>
  );
}
