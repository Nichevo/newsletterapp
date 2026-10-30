import type { AiBacklogView, AiStatsRow, WaitBucket } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { BarChart, dayName, dayTick, hourTick, RangeSwitch, shortDate } from '../components/BarChart';
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
