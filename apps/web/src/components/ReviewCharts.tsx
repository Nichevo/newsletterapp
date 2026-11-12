import type { ReviewArc, ReviewBucket, ReviewMover } from '@newsletterapp/shared';

// Small hand-drawn charts for the weekly and monthly review. Every chart uses
// one scale for its marks and labels, and theme colours from the stylesheet.

export const SERIES = ['var(--ks-main)', 'var(--ks-takeaway)', 'var(--ks-evidence)', 'var(--ks-example)', 'var(--ks-caveat)', 'var(--teal)'];

const nice = (v: number) => {
  if (v <= 5) return 5;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * mag) return m * mag;
  return 10 * mag;
};

/** Items per day as little bars, the last one solid. */
export function Spark({ values, label }: { values: number[]; label: string }) {
  const W = 84;
  const H = 30;
  const max = Math.max(1, ...values);
  const bw = W / values.length;
  return (
    <svg className="rv-spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {values.map((v, i) => {
        const h = Math.max(v > 0 ? 3 : 1, (v / max) * (H - 2));
        return <rect key={i} x={i * bw + 1} y={H - h} width={bw - 2} height={h} rx={1.5} fill="var(--teal)" opacity={v === 0 ? 0.25 : 0.85} />;
      })}
    </svg>
  );
}

export interface Line {
  key: string;
  label: string;
  values: number[];
}

/** Several lines on one scale, labelled at their right-hand ends; the last period shaded. */
export function LineChart({ lines, ticks, unit, label, onPick }: { lines: Line[]; ticks: string[]; unit?: string; label: string; onPick?: (key: string) => void }) {
  const W = 360;
  const H = 190;
  const L = 30;
  const R = 92;
  const T = 8;
  const B = 20;
  const n = ticks.length;
  if (n < 2 || lines.length === 0) return null;
  const top = nice(Math.max(1, ...lines.flatMap((l) => l.values)));
  const x = (i: number) => L + (i * (W - L - R)) / (n - 1);
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const every = Math.max(1, Math.ceil(n / 6));
  const ends = lines.map((l, i) => ({ l, i, y: y(l.values[n - 1] ?? 0) })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k]!.y - ends[k - 1]!.y < 12) ends[k]!.y = ends[k - 1]!.y + 12;
  // Keep the labels above the date axis: if the stack ran off the bottom, push it back up.
  const floor = H - B;
  if (ends.length && ends[ends.length - 1]!.y > floor) {
    ends[ends.length - 1]!.y = floor;
    for (let k = ends.length - 2; k >= 0; k--) if (ends[k + 1]!.y - ends[k]!.y < 12) ends[k]!.y = ends[k + 1]!.y - 12;
  }
  const step = (W - L - R) / (n - 1);
  return (
    <svg className="rv-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <rect x={x(n - 1) - step / 2} y={T} width={step / 2 + 3} height={H - T - B} fill="var(--teal-tint)" />
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={L} x2={W - R} y1={y(top * f)} y2={y(top * f)} stroke="var(--border)" />
          <text x={L - 5} y={y(top * f) + 3.5} textAnchor="end" className="rv-axis">
            {Math.round(top * f)}
            {unit ?? ''}
          </text>
        </g>
      ))}
      {ticks.map((t, i) =>
        (n - 1 - i) % every === 0 ? (
          <text key={i} x={x(i)} y={H - 5} textAnchor="middle" className="rv-axis">
            {t}
          </text>
        ) : null,
      )}
      {lines.map((l, i) => (
        <g key={l.key} onClick={onPick ? () => onPick(l.key) : undefined} style={onPick ? { cursor: 'pointer' } : undefined}>
          <polyline
            fill="none"
            stroke={SERIES[i % SERIES.length]}
            strokeWidth={n > 30 ? 1.5 : 2}
            strokeLinejoin="round"
            points={l.values.map((v, j) => `${x(j)},${y(v)}`).join(' ')}
          />
          <circle cx={x(n - 1)} cy={y(l.values[n - 1] ?? 0)} r={3} fill={SERIES[i % SERIES.length]} />
        </g>
      ))}
      {ends.map((e) => (
        <text
          key={e.l.key}
          x={x(n - 1) + 7}
          y={e.y + 3.5}
          className="rv-endlabel"
          fill={SERIES[e.i % SERIES.length]}
          onClick={onPick ? () => onPick(e.l.key) : undefined}
          style={onPick ? { cursor: 'pointer' } : undefined}
        >
          {e.l.label.length > 15 ? `${e.l.label.slice(0, 14)}…` : e.l.label}
        </text>
      ))}
    </svg>
  );
}

