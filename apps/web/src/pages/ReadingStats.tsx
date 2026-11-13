import { DEPTH_LEVELS, depthTotal, depthValue, emptyDepth, sourceVerdict, type DepthCounts, type ReadingStats, type Source, type SourceActivity, type SourceVerdict, type TopicSkips } from '@newsletterapp/shared';
import { DepthBar, DepthLegend, VerdictPill } from '../components/DepthBar';
import { Fragment, useEffect, useState } from 'react';
import { Help } from '../components/Help';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { dayTick, RangeSwitch, shortDate } from '../components/BarChart';
import { HighlightReadingStats } from '../components/HighlightStats';
import { IconBack } from '../icons';
import { StatsTabs } from '../components/StatsTabs';

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((100 * n) / of)}%` : '–');
const minutes = (m: number) => (m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`);
const ago = (at: number | null) => {
  if (at === null) return 'never';
  const days = Math.floor((Date.now() - at) / 86_400_000);
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : days < 30 ? `${days} days ago` : shortDate(at);
};

const VIA_LABEL = { reader: 'Read in the reader', swipe: 'Swiped or marked read', digest: 'Marked read from the digest', bulk: 'Marked read in bulk', not_interested: 'Marked not interested' } as const;
const DEVICE_LABEL = { phone: 'On the phone', desktop: 'On a PC' } as const;
const KIND_LABEL = { newsletter: 'Newsletters', feed: 'Feeds', site: 'Websites', ai: 'AI notes' } as const;

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
          <h1>Statistics</h1>
        </div>
      </header>
      <StatsTabs current="reading" />

      {error && <div className="error">{error}</div>}
      {data && (
        <>
          <Glance data={data} />
          <Daily data={data} />
          <Backlog data={data} />
          <SourcesByValue />
          <TopicsYouSkip />

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
          <HighlightReadingStats days={days} />
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
            <span className="cardrow__sub">
              items that arrived
              {glance.readOlder > 0 &&
                `, plus ${glance.readOlder} older${glance.readOlderBulk > 0 ? ` (${glance.readOlderBulk} by Mark all read)` : ''}`}
            </span>
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
                  <th className="num">★</th>
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
                    <td className="num">{s.interesting || '–'}</td>
                    <td className="num">{s.avgMinutes === null ? '–' : s.avgMinutes < 1 ? '<1 min' : `${Math.round(s.avgMinutes)} min`}</td>
                    <td>{ago(s.lastReadAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <span className="hint">
          Read = marked read any way. Opened = read in the reader. Finished = scrolled to the end when opened. ★ = starred as Interesting. Last {days} days
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
                <th className="num">★</th>
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
                  <td className="num">{r.interesting || '–'}</td>
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

/**
 * How far you go with what arrives, over all sources, and how many sources fall
 * under each verdict. Uses the same 90-day activity read as Your sources.
 */
function SourcesByValue() {
  const [rows, setRows] = useState<{ activity: SourceActivity[]; sources: Source[] } | null>(null);
  useEffect(() => {
    Promise.all([api.sourceActivity(), api.sources()])
      .then(([activity, sources]) => setRows({ activity, sources }))
      .catch(() => undefined);
  }, []);
  if (!rows) return null;
  const names = new Map(rows.sources.map((s) => [s.id, s]));
  const live = rows.activity.filter((a) => names.has(a.sourceId) && !names.get(a.sourceId)!.pausedAt);
  const all = emptyDepth();
  for (const a of live) for (const l of DEPTH_LEVELS) all[l] += a.depth[l];
  if (depthTotal(all) === 0) return null;
  const verdicts = new Map<SourceVerdict, SourceActivity[]>();
  for (const a of live) {
    const v = sourceVerdict(a.depth);
    verdicts.set(v, [...(verdicts.get(v) ?? []), a]);
  }
  const skipped = [...(verdicts.get('always_skipped') ?? []), ...(verdicts.get('mostly_skipped') ?? [])];
  const skippedItems = skipped.reduce((n, a) => n + a.items, 0);
  const allItems = live.reduce((n, a) => n + a.items, 0);
  const order: SourceVerdict[] = ['keeper', 'summary', 'mixed', 'mostly_skipped', 'always_skipped', 'too_few'];
  const show: Partial<Record<SourceVerdict, string>> = { keeper: 'keeper', summary: 'summary', mostly_skipped: 'skipped', always_skipped: 'skipped' };
  const lowest = [...live]
    .filter((a) => depthTotal(a.depth) >= 8)
    .sort((a, b) => (depthValue(a.depth) ?? 0) - (depthValue(b.depth) ?? 0))
    .slice(0, 5);
  return (
    <div className="section">
      <span className="label">
        How far you go, last 90 days<Help topic="srcValue" />
      </span>
      <section className="card">
        <DepthBar depth={all} big />
        <DepthLegend depth={all} percent />
      </section>
      <span className="label">Sources by value</span>
      <section className="card">
        <div className="kv">
          {order
            .filter((v) => verdicts.get(v)?.length)
            .map((v) => {
              const n = verdicts.get(v)!.length;
              const to = show[v];
              return (
                <Fragment key={v}>
                  <span>{to ? <Link to={`/settings/sources?show=${to}`}><VerdictPill verdict={v} /></Link> : <VerdictPill verdict={v} />}</span>
                  <b>{n}</b>
                </Fragment>
              );
            })}
        </div>
        {skipped.length > 0 && (
          <span className="hint" style={{ margin: 0 }}>
            {skipped.length} mostly skipped source{skipped.length === 1 ? '' : 's'} sent {skippedItems} item{skippedItems === 1 ? '' : 's'}: {pct(skippedItems, allItems)} of
            everything that arrived.{' '}
            <Link to="/settings/sources?show=skipped">Look at {skipped.length === 1 ? 'it' : 'them'}</Link>
          </span>
        )}
        {lowest.length > 0 && (
          <>
            <span className="label" style={{ marginTop: 4 }}>
              Lowest value
            </span>
            {lowest.map((a) => (
              <Link key={a.sourceId} to={`/source/${a.sourceId}`} className="depthrow" style={{ color: 'inherit', textDecoration: 'none' }}>
                <span style={{ flex: '0 1 40%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14 }}>
                  {names.get(a.sourceId)?.name}
                </span>
                <DepthBar depth={a.depth} />
                <span className="depthrow__value">{depthValue(a.depth)}</span>
              </Link>
            ))}
          </>
        )}
      </section>
    </div>
  );
}

const skipShare = (d: DepthCounts) => {
  const total = depthTotal(d);
  return total ? (d.not_interested + d.skipped) / total : 0;
};
const pctOf = (x: number) => `${Math.round(x * 100)}%`;
const tagHref = (tag: string) => `/tag/${encodeURIComponent(tag)}`;

/**
 * Topics (AI tags) you mostly skip or mark Not interested, compared with your
 * average, and topics you skip from one source but read from others, with a
 * one-tap "skip posts mentioning it" for that source's post filter.
 */
function TopicsYouSkip() {
  const [data, setData] = useState<TopicSkips | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .topicSkips()
      .then(setData)
      .catch(() => undefined);
  }, []);
  if (!data || data.topics.length === 0) return null;
  const avg = skipShare(data.all);
  const line = Math.max(0.6, avg + 0.15);
  const skipped = data.topics
    .filter((t) => skipShare(t.depth) >= line)
    .sort((a, b) => skipShare(b.depth) - skipShare(a.depth) || depthTotal(b.depth) - depthTotal(a.depth))
    .slice(0, 10);
  const valued = data.topics
    .filter((t) => (depthValue(t.depth) ?? 0) >= 45)
    .sort((a, b) => (depthValue(b.depth) ?? 0) - (depthValue(a.depth) ?? 0))
    .slice(0, 5);
  // A topic you skip from one source but read from the others.
  const pairs = data.topics
    .flatMap((t) =>
      t.sources.map((s) => {
        const rest = emptyDepth();
        for (const l of DEPTH_LEVELS) rest[l] = t.depth[l] - s.depth[l];
        return { t, s, rest };
      }),
    )
    .filter(
      ({ s, rest }) =>
        skipShare(s.depth) >= 0.8 && depthTotal(rest) >= 5 && (depthValue(rest) ?? 0) >= (depthValue(s.depth) ?? 0) + 15,
    )
    .sort((a, b) => depthTotal(b.s.depth) - depthTotal(a.s.depth))
    .slice(0, 8);

  async function skipWord(sourceId: string, word: string) {
    setError(null);
    try {
      const source = (await api.sources()).find((x) => x.id === sourceId);
      if (!source) return;
      const f = source.postFilter;
      const words = f.skip
        .split(',')
        .map((w) => w.trim())
        .filter(Boolean);
      if (!words.some((w) => w.toLowerCase() === word.toLowerCase())) words.push(word);
      await api.updateSource(sourceId, { postFilter: { ...f, skip: words.join(', ') } });
      setAdded((prev) => new Set(prev).add(`${sourceId}:${word}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the filter');
    }
  }

  return (
    <div className="section">
      <span className="label">
        Topics you skip, last {data.days} days<Help topic="topicSkips" />
      </span>
      <section className="card">
        {skipped.length === 0 ? (
          <span className="hint" style={{ margin: 0 }}>
            No topic stands out yet: you skip {pctOf(avg)} of tagged items overall, and no topic is far above that.
          </span>
        ) : (
          <>
            <span className="hint" style={{ margin: 0 }}>
              You skip or mark Not interested {pctOf(avg)} of tagged items overall. These topics are well above that:
            </span>
            {skipped.map((t) => (
              <Link key={t.tag} to={tagHref(t.tag)} className="depthrow" style={{ color: 'inherit', textDecoration: 'none' }}>
                <span style={{ flex: '0 1 40%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14 }}>
                  {t.label}
                </span>
                <DepthBar depth={t.depth} />
                <span className="depthrow__value" style={{ minWidth: 70, fontWeight: 500, fontSize: 12 }}>
                  {pctOf(skipShare(t.depth))} of {depthTotal(t.depth)}
                </span>
              </Link>
            ))}
          </>
        )}
        {valued.length > 0 && (
          <>
            <span className="label" style={{ marginTop: 4 }}>
              Topics you go into most
            </span>
            {valued.map((t) => (
              <Link key={t.tag} to={tagHref(t.tag)} className="depthrow" style={{ color: 'inherit', textDecoration: 'none' }}>
                <span style={{ flex: '0 1 40%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14 }}>
                  {t.label}
                </span>
                <DepthBar depth={t.depth} />
                <span className="depthrow__value">{depthValue(t.depth)}</span>
              </Link>
            ))}
          </>
        )}
      </section>
      {pairs.length > 0 && (
        <>
          <span className="label">Skipped from one source, read from others</span>
          <section className="card">
            {pairs.map(({ t, s, rest }) => {
              const done = s.skipping || added.has(`${s.sourceId}:${t.label}`);
              return (
                <div key={`${t.tag}:${s.sourceId}`} style={{ display: 'grid', gap: 6 }}>
                  <span style={{ fontSize: 14 }}>
                    You skip <Link to={tagHref(t.tag)}>{t.label}</Link> from <Link to={`/source/${s.sourceId}`}>{s.name}</Link> (
                    {pctOf(skipShare(s.depth))} of {depthTotal(s.depth)}), but go further with it from other sources (value {depthValue(rest)} against{' '}
                    {depthValue(s.depth)}).
                  </span>
                  {s.canFilter &&
                    (done ? (
                      <span className="hint" style={{ margin: 0 }}>
                        {s.name} now skips new posts mentioning “{t.label}”.
                      </span>
                    ) : (
                      <div className="inline">
                        <button className="btn btn--small" onClick={() => void skipWord(s.sourceId, t.label)}>
                          Skip new {s.name} posts mentioning “{t.label}”
                        </button>
                      </div>
                    ))}
                </div>
              );
            })}
            {error && <span className="hint">{error}</span>}
            <span className="hint" style={{ margin: 0 }}>
              The skip goes in that source's "Which posts get in" filter, which checks post titles; change or remove it on the source's page.
            </span>
          </section>
        </>
      )}
    </div>
  );
}
