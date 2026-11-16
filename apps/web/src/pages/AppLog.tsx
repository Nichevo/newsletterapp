import { PROBLEM_CATEGORIES, type AppLogEntry, type AppProblem, type ProblemAction, type ProblemCategory, type ProblemsView } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { relativeTime } from '../format';
import { IconBack, IconChevron } from '../icons';

// "Your app" on System status: problems inside the app itself (a source not
// coming through or gone quiet, a site turning the PC away, the PC helper
// offline or reporting errors), each with the log lines behind it, plus the
// whole log on its own page (/status/log).

function clock(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

const ORIGIN: Record<AppLogEntry['origin'], string> = { pc: 'PC', cloud: 'Cloudflare' };

export function LogLines({ lines }: { lines: AppLogEntry[] }) {
  if (!lines.length) return <span className="hint" style={{ margin: 0 }}>Nothing logged for this yet. The log started on 17 Nov, so older failures only show their latest error (above).</span>;
  return (
    <ul className="plog">
      {lines.map((l) => (
        <li key={l.id} className={`plog__line plog__line--${l.level}`}>
          <span className="plog__meta">
            {clock(l.at)} · {ORIGIN[l.origin] ?? l.origin} · {l.area}
            {l.count > 1 ? ` · ×${l.count}` : ''}
          </span>
          <span className="plog__msg">{l.message}</span>
        </li>
      ))}
    </ul>
  );
}

function problemMeta(p: AppProblem): string {
  const bits: string[] = [];
  if (p.kind === 'site_resting' && p.until) bits.push(`tries again ${clock(p.until)}`);
  if (p.kind === 'source_failing') {
    if (p.count) bits.push(`${p.count} failed checks in a row`);
    bits.push(p.lastOkAt ? `last worked ${relativeTime(p.lastOkAt)}` : 'never worked yet');
  }
  if (p.kind === 'source_silent') bits.push(p.lastItemAt ? `last post ${relativeTime(p.lastItemAt)}` : 'no posts yet');
  if (p.kind === 'source_unchecked' && p.since) bits.push(`last checked ${relativeTime(p.since)}`);
  if (p.kind === 'article_failures' && p.count) bits.push(`${p.count} this week`);
  if (p.kind === 'helper_offline' && p.since) bits.push(`last heard from ${relativeTime(p.since)}`);
  return bits.join(' · ');
}

function logLink(p: AppProblem): string {
  if (p.kind === 'article_failures' && p.site) return `/status/log?site=${encodeURIComponent(p.site)}`;
  if (p.sourceId) return `/status/log?source=${encodeURIComponent(p.sourceId)}`;
  if (p.site) return `/status/log?site=${encodeURIComponent(p.site)}`;
  if (p.kind === 'helper_errors') return '/status/log?origin=pc&level=error';
  return '/status/log?origin=pc';
}

/** One problem: a single summary line; tap for what to do, the buttons and the log. */
function ProblemRow({ p, onHide, onChanged }: { p: AppProblem; onHide: (hidden: boolean) => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);

  async function act(a: ProblemAction) {
    setBusy(true);
    setNote(null);
    try {
      if (a.checkSourceId) {
        const r = await api.checkSource(a.checkSourceId);
        setNote(r.waitingForPc ? 'Asked your PC to check it. Look again in a few minutes.' : r.source.lastError ? `Still failing: ${r.source.lastError}` : `Worked: ${r.added} new.`);
      } else if (a.pcSourceId) {
        await api.updateSource(a.pcSourceId, { fetchVia: 'pc' });
        await api.checkSource(a.pcSourceId);
        setNote('Your PC fetches it now. Look again in a few minutes.');
      }
      onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not do that');
    } finally {
      setBusy(false);
    }
  }

  const meta = problemMeta(p);
  return (
    <div className={`prow ${p.hidden ? 'prow--hidden' : ''}`}>
      <button className="prow__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`sdot sdot--${p.hidden ? 'off' : p.level}`} aria-hidden="true" />
        <span className="prow__text">
          <span className="prow__title">{p.title}</span>
          <span className="prow__cause">
            {p.cause}
            {meta ? ` · ${meta}` : ''}
          </span>
        </span>
        <IconChevron size={16} />
      </button>
      {open && (
        <div className="prow__body">
          <span className="prow__detail">{p.detail}</span>
          <span className="label" style={{ marginTop: 4 }}>
            What to do
          </span>
          <ol className="prow__fix">
            {p.fix.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ol>
          <div className="pcard__actions">
            {p.actions.map((a) =>
              a.to ? (
                <Link key={a.label} to={a.to} className="btn btn--small">
                  {a.label}
                </Link>
              ) : (
                <button key={a.label} className="btn btn--small" disabled={busy} onClick={() => void act(a)}>
                  {a.label}
                </button>
              ),
            )}
            <button className="btn btn--small" onClick={() => onHide(!p.hidden)}>
              {p.hidden ? 'Show again' : 'Hide until it clears'}
            </button>
          </div>
          {note && <span className="hint" style={{ margin: 0 }}>{note}</span>}
          <button className="quick__toggle" style={{ justifySelf: 'start' }} aria-expanded={showLog} onClick={() => setShowLog(!showLog)}>
            {showLog ? 'Hide the log' : `Log (${p.log.length ? `${p.log.length} recent line${p.log.length === 1 ? '' : 's'}` : 'none yet'})`}
          </button>
          {showLog && (
            <>
              <LogLines lines={p.log} />
              <Link to={logLink(p)} className="hint" style={{ margin: 0 }}>
                Full log ›
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** One group of problems (e.g. Sources not coming through): a count and a line, opening to its rows. */
function CategoryCard({ id, list, onHide, onChanged }: { id: ProblemCategory; list: AppProblem[]; onHide: (key: string, hidden: boolean) => void; onChanged: () => void }) {
  const cat = PROBLEM_CATEGORIES.find((c) => c.id === id)!;
  const shown = list.filter((p) => !p.hidden);
  const level = shown.some((p) => p.level === 'major') ? 'major' : shown.length ? 'minor' : 'off';
  const [open, setOpen] = useState(level === 'major');
  // The causes in this group, most common first: "2 refuse readers, 1 address gone".
  const causes = [...shown.reduce((m, p) => m.set(p.cause, (m.get(p.cause) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => (n > 1 ? `${n}× ${c}` : c))
    .join(' · ');
  return (
    <section className={`card pcat ${level === 'major' ? 'sinc--major' : ''}`}>
      <button className="pcard__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`sdot sdot--${level}`} aria-hidden="true" />
        <span className="prow__text">
          <span className="sinc__title">
            {cat.title} <span className="pcat__n">{shown.length || list.length}</span>
          </span>
          <span className="prow__cause">{shown.length ? causes : `${list.length} hidden`}</span>
        </span>
        <IconChevron size={16} />
      </button>
      {open && (
        <>
          <span className="hint" style={{ margin: 0 }}>{cat.blurb}</span>
          <div className="pcat__rows">
            {list.map((p) => (
              <ProblemRow key={p.key} p={p} onHide={(h) => onHide(p.key, h)} onChanged={onChanged} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** The "Your app" section at the top of System status: problems grouped by kind, with what to do. */
export function AppProblemsSection({ onChanged }: { onChanged: () => void }) {
  const [view, setView] = useState<ProblemsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .problems()
      .then((v) => {
        setView(v);
        onChanged();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function hide(key: string, hidden: boolean) {
    try {
      setView(await api.hideProblem(key, hidden));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  const shown = view?.problems.filter((p) => !p.hidden) ?? [];
  const level = shown.some((p) => p.level === 'major') ? 'major' : shown.length ? 'minor' : 'ok';
  const groups = PROBLEM_CATEGORIES.map((c) => ({ id: c.id, title: c.title, short: c.short, list: view?.problems.filter((p) => p.category === c.id) ?? [] })).filter((g) => g.list.length);
  const line = groups
    .map((g) => ({ g, n: g.list.filter((p) => !p.hidden).length }))
    .filter((x) => x.n)
    .map((x) => `${x.n} ${x.g.short}`)
    .join(' · ');

  return (
    <div className="section">
      <span className="label">Your app</span>
      {error && <div className="error">{error}</div>}
      {!view && !error && <div className="spinner">Checking…</div>}
      {view && (
        <div style={{ display: 'grid', gap: 10 }}>
          <div className={`ssum ssum--${level}`} style={{ margin: 0 }}>
            <span className={`sdot sdot--${level}`} aria-hidden="true" />
            <span className="prow__text">
              <span>{shown.length === 0 ? 'Everything is coming through' : `${shown.length} thing${shown.length === 1 ? '' : 's'} to look at`}</span>
              {line && <span className="ssum__line">{line}</span>}
            </span>
            <Link to="/status/log" className="ssum__sub plink">
              Log ›
            </Link>
          </div>
          {groups.map((g) => (
            <CategoryCard key={g.id} id={g.id} list={g.list} onHide={(k, h) => void hide(k, h)} onChanged={() => void load()} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The whole log: /status/log, with filters (and ?source= or ?site= from a problem). */
export function AppLogPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const level = params.get('level') ?? '';
  const origin = params.get('origin') ?? '';
  const source = params.get('source') ?? '';
  const site = params.get('site') ?? '';
  const [lines, setLines] = useState<AppLogEntry[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .appLog({ level, origin, source, site })
      .then((v) => {
        setLines(v.entries);
        setBefore(v.before);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'))
      .finally(() => setLoading(false));
  }, [level, origin, source, site]);

  async function more() {
    if (!before) return;
    setLoading(true);
    try {
      const v = await api.appLog({ level, origin, source, site, before });
      setLines((l) => [...l, ...v.entries]);
      setBefore(v.before);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load');
    } finally {
      setLoading(false);
    }
  }

  function set(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>App log</h1>
        </div>
      </header>
      <div className="section" style={{ display: 'grid', gap: 8 }}>
        <div className="segmented" role="group" aria-label="Which lines">
          <button aria-pressed={level === ''} onClick={() => set('level', '')}>
            Everything
          </button>
          <button aria-pressed={level === 'warn'} onClick={() => set('level', 'warn')}>
            Warnings
          </button>
          <button aria-pressed={level === 'error'} onClick={() => set('level', 'error')}>
            Errors
          </button>
        </div>
        <div className="segmented" role="group" aria-label="From where">
          <button aria-pressed={origin === ''} onClick={() => set('origin', '')}>
            Both
          </button>
          <button aria-pressed={origin === 'pc'} onClick={() => set('origin', 'pc')}>
            PC helper
          </button>
          <button aria-pressed={origin === 'cloud'} onClick={() => set('origin', 'cloud')}>
            Cloudflare
          </button>
        </div>
        {(source || site) && (
          <div className="pcard__actions">
            <span className="hint" style={{ margin: 0 }}>Only {source ? 'one source' : site}</span>
            {source && (
              <Link to={`/source/${source}`} className="btn btn--small">
                Open source
              </Link>
            )}
            <button
              className="btn btn--small"
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete('source');
                next.delete('site');
                setParams(next, { replace: true });
              }}
            >
              Show all
            </button>
          </div>
        )}
        <span className="hint" style={{ margin: 0 }}>
          Warnings and errors from the PC helper (sent each time it checks in) and from Cloudflare's feed checks, kept for 14 days.
        </span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="section">
        <section className="card">
          {loading && lines.length === 0 ? <div className="spinner">Loading…</div> : <LogLines lines={lines} />}
        </section>
        {before && (
          <button className="btn btn--small" style={{ margin: '10px 16px 0' }} disabled={loading} onClick={() => void more()}>
            {loading ? 'Loading…' : 'Older lines'}
          </button>
        )}
      </div>
    </div>
  );
}
