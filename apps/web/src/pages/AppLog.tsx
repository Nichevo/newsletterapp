import type { AppLogEntry, AppProblem, ProblemsView } from '@newsletterapp/shared';
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
  if (!lines.length) return <span className="hint" style={{ margin: 0 }}>No log lines for this yet.</span>;
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
  if (p.kind === 'site_resting' && p.until) bits.push(`Tries again ${clock(p.until)}`);
  if (p.kind === 'source_failing' && p.count) bits.push(`${p.count} checks failed in a row`);
  if (p.kind === 'helper_offline' && p.since) bits.push(`Last heard from ${relativeTime(p.since)}`);
  if (p.kind.startsWith('source_')) {
    bits.push(p.lastOkAt ? `last good check ${relativeTime(p.lastOkAt)}` : 'never checked fine');
    bits.push(p.lastItemAt ? `newest post ${relativeTime(p.lastItemAt)}` : 'no posts yet');
  }
  return bits.join(' · ');
}

function logLink(p: AppProblem): string {
  if (p.sourceId) return `/status/log?source=${encodeURIComponent(p.sourceId)}`;
  if (p.site) return `/status/log?site=${encodeURIComponent(p.site)}`;
  if (p.kind === 'helper_errors') return '/status/log?origin=pc&level=error';
  return '/status/log?origin=pc';
}

function ProblemCard({ p, onHide }: { p: AppProblem; onHide: (hidden: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`card sinc ${open ? 'pcard--open' : ''} ${p.level === 'major' && !p.hidden ? 'sinc--major' : ''} ${p.hidden ? 'sinc--hidden' : ''}`}>
      <button className="pcard__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="sinc__title">{p.title}</span>
        <span className={`spill spill--${p.hidden ? 'resolved' : p.level}`}>{p.hidden ? 'Hidden' : p.level === 'major' ? 'Problem' : 'Check'}</span>
        <IconChevron size={16} />
      </button>
      <span className="sinc__latest">{p.detail}</span>
      {problemMeta(p) && <span className="sinc__meta">{problemMeta(p)}</span>}
      {open && (
        <>
          <span className="label" style={{ margin: '6px 0 0' }}>
            Log · newest first
          </span>
          <LogLines lines={p.log} />
          <div className="pcard__actions">
            {p.sourceId && (
              <Link to={`/source/${p.sourceId}`} className="btn btn--small">
                Open source
              </Link>
            )}
            <Link to={logLink(p)} className="btn btn--small">
              Full log
            </Link>
            <button className="btn btn--small" onClick={() => onHide(!p.hidden)}>
              {p.hidden ? 'Show again' : 'Hide until it clears'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** The "Your app" section at the top of System status. */
export function AppProblemsSection({ onChanged }: { onChanged: () => void }) {
  const [view, setView] = useState<ProblemsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    api
      .problems()
      .then((v) => {
        setView(v);
        onChanged();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
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
  const hiddenList = view?.problems.filter((p) => p.hidden) ?? [];
  const level = shown.some((p) => p.level === 'major') ? 'major' : shown.length ? 'minor' : 'ok';

  return (
    <div className="section">
      <span className="label">Your app</span>
      {error && <div className="error">{error}</div>}
      {!view && !error && <div className="spinner">Checking…</div>}
      {view && (
        <div style={{ display: 'grid', gap: 10 }}>
          <Link to="/status/log" className={`ssum ssum--${level} plink`} style={{ margin: 0 }}>
            <span className={`sdot sdot--${level}`} aria-hidden="true" />
            <span>{shown.length === 0 ? 'No problems with your sources or the PC' : `${shown.length} thing${shown.length === 1 ? '' : 's'} to look at`}</span>
            <span className="ssum__sub">App log ›</span>
          </Link>
          {shown.map((p) => (
            <ProblemCard key={p.key} p={p} onHide={(h) => void hide(p.key, h)} />
          ))}
          {hiddenList.length > 0 && (
            <button className="btn btn--small" style={{ justifySelf: 'start' }} onClick={() => setShowHidden(!showHidden)}>
              {showHidden ? 'Hide' : 'Show'} {hiddenList.length} hidden
            </button>
          )}
          {showHidden && hiddenList.map((p) => <ProblemCard key={p.key} p={p} onHide={(h) => void hide(p.key, h)} />)}
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
