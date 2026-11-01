import { markdownToHtml, type Ask, type AskPreset, type Highlight, type HighlightAnchor } from '@newsletterapp/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { shortTime } from '../format';
import { anchorFor, applyMarks, selectedRange } from '../highlight';
import { IconHighlight, IconSparkle, IconThumbDown, IconThumbUp } from '../icons';
import { getAskOutput, setAskOutput, type AskOutputPref } from '../prefs';

// The highlight bar that appears when text is selected in the reader, the
// sheet for an existing highlight, and the AI notes card.

type Root = ShadowRoot | HTMLElement;

export interface Capture {
  anchor: HighlightAnchor;
  /** Where the selection is on screen, for the floating bar on a PC. */
  rect: { top: number; bottom: number; left: number; right: number };
}

const coarse = () => window.matchMedia('(pointer: coarse)').matches;

/**
 * Follows the text selection inside the article. While the reader is
 * pressing a button on the bar, a selection that collapses (phones clear it
 * on the tap) keeps its last capture so the button still knows the text.
 */
export function useArticleSelection(getRoots: () => Root[]) {
  const [capture, setCapture] = useState<Capture | null>(null);
  const holding = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onChange = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        for (const root of getRoots()) {
          const range = selectedRange(root);
          if (!range) continue;
          const anchor = anchorFor(root, range);
          if (!anchor || anchor.quote.length < 2) continue;
          const r = range.getBoundingClientRect();
          setCapture({ anchor, rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } });
          return;
        }
        if (!holding.current) setCapture(null);
      }, 200);
    };
    document.addEventListener('selectionchange', onChange);
    return () => {
      document.removeEventListener('selectionchange', onChange);
      window.clearTimeout(timer.current);
    };
  }, [getRoots]);

  const clear = useCallback(() => {
    holding.current = false;
    setCapture(null);
    document.getSelection()?.removeAllRanges();
  }, []);

  /** Pointer handlers for the bar: keep the capture while it's being used. */
  const hold = useMemo(
    () => ({
      onPointerDown: () => {
        holding.current = true;
      },
      // Stops a mouse click on the bar from clearing the selection on a PC.
      onMouseDown: (e: { preventDefault: () => void; target: EventTarget }) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      },
    }),
    [],
  );

  return { capture, clear, hold, release: () => (holding.current = false) };
}

const OUTPUT_LABEL: Record<AskOutputPref, string> = { default: 'Default', note: 'Note', item: 'Article', both: 'Both' };
const KEYS: Record<string, string> = { d: 'define', m: 'more', e: 'example' };
const BAR_SLOTS = 4;

