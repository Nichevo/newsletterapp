import { TOPICS_DAYS, type SourceType, type TopicFilter, type TopicsData, type TopicsDays } from '@newsletterapp/shared';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from 'd3-force';
import { sankey, sankeyLinkHorizontal, type SankeyLink, type SankeyNode } from 'd3-sankey';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { StatsTabs } from '../components/StatsTabs';
import { tagPath } from '../components/TagChip';
import { IconBack } from '../icons';

// Statistics > Topics: where the reading comes from and what it's about.
// Flow = sources → categories → tags (band width = items); Web = tags joined by the
// items they share, plus the sources that write about them. The period's data loads
// once; every filter below is worked out here, so changing them costs no reads.

const TYPE_LABEL: Record<SourceType, string> = {
  newsletter: 'Newsletter',
  feed: 'Feed',
  reddit: 'Reddit',
  youtube: 'YouTube',
  github: 'GitHub',
  site: 'Website',
  ai: 'AI notes',
};
const READ_LABEL: Record<TopicFilter['read'], string> = { all: 'All', unread: 'Unread', read: 'Read', starred: '★ Interesting' };
const TOPS = [5, 8, 15, 30, 0];
const MINS = [1, 2, 3, 5];
const MAX_SOURCES = 15; // more fold into "Other sources" on the flow
const OTHER_TAGS = 'Other tags';
const OTHER_SOURCES = 'Other sources';
const NO_CATEGORY = 'No category';
const PREFS_KEY = 'topics:filters';

type Filters = Omit<TopicFilter, 'name'>;
const DEFAULTS: Filters = { days: 30, categories: [], sources: [], types: [], read: 'all', top: 8, min: 1, showSources: true };

function loadPrefs(): { filters: Filters; view: 'flow' | 'web' } {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as { filters?: Partial<Filters>; view?: string } | null;
    return { filters: { ...DEFAULTS, ...(raw?.filters ?? {}) }, view: raw?.view === 'web' ? 'web' : 'flow' };
  } catch {
    return { filters: DEFAULTS, view: 'flow' };
  }
}

/** The items left after the filters, with their tags, plus the tags kept (most common first). */
function applyFilters(data: TopicsData, f: Filters) {
  const srcSet = new Set(f.sources);
  const typeSet = new Set(f.types);
  const catSet = new Set(f.categories);
  const items = data.items.filter(([s, c, flags]) => {
    const src = data.sources[s];
    if (srcSet.size && !(src && srcSet.has(src.id))) return false;
    if (typeSet.size && !(src && typeSet.has(src.type))) return false;
    if (catSet.size && !catSet.has(data.categories[c] ?? NO_CATEGORY)) return false;
    if (f.read === 'unread' && flags & 1) return false;
    if (f.read === 'read' && !(flags & 1)) return false;
    if (f.read === 'starred' && !(flags & 2)) return false;
    return true;
  });
  const counts = new Map<number, number>();
  for (const it of items) for (const t of it[4]) counts.set(t, (counts.get(t) ?? 0) + 1);
  const ranked = [...counts].filter(([, n]) => n >= f.min).sort((a, b) => b[1] - a[1] || data.tags[a[0]]!.label.localeCompare(data.tags[b[0]]!.label));
  const kept = new Map(f.top ? ranked.slice(0, f.top) : ranked);
  return { items, counts, kept };
}

type Focus = { kind: 'source' | 'category' | 'tag'; name: string } | null;

