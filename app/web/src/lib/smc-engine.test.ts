import { describe, expect, it } from 'vitest';
import { analyzeSmc } from './smc-engine';
import type { Candle } from '@/types/desk';

describe('smc-engine', () => {
  const baseTime = 1_700_000_000;


  it('handles empty or too few bars gracefully', () => {
    const res = analyzeSmc([], 70_000, '15m', 'UP');
    expect(res.swings).toHaveLength(0);
    expect(res.breaks).toHaveLength(0);
    expect(res.tradePlan).toBeNull();
  });

  it('detects Fair Value Gaps (Bullish and Bearish FVG)', () => {
    // Bullish FVG: Bar 0 High < Bar 2 Low (Bar 1 is strong expansion)
    const candles: Candle[] = [];
    let p = 70_000;
    for (let i = 0; i < 15; i++) {
      candles.push({ time: baseTime + i * 300, open: p, high: p + 30, low: p - 30, close: p + 10, volume: 100 });
      p += 10;
    }
    // Bar 12: low 70150, high 70190
    candles[12] = { time: baseTime + 12 * 300, open: 70_150, high: 70_190, low: 70_140, close: 70_180, volume: 100 };
    // Bar 13: huge expansion from 70180 to 70400 (high 70420)
    candles[13] = { time: baseTime + 13 * 300, open: 70_180, high: 70_420, low: 70_175, close: 70_400, volume: 500 };
    // Bar 14: open 70400, low 70280 (> 70190), high 70450, close 70440
    candles[14] = { time: baseTime + 14 * 300, open: 70_400, high: 70_450, low: 70_280, close: 70_440, volume: 200 };

    const res = analyzeSmc(candles, 70_440, '5m', 'UP');
    const bullFvg = res.fvgs.find((f) => f.type === 'bull');
    expect(bullFvg).toBeDefined();
    expect(bullFvg?.priceLow).toBe(70_190);
    expect(bullFvg?.priceHigh).toBe(70_280);
  });

  it('detects Bullish Order Blocks (OB↑) before strong displacement', () => {
    const candles: Candle[] = [];
    let p = 70_000;
    for (let i = 0; i < 20; i++) {
      candles.push({ time: baseTime + i * 300, open: p, high: p + 40, low: p - 40, close: p + 5, volume: 100 });
      p += 5;
    }
    // Bar 17: Red candle (OB origin)
    candles[17] = { time: baseTime + 17 * 300, open: 70_120, high: 70_130, low: 70_080, close: 70_090, volume: 150 };
    // Bar 18: Big green impulse
    candles[18] = { time: baseTime + 18 * 300, open: 70_095, high: 70_380, low: 70_090, close: 70_360, volume: 600 };
    // Bar 19: continuation
    candles[19] = { time: baseTime + 19 * 300, open: 70_360, high: 70_420, low: 70_340, close: 70_400, volume: 200 };

    const res = analyzeSmc(candles, 70_400, '15m', 'UP');
    const bullOb = res.orderBlocks.find((o) => o.type === 'bull');
    expect(bullOb).toBeDefined();
    expect(bullOb?.priceLow).toBe(70_080);
    expect(bullOb?.priceHigh).toBe(70_130);
  });

  it('calculates optimal Auto Trade Plan with Red Stop Loss and Green Targets', () => {
    const candles: Candle[] = [];
    let p = 75_000;
    for (let i = 0; i < 25; i++) {
      const up = i % 2 === 0;
      candles.push({
        time: baseTime + i * 300,
        open: p,
        high: p + (up ? 60 : 20),
        low: p - (up ? 20 : 60),
        close: p + (up ? 40 : -40),
        volume: 120,
      });
      p += 30; // overall uptrend
    }

    const spot = candles[candles.length - 1]!.close;
    const res = analyzeSmc(candles, spot, '15m', 'UP');

    expect(res.tradePlan).not.toBeNull();
    const plan = res.tradePlan!;
    expect(plan.direction).toBe('LONG');
    expect(plan.entry).toBe(Math.round(spot));
    expect(plan.sl.price).toBeLessThan(plan.entry);
    expect(plan.tp1.price).toBeGreaterThan(plan.entry);
    expect(plan.tp2.price).toBeGreaterThan(plan.tp1.price);
    expect(plan.riskReward).toContain('1 :');
  });

  it('identifies Buy-Side (BSL) and Sell-Side (SSL) Liquidity levels', () => {
    const candles: Candle[] = [];
    let p = 72_000;
    for (let i = 0; i < 30; i++) {
      candles.push({ time: baseTime + i * 300, open: p, high: p + 50, low: p - 50, close: p + 10, volume: 100 });
      p += (i % 3 === 0 ? 40 : -20);
    }
    // High spike
    candles[10] = { time: baseTime + 10 * 300, open: 72_200, high: 73_100, low: 72_150, close: 72_300, volume: 400 };
    // Low spike
    candles[20] = { time: baseTime + 20 * 300, open: 72_100, high: 72_150, low: 71_300, close: 71_900, volume: 400 };

    const res = analyzeSmc(candles, 72_250, '15m', 'RANGE');
    const bsl = res.liquidity.find((l) => l.type === 'BSL');
    const ssl = res.liquidity.find((l) => l.type === 'SSL');

    expect(bsl).toBeDefined();
    expect(bsl?.price).toBeGreaterThanOrEqual(73_000);
    expect(ssl).toBeDefined();
    expect(ssl?.price).toBeLessThanOrEqual(71_500);
  });
});
