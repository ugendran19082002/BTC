import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeVerified } from '../../src/entry/read.js';
import { FlowSocket } from '../../src/market/flow-socket.js';
import { perpMinuteFromTape, useFlowSocket } from '../../src/market/flow.js';
import type { Candle } from '../../src/market/delta.js';

/**
 * The early look at a closed candle (4 Oct 2026). The signal run waited three
 * seconds after every close for the venue's candle to settle; now it looks at
 * one second and at two, and runs at once if the venue's candles are exactly
 * what the desk's own tape says the minute was. Anything else, and it waits for
 * the settled read as it always did.
 */

const B = 1_790_000_400;                    // a boundary that closes the 1m and the 5m candle, and no longer one
const bar = (time: number, o: Partial<Candle> = {}): Candle => ({ time, open: 85_000, high: 85_050, low: 84_980, close: 85_020, volume: 1_200, ...o });
const tape = { close: 85_020, high: 85_050, low: 84_980, volume: 1_200 };
const series = (m1: Candle[], more: [string, Candle[]][] = []) => new Map<string, Candle[]>([['1m', m1], ...more]) as never;

test('[critical] verified only when the venue\'s closed minute is the tape\'s: close, high, low and volume', () => {
  assert.deepEqual([B % 60, B % 300, B % 900 === 0], [0, 0, false]);
  const five = [bar(B - 300)];
  assert.equal(closeVerified(series([bar(B - 60)], [['5m', five]]), B, tape), true);
  assert.equal(closeVerified(series([bar(B - 60, { close: 85_021 })], [['5m', five]]), B, tape), false, 'a different close: the venue is not final, or the tape missed a trade');
  assert.equal(closeVerified(series([bar(B - 60, { high: 85_060 })], [['5m', five]]), B, tape), false, 'a different high');
  assert.equal(closeVerified(series([bar(B - 60, { low: 84_970 })], [['5m', five]]), B, tape), false, 'a different low');
  assert.equal(closeVerified(series([bar(B - 60, { volume: 1_250 })], [['5m', five]]), B, tape), false, 'volume still being added up');
  assert.equal(closeVerified(series([bar(B - 60, { volume: 1_201 })], [['5m', five]]), B, tape), true, 'one contract of rounding is the same minute');
});

test('[critical] not verified without the candle, without the tape, or when a longer candle closing now is not final', () => {
  assert.equal(closeVerified(series([bar(B - 120)]), B, tape), false, 'the venue has not listed the minute yet');
  assert.equal(closeVerified(series([bar(B - 60)], [['5m', [bar(B - 300)]]]), B, null), false, 'the tape cannot vouch for the minute');
  assert.equal(closeVerified(series([bar(B - 60)]), B, tape), false, 'the 5m candle that closed now is missing');
  assert.equal(closeVerified(series([bar(B - 60)], [['5m', [bar(B - 300, { close: 85_000 })]]]), B, tape), false, 'the 5m candle ends on an older trade');
  // A boundary that closes only the minute needs only the minute.
  assert.equal(closeVerified(series([bar(B + 60 - 60)]), B + 60, tape), true);
});

// ------------------------------------------------------------ the tape's minute

const minuteMs = B * 1000;
const feed = (now: number, prints: [number, number, number][], live = true) => {
  const s = new FlowSocket({ now: () => now });
  // No real connection in a test: whether the feed is live is said here.
  s.fresh = () => live;
  for (const [at, price, size] of prints) {
    s.receive(JSON.stringify({ type: 'all_trades', symbol: 'BTCUSD', price: String(price), size, timestamp: at * 1000, buyer_role: 'taker', seller_role: 'maker' }));
  }
  useFlowSocket(s);
  return s;
};
beforeEach(() => useFlowSocket(null));

test('[critical] the tape\'s minute: its last trade, its range and its volume -- only the trades inside it', () => {
  feed(minuteMs + 1_000, [
    [minuteMs - 70_000, 84_900, 9],                              // the minute before: shows the tape was running
    [minuteMs - 59_000, 85_000, 100], [minuteMs - 30_000, 85_050, 200], [minuteMs - 10_000, 84_980, 300], [minuteMs - 1, 85_020, 600],
    [minuteMs + 200, 85_100, 50],                                // after the boundary: the next minute's
  ]);
  assert.deepEqual(perpMinuteFromTape(minuteMs, minuteMs + 1_000), { close: 85_020, high: 85_050, low: 84_980, volume: 1_200, prints: 4 });
});

test('[critical] the tape does not vouch for a minute it did not see whole, or at all', () => {
  assert.equal(perpMinuteFromTape(minuteMs, minuteMs + 1_000), null, 'no socket');
  feed(minuteMs + 1_000, [[minuteMs - 20_000, 85_000, 100], [minuteMs - 1, 85_020, 600]]);
  assert.equal(perpMinuteFromTape(minuteMs, minuteMs + 1_000), null, 'it joined part-way through the minute');
  feed(minuteMs + 1_000, [[minuteMs - 70_000, 84_900, 9], [minuteMs + 200, 85_100, 50]]);
  assert.equal(perpMinuteFromTape(minuteMs, minuteMs + 1_000), null, 'nothing traded in the minute');
  feed(minuteMs + 1_000, [[minuteMs - 70_000, 84_900, 9], [minuteMs - 1, 85_020, 600]], false);
  assert.equal(perpMinuteFromTape(minuteMs, minuteMs + 1_000), null, 'the socket is not live: its last trades are not the minute');
});
