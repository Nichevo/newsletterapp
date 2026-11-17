import { ITEM_TAGS_MAX, MY_TAG_MAX, cleanTagLabel, tagKey, type ItemSummary, type TagEditResult } from '@newsletterapp/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api';

/** Suggestions for the tag box: every tag in use, most used first (one cached call per visit). */
let known: Promise<string[]> | null = null;
function knownTags(): Promise<string[]> {
  known ??= api
    .tags(0)
    .then((l) => [...l.tags].sort((a, b) => b.n - a.n).slice(0, 600).map((t) => t.label))
    .catch(() => {
      known = null;
      return [];
    });
  return known;
}

/**
 * Add your own tags to an item, or take off a wrong one. Your edits go into the
 * item's tags straight away and stay when the AI summarises it again.
 */
export function TagEditor({ item, onChange, onClose }: { item: ItemSummary; onChange: (r: TagEditResult) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const mine = new Set((item.myTags ?? []).map(tagKey));
  const full = item.tags.length >= ITEM_TAGS_MAX;

  useEffect(() => {
    // Only with a mouse: on an iPad or phone a focus the page makes itself can
    // leave the box looking ready while the on-screen keyboard never opens.
    if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) input.current?.focus();
    void knownTags().then(setSuggest);
  }, []);

  async function edit(e: { add: string } | { remove: string }) {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.editTag(item.id, e));
      if ('add' in e) setText('');
      // Tag lists are cached for a while; the next visit asks again.
      known = null;
      void knownTags().then(setSuggest);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not save');
    } finally {
      setBusy(false);
    }
  }

  function add() {
    const label = cleanTagLabel(text);
    if (!label) return;
    if (item.tags.some((t) => tagKey(t) === tagKey(label))) {
      setError(`It already has “${label}”`);
      return;
    }
    void edit({ add: label });
  }

  const have = new Set(item.tags.map(tagKey));
  // Tags already in use that match what's typed: starting with it first, then containing it.
  const typed = tagKey(cleanTagLabel(text));
  const options = typed
    ? suggest
        .filter((s) => !have.has(tagKey(s)) && tagKey(s) !== typed && tagKey(s).includes(typed))
        .sort((a, b) => Number(!tagKey(a).startsWith(typed)) - Number(!tagKey(b).startsWith(typed)))
        .slice(0, 8)
    : [];

  return (
    <div className="tagedit" role="group" aria-label="Edit tags">
      <div className="tagedit__head">
        <strong>Tags</strong>
        <button type="button" className="btn btn--small" onClick={onClose}>
          Done
        </button>
      </div>
      {item.tags.length ? (
        <ul className="tagedit__list">
          {item.tags.map((t) => (
            <li key={t} className={`tagedit__tag${mine.has(tagKey(t)) ? ' tagedit__tag--mine' : ''}`}>
              <span>{t}</span>
              <span className="tagedit__who">{mine.has(tagKey(t)) ? 'yours' : 'AI'}</span>
              <button type="button" className="tagedit__x" aria-label={`Take off ${t}`} title={`Take off ${t}`} disabled={busy} onClick={() => void edit({ remove: t })}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted tagedit__none">No tags yet.</p>
      )}
      <form
        className="tagedit__add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          ref={input}
          type="text"
          inputMode="text"
          enterKeyHint="done"
          autoCapitalize="none"
          maxLength={MY_TAG_MAX}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby={options.length ? listId : undefined}
          placeholder={full ? `Up to ${ITEM_TAGS_MAX} tags` : 'Add a tag, e.g. Nuclear power'}
          aria-label="New tag"
          value={text}
          disabled={full}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />
        <button type="submit" className="btn btn--primary btn--small" disabled={busy || full || !cleanTagLabel(text)}>
          Add
        </button>
      </form>
      {options.length > 0 && (
        <div className="tagedit__suggest" id={listId} aria-label="Tags you already use">
          {options.map((s) => (
            <button key={s} type="button" className="chip chip--tag chip--button" disabled={busy || full} onClick={() => void edit({ add: s })}>
              + {s}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error tagedit__error">{error}</p>}
      {item.removedTags?.length ? (
        <p className="tagedit__removed">
          Taken off:{' '}
          {item.removedTags.map((t) => (
            <button key={t} type="button" className="chip chip--outline chip--button" title={`Put ${t} back`} disabled={busy || full} onClick={() => void edit({ add: t })}>
              {t} ↩
            </button>
          ))}
        </p>
      ) : null}
      <p className="muted tagedit__note">Tags you add stay when the AI summarises this again, and ones you take off stay off.</p>
    </div>
  );
}
