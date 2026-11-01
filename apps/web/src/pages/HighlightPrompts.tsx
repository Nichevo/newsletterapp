import type { AskOutput, AskPreset, LookupMode } from '@newsletterapp/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { IconBack, IconChevron } from '../icons';

// Settings > AI > Highlight prompts: the prompts on the highlight bar in the
// reader. Rename, edit, reorder, switch off, or add your own. The first four
// switched on show on the bar; the rest are under "More…".

const OUTPUT_LABEL: Record<AskOutput, string> = { note: 'Note on the article', item: 'New article', both: 'Both' };
const LOOKUP_LABEL: Record<LookupMode, string> = {
  none: 'No lookups',
  wiki: 'Wikipedia + the article’s links',
  web: 'Web search',
  both: 'Wikipedia, links and web search',
};
const SLOTS = '{quote} {context} {title} {source} {interests}';

export function HighlightPromptsPage() {
  const navigate = useNavigate();
  const [presets, setPresets] = useState<AskPreset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api
      .askPresets()
      .then(setPresets)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, []);

  async function move(id: string, by: -1 | 1) {
    if (!presets) return;
    const list = [...presets];
    const i = list.findIndex((p) => p.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    setPresets(list);
    setPresets(await api.orderAskPresets(list.map((p) => p.id)).catch(() => list));
  }

  function replace(p: AskPreset) {
    setPresets((list) => list?.map((x) => (x.id === p.id ? p : x)) ?? null);
  }

  let onBar = 0;

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Highlight prompts</h1>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      {!presets && !error && <div className="spinner">Loading…</div>}
      {presets && (
        <div className="section">
          <span className="hint">
            Select text in any article to highlight it or ask the AI on your PC about it. The first four prompts switched on show on the
            bar; the rest are under “More…”, with “Ask your own”. Questions about highlights go ahead of waiting summaries.
          </span>
          <div className="card card--list">
            {presets.map((p, i) => {
              const slot = p.enabled ? ++onBar : 0;
              return (
                <div key={p.id} className="cardrow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                  <div className="inline" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <button
                      className="cardrow__main"
                      style={{ border: 'none', background: 'none', textAlign: 'left', padding: 0 }}
                      onClick={() => setOpen(open === p.id ? null : p.id)}
                    >
                      <span className="cardrow__title">
                        {p.label}
                        {!p.enabled ? ' (off)' : slot > 4 ? ' · under More…' : ''}
                      </span>
                      <span className="cardrow__sub">
                        {OUTPUT_LABEL[p.output]} · {LOOKUP_LABEL[p.lookups]} · v{p.version}
                      </span>
                    </button>
                    <span className="inline" style={{ gap: 0 }}>
                      <button
                        className="iconbtn iconbtn--small"
                        aria-label={`Move ${p.label} up`}
                        disabled={i === 0}
                        onClick={() => void move(p.id, -1)}
                      >
                        <IconChevron style={{ transform: 'rotate(180deg)' }} size={18} />
                      </button>
                      <button
                        className="iconbtn iconbtn--small"
                        aria-label={`Move ${p.label} down`}
                        disabled={i === presets.length - 1}
                        onClick={() => void move(p.id, 1)}
                      >
                        <IconChevron size={18} />
                      </button>
                      <input
                        type="checkbox"
                        aria-label={`${p.label} on the bar`}
                        checked={p.enabled}
                        onChange={(e) => void api.saveAskPreset(p.id, { enabled: e.target.checked }).then(replace)}
                      />
                    </span>
                  </div>
                  {open === p.id && (
                    <PresetEditor
                      preset={p}
                      onSaved={replace}
                      onDeleted={() => {
                        setPresets((list) => list?.filter((x) => x.id !== p.id) ?? null);
                        setOpen(null);
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {adding ? (
            <section className="card">
              <PresetEditor
                onSaved={(p) => {
                  setPresets((list) => [...(list ?? []), p]);
                  setAdding(false);
                }}
                onCancel={() => setAdding(false)}
              />
            </section>
          ) : (
            <button className="btn btn--ghost" onClick={() => setAdding(true)}>
              Add a prompt
            </button>
          )}
          <span className="hint">
            Lookups (web search and Wikipedia) arrive in the next update. Until then every prompt answers from the article and the model’s
            own knowledge.
          </span>
        </div>
      )}
    </div>
  );
}

function PresetEditor({
  preset,
  onSaved,
  onDeleted,
  onCancel,
}: {
  preset?: AskPreset;
  onSaved: (p: AskPreset) => void;
  onDeleted?: () => void;
  onCancel?: () => void;
}) {
  const [label, setLabel] = useState(preset?.label ?? '');
  const [body, setBody] = useState(
    preset?.body ?? 'The reader highlighted "{quote}" in "{title}" from {source}.\nParagraph it sits in: "{context}"\n\n',
  );
  const [output, setOutput] = useState<AskOutput>(preset?.output ?? 'note');
  const [lookups, setLookups] = useState<LookupMode>(preset?.lookups ?? 'none');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!label.trim() || !body.trim()) return;
    setBusy(true);
    try {
      const saved = preset
        ? await api.saveAskPreset(preset.id, { label, body, output, lookups })
        : await api.addAskPreset({ label, body, output, lookups });
      onSaved(saved);
      setNote(preset && saved.version !== preset.version ? `Saved as version ${saved.version}` : 'Saved');
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="field" onSubmit={save} style={{ gap: 10 }}>
      <label>
        Name on the bar
        <input className="input" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label>
        Prompt
        <textarea
          className="input"
          rows={8}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, height: 'auto', minHeight: 180 }}
        />
      </label>
      <span className="hint">
        Slots: {SLOTS}. The app adds its own rules for the answer’s format (short, light formatting, no made-up facts), and the article
        itself goes to the model as well.
      </span>
      <label>
        Answer goes to
        <select className="input" value={output} onChange={(e) => setOutput(e.target.value as AskOutput)}>
          {(Object.keys(OUTPUT_LABEL) as AskOutput[]).map((o) => (
            <option key={o} value={o}>
              {OUTPUT_LABEL[o]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Look things up first
        <select className="input" value={lookups} onChange={(e) => setLookups(e.target.value as LookupMode)}>
          {(Object.keys(LOOKUP_LABEL) as LookupMode[]).map((o) => (
            <option key={o} value={o}>
              {LOOKUP_LABEL[o]}
            </option>
          ))}
        </select>
      </label>
      <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span className="inline">
          <button className="btn btn--small" type="submit" disabled={busy}>
            {preset ? 'Save' : 'Add'}
          </button>
          {onCancel && (
            <button className="btn btn--ghost btn--small" type="button" onClick={onCancel}>
              Cancel
            </button>
          )}
          {note && <span className="hint">{note}</span>}
        </span>
        {preset?.builtIn && (
          <button
            className="btn btn--ghost btn--small"
            type="button"
            onClick={() =>
              void api.resetAskPreset(preset.id).then((p) => {
                setLabel(p.label);
                setBody(p.body);
                onSaved(p);
                setNote('Back to the original prompt');
              })
            }
          >
            Reset to original
          </button>
        )}
        {preset && !preset.builtIn && onDeleted && (
          <button
            className="btn btn--ghost btn--small"
            type="button"
            onClick={() => {
              if (window.confirm(`Delete “${preset.label}”? Notes it already wrote stay.`))
                void api.deleteAskPreset(preset.id).then(onDeleted);
            }}
          >
            Delete
          </button>
        )}
      </div>
    </form>
  );
}
