import {
  DEPTH_MIN_ITEMS,
  SOURCE_TYPES,
  depthTotal,
  depthValue,
  sourceVerdict,
  type DepthCounts,
  type Source,
  type SourceActivity,
  type SourceType,
  type SourceVerdict,
} from '@newsletterapp/shared';
import { DepthBar, VerdictPill, valueColour } from '../components/DepthBar';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { activityView, nextTime, rhythmText, type ActivityView } from '../format';
import { IconBack } from '../icons';
import { KIND_LABEL, sourceType } from '../components/FilterBar';
import { CategoriesSection, useAppSettings } from './Settings';

type Show = 'all' | 'quiet' | 'unread' | 'paused' | 'skipped' | 'summary' | 'keeper';
type Sort = 'latest' | 'name' | 'reads' | 'value';
const SORT_LABEL: Record<Sort, string> = { latest: 'Latest', name: 'Name', reads: 'Most looked at', value: 'Value, lowest first' };
interface Row {
  source: Source;
  view: ActivityView;
  depth: DepthCounts | null;
}
const SKIPPED: SourceVerdict[] = ['mostly_skipped', 'always_skipped'];
/** Lowest value first; sources with too little to go on go last. */
function valueKey(r: Row): number {
  return r.depth && depthTotal(r.depth) >= DEPTH_MIN_ITEMS ? (depthValue(r.depth) ?? 999) : 999;
}

