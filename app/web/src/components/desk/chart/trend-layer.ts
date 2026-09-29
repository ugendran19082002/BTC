import type { Bar } from '@/lib/smc/types';
import { trendR, trendStop, type TrendState, type TrendTrade } from '@/lib/trend/breakout';
import type { SceneItem } from './scene';

/**
 * The trend plan (lib/trend/breakout.ts, on 1H candles) drawn on the chart's
 * own candles: its 20-candle channel as a faint step line, the open trade's
 * entry, initial stop and trailing stop, and finished trades faint. Lines
 * only, in lime -- never a box, so it cannot be mistaken for the SMC plan's
 * position box. Everything is placed by time: a 1H value holds from the close
 * that made it until the next.
 */
const TREND = '#a3e635';
const TREND_FAINT = 'rgba(163,230,53,0.35)';
const fmt = (p: number) => Math.round(p).toLocaleString('en-US');
const R = (r: number) => `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}R`;

export function trendScene(st: TrendState, hBars: readonly Bar[], hSec: number, bars: readonly Bar[]): SceneItem[] {
  if (!bars.length || !hBars.length) return [];
  const first = bars[0]!.time;
  const lastIdx = bars.length - 1;
  /** The chart candle a time falls in, or null before the chart starts. */
  const xAt = (t: number): number | null => {
    if (t < first) return null;
    let lo = 0; let hi = lastIdx;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bars[mid]!.time <= t) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const closeOf = (j: number) => hBars[j]!.time + hSec;
  const out: SceneItem[] = [];

  // The channel: the value in force at each 1H close, held until the next close.
  for (const series of [st.upper, st.lower]) {
    const points: [number, number][] = [];
    for (let j = 0; j < hBars.length; j++) {
      const v = series[j];
      if (v === null || v === undefined) continue;
      const from = xAt(hBars[j]!.time);
      const to = xAt(closeOf(j));
      if (from === null || to === null) continue;
      points.push([from, v], [to, v]);
    }
    if (points.length) out.push({ t: 'path', layer: 'trend', points, color: TREND_FAINT, priority: 20 });
  }

  const mark = bars[lastIdx]!.close;
  for (const t of st.trades) {
    const x0 = xAt(closeOf(t.at));
    if (x0 === null && t.exitAt !== null && closeOf(t.exitAt) < first) continue;
    const from = x0 ?? 0;
    const side = t.dir === 1 ? 'LONG' : 'SHORT';
    if (t.exitAt === null) out.push(...openTrade(t, from, side, mark, xAt, closeOf));
    else {
      const to = xAt(closeOf(t.exitAt)) ?? from;
      const r = trendR(t)!;
      out.push({ t: 'line', layer: 'trend', x1: from, x2: Math.max(to, from + 1), y: t.entry, color: TREND_FAINT, label: `Trend ${side.toLowerCase()} ${R(r)}`, labelAt: 'mid', labelSide: t.dir === 1 ? 'below' : 'above', priority: 30, faint: true });
    }
  }
  return out;
}

function openTrade(t: TrendTrade, from: number, side: string, mark: number, xAt: (t: number) => number | null, closeOf: (j: number) => number): SceneItem[] {
  const stop = trendStop(t);
  const locked = (t.dir * (stop - t.entry)) / t.risk;
  const out: SceneItem[] = [
    { t: 'line', layer: 'trend', x1: from, x2: 'right', y: t.entry, color: TREND, width: 1.5,
      label: `TREND ${side} ${fmt(t.entry)} · 1H breakout · ${R(trendR(t, mark)!)} open`, labelAt: 'end', labelSide: t.dir === 1 ? 'above' : 'below', priority: 86 },
    { t: 'line', layer: 'trend', x1: from, x2: 'right', y: t.stop0, color: TREND_FAINT, dash: 'dot', faint: true,
      label: `Trend stop ${fmt(t.stop0)} · 2 ATR`, labelAt: 'end', labelSide: t.dir === 1 ? 'below' : 'above', priority: 40 },
  ];
  // The trail as it stepped, close by close, then its level now to the right edge.
  const points: [number, number][] = [];
  for (let k = 0; k < t.trail.length; k++) {
    const x = xAt(closeOf(t.trail[k]!.at));
    if (x !== null) points.push([x, t.trail[k]!.stop]);
  }
  if (points.length > 1) out.push({ t: 'path', layer: 'trend', points, color: TREND, priority: 20 });
  out.push({ t: 'line', layer: 'trend', x1: points[points.length - 1]?.[0] ?? from, x2: 'right', y: stop, color: TREND, dash: 'dash',
    label: `Trend trail ${fmt(stop)} · ${locked >= 0 ? `locks ${R(locked)}` : `risk ${R(locked)}`}`, labelAt: 'end', labelSide: t.dir === 1 ? 'below' : 'above', priority: 84 });
  return out;
}
