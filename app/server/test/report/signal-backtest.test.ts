import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PARAMS, MIN_PREMIUM, VOL_STUDY_WIN, passesBar, recordBefore, tallyOf, winBarAt, breakEvenProblems, breakEvenReached, minuteAtr, paramsKey, perpFeePts, perpOf, widenAfter, pickStrike, planOfParams, simulateDay, tslProblems, tslTrail, type BacktestParams, type BoardRow, type BtSignal } from '../../src/report/signal-backtest.js';
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
/**
 * The same contract and a ladder further out, each 200 further, priced and weighted alike (14 Oct 2026): one trade
 * per contract, so overlapping signals each sell the next strike out -- and, priced alike, make what they made on
 * the one strike before.
 */
function ladder(cp: 'C' | 'P', strike: number, delta: number, path: [number, number][], n = 12, spot = 84_000): BoardRow[] {
  return Array.from({ length: n }, (_, i) => contract(cp, cp === 'P' ? strike - 200 * i : strike + 200 * i, delta, path, spot)).flat();
}
const sig = (min: number, o: Partial<BtSignal> = {}): BtSignal => ({ method: 'breakout', mode: 'single', tf: '15m', dir: 1, filledAt: from + min * MIN, fillPrice: 84_000, stop: 83_700, target: 84_500, ...o });
const P: BacktestParams = { ...DEFAULT_PARAMS, window: 'all' };
/** The settings' plan for the test's day. */
const planOf = (p: BacktestParams = P) => planOfParams(p, { from, to });
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
  assert.deepEqual(r.skipped, { 'outside-window': 0, 'no-entry-window': 0, distance: 0, volatility: 0, 'at-limit': 0, 'desk-limit': 0, 'side-limit': 0, 'strike-limit': 0, 'no-board': 0, 'no-strike': 0, 'no-exit-price': 0 });
  const [t] = r.trades;
  assert.equal(t!.cp, 'P'); assert.equal(t!.strike, 83_200);
  assert.equal(t!.entryAt, from + 30 * MIN, 'the 5-minute reading nearest minute 31');
  assert.ok(Math.abs(t!.entry - (40 - 30 * 30 / 1_435)) < 1e-9, 'sold at its bid');
  assert.equal(t!.by, 'perp-tgt');
  assert.equal(t!.exitAt, from + 303 * MIN, 'the minute after the bar that reached it');
  const offer305 = 40 - 30 * 305 / 1_435 + 2;
  assert.ok(Math.abs(t!.exit - offer305) < 1e-9, 'bought back at the offer of the first reading at or after: minute 305');
  assert.ok(Math.abs(t!.netUsd - net(t!.entry, offer305)) < 1e-9, 'money after both fills\' charges');
  assert.ok(Math.abs(t!.chargesUsd - charges(t!.entry) - charges(offer305)) < 1e-12, 'and the charges themselves, both fills');
  assert.ok(t!.chargesUsd > 0);
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

/*
 * A trailing SL on the option's stop (owner, 18 Oct 2026: "TSL in the backtest -- points and per cent; as the price moves
 * from the entry, the SL moves"): every X the premium falls from the price sold, the stop comes down Y; never back up.
 */
test('[critical] TSL: one SL step for every whole price step the best offer is under the sale -- in points, per cent, or both', () => {
  const pts = { move: 5, moveUnit: 'pts', by: 5, byUnit: 'pts' } as const;
  assert.deepEqual([38, 35, 30.01, 30, 41].map((best) => tslTrail(pts, 40, best)), [0, 5, 5, 10, 0]);
  // 10% of 40 is 4: down 8 is two steps; each step 10% of 40, or 5 points
  assert.equal(tslTrail({ move: 10, moveUnit: 'pct', by: 10, byUnit: 'pct' }, 40, 32), 8);
  assert.equal(tslTrail({ move: 10, moveUnit: 'pct', by: 5, byUnit: 'pts' }, 40, 32), 10);
  assert.equal(tslTrail({ move: 5, moveUnit: 'pts', by: 2, byUnit: 'pts' }, 40, 39.99), 0, 'not a whole step yet');
});

test('[critical] TSL: the stop follows the premium down, holds when it turns, and the trade is out on the trailed stop', () => {
  const flat = perp([[0, 84_000], [1_439, 84_000]]);
  // sold at 40 (stop +150%: 100); the offer falls to 12 by minute 100, then climbs to 82 by minute 200, then eases
  const board = contract('P', 83_200, -0.09, [[0, 40], [100, 10], [200, 80], [1_435, 60]]);
  const tsl = { move: 5, moveUnit: 'pts', by: 5, byUnit: 'pts' } as const;
  const trailed = simulateDay({ from, to, params: { ...P, stopPct: 1.5, tsl }, signals: [sig(0)], bars: flat, board }).trades[0]!;
  // best offer 12: 28 under 40 is five steps of 5 -- the stop 100 comes down 25, to 75, and stays there as it climbs
  assert.deepEqual([trailed.by, (trailed.exitAt - from) / MIN, trailed.exit, trailed.optStop, trailed.optStopEnd], ['option-tsl', 190, 75, 100, 75]);
  // the same day without it: the stop at 100 is never reached
  const fixed = simulateDay({ from, to, params: { ...P, stopPct: 1.5 }, signals: [sig(0)], bars: flat, board }).trades[0]!;
  assert.equal(fixed.by, 'window-end');
  assert.equal(fixed.optStopEnd, undefined);
  // a premium that never falls a whole step: the stop is where it was set, and a stop hit is the option's own
  const up = simulateDay({ from, to, params: { ...P, stopPct: 1.5, tsl: { ...tsl, move: 50 } }, signals: [sig(0)], bars: flat, board: contract('P', 83_200, -0.09, [[0, 40], [100, 120], [1_435, 60]]) }).trades[0]!;
  assert.equal(up.by, 'option-sl');
  // a different setting is a different backtest, not a cached one
  assert.notEqual(paramsKey({ ...P, tsl }), paramsKey(P));
  assert.notEqual(paramsKey({ ...P, tsl }), paramsKey({ ...P, tsl: { ...tsl, byUnit: 'pct' } }));
});

test('TSL: checked as the screen says it -- above 0, the SL not moving further than the price in one unit, and a stop to move', () => {
  const t = { move: 5, moveUnit: 'pts', by: 5, byUnit: 'pts' } as const;
  assert.deepEqual(tslProblems(t, 3), []);
  assert.deepEqual(tslProblems({ ...t, by: 6 }, 3), ['The SL cannot move further than the price did: the SL move must be at most the price move.']);
  assert.deepEqual(tslProblems({ ...t, by: 6, byUnit: 'pct' }, 3), [], 'in two units it cannot be compared before a price');
  assert.deepEqual(tslProblems(t, 0), ['A trailing SL needs an option stop to move: set the option stop.']);
  assert.match(tslProblems({ ...t, move: 0 }, 3)[0]!, /price move is more than 0/);
  assert.match(tslProblems({ ...t, moveUnit: 'pct', move: 101 }, 3)[0]!, /at most 100%/);
});

