import type { Address, DiscoverResult, DiscoveredFeed, Me, NewSourceResult } from '@newsletterapp/shared';
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { shortTime } from '../format';
import { IconBack, IconCopy } from '../icons';

export function AddPage({ me }: { me: Me }) {
  const navigate = useNavigate();
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<Address | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    api.addresses().then(setAddresses).catch(() => undefined);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const a = await api.createAddress(label.trim());
      setCreated(a);
      setAddresses((prev) => [a, ...prev]);
      setLabel('');
      await copy(a.email);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the address');
    } finally {
      setBusy(false);
    }
  }

  async function copy(email: string) {
    try {
      await navigator.clipboard.writeText(email);
      setCopied(email);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard can be unavailable (http, older browsers); the address is still shown.
    }
  }

  async function toggleBlock(a: Address) {
    try {
      const updated = await api.addressAction(a.id, a.status === 'blocked' ? 'unblock' : 'block');
      setAddresses((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Add</h1>
        </div>
      </header>

      <FollowSection />
      <OpmlSection />

      <div className="section">
        <span className="label">A newsletter</span>
        <form className="card" onSubmit={submit}>
          <p className="hint" style={{ margin: 0 }}>
            Use a new address for each newsletter, so you always know who sent what, and who shared your address.
          </p>
          <div className="field">
            <label htmlFor="nl-name">Newsletter name</label>
            <input
              id="nl-name"
              className="input"
              placeholder="e.g. Money Matters"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoComplete="off"
            />
          </div>
          {me.domain ? null : (
            <p className="hint" style={{ margin: 0, color: 'var(--amber-ink)' }}>
              MAIL_DOMAIN isn't set yet, so only the first half of the address is shown. Add it as a deploy variable (see README).
            </p>
          )}
          <button className="btn btn--primary" disabled={busy || !label.trim()} type="submit">
            Create address
          </button>
          {error && <div className="error" style={{ margin: 0 }}>{error}</div>}
          {created && (
            <>
              <div className="addressbox">
                <strong>{created.email}</strong>
                <button type="button" className="btn btn--primary btn--small" onClick={() => void copy(created.email)}>
                  <IconCopy size={16} /> {copied === created.email ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="hint" style={{ margin: 0 }}>
                Paste it into the newsletter's sign-up form. The confirmation email will appear in your inbox here, and the first
                sender to this address is allowed automatically.
              </p>
            </>
          )}
        </form>
      </div>

      {addresses.length > 0 && (
        <div className="section">
          <span className="label">Your addresses</span>
          <div className="card card--list">
            {addresses.map((a) => (
              <div key={a.id} className="cardrow">
                <div className="cardrow__main">
                  <span className="cardrow__title">{a.label ?? a.localPart}</span>
                  <span className="cardrow__sub">
                    {a.email}
                    {a.status === 'blocked'
                      ? ` · blocked · ${a.blockedCount} email${a.blockedCount === 1 ? '' : 's'} stopped`
                      : a.approvedSenderCount > 0
                        ? ` · ${a.approvedSenderCount} allowed sender${a.approvedSenderCount === 1 ? '' : 's'}`
                        : ' · waiting for its first email'}
                  </span>
                </div>
                <button className="iconbtn" aria-label={`Copy ${a.email}`} onClick={() => void copy(a.email)}>
                  <IconCopy size={18} />
                </button>
                <button className="btn btn--small" onClick={() => void toggleBlock(a)}>
                  {a.status === 'blocked' ? 'Unblock' : 'Block'}
                </button>
              </div>
            ))}
          </div>
          <p className="hint">Block an address if it starts getting spam or was passed on. Everything sent to it is then dropped.</p>
        </div>
      )}
    </div>
  );
}

/**
 * Paste a site, blog or feed address: the app finds the feed, or offers to
 * watch the page for new articles when there isn't one. Opening /add?url=...
 * fills it in and looks straight away (for sharing a link into the app).
 */
function FollowSection() {
  const [params] = useSearchParams();
  const [url, setUrl] = useState(params.get('url') ?? params.get('text') ?? '');
  const [found, setFound] = useState<DiscoverResult | null>(null);
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<NewSourceResult | null>(null);
  const started = useRef(false);

  async function look(e?: FormEvent) {
    e?.preventDefault();
    if (!url.trim()) return;
    setLooking(true);
    setError(null);
    setFound(null);
    setDone(null);
    try {
      setFound(await api.discoverSource(url.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not look up that address');
    } finally {
      setLooking(false);
    }
  }

  useEffect(() => {
    // A shared link may be a whole sentence; take the first web address in it.
    const shared = url.match(/https?:\/\/\S+/)?.[0];
    if (shared && shared !== url) setUrl(shared);
    if (!started.current && (params.get('url') || params.get('text'))) {
      started.current = true;
      void look();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="section">
      <span className="label">A website, blog or feed</span>
      <form className="card" onSubmit={(e) => void look(e)}>
        <div className="field">
          <label htmlFor="follow-url">Address</label>
          <input
            id="follow-url"
            className="input"
            type="url"
            inputMode="url"
            placeholder="e.g. example.com/blog"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoComplete="off"
          />
        </div>
        <button className="btn btn--primary" disabled={looking || !url.trim()} type="submit">
          {looking ? 'Looking…' : 'Find feed'}
        </button>
        <span className="hint" style={{ margin: 0 }}>
          Paste a site or a feed. If the site has no feed, the app can watch the page for new articles instead.
        </span>
        {error && <div className="error" style={{ margin: 0 }}>{error}</div>}
      </form>

      {done && (
        <div className="notice notice--teal">
          <div className="notice__text">
            <span className="notice__title">Following {done.source.name}</span>
            <span className="notice__sub">
              {done.waitingForPc
                ? 'Your PC fetches it next time the helper checks in (within a minute or two when the PC is on).'
                : done.added > 0
                  ? `${done.added} latest post${done.added === 1 ? '' : 's'} added to your inbox.`
                  : 'Nothing new yet; it is checked every hour.'}
            </span>
            <span className="inline">
              <Link to={`/?source=${done.source.id}`} className="btn btn--small">
                Show posts
              </Link>
              <Link to={`/source/${done.source.id}`} className="btn btn--ghost btn--small">
                Settings for it
              </Link>
            </span>
          </div>
        </div>
      )}

      {found && !done && (
        <>
          {found.existingSourceId && (
            <div className="notice notice--amber">
              <div className="notice__text">
                <span className="notice__title">You already follow this</span>
                <Link to={`/source/${found.existingSourceId}`} className="notice__sub">
                  Open its settings
                </Link>
              </div>
            </div>
          )}
          {found.feeds.map((f) => (
            <FeedOption key={f.feedUrl} feed={f} siteUrl={found.url} onDone={setDone} />
          ))}
          {found.page && <PageOption found={found} onDone={setDone} />}
          {found.feeds.length === 0 && !found.page && <div className="error">{found.error ?? 'Nothing to follow at that address'}</div>}
        </>
      )}
    </div>
  );
}

function SourceFields({
  name,
  setName,
  category,
  setCategory,
}: {
  name: string;
  setName: (v: string) => void;
  category: string;
  setCategory: (v: string) => void;
}) {
  const [categories, setCategories] = useState<string[]>([]);
  useEffect(() => {
    api
      .settings()
      .then((s) => setCategories(s.categories))
      .catch(() => undefined);
  }, []);
  return (
    <div className="inline" style={{ flexWrap: 'wrap' }}>
      <input className="input" style={{ flex: '2 1 160px' }} aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <select className="input" style={{ flex: '1 1 120px' }} aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
        <option value="">No category</option>
        {categories.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
    </div>
  );
}

function FeedOption({ feed, siteUrl, onDone }: { feed: DiscoveredFeed; siteUrl: string; onDone: (r: NewSourceResult) => void }) {
  const [name, setName] = useState(feed.title ?? new URL(feed.feedUrl).hostname);
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function follow() {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.addSource({ kind: 'feed', url: feed.siteUrl ?? siteUrl, feedUrl: feed.feedUrl, name, category: category || null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not follow it');
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <span className="label">{feed.format === 'json' ? 'JSON feed' : feed.format === 'atom' ? 'Atom feed' : 'RSS feed'}</span>
      <span className="hint" style={{ margin: 0, wordBreak: 'break-all' }}>
        {feed.feedUrl}
      </span>
      {feed.sample.length > 0 && (
        <ul className="hint" style={{ margin: 0, paddingLeft: 18 }}>
          {feed.sample.map((p) => (
            <li key={p.url ?? p.title}>
              {p.title}
              {p.publishedAt ? ` · ${shortTime(p.publishedAt)}` : ''}
            </li>
          ))}
        </ul>
      )}
      {feed.teasers && (
        <span className="hint" style={{ margin: 0 }}>
          This feed only has the start of each post, so your PC fetches the full articles.
        </span>
      )}
      <SourceFields name={name} setName={setName} category={category} setCategory={setCategory} />
      <button className="btn btn--primary" disabled={busy} onClick={() => void follow()}>
        Follow
      </button>
      {error && <div className="error" style={{ margin: 0 }}>{error}</div>}
    </section>
  );
}

function PageOption({ found, onDone }: { found: DiscoverResult; onDone: (r: NewSourceResult) => void }) {
  const page = found.page!;
  const [name, setName] = useState(page.title ?? new URL(page.url).hostname.replace(/^www\./, ''));
  const [category, setCategory] = useState('');
  const [hint, setHint] = useState('');
  const [render, setRender] = useState(page.scripted);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function watch() {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.addSource({ kind: 'site', url: page.url, name, category: category || null, render, linkHint: hint.trim() || null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not watch it');
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <span className="label">{found.feeds.length > 0 ? 'Or watch the page itself' : 'No feed found: watch the page'}</span>
      {page.blocked ? (
        <span className="hint" style={{ margin: 0 }}>
          {found.error ?? 'Cloudflare could not open this page.'} Your PC can try instead.
        </span>
      ) : page.sample.length > 0 ? (
        <>
          <span className="hint" style={{ margin: 0 }}>
            Articles found on the page:
          </span>
          <ul className="hint" style={{ margin: 0, paddingLeft: 18 }}>
            {page.sample.map((l) => (
              <li key={l.url}>{l.title}</li>
            ))}
          </ul>
        </>
      ) : (
        <span className="hint" style={{ margin: 0 }}>
          No article links stood out on the page{page.scripted ? '; it looks built by JavaScript, so your PC will open it in a browser' : ''}.
        </span>
      )}
      <span className="hint" style={{ margin: 0 }}>
        Your PC checks the page every few hours and brings in each new article as a clean copy.
      </span>
      <SourceFields name={name} setName={setName} category={category} setCategory={setCategory} />
      <div className="field">
        <label htmlFor="link-hint">Only links containing (optional)</label>
        <input id="link-hint" className="input" placeholder="e.g. /blog/" value={hint} onChange={(e) => setHint(e.target.value)} />
      </div>
      <label className="switchrow">
        <span style={{ fontSize: 15 }}>Needs a browser (page built by JavaScript)</span>
        <input type="checkbox" checked={render} onChange={(e) => setRender(e.target.checked)} />
      </label>
      <button className="btn btn--primary" disabled={busy} onClick={() => void watch()}>
        Watch this page
      </button>
      {error && <div className="error" style={{ margin: 0 }}>{error}</div>}
    </section>
  );
}

/** Feedly (or any reader) export: Organize → OPML. Folders become folders, and categories when the names match. */
function OpmlSection() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.importOpml(await file.text());
      setResult(
        `${r.added} feed${r.added === 1 ? '' : 's'} added${r.skipped ? `, ${r.skipped} you already follow` : ''}. ` +
          (r.added > 0 ? 'Their latest posts arrive over the next hour or so.' : ''),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section">
      <span className="label">Import from Feedly</span>
      <section className="card">
        <span className="hint" style={{ margin: 0 }}>
          In Feedly, open Organize Sources and export OPML, then pick the file here. Each feed brings in its latest 5 posts, then new
          ones as they appear.
        </span>
        <label className="btn" style={{ textAlign: 'center' }}>
          {busy ? 'Importing…' : 'Choose OPML file'}
          <input type="file" accept=".opml,.xml,text/xml,text/x-opml,application/xml" hidden disabled={busy} onChange={(e) => void onFile(e)} />
        </label>
        {result && <span className="hint" style={{ margin: 0 }}>{result}</span>}
        {error && <div className="error" style={{ margin: 0 }}>{error}</div>}
      </section>
    </div>
  );
}
