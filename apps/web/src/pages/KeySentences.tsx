import type { KeyKind, KeySentenceSettings, ModelInfo } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { IconBack } from '../icons';
import { kindDot } from '../keySentences';
import { Help } from '../components/Help';

// Settings > PC helper and AI > Key sentences: the master switch, which
// articles get them (length, categories; sources on their own pages), how many,
// the five colours and what they mean, link-roundup detection, the model, and
// doing older articles.

const BACKDATE = [1, 3, 7, 30];

export function KeySentencesPage({ onChange }: { onChange: (on: boolean) => void }) {
  const navigate = useNavigate();
  const [s, setS] = useState<KeySentenceSettings | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [backdated, setBackdated] = useState<string | null>(null);
  // Text boxes save when you leave them, not on every key.
  const [draft, setDraft] = useState<Partial<Record<'minWords' | 'maxShare' | 'links' | 'para' | 'extra', string>>>({});
  const [kindDraft, setKindDraft] = useState<Partial<Record<KeyKind, { name: string; meaning: string }>>>({});

  useEffect(() => {
    Promise.all([api.keySettings(), api.settings(), api.aiModels().catch(() => [] as ModelInfo[])])
      .then(([k, app, m]) => {
        setS(k);
        setCategories(app.categories);
        setModels(m.filter((x) => x.enabled && x.installed));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, []);

  async function save(patch: Partial<KeySentenceSettings>) {
    if (!s) return;
    const optimistic = { ...s, ...patch };
    setS(optimistic);
    try {
      const next = await api.saveKeySettings(patch);
      setS(next);
      if (patch.enabled !== undefined) onChange(next.enabled);
      setSaved('Saved');
      window.setTimeout(() => setSaved(null), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  function saveNumber(key: 'minWords' | 'maxShare' | 'roundupLinksPer100' | 'roundupParagraphWords', field: keyof typeof draft) {
    const raw = draft[field];
    if (raw === undefined) return;
    setDraft((d) => ({ ...d, [field]: undefined }));
    const n = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(n) && s && n !== s[key]) void save({ [key]: n });
  }

  async function backdate(days: number) {
    setBackdated('Queuing…');
    try {
      const r = await api.keyBackdate(days);
      const parts = [
        r.queued ? `${r.queued} long article${r.queued === 1 ? '' : 's'} for key sentences` : '',
        r.refs ? `${r.refs} article${r.refs === 1 ? '' : 's'} for studies and links` : '',
      ].filter(Boolean);
      setBackdated(parts.length ? `Sent to your PC from the last ${days} day${days === 1 ? '' : 's'}: ${parts.join(', ')}.` : 'Nothing older to do.');
    } catch (err) {
      setBackdated(err instanceof Error ? err.message : "Couldn't queue them");
    }
  }

  const catMode = (c: string) => s?.categories[c] ?? 'auto';

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Key sentences</h1>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      {!s && !error && <div className="spinner">Loading…</div>}
      {s && (
        <>
          <div className="section">
            <section className="card">
              <label className="switchrow">
                <span style={{ fontSize: 15, fontWeight: 600 }}>Colour key sentences</span>
                <input type="checkbox" checked={s.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />
              </label>
              <span className="hint">
                Your PC marks the sentences that carry a long article, in a colour for each kind, after it writes the summary. They're kept
                apart from your highlights: one only reaches your Highlights page when you tap “Keep as my highlight”. Off switches all of it
                off: no PC work, no colours, no filter.
              </span>
              {saved && <span className="hint">{saved}</span>}
            </section>
          </div>

          {s.enabled && (
            <>
              <div className="section">
                <span className="label">Which articles</span>
                <section className="card">
                  <div className="field">
                    <label htmlFor="ks-min">Articles longer than (words)<Help topic="ksMinWords" /></label>
                    <input
                      id="ks-min"
                      className="input"
                      inputMode="numeric"
                      style={{ maxWidth: 140 }}
                      value={draft.minWords ?? String(s.minWords)}
                      onChange={(e) => setDraft((d) => ({ ...d, minWords: e.target.value.replace(/\D/g, '') }))}
                      onBlur={() => saveNumber('minWords', 'minWords')}
                    />
                    <span className="hint">About {Math.max(1, Math.round(s.minWords / 230))} minutes of reading. Shorter ones can still be done from the reader.</span>
                  </div>
                  {categories.length > 0 && (
                    <div className="field">
                      <label>Categories<Help topic="ksCategories" /></label>
                      {categories.map((c) => (
                        <div key={c} className="switchrow">
                          <span style={{ fontSize: 14 }}>{c}</span>
                          <div className="segmented segmented--small" role="group" aria-label={`Key sentences for ${c}`}>
                            {(['auto', 'always', 'never'] as const).map((m) => (
                              <button
                                key={m}
                                aria-pressed={catMode(c) === m}
                                onClick={() => {
                                  const next = { ...s.categories };
                                  if (m === 'auto') delete next[c];
                                  else next[c] = m;
                                  void save({ categories: next });
                                }}
                              >
                                {{ auto: 'Auto', always: 'Always', never: 'Never' }[m]}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                      <span className="hint">
                        Auto goes by length; Always does every article whatever its length; Never skips them. Each source can also be set on
                        its own page (tap its name in <Link to="/settings/sources">Your sources</Link>), which wins over its category.
                      </span>
                    </div>
                  )}
                  <div className="field">
                    <label>Do older articles too<Help topic="ksBackdate" /></label>
                    <div className="inline" style={{ flexWrap: 'wrap' }}>
                      {BACKDATE.map((d) => (
                        <button key={d} className="btn btn--small" onClick={() => void backdate(d)}>
                          Last {d} day{d === 1 ? '' : 's'}
                        </button>
                      ))}
                    </div>
                    <span className="hint">
                      {backdated ?? 'Only articles summarised after you switched this on are done by themselves. This sends long ones from the last few days as well.'}
                    </span>
                  </div>
                </section>
              </div>

              <div className="section">
                <span className="label">How many</span>
                <section className="card">
                  <div className="field">
                    <label>Per section<Help topic="ksPerSection" /></label>
                    <div className="segmented" role="group" aria-label="Key sentences per section">
                      {([1, 2, 3] as const).map((n) => (
                        <button key={n} aria-pressed={s.perSection === n} onClick={() => void save({ perSection: n })}>
                          {{ 1: 'Light', 2: 'Normal', 3: 'More' }[n]}
                        </button>
                      ))}
                    </div>
                    <span className="hint">Light marks about 1 sentence per section, Normal about 2, More about 3.</span>
                  </div>
                  <div className="field">
                    <label htmlFor="ks-share">At most this much of an article coloured (%)<Help topic="ksMaxShare" /></label>
                    <input
                      id="ks-share"
                      className="input"
                      inputMode="numeric"
                      style={{ maxWidth: 140 }}
                      value={draft.maxShare ?? String(s.maxShare)}
                      onChange={(e) => setDraft((d) => ({ ...d, maxShare: e.target.value.replace(/\D/g, '') }))}
                      onBlur={() => saveNumber('maxShare', 'maxShare')}
                    />
                    <span className="hint">Of its sentences. Keeps a long article from turning into a colouring book.</span>
                  </div>
                  <label className="switchrow">
                    <span style={{ fontSize: 14 }}>Open articles in Skim mode<Help topic="ksSkim" /></span>
                    <input type="checkbox" checked={s.skimDefault} onChange={(e) => void save({ skimDefault: e.target.checked })} />
                  </label>
                  <span className="hint">Skim fades everything except the key sentences. You can switch it in the reader either way.</span>
                </section>
              </div>

              <div className="section">
                <span className="label">Index, studies and links</span>
                <section className="card">
                  <label className="switchrow">
                    <span style={{ fontSize: 14 }}>Index under long articles<Help topic="ksIndex" /></span>
                    <input type="checkbox" checked={s.index} onChange={(e) => void save({ index: e.target.checked })} />
                  </label>
                  <span className="hint">People, organisations, places and terms the article names. Tap one to jump to each mention.</span>
                  <label className="switchrow">
                    <span style={{ fontSize: 14 }}>Collect studies and source links<Help topic="ksStudies" /></span>
                    <input type="checkbox" checked={s.studies} onChange={(e) => void save({ studies: e.target.checked })} />
                  </label>
                  <span className="hint">
                    From every article your PC summarises, long or short: one short extra step that only looks at sentences mentioning a study, report or survey.
                    They go into <Link to="/studies">Studies</Link>, where you can see the same study across articles and spot ones quoted differently.
                  </span>
                  <label className="switchrow">
                    <span style={{ fontSize: 14 }}>Show links only one article uses<Help topic="ksLinksAll" /></span>
                    <input type="checkbox" checked={s.linksAll} onChange={(e) => void save({ linksAll: e.target.checked })} />
                  </label>
                  <span className="hint">Off: a source link shows under an article only once another article links to the same page, to keep the clutter down.</span>
                </section>
              </div>

              <div className="section">
                <span className="label">Colours and what they mean<Help topic="ksColours" /></span>
                <section className="card">
                  {s.kinds.map((k) => {
                    const d = kindDraft[k.id];
                    const commit = () => {
                      if (!d) return;
                      setKindDraft((x) => ({ ...x, [k.id]: undefined }));
                      if (d.name.trim() && (d.name !== k.name || d.meaning !== k.meaning)) {
                        void save({ kinds: s.kinds.map((x) => (x.id === k.id ? { ...x, name: d.name.trim(), meaning: d.meaning.trim() || x.meaning } : x)) });
                      }
                    };
                    return (
                      <div key={k.id} className="field kskind">
                        <div className="switchrow">
                          <span className="inline" style={{ gap: 8 }}>
                            <i className="kskind__dot" style={{ background: kindDot(k.id) }} aria-hidden="true" />
                            <input
                              className="input"
                              aria-label="Name"
                              value={d?.name ?? k.name}
                              onChange={(e) => setKindDraft((x) => ({ ...x, [k.id]: { name: e.target.value, meaning: d?.meaning ?? k.meaning } }))}
                              onBlur={commit}
                              style={{ maxWidth: 200 }}
                            />
                          </span>
                          <input
                            type="checkbox"
                            aria-label={`Mark ${k.name}`}
                            checked={k.on}
                            onChange={(e) => void save({ kinds: s.kinds.map((x) => (x.id === k.id ? { ...x, on: e.target.checked } : x)) })}
                          />
                        </div>
                        <input
                          className="input"
                          aria-label={`What ${k.name} means`}
                          value={d?.meaning ?? k.meaning}
                          onChange={(e) => setKindDraft((x) => ({ ...x, [k.id]: { name: d?.name ?? k.name, meaning: e.target.value } }))}
                          onBlur={commit}
                        />
                      </div>
                    );
                  })}
                  <span className="hint">The names and meanings go to the model, so changing them changes what it looks for. Prompt version {s.promptVersion}.</span>
                </section>
              </div>

              <div className="section">
                <span className="label">Model and prompt</span>
                <section className="card">
                  <div className="field">
                    <label htmlFor="ks-model">Model<Help topic="ksModel" /></label>
                    <select id="ks-model" className="input" value={s.model} onChange={(e) => void save({ model: e.target.value })}>
                      <option value="">Same as summaries (first switched-on model)</option>
                      {models.map((m) => (
                        <option key={`${m.provider}:${m.name}`} value={`${m.provider}:${m.name}`}>
                          {m.name}
                          {m.provider !== 'ollama' ? ` (${m.provider})` : ''}
                        </option>
                      ))}
                      {s.model && !models.some((m) => `${m.provider}:${m.name}` === s.model) && <option value={s.model}>{s.model}</option>}
                    </select>
                    <span className="hint">The answer is only sentence numbers and kinds, so a smaller, quicker model may do well here.</span>
                  </div>
                  <div className="field">
                    <label htmlFor="ks-extra">Extra instructions for the model<Help topic="ksExtra" /></label>
                    <textarea
                      id="ks-extra"
                      className="input"
                      rows={3}
                      placeholder="e.g. Prefer sentences with numbers. Never mark quotes from the author's own earlier posts."
                      value={draft.extra ?? s.extraPrompt}
                      onChange={(e) => setDraft((d) => ({ ...d, extra: e.target.value }))}
                      onBlur={() => {
                        const v = draft.extra;
                        setDraft((d) => ({ ...d, extra: undefined }));
                        if (v !== undefined && v !== s.extraPrompt) void save({ extraPrompt: v });
                      }}
                    />
                  </div>
                </section>
              </div>

              <div className="section">
                <span className="label">Link roundups<Help topic="ksRoundups" /></span>
                <section className="card">
                  <span className="hint">
                    Lists of links (daily roundups, “what we're reading”) are skipped on Auto. An article counts as one when it has at least
                    this many links per 100 words, or its paragraphs are shorter than this on average.
                  </span>
                  <div className="inline" style={{ flexWrap: 'wrap', gap: 12 }}>
                    <div className="field">
                      <label htmlFor="ks-links">Links per 100 words</label>
                      <input
                        id="ks-links"
                        className="input"
                        inputMode="numeric"
                        style={{ maxWidth: 120 }}
                        value={draft.links ?? String(s.roundupLinksPer100)}
                        onChange={(e) => setDraft((d) => ({ ...d, links: e.target.value.replace(/\D/g, '') }))}
                        onBlur={() => saveNumber('roundupLinksPer100', 'links')}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="ks-para">Words per paragraph</label>
                      <input
                        id="ks-para"
                        className="input"
                        inputMode="numeric"
                        style={{ maxWidth: 120 }}
                        value={draft.para ?? String(s.roundupParagraphWords)}
                        onChange={(e) => setDraft((d) => ({ ...d, para: e.target.value.replace(/\D/g, '') }))}
                        onBlur={() => saveNumber('roundupParagraphWords', 'para')}
                      />
                    </div>
                  </div>
                </section>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
