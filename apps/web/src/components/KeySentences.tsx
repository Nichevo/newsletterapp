import {
  KEY_KINDS,
  type Highlight,
  type ItemKeySentences,
  type ItemReferences,
  type ItemSummary,
  type KeyKind,
  type KeyMark,
} from '@newsletterapp/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { anchorFor } from '../highlight';
import { applyKeyMarks, clearKeyMarks, clearKeyView, drawnKeys, keySpans, kindDot, revealKey, setKeyView } from '../keySentences';
import { IconChevron } from '../icons';
import { KeyTabs } from './KeyTabs';

// Key sentences in the reader: the bar under the article's header (colour
// chips that double as the legend, Skim, step through), the coloured
// sentences themselves, and the sheet for a tapped one (Keep as my
// highlight, Not key, Wrong colour). None of this touches your highlights
// unless you tap Keep.

type Root = ShadowRoot | HTMLElement;

const EMPTY: ItemKeySentences = {
  status: null,
  note: null,
  marks: [],
  sentences: null,
  model: null,
  kinds: [],
  skimDefault: false,
  helperLastSeenAt: null,
  terms: [],
};


export function useKeySentences({
  item,
  root,
  enabled,
  onKept,
}: {
  item: ItemSummary | null;
  root: Root | null;
  /** Key sentences switched on in Settings. */
  enabled: boolean;
  onKept: (h: Highlight) => void;
}) {
  const itemId = item?.id ?? null;
  const [data, setData] = useState<ItemKeySentences>(EMPTY);
  const [on, setOn] = useState(true);
  const [skim, setSkim] = useState(false);
  const [hidden, setHidden] = useState<Set<KeyKind>>(new Set());
  const [sheet, setSheet] = useState<number | null>(null);
  const [drawn, setDrawn] = useState(0);
  const [asked, setAsked] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [refs, setRefs] = useState<ItemReferences | null>(null);
  const step = useRef(-1);

  const loadRefs = useCallback((id: string) => {
    api
      .references(id)
      .then((r) => setRefs((cur) => (id === itemIdRef.current ? r : cur)))
      .catch(() => null);
  }, []);
  const itemIdRef = useRef<string | null>(null);

  const load = useCallback(
    (id: string) =>
      api
        .keySentences(id)
        .then((d) => {
          setData(d);
          return d;
        })
        .catch(() => null),
    [],
  );

  // A new article: start afresh, and load its key sentences when it has (or is waiting for) some.
  const status = item?.keySentences ?? null;
  useEffect(() => {
    setData(EMPTY);
    setSheet(null);
    setHidden(new Set());
    setOn(true);
    setAsked(false);
    step.current = -1;
    setRefs(null);
    itemIdRef.current = itemId;
    if (!itemId || !enabled) return;
    loadRefs(itemId);
    void load(itemId).then((d) => d && setSkim(d.status === 'done' && d.skimDefault));
  }, [itemId, enabled, load, loadRefs]);

  // Waiting for the PC: look again every 10 seconds while the app is on screen.
  const waiting = data.status === 'pending' || data.status === 'working';
  useEffect(() => {
    if (!waiting || !itemId) return;
    const t = window.setInterval(() => document.visibilityState === 'visible' && void load(itemId), 10_000);
    return () => window.clearInterval(t);
  }, [waiting, itemId, load]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Colour the sentences whenever the article is drawn afresh or the marks change.
  const [found, setFound] = useState(0);
  useEffect(() => {
    if (!root) return;
    if (!enabled || data.status !== 'done') {
      clearKeyMarks(root);
      clearKeyView(root);
      setFound(0);
      return;
    }
    setFound(applyKeyMarks(root, data.marks));
  }, [root, drawn, data, enabled]);

  useEffect(() => {
    if (root && enabled && data.status === 'done') setKeyView(root, { on, skim, hidden });
  }, [root, drawn, data, enabled, on, skim, hidden]);

  const onDrawn = useCallback(() => setDrawn((n) => n + 1), []);
  const onKeyTap = useCallback((i: number) => setSheet(i), []);

  const live = useMemo(() => data.marks.map((m, i) => ({ m, i })).filter((x) => x.m.fix !== 'removed'), [data.marks]);
  const counts = useMemo(() => {
    const c = new Map<KeyKind, number>();
    for (const { m } of live) c.set(m.kind, (c.get(m.kind) ?? 0) + 1);
    return c;
  }, [live]);
  const kindName = (k: KeyKind) => data.kinds.find((x) => x.id === k)?.name ?? k;

  function go(dir: 1 | -1) {
    if (!root) return;
    const order = drawnKeys(root, hidden);
    if (!order.length) return;
    step.current = (step.current + dir + order.length) % order.length;
    revealKey(root, order[step.current]!);
  }

  async function find() {
    if (!itemId) return;
    setAsked(true);
    try {
      await api.findKeySentences(itemId);
      await load(itemId);
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Couldn't ask the PC");
    }
  }

  async function fix(index: number, action: 'remove' | 'kind' | 'restore', kind?: KeyKind) {
    if (!itemId) return;
    setSheet(null);
    try {
      const r = await api.fixKeySentence(itemId, { index, action, kind });
      setData((d) => ({ ...d, marks: r.marks }));
      if (action === 'remove') setToast('Taken out. Thanks, this helps tune it.');
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Couldn't save that");
    }
  }

  async function keep(index: number) {
    if (!itemId || !root) return;
    setSheet(null);
    const spans = keySpans(root, index);
    if (!spans.length) return;
    const range = document.createRange();
    range.setStartBefore(spans[0]!.firstChild ?? spans[0]!);
    range.setEndAfter(spans[spans.length - 1]!.lastChild ?? spans[spans.length - 1]!);
    const anchor = anchorFor(root, range);
    if (!anchor) return setToast("Couldn't find that sentence in the text");
    try {
      const h = await api.addHighlight(itemId, anchor);
      onKept(h);
      setToast('Kept as your highlight');
    } catch (err) {
      setToast(err instanceof Error ? `Couldn't keep it: ${err.message}` : "Couldn't keep it");
    }
  }

  // ----- What shows -----

  // The legend sits in the header (it scrolls away); a slim bar stays at the top while you read.
  let bar: ReactNode = null;
  let legend: ReactNode = null;
  const shownKinds = KEY_KINDS.filter((k) => counts.has(k));
  if (enabled && item && item.kind !== 'ai' && data.status === 'done' && live.length > 0) {
    legend = on ? (
      <div className="kslegend" role="group" aria-label="Key sentence colours: tap one to hide or show it">
        {shownKinds.map((k) => (
          <button
            key={k}
            className="kschip"
            aria-pressed={!hidden.has(k)}
            onClick={() =>
              setHidden((h) => {
                const next = new Set(h);
                if (next.has(k)) next.delete(k);
                else next.add(k);
                return next;
              })
            }
          >
            <i style={{ background: kindDot(k) }} aria-hidden="true" />
            {kindName(k)}
            <b>{counts.get(k)}</b>
          </button>
        ))}
      </div>
    ) : null;
    bar = (
      <div className="ksbar" role="toolbar" aria-label="Key sentences">
        <button className="ksbar__switch" aria-pressed={on} title={on ? 'Hide the colours' : 'Show the colours'} onClick={() => setOn((v) => !v)}>
          <span className="ksbar__swatch" aria-hidden="true">
            {shownKinds.map((k) => (
              <i key={k} style={{ background: kindDot(k) }} />
            ))}
          </span>
          Key sentences
        </button>
        <span className="ksbar__count">
          {live.length}
          {data.sentences ? ` of ${data.sentences}` : ''}
        </span>
        {on && (
          <>
            <button className="ksbar__switch" aria-pressed={skim} title="Fade everything but the key sentences" onClick={() => setSkim((v) => !v)}>
              Skim
            </button>
            <span className="ksbar__nav">
              <button className="iconbtn" aria-label="Previous key sentence" onClick={() => go(-1)}>
                <IconChevron size={18} style={{ transform: 'rotate(90deg)' }} />
              </button>
              <button className="iconbtn" aria-label="Next key sentence" onClick={() => go(1)}>
                <IconChevron size={18} style={{ transform: 'rotate(-90deg)' }} />
              </button>
            </span>
          </>
        )}
      </div>
    );
  }

  // The quieter line in the header: waiting, skipped, or the button to ask.
  let line: ReactNode = null;
  if (enabled && item && item.kind !== 'ai') {
    if (waiting) {
      const away = data.helperLastSeenAt !== null && Date.now() - data.helperLastSeenAt > 5 * 60_000;
      line = (
        <p className="ksline">
          <span className="ksline__dots" aria-hidden="true" />
          Key sentences: waiting for your PC{away ? " (it hasn't checked in for a while)" : ''}.
        </p>
      );
    } else if (data.status === 'done' && live.length > 0) {
      line =
        found < live.length ? (
          <p className="ksline">
            {found} of {live.length} key sentences found in this copy of the article.
          </p>
        ) : null;
    } else if (data.status === 'done' || data.status === 'none' || data.status === 'failed') {
      line = (
        <p className="ksline">
          No key sentences{data.note ? `: ${data.note.replace(/\.$/, '')}` : ''}.{' '}
          <button className="linkbtn" disabled={asked} onClick={() => void find()}>
            Try anyway
          </button>
        </p>
      );
    } else if (data.status === null && status === null && (item.wordCount === null || item.wordCount >= 300)) {
      line = (
        <p className="ksline">
          <button className="linkbtn" disabled={asked} onClick={() => void find()}>
            Find key sentences
          </button>
        </p>
      );
    }
  }

  const tapped = sheet !== null ? data.marks[sheet] : undefined;
  const overlays = (
    <>
      {tapped && sheet !== null && (
        <KeySheet
          mark={tapped}
          kindName={kindName}
          kinds={data.kinds.filter((k) => k.on || k.id === tapped.kind).map((k) => k.id)}
          model={data.model}
          onKeep={() => void keep(sheet)}
          onRemove={() => void fix(sheet, 'remove')}
          onKind={(k) => void fix(sheet, 'kind', k)}
          onRestore={() => void fix(sheet, 'restore')}
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

  const below =
    enabled && item && item.kind !== 'ai' ? <KeyTabs data={data} refs={refs} root={root} onRefs={() => itemId && loadRefs(itemId)} /> : null;

  return { bar, legend, line, overlays, below, onDrawn, onKeyTap };
}

function KeySheet({
  mark,
  kindName,
  kinds,
  model,
  onKeep,
  onRemove,
  onKind,
  onRestore,
  onClose,
}: {
  mark: KeyMark;
  kindName: (k: KeyKind) => string;
  kinds: KeyKind[];
  model: string | null;
  onKeep: () => void;
  onRemove: () => void;
  onKind: (k: KeyKind) => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="sheet" role="dialog" aria-label="Key sentence">
      <div className="sheet__scrim" onClick={onClose} />
      <div className="sheet__panel">
        <div className="kssheet__head">
          <i style={{ background: kindDot(mark.kind) }} aria-hidden="true" />
          <strong>{kindName(mark.kind)}</strong>
          <span className="hint">
            {mark.fix === 'kind' && mark.was ? `you changed it from ${kindName(mark.was)}` : model ? `marked by ${model}` : 'marked by your PC'}
          </span>
        </div>
        <blockquote className="hlquote">{mark.quote}</blockquote>
        <div className="hlbar__row">
          <button className="btn btn--small" onClick={onKeep}>
            Keep as my highlight
          </button>
          <button className="btn btn--ghost btn--small" onClick={onRemove}>
            Not key
          </button>
          <button className="btn btn--ghost btn--small" aria-expanded={picking} onClick={() => setPicking((v) => !v)}>
            Wrong colour…
          </button>
          {mark.fix === 'kind' && (
            <button className="btn btn--ghost btn--small" onClick={onRestore}>
              Undo my change
            </button>
          )}
        </div>
        {picking && (
          <div className="hlbar__row">
            {kinds
              .filter((k) => k !== mark.kind)
              .map((k) => (
                <button key={k} className="kschip" onClick={() => onKind(k)}>
                  <i style={{ background: kindDot(k) }} aria-hidden="true" />
                  {kindName(k)}
                </button>
              ))}
          </div>
        )}
        <span className="hint">These colours are separate from your highlights. Only “Keep as my highlight” adds one to your Highlights page.</span>
        <div className="inline" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn--small" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
