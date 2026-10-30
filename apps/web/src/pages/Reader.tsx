import type { ItemBody, ItemSummary } from '@newsletterapp/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, isPhone } from '../api';
import { EmailBody } from '../components/EmailBody';
import { longDate, readingMinutes } from '../format';
import { IconArchive, IconBack, IconBookmark, IconExternal, IconImage } from '../icons';

export function ReaderPage({ onChanged }: { onChanged: () => void }) {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [item, setItem] = useState<ItemSummary | null>(null);
  const [body, setBody] = useState<ItemBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadImages, setLoadImages] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    setBody(null);
    setError(null);
    setLoadImages(false);
    Promise.all([api.item(id), api.itemBody(id)])
      .then(([i, b]) => {
        if (cancelled) return;
        setItem(i);
        setBody(b);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useReadingTracker(id, item !== null);

  const onLinkClick = useCallback(
    (href: string) => {
      api.event(id, { type: 'link_click', device: isPhone() });
      void href;
    },
    [id],
  );

  async function act(action: 'save' | 'unsave' | 'archive' | 'unarchive') {
    if (!item) return;
    try {
      const updated = await api.itemAction(item.id, action);
      setItem(updated);
      onChanged();
      if (action === 'archive') navigate(-1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  const unsubscribeUrl = item ? httpUnsubscribeLink(item.listUnsubscribe) : null;
  const hasRemoteImages = body?.html ? /<img[^>]+src=["']?https?:/i.test(body.html) : false;

  return (
    <div className="reader">
      <div className="reader__bar">
        <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
          <IconBack />
        </button>
        <div className="reader__who">
          <strong>{item?.sourceName ?? item?.fromName ?? item?.fromEmail ?? ''}</strong>
          <span>
            {item ? `${item.kind === 'newsletter' ? 'Newsletter' : item.kind} · ${readingMinutes(body?.text)} min read` : ''}
          </span>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {item && (
        <div className="reader__head">
          <h1>{item.subject}</h1>
          <div className="reader__chips">
            <span className="chip chip--outline">{longDate(item.receivedAt)}</span>
            {item.toAddress && <span className="chip chip--outline">to {item.toAddress}</span>}
            {item.savedAt && <span className="chip chip--warn">Saved</span>}
            {item.tags.map((t) => (
              <span key={t} className="chip chip--outline">
                {t}
              </span>
            ))}
          </div>
          {item.summary && (
            <section className="card" aria-label="Summary">
              <span className="label" style={{ color: 'var(--teal-ink)' }}>
                Summary
              </span>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.45 }}>{item.summary}</p>
            </section>
          )}
          {hasRemoteImages && !loadImages && (
            <div className="reader__images">
              <span>
                <IconImage size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />
                Images are blocked so the sender can't see you opened this.
              </span>
              <button className="btn btn--small" onClick={() => setLoadImages(true)}>
                Load
              </button>
            </div>
          )}
        </div>
      )}

      <div className="reader__body">
        {body?.html ? (
          <EmailBody html={body.html} loadImages={loadImages} onLinkClick={onLinkClick} />
        ) : body?.text ? (
          <div className="reader__text">{body.text}</div>
        ) : item ? (
          <p className="muted">This email has no readable body.</p>
        ) : (
          !error && <div className="spinner">Loading…</div>
        )}
        {item && (unsubscribeUrl || item.listUnsubscribe) && (
          <p className="hint" style={{ marginTop: 32 }}>
            {unsubscribeUrl ? (
              <a href={unsubscribeUrl} target="_blank" rel="noopener noreferrer">
                Unsubscribe from this newsletter
              </a>
            ) : (
              'This newsletter offers unsubscribe by email only; one-tap unsubscribe comes in Phase 2.'
            )}
          </p>
        )}
      </div>

      <div className="reader__actions">
        <button className={item?.savedAt ? 'active' : ''} disabled={!item} onClick={() => void act(item?.savedAt ? 'unsave' : 'save')}>
          <IconBookmark />
          {item?.savedAt ? 'Saved' : 'Save'}
        </button>
        <button disabled={!item} onClick={() => void act(item?.status === 'archived' ? 'unarchive' : 'archive')}>
          <IconArchive />
          {item?.status === 'archived' ? 'Unarchive' : 'Archive'}
        </button>
        {item?.webUrl ? (
          <a href={item.webUrl} target="_blank" rel="noopener noreferrer" onClick={() => api.event(id, { type: 'open_original', device: isPhone() })}>
            <IconExternal />
            Web version
          </a>
        ) : (
          <a href={api.rawUrl(id)} download onClick={() => api.event(id, { type: 'open_original', device: isPhone() })}>
            <IconExternal />
            Original
          </a>
        )}
        <Link to="/" style={{ color: 'var(--muted)' }}>
          <IconBack />
          Inbox
        </Link>
      </div>
    </div>
  );
}

/** Picks the https link out of a List-Unsubscribe header, if there is one. */
function httpUnsubscribeLink(header: string | null): string | null {
  if (!header) return null;
  const m = /<(https?:\/\/[^>]+)>/i.exec(header);
  return m?.[1] ?? null;
}

/**
 * Logs an "open" when the item appears, then active reading seconds and the
 * furthest scroll position when the reader leaves or the tab is hidden.
 */
function useReadingTracker(id: string, ready: boolean) {
  const seconds = useRef(0);
  const maxScroll = useRef(0);
  const lastActivity = useRef(Date.now());

  useEffect(() => {
    if (!ready) return;
    seconds.current = 0;
    maxScroll.current = 0;
    lastActivity.current = Date.now();
    const device = isPhone();
    api.event(id, { type: 'open', device });

    const tick = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastActivity.current > 60_000) return; // idle: stop counting
      seconds.current += 1;
    }, 1000);

    const activity = () => {
      lastActivity.current = Date.now();
      const doc = document.documentElement;
      const total = doc.scrollHeight - window.innerHeight;
      if (total > 0) {
        const pct = Math.round(((window.scrollY + window.innerHeight) / doc.scrollHeight) * 100);
        maxScroll.current = Math.max(maxScroll.current, Math.min(100, pct));
      } else {
        maxScroll.current = 100;
      }
    };
    activity();

    const flush = () => {
      if (seconds.current >= 2) api.event(id, { type: 'read_time', value: seconds.current, device });
      if (maxScroll.current > 0) api.event(id, { type: 'finish', value: maxScroll.current, device });
      seconds.current = 0;
      maxScroll.current = 0;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };

    window.addEventListener('scroll', activity, { passive: true });
    window.addEventListener('pointerdown', activity, { passive: true });
    window.addEventListener('keydown', activity);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);

    return () => {
      window.clearInterval(tick);
      window.removeEventListener('scroll', activity);
      window.removeEventListener('pointerdown', activity);
      window.removeEventListener('keydown', activity);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [id, ready]);
}
