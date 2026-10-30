import type { AppSettings, ItemKind, Me, Source } from '@newsletterapp/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { shortTime } from '../format';
import { DENSITIES, TEXT_SIZES, getHideSponsored, getTextSize, setDensity, setHideSponsored, setTextSize, type TextSize } from '../prefs';
import { useDensity } from '../components/DensityToggle';

export function SettingsPage({ me }: { me: Me }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.sources().then(setSources).catch(() => undefined);
    api
      .settings()
      .then(setSettings)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load settings'));
  }, []);

  async function save(patch: Partial<AppSettings>) {
    if (!settings) return;
    const before = settings;
    setSettings({ ...settings, ...patch });
    try {
      setSettings(await api.saveSettings(patch));
    } catch (err) {
      setSettings(before);
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles">
          <h1>Settings</h1>
        </div>
      </header>

      <div className="section">
        <span className="label">Sources</span>
        <div className="card card--list">
          <Link to="/add" className="cardrow">
            <div className="cardrow__main">
              <span className="cardrow__title">Sign-up addresses</span>
              <span className="cardrow__sub">Create an address for a newsletter, or block one</span>
            </div>
          </Link>
          <Link to="/senders" className="cardrow">
            <div className="cardrow__main">
              <span className="cardrow__title">Senders</span>
              <span className="cardrow__sub">Allow or block who can reach your inbox</span>
            </div>
          </Link>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <ReadingSection />
      {settings && <DigestSection settings={settings} onSave={save} />}
      {settings && <CategoriesSection settings={settings} onSave={save} />}
      {settings && <AiSection settings={settings} onSave={save} />}

      {sources.length > 0 && (
        <div className="section">
          <span className="label">Newsletters you receive</span>
          <div className="card card--list">
            {sources.map((s) => (
              <Link key={s.id} to={`/source/${s.id}`} className="cardrow">
                <div className="cardrow__main">
                  <span className="cardrow__title">{s.name}</span>
                  <span className="cardrow__sub">
                    {s.itemCount} issue{s.itemCount === 1 ? '' : 's'}
                    {s.lastReceivedAt ? ` · last ${shortTime(s.lastReceivedAt)}` : ''}
                    {s.category ? ` · ${s.category}` : ''}
                    {s.aiMode !== 'default' ? ` · AI ${s.aiMode}` : ''}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="section">
        <span className="label">Account</span>
        <div className="card card--list">
          <div className="cardrow">
            <div className="cardrow__main">
              <span className="cardrow__title">Signed in as {me.email}</span>
              <span className="cardrow__sub">
                {me.domain ? `Newsletters are sent to @${me.domain}` : 'Mail domain not configured yet'}
              </span>
            </div>
          </div>
          <a href="/cdn-cgi/access/logout" className="cardrow">
            <div className="cardrow__main">
              <span className="cardrow__title">Sign out</span>
            </div>
          </a>
        </div>
      </div>

      <p className="hint" style={{ padding: '0 16px' }}>
        Quick summaries are on. AI summaries come from the PC helper once it is set up. Feeds and websites come later.
      </p>
    </div>
  );
}

function CategoriesSection({ settings, onSave }: { settings: AppSettings; onSave: (p: Partial<AppSettings>) => Promise<void> }) {
  const [name, setName] = useState('');
  const [words, setWords] = useState('');
  const [ruleCategory, setRuleCategory] = useState(settings.categories[0] ?? '');

  function addCategory(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n || settings.categories.includes(n)) return;
    void onSave({ categories: [...settings.categories, n] });
    setName('');
  }

  function addRule(e: FormEvent) {
    e.preventDefault();
    if (!words.trim() || !ruleCategory) return;
    void onSave({ keywordRules: [...settings.keywordRules, { match: words.trim(), category: ruleCategory }] });
    setWords('');
  }

  return (
    <div className="section">
      <span className="label">Categories</span>
      <section className="card">
        <div className="chipedit">
          {settings.categories.map((c) => (
            <span key={c} className="chip chip--category">
              {c}
              <button
                aria-label={`Remove ${c}`}
                onClick={() => void onSave({ categories: settings.categories.filter((x) => x !== c) })}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <form className="inline" onSubmit={addCategory}>
          <input className="input" placeholder="New category" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn--small" type="submit">
            Add
          </button>
        </form>
        <span className="hint">
          Set each newsletter's usual category on its page below. Keyword rules override it for single issues.
        </span>
      </section>

      <span className="label">Keyword rules</span>
      <section className="card">
        {settings.keywordRules.length === 0 && <span className="hint">No rules yet.</span>}
        {settings.keywordRules.map((r, i) => (
          <div key={`${r.match}-${i}`} className="switchrow">
            <span style={{ fontSize: 14 }}>
              “{r.match}” → <strong>{r.category}</strong>
            </span>
            <button
              className="btn btn--ghost btn--small"
              onClick={() => void onSave({ keywordRules: settings.keywordRules.filter((_, j) => j !== i) })}
            >
              Remove
            </button>
          </div>
        ))}
        <form className="field" onSubmit={addRule}>
          <input
            className="input"
            placeholder="Words in the subject, e.g. Fed, interest rates"
            value={words}
            onChange={(e) => setWords(e.target.value)}
          />
          <div className="inline">
            <select className="input" value={ruleCategory} onChange={(e) => setRuleCategory(e.target.value)}>
              {settings.categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <button className="btn btn--small" type="submit">
              Add rule
            </button>
          </div>
        </form>
        <span className="hint">Rules apply to new issues as they arrive.</span>
      </section>
    </div>
  );
}

const KIND_LABEL: Record<ItemKind, string> = { newsletter: 'Newsletters', feed: 'RSS feeds', site: 'Websites' };

function AiSection({ settings, onSave }: { settings: AppSettings; onSave: (p: Partial<AppSettings>) => Promise<void> }) {
  const [interests, setInterests] = useState(settings.interests);

  return (
    <div className="section">
      <span className="label">AI summaries</span>
      <section className="card">
        {(Object.keys(KIND_LABEL) as ItemKind[]).map((kind) => (
          <label key={kind} className="switchrow">
            <span style={{ fontSize: 15 }}>{KIND_LABEL[kind]}</span>
            <input
              type="checkbox"
              checked={settings.aiByKind[kind]}
              onChange={(e) => void onSave({ aiByKind: { ...settings.aiByKind, [kind]: e.target.checked } })}
            />
          </label>
        ))}
        <span className="hint">
          Which items go to the AI on your PC. Each newsletter can override this on its own page. Everything always gets the
          quick summary.
        </span>
        <div className="field">
          <label htmlFor="interests">Your interests</label>
          <input
            id="interests"
            className="input"
            placeholder="e.g. AI, investing, home tech"
            value={interests}
            onChange={(e) => setInterests(e.target.value)}
            onBlur={() => interests !== settings.interests && void onSave({ interests })}
          />
          <span className="hint">Used for the “why it matters” line in AI summaries.</span>
        </div>
      </section>
      <div className="card card--list">
        <Link to="/settings/ai" className="cardrow">
          <div className="cardrow__main">
            <span className="cardrow__title">PC helper, models and prompts</span>
            <span className="cardrow__sub">Status, which models to use, the summary prompt, test runs, setup</span>
          </div>
        </Link>
        <Link to="/stats" className="cardrow">
          <div className="cardrow__main">
            <span className="cardrow__title">AI statistics</span>
            <span className="cardrow__sub">Summary value by model, newsletter and prompt, month by month</span>
          </div>
        </Link>
      </div>
    </div>
  );
}

/** Text size and sponsored-section hiding, remembered on this device only. */
function ReadingSection() {
  const [size, setSize] = useState<TextSize>(getTextSize());
  const [hideSponsored, setHide] = useState(getHideSponsored());
  const density = useDensity();

  function pick(next: TextSize) {
    setTextSize(next);
    setSize(next);
  }

  return (
    <div className="section">
      <span className="label">Reading</span>
      <section className="card">
        <div className="field">
          <label>Text size</label>
          <div className="segmented" role="group" aria-label="Text size">
            {TEXT_SIZES.map((t) => (
              <button key={t.id} aria-pressed={size === t.id} onClick={() => pick(t.id)} style={{ fontSize: t.px - 3 }}>
                {t.label}
              </button>
            ))}
          </div>
          <span className="hint">Applies to newsletter text in the reader on this device.</span>
        </div>
        <div className="field">
          <label>Inbox view</label>
          <div className="segmented" role="group" aria-label="Inbox view">
            {DENSITIES.map((d) => (
              <button key={d.id} aria-pressed={density === d.id} onClick={() => setDensity(d.id)}>
                {d.label}
              </button>
            ))}
          </div>
          <span className="hint">{DENSITIES.find((d) => d.id === density)?.hint}. The icon at the top of the inbox switches too.</span>
        </div>
        <label className="switchrow">
          <span style={{ fontSize: 15 }}>Hide sponsored sections</span>
          <input
            type="checkbox"
            checked={hideSponsored}
            onChange={(e) => {
              setHideSponsored(e.target.checked);
              setHide(e.target.checked);
            }}
          />
        </label>
        <span className="hint">
          Sponsor blocks are collapsed in the reader; a note shows how many, with a tap to reveal them. Images are off until
          you tap “Load images”, or “Always” for that newsletter.
        </span>
      </section>
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'am' : 'pm'}`;

/** When the daily digest is built, in which time zone, plus a build-now button. */
function DigestSection({ settings, onSave }: { settings: AppSettings; onSave: (p: Partial<AppSettings>) => Promise<void> }) {
  const [building, setBuilding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = [...new Set([settings.timezone, deviceZone, 'UTC'])];

  async function buildNow() {
    setBuilding(true);
    setNote(null);
    try {
      const d = await api.buildDigest();
      setNote('empty' in d ? 'Nothing to digest yet: no issues arrived in the window.' : `Built today's digest from ${d.itemCount} issue${d.itemCount === 1 ? '' : 's'}.`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not build the digest');
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div className="section">
      <span className="label">Daily digest</span>
      <section className="card">
        <div className="inline">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="digest-hour">Build at</label>
            <select
              id="digest-hour"
              className="input"
              value={settings.digestHour}
              onChange={(e) => void onSave({ digestHour: Number(e.target.value) })}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 2 }}>
            <label htmlFor="digest-zone">Time zone</label>
            <select
              id="digest-zone"
              className="input"
              value={settings.timezone}
              onChange={(e) => void onSave({ timezone: e.target.value })}
            >
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z === deviceZone ? `${z} (this device)` : z}
                </option>
              ))}
            </select>
          </div>
        </div>
        <span className="hint">
          Once a day the top stories from the last 24 hours are grouped by topic, Techmeme style, using the summaries and
          your reading habits. Nothing extra is sent to the AI.
        </span>
        <div className="inline">
          <button className="btn btn--small" disabled={building} onClick={() => void buildNow()}>
            {building ? 'Building…' : 'Build now'}
          </button>
          <Link to="/digest" className="btn btn--ghost btn--small">
            Open digest
          </Link>
        </div>
        {note && <span className="hint">{note}</span>}
      </section>
    </div>
  );
}