/** Every source you receive or follow, grouped by kind. Each row opens the source's own page. */
export function SourcesPage() {
  const navigate = useNavigate();
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { settings, save } = useAppSettings();
  const [activity, setActivity] = useState<Map<string, SourceActivity>>(new Map());
  const [params] = useSearchParams();
  // Statistics links here as ?show=skipped (and sorts by value).
  const linked = (['skipped', 'summary', 'keeper'] as Show[]).find((v) => v === params.get('show'));
  const [show, setShow] = useState<Show>(linked ?? 'all');
  const [sort, setSort] = useState<Sort>(linked ? 'value' : 'latest');
  const [query, setQuery] = useState('');
  const [type, setType] = useState<SourceType | ''>('');
  const [category, setCategory] = useState('');

  useEffect(() => {
    api
      .sources(true)
      .then(setSources)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load sources'));
    api
      .sourceActivity()
      .then((rows) => setActivity(new Map(rows.map((r) => [r.sourceId, r]))))
      .catch(() => undefined);
  }, []);

  const rows: Row[] = (sources ?? []).map((s) => ({ source: s, view: activityView(activity.get(s.id), s), depth: activity.get(s.id)?.depth ?? null }));
  const quietCount = rows.filter((r) => r.view.quiet).length;
  const unreadCount = rows.filter((r) => r.view.unread).length;
  const pausedCount = rows.filter((r) => r.source.pausedAt !== null).length;
  const verdictOf = (r: Row) => (r.depth ? sourceVerdict(r.depth) : 'too_few');
  const skippedCount = rows.filter((r) => SKIPPED.includes(verdictOf(r))).length;
  const summaryCount = rows.filter((r) => verdictOf(r) === 'summary').length;
  const keeperCount = rows.filter((r) => verdictOf(r) === 'keeper').length;
  const types = SOURCE_TYPES.filter((t) => rows.some((r) => sourceType(r.source) === t));
  const categories = [...new Set(rows.map((r) => r.source.category).filter((c): c is string => Boolean(c)))].sort();
  const words = query.trim().toLowerCase();
  const picked = rows
    .filter((r) =>
      show === 'all'
        ? true
        : show === 'quiet'
          ? r.view.quiet
          : show === 'unread'
            ? r.view.unread
            : show === 'skipped'
              ? SKIPPED.includes(verdictOf(r))
              : show === 'summary'
                ? verdictOf(r) === 'summary'
                : show === 'keeper'
                  ? verdictOf(r) === 'keeper'
                  : r.source.pausedAt !== null,
    )
    .filter((r) => !type || sourceType(r.source) === type)
    .filter((r) => !category || (category === '-' ? !r.source.category : r.source.category === category))
    .filter(
      (r) =>
        !words ||
        [r.source.name, r.source.url, r.source.feedUrl, r.source.senderEmail]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(words)),
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.source.name.localeCompare(b.source.name)
        : sort === 'reads'
          ? b.view.readsPerMonth - a.view.readsPerMonth || b.view.perMonth - a.view.perMonth
          : sort === 'value'
            ? valueKey(a) - valueKey(b) || b.view.perMonth - a.view.perMonth
            : 0,
    );
  const newsletters = picked.filter((r) => r.source.kind === 'newsletter');
  const others = picked.filter((r) => r.source.kind !== 'newsletter');
  const [checking, setChecking] = useState<string | null>(null);

  const checkAll = async () => {
    setChecking('Checking…');
    try {
      const r = await api.checkAllSources();
      const left = Math.max(r.due - r.cloud - r.queued, 0);
      setChecking(
        `${r.added} new post${r.added === 1 ? '' : 's'} so far` +
          (r.queued ? `, ${r.queued} sent to your PC` : '') +
          (left ? `; the other ${left} follow over the next hour.` : '.'),
      );
      setSources(await api.sources(true));
    } catch (err) {
      setChecking(err instanceof Error ? err.message : 'Could not check');
    }
  };

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Your sources</h1>
        </div>
      </header>

      {error && <div className="error">{error}</div>}
      <div className="section">
        <div className="card card--list">
          <Link to="/settings/sources/suggested" className="cardrow">
            <div className="cardrow__main">
              <span className="cardrow__title">Suggested for you</span>
              <span className="cardrow__sub">Feeds you might like, from the sites your reading keeps linking to</span>
            </div>
          </Link>
        </div>
      </div>
      {sources === null && !error && <div className="spinner">Loading…</div>}

      {sources && sources.length === 0 && (
        <div className="empty">
          <h2>Nothing yet</h2>
          <p>Sources appear here once the first issue arrives.</p>
          <Link to="/add" className="btn btn--primary">
            Add one
          </Link>
        </div>
      )}

      {sources && sources.length > 0 && (
        <div className="section">
          <input
            className="input"
            type="search"
            placeholder="Find a source by name or address"
            aria-label="Find a source"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="inline" style={{ flexWrap: 'wrap' }}>
            <select className="input" style={{ flex: '1 1 130px' }} aria-label="Type" value={type} onChange={(e) => setType(e.target.value as SourceType | '')}>
              <option value="">All types</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {KIND_LABEL[t]}
                </option>
              ))}
            </select>
            <select className="input" style={{ flex: '1 1 130px' }} aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
              <option value="-">No category</option>
            </select>
          </div>
          <div className="pills">
            {(['all', 'skipped', 'summary', 'keeper', 'quiet', 'unread', 'paused'] as Show[])
              .filter((v) => v !== 'paused' || pausedCount > 0)
              .map((v) => (
                <button key={v} className="pill" aria-pressed={show === v} onClick={() => setShow(v)}>
                  {v === 'all'
                    ? 'All'
                    : v === 'quiet'
                      ? `Quiet (${quietCount})`
                      : v === 'unread'
                        ? `Unread (${unreadCount})`
                        : v === 'skipped'
                          ? `Mostly skipped (${skippedCount})`
                          : v === 'summary'
                            ? `Summary is enough (${summaryCount})`
                            : v === 'keeper'
                              ? `Keepers (${keeperCount})`
                              : `Paused (${pausedCount})`}
                </button>
              ))}
          </div>
          <div className="pills">
            <span className="label" style={{ alignSelf: 'center' }}>
              Sort
            </span>
            {(Object.keys(SORT_LABEL) as Sort[]).map((v) => (
              <button key={v} className="pill" aria-pressed={sort === v} onClick={() => setSort(v)}>
                {SORT_LABEL[v]}
              </button>
            ))}
          </div>
          <span className="hint">
            Rates are over the last 90 days (or since a source was added). The bar shows how far you went with its items, from Not
            interested (orange) and Skipped (grey) to Read the summary, Read the article (teal) and Kept (amber); the number is its value out of 100. Looked at =
            glanced or more, so a swipe without looking doesn&apos;t count. Quiet = nothing for 30+ days and well past its usual gap. Unread =
            none of its recent items looked at.
          </span>
        </div>
      )}
      {sources && sources.length > 0 && picked.length === 0 && (
        <p className="hint" style={{ padding: '0 16px' }}>
          {query || type || category
            ? 'No sources match these filters.'
            : show === 'quiet'
              ? 'No quiet sources: everything has posted recently.'
              : show === 'paused'
                ? 'No paused sources.'
                : show === 'skipped' || show === 'summary' || show === 'keeper'
                  ? `None yet. A source needs ${DEPTH_MIN_ITEMS} items you have looked at, marked read or left unread for two weeks.`
                : 'No unread sources: you read something from each.'}
        </p>
      )}

      <SourceList title="Newsletters you receive" rows={newsletters} noun="issue" />
      <SourceList title="Feeds and websites you follow" rows={others} noun="post" />
      {others.length > 0 && (
        <div className="section">
          <div className="inline">
            <button className="btn btn--small" onClick={checkAll} disabled={checking === 'Checking…'}>
              Check all now
            </button>
          </div>
          <span className="hint">
            {checking ??
              'Feeds set to Auto are checked around the times they usually post (and at least daily). This checks every feed and website straight away.'}
          </span>
        </div>
      )}

      {settings && <CategoriesSection settings={settings} onSave={save} />}
    </div>
  );
}

