import type { ReadingStats } from '@newsletterapp/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { dayTick, RangeSwitch, shortDate } from '../components/BarChart';
import { IconBack } from '../icons';

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((100 * n) / of)}%` : '–');
const minutes = (m: number) => (m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`);
const ago = (at: number | null) => {
  if (at === null) return 'never';
  const days = Math.floor((Date.now() - at) / 86_400_000);
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : days < 30 ? `${days} days ago` : shortDate(at);
};

const VIA_LABEL = { reader: 'Read in the reader', swipe: 'Swiped or marked read', digest: 'Marked read from the digest', bulk: 'Marked read in bulk' } as const;
const DEVICE_LABEL = { phone: 'On the phone', desktop: 'On a PC' } as const;
const KIND_LABEL = { newsletter: 'Newsletters', feed: 'Feeds', site: 'Websites' } as const;

/** What arrives, what gets read, and where the time goes. */
export function ReadingStatsPage() {
  const navigate = useNavigate();
  const [days, setDays] = useState<30 | 90 | 365>(90);
  const [data, setData] = useState<ReadingStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .readingStats(days)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, [days]);

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Reading statistics</h1>
        </div>
      </header>

      {error && <div className="error">{error}</div>}
      {data && (
        <>
          <Glance data={data} />
          <Daily data={data} />
          <Backlog data={data} />

          <div className="section">
            <span className="label">By newsletter and category</span>
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
          <SourcesTable data={data} />
          <CategoriesTable data={data} />
          <HowYouRead data={data} />
        </>
      )}
    </div>
  );
}

function Glance({ data: { glance } }: { data: ReadingStats }) {
  return (
    <div className="section">
      <span className="label">Last 7 days</span>
      <section className="card">
        <div className="statgrid">
          <div className="stat">
            <span className="label">Read</span>
            <strong>
              {glance.read} of {glance.received}
            </strong>
            <span className="cardrow__sub">items that arrived</span>
          </div>
          <div className="stat">
            <span className="label">Reading time</span>
            <strong>{minutes(glance.minutes)}</strong>
            <span className="cardrow__sub">in the reader</span>
          </div>
          <div className="stat">
            <span className="label">Finished</span>
            <strong>{pct(glance.finished, glance.opened)}</strong>
            <span className="cardrow__sub">of {glance.opened} opened, scrolled to the end</span>
          </div>
          <div className="stat">
            <span className="label">Streak</span>
            <strong>
              {glance.streak} {glance.streak === 1 ? 'day' : 'days'}
            </strong>
            <span className="cardrow__sub">in a row with something read</span>
          </div>
        </div>
      </section>
    </div>
  );
}

