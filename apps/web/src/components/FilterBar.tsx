import type { ItemKind, ItemSort, ItemView, Source } from '@newsletterapp/shared';
import { useState } from 'react';
import { IconChevron, IconFilter } from '../icons';

export interface Filters {
  view: ItemView;
  sort: ItemSort;
  source: string | null;
  category: string | null;
  kind: ItemKind | null;
}

export const KIND_LABEL: Record<ItemKind, string> = { newsletter: 'Newsletters', feed: 'Feeds', site: 'Websites', ai: 'AI notes' };

const VIEW_LABEL: Record<ItemView, string> = {
  inbox: 'All',
  unread: 'Unread',
  saved: 'Saved',
  archived: 'Archived',
};

const SORT_LABEL: Record<ItemSort, string> = { newest: 'Newest first', oldest: 'Oldest first', top: 'Top first' };

export function FilterBar({
  filters,
  onChange,
  sources,
  categories,
  count,
  fixedView,
  onBulk,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  sources: Source[];
  categories: string[];
  count: number | null;
  /** When set, the view pills are hidden (e.g. the Saved screen). */
  fixedView?: boolean;
  /** Mark all read / archive all for the selected source, when one is selected. */
  onBulk?: (sourceId: string, action: 'read-all' | 'archive-all') => void;
}) {
  const [open, setOpen] = useState(false);
  const [allSources, setAllSources] = useState(false);
  const sourceName = filters.source ? (sources.find((s) => s.id === filters.source)?.name ?? 'One source') : 'All sources';
  // With a type or category picked, only matching sources are offered (a Feedly import can add hundreds).
  // Sources with no category of their own stay in, since their items get categories from AI tags.
  const matchingSources = sources.filter(
    (s) =>
      s.id === filters.source ||
      ((!filters.kind || s.kind === filters.kind) && (!filters.category || s.category === filters.category || s.category === null)),
  );
  // The list stays folded to the chosen source until asked for, so the panel isn't a wall of chips.
  const SOURCE_PREVIEW = 8;
  const folded = !allSources && matchingSources.length > SOURCE_PREVIEW;
  const shownSources = folded
    ? matchingSources.filter((s, i) => i < SOURCE_PREVIEW || s.id === filters.source)
    : matchingSources;
  const summary = [
    fixedView ? null : VIEW_LABEL[filters.view],
    filters.kind ? KIND_LABEL[filters.kind] : null,
    filters.category,
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
      {open && (
        <div className="filterbar__panel">
          {!fixedView && (
            <div className="filterbar__group">
              <span className="label">Show</span>
              <div className="pills">
                {(['inbox', 'unread', 'archived'] as ItemView[]).map((v) => (
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
              {(Object.keys(KIND_LABEL) as ItemKind[]).map((k) => (
                <button
                  key={k}
                  className="pill"
                  aria-pressed={filters.kind === k}
                  onClick={() => onChange({ ...filters, kind: k, source: null })}
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>
          {categories.length > 0 && (
            <div className="filterbar__group">
              <span className="label">Category</span>
              <div className="pills">
                <button className="pill" aria-pressed={filters.category === null} onClick={() => onChange({ ...filters, category: null })}>
                  All
                </button>
                {categories.map((cat) => (
                  <button
                    key={cat}
                    className="pill"
                    aria-pressed={filters.category === cat}
                    onClick={() => onChange({ ...filters, category: cat })}
                  >
                    {cat}
                  </button>
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
                <button
                  key={s.id}
                  className="pill"
                  aria-pressed={filters.source === s.id}
                  onClick={() => onChange({ ...filters, source: s.id })}
                >
                  {s.name}
                </button>
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
          {onBulk && filters.source && !fixedView && (
            <div className="filterbar__group">
              <span className="label">{sourceName}</span>
              <div className="inline">
                <button className="btn btn--small" onClick={() => onBulk(filters.source!, 'read-all')}>
                  Mark all read
                </button>
                <button className="btn btn--small" onClick={() => onBulk(filters.source!, 'archive-all')}>
                  Archive all
                </button>
              </div>
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
