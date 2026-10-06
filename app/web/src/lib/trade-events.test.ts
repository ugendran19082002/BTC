import { describe, expect, it } from 'vitest';
import type { Trade } from '@/types/trade';
import { isRunning, isWaiting, tradeEvents, tradeWords } from '@/lib/trade-events';

const trade = (over: Partial<Trade> = {}): Trade => ({
  tradeId: 't1', symbol: 'P-BTC-84600-071026', productId: 1, optionSide: 'PE', phase: 'protected',
  position: -500, requestedSize: 500, entrySize: 500, entryAvgPrice: 45.2, exitSize: 0, exitAvgPrice: null,
  protection: { takeProfit: 'tp', stopLoss: 'sl' }, realisedPnl: 0, fills: [], note: null, alarm: null, updatedAt: 0,
  ...over,
});
const waiting = (over: Partial<Trade> = {}) => trade({ phase: 'entry_pending', position: 0, entrySize: 0, entryAvgPrice: null, ...over });

describe('tradeEvents: what changed between two readings', () => {
  it('nothing changed, nothing said', () => {
    expect(tradeEvents([trade()], [trade()])).toEqual([]);
    expect(tradeEvents([], [])).toEqual([]);
  });

  it('[critical] an order begins waiting, then fills, then closes -- one event each', () => {
    expect(tradeEvents([], [waiting()]).map((e) => e.kind)).toEqual(['waiting']);
    expect(tradeEvents([waiting()], [trade()]).map((e) => e.kind)).toEqual(['filled']);
    const closed = tradeEvents([trade()], []);
    expect(closed.map((e) => e.kind)).toEqual(['closed']);
    expect(closed[0]!.trade.position).toBe(-500); // as it was while open, for the toast to describe
  });

  it('a fill between two readings is a fill, not a wait', () => {
    expect(tradeEvents([], [trade()]).map((e) => e.kind)).toEqual(['filled']);
  });

  it('a waiting order that goes without filling is "gone", not "closed"', () => {
    expect(tradeEvents([waiting()], []).map((e) => e.kind)).toEqual(['gone']);
  });

  it('a partial fill growing is not a second fill', () => {
    expect(tradeEvents([trade({ position: -200 })], [trade({ position: -500 })])).toEqual([]);
  });

  it('two accounts\' trades on one id are told apart', () => {
    const a = trade({ account: { id: 1, name: 'SELL' } });
    const b = trade({ account: { id: 2, name: 'BUY' } });
    expect(tradeEvents([a], [a, b]).map((e) => [e.kind, e.trade.account?.id])).toEqual([['filled', 2]]);
  });

  it('waiting and running are each one thing', () => {
    expect(isWaiting(waiting())).toBe(true);
    expect(isWaiting(trade())).toBe(false);
    expect(isRunning(trade())).toBe(true);
    // flat and done is neither
    expect(isWaiting(trade({ position: 0, phase: 'flat' }))).toBe(false);
  });

  it('words for a headline', () => {
    const label = (s: string) => s.split('-')[2] + ' ' + (s.startsWith('P') ? 'PE' : 'CE');
    expect(tradeWords(trade(), label)).toBe('SELL 84600 PE × 500');
    expect(tradeWords(waiting(), label)).toBe('SELL 84600 PE × 500');
  });
});
