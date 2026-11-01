import type { AskPreset } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { IconBack } from '../icons';

/** Ask the AI about anything, outside an article; the answer arrives in the inbox as an "AI notes" article. */
export function AskPage() {
  const navigate = useNavigate();
  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Ask the AI</h1>
        </div>
      </header>
      <AskForm />
      <div className="section">
        <span className="hint">
          Answers use your highlight prompts, which you can change in <Link to="/settings/ai/highlights">Settings &gt; AI &gt; Highlight prompts</Link>.
        </span>
      </div>
    </div>
  );
}

/**
 * A question on its own, not from an article: paste what you read somewhere else, pick a prompt or
 * write your own question, and the PC's answer arrives in the inbox as an "AI notes" article.
 */
function AskForm() {
  const [presets, setPresets] = useState<AskPreset[]>([]);
  const [text, setText] = useState('');
  const [presetId, setPresetId] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [web, setWeb] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .askPresets()
      .then((list) => {
        const on = list.filter((p) => p.enabled);
        setPresets(on);
        // "More info" fits most "tell me more about this" asks; else the first prompt.
        setPresetId((on.find((p) => /more info/i.test(p.label)) ?? on[0])?.id ?? null);
      })
      .catch(() => undefined);
  }, []);

  const own = presetId === null;
  const canSend = !busy && (own ? question.trim().length > 0 : text.trim().length > 0);

  async function send() {
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const preset = presets.find((p) => p.id === presetId);
      await api.askFree({
        text: text.trim(),
        presetId,
        ...(own ? { question: question.trim() } : {}),
        lookups: web ? (own ? 'both' : preset?.lookups === 'none' || preset?.lookups === 'wiki' ? 'both' : preset?.lookups) : 'none',
      });
      setSent('Sent to your PC. The answer arrives in your inbox from AI notes, usually within a few minutes while the PC is on.');
      setText('');
      setQuestion('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section">
      <section className="card">
        <span className="hint" style={{ margin: 0 }}>
          Paste something you read elsewhere and pick what you want to know. The answer comes back as an article in your inbox.
        </span>
        <textarea
          className="textarea"
          aria-label="What to ask about"
          placeholder="Paste or type the text here"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
        />
        <div className="chipedit">
          {presets.map((p) => (
            <button key={p.id} className={`chip ${presetId === p.id ? 'chip--leader' : 'chip--outline'}`} aria-pressed={presetId === p.id} onClick={() => setPresetId(p.id)}>
              {p.label}
            </button>
          ))}
          <button className={`chip ${own ? 'chip--leader' : 'chip--outline'}`} aria-pressed={own} onClick={() => setPresetId(null)}>
            Ask your own
          </button>
        </div>
        {own && (
          <input
            className="input"
            aria-label="Your question"
            placeholder="Your question, e.g. How does MinT reconciliation work?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        )}
        <label className="switchrow">
          <span style={{ fontSize: 15 }}>Look it up on the web and Wikipedia first</span>
          <input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} />
        </label>
        <button className="btn btn--primary" disabled={!canSend} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Ask'}
        </button>
        {sent && <span className="hint" style={{ margin: 0 }}>{sent}</span>}
        {error && <div className="error" style={{ margin: 0 }}>{error}</div>}
      </section>
    </div>
  );
}
