import type { AiCostSettings, AiLimits, AiUsageView, UsageBucket, UsageTotals } from '@newsletterapp/shared';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { IconBack } from '../icons';

// Settings > AI > Usage and cost: caps on how long the PC spends on AI,
// graphs of the run time by hour and by day with the caps drawn on them, and
// a rough running cost from electricity plus hardware wear.

/** "45 min", "2 h 05 min" */
export function minutesLabel(m: number): string {
  const total = Math.round(m);
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')} min`;
}

/** "2h 05m", for tight table cells */
const compactMinutes = (m: number) => {
  const total = Math.round(m);
  return total < 60 ? `${total}m` : `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
};

function money(currency: string, v: number): string {
  if (v > 0 && v < 0.001) return `<${currency}0.001`;
  if (v > 0 && v < 0.01) return `${currency}${v.toFixed(3)}`;
  return `${currency}${v.toFixed(v >= 100 ? 0 : 2)}`;
}

export function AiUsagePage() {
  const navigate = useNavigate();
  const [usage, setUsage] = useState<AiUsageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limits, setLimits] = useState<AiLimits | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .aiUsage()
      .then((u) => {
        setUsage(u);
        setLimits((l) => l ?? u.settings.limits);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  async function save(next: { limits?: AiLimits; cost?: AiCostSettings }, message: string) {
    try {
      await api.saveAiUsageSettings(next);
      setSaved(message);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>AI usage and cost</h1>
        </div>
      </header>

      {error && <div className="error">{error}</div>}
      {!usage && !error && <div className="spinner">Loading…</div>}

      {usage && limits && (
        <>
          {usage.now.limited && <LimitNotice usage={usage} />}
          <NowSection usage={usage} />
          <LimitsSection
            usage={usage}
            draft={limits}
            onDraft={setLimits}
            onSave={() => void save({ limits }, 'Limits saved. The PC picks them up within a minute.')}
            saved={saved}
          />
          <ChartsSection usage={usage} draft={limits} />
          <CostSection usage={usage} onSave={(cost) => void save({ cost }, 'Cost settings saved.')} />
        </>
      )}
    </div>
  );
}

export function LimitNotice({ usage }: { usage: Pick<AiUsageView, 'now'> }) {
  const hit = usage.now.limited!;
  return (
    <div className="notice notice--amber">
      <div className="notice__text">
        <span className="notice__title">AI resting · usage limit reached</span>
        <span className="notice__sub">
          {hit.message}. Summaries start again at{' '}
          {new Date(hit.until).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
          {new Date(hit.until).toDateString() !== new Date().toDateString() ? ' tomorrow' : ''}.
        </span>
      </div>
    </div>
  );
}

function NowSection({ usage }: { usage: AiUsageView }) {
  const { limits } = usage.settings;
  const of = (cap: number | null) => (cap === null ? 'no limit' : `of ${cap} min`);
  return (
    <div className="section">
      <span className="label">Right now</span>
      <section className="card">
        <div className="statgrid">
          <Meter label="Last 60 min" used={usage.now.hourMinutes} cap={limits.perHourMinutes} sub={of(limits.perHourMinutes)} />
          <Meter label="Today" used={usage.now.dayMinutes} cap={limits.perDayMinutes} sub={of(limits.perDayMinutes)} />
          <Meter label="This session" used={usage.now.sessionMinutes} cap={limits.perSessionMinutes} sub={of(limits.perSessionMinutes)} />
        </div>
      </section>
    </div>
  );
}

function Meter({ label, used, cap, sub }: { label: string; used: number; cap: number | null; sub: string }) {
  const share = cap ? Math.min(1, used / cap) : 0;
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <strong>{minutesLabel(used)}</strong>
      <span className="cardrow__sub">{sub}</span>
      {cap !== null && (
        <span className="meter" aria-hidden="true">
          <span className={share >= 1 ? 'meter__fill meter__fill--full' : 'meter__fill'} style={{ width: `${share * 100}%` }} />
        </span>
      )}
    </div>
  );
}

// ---------- Limits ----------

const CAPS: { key: 'perHourMinutes' | 'perDayMinutes' | 'perSessionMinutes'; label: string; hint: string; max: number }[] = [
  { key: 'perHourMinutes', label: 'Per hour', hint: 'Minutes of AI work in any 60 minutes', max: 60 },
  { key: 'perDayMinutes', label: 'Per day', hint: 'Minutes per calendar day', max: 1440 },
  { key: 'perSessionMinutes', label: 'Per session', hint: 'Minutes of back-to-back work before a rest', max: 1440 },
];

function LimitsSection({
  usage,
  draft,
  onDraft,
  onSave,
  saved,
}: {
  usage: AiUsageView;
  draft: AiLimits;
  onDraft: (l: AiLimits) => void;
  onSave: () => void;
  saved: string | null;
}) {
  const changed = JSON.stringify(draft) !== JSON.stringify(usage.settings.limits);
  return (
    <div className="section">
      <span className="label">Limits for local AI</span>
      <section className="card">
        <span className="hint">
          Leave a box empty for no limit. When a limit is reached the PC stops taking new items until it clears; the item in progress
          finishes first. Test runs you start yourself are counted but never stopped.
        </span>
        {CAPS.map((c) => (
          <div key={c.key} className="field">
            <label htmlFor={c.key}>{c.label}</label>
            <div className="inline">
              <input
                id={c.key}
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                max={c.max}
                placeholder="No limit"
                value={draft[c.key] ?? ''}
                onChange={(e) => {
                  const v = e.target.value === '' ? null : Math.min(c.max, Math.max(1, Math.round(Number(e.target.value))));
                  onDraft({ ...draft, [c.key]: Number.isFinite(v) ? v : null });
                }}
              />
              <span className="hint" style={{ whiteSpace: 'nowrap' }}>
                min
              </span>
            </div>
            <span className="hint">{c.hint}</span>
          </div>
        ))}
        <div className="field">
          <label htmlFor="breakMinutes">Rest between sessions</label>
          <div className="inline">
            <input
              id="breakMinutes"
              className="input"
              type="number"
              inputMode="numeric"
              min={1}
              max={240}
              value={draft.breakMinutes}
              onChange={(e) => onDraft({ ...draft, breakMinutes: Math.min(240, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
            />
            <span className="hint" style={{ whiteSpace: 'nowrap' }}>
              min
            </span>
          </div>
          <span className="hint">A gap this long starts a new session. After the session limit the PC rests this long.</span>
        </div>
        <Preview usage={usage} draft={draft} />
        <div className="inline">
          <button className="btn btn--primary btn--small" disabled={!changed} onClick={onSave}>
            Save limits
          </button>
          {changed && (
            <button className="btn btn--ghost btn--small" onClick={() => onDraft(usage.settings.limits)}>
              Undo changes
            </button>
          )}
        </div>
        {saved && !changed && <span className="hint">{saved}</span>}
      </section>
    </div>
  );
}

/** How often the last few weeks would have run into the limits being typed in. */
function Preview({ usage, draft }: { usage: AiUsageView; draft: AiLimits }) {
  const lines: string[] = [];
  if (draft.perHourMinutes !== null) {
    const busy = usage.hourly.filter((b) => b.minutes > 0);
    const over = busy.filter((b) => b.minutes > draft.perHourMinutes!).length;
    const peak = Math.max(0, ...usage.hourly.map((b) => b.minutes));
    lines.push(`Per hour: over the limit in ${over} of the last 168 hours (busiest hour ${minutesLabel(peak)}).`);
  }
  if (draft.perDayMinutes !== null) {
    const last30 = usage.daily.slice(-30);
    const over = last30.filter((b) => b.minutes > draft.perDayMinutes!).length;
    const peak = Math.max(0, ...last30.map((b) => b.minutes));
    lines.push(`Per day: over the limit on ${over} of the last 30 days (busiest day ${minutesLabel(peak)}).`);
  }
  if (lines.length === 0) return null;
  return (
    <div className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {lines.map((l) => (
        <span key={l}>{l}</span>
      ))}
    </div>
  );
}

// ---------- Charts ----------

function ChartsSection({ usage, draft }: { usage: AiUsageView; draft: AiLimits }) {
  const [hours, setHours] = useState<48 | 168>(48);
  const [days, setDays] = useState<30 | 90>(30);
  const hourly = usage.hourly.slice(-hours);
  const daily = usage.daily.slice(-days);
  const cur = usage.settings.cost.currency;
  return (
    <div className="section">
      <span className="label">Usage history</span>
      <section className="card">
        <div className="switchrow">
          <strong>By hour</strong>
          <div className="segmented" role="group" aria-label="Hours shown">
            <button aria-pressed={hours === 48} onClick={() => setHours(48)}>
              48 h
            </button>
            <button aria-pressed={hours === 168} onClick={() => setHours(168)}>
              7 days
            </button>
          </div>
        </div>
        <BarChart
          buckets={hourly}
          limit={draft.perHourMinutes}
          limitLabel="hourly limit"
          describe={(b) => `${dayName(b.at)} ${b.label} · ${minutesLabel(b.minutes)} · ${b.runs} run${b.runs === 1 ? '' : 's'}`}
          tick={(b) => (b.label === '00:00' ? dayName(b.at) : hours === 48 && b.label === '12:00' ? '12:00' : null)}
        />
      </section>
      <section className="card">
        <div className="switchrow">
          <strong>By day</strong>
          <div className="segmented" role="group" aria-label="Days shown">
            <button aria-pressed={days === 30} onClick={() => setDays(30)}>
              30 days
            </button>
            <button aria-pressed={days === 90} onClick={() => setDays(90)}>
              90 days
            </button>
          </div>
        </div>
        <BarChart
          buckets={daily}
          limit={draft.perDayMinutes}
          limitLabel="daily limit"
          describe={(b) => `${dayName(b.at)} ${shortDate(b.at)} · ${minutesLabel(b.minutes)} · ${b.runs} runs · ${money(cur, b.cost)}`}
          tick={(b, i) => ((days === 30 ? i % 7 : i % 21) === 0 ? shortDate(b.at) : null)}
        />
      </section>
      <span className="hint">Tap or hover a bar for its numbers. Bars over the limit you're setting turn amber.</span>
    </div>
  );
}

const dayName = (at: number) => new Date(at).toLocaleDateString(undefined, { weekday: 'short' });
const shortDate = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** Round the top of the scale up to a tidy number of minutes. */
function niceMax(v: number): number {
  for (const step of [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440]) if (v <= step) return step;
  return Math.ceil(v / 60) * 60;
}

function BarChart({
  buckets,
  limit,
  limitLabel,
  describe,
  tick,
}: {
  buckets: UsageBucket[];
  limit: number | null;
  limitLabel: string;
  describe: (b: UsageBucket) => string;
  tick: (b: UsageBucket, i: number) => string | null;
}) {
  const [active, setActive] = useState<number | null>(null);
  const top = niceMax(Math.max(1, limit ?? 0, ...buckets.map((b) => b.minutes)));
  const n = buckets.length;
  const gap = n > 60 ? 0.15 : 0.25; // share of each slot left empty between bars
  const total = buckets.reduce((s, b) => s + b.minutes, 0);
  const shown = active !== null ? buckets[active] : null;

  function pick(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * n);
    setActive(i >= 0 && i < n ? i : null);
  }

  return (
    <div className="chart">
      <div className="chart__readout" aria-live="polite">
        {shown ? describe(shown) : `${minutesLabel(total)} in total${limit !== null ? ` · ${limitLabel} ${limit} min` : ''}`}
      </div>
      <div className="chart__plot">
        <span className="chart__ymax">{top} min</span>
        <svg
          viewBox={`0 0 ${n} 100`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Minutes of AI work, ${n} bars`}
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={() => setActive(null)}
        >
          <line x1="0" x2={n} y1="100" y2="100" className="chart__base" vectorEffect="non-scaling-stroke" />
          {buckets.map((b, i) => {
            const h = (b.minutes / top) * 100;
            const over = limit !== null && b.minutes > limit;
            return (
              <rect
                key={b.at}
                x={i + gap / 2}
                width={1 - gap}
                y={100 - h}
                height={h}
                className={`chart__bar${over ? ' chart__bar--over' : ''}${active === i ? ' chart__bar--active' : ''}`}
              />
            );
          })}
          {limit !== null && (
            <line
              x1="0"
              x2={n}
              y1={100 - (limit / top) * 100}
              y2={100 - (limit / top) * 100}
              className="chart__limit"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>
      <div className="chart__ticks">
        {buckets.map((b, i) => {
          const t = tick(b, i);
          return t ? (
            <span key={b.at} style={{ left: `${(i / n) * 100}%` }}>
              {t}
            </span>
          ) : null;
        })}
      </div>
    </div>
  );
}

