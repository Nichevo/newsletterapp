import type { AiStatusView, AiUsageView, AppSettings, ModelInfo, ModelMode, ModelRef, PromptInfo, Source, TrialView } from '@newsletterapp/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useVisiblePolling } from '../poll';
import { relativeTime } from '../format';
import { IconBack, IconThumbDown, IconThumbUp } from '../icons';
import { LimitNotice, minutesLabel } from './AiUsage';

const HELPER_STALE_MS = 5 * 60_000;

/** Settings > AI: is the PC helper working, which models it may use, the prompts, and test runs. */
export function AiSettingsPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<AiStatusView | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [usage, setUsage] = useState<AiUsageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.aiStatus().then(setStatus).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
    api.aiModels().then(setModels).catch(() => undefined);
    api.aiUsage().then(setUsage).catch(() => undefined);
  }, []);

  useVisiblePolling(refresh, 30_000);

  async function act(fn: () => Promise<unknown>, message?: string) {
    try {
      await fn();
      if (message) setNote(message);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>AI</h1>
        </div>
      </header>

      {error && <div className="error">{error}</div>}
      {note && (
        <p className="hint" style={{ padding: '0 16px' }}>
          {note}
        </p>
      )}

      {usage?.now.limited && <LimitNotice usage={usage} />}
      {status && <StatusSection status={status} onAct={act} />}
      {usage && <UsageLink usage={usage} />}
      <ModelsSection models={models} onChange={setModels} onAct={act} />
      <PromptsSection />
      <TrialSection models={models} />
      <SetupSection />
    </div>
  );
}

function StatusSection({ status, onAct }: { status: AiStatusView; onAct: (fn: () => Promise<unknown>, msg?: string) => Promise<void> }) {
  const helper = status.helper;
  const online = helper && Date.now() - helper.lastSeenAt < HELPER_STALE_MS;
  const load = helper?.load;
  return (
    <div className="section">
      <span className="label">Status</span>
      {status.paused && (
        <div className="notice notice--amber">
          <div className="notice__text">
            <span className="notice__title">AI paused · {status.pauseReason}</span>
            {status.lastError && <span className="notice__sub">Last error: {status.lastError}</span>}
            <span className="notice__sub">Quick summaries carry on. Nothing in the queue is lost.</span>
          </div>
          <button className="btn btn--small" onClick={() => void onAct(api.aiResume, 'Resumed.')}>
            Resume
          </button>
        </div>
      )}
      <section className="card">
        <div className="switchrow">
          <span>
            <strong>{helper ? (online ? 'PC helper online' : 'PC helper offline') : 'PC helper not set up yet'}</strong>
            {helper && (
              <span className="cardrow__sub" style={{ display: 'block' }}>
                {helper.hostname} · v{helper.version} · last check-in {relativeTime(helper.lastSeenAt)}
              </span>
            )}
          </span>
          {!status.paused && (
            <button className="btn btn--ghost btn--small" onClick={() => void onAct(api.aiPause, 'Paused.')}>
              Pause
            </button>
          )}
        </div>
        {helper?.providerErrors?.map((e) => (
          <span key={e.provider} className="hint" style={{ color: 'var(--red-ink)' }}>
            {e.provider}: {e.error}
          </span>
        ))}
        <div className="statgrid">
          <Stat label="Waiting" value={status.queue.waiting} />
          <Stat label="Done" value={status.queue.done} />
          <Stat label="Failed" value={status.queue.failed} />
          <Stat label="Last 24 h" value={status.last24h.runs} sub={status.last24h.failures ? `${status.last24h.failures} failed` : undefined} />
          <Stat
            label="Avg per item"
            value={status.last24h.avgSeconds !== null ? `${Math.round(status.last24h.avgSeconds)} s` : '–'}
          />
          {load?.cpuPercent !== undefined && <Stat label="PC CPU" value={`${load.cpuPercent}%`} />}
          {load?.gpuPercent !== undefined && (
            <Stat
              label="GPU"
              value={`${load.gpuPercent}%`}
              sub={load.vramUsedMb !== undefined ? `${(load.vramUsedMb / 1024).toFixed(1)} of ${((load.vramTotalMb ?? 0) / 1024).toFixed(0)} GB` : undefined}
            />
          )}
        </div>
        {status.queue.failed > 0 && (
          <button
            className="btn btn--small"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => void onAct(api.aiRetryFailed, 'Failed items are back in the queue.')}
          >
            Retry failed items
          </button>
        )}
      </section>
    </div>
  );
}

