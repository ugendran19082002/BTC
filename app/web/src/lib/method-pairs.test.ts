import { describe, expect, it } from 'vitest';
import { CHAIN_TF, chosenTfs, pairsOfReport, pairsOfStats, methodsOfReport, pickTf, splitPairs, timeframesOf, type PairStat } from '@/lib/method-pairs';
import type { MethodReportResponse, MethodReportRow, MethodReportSection } from '@/types/entry';

const pair = (name: string, tf: string, net: number, trades = 4): PairStat => ({
  key: `${name}|single|${tf}`, name, tf, trades, wins: net > 0 ? trades : 0, losses: net < 0 ? trades : 0,
  winRate: net > 0 ? 1 : 0, profitFactor: net < 0 ? 0 : null, net,
});

describe('method + timeframe pairs', () => {
  it('[critical] the pairs in profit, most first, and the pairs in loss, worst first: no pair in both', () => {
    const s = splitPairs([pair('A', '15m', 1.1), pair('B', '30m', -0.7), pair('A', '30m', 0.8), pair('C', '5m', -0.6), pair('D', '1h', 0)]);
    expect(s.best.map((p) => `${p.name} ${p.tf}`)).toEqual(['A 15m', 'A 30m']);
    expect(s.worst.map((p) => `${p.name} ${p.tf}`)).toEqual(['B 30m', 'C 5m']);
    expect(s.flat).toBe(1);
    expect(s.trades).toBe(20);
  });

  it('level on what they made, the pair with more trades comes first', () => {
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

  it('the closed trades\' pairs are ranked on their money', () => {
    const [p] = pairsOfStats([{ key: 'breakout|single|15m', name: '#1 Breakout', tf: '15m', trades: 3, wins: 2, losses: 1, winRate: 2 / 3,
      grossProfitUsd: 2, grossLossUsd: 0.5, profitFactor: 4, avgWinUsd: 1, avgLossUsd: 0.5, netUsd: 1.5, bestUsd: 1.2, worstUsd: -0.5 }]);
    expect(p).toEqual({ key: 'breakout|single|15m', name: '#1 Breakout', tf: '15m', trades: 3, wins: 2, losses: 1, winRate: 2 / 3, profitFactor: 4, net: 1.5 });
  });
});

describe('signal history pairs', () => {
  const row = (n: number, method: string, o: Partial<MethodReportRow> = {}): MethodReportRow => ({
    n, method, name: method[0]!.toUpperCase() + method.slice(1), signals: 10, trades: 4, wins: 3, losses: 1, winPct: 75,
    profitPts: 900, lossPts: 300, netPts: 600, profitR: 3, lossR: 1, netR: 2, ...o,
  });
  const section = (mode: 'mtf' | 'single', rows: MethodReportRow[]): MethodReportSection =>
    ({ mode, label: mode, rows, total: row(0, 'total'), gatesOffSignals: 0 });
  const report: MethodReportResponse = {
    tf: null,
    sections: [section('mtf', [row(1, 'breakout', { netPts: -250, netR: -0.8 })]), section('single', [row(1, 'breakout')])],
    singleByTf: {
      '15m': section('single', [row(1, 'breakout'), row(6, 'bos', { signals: 7, trades: 0, wins: 0, losses: 0, winPct: null, profitPts: 0, lossPts: 0, netPts: 0, netR: 0 })]),
      '1h': section('single', [row(1, 'breakout', { trades: 2, wins: 2, losses: 0, winPct: 100, profitPts: 400, lossPts: 0, netPts: 400, netR: 1.5 })]),
    },
  };

  it('[critical] without the timeframe chain: one pair for each timeframe a method traded on, ranked on points', () => {
    const { pairs, signals } = pairsOfReport(report, 'single');
    expect(pairs.map((p) => [p.name, p.tf, p.trades, p.net, p.netR])).toEqual([['#1 Breakout', '15m', 4, 600, 2], ['#1 Breakout', '1h', 2, 400, 1.5]]);
    expect(pairs[0]).toMatchObject({ key: 'breakout|single|15m', winRate: 0.75, profitFactor: 3, signals: 10, wonPts: 900, lostPts: 300 });
    // nothing lost: no profit factor, rather than an infinite one
    expect(pairs[1]!.profitFactor).toBeNull();
    // the method with signals and no trade is in no pair, and its signals still count
    expect(signals).toBe(27);
  });

  it('with the timeframe chain: one pair a method, its timeframe the chain\'s', () => {
    const { pairs, signals } = pairsOfReport(report, 'mtf');
    expect(pairs.map((p) => [p.key, p.tf, p.net])).toEqual([['breakout|mtf|5m + TF chain', CHAIN_TF, -250]]);
    expect(signals).toBe(10);
    expect(splitPairs(pairs).worst).toHaveLength(1);
  });

  it('[critical] without the chain, only the timeframes picked: their pairs and their signals; none picked is all', () => {
    expect(pairsOfReport(report, 'single', ['1h']).pairs.map((p) => p.tf)).toEqual(['1h']);
    expect(pairsOfReport(report, 'single', ['1h']).signals).toBe(10);
    expect(pairsOfReport(report, 'single', ['1h', '15m']).pairs.map((p) => p.tf)).toEqual(['15m', '1h']);
    expect(pairsOfReport(report, 'single', []).pairs).toHaveLength(2);
    // a pick remembered from a day that had 2h, on a report without it: every timeframe, not none
    expect(pairsOfReport(report, 'single', ['2h']).pairs).toHaveLength(2);
    // the chain has no timeframe to pick: the filter does not touch it
    expect(pairsOfReport(report, 'mtf', ['1h']).pairs).toHaveLength(1);
  });

  it('the filter\'s chips: the report\'s timeframes, shortest first; a pick keeps only those it has', () => {
    const r: MethodReportResponse = { tf: null, sections: [], singleByTf: { '4h': section('single', []), '5m': section('single', []), '1h': section('single', []), '15m': section('single', []) } };
    expect(timeframesOf(r)).toEqual(['5m', '15m', '1h', '4h']);
    expect(chosenTfs(r, ['4h', '2h', '5m'])).toEqual(['5m', '4h']);
    expect(timeframesOf({ tf: null, sections: [], singleByTf: {} })).toEqual([]);
  });

  it('a tap on the filter: one at a time chooses that one alone; many adds or takes away; All clears', () => {
    expect(pickTf([], '15m', 'one')).toEqual(['15m']);
    expect(pickTf(['15m'], '1h', 'one')).toEqual(['1h']);
    expect(pickTf(['15m'], '15m', 'one')).toEqual(['15m']);
    expect(pickTf([], '15m', 'many')).toEqual(['15m']);
    expect(pickTf(['15m'], '1h', 'many')).toEqual(['15m', '1h']);
    expect(pickTf(['15m', '1h'], '15m', 'many')).toEqual(['1h']);
    expect(pickTf(['1h'], '1h', 'many')).toEqual([]);
    expect(pickTf(['15m', '1h'], null, 'many')).toEqual([]);
    expect(pickTf(['15m'], null, 'one')).toEqual([]);
  });

  it('a report with no section for a way gives no pairs', () => {
    expect(pairsOfReport({ tf: null, sections: [], singleByTf: {} }, 'mtf')).toEqual({ pairs: [], signals: 0 });
    expect(pairsOfReport({ tf: null, sections: [], singleByTf: {} }, 'single')).toEqual({ pairs: [], signals: 0 });
  });
});

describe('the method filter on the signal history', () => {
  const row = (n: number, method: string, o: Partial<MethodReportRow> = {}): MethodReportRow => ({
    n, method, name: method, signals: 10, trades: 4, wins: 3, losses: 1, winPct: 75, profitPts: 900, lossPts: 300, netPts: 600, profitR: 3, lossR: 1, netR: 2, ...o,
  });
  const sec = (mode: 'mtf' | 'single', rows: MethodReportRow[]): MethodReportSection => ({ mode, label: mode, rows, total: row(0, 'all'), gatesOffSignals: 0 });
  const report: MethodReportResponse = {
    tf: null,
    sections: [sec('mtf', [row(31, 'edge')]), sec('single', [])],
    singleByTf: {
      '15m': sec('single', [row(63, 'ib'), row(1, 'breakout', { netPts: -200 }), row(9, 'quiet', { signals: 0, trades: 0, netPts: 0 })]),
      '1h': sec('single', [row(63, 'ib', { signals: 5, trades: 2, netPts: 100 }), row(7, 'waiting', { signals: 3, trades: 0, netPts: 0 })]),
    },
  } as MethodReportResponse;

  it('[critical] the methods to choose from: each once, added up across its timeframes, in the desk\'s own order', () => {
    expect(methodsOfReport(report, 'single').map((m) => [m.name, m.signals, m.trades, m.net])).toEqual([
      ['#1 breakout', 10, 4, -200], ['#7 waiting', 3, 0, 0], ['#63 ib', 15, 6, 700],
    ]);
    // A method with no signal at all is not offered; one with signals and no trade yet is.
    expect(methodsOfReport(report, 'single').some((m) => m.key === 'quiet')).toBe(false);
    // Only the timeframes kept, and only this way of reading.
    expect(methodsOfReport(report, 'single', ['1h']).map((m) => [m.key, m.trades])).toEqual([['waiting', 0], ['ib', 2]]);
    expect(methodsOfReport(report, 'mtf').map((m) => m.name)).toEqual(['#31 edge']);
  });

  it('[critical] with methods chosen only their signals are ranked and counted', () => {
    const all = pairsOfReport(report, 'single');
    expect([all.pairs.length, all.signals]).toEqual([3, 28]);
    const one = pairsOfReport(report, 'single', [], (method) => method === 'ib');
    expect(one.pairs.map((p) => `${p.name} ${p.tf}`)).toEqual(['#63 ib 15m', '#63 ib 1h']);
    expect(one.signals).toBe(15);
    expect(pairsOfReport(report, 'single', ['15m'], (method) => method === 'ib').pairs.map((p) => p.tf)).toEqual(['15m']);
  });
});