// ---------- Cost ----------

const COST_FIELDS: { key: keyof Omit<AiCostSettings, 'currency'>; label: string; unit: (cur: string) => string; step: number; hint?: string }[] = [
  { key: 'electricityPerKwh', label: 'Electricity price', unit: (c) => `${c} per kWh`, step: 0.01, hint: 'From your power bill.' },
  { key: 'gpuWatts', label: 'GPU power while working', unit: () => 'W', step: 10, hint: 'Only used when the PC can’t measure it.' },
  { key: 'otherWatts', label: 'Rest of the PC, extra while working', unit: () => 'W', step: 10, hint: 'CPU, fans and RAM above what they use anyway.' },
  { key: 'hardwareCost', label: 'Hardware cost', unit: (c) => c, step: 50, hint: 'The GPU alone, or the whole PC if you prefer.' },
  { key: 'resaleValue', label: 'Worth at the end', unit: (c) => c, step: 50 },
  { key: 'lifespanYears', label: 'Expected life', unit: () => 'years', step: 0.5 },
  { key: 'busyHoursPerDay', label: 'Hours a day it works hard, all uses', unit: () => 'h', step: 0.5, hint: 'Games, AI and everything else. Wear is shared out by these hours.' },
];

function CostSection({ usage, onSave }: { usage: AiUsageView; onSave: (c: AiCostSettings) => void }) {
  const [draft, setDraft] = useState<AiCostSettings>(usage.settings.cost);
  const cur = usage.settings.cost.currency;
  const t = usage.totals;
  const perHour = usage.costPerHour.electricity + usage.costPerHour.wear;
  const yearly = ((t.last30Days.electricity + t.last30Days.wear) * 365) / 30;
  const perRun = t.last30Days.runs ? (t.last30Days.electricity + t.last30Days.wear) / t.last30Days.runs : null;
  const changed = JSON.stringify(draft) !== JSON.stringify(usage.settings.cost);

  const rows: [string, UsageTotals][] = [
    ['Today', t.today],
    ['7 days', t.last7Days],
    ['30 days', t.last30Days],
    ['12 months', t.last365Days],
    ['All time', t.allTime],
  ];

  return (
    <div className="section">
      <span className="label">Running cost (estimate)</span>
      <section className="card">
        <div className="statgrid">
          <div className="stat">
            <span className="label">Per year at this rate</span>
            <strong>{money(cur, yearly)}</strong>
            <span className="cardrow__sub">from the last 30 days</span>
          </div>
          <div className="stat">
            <span className="label">Per hour of AI work</span>
            <strong>{money(cur, perHour)}</strong>
            <span className="cardrow__sub">
              {money(cur, usage.costPerHour.electricity)} power + {money(cur, usage.costPerHour.wear)} wear
            </span>
          </div>
          <div className="stat">
            <span className="label">Per summary</span>
            <strong>{perRun !== null ? money(cur, perRun) : '–'}</strong>
            {usage.avgWatts !== null && <span className="cardrow__sub">GPU measured at {Math.round(usage.avgWatts)} W</span>}
          </div>
        </div>
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>Period</th>
                <th className="num">Time</th>
                <th className="num">Power</th>
                <th className="num">Wear</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, r]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    {compactMinutes(r.minutes)}
                  </td>
                  <td className="num" title={`${r.kwh.toFixed(2)} kWh`}>
                    {money(cur, r.electricity)}
                  </td>
                  <td className="num">{money(cur, r.wear)}</td>
                  <td className="num">
                    <strong>{money(cur, r.electricity + r.wear)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <span className="hint">
          {t.last30Days.runs} runs and {t.last30Days.kwh.toFixed(1)} kWh in the last 30 days. Counts only the time the PC spends running models, since it’s on anyway. Power uses the GPU draw the helper measures with
          nvidia-smi during each run, plus the rest-of-PC figure below. Wear shares the hardware’s lost value over its working hours.
        </span>
      </section>

      <section className="card">
        <strong>Cost settings</strong>
        <div className="field">
          <label htmlFor="currency">Currency symbol</label>
          <input
            id="currency"
            className="input"
            maxLength={4}
            value={draft.currency}
            onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
          />
        </div>
        {COST_FIELDS.map((f) => (
          <div key={f.key} className="field">
            <label htmlFor={f.key}>{f.label}</label>
            <div className="inline">
              <input
                id={f.key}
                className="input"
                type="number"
                inputMode="decimal"
                min={0}
                step={f.step}
                value={draft[f.key]}
                onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
              />
              <span className="hint" style={{ whiteSpace: 'nowrap' }}>
                {f.unit(draft.currency || cur)}
              </span>
            </div>
            {f.hint && <span className="hint">{f.hint}</span>}
          </div>
        ))}
        <div className="inline">
          <button className="btn btn--primary btn--small" disabled={!changed} onClick={() => onSave(draft)}>
            Save cost settings
          </button>
          {changed && (
            <button className="btn btn--ghost btn--small" onClick={() => setDraft(usage.settings.cost)}>
              Undo changes
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
