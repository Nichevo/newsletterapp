import { useEffect, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { HELP, type HelpTopic } from '../help';

/**
 * A small "?" next to a setting's name. Tapping it opens a short note on what
 * the setting does, its usual value, the trade-off and any fixed limit behind it.
 * The note opens in a sheet outside the setting's own label, so tapping in it
 * never flips the switch.
 */
export function Help({ topic }: { topic: HelpTopic }) {
  const [open, setOpen] = useState(false);
  const entry = HELP[topic];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function toggle(e: MouseEvent) {
    // Inside a <label> a tap would otherwise flip the switch next to it.
    e.preventDefault();
    e.stopPropagation();
    setOpen((o) => !o);
  }

  return (
    <>
      <button type="button" className="help" aria-label={`What is “${entry.title}”?`} aria-haspopup="dialog" onClick={toggle}>
        ?
      </button>
      {open &&
        createPortal(
          <div className="sheet" role="dialog" aria-label={entry.title} onClick={(e) => e.stopPropagation()}>
            <div className="sheet__scrim" onClick={() => setOpen(false)} />
            <div className="sheet__panel helpsheet">
              <strong>{entry.title}</strong>
              {entry.text.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
              {entry.fixed && <p className="helpsheet__fixed">{entry.fixed}</p>}
              <div className="inline">
                <button className="btn btn--small" onClick={() => setOpen(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