function SourceList({ title, rows, noun }: { title: string; rows: Row[]; noun: string }) {
  if (rows.length === 0) return null;
  return (
    <div className="section">
      <span className="label">{title}</span>
      <div className="card card--list">
        {rows.map(({ source: s, view, depth }) => (
          <Link key={s.id} to={`/source/${s.id}`} className="cardrow">
            <div className="cardrow__main">
              <span className="cardrow__title">{s.name}</span>
              <span className="cardrow__sub">
                {s.savedPages ? 'Single pages · ' : s.kind === 'site' ? 'Website · ' : s.platform ? `${{ reddit: 'Reddit', youtube: 'YouTube', github: 'GitHub' }[s.platform]} · ` : ''}
                {s.itemCount} {noun}
                {s.itemCount === 1 ? '' : 's'}
                {s.category ? ` · ${s.category}` : ''}
                {s.aiMode !== 'default' ? ` · AI ${s.aiMode}` : ''}
                {s.pausedAt ? ' · paused' : s.lastError ? ' · last check failed' : ''}
              </span>
              <span className="cardrow__sub">{view.line}</span>
              {depth && depthTotal(depth) > 0 && <SourceDepthLine depth={depth} />}
              {view.flag && !s.pausedAt && <span className="cardrow__sub cardrow__flag">{view.flag}</span>}
              {s.kind === 'feed' && !s.pausedAt && (
                <span className="cardrow__sub">
                  {rhythmText(s.rhythm, s.checkMinutes === null).summary}
                  {s.checkMinutes !== null ? ' Fixed interval.' : ''}
                  {s.nextCheckAt ? ` Next check ${nextTime(s.nextCheckAt)}.` : ''}
                </span>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function SourceDepthLine({ depth }: { depth: DepthCounts }) {
  const verdict = sourceVerdict(depth);
  const value = depthValue(depth);
  return (
    <span className="cardrow__sub depthrow">
      <DepthBar depth={depth} />
      <span className="depthrow__value" style={{ color: verdict === 'too_few' ? undefined : valueColour(value) }}>
        {verdict === 'too_few' ? '' : value}
      </span>
      {verdict !== 'mixed' && <VerdictPill verdict={verdict} />}
    </span>
  );
}
