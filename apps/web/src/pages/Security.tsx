import {
  HIBP_SITE,
  breachTodo,
  hitLabel,
  isHighClass,
  leakedPhrase,
  sortDataClasses,
  type BreachHit,
  type SecurityBreach,
  type SecurityBreachPage,
  type SecurityLevel,
  type SecurityMailPage,
  type SecuritySummary,
  type SecurityView,
} from '@newsletterapp/shared';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { longDate, relativeTime } from '../format';
import { IconBack, IconExternal, IconRefresh, IconSettings } from '../icons';

// Security alerts: breaches Have I Been Pwned has emailed about (to the alerts
// address), the ones still to deal with on top, then the whole history, and the
// mail the alerts address has received. Each breach opens a page with what
// leaked, your addresses in it, a to-do list and what happened to it.

/** The dot colours System status uses: red, amber, green, grey. */
const DOT: Record<SecurityLevel, string> = { high: 'major', medium: 'minor', watch: 'minor', low: 'minor', ok: 'ok', off: 'off' };

export function SecurityDot({ level }: { level: SecurityLevel }) {
  return <span className={`sdot sdot--${DOT[level]}`} aria-hidden="true" />;
}

export function securityButtonLabel(s: SecuritySummary): string {
  if (s.level === 'off') return 'Security alerts';
  if (s.level === 'ok' || s.open === 0) return 'Security alerts: nothing to do';
  return `Security alerts: ${s.open} breach${s.open === 1 ? '' : 'es'} to deal with`;
}

/** "Passwords" / "Personal data" / "Email only" / "Site you use": the pill on a breach. */
function levelWord(b: SecurityBreach): string {
  if (b.state === 'handled') return 'Handled';
  if (b.level === 'watch') return 'Site you use';
  if (b.level === 'high') return sortDataClasses(b.info.dataClasses).find(isHighClass) ?? 'Serious';
  if (b.level === 'low') return b.info.spamList ? 'Spam list' : 'Email only';
  return 'Personal data';
}

export function LevelPill({ b }: { b: SecurityBreach }) {
  const cls = b.state === 'handled' ? 'resolved' : b.level === 'high' ? 'major' : 'minor';
  return <span className={`spill spill--${cls}`}>{levelWord(b)}</span>;
}

const provider = (domain: string) =>
  /gmail|googlemail/.test(domain)
    ? 'Gmail'
    : /hotmail|outlook|live\.|msn/.test(domain)
      ? 'Hotmail'
      : /yahoo/.test(domain)
        ? 'Yahoo'
        : /icloud|me\.com|mac\.com/.test(domain)
          ? 'iCloud'
          : null;

/** A short name for an address: "Gmail", "newsletter address for Morning Brew", "addresses on example.com". */
function shortAddress(h: BreachHit): string {
  if (!h.address || h.address.startsWith('@')) return hitLabel(h);
  if (h.sources.length) return `newsletter address for ${h.sources[0]!.name}${h.sources.length > 1 ? ` +${h.sources.length - 1}` : ''}`;
  const p = provider(h.address.split('@')[1] ?? '');
  return p ? `${p} address` : h.address;
}

/** "Your Gmail address was in this breach", "Sam's address and 1 more…" */
function whoLine(b: SecurityBreach): string {
  if (b.origin === 'site') return 'A site you get mail from was breached';
  const h = b.hits[0];
  if (!h) return 'One of your addresses was in this breach';
  const owner = h.person && !/^me$/i.test(h.person) ? `${h.person}’s` : 'Your';
  const more = b.hits.length > 1 ? ` and ${b.hits.length - 1} more` : '';
  if (!h.address) return 'An address the alert didn’t name was in this breach';
  if (h.address.startsWith('@')) return `${hitLabel(h).replace(/^./, (c) => c.toUpperCase())}${more} ${h.count === 1 ? 'was' : 'were'} in this breach`;
  return `${owner} ${shortAddress(h)}${more} was in this breach`;
}

function monthYear(date: string | null): string | null {
  if (!date) return null;
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }) : null;
}

const year = (b: SecurityBreach) => b.info.breachDate?.slice(0, 4) ?? (b.info.addedAt ? String(new Date(b.info.addedAt).getFullYear()) : '');

function Chips({ list, max = 3 }: { list: string[]; max?: number }) {
  if (!list.length) return null;
  const sorted = sortDataClasses(list);
  return (
    <div className="schips">
      {sorted.slice(0, max).map((c) => (
        <span key={c} className={`schip ${isHighClass(c) ? 'schip--high' : ''}`}>
          {c}
        </span>
      ))}
      {sorted.length > max && <span className="schip">+{sorted.length - max}</span>}
    </div>
  );
}

