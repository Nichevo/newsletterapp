import type { ItemSummary } from '@newsletterapp/shared';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useDensity, useViewOptions } from './DensityToggle';
import { readingMinutes, shortTime } from '../format';
import { IconBookmark, IconCheck, IconHighlight, IconSparkle } from '../icons';

const KIND_CHIP: Record<ItemSummary['kind'], string> = { newsletter: 'Newsletter', feed: 'Feed', site: 'Site', ai: 'AI note' };
const PLATFORM_CHIP = { reddit: 'Reddit', youtube: 'YouTube', github: 'GitHub' } as const;

const THRESHOLD = 88; // px of travel before a swipe counts
const MAX = 120;

/** What a swipe to one side does: the handler, its label and which look it gets. */
export interface SwipeAction {
  run: (item: ItemSummary) => void;
  label: string;
  kind: 'read' | 'save';
}

export function ItemRow({ item, left, right }: { item: ItemSummary; left: SwipeAction; right: SwipeAction }) {
  const navigate = useNavigate();
  const density = useDensity();
  const opts = useViewOptions();
  const [dx, setDx] = useState(0);
  const [viewing, setViewing] = useState(false);
  const [snapping, setSnapping] = useState(false);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const axis = useRef<'x' | 'y' | null>(null);
  const moved = useRef(false);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    axis.current = null;
    moved.current = false;
    setSnapping(false);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const ddx = e.clientX - s.x;
    const ddy = e.clientY - s.y;
    if (!axis.current) {
      if (Math.abs(ddx) < 6 && Math.abs(ddy) < 6) return;
      axis.current = Math.abs(ddx) > Math.abs(ddy) ? 'x' : 'y';
      if (axis.current === 'x') e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (axis.current !== 'x') return;
    moved.current = true;
    const clamped = Math.max(-MAX, Math.min(MAX, ddx));
    setDx(clamped);
  }

  function finish(e: PointerEvent<HTMLDivElement>) {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    start.current = null;
    if (axis.current === 'x') {
      if (dx <= -THRESHOLD) left.run(item);
      else if (dx >= THRESHOLD) right.run(item);
    }
    setSnapping(true);
    setDx(0);
  }

  function onClick() {
    if (moved.current) {
      moved.current = false;
      return;
    }
    navigate(`/item/${item.id}`);
  }

  const bg = dx < 0 ? `var(--swipe-${left.kind})` : dx > 0 ? `var(--swipe-${right.kind})` : 'transparent';
  const kindClass = `chip chip--${item.kind}`;
  const preview = item.summary ?? item.preheader ?? item.snippet;
  const expanded = density === 'expanded';
  const hasTags = item.savedAt || item.interestingAt || item.likely || item.category || item.sponsored || item.tags.length > 0;
  const showTags = hasTags && (expanded ? opts.expandedTags : density === 'card' && opts.cardTags);
  const showPreview = preview && (expanded ? true : density === 'card' && opts.cardLines > 0);
  const previewLines = expanded ? (opts.expandedFullSummary ? 'unset' : 4) : opts.cardLines;

  return (
    <div className={`row row--${density}${item.readAt ? ' row--read' : ''}`} style={{ background: bg }}>
      {viewing && item.leadImage && <PictureViewer src={item.leadImage.src} alt={item.leadImage.alt ?? item.leadImage.title ?? ''} onClose={() => setViewing(false)} />}
      <div className="row__under" aria-hidden="true">
        <span style={{ opacity: dx > 20 ? 1 : 0 }}>
          {right.kind === 'save' ? <IconBookmark /> : <IconCheck />}
          {right.label}
        </span>
        <span style={{ opacity: dx < -20 ? 1 : 0 }}>
          {left.kind === 'save' ? <IconBookmark /> : <IconCheck />}
          {left.label}
        </span>
      </div>
      <div
        className={`row__card${snapping ? ' row__card--snap' : ''}`}
        style={{ transform: `translateX(${dx}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onClick={onClick}
        role="link"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') navigate(`/item/${item.id}`);
        }}
      >
        <div className="row__meta">
          {!item.readAt && <span className="row__dot" />}
          <span className="row__source">{item.sourceName ?? item.fromName ?? item.fromEmail}</span>
          <span className={kindClass}>{item.platform ? PLATFORM_CHIP[item.platform] : KIND_CHIP[item.kind]}</span>
          {item.highlightCount > 0 && (
            <span
              className="row__marks"
              title={`${item.highlightCount} highlight${item.highlightCount === 1 ? '' : 's'}${item.noteCount ? `, ${item.noteCount} AI note${item.noteCount === 1 ? '' : 's'}` : ''}`}
            >
              <IconHighlight size={13} />
              {item.highlightCount}
              {item.noteCount > 0 && (
                <>
                  <IconSparkle size={13} style={{ marginLeft: 4 }} />
                  {item.noteCount}
                </>
              )}
            </span>
          )}
          <span className="row__time">
            {item.wordCount ? `${readingMinutes(item.wordCount)} min · ` : ''}
            {shortTime(item.receivedAt)}
          </span>
        </div>
        <span className="row__title">{item.subject}</span>
        {expanded && item.leadImage && (
          <figure className="row__picture">
            <div className="row__picture-frame">
              <img src={item.leadImage.src} alt={item.leadImage.alt ?? item.leadImage.title ?? ''} loading="lazy" referrerPolicy="no-referrer" />
              <button
                type="button"
                className="row__picture-open"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setViewing(true);
                }}
              >
                Whole picture
              </button>
            </div>
            {item.leadImage.title && <figcaption>{item.leadImage.title}</figcaption>}
            {item.leadImage.alt && item.leadImage.alt !== item.leadImage.title && (
              <figcaption className="row__picture-alt">
                <span className="row__picture-tag">Alt</span> {item.leadImage.alt}
              </figcaption>
            )}
          </figure>
        )}
        {showPreview ? (
          <span className="row__snippet" style={{ WebkitLineClamp: previewLines }}>
            {preview}
          </span>
        ) : null}
        {expanded && opts.expandedPoints > 0 && item.keyPoints.length > 0 && (
          <ul className="row__points">
            {item.keyPoints.slice(0, opts.expandedPoints).map((k) => (
              <li key={k}>{k}</li>
            ))}
          </ul>
        )}
        {expanded && opts.expandedWhy && item.whyItMatters && <span className="row__why">Why it matters: {item.whyItMatters}</span>}
        {showTags && (
          <div className="row__tags">
            {item.savedAt && <span className="chip chip--warn">Saved</span>}
            {item.interestingAt && <span className="chip chip--warn">★ Interesting</span>}
            {item.likely && !item.interestingAt && !item.readAt && <span className="chip chip--outline">Likely interesting</span>}
            {item.category && <span className="chip chip--category">{item.category}</span>}
            {item.sponsored && <span className="chip chip--outline">Sponsored</span>}
            {item.tags.map((t) => (
              <span key={t} className="chip chip--outline">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** WordPress serves cut-down copies named like "chart-1200x630.jpg"; the original drops the size. */
function originalSize(src: string): string | null {
  const full = src.replace(/-\d{2,5}x\d{2,5}(\.(?:jpe?g|png|webp|gif|avif))(\?.*)?$/i, '$1$2');
  return full !== src ? full : null;
}

/** The whole picture on its own screen, full width and scrollable, for tall infographics. */
function PictureViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [shown, setShown] = useState(() => originalSize(src) ?? src);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', key);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  return createPortal(
    <div className="picture-viewer" role="dialog" aria-label="Whole picture" onClick={onClose}>
      <button type="button" className="picture-viewer__close" onClick={onClose}>
        Close
      </button>
      <img
        src={shown}
        alt={alt}
        referrerPolicy="no-referrer"
        onClick={(e) => e.stopPropagation()}
        onError={() => shown !== src && setShown(src)}
      />
      <a className="picture-viewer__link" href={shown} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
        Open in a new tab
      </a>
    </div>,
    document.body,
  );
}
