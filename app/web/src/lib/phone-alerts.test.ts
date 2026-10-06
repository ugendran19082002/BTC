import { describe, expect, it } from 'vitest';
import type { Trade, TradeStatus } from '@/types/trade';
import type { Glance } from '@/api/glance';
import { phoneAlerts } from '@/lib/phone-alerts';

const trade = (over: Partial<Trade> = {}): Trade => ({
  tradeId: 't1', symbol: 'P-BTC-84600-071026', productId: 1, optionSide: 'PE', phase: 'protected',
  position: -100, requestedSize: 100, entrySize: 100, entryAvgPrice: 45, exitSize: 0, exitAvgPrice: null,
  protection: { takeProfit: 'tp', stopLoss: 'sl' }, realisedPnl: 0, fills: [], note: null, alarm: null, updatedAt: 0,
  plan: { lots: 100, entry: { type: 'limit', timeoutMs: 5000, marketFallback: false }, takeProfitPrice: 10, stopPrice: 62 },
  onBook: { target: 10, stop: 62 },
  live: { markPrice: 40, bid: 39.5, ask: 40.5, unrealisedPnl: 0.5, decayed: 0.1, liquidationPrice: 400 },
  ...over,
});

const status = (open: Trade[], over: Partial<TradeStatus> = {}): TradeStatus => ({
  mode: 'live', live: true, canGoLive: true, switchBlockedBy: null, balanceUsd: 100, positions: [], open, alarms: [],
  realisedTodayUsd: 0, walletUsd: 100, marginUsedUsd: 20,
  limits: { maxLeverage: 200, maxQuoteAgeMs: 0, maxSpreadPct: 0, minBookCoverage: 0, maxShortContracts: 0, maxDailyLossUsd: 25, minPremiumUsd: 0, allowPyramiding: false },
  ...over,
});

describe('phoneAlerts', () => {
  it('a calm desk has nothing to say', () => {
    expect(phoneAlerts(status([trade()]), null)).toEqual([]);
  });

  it('[critical] a stop close by is red, and names the position', () => {
    // offer 58, stop 62: 4 points, 6.9% of the price
    const a = phoneAlerts(status([trade({ live: { markPrice: 57.5, bid: 57, ask: 58, unrealisedPnl: -1, decayed: -0.3, liquidationPrice: 400 } })]), null);
    expect(a[0]).toMatchObject({ level: 'red', title: 'Near the stop: 6.9% away', detail: '84,600 PE SELL', tradeId: 't1' });
  });

  it('a target nearly reached is good news, after the warnings', () => {
    const a = phoneAlerts(status([trade({ live: { markPrice: 10.6, bid: 10.5, ask: 10.8, unrealisedPnl: 3, decayed: 0.7, liquidationPrice: 400 } })], { marginUsedUsd: 75 }), null);
    expect(a.map((x) => x.level)).toEqual(['amber', 'green']);
    expect(a[1]!.title).toBe('Close to the target: 7.4% to go');
    expect(a[0]!.title).toBe('75% of the wallet in margin');
  });

  it('wide spreads, the loss limit and liquidation each have their say', () => {
    const wide = trade({ live: { markPrice: 40, bid: 35, ask: 45, unrealisedPnl: 0, decayed: 0, liquidationPrice: 100 } });
    const titles = phoneAlerts(status([wide], { realisedTodayUsd: -21 }), null).map((x) => x.title);
    expect(titles).toContain('Liquidation at 2.5× the price now');
    expect(titles).toContain('84% of the daily loss limit used');
    expect(titles).toContain('Wide spread: 25%');
  });

  it('the desk\'s own health comes first when it is down', () => {
    const glance = { issues: [{ level: 'down', text: 'Option prices stopped 90 s ago.' }] } as unknown as Glance;
    expect(phoneAlerts(status([]), glance)).toEqual([{ level: 'red', title: 'Option prices stopped 90 s ago.' }]);
  });

  it('[critical] two trades on one contract are told apart by strategy, and an alert said twice is said once (the live phone, 6 Oct 2026)', () => {
    const wide = { markPrice: 40, bid: 35, ask: 45, unrealisedPnl: 0, decayed: 0, liquidationPrice: 400 };
    const plan = trade().plan!;
    const twins = phoneAlerts(status([trade({ tradeId: 'a', live: wide }), trade({ tradeId: 'b', live: wide })]), null).filter((x) => x.title.startsWith('Wide spread'));
    expect(twins).toHaveLength(1);
    const apart = phoneAlerts(status([
      trade({ tradeId: 'a', live: wide, plan: { ...plan, strategyName: 'Evening sell' } }),
      trade({ tradeId: 'b', live: wide, plan: { ...plan, strategyName: 'Breakout PE' } }),
    ]), null).filter((x) => x.title.startsWith('Wide spread'));
    expect(apart.map((x) => x.detail)).toEqual([
      '84,600 PE SELL · Evening sell — closing costs more than the mark says',
      '84,600 PE SELL · Breakout PE — closing costs more than the mark says',
    ]);
  });
});