function BreachCard({ b }: { b: SecurityBreach }) {
  const steps = breachTodo(b);
  const done = steps.filter((s) => b.todoDone.includes(s.key)).length;
  const happened = monthYear(b.info.breachDate);
  return (
    <Link to={`/security/breach/${encodeURIComponent(b.name)}`} className={`card sinc secb secb--${b.level}`}>
      <div className="sinc__head">
        <span className="sinc__svc">{b.info.title}</span>
        {b.unseen && <span className="spill">New</span>}
        <LevelPill b={b} />
      </div>
      <span className="sinc__title">{whoLine(b)}</span>
      {b.origin === 'site' ? (
        <span className="sinc__latest">
          You get mail from {b.siteSources.map((s) => s.name).join(', ') || b.info.domain}. Have I Been Pwned hasn’t said your address was in it; if
          it was, an alert follows.
        </span>
      ) : (
        <Chips list={b.info.dataClasses} />
      )}
      <span className="sinc__meta">
        {happened ? `Happened ${happened} · ` : ''}
        {b.info.addedAt ? `announced ${relativeTime(b.info.addedAt)}` : `added ${relativeTime(b.firstSeenAt)}`}
        {b.info.pwnCount ? ` · ${b.info.pwnCount.toLocaleString()} accounts` : ''}
        {steps.length ? ` · ${done} of ${steps.length} steps done` : ''}
      </span>
    </Link>
  );
}

function historySub(b: SecurityBreach): string {
  const who = b.origin === 'site' ? 'site you get mail from' : b.hits.map(shortAddress).slice(0, 2).join(' + ') || 'your address';
  const leaked = b.info.spamList ? 'spam list only' : b.info.dataClasses.length ? leakedPhrase(b.info.dataClasses) : '';
  const how = b.origin === 'past' ? 'added from past list' : b.handledAt ? `handled ${new Date(b.handledAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}` : '';
  return [who, leaked, how].filter(Boolean).join(' · ');
}

/** The groups history can be filtered by: each address (or domain) your breaches hit. */
function addressGroups(list: SecurityBreach[]): { key: string; label: string; n: number }[] {
  const map = new Map<string, { label: string; n: number }>();
  for (const b of list) {
    for (const key of new Set(b.hits.map((h) => h.address).filter(Boolean))) {
      const h = b.hits.find((x) => x.address === key)!;
      const label = key.startsWith('@') ? key.slice(1) : (provider(key.split('@')[1] ?? '') ?? key);
      const g = map.get(key) ?? { label: h.person && !/^me$/i.test(h.person) ? `${h.person}: ${label}` : label, n: 0 };
      g.n += 1;
      map.set(key, g);
    }
  }
  return [...map.entries()].map(([key, g]) => ({ key, ...g })).sort((a, b) => b.n - a.n);
}

