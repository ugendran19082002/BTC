import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PARAMS, MIN_PREMIUM, pickStrike, simulateDay, type BacktestParams, type BoardRow, type BtSignal } from '../../src/report/signal-backtest.js';
import { sessionOf, type MinuteBar } from '../../src/report/market-day.js';
import { fillChargesUsd } from '../../src/trading/charges.js';

/**
 * The signal history traded as options (owner, 13 Oct 2026): "when the perp's SL is hit the contract has often
 * decayed by then, and the trade is a profit -- backtest that". One expiry day drawn by hand: a perp path a
 * minute at a time, a board every five minutes, a signal or two; each exit the backtest knows, priced by hand.
 */

const { from, to } = sessionOf('2026-10-07');
const MIN = 60_000;
/** The perp, a minute at a time, along [minute, price] points. */
function perp(path: [number, number][]): MinuteBar[] {
  const bars: MinuteBar[] = [];
  for (let i = 0; i < 1_440; i++) {
    let k = 0;
    while (k < path.length - 2 && i > path[k + 1]![0]) k++;
    const [m0, p0] = path[k]!, [m1, p1] = path[k + 1]!;
    const close = p0 + (p1 - p0) * Math.min(1, Math.max(0, (i - m0) / (m1 - m0)));
    bars.push({ at: from + i * MIN, high: close + 2, low: close - 2, close });
  }
  return bars;
}
/** One contract's readings every five minutes: its bid along [minute, bid] points, the offer 2 over it. */
function contract(cp: 'C' | 'P', strike: number, delta: number, path: [number, number][], spot = 84_000): BoardRow[] {
  const out: BoardRow[] = [];
  for (let m = 0; m < 1_440; m += 5) {
    let k = 0;
    while (k < path.length - 2 && m > path[k + 1]![0]) k++;
    const [m0, b0] = path[k]!, [m1, b1] = path[k + 1]!;
    const bid = b0 + (b1 - b0) * Math.min(1, Math.max(0, (m - m0) / (m1 - m0)));
    out.push({ at: from + m * MIN, cp, strike, spot, bid, ask: bid + 2, mark: bid + 1, delta });
  }
  return out;
}
const sig = (min: number, o: Partial<BtSignal> = {}): BtSignal => ({ method: 'breakout', mode: 'single', tf: '15m', dir: 1, filledAt: from + min * MIN, fillPrice: 84_000, stop: 83_700, target: 84_500, ...o });
const P: BacktestParams = { ...DEFAULT_PARAMS, window: 'all' };
const byTime = (xs: BoardRow[]) => [...xs].sort((a, b) => a.at - b.at);
const charges = (price: number, lots = 10) => fillChargesUsd({ price, contracts: lots, contractValue: 0.001, spot: 84_000 }).totalUsd;
const net = (entry: number, exit: number, lots = 10) => (entry - exit) * lots * 0.001 - charges(entry, lots) - charges(exit, lots);

test('[critical] the strike a rule picks: the nearest to the money inside the delta, or the dearest inside the price -- out of the money, worth selling', () => {
  const row = (cp: 'C' | 'P', strike: number, delta: number, bid: number | null): BoardRow => ({ at: 0, cp, strike, spot: 84_000, bid, ask: bid === null ? null : bid + 2, mark: bid, delta });
  const board = [
    row('P', 84_200, -0.6, 300), row('P', 83_800, -0.3, 120), row('P', 83_400, -0.12, 62), row('P', 83_200, -0.09, 44), row('P', 83_000, -0.05, 28), row('P', 82_600, -0.02, 8),
    row('C', 84_600, 0.2, 90), row('C', 85_000, 0.1, 47), row('C', 85_400, 0.04, 21),
  ];
  assert.equal(pickStrike(board, 'P', { rule: 'delta', value: 0.1 })!.strike, 83_200, 'the nearest put with a delta of 0.10 or less');
  assert.equal(pickStrike(board, 'C', { rule: 'delta', value: 0.1 })!.strike, 85_000, 'at the limit is inside it');
  assert.equal(pickStrike(board, 'P', { rule: 'delta', value: 0.2 })!.strike, 83_400);
  assert.equal(pickStrike(board, 'P', { rule: 'premium', value: 50 })!.strike, 83_200, 'the dearest put at 50 or under');
  assert.equal(pickStrike(board, 'C', { rule: 'premium', value: 50 })!.strike, 85_000);
  assert.equal(pickStrike(board, 'P', { rule: 'premium', value: 500 })!.strike, 83_800, 'never in the money, whatever the price allows');
  assert.equal(pickStrike(board, 'P', { rule: 'delta', value: 0.03 }), null, `the only one inside 0.03 sells for under ${MIN_PREMIUM}`);
  assert.equal(pickStrike([row('P', 83_000, -0.05, null)], 'P', { rule: 'delta', value: 0.1 }), null, 'no bid: nothing to sell at');
});

