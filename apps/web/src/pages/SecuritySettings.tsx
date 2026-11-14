import {
  HIBP_SITE,
  breachFromHibp,
  breachesInText,
  leakedPhrase,
  type BreachInfo,
  type SecuritySettings,
  type SecuritySettingsView,
  type WatchEntry,
  type WatchStatus,
} from '@newsletterapp/shared';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { relativeTime } from '../format';
import { IconBack, IconCopy } from '../icons';

// Settings > Security alerts: the alerts address, the addresses and domains
// watched (with whose they are), how to set each one up at Have I Been Pwned,
// and how the inbox shows a breach. Add past breaches fills the history once.

const isDomain = (t: string) => !t.includes('@');
const provider = (t: string) => {
  const d = t.split('@')[1] ?? '';
  return /gmail|googlemail/.test(d) ? 'gmail' : /hotmail|outlook|live\.|msn/.test(d) ? 'outlook' : null;
};

/** The steps at HIBP (and the mailbox) for one watched address or domain. */
function setupSteps(w: WatchStatus, alerts: string, mailDomain: boolean): string[] {
  if (w.kind === 'domain') {
    return [
      `At ${HIBP_SITE.replace('https://', '')}, sign in with ${alerts} (the code arrives on the Security page).`,
      `Domain search › add ${w.target} › verify it with a TXT record at its DNS host${mailDomain ? ' (Cloudflare for this one)' : ''}.`,
      'Alerts for every address on the domain then go to the address you signed in with. Free while 10 or fewer of its addresses have been in breaches.',
    ];
  }
  const p = provider(w.target);
  return [
    `At ${HIBP_SITE.replace('https://', '')}, use Notify me with ${w.target} and confirm the email it sends there.`,
    p === 'gmail'
      ? `In Gmail: Settings › Forwarding › add ${alerts} (confirm it from the Security page), then a filter: from noreply@haveibeenpwned.com › forward to ${alerts}.`
      : p === 'outlook'
        ? `In Outlook.com: Settings › Mail › Rules › new rule: from noreply@haveibeenpwned.com › forward to ${alerts}.`
        : `In that mailbox, forward mail from noreply@haveibeenpwned.com to ${alerts} (or forward each alert by hand).`,
  ];
}

