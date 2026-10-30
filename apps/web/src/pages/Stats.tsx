import type { AiBacklogView, AiStatsRow, ModelRating, WaitBucket } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { BarChart, dayName, dayTick, hourTick, RangeSwitch, shortDate } from '../components/BarChart';
import { RatingChart, type RatingBucket } from '../components/RatingChart';
import { IconBack } from '../icons';

type Grouping = 'model' | 'source' | 'prompt';
const GROUP_LABEL: Record<Grouping, string> = { model: 'Model', source: 'Newsletter', prompt: 'Prompt' };

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((100 * n) / of)}%` : '–');

/** How much value the AI summaries add over time, by model, newsletter or prompt version. */
export function StatsPage() {
  const navigate = useNavigate();
  const [by, setBy] = useState<Grouping>('model');
  const [rows, setRows] = useState<AiStatsRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(null);
    api
      .aiStats(by)
      .then(setRows)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, [by]);

  const months = rows ? [...new Set(rows.map((r) => r.month))] : [];

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>AI statistics</h1>
        </div>
      </header>

      <KeepingUpSection />
      <RatingsSection />

      <span className="label" style={{ padding: '8px 16px 0' }}>
        Summary value
      </span>
      <div className="tabs">
        {(Object.keys(GROUP_LABEL) as Grouping[]).map((g) => (
          <button key={g} className="pill" aria-pressed={by === g} onClick={() => setBy(g)}>
            By {GROUP_LABEL[g].toLowerCase()}
          </button>
        ))}
      </div>

      <p className="hint" style={{ padding: '0 16px' }}>
        Liked = share of your thumbs up among rated summaries. Summary enough = you never opened the full item after the summary was
        written.
      </p>

      {error && <div className="error">{error}</div>}
      {rows && rows.length === 0 && (
        <p className="hint" style={{ padding: '0 16px' }}>
          No AI summaries yet. They appear here once the PC helper is running.
        </p>
      )}

      {months.map((month) => {
        const monthRows = rows!.filter((r) => r.month === month);
        return (
          <div key={month} className="section">
            <span className="label">{new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
            <section className="card">
              <div className="tablewrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{GROUP_LABEL[by]}</th>
                      <th className="num">Runs</th>
                      <th className="num">Liked</th>
                      <th className="num">Summary enough</th>
                      <th className="num">Avg time</th>
                      <th className="num">Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthRows.map((r) => {
                      const ok = r.runs - r.failures;
                      return (
                        <tr key={r.key}>
                          <td>{r.key}</td>
                          <td className="num">{r.runs}</td>
                          <td className="num">
                            {pct(r.up, r.up + r.down)}
                            {r.up + r.down > 0 && <span className="cardrow__sub"> of {r.up + r.down}</span>}
                          </td>
                          <td className="num">{pct(r.summaryEnough, ok)}</td>
                          <td className="num">{r.avgSeconds !== null ? `${Math.round(r.avgSeconds)} s` : '–'}</td>
                          <td className="num">{r.failures || ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        );
      })}
    </div>
  );
}

/** "45 min", "3 h", "2 d" for waits */
function waitLabel(min: number | null): string {
  if (min === null) return '–';
  if (min < 1) return '<1 min';
  if (min < 90) return `${Math.round(min)} min`;
  if (min < 48 * 60) return `${(min / 60).toFixed(min < 600 ? 1 : 0)} h`;
  return `${Math.round(min / 1440)} d`;
}

/** Is the PC keeping up? The AI backlog over time, and how long items wait for their summary. */
function KeepingUpSection() {
  const [data, setData] = useState<AiBacklogView | null>(null);
  const [hours, setHours] = useState<48 | 168>(48);
  const [days, setDays] = useState<30 | 90>(30);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .aiBacklog()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, []);

  if (error) return <div className="error">{error}</div>;
  if (!data) return null;

  const backlogHours = data.hourly.slice(-hours);
  const backlogDays = data.daily.slice(-days);
  const waitHours = data.waitsHourly.slice(-hours);
  const waitDays = data.waitsDaily.slice(-days);
  const last24 = data.waitsHourly.slice(-24);
  const done24 = last24.reduce((s, b) => s + b.done, 0);
  const arrived24 = last24.reduce((s, b) => s + b.arrived, 0);
  const oldest = data.now.oldestAt !== null ? (Date.now() - data.now.oldestAt) / 60_000 : null;
  const medianOf = (b: WaitBucket[]) => {
    // Weighted by the number of summaries: good enough for a headline figure.
    const done = b.filter((x) => x.medianMinutes !== null);
    const n = done.reduce((s, x) => s + x.done, 0);
    return n ? done.reduce((s, x) => s + x.medianMinutes! * x.done, 0) / n : null;
  };
  const describeWait = (b: WaitBucket, when: string) =>
    `${when} · ${b.done} summarised · median wait ${waitLabel(b.medianMinutes)} · slowest 10% over ${waitLabel(b.p90Minutes)} · ${b.arrived} joined`;
  const recent = [...data.waitsDaily].reverse().slice(0, 14);
  const peakFor = (at: number) => data.daily.find((d) => d.at === at)?.waiting ?? null;

  return (
    <>
      <div className="section">
        <span className="label">Is the PC keeping up?</span>
        <section className="card">
          <div className="statgrid">
            <div className="stat">
              <span className="label">Waiting now</span>
              <strong>{data.now.waiting + data.now.working}</strong>
              {data.now.working > 0 && <span className="cardrow__sub">{data.now.working} in progress</span>}
            </div>
            <div className="stat">
              <span className="label">Oldest waiting</span>
              <strong>{waitLabel(oldest)}</strong>
            </div>
            <div className="stat">
              <span className="label">Last 24 h</span>
              <strong>
                {done24} of {arrived24}
              </strong>
              <span className="cardrow__sub">summarised of joined</span>
            </div>
            <div className="stat">
              <span className="label">Typical wait, 24 h</span>
              <strong>{waitLabel(medianOf(last24))}</strong>
            </div>
          </div>
          <span className="hint">
            Wait = time from an item joining the AI queue (arriving, or being re-queued) to its summary. If the backlog keeps
            climbing day after day, the PC isn't keeping up: try a faster model, fewer sources on AI, or looser usage limits.
          </span>
        </section>
      </div>

      <div className="section">
        <section className="card">
          <div className="switchrow">
            <strong>Backlog by hour</strong>
            <RangeSwitch value={hours} options={[[48, '48 h'], [168, '7 days']]} onChange={setHours} label="Hours shown" />
          </div>
          <BarChart
            points={backlogHours}
            value={(p) => p.waiting}
            unit="items"
            label="Items waiting for the AI by hour"
            summary="Most items waiting at any point in each hour"
            describe={(p) =>
              p.waiting === null
                ? `${dayName(p.at)} ${p.label} · not recorded yet`
                : `${dayName(p.at)} ${p.label} · up to ${p.waiting} waiting · oldest ${waitLabel(p.oldestMinutes)}`
            }
            tick={hourTick(hours)}
          />
          <div className="switchrow">
            <strong>Wait for a summary by hour</strong>
          </div>
          <BarChart
            points={waitHours}
            value={(b) => b.medianMinutes}
            unit="min"
            label="Median wait for a summary by hour"
            summary="Median wait of the items summarised in each hour"
            describe={(b) => describeWait(b, `${dayName(b.at)} ${b.label}`)}
            tick={hourTick(hours)}
          />
        </section>
        <section className="card">
          <div className="switchrow">
            <strong>Backlog by day</strong>
            <RangeSwitch value={days} options={[[30, '30 days'], [90, '90 days']]} onChange={setDays} label="Days shown" />
          </div>
          <BarChart
            points={backlogDays}
            value={(p) => p.waiting}
            unit="items"
            label="Items waiting for the AI by day"
            summary="Most items waiting at any point in each day"
            describe={(p) =>
              p.waiting === null
                ? `${shortDate(p.at)} · not recorded yet`
                : `${dayName(p.at)} ${shortDate(p.at)} · up to ${p.waiting} waiting · oldest ${waitLabel(p.oldestMinutes)}`
            }
            tick={dayTick(days)}
          />
          <div className="switchrow">
            <strong>Wait for a summary by day</strong>
          </div>
          <BarChart
            points={waitDays}
            value={(b) => b.medianMinutes}
            unit="min"
            label="Median wait for a summary by day"
            summary="Median wait of the items summarised each day"
            describe={(b) => describeWait(b, `${dayName(b.at)} ${shortDate(b.at)}`)}
            tick={dayTick(days)}
          />
          {data.snapshotsSince !== null && (
            <span className="hint">Backlog is recorded every 15 minutes from {shortDate(data.snapshotsSince)}.</span>
          )}
          {data.snapshotsSince === null && <span className="hint">Backlog is recorded every 15 minutes; the first bars appear shortly.</span>}
        </section>
        <section className="card">
          <strong>Last 14 days</strong>
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="num">Joined</th>
                  <th className="num">Done</th>
                  <th className="num">Peak queue</th>
                  <th className="num">Median wait</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((b) => {
                  const peak = peakFor(b.at);
                  return (
                    <tr key={b.at}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {dayName(b.at)} {shortDate(b.at)}
                      </td>
                      <td className="num">{b.arrived}</td>
                      <td className="num">{b.done}</td>
                      <td className="num">{peak ?? '–'}</td>
                      <td className="num" title={`Slowest 10% over ${waitLabel(b.p90Minutes)}`}>
                        {waitLabel(b.medianMinutes)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}

const DAY_MS = 86_400_000;

/** Local midnight of the day `at` falls in, or of that week's Monday. */
function startOf(at: number, unit: 'day' | 'week'): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** Empty buckets for the range, oldest first; stepping by date keeps daylight-saving days right. */
function emptyBuckets(unit: 'day' | 'week', count: number): RatingBucket[] {
  const out: RatingBucket[] = [];
  const d = new Date(startOf(Date.now(), unit));
  d.setDate(d.getDate() - (count - 1) * (unit === 'week' ? 7 : 1));
  for (let i = 0; i < count; i++) {
    const at = d.getTime();
    out.push({ at, label: unit === 'week' ? `Week of ${shortDate(at)}` : `${dayName(at)} ${shortDate(at)}`, up: 0, down: 0 });
    d.setDate(d.getDate() + (unit === 'week' ? 7 : 1));
  }
  return out;
}

/** Thumbs up and down per model over time, from everyday summaries and (optionally) test runs. */
function RatingsSection() {
  const [ratings, setRatings] = useState<ModelRating[] | null>(null);
  const [range, setRange] = useState<30 | 182>(30);
  const [withTests, setWithTests] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .aiRatings(182)
      .then(setRatings)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, []);

  if (error) return <div className="error">{error}</div>;
  if (!ratings) return null;

  const unit = range === 30 ? 'day' : 'week';
  const count = range === 30 ? 30 : 26;
  const base = emptyBuckets(unit, count);
  const from = base[0]!.at;
  const shown = ratings.filter((r) => r.at >= from && (withTests || r.from === 'reading'));

  const byModel = new Map<string, { name: string; buckets: RatingBucket[]; up: number; down: number }>();
  for (const r of shown) {
    const key = `${r.provider}/${r.model}`;
    let m = byModel.get(key);
    if (!m) {
      m = { name: r.model, buckets: base.map((b) => ({ ...b })), up: 0, down: 0 };
      byModel.set(key, m);
    }
    const at = startOf(r.at, unit);
    const b = m.buckets.find((x) => x.at === at);
    if (!b) continue;
    if (r.rating === 1) {
      b.up++;
      m.up++;
    } else {
      b.down++;
      m.down++;
    }
  }
  // Best-liked first; models with few ratings sort by what they have.
  const models = [...byModel.values()].sort((a, b) => b.up / (b.up + b.down) - a.up / (a.up + a.down) || b.up + b.down - (a.up + a.down));
  const tick = (b: RatingBucket, i: number) =>
    unit === 'day' ? (i % 7 === 0 ? shortDate(b.at) : null) : i % 4 === 0 ? shortDate(b.at) : null;

  return (
    <div className="section">
      <span className="label">Thumbs by model</span>
      <section className="card">
        <div className="switchrow">
          <label className="inline" style={{ fontSize: 13 }}>
            <input type="checkbox" checked={withTests} onChange={(e) => setWithTests(e.target.checked)} />
            Include test runs
          </label>
          <RangeSwitch value={range} options={[[30, '30 days'], [182, '6 months']]} onChange={setRange} label="Range shown" />
        </div>
        {models.length === 0 && (
          <span className="hint">
            No thumbs in this range yet. Rate AI summaries in the reader, or answers in a test run (Settings &gt; AI), and they show up
            here per model.
          </span>
        )}
        {models.length > 1 && (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="num">Up</th>
                  <th className="num">Down</th>
                  <th className="num">% up</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.name}>
                    <td style={{ wordBreak: 'break-all' }}>{m.name}</td>
                    <td className="num">{m.up}</td>
                    <td className="num">{m.down}</td>
                    <td className="num">{pct(m.up, m.up + m.down)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {models.map((m) => (
        <section key={m.name} className="card">
          <div className="switchrow">
            <strong style={{ fontSize: 14, wordBreak: 'break-all' }}>{m.name}</strong>
            <span className="cardrow__sub">
              {pct(m.up, m.up + m.down)} up of {m.up + m.down}
            </span>
          </div>
          <RatingChart
            buckets={m.buckets}
            label={`Thumbs up and down for ${m.name} by ${unit}`}
            tick={tick}
            window={unit === 'day' ? 7 : 4}
            windowLabel={unit === 'day' ? '7 days' : '4 weeks'}
          />
        </section>
      ))}
      <span className="hint" style={{ padding: '0 16px' }}>
        Bars above the line are thumbs up, below are thumbs down; the line is the share of thumbs up over the last 7 days (or 4 weeks). Ratings count on the day you gave
        them.
      </span>
    </div>
  );
}