/** The bar shown while text is selected: Highlight, the first few prompts, More… and Ask your own. */
export function SelectionBar({
  capture,
  presets,
  busy,
  hold,
  onHighlight,
  onAsk,
  onClose,
}: {
  capture: Capture;
  presets: AskPreset[];
  busy: boolean;
  hold: ReturnType<typeof useArticleSelection>['hold'];
  onHighlight: () => void;
  onAsk: (presetId: string | null, output: AskOutputPref, question?: string) => void;
  onClose: () => void;
}) {
  const [more, setMore] = useState(false);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const [output, setOutput] = useState<AskOutputPref>(getAskOutput());
  const enabled = presets.filter((p) => p.enabled);
  const shown = enabled.slice(0, BAR_SLOTS);
  const rest = enabled.slice(BAR_SLOTS);
  const phone = coarse();

  function pickOutput(v: AskOutputPref) {
    setOutput(v);
    setAskOutput(v);
  }

  // Keys on a PC: H highlight, D define, M more info, E example, A ask your own, Esc closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.altKey || e.ctrlKey || e.metaKey || asking) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') return onClose();
      if (k === 'h') {
        e.preventDefault();
        onHighlight();
      } else if (k === 'a') {
        e.preventDefault();
        setAsking(true);
      } else if (KEYS[k] && enabled.some((p) => p.id === KEYS[k])) {
        e.preventDefault();
        onAsk(KEYS[k]!, output);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [asking, enabled, output, onAsk, onClose, onHighlight]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (question.trim()) onAsk(null, output, question.trim());
  }

  // On a PC the bar floats just under the selection (above it near the bottom of the window).
  const style: CSSProperties = {};
  if (!phone) {
    const width = Math.min(560, window.innerWidth - 24);
    const below = capture.rect.bottom + 10;
    style.position = 'fixed';
    style.width = width;
    style.left = Math.max(12, Math.min((capture.rect.left + capture.rect.right) / 2 - width / 2, window.innerWidth - width - 12));
    if (below + 140 < window.innerHeight) style.top = below;
    else style.bottom = Math.max(12, window.innerHeight - capture.rect.top + 10);
  }

  return (
    <div className={`hlbar${phone ? ' hlbar--dock' : ''}`} style={style} role="toolbar" aria-label="Highlight and ask the AI" {...hold}>
      {asking ? (
        <form className="hlbar__ask" onSubmit={submit}>
          <input
            className="input"
            autoFocus
            placeholder="Ask about the highlighted text…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setAsking(false)}
          />
          <button className="btn btn--small" type="submit" disabled={busy || !question.trim()}>
            Ask
          </button>
          <button className="btn btn--ghost btn--small" type="button" onClick={() => setAsking(false)}>
            Back
          </button>
        </form>
      ) : (
        <div className="hlbar__row">
          <button className="hlbar__btn hlbar__btn--plain" disabled={busy} onClick={onHighlight} title="Highlight (H)">
            <IconHighlight size={16} />
            Highlight
          </button>
          {shown.map((p) => (
            <button key={p.id} className="hlbar__btn" disabled={busy} onClick={() => onAsk(p.id, output)}>
              {p.label}
            </button>
          ))}
          <button className="hlbar__btn" aria-expanded={more} onClick={() => setMore((m) => !m)}>
            {more ? 'Less' : 'More…'}
          </button>
        </div>
      )}
      {more && !asking && (
        <div className="hlbar__row">
          {rest.map((p) => (
            <button key={p.id} className="hlbar__btn" disabled={busy} onClick={() => onAsk(p.id, output)}>
              {p.label}
            </button>
          ))}
          <button className="hlbar__btn" disabled={busy} onClick={() => setAsking(true)} title="Ask your own (A)">
            Ask your own…
          </button>
        </div>
      )}
      <div className="hlbar__out">
        <span>Answer as</span>
        <div className="segmented segmented--small" role="group" aria-label="Where the answer goes">
          {(Object.keys(OUTPUT_LABEL) as AskOutputPref[]).map((v) => (
            <button
              key={v}
              aria-pressed={output === v}
              onClick={() => pickOutput(v)}
              title={v === 'default' ? "Each prompt's own default" : undefined}
            >
              {OUTPUT_LABEL[v]}
            </button>
          ))}
        </div>
        <button className="hlbar__close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
    </div>
  );
}

