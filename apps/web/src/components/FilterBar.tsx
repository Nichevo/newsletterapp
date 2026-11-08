import {
  SOURCE_TYPES,
  FILE_FILTERS,
  FILE_FILTER_LABEL,
  type FileFilter,
  cycleFilterValue,
  filterState,
  matchesFilterSet,
  parseFilterSet,
  type ItemSort,
  type ItemView,
  type SavedFilter,
  type Source,
  type SourceType,
} from '@newsletterapp/shared';
import { useState } from 'react';
import { IconChevron, IconFilter } from '../icons';

export interface Filters {
  view: ItemView;
  sort: ItemSort;
  source: string | null;
  /** Categories to show or hide, e.g. "AI|Tech" or "!Comics" (see FilterSet). */
  category: string | null;
  /** Types to show or hide, e.g. "!reddit|!github". */
  kind: string | null;
}

/** "Reddit, GitHub" or "Not Reddit, GitHub" (or both parts), for the bar's one-line summary. */
function setLabel(value: string | null, label: (v: string) => string): string | null {
  const set = parseFilterSet(value);
  const parts = [
    set.include.length ? set.include.map(label).join(', ') : null,
    set.exclude.length ? `Not ${set.exclude.map(label).join(', ')}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** A chip that cycles: off → only these → hide these → off. */
function TriPill({ value, token, label, onChange }: { value: string | null; token: string; label: string; onChange: (v: string | null) => void }) {
  const state = filterState(value, token);
  return (
    <button
      className={state === 'exclude' ? 'pill pill--excluded' : 'pill'}
      aria-pressed={state === 'include'}
      aria-label={state === 'exclude' ? `${label} (hidden)` : label}
      onClick={() => onChange(cycleFilterValue(value, token))}
    >
      {state === 'exclude' ? `✕ ${label}` : label}
    </button>
  );
}

export const KIND_LABEL: Record<SourceType, string> = {
  newsletter: 'Newsletters',
  feed: 'Feeds',
  reddit: 'Reddit',
  youtube: 'YouTube',
  github: 'GitHub',
  site: 'Websites',
  ai: 'AI notes',
};

/** A source's type as the Type filter sees it. */
export const sourceType = (s: Pick<Source, 'kind' | 'platform'>): SourceType => s.platform ?? s.kind;

const VIEW_LABEL: Record<ItemView, string> = {
  inbox: 'All',
  unread: 'Unread',
  saved: 'Saved',
  interesting: 'Interesting',
  likely: 'Likely interesting',
  archived: 'Archived',
};

const SORT_LABEL: Record<ItemSort, string> = { newest: 'Newest first', oldest: 'Oldest first', top: 'Top first' };

export function FilterBar({
  filters,
  onChange,
  sources,
  categorySources,
  categories,
  count,
  fixedView,
  onBulk,
  saved,
  onSaved,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  sources: Source[];
  /** With a category picked: the sources that have items in it (from the server), when known. */
  categorySources?: string[] | null;
  categories: string[];
  count: number | null;
  /** When set, the view pills are hidden (e.g. the Saved screen). */
  fixedView?: boolean;
  /** Mark all read / archive all for the selected source, when one is selected. */
  onBulk?: (sourceId: string, action: 'read-all' | 'archive-all') => void;
  /** Named filters (kept in app settings); shown as one-tap presets when given. */
  saved?: SavedFilter[];
  onSaved?: (list: SavedFilter[]) => void;
}) {
  const same = (f: SavedFilter) =>
    f.view === filters.view && f.sort === filters.sort && f.source === filters.source && f.category === filters.category && f.kind === filters.kind;
  const current = saved?.find(same) ?? null;
  function saveCurrent() {
    if (!saved || !onSaved) return;
    const name = window.prompt('Name this filter', current?.name ?? '')?.trim();
    if (!name) return;
    const entry: SavedFilter = { name: name.slice(0, 40), ...filters };
    onSaved([...saved.filter((f) => f.name !== entry.name && !same(f)), entry]);
  }
  const [open, setOpen] = useState(false);
  const [allSources, setAllSources] = useState(false);
  const nameOf = (id: string) => sources.find((s) => s.id === id)?.name ?? 'One source';
  const sourceName = setLabel(filters.source, nameOf) ?? 'All sources';
  // Mark all read / archive all work on one source, when exactly one is shown.
  const srcSet = parseFilterSet(filters.source);
  const singleSource = srcSet.include.length === 1 && !srcSet.exclude.length ? srcSet.include[0]! : null;
  // With a type or category picked, only matching sources are offered (a Feedly import can add hundreds).
  // For a category, that's the sources with items in it (items often get their category from keyword
  // rules or the AI, not their source); until the server has said, sources set to that category.
  const inCategory = categorySources ? new Set(categorySources) : null;
  // File types pick items, not sources, so they leave the source list alone.
  const isFileToken = (k: string) => (FILE_FILTERS as readonly string[]).includes(k);
  const allKinds = parseFilterSet(filters.kind);
  const kindSet = { include: allKinds.include.filter((k) => !isFileToken(k)), exclude: allKinds.exclude.filter((k) => !isFileToken(k)) };
  const catSet = parseFilterSet(filters.category);
  const matchingSources = sources.filter(
    (s) =>
      filterState(filters.source, s.id) !== null ||
      (matchesFilterSet(sourceType(s), kindSet) &&
        (!catSet.include.length || catSet.include.includes(s.category ?? '') || (inCategory ? inCategory.has(s.id) : false)) &&
        !catSet.exclude.includes(s.category ?? '')),
  );
  // Reddit, YouTube and GitHub only show up as types once you follow something there.
  // PDFs, pictures and other files come in as single pages.
  const hasFiles = sources.some((s) => s.savedPages);
  const types = new Set<SourceType>(['newsletter', 'feed', 'site', 'ai', ...sources.map(sourceType)]);
  // The list stays folded to the chosen source until asked for, so the panel isn't a wall of chips.
  const SOURCE_PREVIEW = 8;
  const folded = !allSources && matchingSources.length > SOURCE_PREVIEW;
  const shownSources = folded
    ? matchingSources.filter((s, i) => i < SOURCE_PREVIEW || filterState(filters.source, s.id) !== null)
    : matchingSources;
  const summary = [
    fixedView ? null : VIEW_LABEL[filters.view],
    setLabel(filters.kind, (k) => KIND_LABEL[k as SourceType] ?? FILE_FILTER_LABEL[k as FileFilter] ?? k),
    setLabel(filters.category, (c) => c),
    sourceName,
    SORT_LABEL[filters.sort],
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="filterbar">
      <button className="filterbar__toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <IconFilter size={18} />
        <span>{summary}</span>
        {count !== null && <span className="filterbar__count">{count}</span>}
        <IconChevron size={18} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />
      </button>
      {saved && saved.length > 0 && (
        <div className="filterbar__presets" role="group" aria-label="Saved filters">
          {saved.map((f) => (
            <button
              key={f.name}
              className="pill"
              aria-pressed={same(f)}
              onClick={() => onChange({ view: f.view, sort: f.sort, source: f.source, category: f.category, kind: f.kind })}
            >
              {f.name}
            </button>
          ))}
        </div>
      )}
      {open && (
        <div className="filterbar__panel">
          {!fixedView && (
            <div className="filterbar__group">
              <span className="label">Show</span>
              <div className="pills">
                {(['inbox', 'unread', 'likely', 'interesting', 'archived'] as ItemView[]).map((v) => (
                  <button
                    key={v}
                    className="pill"
                    aria-pressed={filters.view === v}
                    onClick={() => onChange({ ...filters, view: v })}
                  >
                    {VIEW_LABEL[v]}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="filterbar__group">
            <span className="label">Type</span>
            <div className="pills">
              <button className="pill" aria-pressed={filters.kind === null} onClick={() => onChange({ ...filters, kind: null })}>
                All
              </button>
              {SOURCE_TYPES.filter((k) => types.has(k) || filterState(filters.kind, k) !== null).map((k) => (
                <TriPill key={k} value={filters.kind} token={k} label={KIND_LABEL[k]} onChange={(v) => onChange({ ...filters, kind: v })} />
              ))}
            </div>
            {(hasFiles || FILE_FILTERS.some((k) => filterState(filters.kind, k) !== null)) && (
              <div className="pills">
                {FILE_FILTERS.map((k) => (
                  <TriPill key={k} value={filters.kind} token={k} label={FILE_FILTER_LABEL[k]} onChange={(v) => onChange({ ...filters, kind: v })} />
                ))}
              </div>
            )}
            <span className="hint">Types, categories and sources: tap once to show only that, again to hide it (✕), once more to clear. Pick as many as you like.</span>
          </div>
          {categories.length > 0 && (
            <div className="filterbar__group">
              <span className="label">Category</span>
              <div className="pills">
                <button className="pill" aria-pressed={filters.category === null} onClick={() => onChange({ ...filters, category: null })}>
                  All
                </button>
                {categories.map((cat) => (
                  <TriPill key={cat} value={filters.category} token={cat} label={cat} onChange={(v) => onChange({ ...filters, category: v })} />
                ))}
              </div>
            </div>
          )}
          <div className="filterbar__group">
            <span className="label">Source</span>
            <div className="pills">
              <button className="pill" aria-pressed={filters.source === null} onClick={() => onChange({ ...filters, source: null })}>
                All
              </button>
              {shownSources.map((s) => (
                <TriPill key={s.id} value={filters.source} token={s.id} label={s.name} onChange={(v) => onChange({ ...filters, source: v })} />
              ))}
              {matchingSources.length > SOURCE_PREVIEW && (
                <button className="pill pill--more" onClick={() => setAllSources((v) => !v)} aria-expanded={!folded}>
                  {folded ? `Show all ${matchingSources.length}` : 'Show fewer'}
                </button>
              )}
            </div>
          </div>
          <div className="filterbar__group">
            <span className="label">Sort</span>
            <div className="segmented" role="group" aria-label="Sort order">
              <button aria-pressed={filters.sort === 'newest'} onClick={() => onChange({ ...filters, sort: 'newest' })}>
                Newest
              </button>
              <button aria-pressed={filters.sort === 'oldest'} onClick={() => onChange({ ...filters, sort: 'oldest' })}>
                Oldest
              </button>
              <button aria-pressed={filters.sort === 'top'} onClick={() => onChange({ ...filters, sort: 'top' })}>
                Top
              </button>
            </div>
            {filters.sort === 'top' && (
              <span className="hint">Top: newsletters you usually read, issues with substance, and the freshest first.</span>
            )}
          </div>
          {onBulk && singleSource && !fixedView && (
            <div className="filterbar__group">
              <span className="label">{sourceName}</span>
              <div className="inline">
                <button className="btn btn--small" onClick={() => onBulk(singleSource, 'read-all')}>
                  Mark all read
                </button>
                <button className="btn btn--small" onClick={() => onBulk(singleSource, 'archive-all')}>
                  Archive all
                </button>
              </div>
            </div>
          )}
          {saved && onSaved && (
            <div className="filterbar__group">
              <span className="label">Saved filters</span>
              <div className="inline">
                <button className="btn btn--small" onClick={saveCurrent}>
                  {current ? `Rename “${current.name}”` : 'Save this filter'}
                </button>
                {current && (
                  <button className="btn btn--ghost btn--small" onClick={() => onSaved(saved.filter((f) => f !== current))}>
                    Remove “{current.name}”
                  </button>
                )}
              </div>
              <span className="hint">Saved filters show as one-tap buttons under this bar, on your phone and PC.</span>
            </div>
          )}
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <button
              className="btn btn--ghost btn--small"
              onClick={() => onChange({ view: fixedView ? filters.view : 'inbox', sort: 'newest', source: null, category: null, kind: null })}
            >
              Reset
            </button>
            <button className="btn btn--primary btn--small" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