test('[critical] a BUY sells the put at the bid of the reading nearest its fill, and buys it back at the offer when the perp reaches the target', () => {
  // the perp reaches 84,500 in minute 302; the put decays from 40 to 10 over the day
  const r = simulateDay({ from, to, params: P, signals: [sig(31)], bars: perp([[0, 84_000], [300, 84_490], [310, 84_560], [1_439, 84_600]]),
    board: byTime([...contract('P', 83_200, -0.09, [[0, 40], [1_435, 10]]), ...contract('C', 85_000, 0.09, [[0, 40], [1_435, 10]])]) });
  assert.deepEqual(r.skipped, { 'outside-window': 0, 'no-entry-window': 0, distance: 0, 'at-limit': 0, 'no-board': 0, 'no-strike': 0, 'no-exit-price': 0 });
  const [t] = r.trades;
  assert.equal(t!.cp, 'P'); assert.equal(t!.strike, 83_200);
  assert.equal(t!.entryAt, from + 30 * MIN, 'the 5-minute reading nearest minute 31');
  assert.ok(Math.abs(t!.entry - (40 - 30 * 30 / 1_435)) < 1e-9, 'sold at its bid');
  assert.equal(t!.by, 'perp-tgt');
  assert.equal(t!.exitAt, from + 303 * MIN, 'the minute after the bar that reached it');
  const offer305 = 40 - 30 * 305 / 1_435 + 2;
  assert.ok(Math.abs(t!.exit - offer305) < 1e-9, 'bought back at the offer of the first reading at or after: minute 305');
  assert.ok(Math.abs(t!.netUsd - net(t!.entry, offer305)) < 1e-9, 'money after both fills\' charges');
  assert.equal(t!.perpPts, 500);
  // a SELL sells the call
  const short = simulateDay({ from, to, params: P, signals: [sig(31, { dir: -1, stop: 84_400, target: 83_500 })], bars: perp([[0, 84_000], [600, 83_480], [1_439, 83_400]]),
    board: byTime([...contract('P', 83_200, -0.09, [[0, 40], [1_435, 10]]), ...contract('C', 85_000, 0.09, [[0, 40], [1_435, 10]])]) });
  assert.deepEqual([short.trades[0]!.cp, short.trades[0]!.strike, short.trades[0]!.by, short.trades[0]!.perpPts], ['C', 85_000, 'perp-tgt', 500]);
});

test('[critical] the perp\'s SL hit, the option a profit all the same: it had decayed more than the move cost', () => {
  // sold at 40 early; hours later the perp slides to the stop, by when the put is worth 24 bid / 26 offered
  const decayed = simulateDay({ from, to, params: P, signals: [sig(30)], bars: perp([[0, 84_000], [700, 84_000], [760, 83_690], [1_439, 83_600]]),
    board: contract('P', 83_200, -0.09, [[0, 40], [700, 16], [760, 24], [1_435, 30]]) });
  const [t] = decayed.trades;
  assert.equal(t!.by, 'perp-sl');
  assert.equal(t!.perpPts, -300, 'the signal lost its 300 points');
  assert.ok(t!.netUsd > 0, `and the option made money: ${t!.netUsd}`);
  assert.ok(Math.abs(t!.netUsd - net(t!.entry, 26)) < 1e-9);
  // the same stop reached at once: the put has jumped, and it is the loss the stop looks like
  const fast = simulateDay({ from, to, params: P, signals: [sig(30)], bars: perp([[0, 84_000], [40, 84_000], [55, 83_690], [1_439, 83_600]]),
    board: contract('P', 83_200, -0.09, [[0, 40], [40, 40], [60, 95], [1_435, 30]]) });
  assert.equal(fast.trades[0]!.by, 'perp-sl');
  assert.ok(fast.trades[0]!.netUsd < 0);
  // stop and target inside one minute: taken as the stop
  const both = simulateDay({ from, to, params: P, signals: [sig(30, { stop: 83_999, target: 84_001 })], bars: perp([[0, 84_000], [1_439, 84_000]]), board: contract('P', 83_200, -0.09, [[0, 40], [1_435, 10]]) });
  assert.equal(both.trades[0]!.by, 'perp-sl');
});