/** Opened by tapping a highlight: ask about it, jump to its notes, or remove it. */
export function HighlightSheet({
  highlight,
  asks,
  presets,
  busy,
  onAsk,
  onShowNotes,
  onDelete,
  onClose,
}: {
  highlight: Highlight;
  asks: Ask[];
  presets: AskPreset[];
  busy: boolean;
  onAsk: (presetId: string | null, output: AskOutputPref, question?: string) => void;
  onShowNotes: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState('');
  const output = getAskOutput();
  return (
    <div className="sheet" role="dialog" aria-label="Highlight">
      <div className="sheet__scrim" onClick={onClose} />
      <div className="sheet__panel">
        <blockquote className="hlquote">{highlight.quote}</blockquote>
        {asks.length > 0 && (
          <button className="btn btn--ghost btn--small" onClick={onShowNotes}>
            See {asks.length === 1 ? 'the note' : `${asks.length} notes`}
          </button>
        )}
        <span className="label">Ask the AI</span>
        <div className="hlbar__row">
          {presets
            .filter((p) => p.enabled)
            .map((p) => (
              <button key={p.id} className="hlbar__btn" disabled={busy} onClick={() => onAsk(p.id, output)}>
                {p.label}
              </button>
            ))}
        </div>
        <form
          className="hlbar__ask"
          onSubmit={(e) => {
            e.preventDefault();
            if (question.trim()) onAsk(null, output, question.trim());
          }}
        >
          <input className="input" placeholder="Or ask your own question…" value={question} onChange={(e) => setQuestion(e.target.value)} />
          <button className="btn btn--small" type="submit" disabled={busy || !question.trim()}>
            Ask
          </button>
        </form>
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <button className="btn btn--ghost btn--small" onClick={onDelete}>
            Remove highlight{asks.length ? ' and its notes' : ''}
          </button>
          <button className="btn btn--small" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

const OFFLINE_MS = 3 * 60_000;

function waitingText(ask: Ask, helperLastSeenAt: number | null): string {
  if (helperLastSeenAt !== null && Date.now() - helperLastSeenAt > OFFLINE_MS)
    return `Waiting for your PC (offline since ${shortTime(helperLastSeenAt)})`;
  return ask.status === 'working' ? 'Your PC is writing the answer…' : 'Asking your PC…';
}

/** The AI's answers about highlights in this article, newest highlight last. */
export function AiNotes({
  highlights,
  asks,
  missing,
  helperLastSeenAt,
  flash,
  onReveal,
  onChanged,
  api,
}: {
  highlights: Highlight[];
  asks: Ask[];
  missing: string[];
  helperLastSeenAt: number | null;
  flash: string | null;
  onReveal: (highlightId: string) => void;
  onChanged: () => void;
  api: {
    retryAsk: (id: string) => Promise<unknown>;
    rateAsk: (id: string, r: 1 | -1 | 0) => Promise<unknown>;
    deleteAsk: (id: string) => Promise<unknown>;
  };
}) {
  const shown = asks.filter((a) => a.output !== 'item' || a.status !== 'done');
  const articles = asks.filter((a) => a.output === 'item' && a.status === 'done' && a.newItemId);
  if (shown.length === 0 && articles.length === 0) return null;
  const byHighlight = new Map(highlights.map((h) => [h.id, h]));
  return (
    <section className="card notes" aria-label="AI notes">
      <span className="label" style={{ color: 'var(--amber-ink)' }}>
        <IconSparkle size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
        AI notes
      </span>
      {shown.map((a) => (
        <Note
          key={a.id}
          ask={a}
          highlight={byHighlight.get(a.highlightId) ?? null}
          missing={missing.includes(a.highlightId)}
          helperLastSeenAt={helperLastSeenAt}
          flash={flash === a.highlightId}
          onReveal={onReveal}
          onChanged={onChanged}
          api={api}
        />
      ))}
      {articles.map((a) => (
        <p key={a.id} className="note__article">
          {a.label} about “{shorten(byHighlight.get(a.highlightId)?.quote ?? '', 60)}” went to your inbox as a new article.{' '}
          <Link to={`/item/${a.newItemId}`}>Open it</Link>
        </p>
      ))}
    </section>
  );
}

const shorten = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function Note({
  ask,
  highlight,
  missing,
  helperLastSeenAt,
  flash,
  onReveal,
  onChanged,
  api,
}: {
  ask: Ask;
  highlight: Highlight | null;
  missing: boolean;
  helperLastSeenAt: number | null;
  flash: boolean;
  onReveal: (highlightId: string) => void;
  onChanged: () => void;
  api: Parameters<typeof AiNotes>[0]['api'];
}) {
  const [rating, setRating] = useState(ask.rating);
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => (ask.answer ? markdownToHtml(ask.answer) : ''), [ask.answer]);
  useEffect(() => setRating(ask.rating), [ask.rating]);
  useEffect(() => {
    if (flash) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [flash]);

  async function rate(v: 1 | -1) {
    const next = rating === v ? null : v;
    setRating(next);
    await api.rateAsk(ask.id, next ?? 0).catch(() => undefined);
  }

  return (
    <div ref={ref} className={`note${flash ? ' note--flash' : ''}`} id={`note-${ask.id}`}>
      {highlight && (
        <button className="note__quote" onClick={() => onReveal(highlight.id)} title="Show in the article">
          “{shorten(highlight.quote, 160)}”
        </button>
      )}
      {missing && <span className="hint">This passage is no longer in the article.</span>}
      <span className="note__label">
        {ask.label}
        {ask.question ? `: ${ask.question}` : ''}
      </span>
      {ask.status === 'done' && ask.answer ? (
        // markdownToHtml escapes everything first; only its own few tags come out.
        <div className="note__answer" dangerouslySetInnerHTML={{ __html: html }} />
      ) : ask.status === 'failed' ? (
        <p className="note__wait">
          Couldn't answer: {ask.error ?? 'unknown error'}{' '}
          <button className="quick__toggle" onClick={() => void api.retryAsk(ask.id).then(onChanged)}>
            Try again
          </button>
        </p>
      ) : (
        <p className="note__wait">
          <span className="dot-pulse" /> {waitingText(ask, helperLastSeenAt)}
        </p>
      )}
      {ask.sources.length > 0 && (
        <ul className="note__sources">
          {ask.sources.map((s) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noopener noreferrer nofollow">
                {s.title || s.url}
              </a>
            </li>
          ))}
        </ul>
      )}
      <div className="ai__foot">
        <p className="attribution">
          {ask.status === 'done' && ask.model ? `by ${ask.model} via ${ask.provider}` : `asked ${shortTime(ask.createdAt)}`}
          {ask.presetVersion ? ` · prompt v${ask.presetVersion}` : ''}
          {ask.seconds && ask.seconds >= 1 ? ` · ${Math.round(ask.seconds)}s` : ''}
          {ask.newItemId && (
            <>
              {' · '}
              <Link to={`/item/${ask.newItemId}`}>also in your inbox</Link>
            </>
          )}
        </p>
        <div className="inline">
          {ask.status === 'done' && (
            <>
              <button className="iconbtn iconbtn--small" aria-label="Good answer" aria-pressed={rating === 1} onClick={() => void rate(1)}>
                <IconThumbUp size={18} />
              </button>
              <button
                className="iconbtn iconbtn--small"
                aria-label="Poor answer"
                aria-pressed={rating === -1}
                onClick={() => void rate(-1)}
              >
                <IconThumbDown size={18} />
              </button>
            </>
          )}
          <button
            className="quick__toggle"
            onClick={() => {
              if (window.confirm('Remove this note? The highlight stays.')) void api.deleteAsk(ask.id).then(onChanged);
            }}
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

/** A text-only article, drawn by hand so highlight marks can split its text safely. */
export function TextBody({
  text,
  fontSize,
  highlights,
  activeHighlight,
  onRoot,
  onHighlightTap,
  onMissing,
}: {
  text: string;
  fontSize: number;
  highlights: Highlight[];
  activeHighlight: string | null;
  onRoot: (el: HTMLElement) => void;
  onHighlightTap: (id: string) => void;
  onMissing: (ids: string[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const key = highlights.map((h) => h.id).join(',');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = text;
    onRoot(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  useEffect(() => {
    const el = ref.current;
    if (el) onMissing(applyMarks(el, highlights, activeHighlight));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, key, activeHighlight]);
  return (
    <div
      ref={ref}
      className="reader__text"
      style={{ fontSize: fontSize + 1 }}
      onClick={(e) => {
        const mark = (e.target as HTMLElement).closest('mark[data-hl]') as HTMLElement | null;
        const sel = document.getSelection();
        if (mark && (!sel || sel.isCollapsed)) onHighlightTap(mark.dataset.hl!);
      }}
    />
  );
}
