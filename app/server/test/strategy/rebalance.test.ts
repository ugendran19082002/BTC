import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REBALANCE, capFor, cleanRebalance, decideRebalance, movePct, stageThresholds, stagesUnderCap,
  type RebalanceQuote, type RebalanceRule,
} from '../../src/strategy/rebalance.js';
import type { TradeRecord } from '../../src/trading/engine.js';

/**
 * Dynamic one-sided rebalance: buy back part of the side that fell, sell the
 * same number again on the side that rose, one stage at a time.
 *
 * The strategy adds to the losing side at a higher price each stage, so most of
 * these tests are about the moments it must *not* act: a hair under the
 * threshold, one side only, a single reading, a stage that has already fired,
 * sides that swapped, nothing left to buy back, the cap, the cutoff and a
 * book too wide to trade.
 *
 * Nothing here is hardcoded to 30/20/10 or to three stages: every number comes
 * from the rule, and the tests below change them to prove it.
 */

const BASE = 15;

const rec = (side: 'CE' | 'PE', lots: number, soldAt = BASE): TradeRecord => ({
  plan: {
    tradeId: `${side}-1`, symbol: `${side === 'CE' ? 'C' : 'P'}-BTC-80000-180926`,
    optionSide: side, lots, leverage: 200, takeProfitPrice: null, stopPrice: null,
    entry: { type: 'limit', limitPrice: soldAt, timeoutMs: 0, marketFallback: false, chase: null },
    expect: { underlying: 'BTC', optionSide: side, strike: 80_000, expiryTs: 1_789_646_400 },
  },
  state: {
    tradeId: `${side}-1`, symbol: `${side === 'CE' ? 'C' : 'P'}-BTC-80000-180926`,
    optionSide: side, phase: 'open', position: -lots, requestedSize: lots,
    entrySize: lots, entryAvgPrice: soldAt, exitSize: 0, exitAvgPrice: null,
    addedSize: 0,
    fills: [{ role: 'entry', size: lots, price: soldAt, ts: 1 }],
    protection: { takeProfit: null, stopLoss: null },
    realisedPnl: 0, note: null, alarm: null, updatedAt: 1, contractValue: 0.001,
  },
  events: [],
} as unknown as TradeRecord);

const q = (mark: number, spread = 0.4): RebalanceQuote =>
  ({ bid: mark - spread / 2, ask: mark + spread / 2, mark });

const rule = (over: Partial<RebalanceRule> = {}): RebalanceRule =>
  ({ ...DEFAULT_REBALANCE, enabled: true, ...over });

/** A board: CE and PE marks, with whatever has been done so far. */
const ask = (o: {
  ce: number; pe: number; ceLots?: number; peLots?: number;
  rule?: RebalanceRule; stagesDone?: number; lockedUpSide?: 'CE' | 'PE' | null;
  now?: number; end?: number; spread?: number;
}) => decideRebalance({
  rule: o.rule ?? rule(),
  legs: { ce: rec('CE', o.ceLots ?? 100), pe: rec('PE', o.peLots ?? 100) },
  quotes: { ce: q(o.ce, o.spread), pe: q(o.pe, o.spread) },
  stagesDone: o.stagesDone ?? 0,
  lockedUpSide: o.lockedUpSide ?? null,
  nowIstMinutes: o.now ?? 11 * 60,
  entryIstMinutes: 17 * 60 + 30,
  endIstMinutes: o.end ?? 13 * 60 + 30,
  referencePremium: BASE,
});

// ---------------------------------------------------------------------------
// the thresholds themselves

test('[critical] the stages are worked out from the rule, not written into the code', () => {
  assert.deepEqual(
    stageThresholds({ steps: 3, upStartPct: 30, downStartPct: 20, incrementPct: 10 }, { up: 15, down: 15 }),
    [
      { stage: 1, upPct: 30, downPct: 20, upPrice: 19.5, downPrice: 12 },
      { stage: 2, upPct: 40, downPct: 30, upPrice: 21, downPrice: 10.5 },
      { stage: 3, upPct: 50, downPct: 40, upPrice: 22.5, downPrice: 9 },
    ],
  );
  // a different rule entirely: five stages, 25/15, step 5
  const five = stageThresholds({ steps: 5, upStartPct: 25, downStartPct: 15, incrementPct: 5 }, { up: 20, down: 10 });
  assert.equal(five.length, 5);
  assert.deepEqual(five[4], { stage: 5, upPct: 45, downPct: 35, upPrice: 29, downPrice: 6.5 });
});

