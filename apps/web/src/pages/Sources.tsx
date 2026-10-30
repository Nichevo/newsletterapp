import type { Source } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { shortTime } from '../format';
import { IconBack } from '../icons';

/** Every source you receive or follow, grouped by kind. Each row opens the source's own page. */
export function SourcesPage() {
  const navigate = useNavigate();
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .sources()
      .then(setSources)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load sources'));
  }, []);

  const newsletters = sources?.filter((s) => s.kind === 'newsletter') ?? [];
  const others = sources?.filter((s) => s.kind !== 'newsletter') ?? [];

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Your sources</h1>
        </div>
      </header>

      {error && <div className="error">{error}</div>}
      {sources === null && !error && <div className="spinner">Loading…</div>}

      {sources && sources.length === 0 && (
        <div className="empty">
          <h2>Nothing yet</h2>
          <p>Sources appear here once the first issue arrives.</p>
          <Link to="/add" className="btn btn--primary">
            Add one
          </Link>
        </div>
      )}

      <SourceList title="Newsletters you receive" sources={newsletters} noun="issue" />
      <SourceList title="Feeds and websites you follow" sources={others} noun="post" />
    </div>
  );
}

function SourceList({ title, sources, noun }: { title: string; sources: Source[]; noun: string }) {
  if (sources.length === 0) return null;
  return (
    <div className="section">
      <span className="label">{title}</span>
      <div className="card card--list">
        {sources.map((s) => (
          <Link key={s.id} to={`/source/${s.id}`} className="cardrow">
            <div className="cardrow__main">
              <span className="cardrow__title">{s.name}</span>
              <span className="cardrow__sub">
                {s.kind === 'site' ? 'Website · ' : ''}
                {s.itemCount} {noun}
                {s.itemCount === 1 ? '' : 's'}
                {s.lastReceivedAt ? ` · last ${shortTime(s.lastReceivedAt)}` : ''}
                {s.category ? ` · ${s.category}` : ''}
                {s.aiMode !== 'default' ? ` · AI ${s.aiMode}` : ''}
                {s.pausedAt ? ' · paused' : s.lastError ? ' · last check failed' : ''}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
