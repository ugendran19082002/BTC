import { describe, expect, it } from 'vitest';
import type { Trade } from '@/types/trade';
import { isRunning, isWaiting, stateOf, tradeEvents, tradeWords } from '@/lib/trade-events';

const trade = (over: Partial<Trade> = {}): Trade => ({
  tradeId: 't1', symbol: 'P-BTC-84600-071026', productId: 1, optionSide: 'PE', phase: 'protected',
  position: -500, requestedSize: 500, entrySize: 500, entryAvgPrice: 45.2, exitSize: 0, exitAvgPrice: null,
  protection: { takeProfit: 'tp', stopLoss: 'sl' }, realisedPnl: 0, fills: [], note: null, alarm: null, updatedAt: 0,
  ...over,
});
const waiting = (over: Partial<Trade> = {}) => trade({ phase: 'entry_pending', position: 0, entrySize: 0, entryAvgPrice: null, ...over });
/** The exit has filled; the desk still lists the trade while it takes the other exit off the book. */
const exited = (over: Partial<Trade> = {}) => trade({ phase: 'exit_pending', position: 0, exitSize: 500, exitAvgPrice: 30, ...over });
const kinds = (prev: Trade[], next: Trade[]) => tradeEvents(prev, next).map((e) => e.kind);

describe('stateOf', () => {
  it('waiting, running, done -- and nothing else for a trade that never was', () => {
    expect(stateOf(waiting())).toBe('waiting');
    expect(stateOf(waiting({ phase: 'precheck' }))).toBe('waiting');
    expect(stateOf(waiting({ phase: 'entry_unknown' }))).toBe('waiting');
    expect(stateOf(trade())).toBe('running');
    expect(stateOf(trade({ position: 200 }))).toBe('running'); // a bought position
    expect(stateOf(exited())).toBe('done');
    expect(stateOf(trade({ position: 0, phase: 'flat', exitSize: 500 }))).toBe('done');
    expect(stateOf(waiting({ phase: 'aborted' }))).toBe('other');
    expect(isWaiting(waiting())).toBe(true);
    expect(isWaiting(exited())).toBe(false);
    expect(isRunning(trade())).toBe(true);
    expect(isRunning(exited())).toBe(false);
  });
});

describe('tradeEvents: every step between two readings, each said once', () => {
  it('nothing changed, nothing said', () => {
    expect(kinds([trade()], [trade()])).toEqual([]);
    expect(kinds([waiting()], [waiting()])).toEqual([]);
    expect(kinds([exited()], [exited()])).toEqual([]);
    expect(kinds([], [])).toEqual([]);
  });

  it('[critical] the whole life, one event a step: waiting, filled, closed', () => {
    expect(kinds([], [waiting()])).toEqual(['waiting']);
    expect(kinds([waiting()], [trade()])).toEqual(['filled']);
    expect(kinds([trade()], [])).toEqual(['closed']);
  });

  it('[critical] closed while the desk still lists it is a close -- and not "not filled" when it then leaves', () => {
    // The live desk, 6 Oct 2026 15:21: exit filled, sibling being cancelled, position 0, still in the list.
    const closing = tradeEvents([trade()], [exited()]);
    expect(closing.map((e) => e.kind)).toEqual(['closed']);
    expect(closing[0]!.trade.position).toBe(-500); // as it was while it held, for the toast to describe
    expect(kinds([exited()], [])).toEqual([]); // already said
  });

  it('a fill between two readings is a fill, not a wait', () => {
    expect(kinds([], [trade()])).toEqual(['filled']);
  });

  it('opened and closed between two readings: one close', () => {
    expect(kinds([], [exited()])).toEqual(['closed']);
  });

  it('a waiting order that goes without filling is "gone"', () => {
    expect(kinds([waiting()], [])).toEqual(['gone']);
    // gone from the list because it was refused: still an order that did not fill
    expect(kinds([waiting({ phase: 'precheck' })], [])).toEqual(['gone']);
  });

  it('a partial fill growing, a part close, an add: the position changing size is not a new event', () => {
    expect(kinds([trade({ position: -200, entrySize: 200 })], [trade({ position: -500 })])).toEqual([]);
    expect(kinds([trade()], [trade({ position: -300, exitSize: 200 })])).toEqual([]);
    expect(kinds([trade()], [trade({ position: -700, entrySize: 700 })])).toEqual([]);
  });

  it('a trade the desk lists again after it was done is not filled twice', () => {
    expect(kinds([exited()], [exited({ phase: 'flat' })])).toEqual([]);
  });

  it('several things at once are each reported', () => {
    const a = trade({ tradeId: 'a' }), b = waiting({ tradeId: 'b' }), c = trade({ tradeId: 'c' });
    const next = [trade({ tradeId: 'b' }), waiting({ tradeId: 'd' })];
    expect(tradeEvents([a, b, c], next).map((e) => `${e.kind}:${e.tradeId}`).sort()).toEqual(['closed:a', 'closed:c', 'filled:b', 'waiting:d']);
  });

  it('two accounts\' trades on one id are told apart', () => {
    const a = trade({ account: { id: 1, name: 'SELL' } });
    const b = trade({ account: { id: 2, name: 'BUY' } });
    expect(tradeEvents([a], [a, b]).map((e) => [e.kind, e.trade.account?.id])).toEqual([['filled', 2]]);
    expect(tradeEvents([a, b], [b]).map((e) => [e.kind, e.trade.account?.id])).toEqual([['closed', 1]]);
  });

  it('words for a headline', () => {
    const label = (s: string) => s.split('-')[2] + ' ' + (s.startsWith('P') ? 'PE' : 'CE');
    expect(tradeWords(trade(), label)).toBe('SELL 84600 PE × 500');
    expect(tradeWords(waiting(), label)).toBe('SELL 84600 PE × 500');
    expect(tradeWords(exited(), label)).toBe('SELL 84600 PE × 500');
  });
});