export function SecurityPage({ onChanged }: { onChanged: () => void }) {
  const navigate = useNavigate();
  const [view, setView] = useState<SecurityView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    api
      .security()
      .then(setView)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, []);

  async function checkNow() {
    setChecking(true);
    setError(null);
    try {
      setView(await api.securityCheck());
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check');
    } finally {
      setChecking(false);
    }
  }

  const groups = useMemo(() => (view ? addressGroups(view.history) : []), [view]);
  const history = view ? view.history.filter((b) => !filter || b.hits.some((h) => h.address === filter)) : [];
  const shown = all ? history : history.slice(0, 20);
  const level: SecurityLevel = view?.open[0]?.level ?? (view && view.watching ? 'ok' : 'off');

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Security</h1>
        </div>
        <div className="topbar__actions">
          <button className="iconbtn" aria-label="Check Have I Been Pwned’s newest breach now" title="Check now" disabled={checking} onClick={() => void checkNow()}>
            <IconRefresh />
          </button>
          <Link to="/settings/security" className="iconbtn" aria-label="Security alert settings" title="Settings">
            <IconSettings />
          </Link>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      {!view && !error && <div className="spinner">Loading…</div>}
      {view && view.watching === 0 && view.open.length === 0 && view.history.length === 0 && (
        <div className="section">
          <section className="card" style={{ display: 'grid', gap: 8 }}>
            <span>Not set up yet. Add the addresses and domains to watch, then point Have I Been Pwned’s free alerts at {view.alertsAddress}.</span>
            <Link to="/settings/security" className="btn btn--small" style={{ justifySelf: 'start' }}>
              Set up
            </Link>
          </section>
        </div>
      )}
      {view && (view.watching > 0 || view.open.length > 0 || view.history.length > 0) && (
        <>
          <div className={`ssum ssum--${DOT[level]}`}>
            <SecurityDot level={level} />
            <span>{view.open.length === 0 ? 'Nothing to deal with' : `${view.open.length} breach${view.open.length === 1 ? '' : 'es'} to deal with`}</span>
            <span className="ssum__sub">
              {checking
                ? 'Checking…'
                : view.checkError
                  ? `Can’t reach Have I Been Pwned: ${view.checkError}`
                  : `${view.watching} watched${view.lastCheckAt ? ` · checked ${relativeTime(view.lastCheckAt)}` : ''}`}
            </span>
          </div>

          {view.open.length > 0 && (
            <div className="section" style={{ display: 'grid', gap: 10 }}>
              {view.open.map((b) => (
                <BreachCard key={b.name} b={b} />
              ))}
            </div>
          )}

          <div className="section">
            <span className="label">History · {view.history.length} breach{view.history.length === 1 ? '' : 'es'}</span>
            {groups.length > 1 && (
              <div className="secchips">
                <button className="pill" onClick={() => setFilter(null)} aria-pressed={filter === null}>
                  All addresses
                </button>
                {groups.slice(0, 8).map((g) => (
                  <button key={g.key} className="pill" onClick={() => setFilter(filter === g.key ? null : g.key)} aria-pressed={filter === g.key}>
                    {g.label} · {g.n}
                  </button>
                ))}
              </div>
            )}
            {history.length === 0 ? (
              <section className="card">
                <span className="hint">
                  Nothing yet. <Link to="/settings/security/past">Add past breaches</Link> from Have I Been Pwned’s website to start the list; new alerts join it as they arrive.
                </span>
              </section>
            ) : (
              <div className="card card--list">
                {shown.map((b) => (
                  <Link key={b.name} to={`/security/breach/${encodeURIComponent(b.name)}`} className="cardrow srow">
                    <SecurityDot level={b.level === 'low' ? 'off' : 'ok'} />
                    <span className="srow__name">
                      <strong>{b.info.title}</strong>
                      <span className="cardrow__sub" style={{ display: 'block' }}>
                        {historySub(b)}
                      </span>
                    </span>
                    <span className="srow__state">{year(b)}</span>
                  </Link>
                ))}
              </div>
            )}
            {!all && history.length > shown.length && (
              <button className="btn btn--small" style={{ margin: '8px 16px 0' }} onClick={() => setAll(true)}>
                Show all {history.length}
              </button>
            )}
          </div>

          <div className="section">
            <span className="label">Mail to {view.alertsAddress}</span>
            {view.mail.length === 0 ? (
              <section className="card">
                <span className="hint">Nothing has arrived yet.</span>
              </section>
            ) : (
              <div className="card card--list">
                {view.mail.map((m) => (
                  <Link key={m.id} to={`/security/mail/${m.id}`} className="cardrow">
                    <div className="cardrow__main">
                      <span className="cardrow__title">{m.subject}</span>
                      <span className="cardrow__sub">
                        {m.fromHibp ? 'Have I Been Pwned' : m.from} · {relativeTime(m.receivedAt)}
                        {m.breaches.length ? ` · read as ${m.breaches.length === 1 ? 'a breach alert' : `${m.breaches.length} breach alerts`}` : ''}
                        {m.fromHibp && !m.genuine ? ' · couldn’t confirm the sender' : ''}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
            <span className="hint" style={{ margin: '6px 16px 0', display: 'block' }}>
              Everything sent to the alerts address shows here, so sign-in codes and forwarding confirmations aren’t lost. Only genuine Have I Been Pwned
              mail creates a breach.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** HIBP's descriptions are HTML; shown as plain text so nothing in them runs. */
function plainText(html: string): string {
  try {
    return new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim() ?? '';
  } catch {
    return html.replace(/<[^>]+>/g, '');
  }
}

const EVENT_DOT: Record<string, SecurityLevel> = { alert: 'high', announced: 'watch', changed: 'medium', handled: 'ok', reopened: 'medium', past: 'off' };

export function SecurityBreachPagePage({ onChanged }: { onChanged: () => void }) {
  const { name = '' } = useParams();
  const navigate = useNavigate();
  const [page, setPage] = useState<SecurityBreachPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .securityBreach(name)
      .then((p) => {
        setPage(p);
        onChanged();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  async function save(patch: { state?: 'open' | 'handled'; todoDone?: string[] }) {
    if (!page) return;
    setBusy(true);
    setError(null);
    try {
      const breach = await api.updateSecurityBreach(page.breach.name, patch);
      setPage(patch.state ? await api.securityBreach(page.breach.name) : { ...page, breach });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!page) return;
    try {
      await api.removeSecurityBreach(page.breach.name);
      onChanged();
      navigate('/security', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove');
    }
  }

  const b = page?.breach;
  const steps = b ? breachTodo(b) : [];
  const happened = b ? monthYear(b.info.breachDate) : null;
  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>{b?.info.title ?? 'Breach'}</h1>
        </div>
        {b && (
          <div className="topbar__actions">
            {b.state === 'open' ? <span className="spill spill--major">To do</span> : <LevelPill b={b} />}
          </div>
        )}
      </header>
      {error && <div className="error">{error}</div>}
      {!page && !error && <div className="spinner">Loading…</div>}
      {page && b && (
        <>
          <div className="section">
            <section className="card sinc">
              <div className="secinfo">
                {b.info.logo ? (
                  <img className="secinfo__logo" src={b.info.logo} alt="" referrerPolicy="no-referrer" loading="lazy" />
                ) : (
                  <span className="secinfo__logo secinfo__logo--text" aria-hidden="true">
                    {b.info.title.slice(0, 2).toUpperCase()}
                  </span>
                )}
                <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{b.info.domain || b.info.title}</span>
                  <span className="sinc__meta">
                    {b.info.pwnCount ? `${b.info.pwnCount.toLocaleString()} accounts` : 'Size not known yet'}
                    {b.info.verified ? ' · confirmed by Have I Been Pwned' : b.info.fabricated ? ' · probably made up' : ''}
                  </span>
                </span>
              </div>
              {b.info.description && <span className="sinc__latest secinfo__desc">{plainText(b.info.description)}</span>}
              <Chips list={b.info.dataClasses} max={30} />
              <span className="sinc__meta">
                {happened ? `Happened ${happened}` : 'Date not known'}
                {b.info.addedAt ? ` · added to Have I Been Pwned ${new Date(b.info.addedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
              </span>
            </section>
          </div>

          <div className="section">
            <span className="label">{b.origin === 'site' ? 'Why it’s flagged' : 'Your addresses in it'}</span>
            <div className="card card--list">
              {b.origin === 'site' && (
                <div className="cardrow">
                  <div className="cardrow__main">
                    <span className="cardrow__title">You get mail from this site</span>
                    <span className="cardrow__sub">
                      {b.siteSources.map((s, i) => (
                        <Fragment key={s.id}>
                          {i > 0 && ', '}
                          <Link to={`/source/${s.id}`}>{s.name}</Link>
                        </Fragment>
                      ))}
                      . Have I Been Pwned hasn’t said your address was in it.
                    </span>
                  </div>
                </div>
              )}
              {b.hits.map((h) => (
                <div key={h.address || 'unnamed'} className="cardrow">
                  <div className="cardrow__main">
                    <span className="cardrow__title" style={{ overflowWrap: 'anywhere' }}>
                      {hitLabel(h)}
                    </span>
                    <span className="cardrow__sub">
                      {[h.person, h.via === 'past' ? 'added from your past breaches' : h.via === 'domain' ? `domain alert ${relativeTime(h.seenAt)}` : `alert ${relativeTime(h.seenAt)}`]
                        .filter(Boolean)
                        .join(' · ')}
                      {h.sources.length > 0 && (
                        <>
                          {' · used by '}
                          {h.sources.map((s, i) => (
                            <Fragment key={s.id}>
                              {i > 0 && ', '}
                              <Link to={`/source/${s.id}`}>{s.name}</Link>
                            </Fragment>
                          ))}
                        </>
                      )}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            {b.hits.some((h) => h.addressId) && (
              <span className="hint" style={{ margin: '6px 16px 0', display: 'block' }}>
                A newsletter address leaked. Each one is used by only one sender, so this is who lost or shared it. You can stop accepting it under{' '}
                <Link to="/add">Add › Your addresses</Link>.
              </span>
            )}
          </div>

          {steps.length > 0 && (
            <div className="section">
              <span className="label">
                What to do · {steps.filter((s) => b.todoDone.includes(s.key)).length} of {steps.length} done
              </span>
              <div className="card card--list">
                {steps.map((s) => {
                  const done = b.todoDone.includes(s.key);
                  return (
                    <label key={s.key} className="cardrow sectodo">
                      <input
                        type="checkbox"
                        checked={done}
                        disabled={busy}
                        onChange={() => void save({ todoDone: done ? b.todoDone.filter((k) => k !== s.key) : [...b.todoDone, s.key] })}
                      />
                      <span className={done ? 'sectodo__done' : ''}>{s.text}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {page.events.length > 0 && (
            <div className="section">
              <span className="label">History · newest first</span>
              <div className="stl">
                {page.events.map((e, n) => {
                  const isNew = page.seenBefore !== null && e.at > page.seenBefore;
                  const last = n === page.events.length - 1;
                  return (
                    <div key={`${e.at}-${n}`} className="stl__step">
                      <div className="stl__rail">
                        <SecurityDot level={EVENT_DOT[e.kind] ?? 'off'} />
                        {!last && <span className="stl__line" />}
                      </div>
                      <div className={`stl__body ${isNew ? 'stl__body--new' : ''}`}>
                        <span className="sinc__meta">
                          {longDate(e.at)}
                          {isNew ? ' · new since you looked' : ''}
                        </span>
                        <span className="stl__text">{e.text}</span>
                        {e.mailId && (
                          <Link to={`/security/mail/${e.mailId}`} style={{ fontSize: 13 }}>
                            Read the email
                          </Link>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="section">
            <div className="inline" style={{ margin: '0 16px', flexWrap: 'wrap' }}>
              {b.state === 'open' ? (
                <button className="btn btn--primary" disabled={busy} onClick={() => void save({ state: 'handled' })}>
                  Mark handled
                </button>
              ) : (
                <button className="btn" disabled={busy} onClick={() => void save({ state: 'open' })}>
                  Open again
                </button>
              )}
              <a className="btn btn--small" href={`${HIBP_SITE}/Breach/${encodeURIComponent(b.name)}`} target="_blank" rel="noreferrer">
                On Have I Been Pwned <IconExternal size={14} />
              </a>
              <button className={`btn btn--small ${confirmRemove ? 'btn--danger' : ''}`} onClick={() => (confirmRemove ? void remove() : setConfirmRemove(true))}>
                {confirmRemove ? 'Tap again to remove' : 'Remove from list'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Text with its web addresses as links. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"')\]]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>
            {p}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

export function SecurityMailPagePage({ onChanged }: { onChanged: () => void }) {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [mail, setMail] = useState<SecurityMailPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    api
      .securityMail(id)
      .then(setMail)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, [id]);

  async function useIt() {
    setError(null);
    try {
      await api.useSecurityMail(id);
      setMail(await api.securityMail(id));
      setNote('Read as a breach alert.');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read it');
    }
  }

  async function remove() {
    try {
      await api.removeSecurityMail(id);
      navigate('/security', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete');
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Email</h1>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      {note && <div className="notice notice--teal-tint">{note}</div>}
      {!mail && !error && <div className="spinner">Loading…</div>}
      {mail && (
        <div className="section">
          <section className="card" style={{ display: 'grid', gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 16 }}>{mail.subject}</span>
            <span className="sinc__meta">
              {mail.from} · {longDate(mail.receivedAt)}
              {mail.genuine ? ' · sender confirmed' : ' · sender not confirmed'}
            </span>
            {mail.breaches.length > 0 && (
              <span className="schips">
                {mail.breaches.map((n) => (
                  <Link key={n} className="schip" to={`/security/breach/${encodeURIComponent(n)}`}>
                    {n}
                  </Link>
                ))}
              </span>
            )}
            <div className="secmail">
              <Linked text={mail.text || '(no text)'} />
            </div>
            <div className="inline" style={{ flexWrap: 'wrap' }}>
              {mail.breaches.length === 0 && /haveibeenpwned/i.test(mail.from + mail.text) && (
                <button className="btn btn--small" onClick={() => void useIt()}>
                  Read it as a breach alert
                </button>
              )}
              <button className="btn btn--small" onClick={() => void remove()}>
                Delete
              </button>
            </div>
            {mail.breaches.length === 0 && !mail.genuine && mail.fromHibp && (
              <span className="hint">
                Cloudflare couldn’t confirm this really came from Have I Been Pwned (forwarding can do that), so it wasn’t read as an alert. If it looks
                right, “Read it as a breach alert” does it.
              </span>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