test('[critical] the desk\'s hours, and what cannot be traded, are counted and not guessed', () => {
  const bars = perp([[0, 84_000], [1_439, 84_100]]);
  const board = ladder('P', 83_200, -0.09, [[0, 40], [1_435, 10]]);
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

test('[critical] the desk\'s limits: at most N open across every signal, and each side its per cent of it -- as the desk rounds it', async () => {
  const { deskCapsOf, planOfParams } = await import('../../src/report/signal-backtest.js');
  const bars = perp([[0, 84_000], [1_439, 84_050]]);             // the perp reaches nothing: every trade stays open all day
  const board = byTime([...ladder('P', 83_200, -0.09, [[0, 40], [1_435, 30]]), ...ladder('C', 85_000, 0.09, [[0, 40], [1_435, 30]])]);
  const sell = { dir: -1 as const, stop: 84_400, target: 83_500 };
  const signals = [sig(10), sig(20), sig(30), sig(40, sell), sig(50, sell)];
  const run = (o: Partial<BacktestParams>) => simulateDay({ from, to, signals, bars, board, plan: planOfParams({ ...P, ...o }, { from, to }) });

  const none = run({});
  assert.equal(none.trades.length, 5, 'no limit: every signal');
  const two = run({ deskMax: 2 });
  assert.deepEqual(two.trades.map((t) => t.cp), ['P', 'P'], 'at most two open: the first two, and nothing while they are open');
  assert.equal(two.skipped['desk-limit'], 3);
  // four at once, puts at most half of it: two puts, then the third waits; the calls have their own room
  const sides = run({ deskMax: 4, pePct: 50, cePct: 100 });
  assert.deepEqual(sides.trades.map((t) => t.cp), ['P', 'P', 'C', 'C']);
  assert.equal(sides.skipped['side-limit'], 1);
  assert.deepEqual(deskCapsOf({ deskMax: 35, cePct: 80, pePct: 80 }), { max: 35, side: { CE: 28, PE: 28 }, strike: null, strikeFull: 'next' }, 'the desk\'s own rounding: 80% of 35 is 28');
  assert.equal(deskCapsOf({ deskMax: 0, cePct: 80, pePct: 80 }), null, 'no "at most open": no side limit either');
  // a trade that has closed frees its place
  const early = simulateDay({ from, to, signals: [sig(10), sig(400)], bars: perp([[0, 84_000], [100, 84_000], [120, 84_600], [1_439, 84_600]]), board, plan: planOfParams({ ...P, deskMax: 1 }, { from, to }) });
  assert.equal(early.trades.length, 2, 'the first reached its target at minute ~110; the second found the place free');
});

test('[critical] custom hours: only the signals filled from the From time to the To time (IST), across midnight too', async () => {
  const { planOfParams } = await import('../../src/report/signal-backtest.js');
  const bars = perp([[0, 84_000], [1_439, 84_050]]);
  const board = ladder('P', 83_200, -0.09, [[0, 40], [1_435, 30]]);
  // the expiry day begins at 5:30 PM IST: minute 270 is 10:00 PM, 450 is 1:00 AM, 1_200 is 1:30 PM
  const signals = [sig(30), sig(270), sig(450), sig(1_200)];
  const run = (hoursFrom: string, hoursTo: string) => simulateDay({ from, to, signals, bars, board, plan: planOfParams({ ...P, window: 'custom', hoursFrom, hoursTo }, { from, to }) });
  const night = run('22:00', '02:00');
  assert.deepEqual(night.trades.map((t) => (t.signal.filledAt - from) / 60_000), [270, 450], '10 PM and 1 AM; not 6 PM nor 1:30 PM');
  assert.equal(night.skipped['outside-window'], 2);
  assert.deepEqual(run('13:00', '14:00').trades.map((t) => (t.signal.filledAt - from) / 60_000), [1_200]);
  assert.deepEqual(run('22:00', '22:01').trades.map((t) => (t.signal.filledAt - from) / 60_000), [270], 'the From minute is in');
  assert.deepEqual(run('21:00', '22:00').trades, [], 'the To minute is not');
});

test('[critical] signals that filled in the same second are taken in a fixed order -- longest timeframe first -- so a limit gives the same count every time', async () => {
  const { planOfParams, signalOrder } = await import('../../src/report/signal-backtest.js');
  const bars = perp([[0, 84_000], [1_439, 84_050]]);
  const board = ladder('P', 83_200, -0.09, [[0, 40], [1_435, 30]]);
  const at = 100;
  const tie = [sig(at, { tf: '5m', method: 'b' }), sig(at, { tf: '4h', method: 'z' }), sig(at, { tf: '15m', method: 'a' }), sig(at, { tf: '4h', method: 'a' })];
  assert.deepEqual([...tie].sort(signalOrder).map((x) => `${x.tf}:${x.method}`), ['4h:a', '4h:z', '15m:a', '5m:b']);
  const plan = planOfParams({ ...P, deskMax: 2 }, { from, to });
  const took = (xs: typeof tie) => simulateDay({ from, to, signals: xs, bars, board, plan }).trades.map((t) => `${t.signal.tf}:${t.signal.method}`);
  // every order the database could return them in gives the same two trades
  const orders = [tie, [...tie].reverse(), [tie[2]!, tie[0]!, tie[3]!, tie[1]!], [tie[1]!, tie[3]!, tie[0]!, tie[2]!]];
  for (const xs of orders) assert.deepEqual(took(xs), ['4h:a', '4h:z']);
});

test('[critical] a signal only if its SL and TGT are in range: points from the fill to each, minimum and maximum, 0 off', async () => {
  const { planOfParams } = await import('../../src/report/signal-backtest.js');
  const bars = perp([[0, 84_000], [1_439, 84_050]]);
  const board = ladder('P', 83_200, -0.09, [[0, 40], [1_435, 30]]);
  // fills at 84,000: SL 300 away, TGT 500 away
  const near = sig(10, { stop: 83_900, target: 84_150 });          // SL 100, TGT 150
  const usual = sig(20);                                            // SL 300 (stop 83,700 from the 84,000 fill), TGT 500
  const far = sig(30, { stop: 83_000, target: 86_000 });           // SL 1,000, TGT 2,000
  const run = (o: Partial<BacktestParams>) => {
    const r = simulateDay({ from, to, signals: [near, usual, far], bars, board, plan: planOfParams({ ...P, ...o }, { from, to }) });
    return { took: r.trades.map((t) => (t.signal.filledAt - from) / 60_000), skipped: r.skipped.distance };
  };
  assert.deepEqual(run({}), { took: [10, 20, 30], skipped: 0 }, 'all off');
  assert.deepEqual(run({ slMin: 150, tgtMin: 150 }), { took: [20, 30], skipped: 1 }, 'the strategy form\'s 150 / 150: the near one skipped');
  assert.deepEqual(run({ slMin: 300 }), { took: [20, 30], skipped: 1 }, 'at the minimum is in');
  assert.deepEqual(run({ slMax: 500 }), { took: [10, 20], skipped: 1 }, 'further than the maximum is out');
  assert.deepEqual(run({ tgtMin: 200, tgtMax: 500 }), { took: [20], skipped: 2 }, 'each bound on its own');
});

test('[critical] the margin: each trade\'s by the desk\'s 200x estimate, and the most open at once -- a trade ending as another starts makes room', async () => {
  const { peakMargin, planOfParams } = await import('../../src/report/signal-backtest.js');
  const { fundsRequiredPerContract } = await import('../../src/trading/margin.js');
  assert.deepEqual(peakMargin([]), { usd: 0, at: null, open: 0, lots: 0 });
  assert.deepEqual(peakMargin([{ at: 0, until: 10, margin: 5 }, { at: 5, until: 20, margin: 7 }, { at: 10, until: 30, margin: 9 }]), { usd: 16, at: 10, open: 2, lots: 0 },
    'at 10 the first has ended: 7 + 9, not 5 + 7 + 9');
  assert.deepEqual(peakMargin([{ at: 0, until: 100, margin: 5 }, { at: 1, until: 100, margin: 5 }, { at: 2, until: 100, margin: 5 }]), { usd: 15, at: 2, open: 3, lots: 0 });
  // and how many lots that was: what the margin is so many times a lot's
  assert.deepEqual(peakMargin([{ at: 0, until: 10, margin: 5, lots: 2 }, { at: 5, until: 20, margin: 7, lots: 3 }, { at: 10, until: 30, margin: 9, lots: 4 }]), { usd: 16, at: 10, open: 2, lots: 7 });
  // a trade's own: the model at its entry premium and BTC, times its lots
  const r = simulateDay({ from, to, signals: [sig(10)], bars: perp([[0, 84_000], [1_439, 84_050]]), board: contract('P', 83_200, -0.09, [[0, 40], [1_435, 30]]), plan: planOfParams({ ...P, lots: 16 }, { from, to }) });
  const t = r.trades[0]!;
  assert.ok(Math.abs(t.marginUsd - fundsRequiredPerContract({ spot: 84_000, premium: t.entry, leverage: 200, contractValue: 0.001 }) * 16) < 1e-9);
  assert.ok(t.marginUsd > 0);
});

test('[critical] a target by the clock: from each step\'s time the step\'s share, for trades open then and sold after -- read forward from 5:30 PM', async () => {
  const { planOfParams } = await import('../../src/report/signal-backtest.js');
  const flat = perp([[0, 84_000], [1_439, 84_100]]);                  // the perp reaches neither level
  // the put decays 40 -> 4 bid over the day (offered 2 over): sold at 40 at minute 0
  const board = contract('P', 83_200, -0.09, [[0, 40], [1_435, 4]]);
  const run = (o: Partial<BacktestParams>, at = 0) => simulateDay({ from, to, signals: [sig(at)], bars: flat, board, plan: planOfParams({ ...P, stopPct: 0, ...o }, { from, to }) }).trades[0]!;

  // fixed 50%: bought back when the offer is at 20 -- bid 18, about minute 877 -> the reading at 880
  const fixed = run({ targetPct: 0.5 });
  assert.equal(fixed.by, 'option-tgt');
  assert.ok(Math.abs(fixed.exit - 20) < 1e-9);
  assert.equal((fixed.exitAt - from) / 60_000, 880);

  // 50% to begin with, 80% from 11:30 PM (minute 360): at minute 880 the target is 8, not 20 -- it waits for an offer of 8
  const stepped = run({ targetPct: 0.5, targetSteps: [{ at: '23:30', pct: 0.8 }] });
  assert.equal(stepped.by, 'option-tgt');
  assert.ok(Math.abs(stepped.exit - 8) < 1e-9, `at the stepped level: ${stepped.exit}`);
  assert.ok((stepped.exitAt - from) / 60_000 > 1_300, 'and much later');
  assert.ok(stepped.netUsd > fixed.netUsd, 'more of the premium kept');

  // a step DOWN -- 90% to begin with, 20% from 1:30 AM (minute 480): the buy moves up to 32, over the offer, and fills at the offer
  const down = run({ targetPct: 0.9, targetSteps: [{ at: '01:30', pct: 0.2 }] });
  assert.equal(down.by, 'option-tgt');
  assert.equal((down.exitAt - from) / 60_000, 480, 'at the step\'s own time');
  const offer480 = 40 - 36 * 480 / 1_435 + 2;
  assert.ok(Math.abs(down.exit - offer480) < 1e-9, 'at the offer (about 30), not at the 32 the target names');

  // a trade sold after a step starts at the step's share: sold at minute 600 (~24.9), target 80% from 11:30 PM
  const late = run({ targetPct: 0.5, targetSteps: [{ at: '23:30', pct: 0.8 }] }, 600);
  assert.ok(Math.abs(late.exit - late.entry * 0.2) < 1e-9 || late.by !== 'option-tgt');
  // steps in any order of the day are read forward from 5:30 PM: one at 6:00 PM applies before one at 3:00 PM
  const early = run({ targetPct: 0.9, targetSteps: [{ at: '15:00', pct: 0.95 }, { at: '18:00', pct: 0.5 }] });
  assert.ok(Math.abs(early.exit - 20) < 1e-9, 'the 6 PM step (50%) was in force from the day\'s first half hour');
});

test('[critical] volatility at a signal: the last two hours of 15-minute candles against the five days before -- low, medium, high', async () => {
  const { volReader, VOL_LOW, VOL_HIGH } = await import('../../src/report/signal-backtest.js');
  // minutes whose 15-minute candles each span `size` points: a sawtooth of that height every 15 minutes
  const saw = (size: number, minutes = 600): MinuteBar[] => Array.from({ length: minutes }, (_, i) => {
    const close = 84_000 + (i % 15 < 8 ? (i % 15) * (size / 7) : (14 - (i % 15)) * (size / 7));
    return { at: from + i * 60_000, high: close, low: close, close };
  });
  const at = from + 300 * 60_000;
  assert.equal(volReader(saw(100), 100)(at), 'medium', 'the same as the days before');
  assert.equal(volReader(saw(100), 200)(at), 'low', 'half of them: under 0.8');
  assert.equal(volReader(saw(100), 60)(at), 'high', 'two thirds more: over 1.3');
  assert.ok(VOL_LOW === 0.8 && VOL_HIGH === 1.3);
  assert.equal(volReader(saw(100), null)(at), null, 'no days before to compare with: not said');
  assert.equal(volReader(saw(100), 100)(from + 20 * 60_000), null, 'one closed candle is too few');
  // only what had closed by then is read: a storm that begins at minute 300 is not seen at minute 300
  const calmThenWild = [...saw(100, 300), ...saw(1_000, 300).map((b) => ({ ...b, at: b.at + 300 * 60_000 }))];
  assert.equal(volReader(calmThenWild, 100)(from + 300 * 60_000), 'medium');
  assert.equal(volReader(calmThenWild, 100)(from + 480 * 60_000), 'high');
});

test('[critical] the volatility filter keeps only the signals of the level asked for, and every trade says its level', async () => {
  const { volReader, planOfParams } = await import('../../src/report/signal-backtest.js');
  const board = ladder('P', 83_200, -0.09, [[0, 40], [1_435, 30]]);
  // quiet for five hours, wild after: a flat perp for the trades, the volatility read from another series
  const bars = perp([[0, 84_000], [1_439, 84_050]]);
  const volAt = (at: number) => ((at - from) / 60_000 < 300 ? 'low' as const : (at - from) / 60_000 < 600 ? 'high' as const : null);
  const signals = [sig(100), sig(200), sig(400), sig(700)];
  const run = (volOnly: 'low' | 'medium' | 'high' | null) => simulateDay({ from, to, signals, bars, board, plan: planOfParams(P, { from, to }), volAt, volOnly });
  assert.deepEqual(run(null).trades.map((t) => t.vol), ['low', 'low', 'high', null], 'off: every signal, each with its level');
  assert.deepEqual(run('low').trades.map((t) => (t.signal.filledAt - from) / 60_000), [100, 200]);
  assert.equal(run('low').skipped.volatility, 2);
  assert.deepEqual(run('high').trades.map((t) => (t.signal.filledAt - from) / 60_000), [400]);
  assert.deepEqual(run('medium').trades, []);
  assert.equal(run('medium').skipped.volatility, 4, 'one whose level cannot be said is not of the level asked for');
  assert.equal(typeof volReader, 'function');
});

test('[critical] target steps typed out of clock order are read in clock order: the last one the clock reached is in force, not the last one typed', async () => {
  const { planOfParams } = await import('../../src/report/signal-backtest.js');
  const flat = perp([[0, 84_000], [1_439, 84_100]]);
  const board = contract('P', 83_200, -0.09, [[0, 40], [1_435, 4]]);      // sold at 40, offered at bid + 2
  const run = (targetSteps: { at: string; pct: number }[]) => simulateDay({ from, to, signals: [sig(0)], bars: flat, board, plan: planOfParams({ ...P, stopPct: 0, targetPct: 0.5, targetSteps }, { from, to }) }).trades[0]!;
  // 50% to begin with, 60% from 11:30 PM (minute 360), 80% from 3:30 AM (minute 600): from then the buy rests at 8
  const inOrder = run([{ at: '23:30', pct: 0.6 }, { at: '03:30', pct: 0.8 }]);
  const typedBackwards = run([{ at: '03:30', pct: 0.8 }, { at: '23:30', pct: 0.6 }]);
  assert.equal(inOrder.by, 'option-tgt');
  assert.ok(Math.abs(inOrder.exit - 8) < 1e-9, `at 80% of 40 kept: ${inOrder.exit}`);
  assert.equal((inOrder.exitAt - from) / 60_000, 1_360, 'the first reading offered at 8 or under');
  assert.deepEqual([typedBackwards.exit, typedBackwards.exitAt, typedBackwards.netUsd], [inOrder.exit, inOrder.exitAt, inOrder.netUsd], 'the same trade however the steps were typed');
});

test('[critical] two strikes level on the rule: the nearer the money, whichever order the board came in', () => {
  const row = (cp: 'C' | 'P', strike: number, delta: number, bid: number): BoardRow => ({ at: 0, cp, strike, spot: 84_000, bid, ask: bid + 2, mark: bid, delta });
  const puts = [row('P', 82_800, -0.04, 30), row('P', 83_000, -0.05, 30), row('P', 82_600, -0.03, 30)];
  for (const board of [puts, [...puts].reverse(), [puts[1]!, puts[2]!, puts[0]!]]) {
    assert.equal(pickStrike(board, 'P', { rule: 'premium', value: 50 })!.strike, 83_000, 'three puts bid at 30: the nearest');
  }
  const calls = [row('C', 85_400, 0.08, 40), row('C', 85_200, 0.08, 44)];
  assert.equal(pickStrike(calls, 'C', { rule: 'delta', value: 0.1 })!.strike, 85_200);
  assert.equal(pickStrike([...calls].reverse(), 'C', { rule: 'delta', value: 0.1 })!.strike, 85_200, 'the same delta: the nearer call');
});

test('[critical] every signal not traded is named with its reason, and they add up: signals = traded + not traded', () => {
  const up = perp([[0, 84_000], [1_439, 84_100]]);
  const board = byTime([...ladder('P', 83_200, -0.09, [[0, 40], [1_435, 4]])]);     // no call on the board at all
  const signals = [sig(100), sig(300, { tf: '1h' }), sig(400, { dir: -1, stop: 84_300, target: 83_500, method: 'fade' }), sig(1_438, { tf: '5m' })];
  const r = simulateDay({ from, to, signals, bars: up, board, params: P });
  assert.equal(r.trades.length, 2);
  assert.deepEqual(r.refused.map((x) => [x.signal.method, x.signal.tf, x.why]), [['fade', '15m', 'no-strike'], ['breakout', '5m', 'outside-window']]);
  assert.equal(r.trades.length + r.refused.length, signals.length);
  assert.equal(Object.values(r.skipped).reduce((a, b) => a + b, 0), r.refused.length);
});

test('the fee on the way out is worked from BTC as it stood at the exit, not at the entry', () => {
  // a put sold at 300 with BTC at 84,000; the perp's stop is hit about minute 30 and it is bought back at the next
  // reading, where the board has BTC at 60,000. On both fills the notional fee (0.01% of BTC) is the smaller, so BTC
  // is what the fee is: 0.084 in, 0.060 out.
  const rows = byTime(contract('P', 83_200, -0.09, [[0, 300], [100, 500], [1_435, 500]])).map((r) => (r.at >= from + 5 * MIN ? { ...r, spot: 60_000 } : r));
  const bars = perp([[0, 84_000], [100, 83_000], [1_439, 83_000]]);
  const t = simulateDay({ from, to, signals: [sig(0)], bars, board: rows, params: { ...P, targetPct: 0, stopPct: 0 } }).trades[0]!;
  assert.equal(t.by, 'perp-sl');
  const inUsd = fillChargesUsd({ price: t.entry, contracts: 10, contractValue: 0.001, spot: 84_000 }).totalUsd;
  const outUsd = fillChargesUsd({ price: t.exit, contracts: 10, contractValue: 0.001, spot: 60_000 }).totalUsd;
  assert.ok(Math.abs(inUsd - 0.084 * 1.18) < 1e-9 && Math.abs(outUsd - 0.06 * 1.18) < 1e-9, 'the notional fee binds on both');
  assert.ok(Math.abs(t.chargesUsd - (inUsd + outUsd)) < 1e-9, `charges ${t.chargesUsd}`);
  assert.ok(Math.abs(t.netUsd - ((t.entry - t.exit) * 10 * 0.001 - inUsd - outUsd)) < 1e-9);
});

// ------------------------------------------------------------ a minute at a time

test('[critical] a board a minute at a time: the desk\'s own minutes first, its five-minute readings where a minute has none, and Delta\'s mark between -- with the last reading\'s spread around it', async () => {
  const { minuteBoard } = await import('../../src/report/signal-backtest.js');
  const row = (min: number, bid: number | null, o: Partial<BoardRow> = {}): BoardRow => ({ at: from + min * MIN, cp: 'P', strike: 83_200, spot: 84_000, bid, ask: bid === null ? null : bid + 3, mark: bid === null ? 41 : bid + 1, delta: -0.09, oi: 500, ...o });
  const five = [row(0, 40), row(5, 38), row(10, 36)];
  const mark = (min: number, open: number) => ({ cp: 'P' as const, strike: 83_200, at: from + min * MIN, open });

  // Delta's mark at minutes 1 to 4 and 6: each estimated from the reading before it (mark 1 over the bid, the offer 2 over the mark)
  const est = minuteBoard({ five, own: [], marks: [mark(0, 99), mark(1, 40.5), mark(2, 39.5), mark(6, 37.2), mark(21, 30)] }).board;
  assert.deepEqual(est.map((r) => (r.at - from) / MIN), [0, 1, 2, 5, 6, 10], 'oldest first; minute 0 has a reading of its own; minute 21 is over ten minutes from any');
  const m1 = est[1]!;
  assert.deepEqual([m1.est, m1.mark, m1.bid, m1.ask, m1.delta, m1.spot, m1.oi], [true, 40.5, 39.5, 42.5, -0.09, 84_000, 500], 'the mark is Delta\'s; the spread, the delta and BTC are the last reading\'s');
  assert.equal(est[0]!.est, undefined, 'a reading of the desk\'s own is not an estimate');
  assert.deepEqual([est[4]!.bid, est[4]!.ask], [37.2 - 1, 37.2 + 2], 'minute 6 from the reading at minute 5, not the one at 10 that came after');

  // the desk's own minute wins over the five-minute reading of the same minute, and over Delta's mark
  const own = minuteBoard({ five, own: [row(5, 38.4), row(6, 37.9)], marks: [mark(6, 12)] }).board;
  assert.deepEqual(own.filter((r) => (r.at - from) / MIN >= 5).map((r) => [(r.at - from) / MIN, r.bid, r.est ?? false]), [[5, 38.4, false], [6, 37.9, false], [10, 36, false]]);

  // no bid at the last reading: none is invented; a mark under the spread is a bid of nothing, never a negative one
  const thin = minuteBoard({ five: [row(0, null), row(5, 2, { mark: 6, ask: 9 })], own: [], marks: [mark(1, 40), mark(6, 3)] }).board;
  assert.deepEqual([thin[1]!.bid, thin[1]!.ask], [null, null]);
  assert.deepEqual([thin[3]!.bid, thin[3]!.ask], [0, 6]);

  // what a day was priced on: four fifths of its minutes with a reading is "a minute at a time"
  const day = (step: number) => Array.from({ length: Math.floor(1_440 / step) }, (_, i) => row(i * step, 40));
  const marks = Array.from({ length: 1_440 }, (_, i) => mark(i, 41));
  assert.equal(minuteBoard({ five: day(5), own: [], marks: [] }).grain, '5m');
  assert.equal(minuteBoard({ five: day(5), own: [], marks }).grain, 'mark-1m');
  assert.equal(minuteBoard({ five: day(5), own: day(1), marks: [] }).grain, 'own-1m');
  assert.equal(minuteBoard({ five: day(5), own: day(1).slice(0, 360), marks: [] }).grain, '5m', 'six hours of the desk\'s minutes is not the day');
  assert.equal(minuteBoard({ five: [], own: [], marks }).grain, '5m', 'marks alone, with no reading to take a spread from, are no board');
});

test('[critical] on a board a minute at a time the exit is priced at the minute after the perp\'s, not up to five minutes on -- and the option\'s own target is seen the minute it is reached', async () => {
  const { minuteBoard } = await import('../../src/report/signal-backtest.js');
  // the perp falls through the stop (83,700) at about minute 60 of a slide from 84,000 to 83,500 over minutes 0 to 100
  const bars = perp([[0, 84_000], [100, 83_500], [1_439, 83_500]]);
  const five = contract('P', 83_200, -0.09, [[0, 40], [58, 40], [70, 100], [1_435, 100]]);        // the put jumps from 40 to 100 over minutes 58 to 70
  const marks = Array.from({ length: 1_440 }, (_, m) => ({ cp: 'P' as const, strike: 83_200, at: from + m * MIN, open: (m <= 58 ? 40 : m >= 70 ? 100 : 40 + (m - 58) * 5) + 1 }));
  const p = { ...P, targetPct: 0, stopPct: 0 };
  const coarse = simulateDay({ from, to, signals: [sig(0)], bars, board: five, params: p }).trades[0]!;
  const fine = simulateDay({ from, to, signals: [sig(0)], bars, board: minuteBoard({ five, own: [], marks }).board, params: p }).trades[0]!;
  assert.deepEqual([coarse.by, fine.by], ['perp-sl', 'perp-sl']);
  assert.equal(coarse.exitAt, fine.exitAt, 'the perp\'s own minute is the same');
  const stopMinute = (fine.exitAt - from) / MIN;
  assert.ok(stopMinute > 55 && stopMinute < 62, `the stop about minute 60: ${stopMinute}`);
  // five-minute record: the reading at minute 65 (bid 75, offered 77); a minute at a time: that very minute's
  const nextFive = Math.ceil(stopMinute / 5) * 5;
  assert.equal(coarse.exit, (nextFive <= 58 ? 40 : 40 + (nextFive - 58) * 5) + 2);
  assert.ok(fine.exit < coarse.exit, `bought back sooner, for less: ${fine.exit} against ${coarse.exit}`);
  assert.ok(Math.abs(fine.exit - ((stopMinute <= 58 ? 40 : 40 + (stopMinute - 58) * 5) + 1 + 1)) < 1e-9, 'Delta\'s mark that minute, with the offer the last reading had over its mark (1)');

  // the option's own stop at +100% (an offer of 80): seen at minute 66 a minute at a time, at minute 70 on the five-minute record
  const stopped = { ...P, targetPct: 0, stopPct: 1 };
  const quiet = perp([[0, 84_000], [1_439, 84_100]]);
  const c = simulateDay({ from, to, signals: [sig(0)], bars: quiet, board: five, params: stopped }).trades[0]!;
  const f = simulateDay({ from, to, signals: [sig(0)], bars: quiet, board: minuteBoard({ five, own: [], marks }).board, params: stopped }).trades[0]!;
  assert.deepEqual([c.by, (c.exitAt - from) / MIN, c.exit], ['option-sl', 70, 102]);
  assert.deepEqual([f.by, (f.exitAt - from) / MIN], ['option-sl', 66]);
  assert.ok(f.exit >= 80 && f.exit < 86, `at the first minute's offer over the stop: ${f.exit}`);
});

test('[critical] the perp exits while the offer is already under the option\'s own target: the target\'s order filled first, at its own price', async () => {
  const { planOfParams } = await import('../../src/report/signal-backtest.js');
  // the put, sold at 40, is offered at 30 until minute 55 and at 12 from the reading at minute 60 -- a fall through the
  // 50% target (20) between two readings; the perp reaches its target (84,500) in minute 57
  const five = [...contract('P', 83_200, -0.09, [[0, 40], [5, 28], [55, 28], [60, 10], [1_435, 10]])];
  const bars = perp([[0, 84_000], [50, 84_100], [57, 84_600], [1_439, 84_600]]);
  const t = simulateDay({ from, to, signals: [sig(0)], bars, board: five, plan: planOfParams({ ...P, targetPct: 0.5, stopPct: 0 }, { from, to }) }).trades[0]!;
  assert.equal(t.by, 'option-tgt', 'not the perp\'s exit: the option\'s own order was there first');
  assert.ok(Math.abs(t.exit - 20) < 1e-9, `at its own 20, not the 12 offered afterwards: ${t.exit}`);
  assert.equal((t.exitAt - from) / MIN, 60);
  assert.equal(t.perpPts, 500, 'the perp\'s own trade is still its target');
  // with no option target there is no such order: bought back at the offer when the perp exits
  const plain = simulateDay({ from, to, signals: [sig(0)], bars, board: five, plan: planOfParams({ ...P, targetPct: 0, stopPct: 0 }, { from, to }) }).trades[0]!;
  assert.deepEqual([plain.by, plain.exit], ['perp-tgt', 12]);
  // and an offer over the target at the perp's exit is the perp's exit, as before
  const over = simulateDay({ from, to, signals: [sig(0)], bars, board: five, plan: planOfParams({ ...P, targetPct: 0.9, stopPct: 0 }, { from, to }) }).trades[0]!;
  assert.deepEqual([over.by, over.exit], ['perp-tgt', 12]);
});

// ------------------------------------------------------------ several backtests as one account

test('[critical] several backtests on one account: one line in the desk\'s order, and one limit on what is open across all of them', async () => {
  const { planOfParams, simulateTogether, deskCapsOf } = await import('../../src/report/signal-backtest.js');
  // the perp reaches neither level; a put and a call, each sold at 40 and held to the end of the day
  const bars = perp([[0, 84_000], [1_439, 84_050]]);
  const board = byTime([...ladder('P', 83_200, -0.09, [[0, 40], [1_435, 30]]), ...ladder('C', 85_000, 0.09, [[0, 40], [1_435, 30]])]);
  const plan = planOfParams({ ...P, targetPct: 0, stopPct: 0 }, { from, to });
  // two books: one of 15m signals, one of 4h -- a BUY each at minute 10, and another each at minute 20
  const quick = [sig(10, { tf: '15m' }), sig(20, { tf: '15m' })];
  const slow = [sig(10, { tf: '4h', method: 'pullback' }), sig(20, { tf: '4h', method: 'pullback' })];
  const books = [{ signals: quick, plan }, { signals: slow, plan }];

  // each on its own: nothing to share -- all four are traded, four open at once
  const alone = simulateTogether({ from, to, bars, board, books });
  assert.deepEqual(alone.map((x) => x.trades.length), [2, 2]);

  // one account, at most 3 open: the 4h signals go first at each minute, as the desk's queue takes them
  const three = simulateTogether({ from, to, bars, board, books, shared: deskCapsOf({ deskMax: 3, cePct: 100, pePct: 100 }) });
  assert.deepEqual(three.map((x) => x.trades.length), [1, 2], 'the 15m book gets the one place left at minute 10, and none at minute 20');
  assert.deepEqual(three.map((x) => [x.skipped['desk-limit'], x.skipped['side-limit']]), [[1, 0], [0, 0]]);
  assert.deepEqual(three[0]!.refused.map((r) => [(r.signal.filledAt - from) / MIN, r.why]), [[20, 'desk-limit']]);
  const openAt = (t: number, outs: typeof three) => outs.flatMap((x) => x.trades).filter((x) => x.signal.filledAt <= t && x.exitAt > t).length;
  assert.equal(openAt(from + 30 * MIN, three), 3, 'never more than the account holds');
  assert.equal(openAt(from + 30 * MIN, alone), 4);

  // the sides are the account's too: at most 4 open, each side half of it -- two puts, and the third BUY finds its side full
  const calls = [{ signals: [sig(15, { dir: -1, stop: 84_300, target: 83_500, tf: '1h' })], plan }];
  const sided = simulateTogether({ from, to, bars, board, books: [...books, ...calls], shared: deskCapsOf({ deskMax: 4, cePct: 50, pePct: 50 }) });
  assert.deepEqual(sided.map((x) => x.trades.length), [1, 1, 1], 'a put for each book at minute 10, the call at minute 15');
  assert.deepEqual(sided.map((x) => x.skipped['side-limit']), [1, 1, 0], 'both BUYs at minute 20: the puts are at their two');

  // a place is free again when a trade ends: the same three places, turned over
  const short = planOfParams({ ...P, targetPct: 0, stopPct: 0 }, { from, to });
  const falls = perp([[0, 84_000], [100, 83_500], [1_439, 83_500]]);          // every BUY is stopped about minute 60
  const later = [{ signals: [sig(10, { tf: '15m' }), sig(200, { tf: '15m', stop: 83_000 })], plan: short }, { signals: [sig(10, { tf: '4h' }), sig(200, { tf: '4h', stop: 83_000 })], plan: short }];
  const turned = simulateTogether({ from, to, bars: falls, board, books: later, shared: deskCapsOf({ deskMax: 2, cePct: 100, pePct: 100 }) });
  assert.deepEqual(turned.map((x) => x.trades.length), [2, 2], 'two at minute 10, stopped by minute 61, and two more at minute 200');
});

/**
 * Several trades may share a contract (one trade per contract, 14 Oct 2026 morning, was lifted that day: the churn it
 * answered was the desk reading a hundred of its open orders, and it cut the strategies to one trade in six).
 */
test('[critical] no-entry windows in the settings (15 Oct 2026): a signal filling inside one is skipped as the runner skips it, and the live rules carry them', async () => {
  const { strategyOfParams } = await import('../../src/report/signal-backtest.js');
  const one = byTime(contract('P', 83_200, -0.09, [[0, 40], [1_435, 10]]));
  const flat = perp([[0, 84_000], [1_439, 84_000]]);
  // minute 31 is 6:01 PM IST, minute 91 is 7:01 PM (the day starts at 5:30 PM)
  const signals = [sig(31), sig(91)];
  const free = simulateDay({ from, to, params: P, signals, bars: flat, board: one });
  assert.equal(free.trades.length, 2);
  const blocked = simulateDay({ from, to, params: { ...P, noEntry: { on: true, windows: [{ from: '18:00', to: '18:30' }] } }, signals, bars: flat, board: one });
  assert.deepEqual(blocked.trades.map((t) => t.signal.filledAt), [sig(91).filledAt], 'the 6:01 PM signal is inside 6:00 - 6:30 PM');
  assert.equal(blocked.skipped['no-entry-window'], 1);
  // switched off, the times kept: no window
  const off = simulateDay({ from, to, params: { ...P, noEntry: { on: false, windows: [{ from: '18:00', to: '18:30' }] } }, signals, bars: flat, board: one });
  assert.equal(off.trades.length, 2);
  // the live rules made of these settings carry the same windows (the live check compares like with like)
  assert.deepEqual(strategyOfParams({ ...P, noEntry: { on: true, windows: [{ from: '18:00', to: '18:30' }] } }, null, null).config.noEntry, { on: true, windows: [{ from: '18:00', to: '18:30' }] });
  assert.deepEqual(strategyOfParams(P, null, null).config.noEntry, { on: false, windows: [] });
});

test('[critical] signals while the first is open share its strike: each its own trade', async () => {
  const { simulateTogether, deskCapsOf } = await import('../../src/report/signal-backtest.js');
  // Two puts inside delta 0.10: 83,200 nearer the money, 83,000 further out. Both decay all day; the perp never reaches a level.
  const two = byTime([...contract('P', 83_200, -0.09, [[0, 40], [1_435, 10]]), ...contract('P', 83_000, -0.07, [[0, 30], [1_435, 8]])]);
  const flat = perp([[0, 84_000], [1_439, 84_000]]);
  const r = simulateDay({ from, to, params: P, signals: [sig(31), sig(61), sig(91)], bars: flat, board: two });
  assert.deepEqual(r.trades.map((t) => t.strike), [83_200, 83_200, 83_200], 'the rule\'s strike, each time');
  assert.equal(r.skipped['no-strike'], 0);
  // Two books of one account, two different signals: both sell the nearer.
  const books = [{ signals: [sig(31)], plan: planOf() }, { signals: [sig(32, { method: 'pullback' })], plan: planOf() }];
  const together = simulateTogether({ from, to, bars: flat, board: two, books, shared: deskCapsOf({ deskMax: 10, cePct: 100, pePct: 100 }) });
  assert.deepEqual(together.map((o) => o.trades.map((t) => t.strike)), [[83_200], [83_200]]);
  // And the same signal in two books of one account: both trade it, as two strategies on the desk both may.
  const same = sig(31);
  const both = simulateTogether({ from, to, bars: flat, board: two, books: [{ signals: [same], plan: planOf() }, { signals: [same], plan: planOf() }], shared: deskCapsOf({ deskMax: 10, cePct: 100, pePct: 100 }) });
  assert.deepEqual(both.map((o) => o.trades.length), [1, 1]);
});


test('[critical] ATM IV at a reading: the call\'s and the put\'s nearest the money averaged, the one there is alone, nothing from a missing or zero IV', async () => {
  const { atmIvOf } = await import('../../src/report/signal-backtest.js');
  assert.deepEqual(atmIvOf([
    { at: 2, cp: 'C', iv: 50 }, { at: 2, cp: 'P', iv: 54 },
    { at: 1, cp: 'C', iv: 40 }, { at: 1, cp: 'P', iv: null },
    { at: 3, cp: 'C', iv: 0 }, { at: 3, cp: 'P', iv: null },
  ]), [{ at: 1, iv: 40 }, { at: 2, iv: 52 }], 'oldest first; a reading with no IV at all is not a reading');
});

test('[critical] volatility by ATM IV: thirds of the five days before, in the same hour of the day -- low, medium, high', async () => {
  const { ivReader } = await import('../../src/report/signal-backtest.js');
  const H = 3_600_000;
  // Five days before, a reading every five minutes; IV 40-60 in the evening's first hour, 80-100 eight hours on.
  const prior = Array.from({ length: 5 }, (_, d) => from - (d + 1) * 86_400_000).flatMap((day0) => Array.from({ length: 12 }, (_, i) => [
    { at: day0 + i * 5 * MIN, iv: 40 + (i * 20) / 11 },
    { at: day0 + 8 * H + i * 5 * MIN, iv: 80 + (i * 20) / 11 },
  ]).flat());
  const at = (h: number, m: number) => from + h * H + m * MIN;
  const read = (iv: number, h: number) => ivReader([{ at: at(h, 10), iv }], prior)(at(h, 12));
  assert.equal(read(42, 0), 'low');
  assert.equal(read(50, 0), 'medium');
  assert.equal(read(59, 0), 'high');
  // The same 59 eight hours into the day is LOW: that hour's own past, not the day's, is what it is held to.
  assert.equal(read(59, 8), 'low', 'an IV is compared with the same hour of the days before');
  assert.equal(read(99, 8), 'high');
  // An hour the days before have too few readings of: cut from all of them together.
  assert.equal(read(75, 4), 'medium', 'pooled: between the thirds of every reading');
});

test('[critical] volatility by ATM IV never guesses: no reading, a stale one, or too few days before is Unknown -- never Low', async () => {
  const { ivReader, IV_STALE_MS, IV_MIN_READINGS } = await import('../../src/report/signal-backtest.js');
  const prior = Array.from({ length: 60 }, (_, i) => ({ at: from - 86_400_000 + i * 5 * MIN, iv: 40 + i }));
  const today = [{ at: from + 60 * MIN, iv: 10 }];
  assert.equal(ivReader(today, prior)(from + 61 * MIN), 'low', 'a fresh reading under the low third');
  assert.equal(ivReader(today, prior)(from + 59 * MIN), null, 'before the first reading of the day: nothing to read');
  assert.equal(ivReader(today, prior)(from + 60 * MIN + IV_STALE_MS + 1), null, 'a reading too old for the fill');
  assert.equal(ivReader(today, prior)(from + 60 * MIN + IV_STALE_MS), 'low', 'at the limit it still counts');
  assert.equal(ivReader([], prior)(from + 61 * MIN), null, 'a day with no IV at all');
  assert.equal(ivReader(today, prior.slice(0, IV_MIN_READINGS - 1))(from + 61 * MIN), null, 'too few days before to cut levels from');
  assert.equal(ivReader(today, [])(from + 61 * MIN), null);
});

test('[critical] volatility by ATM IV knows nothing it could not have known: later readings, and the day itself, change no earlier level', async () => {
  const { ivReader } = await import('../../src/report/signal-backtest.js');
  const prior = Array.from({ length: 60 }, (_, i) => ({ at: from - 86_400_000 + i * 5 * MIN, iv: 40 + i / 3 }));
  const calm = [{ at: from + 30 * MIN, iv: 50 }];
  const thenWild = [...calm, { at: from + 35 * MIN, iv: 400 }, { at: from + 40 * MIN, iv: 500 }];
  const t = from + 33 * MIN;
  assert.equal(ivReader(calm, prior)(t), 'medium');
  assert.equal(ivReader(thenWild, prior)(t), 'medium', 'a storm after the fill is not seen at the fill');
  assert.equal(ivReader(thenWild, prior)(from + 36 * MIN), 'high', 'and is seen once it has been read');
  // The cut-offs are the days before alone: the day's own readings, however wild, do not move them.
  assert.equal(ivReader([...thenWild, { at: from + 600 * MIN, iv: 1 }], prior)(t), 'medium');
});

test('[critical] the stop by volatility: each trade the stop of its level at the fill; a level not known keeps the plan\'s own', async () => {
  const flat = perp([[0, 84_000], [1_439, 84_100]]);
  // Sold at 40; offered at 102 at minute 300 (+155%), then down to 3, under the 4 the target rests at: a +150% stop is
  // hit, +200% and the plan's +300% are not, and those trades end at their target.
  const board = ladder('P', 83_200, -0.09, [[0, 40], [295, 40], [300, 100], [310, 30], [1_435, 1]]);
  const plan = { ...planOf(), stopPctByVol: { low: 2.5, medium: 2, high: 1.5 } };
  const levelAt = (min: number) => (min < 100 ? 'high' as const : min < 200 ? 'low' as const : null);
  const r = simulateDay({ from, to, signals: [sig(30), sig(130), sig(230)], bars: flat, board, plan, volAt: (at) => levelAt((at - from) / MIN) });
  assert.deepEqual(r.trades.map((t) => [t.vol, t.by]), [['high', 'option-sl'], ['low', 'option-tgt'], [null, 'option-tgt']]);
  assert.ok(Math.abs(r.trades[0]!.optStop! - r.trades[0]!.entry * 2.5) < 1e-9, 'high: +150%, two and a half times the premium');
  assert.ok(Math.abs(r.trades[1]!.optStop! - r.trades[1]!.entry * 3.5) < 1e-9, 'low: +250%');
  assert.ok(Math.abs(r.trades[2]!.optStop! - r.trades[2]!.entry * 4) < 1e-9, 'unknown: the plan\'s own +300%');
  // Without it, the plan's own stop for every trade -- and the same signals traded.
  const fixed = simulateDay({ from, to, signals: [sig(30), sig(130), sig(230)], bars: flat, board, plan: planOf(), volAt: (at) => levelAt((at - from) / MIN) });
  assert.deepEqual(fixed.trades.map((t) => t.by), ['option-tgt', 'option-tgt', 'option-tgt']);
  assert.deepEqual(fixed.trades.map((t) => t.signal.filledAt), r.trades.map((t) => t.signal.filledAt));
});

test('[critical] the strike and the lots by volatility: each trade its level\'s delta and lots; a level not known keeps the plan\'s own', async () => {
  const { planOfStrategy, strategyOfParams } = await import('../../src/report/signal-backtest.js');
  const flat = perp([[0, 84_000], [1_439, 84_100]]);
  // Two puts: 0.09 out at 83,200 and 0.06 out at 82,600, both bid 40 all day.
  const board = byTime([...contract('P', 83_200, -0.09, [[0, 40], [1_435, 30]]), ...contract('P', 82_600, -0.06, [[0, 40], [1_435, 30]])]);
  const span = { from, to };
  const deltaPick = (d: number) => planOfStrategy(strategyOfParams({ ...P, rule: 'delta', value: d }, null, null), span).pick;
  const plan = { ...planOf(), pickByVol: { low: deltaPick(0.12), medium: deltaPick(0.1), high: deltaPick(0.07) }, lotsByVol: { low: 2, medium: 2, high: 1 } };
  const levelAt = (min: number) => (min < 100 ? 'high' as const : min < 200 ? 'low' as const : null);
  const r = simulateDay({ from, to, signals: [sig(30), sig(130), sig(230)], bars: flat, board, plan, volAt: (at) => levelAt((at - from) / MIN) });
  assert.deepEqual(r.trades.map((t) => [t.vol, t.strike, t.lots]), [['high', 82_600, 1], ['low', 83_200, 2], [null, 83_200, 10]],
    'high: the further strike inside 0.07, one lot; low: the nearer inside 0.12, two; unknown: the settings\' own strike and 10 lots');
});

test('[critical] a strategy that sets its delta by volatility is backtested as the desk trades it: each level its delta, read by its own source; unknown its own delta', async () => {
  const { planOfStrategy, strategyOfParams, ownVolBy } = await import('../../src/report/signal-backtest.js');
  const flat = perp([[0, 84_000], [1_439, 84_100]]);
  const board = byTime([
    ...contract('P', 83_800, -0.16, [[0, 40], [1_435, 30]]), ...contract('P', 83_500, -0.09, [[0, 25], [1_435, 15]]), ...contract('P', 83_200, -0.05, [[0, 12], [1_435, 8]]),
  ]);
  const base = strategyOfParams({ ...P, rule: 'delta', value: 0.12, minPremium: 1 }, null, null);
  const dv = { on: true, by: 'iv' as const, low: 0.18, medium: 0.1, high: 0.08 };
  const st = { ...base, config: { ...base.config, signal: { ...base.config.signal!, deltaByVol: dv } } };
  const levelAt = (min: number) => (min < 100 ? 'low' as const : min < 200 ? 'medium' as const : min < 300 ? 'high' as const : null);
  const r = simulateDay({ from, to, signals: [sig(30), sig(130), sig(230), sig(330)], bars: flat, board, plan: planOfStrategy(st, { from, to }), volAt: (at) => levelAt((at - from) / MIN) });
  assert.deepEqual(r.trades.map((t) => [t.vol, t.strike]), [['low', 83_800], ['medium', 83_500], ['high', 83_200], [null, 83_500]],
    'low ≤ 0.18 sells the 0.16, normal ≤ 0.10 the 0.09, high ≤ 0.08 the 0.05; unknown its own 0.12: the 0.09');
  // Read by its own source, whatever the screen's setting; off, or not by delta, the screen's.
  assert.equal(ownVolBy(st, 'atr'), 'iv');
  assert.equal(ownVolBy({ ...st, config: { ...st.config, signal: { ...st.config.signal!, deltaByVol: { ...dv, on: false } } } }, 'atr'), 'atr');
  assert.equal(ownVolBy({ ...st, config: { ...st.config, strikeRule: 'premium' } }, undefined), undefined);
  // Off: the plan has no picks by level, and every trade is its own delta's.
  const off = simulateDay({ from, to, signals: [sig(30), sig(230)], bars: flat, board, plan: planOfStrategy({ ...st, config: { ...st.config, signal: { ...st.config.signal!, deltaByVol: { ...dv, on: false } } } }, { from, to }), volAt: (at) => levelAt((at - from) / MIN) });
  assert.deepEqual(off.trades.map((t) => t.strike), [83_500, 83_500]);
});

test('[critical] a strategy that sets its SL by volatility is backtested as the desk trades it: each trade its level\'s SL to its exit; unknown its own', async () => {
  const { planOfStrategy, strategyOfParams, ownVolBy } = await import('../../src/report/signal-backtest.js');
  const flat = perp([[0, 84_000], [1_439, 84_100]]);
  // Sold at 40; offered at 102 at minute 300 (+155%), then down to 3: a +150% SL is hit, +200%, +250% and +300% are not.
  const board = ladder('P', 83_200, -0.09, [[0, 40], [295, 40], [300, 100], [310, 30], [1_435, 1]]);
  const base = strategyOfParams({ ...P, stopPct: 3 }, null, null);
  const sv = { on: true, by: 'atr' as const, low: 2.5, medium: 2, high: 1.5 };
  const st = { ...base, config: { ...base.config, signal: { ...base.config.signal!, slByVol: sv } } };
  const levelAt = (min: number) => (min < 100 ? 'high' as const : min < 200 ? 'low' as const : null);
  const r = simulateDay({ from, to, signals: [sig(30), sig(130), sig(230)], bars: flat, board, plan: planOfStrategy(st, { from, to }), volAt: (at) => levelAt((at - from) / MIN) });
  assert.deepEqual(r.trades.map((t) => [t.vol, t.by, Math.round((t.optStop! / t.entry - 1) * 100)]), [['high', 'option-sl', 150], ['low', 'option-tgt', 250], [null, 'option-tgt', 300]]);
  assert.equal(ownVolBy(st, 'iv'), 'atr', 'read by its own source');
  // A stop not by %: nothing by level, and no source of its own.
  const points = { ...st, config: { ...st.config, stopMode: 'points' as const, stopLossPoints: 50 } };
  assert.equal(planOfStrategy(points, { from, to }).stopPctByVol, undefined);
  assert.equal(ownVolBy(points, undefined), undefined);
});

// ------------------------------------------------------------ live parity (18 Oct 2026)

test('[critical] a strategy\'s methods at a moment: the list after the last change before it; before the first change, what that change replaced; no history, its list as it stands', async () => {
  const { methodsAt, ownSignal, strategyOfParams } = await import('../../src/report/signal-backtest.js');
  const base = strategyOfParams({ ...P }, ['15m'], ['breakout', 'pullback']);
  assert.deepEqual(methodsAt(base, from), ['breakout', 'pullback'], 'no history: as it stands');
  const st = { ...base, methodHistory: [
    { at: from + 100 * MIN, before: ['pullback'], after: ['breakout'] },
    { at: from + 300 * MIN, before: ['breakout'], after: ['breakout', 'gamma-wall'] },
  ] };
  assert.deepEqual(methodsAt(st, from + 50 * MIN), ['pullback'], 'before the first change: what it replaced');
  assert.deepEqual(methodsAt(st, from + 100 * MIN), ['breakout'], 'at a change: the new list');
  assert.deepEqual(methodsAt(st, from + 299 * MIN), ['breakout']);
  assert.deepEqual(methodsAt(st, from + 400 * MIN), ['breakout', 'gamma-wall']);
  // The signal check reads it at the signal's own fill, with its way of reading and its time frames as ever.
  const own = ownSignal(st);
  assert.equal(own(sig(50, { method: 'pullback' })), true);
  assert.equal(own(sig(150, { method: 'pullback' })), false, 'dropped at the change');
  assert.equal(own(sig(150, { method: 'breakout' })), true);
  assert.equal(own(sig(150, { method: 'breakout', tf: '1h' })), false, 'not its time frame');
  assert.equal(ownSignal(null)(sig(1)), true, 'no strategy: every signal');
});

test('[critical] a strategy closes what it opened at its exit time, as the desk does -- not at the settlement; one whose exit is the day\'s end is as before', async () => {
  const { planOfStrategy, strategyOfParams } = await import('../../src/report/signal-backtest.js');
  // 17:30 IST start: 22:00 is minute 270, 01:30 is minute 480.
  const board = byTime(contract('P', 83_200, -0.09, [[0, 40], [1_435, 10]]));
  const bars = perp([[0, 84_000], [1_439, 84_100]]);
  const st = strategyOfParams({ ...P, targetPct: 0, stopPct: 0, window: 'custom', hoursFrom: '21:30', hoursTo: '01:30' }, ['15m'], ['breakout']);
  const [t] = simulateDay({ from, to, signals: [sig(271)], plan: planOfStrategy(st, { from, to }), bars, board }).trades;
  assert.deepEqual([t!.by, t!.exitAt], ['window-end', from + 480 * MIN], 'bought back at 1:30 AM, its exit time');
  const allDay = strategyOfParams({ ...P, targetPct: 0, stopPct: 0, window: 'all' }, ['15m'], ['breakout']);
  const [d] = simulateDay({ from, to, signals: [sig(271)], plan: planOfStrategy(allDay, { from, to }), bars, board }).trades;
  assert.equal(d!.exitAt, from + 1_435 * MIN, 'exit at the day\'s end: the last reading, as before');
});

test('[critical] every setting is part of what a worked day is kept under: change any one, and it is another backtest -- never the last one\'s answer', async () => {
  const { paramsKey } = await import('../../src/report/signal-backtest.js');
  const base: BacktestParams = {
    ...DEFAULT_PARAMS, window: 'custom', hoursFrom: '21:30', hoursTo: '03:00', deskMax: 20, cePct: 80, pePct: 80,
    slMin: 100, slMax: 900, tgtMin: 100, tgtMax: 900, targetSteps: [{ at: '23:30', pct: 0.75 }], vol: 'low', volBy: 'atr', minPremium: 10,
    noEntry: { on: true, windows: [{ from: '00:30', to: '01:00' }] },
    strikeBlocks: [{ at: '01:30', strikeRule: 'delta', strikeStep: 0, premium: { mode: 'atMost', usd: 50 }, delta: { max: 0.08 } }],
  };
  const changes: [string, Partial<BacktestParams>][] = [
    ['rule', { rule: 'premium' }], ['value', { value: 0.12 }], ['lots', { lots: 3 }], ['targetPct', { targetPct: 0.8 }], ['stopPct', { stopPct: 1.5 }],
    ['window', { window: 'desk' }], ['hoursFrom', { hoursFrom: '22:00' }], ['hoursTo', { hoursTo: '04:00' }],
    ['deskMax', { deskMax: 30 }], ['cePct', { cePct: 70 }], ['pePct', { pePct: 70 }],
    ['slMin', { slMin: 150 }], ['slMax', { slMax: 800 }], ['tgtMin', { tgtMin: 150 }], ['tgtMax', { tgtMax: 800 }],
    ['targetSteps', { targetSteps: [{ at: '23:30', pct: 0.8 }] }], ['vol', { vol: 'high' }], ['volBy', { volBy: 'iv' }], ['minPremium', { minPremium: 15 }],
    ['noEntry', { noEntry: { on: true, windows: [{ from: '00:30', to: '01:30' }] } }], ['noEntry off', { noEntry: { on: false, windows: [] } }],
    ['strikeBlocks', { strikeBlocks: [{ ...base.strikeBlocks![0]!, delta: { max: 0.06 } }] }], ['strikeBlocks at', { strikeBlocks: [{ ...base.strikeBlocks![0]!, at: '02:00' }] }],
  ];
  const seen = new Set([paramsKey(base)]);
  for (const [what, over] of changes) {
    const k = paramsKey({ ...base, ...over });
    assert.ok(!seen.has(k), `${what}: the same key as another setting`);
    seen.add(k);
  }
  // And every field a backtest's settings have is one of those changed above: a new setting must be added here, and to the key.
  const named = new Set(changes.map(([w]) => w.split(' ')[0]!));
  for (const k of Object.keys(base)) assert.ok(named.has(k), `${k} is not checked`);
});

test('[critical] the perp apart from the options: points after the round trip\'s fees, and R over the signal\'s own risk', () => {
  // 0.05% a side and 18% GST on it: 0.118% of the fill a round trip -- 99.12 points at 84,000
  assert.ok(Math.abs(perpFeePts(84_000) - 99.12) < 1e-9);
  // a BUY filled at 84,000, stop 83,700 (300 of risk), out at its target +500: 1.67R before fees, 1.34R after
  const win = perpOf({ perpPts: 500, signal: { fillPrice: 84_000, stop: 83_700 } });
  assert.ok(Math.abs(win.netPts - 400.88) < 1e-9 && Math.abs(win.r - 500 / 300) < 1e-9 && Math.abs(win.rNet - 400.88 / 300) < 1e-9);
  // stopped out: -1R before fees, worse after
  const loss = perpOf({ perpPts: -300, signal: { fillPrice: 84_000, stop: 83_700 } });
  assert.deepEqual([loss.r, Math.round(loss.rNet * 1000) / 1000], [-1, -1.33]);
  // a small win the fees turn into a loss: a good perp line is not a good options one, nor even a good perp one
  assert.ok(perpOf({ perpPts: 60, signal: { fillPrice: 84_000, stop: 83_700 } }).netPts < 0);
  assert.equal(perpOf({ perpPts: 60, signal: { fillPrice: 84_000, stop: 84_000 } }).r, 0, 'no risk, no R');
});

/*
 * The perp's SL and TGT widened with volatility (owner, 18 Oct 2026: "when the signal comes its PERP SL and TGT are the
 * least; as volatility rises they widen -- checked at every 1m close"; asked: "stay at the widest so far").
 */
test('[critical] widening: each level at least k ATRs from the entry -- never nearer than the signal\'s own, nor than the widest so far', () => {
  const lv = { stop: 83_700, target: 84_500 };                       // a BUY at 84,000: SL 300 away, TGT 500
  // ATR 20: 10× is 200 -- under the signal's 300 and 500: the signal's own stand
  assert.deepEqual(widenAfter(lv, { dir: 1, entry: 84_000, atr: 20, slAtr: 10, tgtAtr: 20 }), lv);
  // ATR 40: 400 and 800 -- wider than the signal's: both widened, from the entry
  const wide = widenAfter(lv, { dir: 1, entry: 84_000, atr: 40, slAtr: 10, tgtAtr: 20 });
  assert.deepEqual(wide, { stop: 83_600, target: 84_800 });
  // calm again, ATR 20: kept at the widest
  assert.deepEqual(widenAfter(wide, { dir: 1, entry: 84_000, atr: 20, slAtr: 10, tgtAtr: 20 }), wide);
  // a SELL mirrors it; one level only where only one is asked
  assert.deepEqual(widenAfter({ stop: 84_300, target: 83_500 }, { dir: -1, entry: 84_000, atr: 40, slAtr: 10, tgtAtr: 0 }), { stop: 84_400, target: 83_500 });
  // no ATR yet: nothing moves
  assert.deepEqual(widenAfter(lv, { dir: 1, entry: 84_000, atr: Number.NaN, slAtr: 10, tgtAtr: 20 }), lv);
  // Wilder's ATR of the minutes: none until 14, then each minute's true range smoothed
  const flatAtr = minuteAtr(perp([[0, 84_000], [1_439, 84_000]]));
  assert.ok(Number.isNaN(flatAtr[13]!) && Math.abs(flatAtr[14]! - 4) < 1e-9 && Math.abs(flatAtr[500]! - 4) < 1e-9);
});

/** A minute bar of a given range around its close: the volatility of the test's day, a minute at a time. */
function wild(path: [number, number][], range: (minute: number) => number): ReturnType<typeof perp> {
  return perp(path).map((b, i) => ({ ...b, high: b.close + range(i) / 2, low: b.close - range(i) / 2 }));
}

test('[critical] widening: a stop the signal\'s own would have hit in a volatile hour is held wider -- and a hit inside a minute is taken then', () => {
  // A BUY at minute 30 (fill 84,000, SL 83,700): from minute 60 the minutes swing 120 points; the price dips to 83,660 at 200
  const range = (m: number) => (m >= 60 ? 120 : 4);
  const bars = wild([[0, 84_000], [150, 84_000], [200, 83_720], [260, 84_000], [1_439, 84_000]], range);
  const board = contract('P', 83_200, -0.09, [[0, 40], [1_435, 30]]);
  const own = simulateDay({ from, to, params: P, signals: [sig(30)], bars, board }).trades[0]!;
  assert.equal(own.by, 'perp-sl', 'the signal\'s own 83,700 is touched in the volatile dip');
  // 1m ATR about 120 from the swings: 4× is about 480 -- the SL widened to about 83,520, the dip passes over it
  const widened = simulateDay({ from, to, params: { ...P, widenSlAtr: 4 }, signals: [sig(30)], bars, board }).trades[0]!;
  assert.notEqual(widened.by, 'perp-sl');
  assert.ok((widened.perpStopEnd ?? 0) < 83_600, `widened to ${widened.perpStopEnd}`);
  // never nearer than the signal's own: the quiet start leaves it where it was
  const quiet = simulateDay({ from, to, params: { ...P, widenSlAtr: 4 }, signals: [sig(30)], bars: perp([[0, 84_000], [1_439, 84_000]]), board }).trades[0]!;
  assert.equal(quiet.perpStopEnd, undefined, '4× an ATR of 4 is 16: the signal\'s 300 stands');
  assert.notEqual(paramsKey({ ...P, widenSlAtr: 4 }), paramsKey(P));
});

test('[critical] widening, back when calm: widened only while the 1m ATR is over its level at the fill, then the signal\'s own again', () => {
  const own = { stop: 83_700, target: 84_500 }, wide = { stop: 83_550, target: 84_500 };
  const at = (atr: number) => widenAfter(wide, { dir: 1, entry: 84_000, atr, slAtr: 10, tgtAtr: 0, mode: 'calm', baseAtr: 20, own });
  assert.deepEqual(at(45), { stop: 83_550, target: 84_500 }, 'still volatile: the widest kept');
  assert.deepEqual(at(20), own, 'back to the ATR at the fill: the signal\'s own');
  assert.deepEqual(widenAfter(wide, { dir: 1, entry: 84_000, atr: 20, slAtr: 10, tgtAtr: 0, mode: 'widest', baseAtr: 20, own }), wide, 'kept at the widest, as asked by default');
});

test('[critical] widening, the two side by side: a dip after the volatile hour passes over the widest, and is a stop once calm', () => {
  // The fill at minute 30 with the minutes 20 wide (ATR about 20); 120 wide from 60 to 180; 4 wide after. A dip to 83,690 at 300.
  const range = (m: number) => (m < 60 ? 20 : m < 180 ? 120 : 4);
  const bars = wild([[0, 84_000], [250, 84_000], [300, 83_690], [350, 84_000], [1_439, 84_000]], range);
  const board = contract('P', 83_200, -0.09, [[0, 40], [1_435, 30]]);
  const run = (o: Partial<BacktestParams>) => simulateDay({ from, to, params: { ...P, ...o }, signals: [sig(30)], bars, board }).trades[0]!;
  const widest = run({ widenSlAtr: 4 }), calm = run({ widenSlAtr: 4, widenMode: 'calm' }), signalOwn = run({});
  assert.equal(signalOwn.by, 'perp-sl', 'the signal\'s own 83,700 is touched by the dip');
  assert.notEqual(widest.by, 'perp-sl', 'kept at the widest (about 83,520): the dip passes over it');
  assert.equal(calm.by, 'perp-sl', 'calm again by then: back at 83,700, and the dip takes it');
  assert.ok(Math.abs(calm.perpPts + 300) < 1e-9, 'out at the signal\'s own stop');
  assert.notEqual(paramsKey({ ...P, widenSlAtr: 4, widenMode: 'calm' }), paramsKey({ ...P, widenSlAtr: 4 }));
});

/* The option's stop to the price sold once the premium has fallen so far (owner, 18 Oct 2026: "SL to the entry price"). */
test('[critical] break-even: the stop goes to the price sold once the best offer is that far under it -- points or per cent', () => {
  assert.deepEqual([36, 35.01, 35, 30].map((b) => breakEvenReached({ move: 5, unit: 'pts' }, 40, b)), [false, false, true, true]);
  assert.equal(breakEvenReached({ move: 25, unit: 'pct' }, 40, 30), true, '25% of 40 is 10');
  assert.deepEqual(breakEvenProblems({ move: 0, unit: 'pts' }).length, 1);
  assert.deepEqual(breakEvenProblems({ move: 10, unit: 'pct' }), []);
});

test('[critical] break-even: the trade that came back is bought at the price sold, as its own exit -- with or without a stop set', () => {
  const flat = perp([[0, 84_000], [1_439, 84_000]]);
  // sold at 40; the offer falls to 22 by minute 60, then climbs to 90
  const board = contract('P', 83_200, -0.09, [[0, 40], [60, 20], [300, 88], [1_435, 60]]);
  const be = simulateDay({ from, to, params: { ...P, stopPct: 1.5, breakEven: { move: 25, unit: 'pct' } }, signals: [sig(0)], bars: flat, board }).trades[0]!;
  assert.deepEqual([be.by, be.optStop, be.optStopEnd], ['option-be', 100, 40]);
  assert.ok(be.exit >= 40 && be.exit < 43, `bought back at the first offer at or over 40 (${be.exit})`);
  // no stop set before it: the stop from then on is the price sold
  const none = simulateDay({ from, to, params: { ...P, stopPct: 0, breakEven: { move: 25, unit: 'pct' } }, signals: [sig(0)], bars: flat, board }).trades[0]!;
  assert.deepEqual([none.by, none.optStop, none.optStopEnd], ['option-be', null, 40]);
  // beside a trailing SL: the tighter of the two
  const both = simulateDay({ from, to, params: { ...P, stopPct: 1.5, tsl: { move: 5, moveUnit: 'pts', by: 5, byUnit: 'pts' }, breakEven: { move: 25, unit: 'pct' } }, signals: [sig(0)], bars: flat, board }).trades[0]!;
  assert.equal(both.by, 'option-be', 'the trail took 100 to 85; break-even at 40 is tighter');
  // never reached: the stop where it was set
  const far = simulateDay({ from, to, params: { ...P, stopPct: 1.5, breakEven: { move: 90, unit: 'pct' } }, signals: [sig(0)], bars: flat, board }).trades[0]!;
  assert.equal(far.optStopEnd, undefined);
  assert.notEqual(paramsKey({ ...P, breakEven: { move: 25, unit: 'pct' } }), paramsKey(P));
});

/* The perp's own levels left out (owner, 18 Oct 2026: "skip perp SL, skip perp TGT -- enable, disable"). */
test('[critical] skip perp SL / TGT: the perp reaching a level left out closes nothing -- the option\'s own levels or the day\'s end do', () => {
  // A BUY at 84,000 (SL 83,700, TGT 84,500): the perp falls through the SL at minute 200 and later rises through the TGT
  const bars = perp([[0, 84_000], [200, 83_600], [400, 84_000], [600, 84_600], [1_439, 84_600]]);
  const board = contract('P', 83_200, -0.09, [[0, 40], [1_435, 30]]);
  const run = (o: Partial<BacktestParams>) => simulateDay({ from, to, params: { ...P, stopPct: 0, targetPct: 0, ...o }, signals: [sig(0)], bars, board }).trades[0]!;
  assert.equal(run({}).by, 'perp-sl', 'as the desk: the perp SL at minute 200');
  const noSl = run({ skipPerpSl: true });
  assert.equal(noSl.by, 'perp-tgt', 'the SL left out: on to the TGT');
  assert.ok((noSl.exitAt - from) / MIN > 500);
  assert.equal(run({ skipPerpSl: true, skipPerpTgt: true }).by, 'window-end', 'both left out, no option levels: to the end of the day');
  // the option's own stop still stands with the perp's left out
  const optStop = simulateDay({ from, to, params: { ...P, stopPct: 1, skipPerpSl: true, skipPerpTgt: true }, signals: [sig(0)], bars,
    board: contract('P', 83_200, -0.09, [[0, 40], [200, 85], [1_435, 30]]) }).trades[0]!;
  assert.equal(optStop.by, 'option-sl');
  assert.notEqual(paramsKey({ ...P, skipPerpSl: true }), paramsKey(P));
  assert.notEqual(paramsKey({ ...P, skipPerpSl: true }), paramsKey({ ...P, skipPerpTgt: true }));
});

/*
 * Win % by volatility (20 Oct 2026, owner: "the strategy's 50% as it is; low volatility 5% less, high 5% more"): the bar
 * at each level, and the record it is held to -- the days before a signal's day, never its own.
 */
test('[critical] win % by volatility: the base moved by the level, in points, held to 0-100; no level keeps the base', () => {
  const w = { ...VOL_STUDY_WIN, base: 50 };
  assert.deepEqual([winBarAt(w, 'low'), winBarAt(w, 'medium'), winBarAt(w, 'high'), winBarAt(w, 'unknown'), winBarAt(w, null)], [45, 50, 55, 50, 50]);
  assert.equal(winBarAt({ ...w, base: 98, adj: { low: -5, medium: 0, high: 5 } }, 'high'), 100, 'never over 100');
  assert.equal(winBarAt({ ...w, base: 3, adj: { low: -5, medium: 0, high: 5 } }, 'low'), 0, 'never under 0');
});

test('[critical] win % by volatility: a method passes on enough trades won at the bar, over the days before only', () => {
  const t = (method: string, net: number) => ({ signal: { method }, netUsd: net }) as never;
  // Three days: 18 Oct two won of three, 19 Oct one won of one, 20 Oct (the day itself) a loss.
  const byDay = new Map([
    ['2026-10-18', tallyOf([t('a', 1), t('a', 2), t('a', -1)])],
    ['2026-10-19', tallyOf([t('a', 1), t('b', -1)])],
    ['2026-10-20', tallyOf([t('a', -5)])],
  ]);
  const two = recordBefore(byDay, '2026-10-20', 2);
  assert.deepEqual(two.get('a'), { n: 4, wins: 3 }, 'the two days before, not the day itself');
  const one = recordBefore(byDay, '2026-10-20', 1);
  assert.deepEqual(one.get('a'), { n: 1, wins: 1 });
  // 3 of 4 = 75%: through 70, not 80; and not on 5 trades.
  assert.equal(passesBar(two, 'a', 70, 3), true);
  assert.equal(passesBar(two, 'a', 80, 3), false);
  assert.equal(passesBar(two, 'a', 70, 5), false);
  assert.equal(passesBar(two, 'b', 0, 1), true, 'a loss of one passes a bar of 0');
  assert.equal(passesBar(two, 'c', 0, 1), false, 'no record, no pass');
  // The same record, the level's bar: low 45 / normal 50 / high 55 around a base of 50 -- 50% passes low and normal, not high.
  const half = new Map([['x', { n: 4, wins: 2 }]]);
  const w = { ...VOL_STUDY_WIN, base: 50, minTrades: 3 };
  assert.deepEqual((['low', 'medium', 'high'] as const).map((l) => passesBar(half, 'x', winBarAt(w, l), w.minTrades)), [true, true, false]);
});

test('[critical] 22 Oct 2026: the most on one strike, as the live desk holds it -- at it, the next strike out by the rule (never nearer the money), or skipped; none at 100%', async () => {
  const { deskCapsOf, planOfParams } = await import('../../src/report/signal-backtest.js');
  const bars = perp([[0, 84_000], [1_439, 84_050]]);             // every trade stays open all day
  const board = byTime(ladder('P', 83_400, -0.09, [[0, 40], [1_435, 30]], 8));
  const signals = [sig(10), sig(20), sig(30), sig(40), sig(50)];
  const run = (o: Partial<BacktestParams>) => simulateDay({ from, to, signals, bars, board, plan: planOfParams({ ...P, deskMax: 10, ...o }, { from, to }) });
  assert.deepEqual(deskCapsOf({ deskMax: 10, strikePct: 20 })!.strike, 2, '20% of 10');
  assert.equal(deskCapsOf({ deskMax: 111, strikePct: 20 })!.strike, 22, 'the live account\'s: 20% of 111');

  const free = run({});
  const first = free.trades[0]!.strike;
  assert.ok(free.trades.every((t) => t.strike === first && t.fwdFrom === undefined), 'no limit: all on the one strike');

  const next = run({ strikePct: 20 });
  assert.equal(next.trades.length, 5, 'every signal traded');
  const strikes = next.trades.map((t) => t.strike);
  assert.deepEqual(strikes, [first, first, first - 200, first - 200, first - 400], 'two a strike, each next one further out');
  assert.deepEqual(next.trades.map((t) => t.fwdFrom), [undefined, undefined, first, first, first], 'the forwarded ones say from where');
  assert.ok(strikes.every((k) => k <= first), 'never nearer the money than the first pick');
  assert.equal(next.skipped['strike-limit'], 0);

  const skip = run({ strikePct: 20, strikeFull: 'skip' });
  assert.deepEqual(skip.trades.map((t) => t.strike), [first, first]);
  assert.equal(skip.skipped['strike-limit'], 3);

  // Nowhere further out: a full strike with no room beyond is a skip, said as one.
  const end = simulateDay({ from, to, signals, bars, board: byTime(contract('P', 83_400, -0.09, [[0, 40], [1_435, 30]])), plan: planOfParams({ ...P, deskMax: 10, strikePct: 20 }, { from, to }) });
  assert.equal(end.trades.length, 2);
  assert.equal(end.skipped['strike-limit'], 3);
});
