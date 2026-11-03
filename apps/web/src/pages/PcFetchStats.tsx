import type { PcHoldsView } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { BarChart, shortDate } from '../components/BarChart';
import { StatsTabs } from '../components/StatsTabs';
import { shortTime } from '../format';
import { IconBack } from '../icons';

// Statistics > PC fetches: how often the PC held a fetch back (site on the
// leave-alone list, or resting after a bot check) or waited its turn for a
// site, against the limits in force.

const hours = (ms: number) => `${Math.round(ms / 3_600_000)} h`;
const secs = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
const atOf = (day: string) => new Date(`${day}T12:00:00`).getTime();

export function PcFetchStatsPage() {
  const navigate = useNavigate();
  const [view, setView] = useState<PcHoldsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .pcHolds()
      .then(setView)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, []);

  const points = view?.days.map((d) => ({ ...d, at: atOf(d.day) })) ?? [];
  const total = (d: { skipped: number; rested: number; flagged: number }) => d.skipped + d.rested + d.flagged;
  const sum = points.reduce(
    (a, d) => ({ skipped: a.skipped + d.skipped, rested: a.rested + d.rested, flagged: a.flagged + d.flagged, waited: a.waited + d.waited }),
    { skipped: 0, rested: 0, flagged: 0, waited: 0 },
  );

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Statistics</h1>
        </div>
      </header>
      <StatsTabs current="pc" />
      {error && <div className="error">{error}</div>}
      {!view && !error && <div className="spinner">Loading…</div>}
      {view && (
        <>
          <div className="section">
            <span className="label">Limits now</span>
            <section className="card">
              <span style={{ fontSize: 14 }}>
                The PC waits <strong>{secs(view.gapMs)}</strong> between requests to the same site. A site that shows a bot check is
                left alone for <strong>{hours(view.restFirstMs)}</strong>, doubling each time it happens again, up to{' '}
                <strong>{hours(view.restMaxMs)}</strong>.{' '}
                <Link to="/settings/ai/sites">Sites the PC leaves alone</Link> are never fetched.
              </span>
              {view.resting.length > 0 ? (
                <div className="tablewrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Resting now</th>
                        <th className="num">Rest</th>
                        <th className="num">Until</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.resting.map((r) => (
                        <tr key={r.site}>
                          <td>{r.site}</td>
                          <td className="num">{hours(r.ms)}</td>
                          <td className="num">{shortTime(r.until)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <span className="hint">No site is resting right now.</span>
              )}
            </section>
          </div>

          <div className="section">
            <span className="label">Last 14 days</span>
            <section className="card">
              <BarChart
                points={points}
                value={total}
                unit="fetches"
                label="Fetches held back per day"
                summary={`${sum.skipped + sum.rested} fetches held back, ${sum.flagged} bot check${sum.flagged === 1 ? "" : "s"}, ${sum.waited} delayed`}
                describe={(d) =>
                  `${shortDate(d.at)}: ${d.skipped} skipped, ${d.rested} resting, ${d.flagged} bot checks, ${d.waited} delayed${
                    d.waited ? ` (${secs(d.waitMs)} in all)` : ''
                  }`
                }
                tick={(p, i) => (i % 7 === 0 ? shortDate(p.at) : null)}
              />
              <div className="tablewrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th className="num">Skipped</th>
                      <th className="num">Resting</th>
                      <th className="num">Bot checks</th>
                      <th className="num">Delayed</th>
                      <th className="num">Avg wait</th>
                      <th className="num">Longest rest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...points].reverse().map((d) => (
                      <tr key={d.day}>
                        <td>{shortDate(d.at)}</td>
                        <td className="num">{d.skipped || '–'}</td>
                        <td className="num">{d.rested || '–'}</td>
                        <td className="num">{d.flagged || '–'}</td>
                        <td className="num">{d.waited || '–'}</td>
                        <td className="num">{d.waited ? secs(d.waitMs / d.waited) : '–'}</td>
                        <td className="num">{d.restMs ? hours(d.restMs) : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <span className="hint">
                Skipped = on the leave-alone list. Resting = not fetched because the site showed a bot check earlier. Bot checks = how
                often a site turned the PC away. Delayed = fetches that waited their turn for the same site.
                {view.reportedAt ? ` Last report from the PC ${shortTime(view.reportedAt)}.` : ''}
              </span>
            </section>
          </div>

          <div className="section">
            <span className="label">By site</span>
            <section className="card">
              {view.sites.length === 0 ? (
                <span className="hint">Nothing held back in the last 14 days.</span>
              ) : (
                <div className="tablewrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Site</th>
                        <th className="num">Skipped</th>
                        <th className="num">Resting</th>
                        <th className="num">Bot checks</th>
                        <th className="num">Delayed</th>
                        <th className="num">Avg wait</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.sites.map((s) => (
                        <tr key={s.site}>
                          <td>{s.site}</td>
                          <td className="num">{s.skipped || '–'}</td>
                          <td className="num">{s.rested || '–'}</td>
                          <td className="num">{s.flagged || '–'}</td>
                          <td className="num">{s.waited || '–'}</td>
                          <td className="num">{s.waited ? secs(s.waitMs / s.waited) : '–'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
