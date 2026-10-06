import { useEffect, useMemo, useRef, useState } from 'react';
import { FoldButton, useFold } from '@/components/ui/fold';
import { usePersisted } from '@/hooks/usePersisted';
import type { DayRow } from '@/types/report';
import { inr, signedInr, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The days, one bar each, and the running total over them (owner, 6 Oct 2026): what was booked -- a profit up
 * in green, a loss down in red -- with Delta's charges hanging under it in a milder red, and above the bars the
 * cumulative line they add up to.
 *
 * Two panels on one row of days, not one plot with two scales: a day is hundreds of rupees and the running total
 * thousands, and laying one over the other on a second axis lines the two up by accident. They share the days
 * instead, so a bar and the point of the line over it are the same day, and one readout names both.
 *
 * The bar it replaces rounded its scale up to the next ₹50,000, so a ₹5,000 day was a sliver; the scale here is
 * the data's own, to a round step.
 *
 * Colour says profit, loss and charge, and so does the place: profit is above the line, a loss below it, the
 * charge always the outer end with a gap before it -- for a reader who cannot tell the two reds apart.
 */
type Period = 'Daily' | 'Weekly' | 'Monthly';
export type PnlBucket = {
  key: string;
  /** Under the axis: "6 Oct", "W40", "Oct '26". */
  label: string;
  /** In the readout: "Tue, 6 Oct 2026", "Week to 2026-10-06", "October 2026". */
  title: string;
  /** Booked before charges, ₹: over zero a profit, under it a loss. */
  booked: number;
  /** Delta's fee and GST, ₹, as a positive number. */
  charges: number;
  net: number;
  /** The running total up to and including this bucket: of the net, or of the booked when charges are left out. */
  cumulative: number;
  trades: number;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateOf = (day: string) => new Date(`${day}T00:00:00Z`);
const dayLabel = (day: string) => { const d = dateOf(day); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const dayTitle = (day: string) => dateOf(day).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
/** ISO week, so a week that crosses a year's end is one week. */
function isoWeek(day: string): { year: number; week: number } {
  const d = dateOf(day);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return { year: d.getUTCFullYear(), week: Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7) };
}

/** The rows as bars: a day each, or added into weeks or months; the running total with or without charges. */
export function bucketsOf(rows: readonly DayRow[], period: Period, includeCharges = true): PnlBucket[] {
  const groups = new Map<string, { label: string; title: string; booked: number; charges: number; trades: number }>();
  for (const r of rows) {
    let key = r.day, label = dayLabel(r.day), title = dayTitle(r.day);
    if (period === 'Weekly') {
      const w = isoWeek(r.day);
      key = `${w.year}-W${String(w.week).padStart(2, '0')}`; label = `W${String(w.week).padStart(2, '0')}`; title = `Week to ${r.day}`;
    } else if (period === 'Monthly') {
      const d = dateOf(r.day);
      key = r.day.slice(0, 7); label = `${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(-2)}`;
      title = d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    }
    const g = groups.get(key) ?? { label, title, booked: 0, charges: 0, trades: 0 };
    g.booked += usdToInr(r.realisedUsd) ?? 0;
    g.charges += Math.max(0, usdToInr(r.chargesUsd) ?? 0);
    g.trades += r.trades || 0;
    g.title = title;                       // a week's title ends on its last day in the range
    groups.set(key, g);
  }
  let running = 0;
  return [...groups.entries()].map(([key, g]) => {
    const net = g.booked - g.charges;
    running += includeCharges ? net : g.booked;
    return { key, label: g.label, title: g.title, booked: g.booked, charges: g.charges, net, cumulative: running, trades: g.trades };
  });
}

/** Round steps from at or under `lo` to at or over `hi`, zero among them: 1, 2, 2.5 or 5 times a power of ten apart. */
export function niceTicks(lo: number, hi: number, about = 4): number[] {
  const min = Math.min(0, lo), max = Math.max(0, hi);
  const span = max - min || 1;
  const raw = span / about;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= Math.ceil(max / step) * step + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** An axis figure: ₹950, ₹1.5K, ₹12K, ₹1.2L -- short, because the bars and the readout carry the exact ones. */
export function compactInr(v: number): string {
  const a = Math.abs(v), sign = v < 0 ? '−' : '';
  const trim = (n: number) => String(Math.round(n * 10) / 10);
  if (a >= 100_000) return `${sign}₹${trim(a / 100_000)}L`;
  if (a >= 1_000) return `${sign}₹${trim(a / 1_000)}K`;
  return `${sign}₹${Math.round(a)}`;
}

/** A bar grown from `base` to `end`, its data end rounded and its base square. */
function barPath(x: number, w: number, base: number, end: number, round = true): string {
  const h = Math.abs(end - base);
  const r = round ? Math.min(4, w / 2, h) : 0;
  const s = end < base ? 1 : -1;            // +1: grows up the screen
  return `M${x},${base} V${end + s * r} Q${x},${end} ${x + r},${end} H${x + w - r} Q${x + w},${end} ${x + w},${end + s * r} V${base} Z`;
}

const PROFIT = 'var(--up)';
const LOSS = 'var(--down)';
const CHARGE = 'var(--charge)';
const LINE = 'var(--accent)';
/** The card's own ground, for the gap between stacked parts and the ring round the line's end. */
const SURFACE = 'var(--bg)';

export interface DailyPnlChartProps {
  rows: DayRow[];
  /** The running total after charges (the default), or before them -- the page's own switch. */
  includeCharges?: boolean;
}

export function DailyPnlChart({ rows, includeCharges = true }: DailyPnlChartProps) {
  const [open, setOpen] = useFold('pnl-daily');
  const [period, setPeriod] = usePersisted<Period>('report:daily-period', 'Daily');
  const [asTable, setAsTable] = usePersisted<boolean>('report:daily-table', false);
  const [at, setAt] = useState<number | null>(null);

  // Drawn in real pixels at the card's width, so a bar is never wider than 24px and text is never scaled.
  const wrap = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(720);
  const data = useMemo(() => bucketsOf(rows ?? [], period, includeCharges), [rows, period, includeCharges]);
  const n = data.length;
  // Measured once the plot is on the page -- it is not while the rows are still being read, or the table is shown.
  const plotted = open && !asTable && n > 0;
  useEffect(() => {
    const el = wrap.current;
    if (!plotted || !el) return undefined;
    const measure = () => { const w = Math.round(el.clientWidth); if (w > 0) setWidth(w); };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [plotted]);
  const total = data.reduce((s, d) => s + (includeCharges ? d.net : d.booked), 0);
  useEffect(() => { if (at !== null && at >= n) setAt(null); }, [at, n]);

  const narrow = width < 520;
  const padL = narrow ? 44 : 54;
  const padR = narrow ? 58 : 74;                       // room for the line's end label
  const topH = narrow ? 104 : 132;
  const botH = narrow ? 132 : 156;
  const topY = 18, gap = 34, botY = topY + topH + gap;
  const H = botY + botH + 24;
  const plotW = Math.max(40, width - padL - padR);
  const band = n ? plotW / n : plotW;
  const barW = Math.max(2, Math.min(24, band - 2));
  const cx = (i: number) => padL + band * (i + 0.5);

  // The line's own scale, and the bars' own: two panels, never two scales on one.
  const cumMax = Math.max(...data.map((d) => d.cumulative), 0);
  const cumMin = Math.min(...data.map((d) => d.cumulative), 0);
  // A dip of a few rupees under zero on the first day does not earn a whole band below the line.
  const cumTicks = niceTicks(cumMin > -0.04 * cumMax ? 0 : cumMin, cumMax, narrow ? 3 : 4);
  const cumLo = cumTicks[0] ?? 0, cumHi = cumTicks[cumTicks.length - 1] ?? 1;
  const yCum = (v: number) => topY + topH * (1 - (v - cumLo) / (cumHi - cumLo || 1));
  const up = Math.max(...data.map((d) => Math.max(0, d.booked)), 0);
  const down = Math.max(...data.map((d) => Math.max(0, -d.booked) + d.charges), 0);
  // A sixth of headroom at each end: the best and the worst day's figures are written past their bars.
  const barTicks = niceTicks(-down * 1.18, up * 1.18, narrow ? 3 : 4);
  const barLo = barTicks[0] ?? -1, barHi = barTicks[barTicks.length - 1] ?? 1;
  const yBar = (v: number) => botY + botH * (1 - (v - barLo) / (barHi - barLo || 1));
  const zero = yBar(0);

  const line = data.map((d, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)},${yCum(d.cumulative).toFixed(1)}`).join(' ');
  const area = n ? `${line} L${cx(n - 1).toFixed(1)},${yCum(0).toFixed(1)} L${cx(0).toFixed(1)},${yCum(0).toFixed(1)} Z` : '';
  const last = data[n - 1];
  // A date under every bar would collide: one about every 56px, and always the last.
  const every = Math.max(1, Math.ceil(56 / band));
  const labelled = (i: number) => i === n - 1 || (i % every === 0 && n - 1 - i >= every * 0.6);
  const best = n ? data.reduce((b, d, i) => (d.net > data[b]!.net ? i : b), 0) : -1;
  const worst = n ? data.reduce((b, d, i) => (d.net < data[b]!.net ? i : b), 0) : -1;
  const hovered = at !== null ? data[at] ?? null : null;

  const onKey = (e: React.KeyboardEvent) => {
    if (!n) return;
    const go = (i: number) => { e.preventDefault(); setAt(Math.max(0, Math.min(n - 1, i))); };
    if (e.key === 'ArrowRight') go((at ?? -1) + 1);
    else if (e.key === 'ArrowLeft') go((at ?? n) - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(n - 1);
    else if (e.key === 'Escape') setAt(null);
  };

  return (
    <div className="pnl-panel-card fold-host" data-folded={!open} role="region" aria-label="Daily P&L Chart">
      <div className="pnl-panel-header fold-head">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1"><FoldButton open={open} onToggle={() => setOpen(!open)} label="Daily P&L Chart" /><h2 className="pnl-panel-title m-0">Daily P&L</h2></span>
          <span className={cn('pnl-daily-badge', total < 0 && 'text-rose-400 bg-rose-500/10 border-rose-500/20')}>
            {includeCharges ? 'Net' : 'Gross'} {signedInr(total)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}
                  className="m-0 h-[30px] appearance-none rounded-md border border-solid border-border bg-transparent px-2.5 font-[inherit] text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground">
            {asTable ? 'Chart' : 'Table'}
          </button>
          <select className="pnl-select" aria-label="Period selector" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            <option value="Daily">Daily</option>
            <option value="Weekly">Weekly</option>
            <option value="Monthly">Monthly</option>
          </select>
        </div>
      </div>

      {n === 0 ? (
        <div className="pnl-empty">No trading days in selected date range.</div>
      ) : (
        <>
          {/* What each mark is. Text in the page's own ink; the mark beside it carries the colour. */}
          <ul aria-label="legend" className="m-0 mb-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[11.5px] text-muted-foreground">
            <li className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-0.5 w-4 rounded" style={{ background: LINE }} />Cumulative {includeCharges ? 'net' : 'gross'}</li>
            <li className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: PROFIT }} />Booked profit</li>
            <li className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: LOSS }} />Booked loss</li>
            <li className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: CHARGE }} />Charges</li>
          </ul>

          {asTable ? (
            <div className="max-h-[320px] overflow-auto rounded-md border border-solid border-border">
              <table aria-label="Daily P&L table" className="w-full border-collapse text-[12px] tabular-nums">
                <thead className="sticky top-0 bg-[var(--panel)] text-[11px] text-muted-foreground">
                  <tr>
                    {[period === 'Daily' ? 'Day' : period === 'Weekly' ? 'Week' : 'Month', 'Booked', 'Charges', 'Net', 'Cumulative', 'Trades'].map((h, i) => (
                      <th key={h} scope="col" className={cn('px-2 py-1.5 font-semibold', i === 0 ? 'text-left' : 'text-right')}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...data].reverse().map((d) => (
                    <tr key={d.key} className="border-0 border-t border-solid border-border">
                      <td className="whitespace-nowrap px-2 py-1 text-left font-[inherit]">{d.title}</td>
                      <td className={cn('px-2 py-1 text-right', d.booked > 0 ? 'text-[var(--up)]' : d.booked < 0 ? 'text-[var(--down)]' : '')}>{signedInr(d.booked)}</td>
                      <td className="px-2 py-1 text-right text-muted-foreground">{d.charges > 0 ? `−${inr(d.charges)}` : inr(0)}</td>
                      <td className={cn('px-2 py-1 text-right font-semibold', d.net > 0 ? 'text-[var(--up)]' : d.net < 0 ? 'text-[var(--down)]' : '')}>{signedInr(d.net)}</td>
                      <td className="px-2 py-1 text-right">{signedInr(d.cumulative)}</td>
                      <td className="px-2 py-1 text-right text-muted-foreground">{d.trades}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div
              ref={wrap} className="relative w-full select-none outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
              tabIndex={0} role="group" aria-label={`Daily P&L, ${n} ${period === 'Daily' ? 'days' : period === 'Weekly' ? 'weeks' : 'months'}. Left and right arrows read each one.`}
              onKeyDown={onKey} onPointerLeave={() => setAt(null)} onBlur={() => setAt(null)}
            >
              <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" aria-label="Cumulative line over daily bars" className="block">
                {/* Each panel named in its corner: two panels, each with its own scale. */}
                <text x={padL} y={topY - 6} fontSize={10.5} fill="var(--muted)" fontWeight={600}>CUMULATIVE {includeCharges ? 'NET' : 'GROSS'}</text>
                <text x={padL} y={botY - 8} fontSize={10.5} fill="var(--muted)" fontWeight={600}>BOOKED AND CHARGES, BY {period === 'Daily' ? 'DAY' : period === 'Weekly' ? 'WEEK' : 'MONTH'}</text>

                {cumTicks.map((t) => (
                  <g key={`c${t}`}>
                    <line x1={padL} x2={width - padR} y1={yCum(t)} y2={yCum(t)} stroke={t === 0 ? 'var(--panel-3)' : 'var(--line-soft)'} strokeWidth={1} />
                    <text x={padL - 6} y={yCum(t) + 3.5} fontSize={10} textAnchor="end" fill="var(--dim)" className="tabular-nums">{compactInr(t)}</text>
                  </g>
                ))}
                {barTicks.map((t) => (
                  <g key={`b${t}`}>
                    <line x1={padL} x2={width - padR} y1={yBar(t)} y2={yBar(t)} stroke={t === 0 ? 'var(--panel-3)' : 'var(--line-soft)'} strokeWidth={1} />
                    <text x={padL - 6} y={yBar(t) + 3.5} fontSize={10} textAnchor="end" fill="var(--dim)" className="tabular-nums">{compactInr(t)}</text>
                  </g>
                ))}

                {/* The day being read: one hairline through both panels. */}
                {at !== null && <line x1={cx(at)} x2={cx(at)} y1={topY} y2={botY + botH} stroke="var(--muted)" strokeWidth={1} opacity={0.55} />}

                {/* The running total. */}
                <path d={area} fill={LINE} opacity={0.1} />
                <path d={line} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {at !== null && hovered && <circle cx={cx(at)} cy={yCum(hovered.cumulative)} r={4} fill={LINE} stroke={SURFACE} strokeWidth={2} />}
                {last && (
                  <>
                    <circle cx={cx(n - 1)} cy={yCum(last.cumulative)} r={4} fill={LINE} stroke={SURFACE} strokeWidth={2} />
                    <text x={cx(n - 1) + 9} y={yCum(last.cumulative) + 4} fontSize={11.5} fontWeight={600} fill="var(--text)" className="tabular-nums">{signedInr(last.cumulative)}</text>
                  </>
                )}

                {/* The bars: booked from the zero line, the charge the outer end below it, a gap between the two. */}
                {data.map((d, i) => {
                  const x = cx(i) - barW / 2;
                  const dim = at !== null && at !== i ? 0.45 : 1;
                  const lossEnd = d.booked < 0 ? yBar(d.booked) : zero;
                  const chargeFrom = d.booked < 0 ? lossEnd + 2 : zero;
                  const chargeH = d.charges > 0 ? Math.max(1.5, yBar(-d.charges) - zero) : 0;
                  return (
                    <g key={d.key} opacity={dim}>
                      {d.booked > 0 && <path d={barPath(x, barW, zero, Math.min(zero - 1.5, yBar(d.booked)))} fill={PROFIT} />}
                      {d.booked < 0 && <path d={barPath(x, barW, zero, Math.max(zero + 1.5, lossEnd), chargeH === 0)} fill={LOSS} />}
                      {chargeH > 0 && <path d={barPath(x, barW, chargeFrom, chargeFrom + chargeH)} fill={CHARGE} />}
                    </g>
                  );
                })}

                {/* Only the best and the worst are written on the chart; every other figure is in the readout and the table. */}
                {n > 1 && best >= 0 && data[best]!.net > 0 && (
                  <text x={Math.max(padL + 22, Math.min(width - padR - 22, cx(best)))} y={yBar(Math.max(0, data[best]!.booked)) - 5} fontSize={10} textAnchor="middle" fill="var(--muted)" className="tabular-nums">
                    {signedInr(data[best]!.net)}
                  </text>
                )}
                {n > 1 && worst >= 0 && worst !== best && data[worst]!.net < 0 && (
                  <text x={Math.max(padL + 22, Math.min(width - padR - 22, cx(worst)))} y={yBar(Math.min(0, data[worst]!.booked) - data[worst]!.charges) + 13} fontSize={10} textAnchor="middle" fill="var(--muted)" className="tabular-nums">
                    {signedInr(data[worst]!.net)}
                  </text>
                )}

                {data.map((d, i) => (labelled(i) ? (
                  <text key={`x${d.key}`} x={cx(i)} y={H - 6} fontSize={10} textAnchor={i === n - 1 && cx(i) > width - padR - 14 ? 'end' : 'middle'} fill="var(--dim)">{d.label}</text>
                ) : null))}

                {/* A day's whole column answers the pointer -- not the few pixels of its bar. */}
                {data.map((d, i) => (
                  <rect key={`h${d.key}`} x={padL + band * i} y={topY} width={band} height={botY + botH - topY} fill="transparent"
                        onPointerEnter={() => setAt(i)} onPointerMove={() => setAt(i)} onPointerDown={() => setAt(i)} />
                ))}
              </svg>

              {hovered && at !== null && (
                <div role="status" aria-live="polite" className="pnl-tooltip-box absolute top-1 z-10 min-w-[178px]"
                     style={cx(at) > width / 2 ? { right: width - cx(at) + 12 } : { left: cx(at) + 12 }}>
                  <div className="mb-1 text-[11.5px] font-semibold text-foreground">{hovered.title}</div>
                  <Row k={<i className="inline-block h-0.5 w-3 rounded" style={{ background: hovered.booked < 0 ? LOSS : PROFIT }} />}
                       label={hovered.booked < 0 ? 'Booked loss' : 'Booked profit'} value={signedInr(hovered.booked)} />
                  <Row k={<i className="inline-block h-0.5 w-3 rounded" style={{ background: CHARGE }} />} label="Charges" value={hovered.charges > 0 ? `−${inr(hovered.charges)}` : inr(0)} />
                  <Row k={<i className="inline-block w-3" />} label="Net" value={signedInr(hovered.net)} strong />
                  <div className="my-1 h-px bg-border" />
                  <Row k={<i className="inline-block h-0.5 w-3 rounded" style={{ background: LINE }} />} label="Cumulative" value={signedInr(hovered.cumulative)} />
                  <Row k={<i className="inline-block w-3" />} label="Trades" value={String(hovered.trades)} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One line of the readout: a short stroke of the mark's colour, what it is, and the figure -- the figure the loud part. */
function Row({ k, label, value, strong = false }: { k: React.ReactNode; label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 text-[11.5px] leading-[1.55]">
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">{k}{label}</span>
      <span className={cn('tabular-nums text-foreground', strong ? 'font-bold' : 'font-semibold')}>{value}</span>
    </div>
  );
}