test('the move is measured from what the side was sold at', () => {
  assert.equal(movePct(15, 19.5), 30);
  assert.equal(movePct(15, 12), -20);
  assert.equal(movePct(0, 12), null);
});

// ---------------------------------------------------------------------------
// 1-4: the conditions

test('1. a small move on both sides does nothing', () => {
  const d = ask({ ce: 16.5, pe: 14 });
  assert.equal(d.act, 'wait');
  assert.match(d.detail, /stage 1: CE \+10\.00% of \+30%/);
});

test('[critical] 2. a hair under either threshold is not a trigger', () => {
  assert.equal(ask({ pe: 19.49, ce: 12.0 }).act, 'wait');   // +29.93%
  assert.equal(ask({ pe: 19.5, ce: 12.01 }).act, 'wait');   // −19.93%
});

test('[critical] 3. exactly at both thresholds fires: the test is ≥ and ≤', () => {
  const d = ask({ pe: 19.5, ce: 12.0 });
  assert.equal(d.act, 'ready');
  assert.equal(d.act === 'ready' && d.stage, 1);
  assert.equal(d.act === 'ready' && d.up.side, 'PE');
  assert.equal(d.act === 'ready' && d.down.side, 'CE');
  assert.equal(d.act === 'ready' && d.lots, 30);
  assert.match(d.detail, /buy 30 CE, sell 30 PE/);
});

test('[critical] 4. one side alone is never enough', () => {
  assert.equal(ask({ pe: 22, ce: 14.5 }).act, 'wait', 'up side only');
  assert.equal(ask({ pe: 15.5, ce: 11 }).act, 'wait', 'down side only');
});

// ---------------------------------------------------------------------------
// 7-8: the state machine

test('[critical] 7. a stage that has fired does not fire again while its condition holds', () => {
  // stage 1 is done; the same prices now need stage 2's thresholds
  const d = ask({ pe: 20, ce: 11, stagesDone: 1 });
  assert.equal(d.act, 'wait');
  assert.match(d.detail, /stage 2/);
});

test('[critical] 8. a gap straight past the last stage fires one stage at a time', () => {
  const far = { pe: 30, ce: 6 };  // +100% / −60%: past every stage at once
  assert.equal(ask({ ...far, stagesDone: 0 }).act, 'ready');
  const second = ask({ ...far, stagesDone: 1 });
  assert.equal(second.act === 'ready' && second.stage, 2);
  const third = ask({ ...far, stagesDone: 2 });
  assert.equal(third.act === 'ready' && third.stage, 3);
  // and then it is finished
  const done = ask({ ...far, stagesDone: 3 });
  assert.equal(done.act, 'wait');
  assert.match(done.detail, /all 3 stages are done/);
});

test('the later stages need their own thresholds, in money', () => {
  // stage 2 is +40% / −30%: 21.00 and 10.50
  assert.equal(ask({ pe: 20.9, ce: 10.5, stagesDone: 1 }).act, 'wait');
  assert.equal(ask({ pe: 21, ce: 10.6, stagesDone: 1 }).act, 'wait');
  assert.equal(ask({ pe: 21, ce: 10.5, stagesDone: 1 }).act, 'ready');
  // stage 3 is +50% / −40%: 22.50 and 9.00
  assert.equal(ask({ pe: 22.5, ce: 9, stagesDone: 2 }).act, 'ready');
});

// ---------------------------------------------------------------------------
// 9-10: which side is which

test('[critical] 9. the risen side is found, never assumed', () => {
  const d = ask({ ce: 19.5, pe: 12 });
  assert.equal(d.act === 'ready' && d.up.side, 'CE');
  assert.equal(d.act === 'ready' && d.down.side, 'PE');
  assert.match(d.detail, /buy 30 PE, sell 30 CE/);
});

