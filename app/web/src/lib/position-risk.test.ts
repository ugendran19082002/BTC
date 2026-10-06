import { describe, expect, it } from 'vitest';
import type { Trade, TradeStatus } from '@/types/trade';
import { lossBudget, positionRisk, settlementOf } from '@/lib/position-risk';

const trade = (over: Partial<Trade> = {}): Trade => ({
  tradeId: 't1',
  symbol: 'C-BTC-80000-080926',
  productId: 1,
  optionSide: 'CE',
  phase: 'protected',
  position: -100,
  requestedSize: 100,
  entrySize: 100,
  entryAvgPrice: 10.5,
  exitSize: 0,
  exitAvgPrice: null,
  protection: { takeProfit: 'tp', stopLoss: 'sl' },
  realisedPnl: 0,
  fills: [],
  note: null,
  alarm: null,
  updatedAt: Date.now(),
  plan: { lots: 100, entry: { type: 'limit', timeoutMs: 5000, marketFallback: false }, takeProfitPrice: 0.5, stopPrice: 26 },
  onBook: { target: 0.5, stop: 26 },
  live: { markPrice: 8, bid: 7.5, ask: 8.5, unrealisedPnl: 0.25, decayed: 0.24, liquidationPrice: 300 },
  ifExits: { target: 0.9, stop: -1.6 },
  ...over,
});

describe('settlementOf', () => {
  it('reads the date from the symbol and settles at 17:30 IST', () => {
    expect(new Date(settlementOf('C-BTC-80000-080926')!).toISOString()).toBe('2026-09-08T12:00:00.000Z');
  });
  it('is null for anything that is not a dated BTC option', () => {
    expect(settlementOf('BTCUSD')).toBeNull();
  });
});

describe('positionRisk: a short', () => {
  it('measures the stop and the target from the offer, where buying back happens', () => {
    const r = positionRisk(trade());
    expect(r.long).toBe(false);
    expect(r.exitPx).toBe(8.5);
    expect(r.stop).toMatchObject({ level: 26, points: 17.5, moneyUsd: -1.6 });
    expect(r.target).toMatchObject({ level: 0.5, points: 8, moneyUsd: 0.9 });
  });

  it('reads the levels resting at Delta before the plan', () => {
    const r = positionRisk(trade({ onBook: { target: 1, stop: 20 } }));
    expect(r.stop!.level).toBe(20);
    expect(r.target!.level).toBe(1);
  });

  it('says how far liquidation is, as points and as a multiple of the price now', () => {
    expect(positionRisk(trade()).liquidation).toEqual({ level: 300, points: 292, multiple: 37.5 });
  });

  it('[critical] shouts when nothing stops the position', () => {
    const r = positionRisk(trade({ onBook: { target: 0.5, stop: null }, plan: { ...trade().plan!, stopPrice: null } }));
    expect(r.stop).toBeNull();
    expect(r.problems).toContain('No stop behind this position.');
  });

  it('a signal trade stopped on the perp is not "no stop", and its perp room is measured from the mark', () => {
    const r = positionRisk(
      trade({ onBook: null, plan: { ...trade().plan!, stopPrice: null, underlying: { dir: 1, stop: 62_000, target: 63_500, source: 'signal' } } }),
      { perpMark: 62_400 },
    );
    expect(r.problems).not.toContain('No stop behind this position.');
    expect(r.perp).toMatchObject({ toStop: 400, toTarget: 1_100 });
  });

  it('carries the desk\'s alarms, the exchange\'s refusals and the plan\'s exit problem', () => {
    const r = positionRisk(trade({ protectionProblem: 'price out of band' }), { alarms: [{ tradeId: 't1', message: 'Unprotected for 30 s', at: 0 }] });
    expect(r.problems).toEqual(['Unprotected for 30 s', 'The exchange would not take an exit: price out of band']);
  });
});

describe('positionRisk: a long', () => {
  it('measures from the bid, its stop under and its target over, and has no liquidation', () => {
    const r = positionRisk(trade({
      position: 50,
      plan: { ...trade().plan!, action: 'buy', longExits: { target: { mode: 'pct', value: 0.5 }, stop: { mode: 'points', value: 4 } } },
      onBook: null,
      ifExits: null,
    }));
    expect(r.long).toBe(true);
    expect(r.exitPx).toBe(7.5);
    // entry 10.5: target 15.75 (+50%), stop 6.5 (-4 points)
    expect(r.target).toMatchObject({ level: 15.75, points: 8.25 });
    expect(r.stop).toMatchObject({ level: 6.5, points: 1 });
    expect(r.liquidation).toBeNull();
    expect(r.problems).toEqual([]);
  });
});

describe('lossBudget', () => {
  const status = (over: Partial<TradeStatus>): TradeStatus => ({
    mode: 'live', live: true, canGoLive: true, switchBlockedBy: null, balanceUsd: 100, positions: [], open: [], alarms: [],
    limits: { maxLeverage: 200, maxQuoteAgeMs: 0, maxSpreadPct: 0, minBookCoverage: 0, maxShortContracts: 0, maxDailyLossUsd: 25, minPremiumUsd: 0, allowPyramiding: false },
    ...over,
  });

  it('is the limit less what has been booked as a loss today, as the gate counts it', () => {
    expect(lossBudget(status({ realisedTodayUsd: -10 }))).toEqual({ limitUsd: 25, leftUsd: 15, usedPct: 0.4 });
    expect(lossBudget(status({ realisedTodayUsd: 5 }))).toEqual({ limitUsd: 25, leftUsd: 25, usedPct: 0 });
  });

  it('uses the accounts added together on "All accounts"', () => {
    expect(lossBudget(status({ combined: { accounts: [], lossLimitUsd: 50, lossLeftUsd: 40 } }))).toEqual({ limitUsd: 50, leftUsd: 40, usedPct: 0.2 });
  });
});
