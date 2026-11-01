import type { Source } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { nextTime, rhythmText, shortTime } from '../format';
import { IconBack } from '../icons';
import { CategoriesSection, useAppSettings } from './Settings';

/** Every source you receive or follow, grouped by kind. Each row opens the source's own page. */
export function SourcesPage() {
  const navigate = useNavigate();
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { settings, save } = useAppSettings();

  useEffect(() => {
    api
      .sources()
      .then(setSources)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load sources'));
  }, []);

  const newsletters = sources?.filter((s) => s.kind === 'newsletter') ?? [];
  const others = sources?.filter((s) => s.kind !== 'newsletter') ?? [];
  const [checking, setChecking] = useState<string | null>(null);

  const checkAll = async () => {
    setChecking('Checking…');
    try {
      const r = await api.checkAllSources();
      const left = Math.max(r.due - r.cloud - r.queued, 0);
      setChecking(
        `${r.added} new post${r.added === 1 ? '' : 's'} so far` +
          (r.queued ? `, ${r.queued} sent to your PC` : '') +
          (left ? `; the other ${left} follow over the next hour.` : '.'),
      );
      setSources(await api.sources());
    } catch (err) {
      setChecking(err instanceof Error ? err.message : 'Could not check');
    }
  };

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
      {others.length > 0 && (
        <div className="section">
          <div className="inline">
            <button className="btn btn--small" onClick={checkAll} disabled={checking === 'Checking…'}>
              Check all now
            </button>
          </div>
          <span className="hint">
            {checking ??
              'Feeds set to Auto are checked around the times they usually post (and at least daily). This checks every feed and website straight away.'}
          </span>
        </div>
      )}

      {settings && <CategoriesSection settings={settings} onSave={save} />}
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
              {s.kind === 'feed' && !s.pausedAt && (
                <span className="cardrow__sub">
                  {rhythmText(s.rhythm, s.checkMinutes === null).summary}
                  {s.checkMinutes !== null ? ' Fixed interval.' : ''}
                  {s.nextCheckAt ? ` Next check ${nextTime(s.nextCheckAt)}.` : ''}
                </span>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
