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
  assert.deepEqual(r.skipped, { 'outside-window': 0, 'no-entry-window': 0, distance: 0, volatility: 0, 'at-limit': 0, 'desk-limit': 0, 'side-limit': 0, 'no-board': 0, 'no-strike': 0, 'no-exit-price': 0 });
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

test('[critical] the desk\'s limits: at most N open across every signal, and each side its per cent of it -- as the desk rounds it', async () => {
  const { deskCapsOf, planOfParams } = await import('../../src/report/signal-backtest.js');
  const bars = perp([[0, 84_000], [1_439, 84_050]]);             // the perp reaches nothing: every trade stays open all day
  const board = byTime([...contract('P', 83_200, -0.09, [[0, 40], [1_435, 30]]), ...contract('C', 85_000, 0.09, [[0, 40], [1_435, 30]])]);
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
  assert.deepEqual(deskCapsOf({ deskMax: 35, cePct: 80, pePct: 80 }), { max: 35, side: { CE: 28, PE: 28 } }, 'the desk\'s own rounding: 80% of 35 is 28');
  assert.equal(deskCapsOf({ deskMax: 0, cePct: 80, pePct: 80 }), null, 'no "at most open": no side limit either');
  // a trade that has closed frees its place
  const early = simulateDay({ from, to, signals: [sig(10), sig(400)], bars: perp([[0, 84_000], [100, 84_000], [120, 84_600], [1_439, 84_600]]), board, plan: planOfParams({ ...P, deskMax: 1 }, { from, to }) });
  assert.equal(early.trades.length, 2, 'the first reached its target at minute ~110; the second found the place free');
});

test('[critical] custom hours: only the signals filled from the From time to the To time (IST), across midnight too', async () => {
  const { planOfParams } = await import('../../src/report/signal-backtest.js');
  const bars = perp([[0, 84_000], [1_439, 84_050]]);
  const board = contract('P', 83_200, -0.09, [[0, 40], [1_435, 30]]);
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
  const board = contract('P', 83_200, -0.09, [[0, 40], [1_435, 30]]);
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
  const board = contract('P', 83_200, -0.09, [[0, 40], [1_435, 30]]);
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
  assert.deepEqual(peakMargin([]), { usd: 0, at: null, open: 0 });
  assert.deepEqual(peakMargin([{ at: 0, until: 10, margin: 5 }, { at: 5, until: 20, margin: 7 }, { at: 10, until: 30, margin: 9 }]), { usd: 16, at: 10, open: 2 },
    'at 10 the first has ended: 7 + 9, not 5 + 7 + 9');
  assert.deepEqual(peakMargin([{ at: 0, until: 100, margin: 5 }, { at: 1, until: 100, margin: 5 }, { at: 2, until: 100, margin: 5 }]), { usd: 15, at: 2, open: 3 });
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
  const board = contract('P', 83_200, -0.09, [[0, 40], [1_435, 30]]);
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
