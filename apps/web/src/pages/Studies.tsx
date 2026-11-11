import type { LinkDetail, LinkSummary, StudyDetail, StudySummary } from '@newsletterapp/shared';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { agoText, shortTime } from '../format';
import { IconBack } from '../icons';
import { SavedTabs } from './Highlights';

// Studies: every study, report and survey the PC found cited in your
// articles, with how many articles cite each. A study page shows each
// article's sentence side by side, flags the ones that give different
// numbers, and asks about near-identical studies (Same / Different). The
// Links tab lists source pages two or more articles link to.

type Sort = 'cited' | 'recent';

export function StudiesPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'links' ? 'links' : 'studies';
  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles">
          <span className="topbar__eyebrow">What your articles cite</span>
          <h1>Studies</h1>
        </div>
      </header>
      <SavedTabs current="studies" />
      <div className="section">
        <div className="segmented" role="tablist">
          <button role="tab" aria-pressed={tab === 'studies'} aria-selected={tab === 'studies'} onClick={() => setParams({}, { replace: true })}>
            Studies
          </button>
          <button role="tab" aria-pressed={tab === 'links'} aria-selected={tab === 'links'} onClick={() => setParams({ tab: 'links' }, { replace: true })}>
            Most linked
          </button>
        </div>
      </div>
      {tab === 'studies' ? <StudyList /> : <LinkList />}
    </div>
  );
}

function StudyList() {
  const [sort, setSort] = useState<Sort>('cited');
  const [several, setSeveral] = useState(false);
  const [differs, setDiffers] = useState(false);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<StudySummary[]>([]);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    api
      .studies({ sort, min: several ? 2 : 1, q: query || undefined, differs, page })
      .then((r) => {
        if (mine !== seq.current) return;
        setRows((cur) => (page === 0 ? r.studies : [...cur, ...r.studies]));
        setMore(r.more);
        setError(null);
      })
      .catch((err: unknown) => mine === seq.current && setError(err instanceof Error ? err.message : 'Could not load studies'))
      .finally(() => mine === seq.current && setLoading(false));
  }, [sort, several, differs, query, page]);

  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    setPage(0);
    set(v);
  };

  return (
    <>
      <div className="section">
        <input className="input" type="search" placeholder="Search studies or who published them" value={q} onChange={(e) => reset(setQ)(e.target.value)} />
        <div className="pills">
          <button className="pill" aria-pressed={sort === 'cited'} onClick={() => reset(setSort)('cited')}>
            Most cited
          </button>
          <button className="pill" aria-pressed={sort === 'recent'} onClick={() => reset(setSort)('recent')}>
            Newest
          </button>
          <button className="pill" aria-pressed={several} onClick={() => reset(setSeveral)(!several)}>
            Cited by 2+ articles
          </button>
          <button className="pill" aria-pressed={differs} onClick={() => reset(setDiffers)(!differs)}>
            Quoted differently
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="section">
        {rows.length > 0 ? (
          <div className="card card--list">
            {rows.map((s) => (
              <Link key={s.id} className="cardrow" to={`/study/${s.id}`}>
                <div className="cardrow__main">
                  <span className="cardrow__title">{s.title}</span>
                  <span className="cardrow__sub">
                    {[s.publisher, s.year].filter(Boolean).join(', ')}
                    {s.publisher || s.year ? ' · ' : ''}
                    cited in {s.cites} article{s.cites === 1 ? '' : 's'} · {agoText(s.lastSeen)}
                  </span>
                </div>
                {s.differs && <span className="chip chip--warn">Differs</span>}
              </Link>
            ))}
          </div>
        ) : (
          !loading && (
            <p className="hint">
              {query || several || differs
                ? 'No studies match.'
                : 'No studies yet. Your PC collects them from each article it summarises while key sentences are on.'}
            </p>
          )
        )}
        {loading && <div className="spinner">Loading…</div>}
        {more && !loading && (
          <button className="btn btn--ghost" onClick={() => setPage((p) => p + 1)}>
            Show more
          </button>
        )}
      </div>
    </>
  );
}

