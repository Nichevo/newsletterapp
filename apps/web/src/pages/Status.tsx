import type { ServiceState, StatusIncident, StatusIncidentPage, StatusSummary, StatusView } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { longDate, relativeTime } from '../format';
import { IconBack, IconExternal, IconRefresh, IconSettings } from '../icons';

// System status: the service status pages the Worker checks (Settings > System
// status), as one card per open incident, a dot per service, and what was fixed
// in the last week. Each incident opens a page with its updates.

type DotLevel = ServiceState | StatusSummary['level'];

export function StatusDot({ level }: { level: DotLevel }) {
  return <span className={`sdot sdot--${level}`} aria-hidden="true" />;
}

export function statusButtonLabel(s: StatusSummary): string {
  if (s.level === 'ok') return 'System status: all fine';
  if (s.level === 'off') return 'System status';
  return `System status: ${s.open} problem${s.open === 1 ? '' : 's'} now`;
}

function clock(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

function lasted(from: number, to: number): string {
  const min = Math.max(1, Math.round((to - from) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h${min % 60 ? ` ${min % 60}` : ''}`;
  return `${Math.round(h / 24)} days`;
}

function stateWord(i: StatusIncident): string {
  if (i.state === 'resolved') return 'Fixed';
  return i.level === 'major' ? 'Outage' : 'Problem';
}

function Pill({ i }: { i: StatusIncident }) {
  return <span className={`spill spill--${i.state === 'resolved' ? 'resolved' : i.level}`}>{stateWord(i)}</span>;
}

function Chips({ list, max = 4 }: { list: string[]; max?: number }) {
  if (!list.length) return null;
  return (
    <div className="schips">
      {list.slice(0, max).map((c) => (
        <span key={c} className="schip">
          {c}
        </span>
      ))}
      {list.length > max && <span className="schip">+{list.length - max}</span>}
    </div>
  );
}

function IncidentCard({ i }: { i: StatusIncident }) {
  return (
    <Link to={`/status/${i.id}`} className={`card sinc ${i.level === 'major' ? 'sinc--major' : ''}`}>
      <div className="sinc__head">
        <span className="sinc__svc">{i.serviceName}</span>
        {i.unseen && <span className="spill">New</span>}
        <Pill i={i} />
      </div>
      <span className="sinc__title">{i.title}</span>
      {i.latest && i.latest !== i.title && <span className="sinc__latest">{i.latest}</span>}
      <Chips list={i.components} />
      <span className="sinc__meta">
        Started {clock(i.startedAt)} · {i.updates} update{i.updates === 1 ? '' : 's'} · last {relativeTime(i.updatedAt)}
        {i.nextUpdate ? ` · next by ${i.nextUpdate}` : ''}
      </span>
    </Link>
  );
}

function serviceLine(s: StatusView['services'][number]): string {
  if (s.state === 'unchecked') return 'not checked yet';
  if (s.state === 'major' || s.state === 'minor') return `${s.openCount} open`;
  if (s.state === 'error') return 'can’t read its page';
  if (s.lastFixedAt) return `fixed ${relativeTime(s.lastFixedAt)}`;
  return 'fine';
}

export function StatusPage({ onChanged }: { onChanged: () => void }) {
  const navigate = useNavigate();
  const [view, setView] = useState<StatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api
      .status()
      .then(setView)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, []);

  async function checkNow() {
    setChecking(true);
    setError(null);
    try {
      setView(await api.statusCheck());
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check');
    } finally {
      setChecking(false);
    }
  }

  const fine = view ? view.services.filter((s) => s.state === 'ok').length : 0;
  const lastCheck = view ? Math.max(0, ...view.services.map((s) => s.checkedAt ?? 0)) : 0;

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>System status</h1>
        </div>
        <div className="topbar__actions">
          <button className="iconbtn" aria-label="Check every service now" title="Check now" disabled={checking} onClick={() => void checkNow()}>
            <IconRefresh />
          </button>
          <Link to="/settings/status" className="iconbtn" aria-label="System status settings" title="Settings">
            <IconSettings />
          </Link>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      {!view && !error && <div className="spinner">Loading…</div>}
      {view && view.services.length === 0 && (
        <div className="section">
          <section className="card">
            <span>No services followed.</span>
            <Link to="/settings/status" className="btn btn--small">
              Choose services
            </Link>
          </section>
        </div>
      )}
      {view && view.services.length > 0 && (
        <>
          <div className={`ssum ssum--${view.open.some((i) => i.level === 'major') ? 'major' : view.open.length ? 'minor' : 'ok'}`}>
            <StatusDot level={view.open.some((i) => i.level === 'major') ? 'major' : view.open.length ? 'minor' : 'ok'} />
            <span>
              {view.open.length === 0
                ? 'Everything is fine'
                : `${view.open.length} problem${view.open.length === 1 ? '' : 's'} now · ${fine} service${fine === 1 ? '' : 's'} fine`}
            </span>
            <span className="ssum__sub">{checking ? 'Checking…' : lastCheck ? `Checked ${relativeTime(lastCheck)}` : 'Not checked yet'}</span>
          </div>

          {view.open.length > 0 && (
            <div className="section" style={{ display: 'grid', gap: 10 }}>
              {view.open.map((i) => (
                <IncidentCard key={i.id} i={i} />
              ))}
            </div>
          )}

          <div className="section">
            <span className="label">Services</span>
            <div className="card card--list">
              {view.services.map((s) => (
                <a
                  key={s.id}
                  className="cardrow srow"
                  href={s.pageUrl ?? s.feedUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={s.error ?? undefined}
                >
                  <StatusDot level={s.state} />
                  <span className="srow__name">{s.name}</span>
                  <span className="srow__state">{serviceLine(s)}</span>
                </a>
              ))}
            </div>
          </div>

          {view.fixed.length > 0 && (
            <div className="section">
              <span className="label">Fixed in the last 7 days</span>
              <div className="card card--list">
                {view.fixed.map((i) => (
                  <Link key={i.id} to={`/status/${i.id}`} className="cardrow srow">
                    <StatusDot level="ok" />
                    <span className="srow__name">
                      <strong>{i.serviceName}</strong> · {i.title}
                    </span>
                    <span className="srow__state">
                      {i.resolvedAt ? lasted(i.startedAt, i.resolvedAt) : ''}
                      <br />
                      {i.resolvedAt ? relativeTime(i.resolvedAt) : ''}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {view.quiet.length > 0 && (
            <div className="section">
              <span className="label">Also open, not counted</span>
              <div className="card card--list">
                {view.quiet.map((i) => (
                  <Link key={i.id} to={`/status/${i.id}`} className="cardrow srow">
                    <StatusDot level="unchecked" />
                    <span className="srow__name">
                      <strong>{i.serviceName}</strong> · {i.title}
                    </span>
                    <span className="srow__state">{relativeTime(i.updatedAt)}</span>
                  </Link>
                ))}
              </div>
              <span className="hint" style={{ margin: '6px 16px 0', display: 'block' }}>
                Problems with parts you didn’t pick for that service, or too new to count yet. Change either in Settings.
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function StatusIncidentPagePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [page, setPage] = useState<StatusIncidentPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    api
      .statusIncident(id)
      .then(setPage)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, [id]);

  const i = page?.incident;
  const updates = page ? (all ? page.updates : page.updates.slice(0, 8)) : [];
  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>{page?.service.name ?? 'Incident'}</h1>
        </div>
        {i && (
          <div className="topbar__actions">
            <Pill i={i} />
          </div>
        )}
      </header>
      {error && <div className="error">{error}</div>}
      {!page && !error && <div className="spinner">Loading…</div>}
      {page && i && (
        <>
          <div className="section">
            <section className="card sinc">
              <span className="sinc__title" style={{ fontSize: 17 }}>
                {i.title}
              </span>
              <span className="sinc__meta">
                Started {longDate(i.startedAt)}
                {i.resolvedAt ? ` · fixed after ${lasted(i.startedAt, i.resolvedAt)}` : ` · last update ${relativeTime(i.updatedAt)}`}
                {i.nextUpdate && i.state === 'open' ? ` · next by ${i.nextUpdate}` : ''}
              </span>
              <Chips list={i.components} max={20} />
              <a className="btn btn--small" style={{ justifySelf: 'start' }} href={i.url ?? page.service.pageUrl ?? page.service.feedUrl} target="_blank" rel="noreferrer">
                Status page <IconExternal size={14} />
              </a>
            </section>
          </div>

          <div className="section">
            <span className="label">Updates · newest first</span>
            <div className="stl">
              {updates.map((u, n) => {
                const isNew = page.seenBefore !== null && u.at > page.seenBefore;
                const last = n === updates.length - 1;
                const dot = /resolved|restored|fixed|completed|operating normally/i.test(u.label ?? '') ? 'ok' : i.level;
                return (
                  <div key={`${u.at}-${n}`} className="stl__step">
                    <div className="stl__rail">
                      <StatusDot level={dot} />
                      {!last && <span className="stl__line" />}
                    </div>
                    <div className={`stl__body ${isNew ? 'stl__body--new' : ''}`}>
                      <span className="sinc__meta">
                        {clock(u.at)}
                        {u.label ? ` · ${u.label}` : ''}
                        {isNew ? ' · new since you looked' : ''}
                      </span>
                      <span className="stl__text">{u.text}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            {!all && page.updates.length > updates.length && (
              <button className="btn btn--small" style={{ margin: '0 16px' }} onClick={() => setAll(true)}>
                Show {page.updates.length - updates.length} more update{page.updates.length - updates.length === 1 ? '' : 's'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
