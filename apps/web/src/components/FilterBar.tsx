import type { ItemSort, ItemView, Source } from '@newsletterapp/shared';
import { useState } from 'react';
import { IconChevron, IconFilter } from '../icons';

export interface Filters {
  view: ItemView;
  sort: ItemSort;
  source: string | null;
  category: string | null;
}

const VIEW_LABEL: Record<ItemView, string> = {
  inbox: 'All',
  unread: 'Unread',
  saved: 'Saved',
  archived: 'Archived',
};

export function FilterBar({
  filters,
  onChange,
  sources,
  categories,
  count,
  fixedView,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  sources: Source[];
  categories: string[];
  count: number | null;
  /** When set, the view pills are hidden (e.g. the Saved screen). */
  fixedView?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const sourceName = filters.source ? (sources.find((s) => s.id === filters.source)?.name ?? 'One source') : 'All sources';
  const summary = [
    fixedView ? null : VIEW_LABEL[filters.view],
    filters.category,
    sourceName,
    filters.sort === 'newest' ? 'Newest first' : 'Oldest first',
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
              {sources.map((s) => (
                <button
                  key={s.id}
                  className="pill"
                  aria-pressed={filters.source === s.id}
                  onClick={() => onChange({ ...filters, source: s.id })}
                >
                  {s.name}
                </button>
              ))}
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
            </div>
          </div>
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <button
              className="btn btn--ghost btn--small"
              onClick={() => onChange({ view: fixedView ? filters.view : 'inbox', sort: 'newest', source: null, category: null })}
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
