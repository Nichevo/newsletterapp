import { useNavigate } from 'react-router-dom';

/** Where a tag's page lives. */
export function tagPath(tag: string): string {
  return `/tag/${encodeURIComponent(tag.trim())}`;
}

/**
 * An AI tag that opens its tag page. In an inbox row it keeps the tap (and the
 * start of a swipe) to itself, so it doesn't also open the article.
 */
export function TagChip({ tag, count, inRow = false }: { tag: string; count?: number; inRow?: boolean }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="chip chip--tag"
      title={count ? `${count} item${count === 1 ? '' : 's'} tagged ${tag}` : `Everything tagged ${tag}`}
      onPointerDown={inRow ? (e) => e.stopPropagation() : undefined}
      onClick={(e) => {
        e.stopPropagation();
        navigate(tagPath(tag));
      }}
    >
      {tag}
      {count ? <span className="chip__n">{count}</span> : null}
    </button>
  );
}
