import { useState } from 'react';
import { dayLabel, moneyText } from '@/lib/market-report';
import { count } from '@/components/report/backtest-parts';

/**
 * The backtest's running total, expiry day by expiry day (owner, 14 Oct 2026: "the backtest screen, user friendly"):
 * whether the settings make money steadily or on one lucky day, and the worst stretch on the way -- which a total and
 * a day table do not show at a glance. The same three marks as the P&L's own curve (`CumulativeChart`): the line
 * green above zero, red below, the zero dotted. A finger or the mouse on it reads a day out; the table of the same
 * days is the "By expiry day" panel below.
 */

export type CurveDay = { day: string; net: number; n: number; live?: boolean };

/**
 * Running totals, and the deepest fall from a high point to a later low: where the settings hurt most. `from` is null
 * where the high was the start itself -- the total never stood above nothing.
 */
export function curveOf(days: readonly CurveDay[]): { cum: number[]; drop: { usd: number; from: string | null; to: string } | null } {
  const cum: number[] = [];
  let run = 0, peak = 0, peakDay: string | null = null;
  let drop: { usd: number; from: string | null; to: string } | null = null;
  for (const d of days) {
    run += d.net;
    cum.push(run);
    if (run > peak) { peak = run; peakDay = d.day; }
    const fall = peak - run;
    if (fall > 1e-9 && (!drop || fall > drop.usd)) drop = { usd: fall, from: peakDay, to: d.day };
  }
  return { cum, drop };
}

const W = 640, H = 180;
const PAD = { top: 12, right: 12, bottom: 22, left: 62 };

export function BacktestCurve({ days }: { days: readonly CurveDay[] }) {
  const [at, setAt] = useState<number | null>(null);
  const shown = days.filter((d) => d.n > 0);
  if (shown.length < 2) return null;
  const { cum, drop } = curveOf(shown);
  const values = [0, ...cum];
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const plotW = W - PAD.left - PAD.right, plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (i / (shown.length - 1)) * plotW;
  const y = (v: number) => PAD.top + ((hi - v) / span) * plotH;
  const last = cum[cum.length - 1]!;
  const tone = last > 0 ? 'var(--up)' : last < 0 ? 'var(--down)' : 'var(--muted)';
  const path = cum.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const ticks = [lo, (lo + hi) / 2, hi];
  const ends = [0, shown.length - 1];
  const best = shown.reduce((m, d) => (d.net > m.net ? d : m), shown[0]!);
  const worst = shown.reduce((m, d) => (d.net < m.net ? d : m), shown[0]!);
  const pick = (clientX: number, box: DOMRect) => {
    const px = ((clientX - box.left) / box.width) * W;
    setAt(Math.max(0, Math.min(shown.length - 1, Math.round(((px - PAD.left) / plotW) * (shown.length - 1)))));
  };
  const hover = at === null ? null : { d: shown[at]!, v: cum[at]! };

  return (
    <figure className="m-0 mt-3 grid gap-1.5" aria-label="Running total by expiry day">
      <figcaption className="text-[12px] font-medium text-muted-foreground">Running total, expiry day by expiry day</figcaption>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full touch-none select-none" role="img"
          aria-label={`Running total over ${shown.length} expiry days, ending ${moneyText(last)}`}
          onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerDown={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerLeave={() => setAt(null)}>
          {ticks.map((v, k) => (
            <g key={k}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--line-soft)" strokeWidth="1" />
              <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill="var(--dim)">{moneyText(v)}</text>
            </g>
          ))}
          <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 4" />
          <path d={path} fill="none" stroke={tone} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {hover ? (
            <>
              <line x1={x(at!)} x2={x(at!)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--muted)" strokeWidth="1" />
              <circle cx={x(at!)} cy={y(hover.v)} r="4" fill={tone} stroke="var(--panel)" strokeWidth="2" />
            </>
          ) : <circle cx={x(shown.length - 1)} cy={y(last)} r="3" fill={tone} />}
          {ends.map((i) => (
            <text key={i} x={x(i)} y={H - 6} fontSize="10" fill="var(--dim)" textAnchor={i === 0 ? 'start' : 'end'}>{dayLabel(shown[i]!.day)}</text>
          ))}
        </svg>
        {hover && (
          // Kept inside the chart's box: left of the line in its right half, right of it in its left half.
          <div role="status" className="pointer-events-none absolute top-1 rounded-md border border-solid border-border bg-[var(--panel)] px-2 py-1 text-[12px] leading-snug shadow-sm"
            style={at! > (shown.length - 1) / 2 ? { right: `${100 - (x(at!) / W) * 100 + 1}%` } : { left: `${(x(at!) / W) * 100 + 1}%` }}>
            <span className="block font-medium text-foreground">{dayLabel(hover.d.day)}{hover.d.live ? ' · so far' : ''}</span>
            <span className="block tabular-nums text-muted-foreground">That day {moneyText(hover.d.net)} · {count(hover.d.n)} trade{hover.d.n === 1 ? '' : 's'}</span>
            <span className="block tabular-nums text-foreground">Running total {moneyText(hover.v)}</span>
          </div>
        )}
      </div>
      <p className="m-0 text-[12px] leading-snug text-muted-foreground">
        Best day <span className="tabular-nums text-foreground">{dayLabel(best.day)} {moneyText(best.net)}</span>
        {' '}· worst day <span className="tabular-nums text-foreground">{dayLabel(worst.day)} {moneyText(worst.net)}</span>
        {drop && <> · worst fall from a high <span className="tabular-nums text-foreground">{moneyText(-drop.usd)}</span> ({drop.from ? dayLabel(drop.from) : 'the start'} → {dayLabel(drop.to)})</>}
      </p>
    </figure>
  );
}
