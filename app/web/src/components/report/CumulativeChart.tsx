import type { DayRow } from '@/types/report';
import { cumulative } from '@/lib/report';
import { inr, usdToInr } from '@/lib/format';

/**
 * The running total, day by day: the line that says whether the month is
 * working. Above zero green, below red, the zero line dotted -- the same three
 * marks as the rest of the desk.
 */
const W = 640;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 24, left: 58 };

export function CumulativeChart({ rows, includeCharges }: { rows: DayRow[]; includeCharges: boolean }) {
  const pts = cumulative(rows, includeCharges);
  if (pts.length === 0) {
    return <div className="pnl-empty">No trading days in this range.</div>;
  }
  const values = [0, ...pts.map((p) => p.usd)];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (pts.length === 1 ? plotW / 2 : (i / (pts.length - 1)) * plotW);
  const y = (v: number) => PAD.top + ((hi - v) / span) * plotH;

  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.usd).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1]!;
  const tone = last.usd > 0 ? 'var(--up)' : last.usd < 0 ? 'var(--down)' : 'var(--muted)';

  // Four gridlines, on round rupee figures.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => lo + t * span);
  const labelDays = [0, Math.floor((pts.length - 1) / 2), pts.length - 1]
    .filter((i, n, a) => a.indexOf(i) === n);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="pnl-svg" role="img"
      aria-label={`cumulative profit and loss over ${pts.length} trading days, ending ${inr(usdToInr(last.usd))}`}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--line-soft)" strokeWidth="1" />
          <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill="var(--dim)">
            {inr(usdToInr(v))}
          </text>
        </g>
      ))}
      <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 4" />
      <path d={path} fill="none" stroke={tone} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(pts.length - 1)} cy={y(last.usd)} r="3" fill={tone} />
      {labelDays.map((i) => (
        <text key={i} x={x(i)} y={H - 7} fontSize="10" fill="var(--dim)"
          textAnchor={i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}>
          {pts[i]!.day.slice(5)}
        </text>
      ))}
    </svg>
  );
}
