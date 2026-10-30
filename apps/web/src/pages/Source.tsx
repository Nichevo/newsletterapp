import type { AiMode, AppSettings, Source } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { shortTime } from '../format';
import { IconBack } from '../icons';

const AI_LABEL: Record<AiMode, string> = { default: 'Default', on: 'On', off: 'Off' };

/** One newsletter's settings: its usual category and whether it goes to the AI. */
export function SourcePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [source, setSource] = useState<Source | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function bulk(action: 'read-all' | 'archive-all') {
    if (!source) return;
    if (action === 'archive-all' && !window.confirm(`Archive every inbox issue from ${source.name}?`)) return;
    try {
      const r = await api.sourceBulk(source.id, action);
      setDone(`${r.changed} issue${r.changed === 1 ? '' : 's'} ${action === 'read-all' ? 'marked read' : 'archived'}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  useEffect(() => {
    Promise.all([api.sources(), api.settings()])
      .then(([sources, s]) => {
        setSettings(s);
        const found = sources.find((x) => x.id === id);
        if (found) setSource(found);
        else setError('Source not found');
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, [id]);

  async function update(patch: { category?: string | null; aiMode?: AiMode }) {
    if (!source) return;
    const before = source;
    setSource({ ...source, ...patch });
    try {
      setSource(await api.updateSource(source.id, patch));
    } catch (err) {
      setSource(before);
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  const kindDefault = source && settings ? settings.aiByKind[source.kind] : null;
  const categories = settings?.categories ?? [];

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>{source?.name ?? 'Source'}</h1>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {source && (
        <>
          <div className="section">
            <span className="hint">
              {source.itemCount} issue{source.itemCount === 1 ? '' : 's'}
              {source.lastReceivedAt ? ` · last ${shortTime(source.lastReceivedAt)}` : ''}
              {source.senderEmail ? ` · ${source.senderEmail}` : ''}
              {source.unsubscribedAt ? ` · unsubscribed ${shortTime(source.unsubscribedAt)}` : ''}
            </span>
            <div className="inline">
              <Link to={`/?source=${source.id}`} className="btn btn--small">
                Show issues
              </Link>
              <button className="btn btn--small" onClick={() => void bulk('read-all')}>
                Mark all read
              </button>
              <button className="btn btn--small" onClick={() => void bulk('archive-all')}>
                Archive all
              </button>
            </div>
            {done && <span className="hint">{done}</span>}
          </div>

          <div className="section">
            <span className="label">Category</span>
            <section className="card">
              <select
                className="input"
                value={source.category ?? ''}
                onChange={(e) => void update({ category: e.target.value || null })}
              >
                <option value="">None</option>
                {categories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
                {source.category && !categories.includes(source.category) && <option>{source.category}</option>}
              </select>
              <span className="hint">Applies to every issue from this newsletter, old and new, unless a keyword rule matches.</span>
            </section>
          </div>

          <div className="section">
            <span className="label">AI summaries</span>
            <section className="card">
              <div className="segmented" role="group" aria-label="AI summaries">
                {(Object.keys(AI_LABEL) as AiMode[]).map((m) => (
                  <button key={m} aria-pressed={source.aiMode === m} onClick={() => void update({ aiMode: m })}>
                    {AI_LABEL[m]}
                  </button>
                ))}
              </div>
              <span className="hint">
                Default follows Settings (currently {kindDefault ? 'on' : 'off'} for this kind of source). Off means this
                newsletter only gets the quick summary and never goes to your PC.
              </span>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
