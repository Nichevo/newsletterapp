import type { AppSettings, Source, WebSearchSettings, WebSearchView } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { shortTime } from '../format';
import { IconBack } from '../icons';

// Settings > AI > Web search: whether the PC has a Brave key, the monthly
// search budget and how much of it is used, and which summaries search the
// web too (off everywhere until switched on here).

export function WebSearchPage() {
  const navigate = useNavigate();
  const [view, setView] = useState<WebSearchView | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [budget, setBudget] = useState('');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.webSearch(), api.settings(), api.sources()])
      .then(([v, s, src]) => {
        setView(v);
        setBudget(String(v.settings.monthlyBudget));
        setSettings(s);
        setSources(src.filter((x) => x.kind !== 'ai'));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, []);

  async function save(patch: Partial<WebSearchSettings>) {
    if (!view) return;
    const next = { ...view.settings, ...patch };
    setView({ ...view, settings: next });
    try {
      const s = await api.saveWebSearch(next);
      setView((v) => (v ? { ...v, settings: s } : v));
      setSaved('Saved');
      window.setTimeout(() => setSaved(null), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  const toggle = (list: string[], value: string, on: boolean) => (on ? [...list, value] : list.filter((x) => x !== value));
  const s = view?.settings;
  const pct = view && s && s.monthlyBudget > 0 ? Math.min(100, Math.round((view.used / s.monthlyBudget) * 100)) : 0;
  const shownSources = sources.filter((x) => !filter || x.name.toLowerCase().includes(filter.toLowerCase()));
  const chosenSources = sources.filter((x) => s?.summarySources.includes(x.id));

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Web search</h1>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      {!view && !error && <div className="spinner">Loading…</div>}
      {view && s && (
        <>
          <div className="section">
            <span className="label">Your PC</span>
            <section className="card">
              <PcStatus view={view} />
            </section>
          </div>

          <div className="section">
            <span className="label">This month ({view.month})</span>
            <section className="card">
              <div className="switchrow">
                <span style={{ fontSize: 15 }}>
                  <strong>{view.used}</strong> of {s.monthlyBudget} searches used
                </span>
                {saved && <span className="hint">{saved}</span>}
              </div>
              <div className="meter" aria-hidden="true">
                <span className={`meter__fill${pct >= 100 ? ' meter__fill--full' : ''}`} style={{ width: `${pct}%` }} />
              </div>
              <span className="hint">
                {view.usedAsks} for highlight questions, {view.usedSummaries} for summaries. Highlight questions get first call: summaries
                stop searching when less than a tenth is left. When it's all used, answers carry on without searching and say so.
              </span>
              <div className="field">
                <label htmlFor="budget">Searches per month</label>
                <div className="inline">
                  <input
                    id="budget"
                    className="input"
                    inputMode="numeric"
                    value={budget}
                    onChange={(e) => setBudget(e.target.value.replace(/\D/g, ''))}
                    style={{ maxWidth: 140 }}
                  />
                  <button
                    className="btn btn--small"
                    disabled={budget === '' || Number(budget) === s.monthlyBudget}
                    onClick={() => void save({ monthlyBudget: Number(budget) })}
                  >
                    Save
                  </button>
                </div>
                <span className="hint">
                  Set this to your Brave plan's monthly allowance, less whatever Open WebUI uses on the same key. A highlight question
                  makes one search; each summary with search on makes one.
                </span>
              </div>
            </section>
          </div>

          <div className="section">
            <span className="label">Highlight questions</span>
            <section className="card">
              <span className="hint">
                Each prompt chooses its own lookups (web search, Wikipedia and the article's links, both, or none) in{' '}
                <Link to="/settings/ai/highlights">Highlight prompts</Link>. Out of the box only More info, Fact-check and Other side
                search the web; Define uses Wikipedia.
              </span>
            </section>
          </div>

          <div className="section">
            <span className="label">Summaries with web search</span>
            <section className="card">
              <span className="hint">
                A summary with search on gets a “Background” line and “Other coverage” links, from searching the headline. Off
                everywhere until you switch it on here, by category or by source.
              </span>
              {settings && (
                <div className="field">
                  <label>Categories</label>
                  {settings.categories.map((cat) => (
                    <label key={cat} className="switchrow">
                      <span style={{ fontSize: 14 }}>{cat}</span>
                      <input
                        type="checkbox"
                        checked={s.summaryCategories.includes(cat)}
                        onChange={(e) => void save({ summaryCategories: toggle(s.summaryCategories, cat, e.target.checked) })}
                      />
                    </label>
                  ))}
                </div>
              )}
              <div className="field">
                <label htmlFor="srcfilter">Sources{chosenSources.length ? ` (${chosenSources.length} on)` : ''}</label>
                {chosenSources.length > 0 && (
                  <div className="chipedit">
                    {chosenSources.map((x) => (
                      <span key={x.id} className="chip chip--category">
                        {x.name}
                        <button aria-label={`Turn off for ${x.name}`} onClick={() => void save({ summarySources: toggle(s.summarySources, x.id, false) })}>
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <input id="srcfilter" className="input" placeholder="Find a source…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                {filter && (
                  <div className="card card--list" style={{ maxHeight: 260, overflowY: 'auto' }}>
                    {shownSources.slice(0, 30).map((x) => (
                      <label key={x.id} className="switchrow" style={{ padding: '6px 12px' }}>
                        <span style={{ fontSize: 14 }}>{x.name}</span>
                        <input
                          type="checkbox"
                          checked={s.summarySources.includes(x.id)}
                          onChange={(e) => void save({ summarySources: toggle(s.summarySources, x.id, e.target.checked) })}
                        />
                      </label>
                    ))}
                    {shownSources.length === 0 && <span className="hint" style={{ padding: 12 }}>No source matches.</span>}
                  </div>
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function PcStatus({ view }: { view: WebSearchView }) {
  if (view.pcSearch === 'brave') {
    return (
      <p style={{ margin: 0, fontSize: 15 }}>
        <strong>Brave key found.</strong> Web search is ready
        {view.helperLastSeenAt ? ` (helper last checked in ${shortTime(view.helperLastSeenAt)})` : ''}.
      </p>
    );
  }
  return (
    <>
      <p style={{ margin: 0, fontSize: 15 }}>
        <strong>{view.pcSearch === null ? 'No Brave key on your PC yet.' : 'Waiting for your PC helper to update.'}</strong>{' '}
        {view.pcSearch === null
          ? 'Wikipedia and the article’s links work without one; web search is skipped until it’s added.'
          : 'It updates itself within a few minutes of the PC checking in.'}
      </p>
      {view.pcSearch === null && (
        <ol className="hint" style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            Download <a href="/helper/newsletter-helper.mjs">newsletter-helper.mjs</a> and{' '}
            <a href="/helper/install-helper.ps1" download>
              install-helper.ps1
            </a>{' '}
            into one folder.
          </li>
          <li>
            Run <code>powershell -ExecutionPolicy Bypass -File install-helper.ps1</code> there. Press Enter to keep each saved answer,
            and paste your Brave Search API key when it asks (the one Open WebUI uses works).
          </li>
          <li>The key stays in the helper's config on your PC; it never goes to Cloudflare.</li>
        </ol>
      )}
    </>
  );
}
