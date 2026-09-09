import { describe, expect, it } from 'vitest';
import { heldKey, heldLegs } from '@/lib/held';
import type { Trade } from '@/types/trade';

const t = (over: Partial<Trade> = {}): Trade => ({
  tradeId: 't', symbol: 'C-BTC-79600-090926', productId: 1, optionSide: 'CE',
  phase: 'protected', position: -1, requestedSize: 1, entrySize: 1, entryAvgPrice: 16,
  exitSize: 0, exitAvgPrice: null, protection: { takeProfit: null, stopLoss: null },
  realisedPnl: 0, fills: [], note: null, alarm: null, updatedAt: 0,
  live: { markPrice: 14, unrealisedPnl: 0.002, decayed: 0.1, liquidationPrice: null },
  ...over,
}) as Trade;

describe('the strikes you are short', () => {
  it('keys a position the way the board looks it up', () => {
    const held = heldLegs([t()]);
    expect(held.get(heldKey('C', 79_600))).toMatchObject({ cp: 'C', strike: 79_600, size: 1 });
  });

  it('reports size as a plain count, not as a negative', () => {
    // the board says "short 3", and a −3 in a chip reads as a loss
    expect(heldLegs([t({ position: -3 })]).get('C-79600')!.size).toBe(3);
  });

  it('tells a put from a call at the same strike', () => {
    const held = heldLegs([t(), t({ symbol: 'P-BTC-79600-090926', position: -2 })]);
    expect(held.get('C-79600')!.size).toBe(1);
    expect(held.get('P-79600')!.size).toBe(2);
  });

  it('[critical] ignores a working order, which is not a position', () => {
    // marking the row for one would say you are short when you are not
    expect(heldLegs([t({ position: 0 })]).size).toBe(0);
  });

  it('adds two trades on one strike into one thing to look at', () => {
    const held = heldLegs([t(), t({ tradeId: 't2', position: -2 })]);
    expect(held.get('C-79600')).toMatchObject({ size: 3, pnlUsd: 0.004 });
  });

  it('refuses to total a P&L when half of it is unknown', () => {
    // a total that quietly drops a missing half is worse than no total
    const held = heldLegs([t(), t({ tradeId: 't2', live: undefined })]);
    expect(held.get('C-79600')!.pnlUsd).toBeNull();
    expect(held.get('C-79600')!.size).toBe(2);
  });

  it('skips a symbol it cannot read rather than guessing', () => {
    expect(heldLegs([t({ symbol: 'nonsense' })]).size).toBe(0);
  });

  it('has nothing to say about nothing', () => {
    expect(heldLegs(undefined).size).toBe(0);
    expect(heldLegs([]).size).toBe(0);
  });
});
