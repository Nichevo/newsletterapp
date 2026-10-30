import type { Digest } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { shortTime } from '../format';

/** Techmeme-style daily digest: top stories grouped by topic, built once a day on the Worker. */
export function DigestPage() {
  const [digests, setDigests] = useState<Digest[] | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  function load() {
    return api
      .digests()
      .then((list) => {
        setDigests(list);
        setDay((d) => d ?? list[0]?.day ?? null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the digest'));
  }

  useEffect(() => {
    void load();
  }, []);

  async function buildNow() {
    setBuilding(true);
    setError(null);
    try {
      const d = await api.buildDigest();
      if ('empty' in d) setError('Nothing to digest yet: no issues arrived in the last day.');
      else setDay(d.day);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build the digest');
    } finally {
      setBuilding(false);
    }
  }

  const open = digests?.filter((d) => !d.readAt) ?? [];
  const earlier = digests?.filter((d) => d.readAt) ?? [];
  const visible = showEarlier ? (digests ?? []) : open;
  const current = visible.find((d) => d.day === day) ?? visible[0] ?? null;

  async function markDone(d: Digest) {
    try {
      const r = await api.digestDone(d.day);
      setNote(r.itemsRead > 0 ? `Done. ${r.itemsRead} stor${r.itemsRead === 1 ? 'y' : 'ies'} marked read.` : null);
      setDigests((list) => list?.map((x) => (x.day === d.day ? { ...x, readAt: r.readAt } : x)) ?? null);
      setDay(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not mark the digest done');
    }
  }

  async function reopen(d: Digest) {
    await api.digestUndone(d.day).catch(() => undefined);
    setDigests((list) => list?.map((x) => (x.day === d.day ? { ...x, readAt: null } : x)) ?? null);
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles">
          <h1>Digest</h1>
          {current && (
            <span className="topbar__eyebrow">
              {dayLabel(current.day)} · {current.itemCount} issue{current.itemCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <button className="btn btn--ghost btn--small" disabled={building} onClick={() => void buildNow()}>
          {building ? 'Building…' : 'Build now'}
        </button>
      </header>

      {(visible.length > 1 || earlier.length > 0) && (
        <div className="tabs">
          {visible.map((d) => (
            <button key={d.day} className="pill" aria-pressed={d.day === current?.day} onClick={() => setDay(d.day)}>
              {dayLabel(d.day)}
              {d.readAt ? ' ✓' : ''}
            </button>
          ))}
          {earlier.length > 0 && (
            <button className="pill" onClick={() => setShowEarlier((v) => !v)}>
              {showEarlier ? 'Hide earlier' : `Earlier (${earlier.length})`}
            </button>
          )}
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {note && <p className="hint" style={{ padding: '0 16px' }}>{note}</p>}
      {digests === null && !error && <div className="spinner">Loading…</div>}

      {digests && !current && (
        <div className="empty">
          <h2>{earlier.length > 0 ? 'All caught up' : 'No digest yet'}</h2>
          <p>
            {earlier.length > 0
              ? 'The next digest is built at the hour set in Settings. Tap “Build now” for one from what has arrived since.'
              : 'One is built every day at the hour set in Settings, from the issues that arrived. Tap “Build now” to make one from what is here already.'}
          </p>
        </div>
      )}

      {current && (
        <div className="digest">
          <div className="digest__bar">
            <span className="digest__meta">
              Issues from {shortTime(current.fromAt)} to {shortTime(current.toAt)}, ranked by what you tend to read.
            </span>
            {current.readAt ? (
              <button className="btn btn--ghost btn--small" onClick={() => void reopen(current)}>
                Reopen
              </button>
            ) : (
              <button className="btn btn--small" onClick={() => void markDone(current)}>
                Done
              </button>
            )}
          </div>
          {current.sections.map((section) => (
            <section key={section.title} className="card digest__section">
              <h2>{section.title}</h2>
              {section.stories.map((s) => (
                <article key={s.itemId} className={`story${s.readAt ? ' story--read' : ''}`}>
                  <Link to={`/item/${s.itemId}`} className="story__title">
                    {s.subject}
                  </Link>
                  <span className="story__source">
                    {s.sourceName ?? 'Unknown sender'} · {shortTime(s.receivedAt)}
                    {s.readAt ? ' · read' : ''}
                  </span>
                  {s.summary && <p className="story__summary">{s.summary}</p>}
                  {s.whyItMatters && <p className="story__why">Why it matters: {s.whyItMatters}</p>}
                  {s.more.length > 0 && (
                    <ul className="story__more">
                      <li>More:</li>
                      {s.more.map((m) => (
                        <li key={m.itemId}>
                          <Link to={`/item/${m.itemId}`}>{m.sourceName ?? m.subject}</Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              ))}
            </section>
          ))}
          {!current.readAt && (
            <button className="btn btn--block" onClick={() => void markDone(current)}>
              Done with this digest
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function dayLabel(day: string): string {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - date.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
