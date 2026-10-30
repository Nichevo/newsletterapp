import type { ItemSummary } from '@newsletterapp/shared';
import { useRef, useState, type PointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { shortTime } from '../format';
import { IconBookmark, IconCheck } from '../icons';

const THRESHOLD = 88; // px of travel before a swipe counts
const MAX = 120;

export function ItemRow({
  item,
  onSwipeLeft,
  onSwipeRight,
  leftLabel = 'Mark read',
  rightLabel = 'Save for later',
}: {
  item: ItemSummary;
  onSwipeLeft: (item: ItemSummary) => void;
  onSwipeRight: (item: ItemSummary) => void;
  leftLabel?: string;
  rightLabel?: string;
}) {
  const navigate = useNavigate();
  const [dx, setDx] = useState(0);
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
      if (dx <= -THRESHOLD) onSwipeLeft(item);
      else if (dx >= THRESHOLD) onSwipeRight(item);
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

  const bg = dx < 0 ? 'var(--swipe-read)' : dx > 0 ? 'var(--swipe-save)' : 'transparent';
  const kindClass = `chip chip--${item.kind}`;

  return (
    <div className={`row${item.readAt ? ' row--read' : ''}`} style={{ background: bg }}>
      <div className="row__under" aria-hidden="true">
        <span style={{ opacity: dx > 20 ? 1 : 0 }}>
          <IconBookmark />
          {rightLabel}
        </span>
        <span style={{ opacity: dx < -20 ? 1 : 0 }}>
          <IconCheck />
          {leftLabel}
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
          <span className={kindClass}>{item.kind === 'newsletter' ? 'Newsletter' : item.kind === 'feed' ? 'Feed' : 'Site'}</span>
          <span className="row__time">{shortTime(item.receivedAt)}</span>
        </div>
        <span className="row__title">{item.subject}</span>
        {item.summary || item.snippet ? <span className="row__snippet">{item.summary ?? item.snippet}</span> : null}
        {(item.savedAt || item.tags.length > 0) && (
          <div className="row__tags">
            {item.savedAt && <span className="chip chip--warn">Saved</span>}
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
