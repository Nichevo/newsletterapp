import type { AiStatsRow } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
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