/** Rising and falling tags: change against the usual, as bars either side of a centre line. */
export function Movers({ movers, onPick }: { movers: ReviewMover[]; onPick?: (m: ReviewMover) => void }) {
  if (movers.length === 0) return null;
  const W = 360;
  const rowH = 22;
  const T = 16;
  const mid = 196;
  const half = 70;
  const H = T + movers.length * rowH + 2;
  // A tag that was nearly absent shows as "new" rather than a huge percentage,
  // and bars cap at +300% so one outlier doesn't flatten the rest.
  const fresh = movers.map((m) => m.usual < 1 && m.now > m.usual);
  const change = movers.map((m) => (m.usual > 0 ? Math.round(((m.now - m.usual) / m.usual) * 100) : 100));
  const CAP = 300;
  const max = Math.max(1, ...change.map((c, i) => (fresh[i] ? CAP : Math.min(CAP, Math.abs(c)))));
  return (
    <svg className="rv-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Tags rising and falling against your usual week">
      <text x={mid - 6} y={10} textAnchor="end" className="rv-axis">
        Falling
      </text>
      <text x={mid + 6} y={10} className="rv-axis">
        Rising
      </text>
      <text x={W - 2} y={10} textAnchor="end" className="rv-axis">
        week vs usual
      </text>
      <line x1={mid} x2={mid} y1={T - 3} y2={H} stroke="var(--border-strong)" />
      {movers.map((m, i) => {
        const yy = T + i * rowH;
        const up = change[i]! >= 0;
        const w = Math.max(2, ((fresh[i] ? CAP : Math.min(CAP, Math.abs(change[i]!))) / max) * half);
        const color = up ? 'var(--green-ink)' : 'var(--red-ink)';
        return (
          <g key={m.tag} onClick={onPick ? () => onPick(m) : undefined} style={onPick ? { cursor: 'pointer' } : undefined}>
            <text x={mid - half - 34} y={yy + 14} textAnchor="end" className="rv-endlabel" fill="var(--ink)">
              {m.label.length > 18 ? `${m.label.slice(0, 17)}…` : m.label}
            </text>
            <rect x={up ? mid : mid - w} y={yy + 4} width={w} height={13} rx={3} fill={color} opacity={0.85} />
            <text x={up ? mid + w + 4 : mid - w - 4} y={yy + 14} textAnchor={up ? 'start' : 'end'} className="rv-axis" fill={color} style={{ fontWeight: 600 }}>
              {fresh[i] ? 'new' : `${up ? '+' : ''}${change[i]}%`}
            </text>
            <text x={W - 2} y={yy + 14} textAnchor="end" className="rv-axis">
              {m.now} vs {Math.round(m.usual * 10) / 10}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Arrived (pale) and read (solid) side by side for each day or month. */
export function PairBars({ buckets, label }: { buckets: ReviewBucket[]; label: string }) {
  const W = 360;
  const H = 130;
  const L = 30;
  const T = 6;
  const B = 18;
  const n = buckets.length;
  if (n === 0) return null;
  const top = nice(Math.max(1, ...buckets.map((b) => Math.max(b.arrived, b.read))));
  const slot = (W - L) / n;
  const bw = Math.min(22, slot * 0.34);
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  return (
    <svg className="rv-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={L} x2={W} y1={y(top * f)} y2={y(top * f)} stroke="var(--border)" />
          <text x={L - 5} y={y(top * f) + 3.5} textAnchor="end" className="rv-axis">
            {Math.round(top * f)}
          </text>
        </g>
      ))}
      {buckets.map((b, i) => {
        const cx = L + slot * i + slot / 2;
        return (
          <g key={b.at}>
            <title>{`${b.label}: ${b.arrived} arrived, ${b.read} read`}</title>
            <rect x={cx - bw - 1} y={y(b.arrived)} width={bw} height={y(0) - y(b.arrived)} rx={2} fill="var(--border-strong)" />
            <rect x={cx + 1} y={y(b.read)} width={bw} height={y(0) - y(b.read)} rx={2} fill="var(--teal)" />
            <text x={cx} y={H - 4} textAnchor="middle" className="rv-axis">
              {b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Each story as a bar from first to last post over 26 weeks, its busiest week marked. */
export function Arcs({ arcs, toAt, onPick }: { arcs: ReviewArc[]; toAt: number; onPick?: (a: ReviewArc) => void }) {
  if (arcs.length === 0) return null;
  const WEEKS = 26;
  const W = 360;
  const T = 18;
  const rowH = 30;
  const H = T + arcs.length * rowH + 4;
  const x0 = 4;
  const x1 = W - 58;
  const wx = (w: number) => x0 + (w / WEEKS) * (x1 - x0);
  const start = toAt - WEEKS * 7 * 86_400_000;
  const months: { x: number; label: string }[] = [];
  for (let w = 0; w <= WEEKS; w++) {
    const d = new Date(start + w * 7 * 86_400_000);
    const label = d.toLocaleDateString(undefined, { month: 'short' });
    if (!months.length || months[months.length - 1]!.label !== label) months.push({ x: wx(w), label });
  }
  const color = (s: ReviewArc['status']) => (s === 'ended' ? 'var(--border-strong)' : s === 'back' ? 'var(--ks-example)' : 'var(--teal)');
  return (
    <svg className="rv-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="How your stories ran over 6 months">
      {months.slice(1).map((m) => (
        <g key={m.label + m.x}>
          <line x1={m.x} x2={m.x} y1={T - 4} y2={H} stroke="var(--border)" />
          <text x={m.x + 3} y={10} className="rv-axis">
            {m.label}
          </text>
        </g>
      ))}
      {arcs.map((a, i) => {
        const yy = T + i * rowH;
        const first = a.perWeek.findIndex((n) => n > 0);
        const last = a.perWeek.length - 1 - [...a.perWeek].reverse().findIndex((n) => n > 0);
        const peak = a.perWeek.indexOf(Math.max(...a.perWeek));
        const segs: [number, number][] = [];
        let runStart = -1;
        let gapRun = 0;
        for (let w = Math.max(0, first); w <= last; w++) {
          if (a.perWeek[w]! > 0) {
            if (runStart < 0) runStart = w;
            gapRun = 0;
          } else if (runStart >= 0 && ++gapRun >= 4) {
            segs.push([runStart, w - gapRun + 1]);
            runStart = -1;
          }
        }
        if (runStart >= 0) segs.push([runStart, last + 1]);
        const c = color(a.status);
        const labelX = Math.min(wx(Math.max(0, first)), x1 - 150);
        return (
          <g key={a.id} onClick={onPick ? () => onPick(a) : undefined} style={onPick ? { cursor: 'pointer' } : undefined}>
            <text x={labelX} y={yy + 9} className="rv-endlabel" fill="var(--ink)">
              {a.title.length > 34 ? `${a.title.slice(0, 33)}…` : a.title}
            </text>
            {segs.length > 1 && <line x1={wx(segs[0]![1])} x2={wx(segs[1]![0])} y1={yy + 18} y2={yy + 18} stroke={c} strokeDasharray="2 4" />}
            {segs.map(([p, q]) => (
              <rect key={p} x={wx(p)} y={yy + 14} width={Math.max(3, wx(q) - wx(p))} height={8} rx={4} fill={c} />
            ))}
            {first >= 0 && <circle cx={wx(peak + 0.5)} cy={yy + 18} r={5} fill={c} stroke="var(--surface)" strokeWidth={2} />}
            <text x={W - 2} y={yy + 21} textAnchor="end" className="rv-axis">
              {a.status === 'ended' ? 'ended' : a.status === 'back' ? 'came back' : 'running'}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