export function TopicsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const initial = useMemo(loadPrefs, []);
  const [filters, setFilters] = useState<Filters>(initial.filters);
  const [view, setView] = useState<'flow' | 'web'>(params.get('view') === 'web' ? 'web' : initial.view);
  const [panel, setPanel] = useState(false);
  const [data, setData] = useState<TopicsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>(null);
  const [find, setFind] = useState('');
  const [saved, setSaved] = useState<TopicFilter[] | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const cache = useRef(new Map<TopicsDays, TopicsData>());

  // Opened from a tag page: focus that tag.
  useEffect(() => {
    const tag = params.get('tag');
    if (tag) setFocus({ kind: 'tag', name: tag });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ filters, view }));
    } catch {
      // Not remembered on this device.
    }
  }, [filters, view]);

  useEffect(() => {
    api
      .settings()
      .then((s) => setSaved(s.topicFilters))
      .catch(() => setSaved([]));
  }, []);

  function load(days: TopicsDays, fresh = false) {
    const hit = cache.current.get(days);
    if (hit && !fresh) {
      setData(hit);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .topics(days, fresh)
      .then((d) => {
        cache.current.set(days, d);
        setData(d);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load'))
      .finally(() => setLoading(false));
  }
  useEffect(() => load(filters.days), [filters.days]);

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const toggleIn = <K extends 'categories' | 'sources' | 'types'>(key: K, value: Filters[K][number]) =>
    setFilters((f) => {
      const list = f[key] as string[];
      return { ...f, [key]: list.includes(value) ? list.filter((x) => x !== value) : [...list, value] };
    });

  const result = useMemo(() => (data ? applyFilters(data, filters) : null), [data, filters]);
  // Tag keys → index, for "find a tag" and focus from a tag page.
  const tagByKey = useMemo(() => new Map(data?.tags.map((t, i) => [t.key, i]) ?? []), [data]);
  const allTagLabels = useMemo(() => [...new Set(data?.tags.map((t) => t.label) ?? [])].sort((a, b) => a.localeCompare(b)), [data]);

  const active =
    filters.categories.length +
    filters.sources.length +
    filters.types.length +
    (filters.read !== 'all' ? 1 : 0) +
    (filters.top !== DEFAULTS.top ? 1 : 0) +
    (filters.min !== DEFAULTS.min ? 1 : 0) +
    (!filters.showSources ? 1 : 0);

  const sourcesSorted = useMemo(() => {
    if (!data) return [];
    const n = new Map<number, number>();
    for (const it of data.items) n.set(it[0], (n.get(it[0]) ?? 0) + 1);
    return data.sources.map((s, i) => ({ ...s, n: n.get(i) ?? 0 })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  }, [data]);
  const typesPresent = useMemo(() => [...new Set(data?.sources.map((s) => s.type) ?? [])], [data]);
  const categories = useMemo(() => {
    if (!data) return [];
    const list = [...data.categories].sort((a, b) => a.localeCompare(b));
    return data.items.some((i) => i[1] < 0) ? [...list, NO_CATEGORY] : list;
  }, [data]);

  function findTag(label: string) {
    const key = label.trim().toLowerCase();
    if (!tagByKey.has(key)) return;
    setFocus({ kind: 'tag', name: key });
    setFind('');
  }

  async function storeSaved(list: TopicFilter[]) {
    const before = saved;
    setSaved(list);
    try {
      setSaved((await api.saveSettings({ topicFilters: list })).topicFilters);
    } catch {
      setSaved(before);
    }
  }

  const chips: string[] = [
    ...filters.categories,
    ...filters.sources.map((id) => data?.sources.find((s) => s.id === id)?.name ?? 'A source'),
    ...filters.types.map((t) => TYPE_LABEL[t]),
    ...(filters.read !== 'all' ? [READ_LABEL[filters.read]] : []),
    ...(filters.top !== DEFAULTS.top ? [filters.top ? `Top ${filters.top} tags` : 'All tags'] : []),
    ...(filters.min > 1 ? [`Tags on ${filters.min}+ items`] : []),
    ...(!filters.showSources ? ['Tags only'] : []),
  ];

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
      <StatsTabs current="topics" />

      <div className="section">
        <div className="topics__bar">
          <div className="pills">
            <button
              className="pill"
              aria-pressed={view === 'flow'}
              onClick={() => {
                setView('flow');
                setParams({}, { replace: true });
              }}
            >
              Flow
            </button>
            <button
              className="pill"
              aria-pressed={view === 'web'}
              onClick={() => {
                setView('web');
                setParams({ view: 'web' }, { replace: true });
              }}
            >
              Web
            </button>
          </div>
          <div className="pills">
            {TOPICS_DAYS.map((d) => (
              <button key={d} className="pill" aria-pressed={filters.days === d} onClick={() => set({ days: d })}>
                {d} days
              </button>
            ))}
          </div>
        </div>
        <div className="topics__bar">
          <button className="pill" aria-expanded={panel} onClick={() => setPanel((p) => !p)}>
            Filters{active ? ` · ${active}` : ''} {panel ? '▴' : '▾'}
          </button>
          <input
            className="input topics__find"
            list="topics-tags"
            placeholder="Find a tag"
            aria-label="Find a tag"
            value={find}
            onChange={(e) => {
              setFind(e.target.value);
              if (allTagLabels.includes(e.target.value)) findTag(e.target.value);
            }}
            onKeyDown={(e) => e.key === 'Enter' && findTag(find)}
          />
          <datalist id="topics-tags">
            {allTagLabels.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>
        {saved && saved.length > 0 && (
          <div className="pills">
            {saved.map((s) => (
              <button
                key={s.name}
                className="pill"
                onClick={() => {
                  const { name: _n, ...rest } = s;
                  setFilters({ ...DEFAULTS, ...rest });
                }}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}

        {panel && data && (
          <section className="card topics__panel">
            <FilterRow label="Categories">
              {categories.map((c) => (
                <button key={c} className="pill" aria-pressed={filters.categories.includes(c)} onClick={() => toggleIn('categories', c)}>
                  {c}
                </button>
              ))}
            </FilterRow>
            <FilterRow label="Sources">
              {sourcesSorted
                .filter((s) => s.n > 0)
                .map((s) => (
                  <button key={s.id} className="pill" aria-pressed={filters.sources.includes(s.id)} onClick={() => toggleIn('sources', s.id)}>
                    {s.name} <span className="chip__n">{s.n}</span>
                  </button>
                ))}
            </FilterRow>
            <FilterRow label="Source type">
              {typesPresent.map((t) => (
                <button key={t} className="pill" aria-pressed={filters.types.includes(t)} onClick={() => toggleIn('types', t)}>
                  {TYPE_LABEL[t]}
                </button>
              ))}
            </FilterRow>
            <FilterRow label="Items">
              {(Object.keys(READ_LABEL) as TopicFilter['read'][]).map((r) => (
                <button key={r} className="pill" aria-pressed={filters.read === r} onClick={() => set({ read: r })}>
                  {READ_LABEL[r]}
                </button>
              ))}
            </FilterRow>
            <FilterRow label="Tags shown">
              {TOPS.map((t) => (
                <button key={t} className="pill" aria-pressed={filters.top === t} onClick={() => set({ top: t })}>
                  {t ? `Top ${t}` : 'All'}
                </button>
              ))}
            </FilterRow>
            <FilterRow label="Only tags on at least">
              {MINS.map((m) => (
                <button key={m} className="pill" aria-pressed={filters.min === m} onClick={() => set({ min: m })}>
                  {m} item{m === 1 ? '' : 's'}
                </button>
              ))}
            </FilterRow>
            {view === 'web' && (
              <FilterRow label="Web shows">
                <button className="pill" aria-pressed={filters.showSources} onClick={() => set({ showSources: true })}>
                  Tags and sources
                </button>
                <button className="pill" aria-pressed={!filters.showSources} onClick={() => set({ showSources: false })}>
                  Tags only
                </button>
              </FilterRow>
            )}
            {naming !== null ? (
              <div className="inline">
                <input
                  className="input"
                  autoFocus
                  placeholder="Name, e.g. Gaming unread"
                  value={naming}
                  maxLength={40}
                  onChange={(e) => setNaming(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && naming.trim()) {
                      void storeSaved([...(saved ?? []).filter((s) => s.name !== naming.trim()), { name: naming.trim(), ...filters }]);
                      setNaming(null);
                    }
                  }}
                />
                <button
                  className="btn btn--small"
                  disabled={!naming.trim()}
                  onClick={() => {
                    void storeSaved([...(saved ?? []).filter((s) => s.name !== naming.trim()), { name: naming.trim(), ...filters }]);
                    setNaming(null);
                  }}
                >
                  Save
                </button>
              </div>
            ) : (
              <div className="pills">
                <button className="pill" onClick={() => setFilters({ ...DEFAULTS, days: filters.days })}>
                  Reset
                </button>
                <button className="pill" onClick={() => setNaming('')}>
                  Save these filters…
                </button>
                {saved?.map((s) => (
                  <button key={s.name} className="pill pill--excluded" title="Delete this saved set" onClick={() => void storeSaved(saved.filter((x) => x !== s))}>
                    {s.name} ✕
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
        {!panel && chips.length > 0 && (
          <div className="row__tags">
            {chips.map((c) => (
              <span key={c} className="chip chip--category">
                {c}
              </span>
            ))}
            <button className="chip chip--outline topics__clear" onClick={() => setFilters({ ...DEFAULTS, days: filters.days })}>
              Clear
            </button>
          </div>
        )}
      </div>

      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="spinner">Loading…</div>}
      {data && result && (
        <>
          <div className="topics__summary">
            <span>
              {result.items.length} item{result.items.length === 1 ? '' : 's'} · {result.kept.size} tag{result.kept.size === 1 ? '' : 's'} shown · last{' '}
              {data.days} days
            </span>
            <span className="topics__legend">
              <span>
                <i style={{ background: 'var(--purple-ink)' }} />
                Sources
              </span>
              {view === 'flow' && (
                <span>
                  <i style={{ background: 'var(--amber-ink)' }} />
                  Categories
                </span>
              )}
              <span>
                <i style={{ background: 'var(--teal)' }} />
                Tags
              </span>
            </span>
          </div>
          {result.items.length === 0 || (view === 'web' && result.kept.size === 0) ? (
            <p className="hint" style={{ padding: '24px 16px', textAlign: 'center' }}>
              {data.items.length === 0
                ? 'Nothing arrived in this period yet.'
                : result.items.length === 0
                  ? 'Nothing matches these filters. Try a longer period or fewer filters.'
                  : 'None of these items have tags yet. Tags come from the AI summaries.'}
            </p>
          ) : view === 'flow' ? (
            <FlowChart data={data} result={result} focus={focus} onFocus={setFocus} />
          ) : (
            <WebChart data={data} result={result} showSources={filters.showSources} focus={focus} onFocus={setFocus} />
          )}
          <p className="hint" style={{ padding: '4px 16px 16px' }}>
            Updated {Math.max(0, Math.round((Date.now() - data.generatedAt) / 60_000))} min ago ·{' '}
            <button className="linkbtn" disabled={loading} onClick={() => load(filters.days, true)}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </p>
        </>
      )}
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="topics__frow">
      <span className="label">{label}</span>
      <div className="pills">{children}</div>
    </div>
  );
}

type Result = ReturnType<typeof applyFilters>;

/** The chart's width, following the page. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const plural = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

// ---------- Flow ----------

interface FNode {
  id: string;
  name: string;
  kind: 'source' | 'category' | 'tag';
  key: string; // tag key, source id or category name
  /** Items through this node (a category's bands out add up to more: an item can have several tags). */
  items: number;
}
interface FLink {
  source: number;
  target: number;
  value: number;
}

const KIND_COLOUR = { source: 'var(--purple-ink)', category: 'var(--amber-ink)', tag: 'var(--teal)' } as const;

function FlowChart({ data, result, focus, onFocus }: { data: TopicsData; result: Result; focus: Focus; onFocus: (f: Focus) => void }) {
  const [ref, measured] = useWidth();
  const width = Math.max(measured, 320);

  const graph = useMemo(() => {
    const nodes: FNode[] = [];
    const index = new Map<string, number>();
    const node = (id: string, name: string, kind: FNode['kind'], key: string) => {
      let i = index.get(id);
      if (i === undefined) {
        i = nodes.length;
        index.set(id, i);
        nodes.push({ id, name, kind, key, items: 0 });
      }
      return i;
    };
    const perSource = new Map<number, number>();
    for (const it of result.items) perSource.set(it[0], (perSource.get(it[0]) ?? 0) + 1);
    const topSources = new Set([...perSource].sort((a, b) => b[1] - a[1]).slice(0, MAX_SOURCES).map(([s]) => s));
    const links = new Map<string, number>();
    const add = (a: number, b: number) => links.set(`${a}>${b}`, (links.get(`${a}>${b}`) ?? 0) + 1);
    for (const [s, c, , , tags] of result.items) {
      const src = data.sources[s];
      const sn = topSources.has(s) && src ? node(`s:${src.id}`, src.name, 'source', src.id) : node('s:other', OTHER_SOURCES, 'source', '');
      const catName = data.categories[c] ?? NO_CATEGORY;
      const cn = node(`c:${catName}`, catName, 'category', catName);
      add(sn, cn);
      nodes[sn]!.items++;
      nodes[cn]!.items++;
      const seen = new Set<number>();
      for (const t of tags) {
        const tn = result.kept.has(t) ? node(`t:${data.tags[t]!.key}`, data.tags[t]!.label, 'tag', data.tags[t]!.key) : node('t:other', OTHER_TAGS, 'tag', '');
        if (!seen.has(tn)) {
          seen.add(tn);
          add(cn, tn);
          nodes[tn]!.items++;
        }
      }
    }
    const linkList: FLink[] = [...links].map(([k, v]) => {
      const [a, b] = k.split('>').map(Number) as [number, number];
      return { source: a, target: b, value: v };
    });
    const count = Math.max(...(['source', 'category', 'tag'] as const).map((k) => nodes.filter((n) => n.kind === k).length));
    const height = Math.max(320, count * 26 + 20);
    const layout = sankey<FNode, FLink>()
      .nodeWidth(12)
      .nodePadding(10)
      // Biggest first in each column, the catch-all nodes last.
      .nodeSort((a, b) => Number(a.key === '') - Number(b.key === '') || b.items - a.items || a.name.localeCompare(b.name))
      .extent([
        [4, 8],
        [width - 4, height - 8],
      ]);
    const g = layout({ nodes: nodes.map((n) => ({ ...n })), links: linkList.map((l) => ({ ...l })) });
    return { ...g, height };
  }, [data, result, width]);

  type N = SankeyNode<FNode, FLink>;
  type L = SankeyLink<FNode, FLink>;
  const picked = focus ? (graph.nodes.find((n) => n.kind === focus.kind && (n.key === focus.name || n.name === focus.name)) ?? null) : null;
  const focusTag = focus?.kind === 'tag' ? focus.name : null;

  // Everything upstream and downstream of the picked node.
  const lit = useMemo(() => {
    if (!picked) return null;
    const on = new Set<N>([picked]);
    const walk = (n: N, dir: 'up' | 'down') => {
      for (const l of (dir === 'down' ? n.sourceLinks : n.targetLinks) ?? []) {
        const m = (dir === 'down' ? l.target : l.source) as unknown as N;
        if (!on.has(m)) on.add(m);
        walk(m, dir);
      }
    };
    walk(picked, 'down');
    walk(picked, 'up');
    return on;
  }, [picked]);
  const linkLit = (l: L) => {
    if (!picked || !lit) return true;
    const s = l.source as unknown as N;
    const t = l.target as unknown as N;
    if (s === picked || t === picked) return true;
    // A category's flows are the bands either side of it; for a source or tag, the path through.
    if (picked.kind === 'category') return false;
    return lit.has(s) && lit.has(t) && (picked.kind === 'source' ? s.kind === 'category' : t.kind === 'category');
  };

  return (
    <div className="topics__chartwrap" ref={ref}>
      <div className="topics__chart">
        <svg width={width} height={graph.height} viewBox={`0 0 ${width} ${graph.height}`} role="img" aria-label="Flow from sources to categories to tags">
          <g fill="none">
            {graph.links.map((l, i) => {
              const s = l.source as unknown as N;
              const t = l.target as unknown as N;
              return (
                <path
                  key={i}
                  d={sankeyLinkHorizontal()(l) ?? undefined}
                  stroke={KIND_COLOUR[s.kind]}
                  strokeOpacity={linkLit(l) ? (picked ? 0.6 : 0.28) : 0.06}
                  strokeWidth={Math.max(1, l.width ?? 1)}
                >
                  <title>
                    {s.name} → {t.name}: {plural(l.value)}
                  </title>
                </path>
              );
            })}
          </g>
          {graph.nodes.map((n) => {
            const left = (n.x0 ?? 0) < width / 2;
            const dim = lit && !lit.has(n);
            return (
              <g
                key={n.id}
                className="topics__node"
                opacity={dim ? 0.3 : 1}
                onClick={() => onFocus(picked === n ? null : { kind: n.kind, name: n.key || n.name })}
              >
                <rect
                  x={n.x0}
                  y={n.y0}
                  width={(n.x1 ?? 0) - (n.x0 ?? 0)}
                  height={Math.max(2, (n.y1 ?? 0) - (n.y0 ?? 0))}
                  rx={3}
                  fill={KIND_COLOUR[n.kind]}
                />
                <rect x={(n.x0 ?? 0) - 6} y={(n.y0 ?? 0) - 4} width={160} height={Math.max(12, (n.y1 ?? 0) - (n.y0 ?? 0)) + 8} fill="transparent" />
                <text
                  x={left ? (n.x1 ?? 0) + 6 : (n.x0 ?? 0) - 6}
                  y={((n.y0 ?? 0) + (n.y1 ?? 0)) / 2}
                  dy="0.35em"
                  textAnchor={left ? 'start' : 'end'}
                  className="topics__label"
                >
                  {n.name} <tspan className="topics__count">{n.items}</tspan>
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <Info>
        {picked ? (
          <>
            <strong>
              {{ source: 'Source', category: 'Category', tag: 'Tag' }[picked.kind]}: {picked.name}
            </strong>{' '}
            · {plural(picked.items)}
            {(picked.targetLinks?.length ?? 0) > 0 && (
              <div>
                From:{' '}
                {[...(picked.targetLinks ?? [])]
                  .sort((a, b) => b.value - a.value)
                  .map((l) => `${(l.source as unknown as N).name} ${l.value}`)
                  .join(', ')}
              </div>
            )}
            {(picked.sourceLinks?.length ?? 0) > 0 && (
              <div>
                Into:{' '}
                {[...(picked.sourceLinks ?? [])]
                  .sort((a, b) => b.value - a.value)
                  .map((l) => `${(l.target as unknown as N).name} ${l.value}`)
                  .join(', ')}
              </div>
            )}
            {picked.kind === 'tag' && picked.key && <Link to={tagPath(picked.name)}>Open tag page ›</Link>}
            {picked.kind === 'source' && picked.key && <Link to={`/source/${picked.key}`}>Open source ›</Link>}
          </>
        ) : focusTag ? (
          <HiddenTag data={data} tagKey={focusTag} />
        ) : (
          'Tap a source, category or tag to light up its flows. Bands are as thick as the number of items.'
        )}
      </Info>
    </div>
  );
}

// ---------- Web ----------

interface WNode extends SimulationNodeDatum {
  id: string;
  name: string;
  kind: 'tag' | 'source';
  key: string;
  n: number;
}
interface WLink {
  source: string | WNode;
  target: string | WNode;
  value: number;
  kind: 'tag' | 'source';
}

const WEB_HEIGHT = 480;

function WebChart({
  data,
  result,
  showSources,
  focus,
  onFocus,
}: {
  data: TopicsData;
  result: Result;
  showSources: boolean;
  focus: Focus;
  onFocus: (f: Focus) => void;
}) {
  const [ref, measured] = useWidth();
  const width = Math.max(measured, 340);
  const [, redraw] = useState(0);

  const graph = useMemo(() => {
    const nodes: WNode[] = [...result.kept].map(([t, n]) => ({ id: `t:${data.tags[t]!.key}`, name: data.tags[t]!.label, kind: 'tag', key: data.tags[t]!.key, n }));
    const links = new Map<string, WLink>();
    const add = (a: string, b: string, kind: WLink['kind']) => {
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      const l = links.get(k);
      if (l) l.value++;
      else links.set(k, { source: a, target: b, value: 1, kind });
    };
    const perSource = new Map<number, number>();
    for (const [s, , , , tags] of result.items) {
      const kept = [...new Set(tags)].filter((t) => result.kept.has(t));
      if (!kept.length) continue;
      kept.forEach((a, i) => kept.slice(i + 1).forEach((b) => add(`t:${data.tags[a]!.key}`, `t:${data.tags[b]!.key}`, 'tag')));
      const src = data.sources[s];
      if (showSources && src) {
        perSource.set(s, (perSource.get(s) ?? 0) + 1);
        kept.forEach((t) => add(`s:${src.id}`, `t:${data.tags[t]!.key}`, 'source'));
      }
    }
    for (const [s, n] of perSource) {
      const src = data.sources[s]!;
      nodes.push({ id: `s:${src.id}`, name: src.name, kind: 'source', key: src.id, n });
    }
    const linkList = [...links.values()];
    const radius = (d: WNode) => (d.kind === 'tag' ? 7 + Math.sqrt(d.n) * 4 : 7);
    const sim = forceSimulation<WNode>(nodes)
      .force(
        'link',
        forceLink<WNode, WLink>(linkList)
          .id((d) => d.id)
          .distance((l) => (l.kind === 'source' ? 90 : 70))
          .strength((l) => (l.kind === 'source' ? 0.12 : 0.35)),
      )
      .force('charge', forceManyBody().strength(-240))
      .force('center', forceCenter(width / 2, WEB_HEIGHT / 2))
      .force('collide', forceCollide<WNode>((d) => radius(d) + 22))
      .stop();
    for (let i = 0; i < 300; i++) sim.tick();
    for (const d of nodes) {
      d.x = Math.max(50, Math.min(width - 50, d.x ?? 0));
      d.y = Math.max(18, Math.min(WEB_HEIGHT - 26, d.y ?? 0));
    }
    return { nodes, links: linkList as (WLink & { source: WNode; target: WNode })[], radius };
  }, [data, result, showSources, width]);

  const picked = focus
    ? (graph.nodes.find((n) => (focus.kind === 'tag' ? n.kind === 'tag' && n.key === focus.name : n.kind === 'source' && (n.key === focus.name || n.name === focus.name))) ?? null)
    : null;
  const near = useMemo(() => {
    if (!picked) return null;
    const s = new Set<WNode>([picked]);
    for (const l of graph.links) {
      if (l.source === picked) s.add(l.target);
      if (l.target === picked) s.add(l.source);
    }
    return s;
  }, [picked, graph]);

  // Dragging a node to untangle; a tap without a drag picks it.
  const drag = useRef<{ node: WNode; x: number; y: number; moved: boolean; id: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const toSvg = (e: RPointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * width, y: ((e.clientY - r.top) / r.height) * WEB_HEIGHT };
  };
  function down(e: RPointerEvent<SVGGElement>, node: WNode) {
    drag.current = { node, ...toSvg(e), moved: false, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e: RPointerEvent<SVGGElement>) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const p = toSvg(e);
    if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) < 4) return;
    d.moved = true;
    d.node.x = Math.max(12, Math.min(width - 12, p.x));
    d.node.y = Math.max(12, Math.min(WEB_HEIGHT - 12, p.y));
    redraw((n) => n + 1);
  }
  function up(e: RPointerEvent<SVGGElement>, node: WNode) {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved || d.id !== e.pointerId) return;
    if (picked === node) onFocus(null);
    else onFocus({ kind: node.kind, name: node.key });
  }

  const mine = picked
    ? graph.links
        .filter((l) => l.source === picked || l.target === picked)
        .map((l) => ({ other: l.source === picked ? l.target : l.source, value: l.value }))
        .sort((a, b) => b.value - a.value)
    : [];

  return (
    <div className="topics__chartwrap" ref={ref}>
      <div className="topics__chart">
        <svg ref={svgRef} width={width} height={WEB_HEIGHT} viewBox={`0 0 ${width} ${WEB_HEIGHT}`} role="img" aria-label="Network of tags and sources">
          {graph.links.map((l, i) => {
            const on = !picked || l.source === picked || l.target === picked;
            return (
              <line
                key={i}
                x1={l.source.x}
                y1={l.source.y}
                x2={l.target.x}
                y2={l.target.y}
                stroke={l.kind === 'source' ? 'var(--purple-ink)' : 'var(--teal)'}
                strokeOpacity={on ? (l.kind === 'source' ? 0.3 : 0.5) : 0.06}
                strokeWidth={Math.min(10, 1 + l.value * 1.2)}
                strokeDasharray={l.kind === 'source' ? '3 3' : undefined}
              >
                <title>
                  {l.kind === 'source'
                    ? `${l.source.kind === 'source' ? l.source.name : l.target.name}: ${plural(l.value)} on ${l.source.kind === 'tag' ? l.source.name : l.target.name}`
                    : `${l.source.name} + ${l.target.name}: together on ${plural(l.value)}`}
                </title>
              </line>
            );
          })}
          {graph.nodes.map((n) => {
            const r = graph.radius(n);
            return (
              <g
                key={n.id}
                className="topics__node"
                transform={`translate(${n.x},${n.y})`}
                opacity={near && !near.has(n) ? 0.25 : 1}
                onPointerDown={(e) => down(e, n)}
                onPointerMove={move}
                onPointerUp={(e) => up(e, n)}
                onPointerCancel={() => (drag.current = null)}
              >
                {n.kind === 'tag' ? (
                  <circle r={r} fill="var(--teal)" fillOpacity={0.88} stroke={picked === n ? 'var(--ink)' : 'none'} strokeWidth={2} />
                ) : (
                  <rect x={-7} y={-7} width={14} height={14} rx={3} fill="var(--purple-ink)" stroke={picked === n ? 'var(--ink)' : 'none'} strokeWidth={2} />
                )}
                {n.kind === 'tag' && (
                  <text dy="0.35em" textAnchor="middle" className="topics__inner">
                    {n.n}
                  </text>
                )}
                <text y={r + 13} textAnchor="middle" className={n.kind === 'tag' ? 'topics__label' : 'topics__label topics__label--source'}>
                  {n.name}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <Info>
        {picked ? (
          picked.kind === 'tag' ? (
            <>
              <strong>{picked.name}</strong> · {plural(picked.n)}
              <div>
                Seen with:{' '}
                {mine
                  .filter((m) => m.other.kind === 'tag')
                  .map((m) => `${m.other.name} ${m.value}`)
                  .join(', ') || 'nothing shown'}
              </div>
              {showSources && (
                <div>
                  From:{' '}
                  {mine
                    .filter((m) => m.other.kind === 'source')
                    .map((m) => `${m.other.name} ${m.value}`)
                    .join(', ')}
                </div>
              )}
              <Link to={tagPath(picked.name)}>Open tag page ›</Link>
            </>
          ) : (
            <>
              <strong>{picked.name}</strong> · {plural(picked.n)} with tags shown
              <div>
                Writes about:{' '}
                {mine.map((m) => `${m.other.name} ${m.value}`).join(', ')}
              </div>
              <Link to={`/source/${picked.key}`}>Open source ›</Link>
            </>
          )
        ) : focus?.kind === 'tag' ? (
          <HiddenTag data={data} tagKey={focus.name} />
        ) : (
          'Circles are tags (sized by items), squares are sources. Tap one to light up its links; drag to untangle.'
        )}
      </Info>
    </div>
  );
}

function Info({ children }: { children: React.ReactNode }) {
  return <div className="topics__info">{children}</div>;
}

/** A tag that was asked for but isn't on the chart with these filters. */
function HiddenTag({ data, tagKey }: { data: TopicsData; tagKey: string }) {
  const t = data.tags.find((x) => x.key === tagKey);
  const label = t?.label ?? tagKey;
  return (
    <>
      <strong>{label}</strong> isn't on the chart with these filters{t ? '' : ` or in the last ${data.days} days`}.{' '}
      <Link to={tagPath(label)}>Open its tag page ›</Link>
    </>
  );
}