/** Received (pale) and read (teal) per day, last four weeks. Tap a bar for its numbers. */
function Daily({ data: { daily } }: { data: ReadingStats }) {
  const [active, setActive] = useState<number | null>(null);
  const n = daily.length;
  const top = Math.max(1, ...daily.map((d) => Math.max(d.received, d.read)));
  const totalReceived = daily.reduce((s, d) => s + d.received, 0);
  const totalRead = daily.reduce((s, d) => s + d.read, 0);
  const shown = active !== null ? daily[active] : null;
  const tick = dayTick(n);

  function pick(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * n);
    setActive(i >= 0 && i < n ? i : null);
  }

  return (
    <div className="section">
      <span className="label">Arrived and read, last 4 weeks</span>
      <section className="card">
        <div className="chart">
          <div className="chart__readout" aria-live="polite">
            {shown
              ? `${shortDate(shown.at)}: ${shown.received} arrived, ${shown.read} read`
              : `${totalReceived} arrived, ${totalRead} read in 28 days`}
          </div>
          <div className="chart__plot">
            <span className="chart__ymax">{top} items</span>
            <svg
              viewBox={`0 0 ${n} 100`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`Arrived and read per day, ${n} days`}
              onPointerMove={pick}
              onPointerDown={pick}
              onPointerLeave={() => setActive(null)}
            >
              <line x1="0" x2={n} y1="100" y2="100" className="chart__base" vectorEffect="non-scaling-stroke" />
              {daily.map((d, i) => {
                const hr = (d.received / top) * 100;
                const hd = (d.read / top) * 100;
                const cls = active === i ? ' chart__bar--active' : '';
                return (
                  <g key={d.day}>
                    <rect x={i + 0.125} width={0.75} y={100 - hr} height={hr} className={`chart__bar chart__bar--pale${cls}`} />
                    <rect x={i + 0.125} width={0.75} y={100 - hd} height={hd} className={`chart__bar${cls}`} />
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="chart__ticks">
            {daily.map((d, i) => {
              const t = tick(d, i);
              return t ? (
                <span key={d.day} style={{ left: `${(i / n) * 100}%` }}>
                  {t}
                </span>
              ) : null;
            })}
          </div>
        </div>
        <span className="hint">Pale bars are items that arrived that day; teal bars are items you read that day.</span>
      </section>
    </div>
  );
}

function Backlog({ data: { backlog } }: { data: ReadingStats }) {
  const total = backlog.today + backlog.week + backlog.older;
  return (
    <div className="section">
      <span className="label">Unread in the inbox</span>
      <section className="card">
        <div className="statgrid">
          <div className="stat">
            <span className="label">Today</span>
            <strong>{backlog.today}</strong>
          </div>
          <div className="stat">
            <span className="label">This week</span>
            <strong>{backlog.week}</strong>
          </div>
          <div className="stat">
            <span className="label">Older</span>
            <strong>{backlog.older}</strong>
          </div>
          <div className="stat">
            <span className="label">All unread</span>
            <strong>{total}</strong>
          </div>
        </div>
        {backlog.older > 20 && (
          <span className="hint">
            A pile of older unread items usually means a newsletter you don't actually read. The table below shows which ones are never
            opened.
          </span>
        )}
      </section>
    </div>
  );
}

function SourcesTable({ data: { sources, days } }: { data: ReadingStats }) {
  const neverOpened = sources.filter((s) => s.opened === 0 && s.issues >= 3);
  return (
    <div className="section">
      <section className="card">
        {sources.length === 0 ? (
          <p className="hint">Nothing arrived in this period.</p>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th className="num">Issues</th>
                  <th className="num">Read</th>
                  <th className="num">Opened</th>
                  <th className="num">Finished</th>
                  <th className="num">Avg time</th>
                  <th>Last read</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.id} className={s.opened === 0 ? 'quiet' : undefined}>
                    <td>
                      <Link to={`/source/${s.id}`}>{s.name}</Link>
                      {s.kind !== 'newsletter' && <span className="cardrow__sub"> {KIND_LABEL[s.kind]}</span>}
                    </td>
                    <td className="num">{s.issues}</td>
                    <td className="num">{pct(s.read, s.issues)}</td>
                    <td className="num">{pct(s.opened, s.issues)}</td>
                    <td className="num">{pct(s.finished, s.opened)}</td>
                    <td className="num">{s.avgMinutes === null ? '–' : s.avgMinutes < 1 ? '<1 min' : `${Math.round(s.avgMinutes)} min`}</td>
                    <td>{ago(s.lastReadAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <span className="hint">
          Read = marked read any way. Opened = read in the reader. Finished = scrolled to the end when opened. Last {days} days
          {neverOpened.length > 0 && `; ${neverOpened.length} ${neverOpened.length === 1 ? 'source was' : 'sources were'} never opened`}.
        </span>
      </section>
    </div>
  );
}

function CategoriesTable({ data: { categories } }: { data: ReadingStats }) {
  if (categories.length === 0) return null;
  return (
    <div className="section">
      <span className="label">By category</span>
      <section className="card">
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">Issues</th>
                <th className="num">Read</th>
                <th className="num">Opened</th>
                <th className="num">Finished</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((r) => (
                <tr key={r.category}>
                  <td>{r.category}</td>
                  <td className="num">{r.issues}</td>
                  <td className="num">{pct(r.read, r.issues)}</td>
                  <td className="num">{pct(r.opened, r.issues)}</td>
                  <td className="num">{pct(r.finished, r.opened)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function HowYouRead({ data: { how, days } }: { data: ReadingStats }) {
  const viaTotal = Object.values(how.via).reduce((a, b) => a + b, 0);
  const deviceTotal = Object.values(how.device).reduce((a, b) => a + b, 0);
  if (viaTotal === 0 && deviceTotal === 0) return null;
  return (
    <div className="section">
      <span className="label">How you read</span>
      <section className="card">
        <div className="tablewrap">
          <table className="table">
            <tbody>
              {(Object.keys(VIA_LABEL) as (keyof typeof VIA_LABEL)[]).map((k) => (
                <tr key={k}>
                  <td>{VIA_LABEL[k]}</td>
                  <td className="num">{how.via[k]}</td>
                  <td className="num">{pct(how.via[k], viaTotal)}</td>
                </tr>
              ))}
              {(Object.keys(DEVICE_LABEL) as (keyof typeof DEVICE_LABEL)[]).map((k) => (
                <tr key={k}>
                  <td>{DEVICE_LABEL[k]}</td>
                  <td className="num">{how.device[k]}</td>
                  <td className="num">{pct(how.device[k], deviceTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <span className="hint">Items marked read in the last {days} days. Items read before the app started recording this are left out.</span>
      </section>
    </div>
  );
}
