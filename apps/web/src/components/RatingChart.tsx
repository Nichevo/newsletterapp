import { useState } from 'react';

// Thumbs up and down for one model over time: stacked bars (up above the
// line, down below) with the share of thumbs up as a line on a 0-100% scale.
// The line is a rolling share over the last few bars, since a single day or
// week often has only one or two ratings. Tap or hover a bar for its numbers.

export interface RatingBucket {
  at: number;
  label: string;
  up: number;
  down: number;
}

const pctUp = (b: { up: number; down: number }) => (b.up + b.down > 0 ? Math.round((100 * b.up) / (b.up + b.down)) : null);

export function RatingChart({
  buckets,
  label,
  tick,
  window,
  windowLabel,
}: {
  buckets: RatingBucket[];
  label: string;
  tick: (b: RatingBucket, i: number) => string | null;
  /** How many bars the % up line rolls over. */
  window: number;
  /** e.g. "4 weeks", for the legend and readout. */
  windowLabel: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const n = buckets.length;
  const top = Math.max(1, ...buckets.map((b) => Math.max(b.up, b.down)));
  const gap = n > 60 ? 0.15 : 0.25;
  const shown = active !== null ? buckets[active] : null;
  const total = buckets.reduce((s, b) => ({ up: s.up + b.up, down: s.down + b.down }), { up: 0, down: 0 });

  // Bars use the middle of the plot as zero: up grows to the top, down to the bottom.
  const y = (v: number) => 50 - (v / top) * 48;
  const yDown = (v: number) => 50 + (v / top) * 48;
  const rolling = buckets.map((_, i) =>
    pctUp(buckets.slice(Math.max(0, i - window + 1), i + 1).reduce((s, b) => ({ up: s.up + b.up, down: s.down + b.down }), { up: 0, down: 0 })),
  );
  const line = rolling.map((p, i) => (p === null ? null : `${i + 0.5},${100 - p}`)).filter(Boolean);

  function pick(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * n);
    setActive(i >= 0 && i < n ? i : null);
  }

  const describe = (b: { up: number; down: number }) =>
    b.up + b.down === 0 ? 'no ratings' : `${b.up} up · ${b.down} down · ${pctUp(b)}% up`;

  return (
    <div className="chart">
      <div className="chart__readout" aria-live="polite">
        {shown
          ? `${shown.label} · ${describe(shown)}${rolling[active!] !== null ? ` · ${rolling[active!]}% up over ${windowLabel}` : ''}`
          : `All shown · ${describe(total)}`}
      </div>
      <div className="chart__plot chart__plot--split">
        <span className="chart__ymax">
          {top} up / 100%
        </span>
        <svg
          viewBox={`0 0 ${n} 100`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${label}, ${n} bars`}
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={() => setActive(null)}
        >
          <line x1="0" x2={n} y1="50" y2="50" className="chart__base" vectorEffect="non-scaling-stroke" />
          {buckets.map((b, i) => (
            <g key={b.at} className={active === i ? 'chart__bar--active' : undefined}>
              {b.up > 0 && <rect x={i + gap / 2} width={1 - gap} y={y(b.up)} height={50 - y(b.up)} className="chart__bar chart__bar--up" />}
              {b.down > 0 && <rect x={i + gap / 2} width={1 - gap} y={50} height={yDown(b.down) - 50} className="chart__bar chart__bar--down" />}
            </g>
          ))}
          {line.length > 1 && <polyline points={line.join(' ')} className="chart__pct" vectorEffect="non-scaling-stroke" />}
          {line.length === 1 && (
            <line
              x1={Number(line[0]!.split(',')[0]) - 0.3}
              x2={Number(line[0]!.split(',')[0]) + 0.3}
              y1={line[0]!.split(',')[1]}
              y2={line[0]!.split(',')[1]}
              className="chart__pct"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        <span className="chart__ymin">{top} down / 0%</span>
      </div>
      <div className="chart__ticks">
        {buckets.map((b, i) => {
          const t = tick(b, i);
          return t ? (
            <span key={b.at} style={{ left: `${(i / n) * 100}%` }}>
              {t}
            </span>
          ) : null;
        })}
      </div>
      <div className="chart__legend">
        <span className="chart__key chart__key--up">Thumbs up</span>
        <span className="chart__key chart__key--down">Thumbs down</span>
        <span className="chart__key chart__key--pct">% up, rolling {windowLabel}</span>
      </div>
    </div>
  );
}
