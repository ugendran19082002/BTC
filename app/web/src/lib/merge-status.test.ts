import { describe, expect, it } from 'vitest';
import { mergeStatuses } from '@/lib/merge-status';
import type { Trade, TradeStatus } from '@/types/trade';

/** "All accounts" on Positions and P&L (5 Oct 2026): it showed the default account's alone. */
const status = (over: Partial<TradeStatus>): TradeStatus => ({
  mode: 'live', live: true, canGoLive: true, switchBlockedBy: null, balanceUsd: 0, positions: [], open: [], alarms: [],
  limits: { maxLeverage: 200, maxQuoteAgeMs: 3000, maxSpreadPct: 0.15, minBookCoverage: 0.5, maxShortContracts: 0, maxDailyLossUsd: 0, minPremiumUsd: 5, allowPyramiding: false },
  ...over,
});
const trade = (id: string, position: number): Trade => ({ tradeId: id, position } as unknown as Trade);

const sell = status({
  balanceUsd: 51.29, walletUsd: 75.47, marginUsedUsd: 24.18, unrealisedPnlUsd: 1.4, realisedTodayUsd: 6.35, lossTodayUsd: 2.25,
  today: { realisedUsd: 6.35, unrealisedUsd: 1.4, chargesUsd: 1.59, netUsd: 6.16, lossUsd: 2.25, profitUsd: 8.6 },
  open: [trade('s1', -5), trade('s2', -6)], positions: [{ symbol: 'P', size: -11 } as never],
  limits: { ...status({}).limits, maxShortContracts: 116, maxLongContracts: 500, maxDailyLossUsd: 25.65 },
});
const buy = status({
  balanceUsd: 2.35, walletUsd: 2.39, marginUsedUsd: 0.04, unrealisedPnlUsd: 0.005, realisedTodayUsd: -3,
  today: { realisedUsd: -3, unrealisedUsd: 0.005, chargesUsd: 0.002, netUsd: -2.997, lossUsd: 3, profitUsd: 0 },
  open: [trade('b1', 1)], positions: [{ symbol: 'C', size: 1 } as never],
  limits: { ...status({}).limits, maxShortContracts: 10, maxLongContracts: 500, maxDailyLossUsd: 1.18 },
});
const both = () => mergeStatuses([{ account: { id: 1, name: 'SELL' }, status: sell }, { account: { id: 2, name: 'BUY' }, status: buy }])!;

describe('several accounts as one', () => {
  it('[critical] the money and the day are sums; the positions are every account\'s, each tagged with whose it is', () => {
    const m = both();
    expect(m.walletUsd).toBeCloseTo(77.86);
    expect(m.balanceUsd).toBeCloseTo(53.64);
    expect(m.marginUsedUsd).toBeCloseTo(24.22);
    expect(m.unrealisedPnlUsd).toBeCloseTo(1.405);
    expect(m.today!.netUsd).toBeCloseTo(3.163);
    expect(m.today!.chargesUsd).toBeCloseTo(1.592);
    expect(m.today!.lossUsd).toBeCloseTo(5.25);
    expect(m.open.map((t) => [t.tradeId, t.account?.name])).toEqual([['s1', 'SELL'], ['s2', 'SELL'], ['b1', 'BUY']]);
    expect(m.positions).toHaveLength(2);
    expect([m.limits.maxShortContracts, m.limits.maxLongContracts]).toEqual([126, 1000]);
    expect(m.room).toBeUndefined();
  });

  it('[critical] the loss budget left is each account\'s own, added: one at its limit does not use up the other\'s', () => {
    const m = both();
    // SELL has booked a gain, so all of its 25.65 is left; BUY has lost 3 against a 1.18 limit, so none of its is.
    expect(m.combined!.lossLimitUsd).toBeCloseTo(26.83);
    expect(m.combined!.lossLeftUsd).toBeCloseTo(25.65);
    expect(m.combined!.accounts).toEqual([
      { id: 1, name: 'SELL', totalUsd: 75.47, availableUsd: 51.29, openPnlUsd: 1.4, netTodayUsd: 6.16, positions: 2 },
      { id: 2, name: 'BUY', totalUsd: 2.39, availableUsd: 2.35, openPnlUsd: 0.005, netTodayUsd: -2.997, positions: 1 },
    ]);
  });

  it('a figure one account cannot give is left out of the total rather than counted as nothing', () => {
    const m = mergeStatuses([{ account: { id: 1, name: 'A' }, status: sell }, { account: { id: 2, name: 'B' }, status: { ...buy, walletUsd: null } }])!;
    expect(m.walletUsd).toBeNull();
    expect(mergeStatuses([])).toBeNull();
  });
});