test('[critical] the option\'s own target and stop come first when a reading reaches them; none set, none taken', () => {
  const flat = perp([[0, 84_000], [1_439, 84_100]]);              // the perp reaches neither level all day
  // offered at 4 or under (a tenth of 40) from minute 600
  const tgt = simulateDay({ from, to, params: P, signals: [sig(0)], bars: flat, board: contract('P', 83_200, -0.09, [[0, 40], [600, 2], [1_435, 1]]) });
  assert.equal(tgt.trades[0]!.by, 'option-tgt');
  assert.ok(Math.abs(tgt.trades[0]!.exit - 4) < 1e-9, 'a resting buy fills at its own price, not at the offer under it');
  assert.equal(tgt.trades[0]!.exitAt, from + 600 * MIN);
  // offered at 160 or over (four times 40) at minute 300
  const stop = simulateDay({ from, to, params: P, signals: [sig(0)], bars: flat, board: contract('P', 83_200, -0.09, [[0, 40], [295, 60], [300, 170], [1_435, 5]]) });
  assert.equal(stop.trades[0]!.by, 'option-sl');
  assert.equal(stop.trades[0]!.exit, 172, 'bought at the offer that reached it');
  assert.ok(stop.trades[0]!.netUsd < -1.2);
  // with no option stop, the same day is held to the end of the window and bought back at the last reading
  const held = simulateDay({ from, to, params: { ...P, stopPct: 0, targetPct: 0 }, signals: [sig(0)], bars: flat, board: contract('P', 83_200, -0.09, [[0, 40], [295, 60], [300, 170], [1_435, 5]]) });
  assert.equal(held.trades[0]!.by, 'window-end');
  assert.equal(held.trades[0]!.exit, 7);
  assert.equal(held.trades[0]!.perpPts, 100, 'and the perp is marked where it ended');
  // a tighter stop: 1.5 is two and a half times the premium
  const tight = simulateDay({ from, to, params: { ...P, stopPct: 1.5 }, signals: [sig(0)], bars: flat, board: contract('P', 83_200, -0.09, [[0, 40], [200, 99], [1_435, 5]]) });
  assert.equal(tight.trades[0]!.by, 'option-sl');
});

test('[critical] the desk\'s hours, and what cannot be traded, are counted and not guessed', () => {
  const bars = perp([[0, 84_000], [1_439, 84_100]]);
  const board = contract('P', 83_200, -0.09, [[0, 40], [1_435, 10]]);
  // 5:30-9:30 PM and after 3:59 PM are outside the strategies' window
  const desk = simulateDay({ from, to, params: { ...P, window: 'desk' }, signals: [sig(10), sig(239), sig(240), sig(1_348), sig(1_349)], bars, board });
  assert.equal(desk.trades.length, 2, '9:30 PM and 3:58 PM are inside it');
  assert.equal(desk.skipped['outside-window'], 3);
  assert.equal(simulateDay({ from, to, params: P, signals: [sig(10), sig(239), sig(240), sig(1_348)], bars, board }).trades.length, 4, 'the whole day, when asked');
  // no reading within five minutes of the fill; no strike inside the rule
  const gap = simulateDay({ from, to, params: P, signals: [sig(100)], bars, board: board.filter((r) => r.at < from + 80 * MIN || r.at > from + 120 * MIN) });
  assert.deepEqual([gap.trades.length, gap.skipped['no-board']], [0, 1]);
  const none = simulateDay({ from, to, params: { ...P, value: 0.05 }, signals: [sig(100)], bars, board });
  assert.deepEqual([none.trades.length, none.skipped['no-strike']], [0, 1]);
  // lots scale the money and nothing else
  const one = simulateDay({ from, to, params: { ...P, lots: 1 }, signals: [sig(100)], bars, board }).trades[0]!;
  const ten = simulateDay({ from, to, params: P, signals: [sig(100)], bars, board }).trades[0]!;
  assert.ok(Math.abs(ten.netUsd - 10 * one.netUsd) < 1e-9);
});
