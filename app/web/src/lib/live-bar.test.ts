import { describe, it, expect } from 'vitest';
import { withLtp, withLiveBar, isForming, barAgeSec, TF_SECONDS } from './live-bar';
import type { Candle } from '@/types/desk';

const bar = (time: number, over: Partial<Candle> = {}): Candle => ({
  time, open: 84_000, high: 84_100, low: 83_900, close: 84_050, volume: 10, ...over,
});

// A 5-minute bar opening at a clean boundary, and a moment two minutes into it.
const OPEN = 1_790_000_100 - (1_790_000_100 % 300);
const MID = (OPEN + 120) * 1000;
const AFTER = (OPEN + 300) * 1000;

describe('whether a bar is still forming', () => {
  it('[critical] a bar whose period contains now is forming; one that has closed is not', () => {
    expect(isForming(bar(OPEN), 300, MID)).toBe(true);
    expect(isForming(bar(OPEN), 300, AFTER)).toBe(false);
  });

  it('the instant the period ends, the bar is closed', () => {
    expect(isForming(bar(OPEN), 300, (OPEN + 299) * 1000)).toBe(true);
    expect(isForming(bar(OPEN), 300, (OPEN + 300) * 1000)).toBe(false);
  });

  it('a bar from the future is not forming', () => {
    expect(isForming(bar(OPEN + 600), 300, MID)).toBe(false);
  });
});

describe('carrying the forming bar to the last traded price', () => {
  it('[critical] the close becomes the tick', () => {
    const out = withLtp([bar(OPEN)], 84_400, 300, MID);
    expect(out[0]!.close).toBe(84_400);
  });

  it('[critical] high and low stretch to include the tick', () => {
    const up = withLtp([bar(OPEN)], 84_500, 300, MID);
    expect(up[0]!.high).toBe(84_500);
    expect(up[0]!.low).toBe(83_900);
    const down = withLtp([bar(OPEN)], 83_500, 300, MID);
    expect(down[0]!.low).toBe(83_500);
    expect(down[0]!.high).toBe(84_100);
  });

  it('[critical] open and volume are never touched — the open is history and the volume is unknown', () => {
    const out = withLtp([bar(OPEN)], 84_400, 300, MID);
    expect(out[0]!.open).toBe(84_000);
    expect(out[0]!.volume).toBe(10);
  });

  it('[critical] a tick inside the existing range still moves the close', () => {
    const out = withLtp([bar(OPEN)], 84_000, 300, MID);
    expect(out[0]!.close).toBe(84_000);
    expect(out[0]!.high).toBe(84_100);
    expect(out[0]!.low).toBe(83_900);
  });

  it('[critical] a closed newest bar is left alone — a bar is never invented', () => {
    const bars = [bar(OPEN)];
    const out = withLtp(bars, 84_400, 300, AFTER);
    expect(out).toBe(bars);
    expect(out).toHaveLength(1);
  });

  it('only the newest bar is touched', () => {
    const bars = [bar(OPEN - 300), bar(OPEN)];
    const out = withLtp(bars, 84_400, 300, MID);
    expect(out[0]).toBe(bars[0]);
    expect(out[1]!.close).toBe(84_400);
  });

  it('[critical] nothing changed means the same array back, so the chart does not redraw', () => {
    const bars = [bar(OPEN, { close: 84_050 })];
    expect(withLtp(bars, 84_050, 300, MID)).toBe(bars);
    expect(withLtp(bars, null, 300, MID)).toBe(bars);
    expect(withLtp(bars, undefined, 300, MID)).toBe(bars);
  });

  it('a nonsense price is ignored rather than drawn', () => {
    const bars = [bar(OPEN)];
    expect(withLtp(bars, 0, 300, MID)).toBe(bars);
    expect(withLtp(bars, -5, 300, MID)).toBe(bars);
    expect(withLtp(bars, Number.NaN, 300, MID)).toBe(bars);
    expect(withLtp(bars, Number.POSITIVE_INFINITY, 300, MID)).toBe(bars);
  });

  it('no bars is no bars', () => {
    expect(withLtp([], 84_000, 300, MID)).toEqual([]);
  });

  it('[critical] works on every chart timeframe', () => {
    for (const [tf, secs] of Object.entries(TF_SECONDS)) {
      const open = 1_790_000_000 - (1_790_000_000 % secs);
      const mid = (open + Math.floor(secs / 2)) * 1000;
      const out = withLtp([bar(open)], 84_321, secs, mid);
      expect(out[0]!.close, `${tf} did not take the tick`).toBe(84_321);
    }
  });
});

describe('how stale the newest bar is', () => {
  it('a forming bar has no age', () => {
    expect(barAgeSec([bar(OPEN)], 300, MID)).toBeNull();
  });

  it('[critical] a closed bar reports the seconds since it closed', () => {
    expect(barAgeSec([bar(OPEN)], 300, (OPEN + 300 + 45) * 1000)).toBe(45);
  });

  it('no bars has no age', () => {
    expect(barAgeSec([], 300, MID)).toBeNull();
  });
});

describe('the candle in progress from the tape', () => {
  const T = 1_790_000_100; // a 5m boundary
  const c = (time: number, o: number, h: number, l: number, cl: number, v: number) => ({ time, open: o, high: h, low: l, close: cl, volume: v });
  const bars = [c(T - 300, 100, 110, 90, 105, 50), c(T, 105, 108, 104, 106, 10)];
  const now = (T + 120) * 1000;

  it('[critical] widens the exchange\'s forming candle to the trades, closes at the last one, keeps the open', () => {
    const out = withLiveBar(bars, c(T, 999, 112, 103, 111, 25), 300, now);
    expect(out[1]).toEqual(c(T, 105, 112, 103, 111, 25));
    expect(out[0]).toBe(bars[0]);
  });

  it('keeps the exchange\'s volume when the socket saw less, and the same array when nothing changed', () => {
    expect(withLiveBar(bars, c(T, 105, 108, 104, 106, 3), 300, now)).toBe(bars);
  });

  it('[critical] adds the next candle when the exchange has not listed it yet', () => {
    const out = withLiveBar(bars, c(T + 300, 106, 107, 105, 107, 4), 300, (T + 330) * 1000);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual(c(T + 300, 106, 107, 105, 107, 4));
  });

  it('[critical] changes nothing with a candle that is over, older, or beyond the next', () => {
    expect(withLiveBar(bars, c(T, 105, 200, 1, 150, 99), 300, (T + 301) * 1000)).toBe(bars);
    expect(withLiveBar(bars, c(T - 300, 105, 200, 1, 150, 99), 300, (T - 10) * 1000)).toBe(bars);
    expect(withLiveBar(bars, c(T + 600, 105, 200, 1, 150, 99), 300, (T + 700) * 1000)).toBe(bars);
    expect(withLiveBar(bars, null, 300, now)).toBe(bars);
  });
});
