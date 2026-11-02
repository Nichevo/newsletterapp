import type { AskPreset, FetchPageStatus, ItemBody, ItemHighlights, ItemSummary, RelatedItem, UnsubscribeResult } from '@newsletterapp/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, isPhone } from '../api';
import { EmailBody } from '../components/EmailBody';
import { AiNotes, HighlightSheet, SelectionBar, TextBody, useArticleSelection } from '../components/Highlights';
import { revealMark } from '../highlight';
import { aiAttribution, longDate, readingMinutes, shortTime } from '../format';
import { IconArchive, IconBack, IconBookmark, IconCheck, IconChevron, IconExternal, IconImage, IconSettings, IconStar, IconThumbDown, IconThumbUp } from '../icons';
import { getHideSponsored, getNotesPlace, getTextSize, imagesAllowed, setImagesAllowed, textSizePx, type AskOutputPref } from '../prefs';
import { outlineOf } from '../quick';
import { neighbours } from '../readingList';

const KIND_NAME: Record<ItemSummary['kind'], string> = { newsletter: 'Newsletter', feed: 'Feed', site: 'Website', ai: 'AI note' };
const PLATFORM_NAME = { reddit: 'Reddit', youtube: 'YouTube', github: 'GitHub' } as const;

export function ReaderPage({ onChanged }: { onChanged: () => void }) {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [item, setItem] = useState<ItemSummary | null>(null);
  const [body, setBody] = useState<ItemBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadImages, setLoadImages] = useState(false);
  const [related, setRelated] = useState<RelatedItem[]>([]);
  const [sponsoredCount, setSponsoredCount] = useState(0);
  const [showSponsored, setShowSponsored] = useState(false);
  const fontSize = textSizePx(getTextSize());
  const nav = useMemo(() => neighbours(id), [id]);
  const [params] = useSearchParams();
  const marks = useHighlights(id, params.get('hl'));

  // Previous / Next replace the current entry so Back still returns to the inbox.
  const go = useCallback(
    (target: string | null) => {
      if (target) navigate(`/item/${target}`, { replace: true });
    },
    [navigate],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (marks.capture) return; // the highlight bar has its own keys while text is selected
      if (e.key === 'ArrowLeft' || e.key === 'k') go(nav.prev);
      if (e.key === 'ArrowRight' || e.key === 'j') go(nav.next);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav, go, marks.capture]);
  const hideSponsored = getHideSponsored() && !showSponsored;

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    setBody(null);
    setError(null);
    setLoadImages(false);
    setRelated([]);
    setSponsoredCount(0);
    setShowSponsored(false);
    Promise.all([api.item(id), api.itemBody(id)])
      .then(async ([i, b]) => {
        // A copy fetched again since: ask for that version (rare, so the first request stays parallel).
        if (i.bodyVersion > 0) b = await api.itemBody(id, i.bodyVersion);
        if (cancelled) return;
        setItem(i);
        setBody(b);
        // Images in feed posts and web articles can't tell anyone you opened an email, so they just load.
        setLoadImages(i.kind !== 'newsletter' || imagesAllowed(i.sourceId));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useReadingTracker(id, item !== null);

  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    api
      .related(item.id)
      .then((r) => !cancelled && setRelated(r))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [item]);

  const onLinkClick = useCallback(
    (href: string) => {
      api.event(id, { type: 'link_click', device: isPhone() });
      void href;
    },
    [id],
  );

  async function act(action: 'save' | 'unsave' | 'interesting' | 'uninteresting' | 'archive' | 'unarchive' | 'read' | 'unread') {
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

  const hasRemoteImages = body?.html ? /<img[^>]+src=["']?https?:/i.test(body.html) : false;

  function allowImagesForSource() {
    if (item?.sourceId) setImagesAllowed(item.sourceId, true);
    setLoadImages(true);
  }

  return (
    <div className="reader">
      <div className="reader__bar">
        <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
          <IconBack />
        </button>
        <div className="reader__who">
          {item?.sourceId ? (
            // Tap the name to open the source's settings (AI, pictures, category, pause...).
            <Link to={`/source/${item.sourceId}`} className="reader__source" title="Source settings">
              <strong>{item.sourceName ?? item.fromName ?? item.fromEmail ?? ''}</strong>
              <IconSettings size={13} />
            </Link>
          ) : (
            <strong>{item?.sourceName ?? item?.fromName ?? item?.fromEmail ?? ''}</strong>
          )}
          <span>
            {item ? `${item.platform ? PLATFORM_NAME[item.platform] : KIND_NAME[item.kind]} · ${readingMinutes(item.wordCount ?? body?.text)} min read` : ''}
          </span>
        </div>
        {nav.position !== null && (
          <div className="reader__nav">
            <button className="iconbtn" aria-label="Previous in list" disabled={!nav.prev} onClick={() => go(nav.prev)}>
              <IconChevron style={{ transform: 'rotate(90deg)' }} />
            </button>
            <span className="reader__nav-pos">
              {nav.position}/{nav.total}
            </span>
            <button className="iconbtn" aria-label="Next in list" disabled={!nav.next} onClick={() => go(nav.next)}>
              <IconChevron style={{ transform: 'rotate(-90deg)' }} />
            </button>
          </div>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      {item && (
        <div className="reader__head">
          <h1>{item.subject}</h1>
          <div className="reader__chips">
            <span className="chip chip--outline">{longDate(item.receivedAt)}</span>
            {item.readAt && <span className="chip chip--outline">{readLabel(item)}</span>}
            {item.toAddress && <span className="chip chip--outline">to {item.toAddress}</span>}
            {item.savedAt && <span className="chip chip--warn">Saved</span>}
            {item.interestingAt && <span className="chip chip--warn">★ Interesting</span>}
            {item.category && <span className="chip chip--category">{item.category}</span>}
            {item.sponsored && <span className="chip chip--outline">Has a sponsored section</span>}
            {item.tags.map((t) => (
              <span key={t} className="chip chip--outline">
                {t}
              </span>
            ))}
          </div>
          {marks.place === 'bottom' && marks.noteCount > 0 && (
            <button className="chip chip--ai notes-jump" onClick={marks.scrollToNotes}>
              {marks.noteCount} AI note{marks.noteCount === 1 ? '' : 's'} ↓
            </button>
          )}
          {item.summary && <AiSummary item={item} onItem={setItem} />}
          {item.kind !== 'ai' && (
            <QuickSummary
              preview={item.preheader ?? item.snippet}
              html={body?.html ?? null}
              folded={Boolean(item.summary)}
              pending={!item.summary && (item.aiStatus === 'pending' || item.aiStatus === 'working')}
              onLinkClick={onLinkClick}
            />
          )}
          {marks.place === 'top' && marks.notes}
          {item.webUrl && item.kind !== 'newsletter' && item.kind !== 'ai' && (
            <FetchPage
              item={item}
              onFetched={async () => {
                const i = await api.item(item.id);
                const b = await api.itemBody(item.id, i.bodyVersion);
                setItem(i);
                setBody(b);
              }}
            />
          )}
          {hasRemoteImages && !loadImages && (
            <div className="reader__images">
              <span>
                <IconImage size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />
                Images are blocked so the sender can't see you opened this.
              </span>
              <span className="inline">
                <button className="btn btn--small" onClick={() => setLoadImages(true)}>
                  Load
                </button>
                {item.sourceId && (
                  <button className="btn btn--ghost btn--small" onClick={allowImagesForSource}>
                    Always
                  </button>
                )}
              </span>
            </div>
          )}
          {sponsoredCount > 0 && getHideSponsored() && (
            <div className="reader__images">
              <span>
                {sponsoredCount} sponsored section{sponsoredCount === 1 ? '' : 's'} {showSponsored ? 'shown' : 'hidden'}.
              </span>
              <button className="btn btn--small" onClick={() => setShowSponsored((v) => !v)}>
                {showSponsored ? 'Hide' : 'Show'}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="reader__body">
        {body?.html ? (
          <EmailBody
            html={body.html}
            loadImages={loadImages}
            fontSize={fontSize}
            hideSponsored={hideSponsored}
            onSponsored={setSponsoredCount}
            onLinkClick={onLinkClick}
            highlights={marks.data.highlights}
            activeHighlight={marks.sheet}
            onRoot={marks.setRoot}
            onHighlightTap={marks.openSheet}
            onInternalLink={(path) => navigate(path)}
            onMissing={marks.setMissing}
          />
        ) : body?.text ? (
          <TextBody
            text={body.text}
            fontSize={fontSize}
            highlights={marks.data.highlights}
            activeHighlight={marks.sheet}
            onRoot={marks.setRoot}
            onHighlightTap={marks.openSheet}
            onMissing={marks.setMissing}
          />
        ) : item ? (
          <p className="muted">{item.kind === 'newsletter' ? 'This email has no readable body.' : 'No saved copy of this post; open the live page.'}</p>
        ) : (
          !error && <div className="spinner">Loading…</div>
        )}
        {marks.place === 'bottom' && marks.notes}
        {item && related.length > 0 && <RelatedList related={related} />}
        {item && item.listUnsubscribe && <Unsubscribe item={item} onChanged={onChanged} />}
      </div>

      <div className="reader__actions">
        <button className={item?.savedAt ? 'active' : ''} disabled={!item} onClick={() => void act(item?.savedAt ? 'unsave' : 'save')}>
          <IconBookmark />
          {item?.savedAt ? 'Saved' : 'Save'}
        </button>
        <button
          className={item?.interestingAt ? 'active' : ''}
          disabled={!item}
          title="Interesting: this was worth it. Helps the Top sort and digest learn what you value."
          onClick={() => void act(item?.interestingAt ? 'uninteresting' : 'interesting')}
        >
          <IconStar filled={Boolean(item?.interestingAt)} />
          {item?.interestingAt ? 'Starred' : 'Star'}
        </button>
        <button disabled={!item} onClick={() => void act(item?.status === 'archived' ? 'unarchive' : 'archive')}>
          <IconArchive />
          {item?.status === 'archived' ? 'Unarchive' : 'Archive'}
        </button>
        <button disabled={!item} onClick={() => void act(item?.readAt ? 'unread' : 'read')}>
          <IconCheck />
          {item?.readAt ? 'Mark unread' : 'Mark read'}
        </button>
        {item?.originItemId ? (
          <Link to={`/item/${item.originItemId}`}>
            <IconExternal />
            Original article
          </Link>
        ) : item?.webUrl ? (
          <a href={item.webUrl} target="_blank" rel="noopener noreferrer" onClick={() => api.event(id, { type: 'open_original', device: isPhone() })}>
            <IconExternal />
            {item.kind === 'newsletter' ? 'Web version' : 'Live page'}
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
      {marks.overlays}
    </div>
  );
}

const ROOTLESS: (ShadowRoot | HTMLElement)[] = [];

/**
 * Highlights in the open article: loading them, the selection bar, the sheet
 * for a tapped highlight, the AI notes card, and checking for answers while
 * the PC works on them.
 */
function useHighlights(itemId: string, jumpTo: string | null) {
  const [data, setData] = useState<ItemHighlights>({ highlights: [], asks: [], helperLastSeenAt: null });
  const [presets, setPresets] = useState<AskPreset[]>([]);
  const [missing, setMissingState] = useState<string[]>([]);
  const [sheet, setSheet] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const roots = useRef<(ShadowRoot | HTMLElement)[]>(ROOTLESS);
  const notesRef = useRef<HTMLDivElement>(null);
  const place = getNotesPlace();
  const selection = useArticleSelection(useCallback(() => roots.current, []));

  const refresh = useCallback(() => {
    api
      .highlights(itemId)
      .then(setData)
      .catch(() => undefined);
  }, [itemId]);

  useEffect(() => {
    setData({ highlights: [], asks: [], helperLastSeenAt: null });
    setMissingState([]);
    setSheet(null);
    roots.current = ROOTLESS;
    refresh();
  }, [itemId, refresh]);

  useEffect(() => {
    api
      .askPresets()
      .then(setPresets)
      .catch(() => undefined);
  }, []);

  // While the PC works on an answer, look for it every few seconds (only while the app is on screen).
  const waiting = data.asks.some((a) => a.status === 'pending' || a.status === 'working');
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(() => document.visibilityState === 'visible' && refresh(), 4000);
    return () => window.clearInterval(t);
  }, [waiting, refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const setRoot = useCallback((r: ShadowRoot | HTMLElement) => {
    roots.current = [r];
  }, []);
  const setMissing = useCallback((ids: string[]) => {
    setMissingState((prev) => (prev.join() === ids.join() ? prev : ids));
  }, []);
  const openSheet = useCallback((id: string) => setSheet(id), []);

  function reveal(highlightId: string) {
    for (const r of roots.current) if (revealMark(r, highlightId)) return true;
    return false;
  }

  // Opened from the Highlights page: scroll to that highlight once the article and its marks are in.
  const jumped = useRef<string | null>(null);
  const hasJumpTarget = jumpTo !== null && data.highlights.some((h) => h.id === jumpTo);
  useEffect(() => {
    if (!jumpTo || !hasJumpTarget || jumped.current === `${itemId}:${jumpTo}`) return;
    let tries = 0;
    const t = window.setInterval(() => {
      const done = roots.current.some((r) => revealMark(r, jumpTo));
      if (done || ++tries > 20) {
        window.clearInterval(t);
        jumped.current = `${itemId}:${jumpTo}`;
      }
    }, 250);
    return () => window.clearInterval(t);
  }, [itemId, jumpTo, hasJumpTarget]);

  function showNotes(highlightId: string) {
    setSheet(null);
    setFlash(highlightId);
    window.setTimeout(() => setFlash(null), 2500);
    if (!data.asks.some((a) => a.highlightId === highlightId)) notesRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  async function highlight() {
    const anchor = selection.capture?.anchor;
    if (!anchor) return;
    setBusy(true);
    try {
      const h = await api.addHighlight(itemId, anchor);
      setData((d) => ({ ...d, highlights: [...d.highlights, h] }));
      selection.clear();
    } catch (err) {
      setToast(err instanceof Error ? `Couldn't highlight: ${err.message}` : "Couldn't highlight");
    } finally {
      setBusy(false);
      selection.release();
    }
  }

  async function ask(presetId: string | null, output: AskOutputPref, question?: string, highlightId?: string) {
    const anchor = highlightId ? undefined : selection.capture?.anchor;
    if (!highlightId && !anchor) return;
    setBusy(true);
    try {
      const res = await api.ask({ itemId, highlightId, highlight: anchor, presetId, question, output });
      setData((d) => ({
        ...d,
        highlights: d.highlights.some((h) => h.id === res.highlight.id) ? d.highlights : [...d.highlights, res.highlight],
        asks: [...d.asks, res.ask],
      }));
      selection.clear();
      setSheet(null);
      setToast(
        res.ask.output === 'item'
          ? `${res.ask.label}: asked your PC. The answer will arrive as a new article in your inbox.`
          : `${res.ask.label}: asked your PC. The answer will appear in AI notes${place === 'bottom' ? ' at the end' : ''}.`,
      );
      refresh();
    } catch (err) {
      setToast(err instanceof Error ? `Couldn't ask: ${err.message}` : "Couldn't ask");
    } finally {
      setBusy(false);
      selection.release();
    }
  }

  async function remove(highlightId: string) {
    setSheet(null);
    setData((d) => ({ ...d, highlights: d.highlights.filter((h) => h.id !== highlightId), asks: d.asks.filter((a) => a.highlightId !== highlightId) }));
    await api.deleteHighlight(highlightId).catch(() => refresh());
  }

  const visibleAsks = data.asks;
  const noteCount = visibleAsks.filter((a) => a.output !== 'item').length;
  const sheetHighlight = sheet ? data.highlights.find((h) => h.id === sheet) : undefined;

  const notes = (
    <div ref={notesRef}>
      <AiNotes
        highlights={data.highlights}
        asks={visibleAsks}
        missing={missing}
        helperLastSeenAt={data.helperLastSeenAt}
        flash={flash}
        onReveal={reveal}
        onChanged={refresh}
        api={api}
      />
    </div>
  );

  const overlays = (
    <>
      {selection.capture && !sheet && (
        <SelectionBar
          capture={selection.capture}
          presets={presets}
          busy={busy}
          hold={selection.hold}
          onHighlight={() => void highlight()}
          onAsk={(presetId, output, question) => void ask(presetId, output, question)}
          onClose={selection.clear}
        />
      )}
      {sheetHighlight && (
        <HighlightSheet
          highlight={sheetHighlight}
          asks={visibleAsks.filter((a) => a.highlightId === sheetHighlight.id)}
          presets={presets}
          busy={busy}
          onAsk={(presetId, output, question) => void ask(presetId, output, question, sheetHighlight.id)}
          onShowNotes={() => showNotes(sheetHighlight.id)}
          onDelete={() => void remove(sheetHighlight.id)}
          onClose={() => setSheet(null)}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );

  return {
    data,
    capture: selection.capture,
    sheet,
    place,
    noteCount,
    notes,
    overlays,
    setRoot,
    setMissing,
    openSheet,
    scrollToNotes: () => notesRef.current?.scrollIntoView({ behavior: 'smooth' }),
  };
}

/** The AI summary from the PC helper, with who wrote it and a thumbs up/down. */
function AiSummary({ item, onItem }: { item: ItemSummary; onItem: (i: ItemSummary) => void }) {
  const [advice, setAdvice] = useState(false);
  const [redoing, setRedoing] = useState(false);
  const rating = item.ai?.rating ?? null;

  async function rate(value: 1 | -1) {
    if (!item.ai) return;
    const next = rating === value ? null : value;
    onItem({ ...item, ai: { ...item.ai, rating: next } });
    await api.rateItem(item.id, next ?? 0).catch(() => undefined);
    if (next === -1) {
      const res = await api.aiAdvice(item.id).catch(() => null);
      setAdvice(Boolean(res?.suggestOff));
    } else {
      setAdvice(false);
    }
  }

  async function redo() {
    setRedoing(true);
    await api.redoItem(item.id).catch(() => undefined);
    onItem({ ...item, aiStatus: 'pending' });
  }

  return (
    <section className="card ai" aria-label="AI summary">
      <span className="label" style={{ color: 'var(--teal-ink)' }}>
        AI summary
      </span>
      <p className="quick__lead">{item.summary}</p>
      {item.thinContent && <p className="hint" style={{ margin: 0 }}>This issue is mostly a teaser; the full story is on the website.</p>}
      {item.keyPoints.length > 0 && (
        <ul className="quick__list">
          {item.keyPoints.map((k) => (
            <li key={k}>{k}</li>
          ))}
        </ul>
      )}
      {item.whyItMatters && (
        <p className="ai__why">
          <strong>Why it matters:</strong> {item.whyItMatters}
        </p>
      )}
      {item.background && (
        <p className="ai__why">
          <strong>Background:</strong> {item.background}
        </p>
      )}
      {item.coverage.length > 0 && (
        <div className="ai__why">
          <strong>Other coverage:</strong>
          <ul className="quick__list">
            {item.coverage.map((c) => (
              <li key={c.url}>
                <a href={c.url} target="_blank" rel="noopener noreferrer nofollow">
                  {c.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="ai__foot">
        {item.ai && <p className="attribution">{aiAttribution(item.ai)}</p>}
        <div className="inline">
          <button className="iconbtn iconbtn--small" aria-label="Good summary" aria-pressed={rating === 1} onClick={() => void rate(1)}>
            <IconThumbUp size={18} />
          </button>
          <button className="iconbtn iconbtn--small" aria-label="Poor summary" aria-pressed={rating === -1} onClick={() => void rate(-1)}>
            <IconThumbDown size={18} />
          </button>
          <button className="quick__toggle" disabled={redoing || item.aiStatus === 'pending'} onClick={() => void redo()}>
            {redoing || item.aiStatus === 'pending' ? 'Queued' : 'Redo'}
          </button>
        </div>
      </div>
      {advice && item.sourceId && (
        <p className="hint" style={{ margin: 0 }}>
          The last few AI summaries from this newsletter weren't useful.{' '}
          <Link to={`/source/${item.sourceId}`}>Turn AI off for it?</Link>
        </p>
      )}
    </section>
  );
}

/**
 * The rules-based summary every item gets: the sender's preview line plus the
 * headings and main story links in the issue. Folds away under an AI summary.
 */
function QuickSummary({
  preview,
  html,
  folded,
  pending,
  onLinkClick,
}: {
  preview: string | null;
  html: string | null;
  folded: boolean;
  /** An AI summary is on its way from the PC. */
  pending: boolean;
  onLinkClick: (href: string) => void;
}) {
  const [open, setOpen] = useState(!folded);
  const [showOutline, setShowOutline] = useState(() => readFlag(OUTLINE_KEY));
  const outline = useMemo(() => (html ? outlineOf(html) : { headings: [], links: [] }), [html]);
  useEffect(() => setOpen(!folded), [folded]);
  const headings = outline.headings.length > 1 ? outline.headings : [];
  const outlineCount = headings.length + outline.links.length;
  if (!preview && outlineCount === 0) return null;

  function toggleOutline() {
    setShowOutline((v) => {
      writeFlag(OUTLINE_KEY, !v);
      return !v;
    });
  }

  return (
    <section className="card quick" aria-label="Quick summary">
      <span className="label" style={{ color: 'var(--teal-ink)' }}>
        Quick summary
      </span>
      {folded && (
        <button className="quick__toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
        </button>
      )}
      {open && (
        <>
          {preview && <p className="quick__lead">{preview}</p>}
          {outlineCount > 0 && (
            <button className="quick__toggle" onClick={toggleOutline} aria-expanded={showOutline}>
              {showOutline ? 'Hide' : 'Show'} what's in this issue ({outlineCount})
            </button>
          )}
          {showOutline && headings.length > 0 && (
            <>
              <span className="label">In this issue</span>
              <ul className="quick__list">
                {headings.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </>
          )}
          {showOutline && outline.links.length > 0 && (
            <>
              <span className="label">Main links</span>
              <ul className="quick__list">
                {outline.links.map((l) => (
                  <li key={l.href + l.text}>
                    <a href={l.href} target="_blank" rel="noopener noreferrer nofollow" onClick={() => onLinkClick(l.href)}>
                      {l.text}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="attribution">Quick summary (no AI){pending ? ' · AI summary waiting for your PC' : ''}</p>
        </>
      )}
    </section>
  );
}

/** Whether the "what's in this issue" lists start open, remembered on this device. */
const OUTLINE_KEY = 'reader:showOutline';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Storage unavailable; the choice just isn't remembered.
  }
}

/** "You've read about this before": older items you read that share a specific topic. */
function RelatedList({ related }: { related: RelatedItem[] }) {
  return (
    <section className="card related" aria-label="Related reading">
      <span className="label" style={{ color: 'var(--teal-ink)' }}>
        You've read about this before
      </span>
      <ul className="related__list">
        {related.map((r) => (
          <li key={r.id}>
            <Link to={`/item/${r.id}`}>{r.subject}</Link>
            <span className="related__meta">
              {r.sourceName ?? ''}
              {r.sourceName ? ' · ' : ''}
              {r.readAt ? `read ${shortTime(r.readAt)}` : `arrived ${shortTime(r.receivedAt)}, unread`}
              {r.shared.length > 0 ? ` · both about ${r.shared.slice(0, 3).join(', ')}` : r.similarity ? ' · similar story' : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One-tap unsubscribe. With one-click support the Worker does it in place;
 * otherwise the sender's link (or mailto) opens and the source is still marked.
 */
function Unsubscribe({ item, onChanged }: { item: ItemSummary; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UnsubscribeResult | null>(null);
  const [archived, setArchived] = useState<number | null>(null);

  async function run() {
    if (!window.confirm(`Unsubscribe from ${item.sourceName ?? item.fromEmail ?? 'this newsletter'}?`)) return;
    setBusy(true);
    try {
      const r = await api.unsubscribe(item.id);
      setResult(r);
      if (!r.done) {
        const target = r.url ?? r.mailto;
        if (target) window.open(target, '_blank', 'noopener');
      }
    } catch (err) {
      setResult({ done: false, url: null, mailto: null, error: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setBusy(false);
    }
  }

  async function archiveAll() {
    if (!item.sourceId) return;
    const r = await api.sourceBulk(item.sourceId, 'archive-all').catch(() => null);
    setArchived(r?.changed ?? 0);
    onChanged();
  }

  return (
    <div className="unsub">
      {!result ? (
        <button className="btn btn--ghost btn--small" disabled={busy} onClick={() => void run()}>
          {busy ? 'Unsubscribing…' : item.oneClickUnsubscribe ? 'Unsubscribe (one tap)' : 'Unsubscribe'}
        </button>
      ) : (
        <p className="hint" style={{ margin: 0 }}>
          {result.done
            ? 'Unsubscribed. The sender confirmed it; a last issue or two may still arrive.'
            : result.url || result.mailto
              ? "The sender's unsubscribe page opened in a new tab; finish it there."
              : `Could not unsubscribe: ${result.error ?? 'no link in the email'}.`}
          {item.sourceId && archived === null && (
            <>
              {' '}
              <button className="quick__toggle" onClick={() => void archiveAll()}>
                Archive all its issues
              </button>
            </>
          )}
          {archived !== null && ` Archived ${archived} issue${archived === 1 ? '' : 's'}.`}
        </p>
      )}
    </div>
  );
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

const READ_VIA_LABEL: Record<NonNullable<ItemSummary['readVia']>, string> = {
  reader: 'Read',
  swipe: 'Marked read',
  bulk: 'Marked read with its newsletter',
  digest: 'Marked read from the digest',
};

/** "Read on phone, Thu 30 Oct 9:12" or "Marked read from the digest on desktop, …". */
function readLabel(item: ItemSummary): string {
  const how = item.readVia ? READ_VIA_LABEL[item.readVia] : 'Read';
  const where = item.readDevice ? ` on ${item.readDevice}` : '';
  return `${how}${where}, ${item.readAt ? longDate(item.readAt) : ''}`.replace(/, $/, '');
}

/**
 * "Fetch full page": the PC fetches the post's web page again and its article
 * replaces the saved copy. Checks back every 10 seconds while it waits.
 */
function FetchPage({ item, onFetched }: { item: ItemSummary; onFetched: () => Promise<void> }) {
  const [status, setStatus] = useState<FetchPageStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fetched = useRef(onFetched);
  fetched.current = onFetched;

  useEffect(() => {
    let stop = false;
    api
      .fetchPageStatus(item.id)
      .then((s) => !stop && setStatus(s))
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [item.id]);

  useEffect(() => {
    if (!status?.pending) return;
    const started = Date.now();
    const timer = setInterval(() => {
      api
        .fetchPageStatus(item.id)
        .then(async (s) => {
          if (s.pending && Date.now() - started < 10 * 60_000) return;
          setStatus(s);
          if (!s.pending && !s.error) {
            await fetched.current();
            setNote('Fetched: this is the page as it is now.');
          }
        })
        .catch(() => undefined);
    }, 10_000);
    return () => clearInterval(timer);
  }, [status?.pending, item.id]);

  async function start() {
    setNote(null);
    try {
      setStatus(await api.fetchPage(item.id));
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not ask for the page');
    }
  }

  const label = item.hasHtml ? 'Fetch full page again' : 'Fetch full page';
  return (
    <div className="reader__images">
      <span>
        {status?.pending
          ? status.helperOnline
            ? 'Fetching the page on your PC…'
            : 'Waiting for your PC to come online to fetch the page…'
          : status?.error
            ? `Last try: ${status.error}`
            : (note ?? 'Only a summary or the wrong text? Your PC can fetch the whole article from the web page.')}
      </span>
      {!status?.pending && (
        <button className="btn btn--small" onClick={() => void start()}>
          {status?.error ? 'Try again' : label}
        </button>
      )}
    </div>
  );
}
