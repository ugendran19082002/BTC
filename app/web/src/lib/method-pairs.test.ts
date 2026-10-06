import { describe, expect, it } from 'vitest';
import { splitPairs, type Pair } from '@/lib/method-pairs';

const pair = (name: string, tf: string, netUsd: number, trades = 4): Pair => ({
  key: `${name}|single|${tf}`, name, tf, trades, wins: netUsd > 0 ? trades : 0, losses: netUsd < 0 ? trades : 0,
  winRate: netUsd > 0 ? 1 : 0, grossProfitUsd: Math.max(0, netUsd), grossLossUsd: Math.max(0, -netUsd),
  profitFactor: netUsd < 0 ? 0 : null, avgWinUsd: null, avgLossUsd: null, netUsd, bestUsd: null, worstUsd: null,
});

describe('method + timeframe pairs', () => {
  it('[critical] the pairs in profit, most first, and the pairs in loss, worst first: no pair in both', () => {
    const s = splitPairs([pair('A', '15m', 1.1), pair('B', '30m', -0.7), pair('A', '30m', 0.8), pair('C', '5m', -0.6), pair('D', '1h', 0)]);
    expect(s.best.map((p) => `${p.name} ${p.tf}`)).toEqual(['A 15m', 'A 30m']);
    expect(s.worst.map((p) => `${p.name} ${p.tf}`)).toEqual(['B 30m', 'C 5m']);
    expect(s.flat).toBe(1);
    expect(s.trades).toBe(20);
  });

  it('level on money, the pair with more trades comes first', () => {
    const s = splitPairs([pair('A', '15m', 0.5, 2), pair('B', '15m', 0.5, 9), pair('C', '1h', -0.5, 1), pair('D', '1h', -0.5, 6)]);
    expect(s.best.map((p) => p.name)).toEqual(['B', 'A']);
    expect(s.worst.map((p) => p.name)).toEqual(['D', 'C']);
  });

  it('nothing in, nothing out; and the list given is not reordered', () => {
    expect(splitPairs([])).toEqual({ best: [], worst: [], flat: 0, trades: 0 });
    const given = [pair('B', '30m', -1), pair('A', '15m', 1)];
    splitPairs(given);
    expect(given.map((p) => p.name)).toEqual(['B', 'A']);
  });
});
