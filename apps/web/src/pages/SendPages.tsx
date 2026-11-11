import type { AppSettings, SaveAddressInfo } from '@newsletterapp/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { shortTime } from '../format';
import { IconBack, IconCopy } from '../icons';

// Settings > Send pages from anywhere: the save address (email links or whole
// emails in), who may send to it, and bookmarks that send the page you're on.

/** Bookmarklets are one line of script; these build them for this app and address. */
export function saveBookmarklet(appOrigin: string): string {
  return (
    'javascript:(function(){' +
    `var u='${appOrigin}/add?save=1&shared_url='+encodeURIComponent(location.href);` +
    "var w=window.open(u,'reader_save','width=480,height=460');" +
    'if(!w)location.href=u;' +
    '})();'
  );
}

export function emailBookmarklet(address: string): string {
  return (
    'javascript:(function(){' +
    `location.href='mailto:${address}?subject='+encodeURIComponent(document.title)+'&body='+encodeURIComponent(location.href);` +
    '})();'
  );
}

export function outlookBookmarklet(address: string): string {
  return (
    'javascript:(function(){' +
    `window.open('https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(address)}&subject='+encodeURIComponent(document.title)+'&body='+encodeURIComponent(location.href),'_blank');` +
    '})();'
  );
}

/**
 * A link you drag to the bookmarks bar. React won't render a javascript: href,
 * so it is set on the element directly; clicking it here does nothing.
 */
function Bookmarklet({ name, code, sub }: { name: string; code: string; sub: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    ref.current?.setAttribute('href', code);
  }, [code]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard (older browser): dragging still works.
    }
  }

  return (
    <div className="cardrow" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <div className="cardrow__main">
        <span className="cardrow__title">
          <a ref={ref} className="btn btn--small btn--primary" onClick={(e) => e.preventDefault()} draggable title="Drag me to your bookmarks bar">
            {name}
          </a>
        </span>
        <span className="cardrow__sub">{sub}</span>
      </div>
      <button className="btn btn--small" type="button" onClick={() => void copy()}>
        <IconCopy /> {copied ? 'Copied' : 'Copy code'}
      </button>
    </div>
  );
}

export function SendPagesPage() {
  const navigate = useNavigate();
  const [info, setInfo] = useState<SaveAddressInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sender, setSender] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    Promise.all([api.saveAddressInfo(), api.settings()])
      .then(([i, s]) => {
        setInfo(i);
        setSettings(s);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, []);

  async function saveSenders(saveSenders: string[]) {
    if (!settings) return;
    const before = settings;
    setSettings({ ...settings, saveSenders });
    try {
      setSettings(await api.saveSettings({ saveSenders }));
    } catch (err) {
      setSettings(before);
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  function addSender(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    const email = sender.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setError('That doesn’t look like an email address');
    setError(null);
    setSender('');
    if (!settings.saveSenders.includes(email) && !info?.signInEmails.includes(email)) void saveSenders([...settings.saveSenders, email]);
  }

  async function copyAddress() {
    if (!info?.address) return;
    try {
      await navigator.clipboard.writeText(info.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // The address is shown anyway.
    }
  }

  const origin = window.location.origin;

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Send pages from anywhere</h1>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      {!info && !error && <div className="spinner">Loading…</div>}

      {info && settings && (
        <>
          <div className="section">
            <span className="label">Save address</span>
            <section className="card">
              {info.address ? (
                <div className="inline" style={{ flexWrap: 'wrap' }}>
                  <strong>{info.address}</strong>
                  <button className="btn btn--small" type="button" onClick={() => void copyAddress()}>
                    <IconCopy /> {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              ) : (
                <p className="hint" style={{ margin: 0 }}>
                  The mail domain isn't set up yet, so there is no save address.
                </p>
              )}
              <p className="hint" style={{ margin: 0 }}>
                Email a link here and the page goes into your inbox under <Link to="/settings/sources">Saved pages</Link>, the same
                as Add &gt; Just one page. Up to 5 links per email are saved (the ones above your signature). Forward an email here
                and the email itself is saved. PDFs attached are kept and your PC reads them. Nothing is sent back.
              </p>
            </section>
          </div>

          <div className="section">
            <span className="label">Who can send to it</span>
            <section className="card">
              <div className="chipedit">
                {info.signInEmails.map((e) => (
                  <span key={e} className="chip chip--category" title="Your sign-in address, always allowed">
                    {e}
                  </span>
                ))}
                {settings.saveSenders.map((e) => (
                  <span key={e} className="chip chip--category">
                    {e}
                    <button aria-label={`Remove ${e}`} onClick={() => void saveSenders(settings.saveSenders.filter((x) => x !== e))}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <form className="inline" onSubmit={addSender}>
                <input
                  className="input"
                  type="email"
                  placeholder="another address, e.g. your work email"
                  value={sender}
                  onChange={(e) => setSender(e.target.value)}
                  autoComplete="off"
                />
                <button className="btn btn--small" type="submit">
                  Add
                </button>
              </form>
              <p className="hint" style={{ margin: 0 }}>
                Addresses added here can only save pages; they can't open the app. Mail from anyone else is ignored, and so is
                mail whose sender check (DKIM/DMARC) fails, so a faked From line can't add anything.
              </p>
            </section>
          </div>

          <div className="section">
            <span className="label">Bookmarks that send the page you're on</span>
            <section className="card card--list">
              <Bookmarklet
                name="Save to Reader"
                code={saveBookmarklet(origin)}
                sub="For your own computers: opens a small window that saves the page, then closes. Needs you signed in to the app in that browser."
              />
              {info.address && (
                <Bookmarklet
                  name="Email to Reader"
                  code={emailBookmarklet(info.address)}
                  sub="Opens a new email in your mail app (e.g. Outlook) with the page's title and link filled in; press Send. Never opens the app, so it suits a work computer."
                />
              )}
              {info.address && (
                <Bookmarklet
                  name="Email to Reader (Outlook web)"
                  code={outlookBookmarklet(info.address)}
                  sub="The same, for when you use Outlook in the browser instead of a mail app."
                />
              )}
            </section>
            <p className="hint">
              In Firefox: show the bookmarks toolbar (Ctrl+Shift+B, or ⌘⇧B on a Mac), then drag a button above onto it. Or right-click
              the toolbar, Add Bookmark, and paste the copied code as the URL. With Firefox Sync on, it appears on your other computers
              too.
            </p>
          </div>

          <div className="section">
            <span className="label">Last emails to the save address</span>
            <section className="card card--list">
              {info.log.length === 0 && (
                <div className="cardrow">
                  <span className="hint">Nothing yet. Send a link from one of the addresses above to try it.</span>
                </div>
              )}
              {info.log.map((e) => (
                <div key={`${e.at}-${e.from}`} className="cardrow">
                  <div className="cardrow__main">
                    <span className="cardrow__title">
                      {e.outcome === 'saved' ? '✓ ' : '✕ '}
                      {e.subject || '(no subject)'}
                    </span>
                    <span className="cardrow__sub">
                      {shortTime(e.at)} · {e.from} · {e.detail}
                      {e.itemIds[0] && (
                        <>
                          {' · '}
                          <Link to={`/item/${e.itemIds[0]}`}>Open</Link>
                        </>
                      )}
                    </span>
                  </div>
                </div>
              ))}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
