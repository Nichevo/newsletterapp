import type { SuggestLearnt, SuggestLearntPage } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { relativeTime } from '../format';
import { IconBack } from '../icons';

/** What Follow and Not interested have taught the suggestions, with a way to undo each part. */
export function SuggestedLearntPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState<SuggestLearntPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .suggestionsLearnt()
      .then(setPage)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  useEffect(() => {
    void load();
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t work');
    }
  };

  const more = page?.learnt.filter((l) => l.kind === 'topic' && l.net > 0) ?? [];
  const less = page?.learnt.filter((l) => l.kind === 'topic' && l.net < 0) ?? [];
  const sources = page?.learnt.filter((l) => l.kind === 'source') ?? [];

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span className="topbar__eyebrow">Suggested for you</span>
            <h1>Learnt from you</h1>
          </div>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      {!page && !error && <div className="spinner">Loading…</div>}
      {page && (
        <>
          <div className="section">
            <span className="hint" style={{ margin: 0 }}>
              Follow counts a site’s topics and the sources that linked to it up; Not interested counts its topics down a little. A site you follow but
              hardly open after three weeks counts as a soft no.
            </span>
          </div>
          <LearntList title="Topics you want more of" rows={more} onForget={(l) => act(() => api.suggestionsForget({ kind: l.kind, key: l.key }))} />
          <LearntList title="Topics you want less of" rows={less} onForget={(l) => act(() => api.suggestionsForget({ kind: l.kind, key: l.key }))} />
          <LearntList
            title="Sources whose links led you to follows"
            rows={sources}
            onForget={(l) => act(() => api.suggestionsForget({ kind: l.kind, key: l.key }))}
          />
          {more.length + less.length + sources.length === 0 && (
            <div className="section">
              <span className="hint">Nothing learnt yet. Follow a suggestion, or tap Not interested on one, and it shows up here.</span>
            </div>
          )}

          {page.followed.length > 0 && (
            <div className="section">
              <span className="label">How your follows are doing</span>
              <div className="card card--list">
                {page.followed.map((f) => (
                  <div key={f.site} className="cardrow" style={{ alignItems: 'flex-start' }}>
                    <div className="cardrow__main">
                      <Link to={`/source/${f.sourceId}`} className="cardrow__title">
                        {f.title}
                      </Link>
                      <span className="cardrow__sub">
                        Followed {relativeTime(f.followedAt)} · read {f.read} of {f.items}
                        {f.starred ? ` · ${f.starred} starred` : ''}
                      </span>
                      <span className={`cardrow__sub${f.verdict === 'not-opening' ? ' cardrow__flag' : ''}`}>
                        {f.ignored
                          ? 'Kept, and not teaching the suggestions'
                          : f.verdict === 'reading'
                            ? 'Reading it: more like this'
                            : f.verdict === 'not-opening'
                              ? 'Hardly opened: counts as a soft no'
                              : 'Too early to tell'}
                      </span>
                    </div>
                    <button className="btn btn--small btn--ghost" onClick={() => void act(() => api.suggestionIgnore(f.site, !f.ignored))}>
                      {f.ignored ? 'Learn from it' : 'Don’t learn from it'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {page.hidden.length > 0 && (
            <div className="section">
              <span className="label">Hidden sites ({page.hidden.length})</span>
              <div className="card card--list">
                {page.hidden.map((h) => (
                  <div key={h.site} className="cardrow">
                    <div className="cardrow__main">
                      <span className="cardrow__title">{h.title}</span>
                      <span className="cardrow__sub">
                        {h.site}
                        {h.decidedAt ? ` · hidden ${relativeTime(h.decidedAt)}` : ''}
                      </span>
                    </div>
                    <button className="btn btn--small btn--ghost" onClick={() => void act(() => api.suggestionUndo(h.site))}>
                      Show again
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {page.learnt.length > 0 && (
            <div className="section">
              <div className="inline">
                <button
                  className="btn btn--small btn--ghost"
                  onClick={() => {
                    if (window.confirm('Forget everything the suggestions have learnt? Hidden sites stay hidden.')) void act(() => api.suggestionsForget({ all: true }));
                  }}
                >
                  Forget everything learnt
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function strength(net: number): string {
  const a = Math.abs(net);
  return `${net > 0 ? '+' : '−'} ${a >= 3 ? 'strong' : a >= 1.5 ? 'medium' : 'light'}`;
}

function LearntList({ title, rows, onForget }: { title: string; rows: SuggestLearnt[]; onForget: (l: SuggestLearnt) => void }) {
  if (rows.length === 0) return null;
  return (
    <div className="section">
      <span className="label">{title}</span>
      <div className="card card--list">
        {rows.map((l) => (
          <div key={`${l.kind}:${l.key}`} className="cardrow">
            <div className="cardrow__main">
              <span className="cardrow__title">{l.label}</span>
            </div>
            <span className={`suggest__net ${l.net > 0 ? 'suggest__net--up' : 'suggest__net--down'}`}>{strength(l.net)}</span>
            <button className="iconbtn" aria-label={`Forget ${l.label}`} title="Forget this" onClick={() => onForget(l)}>
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
