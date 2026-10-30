import { useState } from 'react';

// A small single-series bar chart: one bar per hour or day, an optional dashed
// limit line, and a readout line that shows a bar's numbers on tap or hover.

export const dayName = (at: number) => new Date(at).toLocaleDateString(undefined, { weekday: 'short' });
export const shortDate = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** Tick labels: day names at midnight, plus noon on the 48-hour view. */
export const hourTick = (hours: number) => (p: { at: number; label: string }) =>
  p.label === '00:00' ? dayName(p.at) : hours <= 48 && p.label === '12:00' ? '12:00' : null;

/** Tick labels for a run of days: a date every week (or three weeks on long views). */
export const dayTick = (days: number) => (p: { at: number }, i: number) => ((days <= 30 ? i % 7 : i % 21) === 0 ? shortDate(p.at) : null);

/** Round the top of the scale up to a tidy number. */
function niceMax(v: number): number {
  for (const step of [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440]) if (v <= step) return step;
  return Math.ceil(v / 60) * 60;
}

export function BarChart<P extends { at: number }>({
  points,
  value,
  unit,
  limit = null,
  summary,
  describe,
  tick,
  label,
}: {
  points: P[];
  /** null = no data for that period (no bar). */
  value: (p: P) => number | null;
  /** Shown after the top-of-scale number, e.g. "min" or "items". */
  unit: string;
  limit?: number | null;
  /** Readout when no bar is picked. */
  summary: string;
  describe: (p: P) => string;
  tick: (p: P, i: number) => string | null;
  label: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const values = points.map(value);
  const top = niceMax(Math.max(1, limit ?? 0, ...values.map((v) => v ?? 0)));
  const n = points.length;
  const gap = n > 60 ? 0.15 : 0.25; // share of each slot left empty between bars
  const shown = active !== null ? points[active] : null;

  function pick(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * n);
    setActive(i >= 0 && i < n ? i : null);
  }

  return (
    <div className="chart">
      <div className="chart__readout" aria-live="polite">
        {shown ? describe(shown) : summary}
      </div>
      <div className="chart__plot">
        <span className="chart__ymax">
          {unit === 'min' && top >= 120 ? `${top / 60} h` : `${top} ${unit}`}
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
          <line x1="0" x2={n} y1="100" y2="100" className="chart__base" vectorEffect="non-scaling-stroke" />
          {points.map((p, i) => {
            const v = values[i] ?? 0;
            const h = (v / top) * 100;
            const over = limit !== null && v > limit;
            return (
              <rect
                key={p.at}
                x={i + gap / 2}
                width={1 - gap}
                y={100 - h}
                height={h}
                className={`chart__bar${over ? ' chart__bar--over' : ''}${active === i ? ' chart__bar--active' : ''}`}
              />
            );
          })}
          {limit !== null && (
            <line
              x1="0"
              x2={n}
              y1={100 - (limit / top) * 100}
              y2={100 - (limit / top) * 100}
              className="chart__limit"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>
      <div className="chart__ticks">
        {points.map((p, i) => {
          const t = tick(p, i);
          return t ? (
            <span key={p.at} style={{ left: `${(i / n) * 100}%` }}>
              {t}
            </span>
          ) : null;
        })}
      </div>
    </div>
  );
}

/** The two-way switch above a chart: e.g. 48 h / 7 days. */
export function RangeSwitch<T extends number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}
