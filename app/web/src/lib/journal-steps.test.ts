import { describe, expect, it } from 'vitest';
import type { Trade } from '@/types/trade';
import { journalSteps } from '@/lib/journal-steps';

const trade = (over: Partial<Trade> = {}): Trade => ({
  tradeId: 't1', symbol: 'C-BTC-80000-071026', productId: 1, optionSide: 'CE', phase: 'flat',
  position: 0, requestedSize: 100, entrySize: 100, entryAvgPrice: 20, exitSize: 100, exitAvgPrice: 2,
  protection: { takeProfit: null, stopLoss: null }, realisedPnl: 1.8, fills: [], note: null, alarm: null, updatedAt: 5_000,
  plan: {
    lots: 100, entry: { type: 'limit', timeoutMs: 5000, marketFallback: false }, takeProfitPrice: 2, stopPrice: 40,
    signal: { method: 'breakout', n: 1, name: 'Breakout', mode: 'single', tf: '5m', dir: -1, triggerTime: 500 },
  },
  ...over,
});

const EVENTS = [
  { t: 'protection_placed', takeProfit: 'tp', stopLoss: 'sl', size: 100, at: 3_000 },
  { t: 'entry_submitted', clientOrderId: 'c', size: 100, limitPrice: 20, quote: { bid: 19.5, ask: 20.5, mark: 20, at: 900 }, at: 1_000 },
  { t: 'fill', role: 'entry', side: 'sell', size: 100, price: 20, orderId: 'o1', perp: 62_000.4, at: 2_000 },
  { t: 'fill', role: 'take_profit', side: 'buy', size: 100, price: 2, orderId: 'o2', at: 4_000 },
  { t: 'sibling_cancelled', role: 'stop_loss', at: 4_100 },
];

describe('journalSteps', () => {
  it('[critical] tells the trade in order: signal, entry, fill, protection, exit, closed', () => {
    const steps = journalSteps(trade(), EVENTS);
    expect(steps.map((s) => s.stage)).toEqual(['signal', 'entry', 'fill', 'protection', 'exit', 'info', 'closed']);
    expect(steps[0]).toMatchObject({ title: 'Signal: #1 Breakout', detail: 'SELL · 5m · without it' });
    expect(steps[1]).toMatchObject({ title: 'Entry order sent: 100 contracts at 20.00', detail: 'Book then: bid 19.50 · ask 20.50' });
    expect(steps[2]).toMatchObject({ title: 'Sold 100 @ 20.00', detail: 'BTC perp at 62,000' });
    expect(steps[3]!.title).toBe('Target and stop placed at the exchange');
    expect(steps[4]!.title).toBe('Target filled: bought back 100 @ 2.00');
    expect(steps[5]!.title).toBe('The other exit (stop) was cancelled');
  });

  it('says what went wrong in the exchange\'s words', () => {
    const steps = journalSteps(trade({ position: -100, exitSize: 0 }), [
      { t: 'protection_failed', reason: 'price outside band', at: 1 },
      { t: 'entry_rejected', reason: 'insufficient margin', at: 2 },
    ]);
    expect(steps.filter((s) => s.stage === 'problem').map((s) => s.detail)).toEqual(['price outside band', 'insufficient margin']);
    expect(steps.some((s) => s.stage === 'closed')).toBe(false);
  });

  it('a trade with no signal starts with the strategy that placed it, or straight at the order', () => {
    const plan = trade().plan!;
    expect(journalSteps(trade({ plan: { ...plan, signal: null, strategyName: 'Evening CE' } }), EVENTS)[0]!.title).toBe('Placed by strategy “Evening CE”');
    expect(journalSteps(trade({ plan: { ...plan, signal: null } }), EVENTS)[0]!.stage).toBe('entry');
  });

  it('an event it does not know is still shown, in its own words', () => {
    expect(journalSteps(trade({ plan: undefined }), [{ t: 'something_new', at: 1 }])[0]!.title).toBe('something new');
  });
});
