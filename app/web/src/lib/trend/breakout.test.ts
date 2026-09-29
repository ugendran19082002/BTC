import { describe, expect, it } from 'vitest';
import { runTrend, trendFeeR, trendR, trendStop, type TrendBar } from './breakout';

const bar = (i: number, close: number, spread = 10): TrendBar => ({ time: i * 3600, open: close, high: close + spread, low: close - spread, close });
/** 30 flat candles, then a breakout and a run up, then a fall. */
const series = (): TrendBar[] => [
  ...Array.from({ length: 30 }, (_, i) => bar(i, 100)),
  ...Array.from({ length: 10 }, (_, i) => bar(30 + i, 120 + i * 20)),
  ...Array.from({ length: 10 }, (_, i) => bar(40 + i, 300 - i * 40)),
];

describe('the trend plan', () => {
  it('[critical] enters on a close beyond the 20-candle channel, the stop 2 ATR away', () => {
    const st = runTrend(series());
    const t = st.trades[0]!;
    expect(t.dir).toBe(1);
    expect(t.at).toBe(30);
    expect(t.entry).toBe(120);
    expect(st.upper[30]).toBe(110);
    expect(t.stop0).toBeCloseTo(120 - 2 * st.atr[30]!, 9);
  });

  it('[critical] the stop trails 3 ATR under the best price and never loosens; out at the stop', () => {
    const st = runTrend(series());
    const t = st.trades[0]!;
    const stops = t.trail.map((x) => x.stop);
    for (let k = 1; k < stops.length; k++) expect(stops[k]!).toBeGreaterThanOrEqual(stops[k - 1]!);
    expect(t.exitAt).not.toBeNull();
    expect(t.exit).toBeLessThanOrEqual(t.trail[t.trail.length - 2]!.stop + 1e-9);
    expect(trendR(t)!).toBeGreaterThan(0);
    expect(trendFeeR(t, 0.0005)).toBeGreaterThan(0);
  });

  it('[critical] no lookahead: the history at every candle is the same whether the replay stopped there or ran on', () => {
    const bars = series();
    const full = runTrend(bars);
    for (let n = 1; n <= bars.length; n++) {
      const part = runTrend(bars.slice(0, n));
      for (const t of part.trades) {
        const same = full.trades.find((x) => x.at === t.at)!;
        expect(same.entry).toBe(t.entry);
        expect(same.stop0).toBe(t.stop0);
        expect(same.trail.slice(0, t.trail.length)).toEqual(t.trail);
        if (t.exitAt !== null) expect([same.exitAt, same.exit]).toEqual([t.exitAt, t.exit]);
      }
      expect(part.upper).toEqual(full.upper.slice(0, n));
    }
  });

  it('one position at a time, and a gap through the stop fills at the open', () => {
    const bars = series();
    bars[45] = { time: 45 * 3600, open: 50, high: 55, low: 40, close: 45 };
    const st = runTrend(bars);
    const t = st.trades[0]!;
    expect(st.trades.filter((x) => x.exitAt === null).length).toBeLessThanOrEqual(1);
    if (t.exitAt === 45) expect(t.exit).toBe(50);
    expect(trendStop(t)).toBe(t.trail[t.trail.length - 1]!.stop);
  });
});
