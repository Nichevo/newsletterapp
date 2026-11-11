import { KEY_KINDS, type KeyKind, type KeyStats, type ReadThrough } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { BarChart, dayTick, RangeSwitch, shortDate } from '../components/BarChart';
import { StatsTabs } from '../components/StatsTabs';
import { IconBack } from '../icons';
import { kindDot } from '../keySentences';

// Statistics > Key sentences: how much the PC did, how often each colour
// appears and where, how the colours get used in the reader, and whether they
// seem to help (corrections, kept highlights, read-through).

const KIND_NAME: Record<KeyKind, string> = { main: 'Main point', evidence: 'Evidence', example: 'Example', caveat: 'Caveat', takeaway: 'Takeaway' };
const pct = (n: number, of: number) => (of > 0 ? `${Math.round((100 * n) / of)}%` : '–');

export function KeyStatsPage() {
  const navigate = useNavigate();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [data, setData] = useState<KeyStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    api
      .keyStats(days)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, [days]);

  const totalMarks = data?.kinds.reduce((a, k) => a + k.count, 0) ?? 0;
  const opened = data?.use.open ?? 0;

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
      <StatsTabs current="keys" />
      <div className="section">
        <RangeSwitch
          value={days}
          options={[
            [7, '7 days'],
            [30, '30 days'],
            [90, '90 days'],
          ]}
          onChange={setDays}
          label="Period"
        />
      </div>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="spinner">Loading…</div>}
      {data && (
        <>
          {!data.enabled && (
            <p className="hint" style={{ padding: '0 16px' }}>
              Key sentences are switched off. <Link to="/settings/ai/key-sentences">Settings</Link>
            </p>
          )}
          <div className="section">
            <span className="label">In the last {data.days} days</span>
            <section className="card">
              <div className="statgrid">
                <div className="stat">
                  <span className="label">Articles done</span>
                  <strong>{data.treated}</strong>
                  <span className="cardrow__sub">
                    {data.manual} asked for by hand · {data.skipped.short + data.skipped.roundup + data.skipped.empty} skipped
                    {data.failed ? ` · ${data.failed} failed` : ''}
                  </span>
                </div>
                <div className="stat">
                  <span className="label">Per article</span>
                  <strong>{data.avgMarks ?? '–'}</strong>
                  <span className="cardrow__sub">key sentences on average</span>
                </div>
                <div className="stat">
                  <span className="label">PC time</span>
                  <strong>{data.avgSeconds !== null ? `${data.avgSeconds}s` : '–'}</strong>
                  <span className="cardrow__sub">per article, {Math.round(data.totalSeconds / 60)} min in all</span>
                </div>
                <div className="stat">
                  <span className="label">Studies</span>
                  <strong>{data.studies.seen}</strong>
                  <span className="cardrow__sub">
                    {data.studies.citedTwice} cited by 2+ articles · {data.studies.differs} quoted differently ·{' '}
                    <Link to="/studies">see all</Link>
                  </span>
                </div>
              </div>
            </section>
          </div>

          <div className="section">
            <span className="label">Articles done each day</span>
            <section className="card">
              <BarChart
                points={data.daily}
                value={(p) => p.treated}
                unit="articles"
                summary={`${data.treated} articles in ${data.days} days`}
                describe={(p) => `${shortDate(p.at)}: ${p.treated} article${p.treated === 1 ? '' : 's'}`}
                tick={dayTick(data.days)}
                label="Articles given key sentences per day"
              />
            </section>
          </div>

          <div className="section">
            <span className="label">How often each colour appears</span>
            <section className="card">
              {totalMarks === 0 ? (
                <p className="hint">No key sentences in this period yet.</p>
              ) : (
                <>
                  <div className="kscolourbar" role="img" aria-label="Share of each colour">
                    {data.kinds
                      .filter((k) => k.count > 0)
                      .map((k) => (
                        <i key={k.kind} style={{ flex: k.count, background: kindDot(k.kind) }} title={`${KIND_NAME[k.kind]}: ${k.count}`} />
                      ))}
                  </div>
                  <div className="tablewrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Colour</th>
                          <th>Sentences</th>
                          <th>Share</th>
                          <th>Per 1,000 words</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.kinds.map((k) => (
                          <tr key={k.kind}>
                            <td>
                              <span className="kskind__dot" style={{ background: kindDot(k.kind) }} /> {KIND_NAME[k.kind]}
                            </td>
                            <td>{k.count}</td>
                            <td>{pct(k.count, totalMarks)}</td>
                            <td>{k.per1000 ?? '–'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          </div>

          {(['bySource', 'byCategory'] as const).map((key) =>
            data[key].length ? (
              <div className="section" key={key}>
                <span className="label">{key === 'bySource' ? 'By source' : 'By category'}</span>
                <section className="card">
                  <div className="tablewrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{key === 'bySource' ? 'Source' : 'Category'}</th>
                          <th>Articles</th>
                          <th>Colours</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data[key].map((r) => (
                          <tr key={r.name}>
                            <td>{r.name}</td>
                            <td>{r.articles}</td>
                            <td>
                              <span className="kscolourbar kscolourbar--small" title={KEY_KINDS.map((k) => `${KIND_NAME[k]} ${r.kinds[k] ?? 0}`).join(', ')}>
                                {KEY_KINDS.filter((k) => (r.kinds[k] ?? 0) > 0).map((k) => (
                                  <i key={k} style={{ flex: r.kinds[k], background: kindDot(k) }} />
                                ))}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            ) : null,
          )}

          <div className="section">
            <span className="label">How you use them</span>
            <section className="card">
              {opened === 0 ? (
                <p className="hint">Nothing counted yet: counts start when you open an article with key sentences.</p>
              ) : (
                <div className="tablewrap">
                  <table className="table">
                    <tbody>
                      {(
                        [
                          ['open', 'Articles opened with key sentences'],
                          ['off', 'Colours switched off'],
                          ['skim', 'Skim switched on'],
                          ['step', 'Stepped through with ‹ ›'],
                          ['legend', 'Hid or showed a colour'],
                          ['outline', 'Opened the Outline'],
                          ['index', 'Opened the Index'],
                          ['refs', 'Opened References'],
                          ['jump', 'Jumped from the Outline or Index'],
                          ['keep', 'Kept one as a highlight'],
                          ['find', 'Asked for key sentences by hand'],
                        ] as const
                      ).map(([e, text]) => (
                        <tr key={e}>
                          <td>{text}</td>
                          <td>{data.use[e] ?? 0}</td>
                          <td className="hint">{e === 'open' || e === 'find' ? '' : pct(data.use[e] ?? 0, opened)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <span className="hint">Each counted once per article, so the % is the share of articles opened.</span>
            </section>
          </div>

          <div className="section">
            <span className="label">Is it useful?</span>
            <section className="card">
              <div className="statgrid">
                <ThroughStat title="Long articles with key sentences" t={data.readThrough.with} />
                <ThroughStat title="Long articles without" t={data.readThrough.without} />
              </div>
              <span className="hint">Read to the end means scrolled to 90% or more. Long means at least the length set in Settings.</span>
              <div className="tablewrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>As the model picked it</th>
                      <th>Sentences</th>
                      <th>Not key</th>
                      <th>Wrong colour</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.corrections.map((k) => (
                      <tr key={k.kind}>
                        <td>
                          <span className="kskind__dot" style={{ background: kindDot(k.kind) }} /> {KIND_NAME[k.kind]}
                        </td>
                        <td>{k.marks}</td>
                        <td>{pct(k.removed, k.marks)}</td>
                        <td>{pct(k.recoloured, k.marks)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.byModel.length > 0 && (
                <div className="tablewrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th>Articles</th>
                        <th>Corrected</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byModel.map((m) => (
                        <tr key={m.model}>
                          <td>{m.model}</td>
                          <td>{m.articles}</td>
                          <td>{pct(m.removed + m.recoloured, m.marks)}</td>
                          <td>{m.avgSeconds !== null ? `${m.avgSeconds}s` : '–'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <span className="hint">Lots of Not key or Wrong colour for a kind means the prompt or the model needs work for it.</span>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function ThroughStat({ title, t }: { title: string; t: ReadThrough }) {
  return (
    <div className="stat">
      <span className="label">{title}</span>
      <strong>{t.opened ? pct(t.finished, t.opened) : '–'}</strong>
      <span className="cardrow__sub">
        read to the end, of {t.opened} opened{t.avgMinutes !== null ? ` · ${t.avgMinutes} min on average` : ''}
      </span>
    </div>
  );
}