test('[critical] 10. with the lock on, sides that swap after stage 1 are refused', () => {
  const swapped = ask({ ce: 21, pe: 10.5, stagesDone: 1, lockedUpSide: 'PE' });
  assert.equal(swapped.act, 'skip');
  assert.match(swapped.detail, /the sides swapped: stage 1 sold PE/);
  // the same board with the lock off is allowed
  const free = ask({ ce: 21, pe: 10.5, stagesDone: 1, lockedUpSide: 'PE', rule: rule({ lockDirection: false }) });
  assert.equal(free.act, 'ready');
  assert.equal(free.act === 'ready' && free.up.side, 'CE');
});

// ---------------------------------------------------------------------------
// 11-12: size

test('[critical] 11. what is left is what is bought back, and then it is exhausted', () => {
  const partial = ask({ pe: 19.5, ce: 12, ceLots: 10 });
  assert.equal(partial.act === 'ready' && partial.lots, 10);
  assert.equal(partial.act === 'ready' && partial.partial, true);
  const off = ask({ pe: 19.5, ce: 12, ceLots: 10, rule: rule({ allowPartial: false }) });
  assert.equal(off.act, 'skip');
  assert.match(off.detail, /only 10 lots left on the CE, and partial steps are off/);
  const none = ask({ pe: 19.5, ce: 12, ceLots: 0 });
  assert.equal(none.act, 'skip');
  assert.match(none.detail, /nothing left on the CE to buy back/);
});

test('[critical] 12. the cap on a side is never exceeded, and says so', () => {
  const capped = ask({ pe: 19.5, ce: 12, peLots: 200 });
  assert.equal(capped.act, 'skip');
  assert.match(capped.detail, /PE is at the 200-lot cap/);
  // room for 15 of the 30
  const room = ask({ pe: 19.5, ce: 12, peLots: 185 });
  assert.equal(room.act === 'ready' && room.lots, 15);
  // no cap at all is allowed, and then the step is the step
  const uncapped = ask({ pe: 19.5, ce: 12, peLots: 900, rule: rule({ maxLotsPerSide: null }) });
  assert.equal(uncapped.act === 'ready' && uncapped.lots, 30);
});

// ---------------------------------------------------------------------------
// 13-14: time and the book

test('[critical] 13. after the cutoff no stage fires, however far the premiums have gone', () => {
  const late = ask({ pe: 30, ce: 6, now: 14 * 60 });
  assert.equal(late.act, 'wait');
  assert.match(late.detail, /past 13:30 — no more rebalancing today/);
  // and the cutoff is measured forward from an overnight entry: 11:00 is
  // "tomorrow morning" for a strategy that entered at 17:30
  assert.equal(ask({ pe: 30, ce: 6, now: 11 * 60 }).act, 'ready');
});

test('[critical] 14. a book too wide to trade waits rather than crossing it', () => {
  const wide = ask({ pe: 19.5, ce: 12, spread: 4 });
  assert.equal(wide.act, 'wait');
  assert.match(wide.detail, /spread .* is wider than 15%/);
  // with the gate off it acts
  assert.equal(ask({ pe: 19.5, ce: 12, spread: 4, rule: rule({ maxSpreadPct: null }) }).act, 'ready');
});

test('no price, one leg, or the feature switched off: all wait, none act', () => {
  const base = {
    rule: rule(), stagesDone: 0, lockedUpSide: null,
    nowIstMinutes: 11 * 60, entryIstMinutes: 17 * 60 + 30, endIstMinutes: 13 * 60 + 30,
    referencePremium: BASE,
  };
  const legs = { ce: rec('CE', 100), pe: rec('PE', 100) };
  assert.match(decideRebalance({ ...base, legs, quotes: { ce: null, pe: q(12) } }).detail, /no prices yet/);
  assert.match(
    decideRebalance({ ...base, legs: { ce: legs.ce, pe: null }, quotes: { ce: q(19.5), pe: q(12) } }).detail,
    /needs both legs/,
  );
  assert.match(
    decideRebalance({ ...base, rule: rule({ enabled: false }), legs, quotes: { ce: q(19.5), pe: q(12) } }).detail,
    /rebalancing is off/,
  );
  // a quote with no mark and no two-sided book cannot be measured
  const noPrice = decideRebalance({
    ...base, legs, quotes: { ce: { bid: null, ask: null, mark: null }, pe: q(19.5) },
  });
  assert.match(noPrice.detail, /no price to measure the move from/);
});