function LinkList() {
  const [rows, setRows] = useState<LinkSummary[]>([]);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLoading(true);
    api
      .links(page)
      .then((r) => {
        setRows((cur) => (page === 0 ? r.links : [...cur, ...r.links]));
        setMore(r.more);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load links'))
      .finally(() => setLoading(false));
  }, [page]);
  return (
    <div className="section">
      <p className="hint">Source pages two or more of your articles link to. Links only one article uses stay out of the way.</p>
      {error && <div className="error">{error}</div>}
      {rows.length > 0 ? (
        <div className="card card--list">
          {rows.map((l) => (
            <Link key={l.id} className="cardrow" to={`/link/${l.id}`}>
              <div className="cardrow__main">
                <span className="cardrow__title">{l.title || l.url}</span>
                <span className="cardrow__sub">
                  {l.host} · linked from {l.cites} articles · {agoText(l.lastSeen)}
                </span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        !loading && <p className="hint">Nothing linked from two articles yet.</p>
      )}
      {loading && <div className="spinner">Loading…</div>}
      {more && !loading && (
        <button className="btn btn--ghost" onClick={() => setPage((p) => p + 1)}>
          Show more
        </button>
      )}
    </div>
  );
}

function BackBar({ title }: { title: string }) {
  const navigate = useNavigate();
  return (
    <header className="topbar">
      <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
          <IconBack />
        </button>
        <h1>{title}</h1>
      </div>
    </header>
  );
}

export function StudyPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [study, setStudy] = useState<StudyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (studyId: string) =>
    api
      .study(studyId)
      .then((s) => {
        setStudy(s);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the study'));
  useEffect(() => {
    setStudy(null);
    void load(id);
  }, [id]);

  async function answer(other: string, same: boolean) {
    setBusy(true);
    try {
      await api.sameStudy(id, other, same);
      await load(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that");
    } finally {
      setBusy(false);
    }
  }

  const byId = new Map(study?.citedBy.map((c) => [c.id, c]) ?? []);
  // Pairs that disagree, shown side by side at the top.
  const pairs = study?.citedBy.filter((c) => c.differsFrom && byId.has(c.differsFrom)).map((c) => [byId.get(c.differsFrom!)!, c] as const) ?? [];

  return (
    <div className="page">
      <BackBar title="Study" />
      {error && <div className="error">{error}</div>}
      {!study && !error && <div className="spinner">Loading…</div>}
      {study && (
        <>
          <div className="storypage__head">
            <h2>{study.title}</h2>
            <p className="hint">
              {[study.publisher, study.year].filter(Boolean).join(', ') || 'Publisher not named'} · cited in {study.cites} article
              {study.cites === 1 ? '' : 's'}
            </p>
            <div className="pills">
              {study.url && (
                <a className="pill" href={study.url} target="_blank" rel="noreferrer noopener">
                  Open the study
                </a>
              )}
              {study.doi && (
                <a className="pill" href={`https://doi.org/${study.doi}`} target="_blank" rel="noreferrer noopener">
                  DOI {study.doi}
                </a>
              )}
              {study.differs && <span className="chip chip--warn">Articles quote it differently</span>}
            </div>
          </div>

          {pairs.length > 0 && (
            <div className="section">
              <span className="label">Different numbers</span>
              {pairs.map(([a, b]) => (
                <div key={b.id} className="ksdiffer">
                  {[a, b].map((c) => (
                    <figure key={c.id}>
                      <blockquote className="hlquote">{c.quote}</blockquote>
                      <figcaption>
                        <Link to={`/item/${c.itemId}`}>{c.sourceName ?? c.subject}</Link>
                        {c.numbers.length > 0 && <span className="hint"> · {c.numbers.join(', ')}</span>}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              ))}
            </div>
          )}

          {study.maybe.length > 0 && (
            <div className="section">
              <span className="label">Maybe the same study</span>
              <div className="card card--list">
                {study.maybe.map((m) => (
                  <div key={m.id} className="cardrow">
                    <div className="cardrow__main">
                      <Link className="cardrow__title" to={`/study/${m.id}`}>
                        {m.title}
                      </Link>
                      <span className="cardrow__sub">
                        {[m.publisher, m.year].filter(Boolean).join(', ')}
                        {m.publisher || m.year ? ' · ' : ''}
                        {m.cites} article{m.cites === 1 ? '' : 's'}
                      </span>
                    </div>
                    <span className="inline">
                      <button className="btn btn--small" disabled={busy} onClick={() => void answer(m.id, true)}>
                        Same
                      </button>
                      <button className="btn btn--ghost btn--small" disabled={busy} onClick={() => void answer(m.id, false)}>
                        Different
                      </button>
                    </span>
                  </div>
                ))}
              </div>
              <p className="hint">Same joins them into one study, with all their articles.</p>
            </div>
          )}

          <div className="section">
            <span className="label">How each article cites it</span>
            {study.citedBy.length === 0 ? (
              <p className="hint">No articles cite it any more.</p>
            ) : (
              <div className="ksciting">
                {study.citedBy.map((c) => (
                  <div key={c.id} className={c.differsFrom ? 'ksciting__row ksciting__row--differs' : 'ksciting__row'}>
                    <button className="linkbtn ksciting__title" onClick={() => navigate(`/item/${c.itemId}`)}>
                      {c.subject}
                    </button>
                    <span className="hint">
                      {c.sourceName ? `${c.sourceName} · ` : ''}
                      {shortTime(c.receivedAt)}
                    </span>
                    <blockquote className="hlquote">{c.quote}</blockquote>
                    {c.claim && <p className="ksstudy__claim">{c.claim}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function LinkPage() {
  const { id = '' } = useParams();
  const [link, setLink] = useState<LinkDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLink(null);
    api
      .link(id)
      .then(setLink)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the link'));
  }, [id]);
  return (
    <div className="page">
      <BackBar title="Source link" />
      {error && <div className="error">{error}</div>}
      {!link && !error && <div className="spinner">Loading…</div>}
      {link && (
        <>
          <div className="storypage__head">
            <h2>{link.title || link.host}</h2>
            <p className="hint">
              {link.host} · linked from {link.cites} article{link.cites === 1 ? '' : 's'}
            </p>
            <div className="pills">
              <a className="pill" href={link.url} target="_blank" rel="noreferrer noopener">
                Open the page
              </a>
            </div>
          </div>
          <div className="section">
            <span className="label">Articles that link to it</span>
            <div className="card card--list">
              {link.items.map((i) => (
                <Link key={i.itemId} className="cardrow" to={`/item/${i.itemId}`}>
                  <div className="cardrow__main">
                    <span className="cardrow__title">{i.subject}</span>
                    <span className="cardrow__sub">
                      {i.sourceName ? `${i.sourceName} · ` : ''}
                      {shortTime(i.receivedAt)}
                      {i.text ? ` · “${i.text}”` : ''}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