function UsageLink({ usage }: { usage: AiUsageView }) {
  const { limits, cost } = usage.settings;
  const caps = [
    limits.perHourMinutes !== null && `${limits.perHourMinutes} min/hour`,
    limits.perDayMinutes !== null && `${limits.perDayMinutes} min/day`,
    limits.perSessionMinutes !== null && `${limits.perSessionMinutes} min/session`,
  ].filter(Boolean);
  const today = usage.totals.today;
  return (
    <div className="section">
      <div className="card card--list">
        <Link to="/settings/ai/usage" className="cardrow">
          <div className="cardrow__main">
            <span className="cardrow__title">Usage limits and cost</span>
            <span className="cardrow__sub">
              Today {minutesLabel(today.minutes)} · about {cost.currency}
              {(today.electricity + today.wear).toFixed(2)} · {caps.length ? `limits ${caps.join(', ')}` : 'no limits set'}
            </span>
          </div>
        </Link>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <strong>{value}</strong>
      {sub && <span className="cardrow__sub">{sub}</span>}
    </div>
  );
}

function ModelsSection({
  models,
  onChange,
  onAct,
}: {
  models: ModelInfo[];
  onChange: (m: ModelInfo[]) => void;
  onAct: (fn: () => Promise<unknown>, msg?: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<ModelMode>('first');
  useEffect(() => {
    api.modelMode().then((r) => setMode(r.mode)).catch(() => undefined);
  }, []);
  const inUse = models.filter((m) => m.enabled && m.installed);

  async function changeMode(next: ModelMode) {
    setMode(next);
    await onAct(() => api.saveModelMode(next));
  }

  async function save(next: ModelInfo[]) {
    onChange(next);
    await onAct(() => api.saveAiModels(next.map((m) => ({ provider: m.provider, name: m.name, enabled: m.enabled }))));
  }

  function move(i: number, by: -1 | 1) {
    const j = i + by;
    if (j < 0 || j >= models.length) return;
    const next = [...models];
    [next[i], next[j]] = [next[j]!, next[i]!];
    void save(next);
  }

  return (
    <div className="section">
      <span className="label">Models</span>
      <section className="card">
        <strong style={{ fontSize: 14 }}>Everyday summaries use</strong>
        <div className="segmented" role="group" aria-label="Which models write everyday summaries">
          <button aria-pressed={mode === 'first'} onClick={() => void changeMode('first')}>
            The first model
          </button>
          <button aria-pressed={mode === 'split'} onClick={() => void changeMode('split')}>
            Split between all on
          </button>
        </div>
        {models.length === 0 && <span className="hint">Models appear here once the PC helper has checked in.</span>}
        {models.map((m, i) => (
          <div key={`${m.provider}/${m.name}`} className="switchrow" style={{ opacity: m.installed ? 1 : 0.5 }}>
            <span style={{ minWidth: 0 }}>
              <strong style={{ fontSize: 14, wordBreak: 'break-all' }}>{m.name}</strong>
              <span className="cardrow__sub" style={{ display: 'block' }}>
                {(mode === 'split' ? m.enabled && m.installed : i === models.findIndex((x) => x.enabled && x.installed)) ? 'In use · ' : ''}
                {m.provider}
                {m.sizeBytes ? ` · ${(m.sizeBytes / 1e9).toFixed(1)} GB` : ''}
                {m.installed ? '' : ' · not installed'}
                {m.ratedCount > 0 && m.avgRating !== null ? ` · ${Math.round(((m.avgRating + 1) / 2) * 100)}% liked of ${m.ratedCount}` : ''}
              </span>
            </span>
            <span className="inline">
              <button className="iconbtn iconbtn--small" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button className="iconbtn iconbtn--small" aria-label="Move down" disabled={i === models.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <input
                type="checkbox"
                aria-label={`Use ${m.name}`}
                checked={m.enabled}
                onChange={(e) => void save(models.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))}
              />
            </span>
          </div>
        ))}
        {models.some((m) => !m.enabled) && (
          <div className="inline" style={{ flexWrap: 'wrap' }}>
            {models
              .filter((m) => !m.enabled)
              .map((m) => (
                <button
                  key={m.name}
                  className="btn btn--ghost btn--small"
                  onClick={() => void onAct(() => api.aiRedoModel(m), `Summaries by ${m.name} are queued to be redone.`)}
                >
                  Redo {m.name}'s summaries
                </button>
              ))}
          </div>
        )}
        <span className="hint">
          {mode === 'split'
            ? `Summaries are shared evenly between the ${inUse.length} switched-on, installed models: each batch of 5 goes to whichever has done the fewest in the last day, so the PC isn't swapping models for every item. Thumbs on each summary show up per model in AI statistics.`
            : 'The helper uses the first model that is switched on and installed. Switched-off models are never used.'}
        </span>
      </section>
    </div>
  );
}

function PromptsSection() {
  const [prompts, setPrompts] = useState<PromptInfo[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [editing, setEditing] = useState<PromptInfo | null>(null);
  const [draft, setDraft] = useState('');
  const [newScope, setNewScope] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.aiPrompts().then(setPrompts).catch(() => undefined);
    api.settings().then(setSettings).catch(() => undefined);
    api.sources().then(setSources).catch(() => undefined);
  }, []);

  const label = (p: Pick<PromptInfo, 'scope' | 'scopeValue'>) =>
    p.scope === 'default'
      ? 'Default'
      : p.scope === 'category'
        ? `Category: ${p.scopeValue}`
        : `Newsletter: ${sources.find((s) => s.id === p.scopeValue)?.name ?? p.scopeValue}`;

  async function save() {
    if (!editing) return;
    try {
      const saved = await api.saveAiPrompt({ scope: editing.scope, scopeValue: editing.scopeValue, body: draft });
      setPrompts((prev) => [...prev.filter((p) => p.id !== saved.id), saved]);
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  function startNew() {
    const [scope, value] = newScope.split(':') as ['category' | 'source', string];
    if (!scope || !value) return;
    const base = prompts.find((p) => p.scope === 'default');
    setEditing({ id: '', scope, scopeValue: value, version: 0, body: base?.body ?? '', updatedAt: 0 });
    setDraft(base?.body ?? '');
    setNewScope('');
  }

  const ordered = [...prompts].sort((a, b) => (a.scope === 'default' ? -1 : b.scope === 'default' ? 1 : label(a).localeCompare(label(b))));

  return (
    <div className="section">
      <span className="label">Summary prompts</span>
      {error && <div className="error">{error}</div>}
      <section className="card">
        {editing ? (
          <>
            <strong style={{ fontSize: 14 }}>{label(editing)}</strong>
            <textarea className="textarea" value={draft} onChange={(e) => setDraft(e.target.value)} />
            <span className="hint">
              {'{categories}'} and {'{interests}'} are filled in from Settings. Keep the JSON shape at the end: the app relies on it.
            </span>
            <div className="inline">
              <button className="btn btn--primary btn--small" onClick={() => void save()}>
                Save as v{editing.version + 1}
              </button>
              <button className="btn btn--ghost btn--small" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            {ordered.map((p) => (
              <div key={p.id} className="switchrow">
                <span>
                  <strong style={{ fontSize: 14 }}>{label(p)}</strong>
                  <span className="cardrow__sub" style={{ display: 'block' }}>
                    v{p.version} · edited {relativeTime(p.updatedAt)}
                  </span>
                </span>
                <span className="inline">
                  <button
                    className="btn btn--small"
                    onClick={() => {
                      setEditing(p);
                      setDraft(p.body);
                    }}
                  >
                    Edit
                  </button>
                  {p.scope !== 'default' && (
                    <button
                      className="btn btn--ghost btn--small"
                      onClick={() => void api.deleteAiPrompt(p.id).then(() => setPrompts((prev) => prev.filter((x) => x.id !== p.id)))}
                    >
                      Remove
                    </button>
                  )}
                </span>
              </div>
            ))}
            <div className="inline">
              <select className="input" value={newScope} onChange={(e) => setNewScope(e.target.value)}>
                <option value="">Add a prompt for…</option>
                <optgroup label="Category">
                  {settings?.categories.map((c) => (
                    <option key={c} value={`category:${c}`}>
                      {c}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Newsletter">
                  {sources.map((s) => (
                    <option key={s.id} value={`source:${s.id}`}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              </select>
              <button className="btn btn--small" disabled={!newScope} onClick={startNew}>
                Add
              </button>
            </div>
            <span className="hint">
              The most specific prompt wins: a newsletter's own, then its category's (from the newsletter's category or a keyword rule),
              then Default.
            </span>
          </>
        )}
      </section>
    </div>
  );
}

function TrialSection({ models }: { models: ModelInfo[] }) {
  const [trial, setTrial] = useState<TrialView | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const installed = models.filter((m) => m.installed);
  const key = (m: ModelRef) => `${m.provider}/${m.name}`;

  const load = useCallback(() => {
    api.latestTrial().then(setTrial).catch(() => undefined);
  }, []);
  useVisiblePolling(load, 20_000);

  async function start() {
    const chosen = installed.filter((m) => picked.includes(key(m)));
    try {
      await api.startTrial(chosen.map((m) => ({ provider: m.provider, name: m.name })));
      setPicked([]);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start');
    }
  }

  return (
    <div className="section">
      <span className="label">Test models side by side</span>
      {error && <div className="error">{error}</div>}
      <section className="card">
        <span className="hint">
          Runs the Default prompt on your 20 latest newsletters with up to 3 models, so you can compare before choosing. Your PC picks it up
          at its next check-in.
        </span>
        <div className="chipedit">
          {installed.map((m) => (
            <label key={key(m)} className="chip chip--outline" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={picked.includes(key(m))}
                disabled={!picked.includes(key(m)) && picked.length >= 3}
                onChange={(e) => setPicked((p) => (e.target.checked ? [...p, key(m)] : p.filter((x) => x !== key(m))))}
              />
              {m.name}
            </label>
          ))}
        </div>
        <button className="btn btn--small" style={{ alignSelf: 'flex-start' }} disabled={picked.length === 0} onClick={() => void start()}>
          Start test run
        </button>
      </section>
      {trial && <TrialResults trial={trial} onTrial={setTrial} />}
    </div>
  );
}

function TrialResults({ trial, onTrial }: { trial: TrialView; onTrial: (t: TrialView) => void }) {
  const [open, setOpen] = useState<string | null>(trial.items[0]?.id ?? null);
  const resultsOf = (m: ModelRef) => trial.results.filter((r) => r.provider === m.provider && r.model === m.name);
  const tally = trial.models.map((m) => {
    const rs = resultsOf(m);
    return { model: m, up: rs.filter((r) => r.rating === 1).length, down: rs.filter((r) => r.rating === -1).length };
  });
  // Leader = most thumbs up net of thumbs down; only once something is rated and there's no tie.
  const score = (t: (typeof tally)[number]) => t.up - t.down;
  const best = Math.max(...tally.map(score));
  const leaders = tally.filter((t) => score(t) === best);
  const leader = tally.some((t) => t.up + t.down > 0) && leaders.length === 1 ? leaders[0]!.model : null;

  async function rate(itemId: string, m: ModelRef, value: 1 | -1) {
    const current = trial.results.find((r) => r.itemId === itemId && r.provider === m.provider && r.model === m.name)?.rating ?? null;
    const next = current === value ? null : value;
    onTrial({
      ...trial,
      results: trial.results.map((r) => (r.itemId === itemId && r.provider === m.provider && r.model === m.name ? { ...r, rating: next } : r)),
    });
    await api.rateTrial(trial.id, { itemId, provider: m.provider, model: m.name, rating: next ?? 0 }).catch(() => undefined);
  }
  const done = trial.results.length;
  const total = trial.items.length * trial.models.length;
  const avg = (m: ModelRef) => {
    const rs = resultsOf(m).filter((r) => r.output);
    return rs.length ? Math.round(rs.reduce((s, r) => s + r.seconds, 0) / rs.length) : null;
  };

  return (
    <section className="card">
      <strong style={{ fontSize: 14 }}>
        Test run {relativeTime(trial.createdAt)} · {trial.status === 'done' ? 'finished' : trial.status === 'running' ? `running, ${done} of ${total}` : 'waiting for your PC'}
      </strong>
      <div className="inline" style={{ flexWrap: 'wrap' }}>
        {tally.map(({ model: m, up, down }) => (
          <span key={m.name} className={`chip ${leader === m ? 'chip--leader' : 'chip--outline'}`}>
            {leader === m ? 'Leading: ' : ''}
            {m.name}
            {avg(m) !== null ? ` · ${avg(m)} s avg` : ''}
            {up + down > 0 ? ` · ${up} up, ${down} down` : ''}
          </span>
        ))}
      </div>
      <span className="hint">Thumbs up or down each answer to pick a winner. Ratings also count towards each model's chart in AI statistics.</span>
      {trial.items.map((item) => (
        <div key={item.id}>
          <button className="quick__toggle" onClick={() => setOpen(open === item.id ? null : item.id)}>
            {item.sourceName ? `${item.sourceName}: ` : ''}
            {item.subject}
          </button>
          {open === item.id && (
            <div className="trial" style={{ marginTop: 8 }}>
              {trial.models.map((m) => {
                const r = trial.results.find((x) => x.itemId === item.id && x.provider === m.provider && x.model === m.name);
                return (
                  <div key={m.name} className="card" style={{ padding: 12, gap: 6 }}>
                    <span className="label">
                      {m.name}
                      {r?.output ? ` · ${Math.round(r.seconds)} s` : ''}
                    </span>
                    {!r && <span className="hint">Not done yet</span>}
                    {r?.error && <span className="hint" style={{ color: 'var(--red-ink)' }}>{r.error}</span>}
                    {r?.output && (
                      <>
                        <p className="quick__lead" style={{ fontSize: 14 }}>
                          {r.output.summary}
                        </p>
                        <ul className="quick__list" style={{ fontSize: 13 }}>
                          {r.output.key_points.map((k) => (
                            <li key={k}>{k}</li>
                          ))}
                        </ul>
                        {r.output.why_it_matters && <p className="ai__why" style={{ fontSize: 13 }}>Why it matters: {r.output.why_it_matters}</p>}
                        <span className="cardrow__sub">
                          {[...r.output.category, ...r.output.topics].join(' · ')}
                          {r.output.thin_content ? ' · thin content' : ''}
                        </span>
                        <div className="inline">
                          <button
                            className="iconbtn iconbtn--small"
                            aria-label={`Good answer from ${m.name}`}
                            aria-pressed={r.rating === 1}
                            onClick={() => void rate(item.id, m, 1)}
                          >
                            <IconThumbUp size={18} />
                          </button>
                          <button
                            className="iconbtn iconbtn--small"
                            aria-label={`Poor answer from ${m.name}`}
                            aria-pressed={r.rating === -1}
                            onClick={() => void rate(item.id, m, -1)}
                          >
                            <IconThumbDown size={18} />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

function SetupSection() {
  return (
    <div className="section">
      <span className="label">Set up the PC helper (Windows)</span>
      <section className="card">
        <ol className="quick__list" style={{ gap: 10 }}>
          <li>
            In Cloudflare Zero Trust, go to Access → Service credentials → Service Tokens → Create Service Token. Name it "Newsletter helper"
            and copy the Client ID and Client Secret.
          </li>
          <li>
            Open Access → Applications → your app → Policies → Add a policy: Action <strong>Service Auth</strong>, Include{' '}
            <strong>Service Token</strong> = Newsletter helper. Save.
          </li>
          <li>
            In GitHub, add a repository variable <code>HELPER_CLIENT_ID</code> with the Client ID (not the secret), and redeploy.
          </li>
          <li>
            On your PC, make sure Node.js is installed (<code>winget install OpenJS.NodeJS.LTS</code>) and Ollama is running.
          </li>
          <li>
            Download <a href="/helper/newsletter-helper.mjs" download>newsletter-helper.mjs</a> and{' '}
            <a href="/helper/install-helper.ps1" download>install-helper.ps1</a> into the same folder.
          </li>
          <li>
            In that folder, run <code>powershell -ExecutionPolicy Bypass -File install-helper.ps1</code> and paste the Client ID and Secret
            when asked. It checks the connection, then starts the helper in the background whenever you log in.
          </li>
        </ol>
        <span className="hint">
          The secret stays in a file on your PC that only your Windows account can read. The helper only makes outbound requests and updates
          itself when the app ships a new version. <Link to="/stats">See statistics</Link>.
        </span>
      </section>
    </div>
  );
}