test('the move is measured from the fill, not from the number typed on the form', () => {
  // sold at 14.60 with a reference of 15.00: +30% is 18.98, not 19.50
  const legs = { ce: rec('CE', 100, 14.6), pe: rec('PE', 100, 14.6) };
  const d = decideRebalance({
    rule: rule(), legs, quotes: { ce: q(11.68), pe: q(18.98) },
    stagesDone: 0, lockedUpSide: null,
    nowIstMinutes: 11 * 60, entryIstMinutes: 17 * 60 + 30, endIstMinutes: 13 * 60 + 30,
    referencePremium: 15,
  });
  assert.equal(d.act, 'ready');
});

test('a rule from a browser is brought inside its limits, and off is off', () => {
  assert.equal(cleanRebalance(null), null);
  assert.equal(cleanRebalance({})!.enabled, false, 'only a real true enables it');
  const wild = cleanRebalance({
    enabled: true, lotsPerStep: 999_999, steps: 99, upStartPct: 9_999, downStartPct: 150,
    incrementPct: -5, confirmTicks: 99, endTime: '99:99', maxLotsPerSide: 0, maxSpreadPct: 9,
  })!;
  assert.deepEqual(wild, {
    enabled: true, lotsPerStep: 10_000, steps: 20, upStartPct: 500, downStartPct: 99,
    incrementPct: 0, confirmTicks: 10, endTime: '13:30', lockDirection: true,
    maxLotsPerSide: 1, allowPartial: true, maxSpreadPct: 1, crossAfterSec: null,
  });
  // "if not filled, sell at bid after": blank keeps the strategy's entry seconds
  assert.equal(cleanRebalance({ crossAfterSec: 45 })!.crossAfterSec, 45);
  assert.equal(cleanRebalance({ crossAfterSec: 9_999 })!.crossAfterSec, 600);
  assert.equal(cleanRebalance({ crossAfterSec: 0 })!.crossAfterSec, 0, 'zero rests at the offer');
  assert.equal(cleanRebalance({})!.crossAfterSec, null);
  assert.equal(cleanRebalance({ maxLotsPerSide: null })!.maxLotsPerSide, null);
  assert.equal(cleanRebalance({ endTime: '09:45' })!.endTime, '09:45');
});

/*
 * The cap works itself out.
 *
 * A desk default of 200 on a strategy selling 700 a side refused every stage
 * before it began. The most one side can reach is the lots plus what can move,
 * and what can move is bounded by the other side: 100 a side with 30 lots over
 * 5 stages reaches 200, not 250.
 */
test('[critical] the automatic cap is the most one side can actually reach', () => {
  assert.equal(capFor({ lotsPerStep: 30, steps: 3 }, 100), 190);
  assert.equal(capFor({ lotsPerStep: 30, steps: 5 }, 100), 200, 'only 100 are there to move');
  assert.equal(capFor({ lotsPerStep: 30, steps: 3 }, 700), 790);
  assert.equal(capFor({ lotsPerStep: 0, steps: 3 }, 100), 100);
});

test('[critical] a cap that is too small says which stages it refuses, counted not guessed', () => {
  const r = rule({ maxLotsPerSide: 160 });
  assert.deepEqual(stagesUnderCap(r, 100).map((x) => [x.stage, x.up, x.down, x.blocked]), [
    [1, 130, 70, false],
    [2, 160, 40, false],
    [3, 160, 40, true],
  ]);
  const none = stagesUnderCap(rule({ maxLotsPerSide: 100 }), 100);
  assert.ok(none.every((x) => x.blocked), 'no room above the opening lots: nothing runs');
  const free = stagesUnderCap(rule({ maxLotsPerSide: null }), 100);
  assert.ok(free.every((x) => !x.blocked));
});

test('capAuto is kept, and only a real true switches it on', () => {
  assert.equal(cleanRebalance({ capAuto: true })!.capAuto, true);
  assert.equal(cleanRebalance({ capAuto: 'yes' as never })!.capAuto, false);
  assert.equal(cleanRebalance({})!.capAuto, false, 'a rule saved before the switch existed was set by hand');
});

