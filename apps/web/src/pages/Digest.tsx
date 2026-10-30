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

  const current = digests?.find((d) => d.day === day) ?? digests?.[0] ?? null;

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

      {digests && digests.length > 1 && (
        <div className="tabs">
          {digests.map((d) => (
            <button key={d.day} className="pill" aria-pressed={d.day === current?.day} onClick={() => setDay(d.day)}>
              {dayLabel(d.day)}
            </button>
          ))}
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {digests === null && !error && <div className="spinner">Loading…</div>}

      {digests && !current && (
        <div className="empty">
          <h2>No digest yet</h2>
          <p>One is built every day at the hour set in Settings, from the issues that arrived. Tap “Build now” to make one from what's here already.</p>
        </div>
      )}

      {current && (
        <div className="digest">
          <span className="digest__meta">
            Issues from {shortTime(current.fromAt)} to {shortTime(current.toAt)}, ranked by what you tend to read.
          </span>
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
