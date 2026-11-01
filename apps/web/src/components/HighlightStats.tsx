import type { HighlightPromptStats, HighlightStats, HighlightStatsGroup } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { BarChart, dayTick, RangeSwitch, shortDate } from './BarChart';

// Highlight statistics. Reading statistics shows what gets highlighted and
// where; AI statistics shows the questions asked about highlights: by prompt,
// by model, thumbs, run time, and web searches against the month's budget.

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((100 * n) / of)}%` : '–');
const secs = (s: number | null) => (s === null ? '–' : s < 1 ? '<1 s' : s < 90 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`);

function useHighlightStats(days: number) {
  const [data, setData] = useState<HighlightStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .highlightStats(days)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, [days]);
  return { data, error };
}

/** On Reading statistics: follows the page's period switch. */
export function HighlightReadingStats({ days }: { days: number }) {
  const { data, error } = useHighlightStats(days);
  if (error) return <div className="error">{error}</div>;
  if (!data) return null;
  const t = data.totals;
  const recent = data.daily.reduce((n, d) => n + d.highlights, 0);

  return (
    <>
      <div className="section">
        <span className="label">Highlights, last {data.days} days</span>
        <section className="card">
          {t.highlights === 0 ? (
            <p className="hint" style={{ margin: 0 }}>
              No highlights in this period. Select words in any article to highlight them; they're all listed in{' '}
              <Link to="/saved/highlights">Saved › Highlights</Link>.
            </p>
          ) : (
            <>
              <div className="statgrid">
                <div className="stat">
                  <span className="label">Highlights</span>
                  <strong>{t.highlights}</strong>
                  <span className="cardrow__sub">in {t.articles} {t.articles === 1 ? 'article' : 'articles'}</span>
                </div>
                <div className="stat">
                  <span className="label">Asked the AI</span>
                  <strong>{pct(t.asked, t.highlights)}</strong>
                  <span className="cardrow__sub">
                    {t.asked} asked, {t.plain} just highlighted
                  </span>
                </div>
                <div className="stat">
                  <span className="label">Questions</span>
                  <strong>{t.asks}</strong>
                  <span className="cardrow__sub">to the AI about them</span>
                </div>
                <div className="stat">
                  <span className="label">Per 100 read</span>
                  <strong>{t.per100Read ?? '–'}</strong>
                  <span className="cardrow__sub">highlights per 100 items read</span>
                </div>
              </div>
              <Link to="/saved/highlights" className="hint">
                See them all in Saved › Highlights
              </Link>
            </>
          )}
        </section>
      </div>

      {recent > 0 && (
        <div className="section">
          <span className="label">Highlights per day, last 4 weeks</span>
          <section className="card">
            <BarChart
              points={data.daily}
              value={(d) => d.highlights}
              unit="highlights"
              label="Highlights per day"
              summary={`${recent} highlights in 4 weeks`}
              describe={(d) => `${shortDate(d.at)} · ${d.highlights} highlighted · ${d.asks} asked`}
              tick={dayTick(28)}
            />
          </section>
        </div>
      )}

      {t.highlights > 0 && (
        <>
          <GroupTable title="Highlights by source" first="Source" rows={data.bySource} link={(g) => (g.key === '-' ? null : `/source/${g.key}`)} />
          <GroupTable title="Highlights by category" first="Category" rows={data.byCategory} />
          <div className="section">
            <span className="label">Most highlighted articles</span>
            <section className="card card--list">
              {data.mostHighlighted.map((m) => (
                <Link key={m.itemId} to={`/item/${m.itemId}`} className="cardrow">
                  <span className="cardrow__main">
                    <span className="cardrow__title">{m.title}</span>
                    <span className="cardrow__sub">
                      {m.sourceName ? `${m.sourceName} · ` : ''}
                      {m.highlights} {m.highlights === 1 ? 'highlight' : 'highlights'}
                    </span>
                  </span>
                </Link>
              ))}
            </section>
          </div>
        </>
      )}
    </>
  );
}

function GroupTable({
  title,
  first,
  rows,
  link,
}: {
  title: string;
  first: string;
  rows: HighlightStatsGroup[];
  link?: (g: HighlightStatsGroup) => string | null;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="section">
      <span className="label">{title}</span>
      <section className="card">
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>{first}</th>
                <th className="num">Highlights</th>
                <th className="num">Questions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const to = link?.(g) ?? null;
                return (
                  <tr key={g.key}>
                    <td>{to ? <Link to={to}>{g.name}</Link> : g.name}</td>
                    <td className="num">{g.highlights}</td>
                    <td className="num">{g.asks || ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/** On AI statistics: questions about highlights, with its own period switch. */
export function HighlightAiStats() {
  const [days, setDays] = useState<30 | 90 | 365>(90);
  const { data, error } = useHighlightStats(days);
  const out = data?.output;
  const outTotal = out ? out.note + out.item + out.both : 0;
  const s = data?.searches;

  return (
    <>
      <span className="label" style={{ padding: '8px 16px 0' }}>
        Highlight questions
      </span>
      <div className="section">
        <RangeSwitch
          value={days}
          options={[
            [30, '30 days'],
            [90, '90 days'],
            [365, 'Year'],
          ]}
          onChange={setDays}
          label="Period"
        />
      </div>
      {error && <div className="error">{error}</div>}
      {data && data.totals.asks === 0 && (
        <p className="hint" style={{ padding: '0 16px' }}>
          No questions about highlights in this period.
        </p>
      )}
      {data && data.totals.asks > 0 && (
        <>
          <PromptTable title="By prompt" first="Prompt" rows={data.byPrompt} />
          <PromptTable title="By model" first="Model" rows={data.byModel} />
          <div className="section">
            <span className="label">Where answers went</span>
            <section className="card">
              <div className="statgrid">
                <div className="stat">
                  <span className="label">Note on the article</span>
                  <strong>{pct(out!.note, outTotal)}</strong>
                </div>
                <div className="stat">
                  <span className="label">New article</span>
                  <strong>{pct(out!.item, outTotal)}</strong>
                </div>
                <div className="stat">
                  <span className="label">Both</span>
                  <strong>{pct(out!.both, outTotal)}</strong>
                </div>
              </div>
            </section>
          </div>
        </>
      )}
      {s && (
        <div className="section">
          <span className="label">Web searches this month</span>
          <section className="card">
            <span style={{ fontSize: 15 }}>
              <strong>{s.used}</strong> of {s.budget} used: {s.asks} for highlight questions, {s.summaries} for summaries.
            </span>
            <div className="meter" aria-hidden="true">
              <span
                className={`meter__fill${s.budget > 0 && s.used >= s.budget ? ' meter__fill--full' : ''}`}
                style={{ width: `${s.budget > 0 ? Math.min(100, Math.round((100 * s.used) / s.budget)) : 0}%` }}
              />
            </div>
            <Link to="/settings/ai/web-search" className="hint">
              Web search settings
            </Link>
          </section>
        </div>
      )}
    </>
  );
}

function PromptTable({ title, first, rows }: { title: string; first: string; rows: HighlightPromptStats[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="section">
      <span className="label">{title}</span>
      <section className="card">
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>{first}</th>
                <th className="num">Asked</th>
                <th className="num">Liked</th>
                <th className="num">Median time</th>
                <th className="num">Failed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td className="num">{r.asks}</td>
                  <td className="num">
                    {pct(r.up, r.up + r.down)}
                    {r.up + r.down > 0 && <span className="cardrow__sub"> of {r.up + r.down}</span>}
                  </td>
                  <td className="num">{secs(r.medianSeconds)}</td>
                  <td className="num">{r.failed || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
