import { HOME_RADIUS_KM, STATUS_KEEP_DAYS, STATUS_MIN_MINUTES, type HomeArea, type StatusService, type StatusSettings, type StatusSettingsView } from '@newsletterapp/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { relativeTime } from '../format';
import { IconBack } from '../icons';
import { StatusDot } from './Status';

// Settings > System status: which status pages are followed, the words that
// narrow busy ones (Cloudflare, AWS, GitHub) to the parts that matter, and how
// the inbox shows a problem.

const KIND_NOTE: Record<StatusService['kind'], string> = {
  statuspage: 'Status page feed, one item per incident',
  google: 'Google status feed',
  m365: 'Microsoft 365 public status (big outages only); updates joined into one incident',
  azure: 'Azure status (only lists what’s happening now)',
  aws: 'AWS status feed; updates joined by service and region',
  apple: 'Apple System Status data',
  onenz: 'One NZ’s outage map data (mobile and broadband), outages near your home area',
  vector: 'Vector’s outage map data: power cuts covering or near your home area, planned cuts while they’re on, and Vector’s Auckland-wide alerts',
  chorus: 'Chorus’s outage map data (the fibre and copper network most internet providers use), outages near your home area',
};

function ServiceRow({ s, onSave, onRemove }: { s: StatusService; onSave: (patch: { enabled?: boolean; only?: string[] }) => void; onRemove: () => void }) {
  const [words, setWords] = useState(s.only.join(', '));
  const [open, setOpen] = useState(false);
  useEffect(() => setWords(s.only.join(', ')), [s.only]);
  const parsed = words
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);
  const changed = parsed.join('|') !== s.only.join('|');
  return (
    <div className="cardrow" style={{ display: 'grid', gap: 8 }}>
      <div className="srow">
        <StatusDot level={s.enabled ? s.state : 'off'} />
        <button className="srow__name" style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', color: 'inherit', font: 'inherit' }} onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="cardrow__title">{s.name}</span>
          <span className="cardrow__sub" style={{ display: 'block' }}>
            {!s.enabled
              ? 'Not followed'
              : s.error
                ? `Can’t read it: ${s.error}`
                : s.checkedAt
                  ? `Checked ${relativeTime(s.checkedAt)}${s.only.length ? ` · only ${s.only.join(', ')}` : ''}`
                  : 'Checked within the next 15 minutes'}
          </span>
        </button>
        <input type="checkbox" aria-label={`Follow ${s.name}`} checked={s.enabled} onChange={(e) => onSave({ enabled: e.target.checked })} />
      </div>
      {open && (
        <div style={{ display: 'grid', gap: 6 }}>
          <span className="hint">{KIND_NOTE[s.kind]}</span>
          <label className="hint" htmlFor={`only-${s.id}`}>
            Only count problems naming (commas between; empty = everything)
          </label>
          <div className="inline">
            <input id={`only-${s.id}`} className="input" value={words} placeholder="e.g. Workers, D1, R2" onChange={(e) => setWords(e.target.value)} />
            <button className="btn btn--small" disabled={!changed} onClick={() => onSave({ only: parsed })}>
              Save
            </button>
          </div>
          <span className="hint">
            Matched against the problem’s title and the parts it says are affected. Others still appear on the System status page under “Also
            open, not counted”.
          </span>
          <div className="inline">
            <a className="btn btn--small" href={s.pageUrl ?? s.feedUrl} target="_blank" rel="noreferrer">
              Open its status page
            </a>
            {s.custom && (
              <button className="btn btn--small" onClick={onRemove}>
                Remove
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function HomeCard({ home, onSave }: { home: HomeArea | null; onSave: (home: HomeArea | null) => void }) {
  const [label, setLabel] = useState(home?.label ?? '');
  const [lat, setLat] = useState(home ? String(home.lat) : '');
  const [lng, setLng] = useState(home ? String(home.lng) : '');
  const [radius, setRadius] = useState(home?.radiusKm ?? 5);
  const [note, setNote] = useState<string | null>(null);
  const valid = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && lat.trim() !== '' && lng.trim() !== '';

  function locate() {
    if (!navigator.geolocation) return setNote('This browser can’t share its location; type the numbers in instead.');
    setNote('Finding where you are…');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLat(p.coords.latitude.toFixed(4));
        setLng(p.coords.longitude.toFixed(4));
        setNote('Filled in from this device. Check it, then Save.');
      },
      () => setNote('Location wasn’t shared; type the numbers in instead.'),
      { timeout: 15000 },
    );
  }

  return (
    <div className="section">
      <span className="label">Home area (power, mobile and internet outages)</span>
      <section className="card" style={{ display: 'grid', gap: 8 }}>
        <input className="input" placeholder="Name, e.g. your suburb" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Home area name" />
        <div className="inline">
          <input className="input" inputMode="decimal" placeholder="Latitude, e.g. -36.9" value={lat} onChange={(e) => setLat(e.target.value)} aria-label="Latitude" />
          <input className="input" inputMode="decimal" placeholder="Longitude, e.g. 174.9" value={lng} onChange={(e) => setLng(e.target.value)} aria-label="Longitude" />
        </div>
        <label className="switchrow">
          <span style={{ fontSize: 14 }}>Count outages within</span>
          <select className="input" style={{ width: 'auto' }} value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
            {HOME_RADIUS_KM.map((k) => (
              <option key={k} value={k}>
                {k} km
              </option>
            ))}
          </select>
        </label>
        <div className="inline">
          <button className="btn btn--small" type="button" onClick={locate}>
            Use this device’s location
          </button>
          <button
            className="btn btn--small"
            type="button"
            disabled={!valid}
            onClick={() => onSave({ label: label.trim(), lat: Number(lat), lng: Number(lng), radiusKm: radius })}
          >
            Save
          </button>
          {home && (
            <button className="btn btn--small" type="button" onClick={() => onSave(null)}>
              Clear
            </button>
          )}
        </div>
        {note && <span className="hint">{note}</span>}
        <span className="hint">
          {home
            ? `Saved${home.label ? `: ${home.label}` : ''}. Power cuts are matched to the outage areas on Vector’s map; mobile and internet outages to the sites One NZ and Chorus list.`
            : 'Not set, so the power, mobile and internet checks are waiting. Tip: right-click your house in Google Maps on a computer to copy its latitude and longitude.'}{' '}
          Kept only in this app’s settings.
        </span>
      </section>
    </div>
  );
}

export function StatusSettingsPage({ onChanged }: { onChanged: () => void }) {
  const navigate = useNavigate();
  const [view, setView] = useState<StatusSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api
      .statusSettings()
      .then(setView)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, []);

  async function run(p: Promise<StatusSettingsView>) {
    setError(null);
    try {
      setView(await p);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  const saveSettings = (patch: Partial<StatusSettings>) => {
    if (view) setView({ ...view, settings: { ...view.settings, ...patch } });
    void run(api.saveStatusSettings(patch));
  };

  async function add(e: FormEvent) {
    e.preventDefault();
    setAdding(true);
    await run(api.addStatusService(name, url));
    setAdding(false);
    setName('');
    setUrl('');
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>System status</h1>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      {!view && !error && <div className="spinner">Loading…</div>}
      {view && (
        <>
          <div className="section">
            <span className="label">In the inbox</span>
            <section className="card">
              <label className="switchrow">
                <span style={{ fontSize: 14 }}>Banner while something is broken</span>
                <input type="checkbox" checked={view.settings.banner} onChange={(e) => saveSettings({ banner: e.target.checked })} />
              </label>
              <label className="switchrow">
                <span style={{ fontSize: 14 }}>Count a problem once it’s lasted</span>
                <select className="input" style={{ width: 'auto' }} value={view.settings.minMinutes} onChange={(e) => saveSettings({ minMinutes: Number(e.target.value) })}>
                  {STATUS_MIN_MINUTES.map((m) => (
                    <option key={m} value={m}>
                      {m === 0 ? 'Straight away' : `${m} min`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="switchrow">
                <span style={{ fontSize: 14 }}>Keep fixed problems for</span>
                <select className="input" style={{ width: 'auto' }} value={view.settings.keepDays} onChange={(e) => saveSettings({ keepDays: Number(e.target.value) })}>
                  {STATUS_KEEP_DAYS.map((d) => (
                    <option key={d} value={d}>
                      {d} days
                    </option>
                  ))}
                </select>
              </label>
              <span className="hint">
                The Status button at the top of the inbox shows a green, amber or red dot and opens <Link to="/status">System status</Link>.
                Status pages never add items to the inbox. Services are checked every hour, and every 15 minutes while one has a
                problem open.
              </span>
            </section>
          </div>

          <HomeCard key={JSON.stringify(view.settings.home)} home={view.settings.home} onSave={(home) => saveSettings({ home })} />

          <div className="section">
            <span className="label">Services · tap one for its words</span>
            <div className="card card--list">
              {view.services.map((s) => (
                <ServiceRow
                  key={s.id}
                  s={s}
                  onSave={(patch) => void run(api.updateStatusService(s.id, patch))}
                  onRemove={() => void run(api.removeStatusService(s.id))}
                />
              ))}
            </div>
          </div>

          <div className="section">
            <span className="label">Add another status page</span>
            <section className="card">
              <form onSubmit={(e) => void add(e)} style={{ display: 'grid', gap: 8 }}>
                <input className="input" placeholder="Name, e.g. Slack" value={name} onChange={(e) => setName(e.target.value)} />
                <input className="input" placeholder="Status page or feed, e.g. status.slack.com" value={url} onChange={(e) => setUrl(e.target.value)} />
                <button className="btn btn--small" type="submit" disabled={adding || !name.trim() || !url.trim()} style={{ justifySelf: 'start' }}>
                  {adding ? 'Checking…' : 'Add'}
                </button>
              </form>
              <span className="hint">
                Works with most company status pages (the ones run on Atlassian Statuspage, with a “Subscribe to updates” button), and with
                Google, AWS and Azure status feeds.
              </span>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