function WatchRow({
  w,
  alerts,
  mailDomain,
  onSave,
  onRemove,
}: {
  w: WatchStatus;
  alerts: string;
  mailDomain: boolean;
  onSave: (patch: Partial<WatchEntry>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(!w.setupDone);
  const [person, setPerson] = useState(w.person);
  useEffect(() => setPerson(w.person), [w.person]);
  const state = w.setupDone ? 'ok' : 'minor';
  return (
    <div className="cardrow secwatch">
      <div className="secwatch__head">
        <span className={`sdot sdot--${state}`} aria-hidden="true" />
        <button
          className="srow__name"
          style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', color: 'inherit', font: 'inherit' }}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <span className="cardrow__title" style={{ overflowWrap: 'anywhere' }}>
            {w.target}
          </span>
          <span className="cardrow__sub" style={{ display: 'block' }}>
            {[
              w.person || null,
              w.kind === 'domain' ? 'whole domain' : 'one address',
              !w.setupDone ? 'set-up not ticked yet' : w.lastAlertAt ? `last alert ${relativeTime(w.lastAlertAt)}` : 'no alert yet',
              w.breaches ? `${w.breaches} breach${w.breaches === 1 ? '' : 'es'}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </button>
      </div>
      {open && (
        <div style={{ display: 'grid', gap: 8 }}>
          <ol className="secwatch__steps">
            {setupSteps(w, alerts, mailDomain).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <label className="switchrow">
            <span style={{ fontSize: 14 }}>Set up at Have I Been Pwned</span>
            <input type="checkbox" checked={w.setupDone} onChange={(e) => onSave({ setupDone: e.target.checked })} />
          </label>
          <div className="inline">
            <input className="input" aria-label="Whose it is" placeholder="Whose, e.g. Me or Sam" value={person} onChange={(e) => setPerson(e.target.value)} />
            <button className="btn btn--small" disabled={person.trim() === w.person} onClick={() => onSave({ person: person.trim() })}>
              Save
            </button>
            <button className="btn btn--small" onClick={onRemove}>
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SecuritySettingsPage({ onChanged }: { onChanged: () => void }) {
  const navigate = useNavigate();
  const [view, setView] = useState<SecuritySettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [person, setPerson] = useState('Me');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api
      .securitySettings()
      .then(setView)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, []);

  async function save(patch: Partial<SecuritySettings>) {
    setError(null);
    if (view) setView({ ...view, settings: { ...view.settings, ...patch } });
    try {
      setView(await api.saveSecuritySettings(patch));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  const entries = (): WatchEntry[] => view?.settings.watch ?? [];
  const saveWatch = (list: WatchEntry[]) => void save({ watch: list });

  function add(e: FormEvent) {
    e.preventDefault();
    let t = target.trim().toLowerCase();
    if (t.startsWith('@')) t = t.slice(1);
    if (!t) return;
    if (entries().some((w) => w.target === t)) return setError('Already watched');
    saveWatch([...entries(), { id: '', target: t, person: person.trim(), setupDone: false }]);
    setTarget('');
  }

  async function copy() {
    if (!view) return;
    try {
      await navigator.clipboard.writeText(view.alertsAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Couldn’t copy; select the address instead');
    }
  }

  const mailDomain = view?.alertsAddress.split('@')[1] ?? '';
  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Security alerts</h1>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      {!view && !error && <div className="spinner">Loading…</div>}
      {view && (
        <>
          <div className="section">
            <span className="label">Your alerts address</span>
            <section className="card" style={{ display: 'grid', gap: 8 }}>
              <div className="inline">
                <span style={{ fontWeight: 600, flex: 1, overflowWrap: 'anywhere' }}>{view.alertsAddress}</span>
                <button className="btn btn--small" onClick={() => void copy()} aria-label="Copy the alerts address">
                  <IconCopy size={15} /> {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <span className="hint">
                Sign in to Have I Been Pwned with this address and send its alerts here. Mail to it skips New senders, never reaches the inbox and shows on
                the <Link to="/security">Security page</Link>.{' '}
                {view.hibpMailSeen ? 'Mail from Have I Been Pwned has arrived, so signing in worked.' : 'Nothing from Have I Been Pwned has arrived yet.'}
              </span>
            </section>
          </div>

          <div className="section">
            <span className="label">Watching · tap one for its set-up steps</span>
            {view.watch.length > 0 && (
              <div className="card card--list">
                {view.watch.map((w) => (
                  <WatchRow
                    key={w.id}
                    w={w}
                    alerts={view.alertsAddress}
                    mailDomain={w.target === mailDomain}
                    onSave={(patch) => saveWatch(entries().map((e) => (e.id === w.id ? { ...e, ...patch } : e)))}
                    onRemove={() => saveWatch(entries().filter((e) => e.id !== w.id))}
                  />
                ))}
              </div>
            )}
            <section className="card" style={{ marginTop: view.watch.length ? 10 : 0 }}>
              <form onSubmit={add} style={{ display: 'grid', gap: 8 }}>
                <input
                  className="input"
                  placeholder={view.watch.length ? 'Another address or domain' : `An address, or a domain like ${mailDomain}`}
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  aria-label="Address or domain to watch"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <div className="inline">
                  <input className="input" placeholder="Whose, e.g. Me" value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Whose it is" />
                  <button className="btn btn--small" type="submit" disabled={!target.trim()}>
                    Watch
                  </button>
                </div>
              </form>
              <span className="hint">
                A domain covers every address on it (all your newsletter addresses on {mailDomain}, or a family domain). Give family addresses their own
                name so their alerts say whose it is and add “Tell them”. Kept only in this app’s settings.
              </span>
            </section>
            <Link to="/settings/security/past" className="btn btn--small" style={{ margin: '10px 16px 0', display: 'inline-flex' }}>
              Add past breaches
            </Link>
          </div>

          <div className="section">
            <span className="label">In the inbox</span>
            <section className="card">
              <label className="switchrow">
                <span style={{ fontSize: 14 }}>Banner until a breach is handled</span>
                <input type="checkbox" checked={view.settings.banner} onChange={(e) => void save({ banner: e.target.checked })} />
              </label>
              <label className="switchrow">
                <span style={{ fontSize: 14 }}>Warn about sites I get mail from</span>
                <input type="checkbox" checked={view.settings.siteWatch} onChange={(e) => void save({ siteWatch: e.target.checked })} />
              </label>
              <label className="switchrow">
                <span style={{ fontSize: 14 }}>Banner for email-only leaks too</span>
                <input type="checkbox" checked={view.settings.bannerLow} onChange={(e) => void save({ bannerLow: e.target.checked })} />
              </label>
              <span className="hint">
                The shield at the top of the inbox shows a red dot when a password or bank detail leaked, amber for other personal details, sites you get mail
                from and email-only leaks, green when there’s nothing to do. Once an hour the app reads Have I Been Pwned’s newest breach and flags it if a
                newsletter or feed you follow comes from that site.
                {view.lastCheckAt ? ` Last checked ${relativeTime(view.lastCheckAt)}.` : ''}
                {view.checkError ? ` Last check failed: ${view.checkError}.` : ''}
              </span>
            </section>
          </div>

          <div className="section">
            <span className="label">Privacy</span>
            <section className="card">
              <span className="hint">
                The addresses here stay in this app. The app never sends them anywhere: it only downloads Have I Been Pwned’s public list of breaches,
                which has no addresses in it. Have I Been Pwned does the matching and emails you. Breach mail is never summarised by AI, searched on the
                web or written to logs. Your breach history is part of Backup and export.
              </span>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Add past breaches ----------

const PICK_SHOWN = 60;

export function AddPastBreachesPage({ onChanged }: { onChanged: () => void }) {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<SecuritySettingsView | null>(null);
  const [catalogue, setCatalogue] = useState<BreachInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [mode, setMode] = useState<'pick' | 'paste'>('pick');
  const [query, setQuery] = useState('');
  const [pasted, setPasted] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [handled, setHandled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    api
      .securitySettings()
      .then((v) => {
        setSettings(v);
        const first = v.watch.find((w) => w.kind === 'address') ?? v.watch[0];
        if (first) setAddress(first.target);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
    api
      .securityCatalogue()
      .then((list) =>
        setCatalogue(
          (Array.isArray(list) ? list : [])
            .map(breachFromHibp)
            .filter((b): b is BreachInfo => !!b)
            .sort((a, b) => a.title.localeCompare(b.title)),
        ),
      )
      .catch((err: unknown) => setError(err instanceof Error ? `Couldn’t load Have I Been Pwned’s breach list: ${err.message}` : 'Couldn’t load the breach list'));
  }, []);

  const byName = useMemo(() => new Map((catalogue ?? []).map((b) => [b.name, b])), [catalogue]);
  const matches = useMemo(() => {
    if (!catalogue) return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return catalogue.filter((b) => b.title.toLowerCase().includes(q) || b.name.toLowerCase().includes(q) || b.domain.includes(q));
  }, [catalogue, query]);

  const watch = settings?.watch ?? [];
  const entry = watch.find((w) => w.target === address);
  const toggle = (name: string) => setPicked((p) => (p.includes(name) ? p.filter((n) => n !== name) : [...p, name]));

  function readPaste() {
    if (!catalogue) return;
    const found = breachesInText(pasted, catalogue);
    setPicked((p) => [...new Set([...p, ...found])]);
    setDone(found.length ? `Found ${found.length} breach${found.length === 1 ? '' : 'es'}; check the ticks below.` : 'No breach names found in that text.');
  }

  async function submit() {
    const breaches = picked.map((n) => byName.get(n)).filter((b): b is BreachInfo => !!b);
    setBusy(true);
    setError(null);
    try {
      const target = address.includes('@') ? address : address.replace(/^@?/, '@');
      const res = await api.addPastBreaches({ address: target, person: entry?.person ?? '', handled, breaches });
      setDone(`Added ${res.added} breach${res.added === 1 ? '' : 'es'} for ${address}.`);
      setPicked([]);
      setPasted('');
      setQuery('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add');
    } finally {
      setBusy(false);
    }
  }

  const row = (b: BreachInfo) => (
    <label key={b.name} className="cardrow sectodo">
      <input type="checkbox" checked={picked.includes(b.name)} onChange={() => toggle(b.name)} />
      <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
        <span style={{ fontWeight: 600 }}>{b.title}</span>
        <span className="cardrow__sub">
          {[b.breachDate?.slice(0, 4), b.pwnCount ? `${b.pwnCount.toLocaleString()} accounts` : null, b.spamList ? 'spam list' : leakedPhrase(b.dataClasses)]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
    </label>
  );

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Add past breaches</h1>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      {done && <div className="notice notice--teal-tint">{done}</div>}
      <div className="section">
        <span className="hint" style={{ margin: '0 16px', display: 'block' }}>
          Look the address up at{' '}
          <a href={HIBP_SITE} target="_blank" rel="noreferrer">
            haveibeenpwned.com
          </a>{' '}
          (free; for a whole domain, its Domain search page), then tick the same breaches here. Dates and what leaked fill in by themselves.
        </span>
      </div>

      <div className="section">
        <label className="label" htmlFor="past-address">
          Address
        </label>
        <section className="card" style={{ display: 'grid', gap: 8 }}>
          {watch.length > 0 && (
            <select id="past-address" className="input" value={watch.some((w) => w.target === address) ? address : ''} onChange={(e) => setAddress(e.target.value)}>
              {watch.map((w) => (
                <option key={w.id} value={w.target}>
                  {w.target}
                  {w.person ? ` · ${w.person}` : ''}
                  {isDomain(w.target) ? ' (whole domain)' : ''}
                </option>
              ))}
              <option value="">Another address…</option>
            </select>
          )}
          {(!watch.length || !watch.some((w) => w.target === address)) && (
            <input
              className="input"
              placeholder="Email address"
              value={address}
              onChange={(e) => setAddress(e.target.value.trim().toLowerCase())}
              aria-label="Email address"
              autoCapitalize="off"
              spellCheck={false}
            />
          )}
        </section>
      </div>

      <div className="section">
        <div className="secchips">
          <button className="pill" aria-pressed={mode === 'pick'} onClick={() => setMode('pick')}>
            Pick from list
          </button>
          <button className="pill" aria-pressed={mode === 'paste'} onClick={() => setMode('paste')}>
            Paste results
          </button>
        </div>
        {!catalogue && !error && <div className="spinner">Loading Have I Been Pwned’s breach list…</div>}
        {catalogue && mode === 'pick' && (
          <section className="card" style={{ display: 'grid', gap: 8 }}>
            <input className="input" type="search" placeholder={`Search ${catalogue.length.toLocaleString()} breaches`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search breaches" />
            {query.trim() && matches.length === 0 && <span className="hint">No breach by that name.</span>}
          </section>
        )}
        {catalogue && mode === 'paste' && (
          <section className="card" style={{ display: 'grid', gap: 8 }}>
            <textarea
              className="input"
              rows={6}
              placeholder="Select all on the results page, copy, and paste here"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              aria-label="Pasted results"
            />
            <button className="btn btn--small" style={{ justifySelf: 'start' }} disabled={!pasted.trim()} onClick={readPaste}>
              Find the breaches
            </button>
          </section>
        )}
        {catalogue && mode === 'pick' && matches.length > 0 && (
          <div className="card card--list secpick" style={{ marginTop: 10 }}>
            {matches.slice(0, PICK_SHOWN).map(row)}
          </div>
        )}
        {matches.length > PICK_SHOWN && <span className="hint" style={{ margin: '6px 16px 0', display: 'block' }}>Showing {PICK_SHOWN} of {matches.length}; type more to narrow it.</span>}
      </div>

      {picked.length > 0 && (
        <div className="section">
          <span className="label">Ticked · {picked.length}</span>
          <div className="card card--list">{picked.map((n) => byName.get(n)).filter((b): b is BreachInfo => !!b).map(row)}</div>
        </div>
      )}

      <div className="section">
        <section className="card">
          <label className="switchrow">
            <span style={{ fontSize: 14 }}>Already dealt with (no banner)</span>
            <input type="checkbox" checked={handled} onChange={(e) => setHandled(e.target.checked)} />
          </label>
        </section>
        <button className="btn btn--primary" style={{ margin: '12px 16px 0' }} disabled={busy || !picked.length || !address.trim()} onClick={() => void submit()}>
          {busy ? 'Adding…' : `Add ${picked.length || ''} breach${picked.length === 1 ? '' : 'es'}`}
        </button>
        <Link to="/security" className="btn btn--small" style={{ margin: '12px 0 0 8px' }}>
          Security page
        </Link>
      </div>
    </div>
  );
}
