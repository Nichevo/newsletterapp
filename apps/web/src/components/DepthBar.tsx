import { DEPTH_LABEL, DEPTH_LEVELS, VERDICT_LABEL, depthTotal, type DepthCounts, type SourceVerdict } from '@newsletterapp/shared';

/** A stacked bar of how far you went with a source's items, Not interested first. */
export function DepthBar({ depth, big = false }: { depth: DepthCounts; big?: boolean }) {
  const total = depthTotal(depth);
  const title = DEPTH_LEVELS.filter((l) => depth[l] > 0)
    .map((l) => `${DEPTH_LABEL[l]} ${depth[l]}`)
    .join(' · ');
  return (
    <div className={`depthbar${big ? ' depthbar--big' : ''}`} title={title || 'Nothing looked at yet'} role="img" aria-label={title || 'Nothing looked at yet'}>
      {total > 0 &&
        DEPTH_LEVELS.map((l) =>
          depth[l] > 0 ? <i key={l} style={{ width: `${(depth[l] / total) * 100}%`, background: `var(--depth-${l})` }} /> : null,
        )}
    </div>
  );
}

export function DepthLegend({ depth, percent = false }: { depth: DepthCounts; percent?: boolean }) {
  const total = depthTotal(depth);
  return (
    <div className="depthlegend">
      {DEPTH_LEVELS.map((l) => (
        <div key={l}>
          <i style={{ background: `var(--depth-${l})` }} />
          {DEPTH_LABEL[l]}
          <em>{percent ? `${total ? Math.round((depth[l] / total) * 100) : 0}%` : depth[l]}</em>
        </div>
      ))}
    </div>
  );
}

export function VerdictPill({ verdict }: { verdict: SourceVerdict }) {
  return <span className={`verdict verdict--${verdict}`}>{VERDICT_LABEL[verdict]}</span>;
}

/** Colour for a 0-100 value: low reads as a warning, high as good. */
export function valueColour(value: number | null): string | undefined {
  if (value === null) return undefined;
  if (value < 20) return 'var(--red-ink)';
  if (value >= 60) return 'var(--green-ink)';
  return undefined;
}
