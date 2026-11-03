import { siteName, type AppSettings } from '@newsletterapp/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { IconBack } from '../icons';

// Settings > PC helper and AI > Sites the PC leaves alone: sites whose bot
// checks flag the home network, which the PC never fetches, and the categories
// whose items are fetched from them anyway.

export function PcSitesPage() {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [site, setSite] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    api
      .settings()
      .then(setSettings)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, []);

  async function save(patch: Partial<AppSettings>) {
    if (!settings) return;
    setSettings({ ...settings, ...patch });
    try {
      setSettings(await api.saveSettings(patch));
      setSaved('Saved');
      window.setTimeout(() => setSaved(null), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  function add(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    const s = siteName(site);
    if (!s) return setError('That doesn’t look like a web address');
    setError(null);
    setSite('');
    if (!settings.pcSkipSites.includes(s)) void save({ pcSkipSites: [...settings.pcSkipSites, s] });
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Sites the PC leaves alone</h1>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      {!settings && !error && <div className="spinner">Loading…</div>}
      {settings && (
        <>
          <div className="section">
            <span className="label">Never fetched by the PC</span>
            <section className="card">
              <div className="chipedit">
                {settings.pcSkipSites.length === 0 && <span className="hint">None: the PC fetches every site.</span>}
                {settings.pcSkipSites.map((s) => (
                  <span key={s} className="chip chip--category">
                    {s}
                    <button aria-label={`Remove ${s}`} onClick={() => void save({ pcSkipSites: settings.pcSkipSites.filter((x) => x !== s) })}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <form className="inline" onSubmit={add}>
                <input className="input" placeholder="e.g. bloomberg.com" value={site} onChange={(e) => setSite(e.target.value)} />
                <button className="btn btn--small" type="submit">
                  Add
                </button>
                {saved && <span className="hint">{saved}</span>}
              </form>
              <span className="hint">
                Your PC fetches pages from your home internet. Some sites (Bloomberg especially) answer a few of those with a “prove
                you’re not a robot” page, and then show it to you in your own browser too. Sites listed here, and their subdomains,
                are never fetched: the post keeps what its feed or newsletter gave (for Techmeme, the summary and the More links) and
                Live page opens it in your browser. Any other site that shows a bot check is left alone for a few hours on its own.
              </span>
            </section>
          </div>

          {settings.categories.length > 0 && (
            <div className="section">
              <span className="label">Fetch them anyway for</span>
              <section className="card">
                <div className="chipedit">
                  {settings.categories.map((c) => {
                    const on = settings.pcSkipAllowCategories.includes(c);
                    return (
                      <button
                        key={c}
                        className={`chip ${on ? 'chip--category' : 'chip--outline'}`}
                        aria-pressed={on}
                        onClick={() =>
                          void save({
                            pcSkipAllowCategories: on
                              ? settings.pcSkipAllowCategories.filter((x) => x !== c)
                              : [...settings.pcSkipAllowCategories, c],
                          })
                        }
                      >
                        {c}
                      </button>
                    );
                  })}
                </div>
                <span className="hint">
                  Tap a category to let the PC fetch the sites above for its items (the item’s category, or else its source’s). The PC
                  still spaces its requests out and backs off if a site shows a bot check.
                </span>
              </section>
            </div>
          )}

          <div className="section">
            <div className="card card--list">
              <Link to="/stats/pc" className="cardrow">
                <div className="cardrow__main">
                  <span className="cardrow__title">How often the PC held back</span>
                  <span className="cardrow__sub">Skipped, resting and delayed fetches by day and site, and the limits in force</span>
                </div>
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
