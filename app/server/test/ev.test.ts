import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedPayoutPerBtc, legEv, attachEv, topByEv, EV_RULES } from '../src/domain/ev.js';
import { optionStructure } from '../src/domain/structure.js';
import { recommend } from '../src/domain/recommend.js';
import type { ScoredLeg } from '../src/domain/score.js';
import type { Snapshot } from '../src/market/chain.js';

/**
 * Expected value per strike, and the eligibility rules the board marks with.
 *
 * The one property worth more than the rest is the first test: the number on a
 * strike and the number on the card above it come from one piece of arithmetic.
 * A board that says +$0.09 beside a card that says +$0.11 for the same option
 * is a board nobody can act on.
 */

const SPOT = 77_028.5;
const LOT = 0.001;

const leg = (o: {
  cp: 'C' | 'P';
  strike: number;
  bid: number;
  ask?: number;
  mark: number;
  zero: number;
  model: number;
  oi?: number;
  volume?: number;
  delta?: number;
  ageMin?: number;
  moneyness?: 'ITM' | 'ATM' | 'OTM';
}) =>
  ({
    cp: o.cp,
    strike: o.strike,
    off: 0,
    moneyness: o.moneyness ?? 'OTM',
    ltp: null,
    mark: o.mark,
    bid: o.bid,
    ask: o.ask ?? o.bid + 1,
    sellPrice: o.bid,
    iv: 0.3,
    delta: o.delta ?? 0.03,
    gamma: null,
    theta: null,
    vega: null,
    oi: o.oi ?? 50_000,
    volume: o.volume ?? 10_000,
    ageMin: o.ageMin ?? 0,
    pOtm: o.model,
    zero: {
      model: o.model, adjusted: o.zero, historical: o.zero,
      sample: 500, gap: null, comparableHorizon: true, outsideTable: false,
    },
    zeroByDistance: null,
    edge: null,
    emDistance: 1,
    score: 0.5,
    reasons: [],
    probs: { expireWorthless: o.model, touch: 0.05, nearZero: 0.5 },
    distancePct: ((o.strike - SPOT) / SPOT) * 100,
    intrinsic: 0,
    extrinsic: o.mark,
    gammaExposure: null,
  }) as unknown as ScoredLeg;

const snap = (spot = SPOT, legs: ScoredLeg[] = []) =>
  ({ spot, step: 200, expiry: '110926', legs, atmIv: 0.3, expectedMove: 900, hoursToExpiry: 12 }) as unknown as Snapshot;

const opts = { spot: SPOT, lots: 5, minPremium: 10 };

// ---------------------------------------------------------------------------

test('[critical] the board and the card are one piece of arithmetic, not two', () => {
  // The exact book from recommend-figures.test.ts, so the two files describe
  // the same evening.
  const book = [
    leg({ cp: 'C', strike: 79_600, bid: 18, ask: 19, mark: 18.7399, zero: 0.9882, model: 0.96686 }),
    leg({ cp: 'P', strike: 74_000, bid: 13.7, ask: 14, mark: 10.956, zero: 1, model: 0.97935 }),
  ];
  const r = recommend(snap(SPOT, book), book, null, 10, 10, 0, 'safety', 0.988);
  assert.equal(r.ok, true);
  assert.deepEqual(r.sides.map((s) => s.lots), [5, 5]);

  // The same two strikes, each priced on its own through the board's function.
  const board = r.sides.map((s) =>
    legEv(book.find((l) => l.strike === s.leg.strike)!, { spot: SPOT, lots: s.lots, minPremium: 10 }),
  );
  const summed = board.reduce((a, e) => a + e.evUsd!, 0);

  assert.ok(
    Math.abs(summed - r.expectedProfitUsd!) < 1e-12,
    `board sums to ${summed}, card says ${r.expectedProfitUsd}`,
  );
});

test('the payout is the mark scaled by how often strikes like it actually breached', () => {
  const p = expectedPayoutPerBtc({ mark: 18.7399, model: 0.96686, real: 0.9882 });
  assert.ok(Math.abs(p! - 18.7399 * ((1 - 0.9882) / (1 - 0.96686))) < 1e-12);
});

test('with no history to correct by, the model stands on its own', () => {
  const p = expectedPayoutPerBtc({ mark: 20, model: 0.97, real: null });
  assert.equal(p, 20, 'scale is exactly 1 when real equals model');
});

test('a model that says the strike can never breach has no payout to scale', () => {
  assert.equal(expectedPayoutPerBtc({ mark: 20, model: 1, real: 1 }), null);
  assert.equal(expectedPayoutPerBtc({ mark: null, model: 0.9, real: 0.9 }), null);
});

// ---------------------------------------------------------------------------

test('[critical] a 99% strike can still be a bad sell, and is marked as one', () => {
  // Sold at 2, but strikes like it breach three times more often than the maths
  // expects -- so the average payout is above the credit. This is the whole
  // reason the board carries an expected value beside the probability: the
  // probability column alone calls this one excellent.
  const bad = leg({ cp: 'C', strike: 82_000, bid: 2, ask: 2.5, mark: 2, zero: 0.97, model: 0.99 });
  const e = legEv(bad, opts);

  assert.ok(e.evPerBtc! < 0, `expected a negative edge, got ${e.evPerBtc}`);
  assert.equal(e.signal, 'avoid');
  assert.ok(
    e.checks.some((c) => c.severity === 'block' && !c.ok && c.text.includes('Negative expected value')),
    'the reason is spelled out, not just the colour',
  );
});

test('a strike that clears every rule is marked to sell', () => {
  const good = leg({ cp: 'C', strike: 79_600, bid: 18, ask: 19, mark: 15, zero: 0.99, model: 0.97 });
  const e = legEv(good, opts);
  assert.equal(e.signal, 'sell');
  assert.ok(e.evUsd! > 0);
  assert.ok(e.checks.every((c) => c.ok), 'nothing outstanding');
});

test('too close to the money is refused however good the odds look', () => {
  const near = leg({
    cp: 'C', strike: Math.round(SPOT * 1.01), bid: 30, ask: 31, mark: 20, zero: 0.99, model: 0.97,
  });
  const e = legEv(near, opts);
  assert.equal(e.signal, 'avoid');
  assert.ok(
    e.checks.some((c) => !c.ok && c.text.includes('out of the money')),
    `under the ${EV_RULES.minOtmPct}% bar`,
  );
});

test('a thin tape is a warning, not a refusal — or the far half of the board would read unsellable', () => {
  // 0.17% of open interest traded today, which is ordinary at this distance and
  // is exactly what the strike the tested engine picks looks like.
  const thin = leg({
    cp: 'C', strike: 80_000, bid: 18, ask: 19, mark: 15, zero: 0.99, model: 0.97,
    oi: 425_600, volume: 729,
  });
  const e = legEv(thin, opts);
  assert.equal(e.signal, 'watch');
  assert.ok(Math.abs(e.volumeToOi! - 729 / 425_600) < 1e-12);
  assert.ok(
    e.checks.some((c) => c.severity === 'warn' && !c.ok && c.text.includes('open interest')),
    'said as a warning',
  );
  assert.ok(
    e.checks.every((c) => c.severity !== 'block' || c.ok),
    'and nothing hard is failing',
  );
});

test('in the money is refused outright', () => {
  const itm = leg({
    cp: 'C', strike: 70_000, bid: 40, ask: 41, mark: 30, zero: 0.99, model: 0.97, moneyness: 'ITM',
  });
  assert.equal(legEv(itm, opts).signal, 'avoid');
});

test('the credit is the most a naked short can make, and the worst case is not a number', () => {
  const l = leg({ cp: 'C', strike: 79_600, bid: 18, ask: 19, mark: 15, zero: 0.99, model: 0.97 });
  const e = legEv(l, opts);
  assert.ok(Math.abs(e.maxProfitUsd! - (18 * 5 * LOT - e.chargesUsd)) < 1e-12);
  assert.equal(e.maxLossUsd, null, 'unbounded, and not dressed up as a large number');
  assert.equal(e.breakeven, 79_600 + 18);
});

test('a put breaks even below its strike', () => {
  const l = leg({ cp: 'P', strike: 74_000, bid: 13.7, ask: 14, mark: 11, zero: 0.99, model: 0.97 });
  assert.equal(legEv(l, opts).breakeven, 74_000 - 13.7);
});

// ---------------------------------------------------------------------------

test('a strike a hard rule refuses is never ranked, however large its premium', () => {
  const book = [
    leg({ cp: 'C', strike: 79_600, bid: 18, ask: 19, mark: 15, zero: 0.99, model: 0.97 }),
    leg({ cp: 'C', strike: 79_400, bid: 28, ask: 29, mark: 24, zero: 0.99, model: 0.97 }),
    // negative edge: must not appear however large its premium
    leg({ cp: 'C', strike: 82_000, bid: 2, ask: 2.5, mark: 2, zero: 0.97, model: 0.99 }),
  ];
  const ranked = topByEv(attachEv(book, opts));
  assert.deepEqual(ranked.map((l) => l.strike), [79_400, 79_600]);
  assert.ok(ranked.every((l) => l.ev.signal !== 'avoid'));
});

test('[critical] a thin strike is ranked, below the clear ones -- dropping them emptied the card', () => {
  // At the distance this strategy sells, a daily option routinely trades a
  // fraction of a percent of its open interest. Ranking `sell` alone meant the
  // list was empty on almost every real board, which reads as "nothing
  // qualifies" rather than "these qualify and here is what is thin".
  const book = [
    leg({ cp: 'C', strike: 80_000, bid: 40, ask: 41, mark: 30, zero: 0.99, model: 0.97,
          oi: 425_600, volume: 729 }),                      // thin: 0.17% of OI
    leg({ cp: 'C', strike: 79_600, bid: 18, ask: 19, mark: 15, zero: 0.99, model: 0.97 }),
  ];
  const ranked = topByEv(attachEv(book, opts));
  assert.deepEqual(ranked.map((l) => l.ev.signal), ['sell', 'watch']);
  assert.deepEqual(ranked.map((l) => l.strike), [79_600, 80_000],
    'the clear strike ranks first even though the thin one pays more and scores higher');
  assert.equal(ranked[1]!.ev.tier, 'watch',
    'a soft rule failing caps the tier, so a score cannot promote past it');
  assert.ok((ranked[1]!.ev.score ?? 0) > (ranked[0]!.ev.score ?? 0),
    'and it really does score higher -- the cap is what holds the order');
});

test('every strike on the board carries its own arithmetic', () => {
  const book = [
    leg({ cp: 'C', strike: 79_600, bid: 18, ask: 19, mark: 15, zero: 0.99, model: 0.97 }),
    leg({ cp: 'P', strike: 74_000, bid: 13.7, ask: 14, mark: 11, zero: 0.99, model: 0.97 }),
  ];
  const withEv = attachEv(book, opts);
  assert.equal(withEv.length, 2);
  assert.ok(withEv.every((l) => l.ev.evUsd !== null && l.ev.checks.length > 0));
});

// ---------------------------------------------------------------------------

test('max pain is the settlement that pays the open contracts least', () => {
  const book = [
    leg({ cp: 'C', strike: 78_000, bid: 5, mark: 5, zero: 0.99, model: 0.97, oi: 100 }),
    leg({ cp: 'P', strike: 78_200, bid: 5, mark: 5, zero: 0.99, model: 0.97, oi: 300 }),
  ];
  const s = optionStructure(snap(SPOT, book), null);
  // settling at 78,000 owes the 300 puts $200 each; settling at 78,200 owes the
  // 100 calls $200 each, which is the cheaper of the two.
  assert.equal(s.maxPain!.strike, 78_200);
  assert.ok(Math.abs(s.maxPain!.payoutUsd - 200 * 100 * LOT) < 1e-9);
});

test('max pain needs open interest to read', () => {
  const book = [leg({ cp: 'C', strike: 78_000, bid: 5, mark: 5, zero: 0.99, model: 0.97, oi: undefined })];
  const bare = { ...book[0]!, oi: null } as ScoredLeg;
  assert.equal(optionStructure(snap(SPOT, [bare]), null).maxPain, null);
});

test('the open-interest range runs from the heaviest put to the heaviest call', () => {
  const book = [
    leg({ cp: 'P', strike: 74_400, bid: 5, mark: 5, zero: 0.99, model: 0.97, oi: 59_000 }),
    leg({ cp: 'P', strike: 73_000, bid: 3, mark: 3, zero: 0.99, model: 0.97, oi: 1_000 }),
    leg({ cp: 'C', strike: 80_000, bid: 5, mark: 5, zero: 0.99, model: 0.97, oi: 425_600 }),
    leg({ cp: 'C', strike: 81_000, bid: 3, mark: 3, zero: 0.99, model: 0.97, oi: 2_000 }),
  ];
  const s = optionStructure(snap(SPOT, book), null);
  assert.deepEqual(
    { low: s.oiRange!.low, high: s.oiRange!.high, widthUsd: s.oiRange!.widthUsd },
    { low: 74_400, high: 80_000, widthUsd: 5_600 },
  );
  assert.ok(Math.abs(s.oiRange!.widthPct - (5_600 / SPOT) * 100) < 1e-9);
});

test('a range is only reported when the walls are the right way round', () => {
  // every put above every call: not a band, and reporting one would invent a
  // level the board does not show.
  const book = [
    leg({ cp: 'P', strike: 81_000, bid: 5, mark: 5, zero: 0.99, model: 0.97, oi: 9_000 }),
    leg({ cp: 'C', strike: 74_000, bid: 5, mark: 5, zero: 0.99, model: 0.97, oi: 9_000 }),
  ];
  assert.equal(optionStructure(snap(SPOT, book), null).oiRange, null);
});

// ---------------------------------------------------------------------------

test('the score is a rank against the board, not an absolute', () => {
  const book = [
    leg({ cp: 'C', strike: 80_000, bid: 18, ask: 19, mark: 15, zero: 0.99, model: 0.97, oi: 400_000, volume: 40_000 }),
    leg({ cp: 'C', strike: 79_600, bid: 18, ask: 19, mark: 15, zero: 0.99, model: 0.97, oi: 400, volume: 40 }),
  ];
  const [heavy, thin] = attachEv(book, opts);
  assert.ok(heavy!.ev.score! > thin!.ev.score!, 'open interest and volume are scored against the heaviest strike listed');
  for (const l of [heavy, thin]) {
    assert.ok(l!.ev.score! >= 0 && l!.ev.score! <= 100, `0-100, got ${l!.ev.score}`);
  }
});

test('a strike with no price has no score and no tier above avoid', () => {
  const l = leg({ cp: 'C', strike: 80_000, bid: 18, mark: 15, zero: 0.99, model: 0.97 });
  const bare = { ...l, sellPrice: null, sellPrice2: undefined } as unknown as typeof l;
  const e = legEv({ ...bare, sellPrice: null } as typeof l, opts);
  assert.equal(e.score, null);
  assert.equal(e.tier, 'avoid');
});

test('[critical] a hard rule failing is avoid however well the strike scores', () => {
  // deep out, heavy, richly paid -- and the average payout still exceeds the credit
  const bad = leg({
    cp: 'C', strike: 90_000, bid: 40, ask: 41, mark: 40, zero: 0.90, model: 0.99,
    oi: 500_000, volume: 90_000,
  });
  const e = legEv(bad, opts, { maxOi: 500_000, maxVolume: 90_000, atmIv: 0.3, expectedMove: 900 });
  assert.equal(e.tier, 'avoid');
  assert.ok(e.checks.some((c) => c.severity === 'block' && !c.ok));
});

test('a strike that clears everything is named by its score', () => {
  const good = leg({
    cp: 'C', strike: 82_000, bid: 40, ask: 41, mark: 12, zero: 0.995, model: 0.97,
    oi: 100_000, volume: 20_000,
  });
  const e = legEv(good, opts, { maxOi: 100_000, maxVolume: 20_000, atmIv: 0.3, expectedMove: 900 });
  assert.ok(e.checks.every((c) => c.ok), 'nothing outstanding');
  assert.ok(['strong', 'candidate', 'watch'].includes(e.tier), `named, got ${e.tier}`);
});

test('[critical] the breakdown adds back up to the expected value on screen', () => {
  const l = leg({ cp: 'C', strike: 79_600, bid: 18, ask: 19, mark: 15, zero: 0.99, model: 0.97 });
  const e = legEv(l, opts);
  const b = e.breakdown!;

  assert.ok(Math.abs(b.pWin + b.pLoss - 1) < 1e-12, 'the two chances are the whole of it');
  assert.equal(b.premiumPerBtc, 18);
  assert.equal(b.feesUsd, e.chargesUsd);
  assert.equal(b.evUsd, e.evUsd);

  // the average payout is the cost of a breach weighted by how often one happens
  assert.ok(
    Math.abs(b.expectedLossPerBtc * b.pLoss - e.payoutPerBtc!) < 1e-9,
    'expected loss x chance of losing is the payout the EV was worked out from',
  );
  // and the whole thing is the formula it claims to be
  assert.ok(
    Math.abs((b.premiumPerBtc - b.expectedLossPerBtc * b.pLoss) * 5 * LOT - b.feesUsd - b.evUsd!) < 1e-12,
    'premium less the expected loss, times lots, less fees',
  );
});

test('a strike that cannot breach has no breach to cost anything', () => {
  const certain = leg({ cp: 'P', strike: 60_000, bid: 12, ask: 13, mark: 9, zero: 1, model: 0.98 });
  const b = legEv(certain, opts).breakdown!;
  assert.equal(b.pLoss, 0);
  assert.equal(b.expectedLossPerBtc, 0);
});

test('the credit is reported against the margin it ties up', () => {
  const l = leg({ cp: 'C', strike: 79_600, bid: 18, ask: 19, mark: 15, zero: 0.99, model: 0.97 });
  const e = legEv(l, opts, { maxOi: 1, maxVolume: 1, atmIv: 0.3, expectedMove: 900 });
  assert.ok(e.premiumYieldPct! > 0, 'a yield, not a bare number of dollars');
  assert.ok(Math.abs(e.premiumPerExpectedMove! - 18 / 900) < 1e-12);
});

test('there is no yield to report without an expected move to report it against', () => {
  const l = leg({ cp: 'C', strike: 79_600, bid: 18, ask: 19, mark: 15, zero: 0.99, model: 0.97 });
  assert.equal(legEv(l, opts).premiumPerExpectedMove, null);
});

test('how busy a strike is, banded rather than left as a ratio', () => {
  const band = (oi: number, volume: number) =>
    legEv(leg({ cp: 'C', strike: 79_600, bid: 18, mark: 15, zero: 0.99, model: 0.97, oi, volume }), opts).liquidity;

  assert.equal(band(100_000, 1_000), 'low');      // 1%
  assert.equal(band(100_000, 10_000), 'normal');  // 10%
  assert.equal(band(100_000, 20_000), 'high');    // 20%
});

/*
 * "Resistance 89,000" on a board with BTC at 76,723 and ten hours left.
 *
 * The wall was "the strike with the largest call open interest anywhere on the
 * chain", and on Delta the far round numbers carry real open interest from
 * cheap lottery calls. 89,000 was about eleven expected moves away: open
 * interest, not a level. The near pair is what the screens draw now.
 */
test('[critical] the wall the screens draw is the heaviest within reach, not the heaviest on the board', () => {
  const book = [
    // near the money: the level a seller can actually trade against
    leg({ cp: 'C', strike: 77_400, bid: 5, mark: 5, zero: 0.99, model: 0.97, oi: 20_000 }),
    // eleven expected moves away, and the biggest open interest on the chain
    leg({ cp: 'C', strike: 89_000, bid: 0.2, mark: 0.2, zero: 0.99, model: 0.99, oi: 500_000 }),
    leg({ cp: 'P', strike: 75_600, bid: 5, mark: 5, zero: 0.99, model: 0.97, oi: 18_000 }),
    leg({ cp: 'P', strike: 60_000, bid: 0.2, mark: 0.2, zero: 0.99, model: 0.99, oi: 400_000 }),
  ];
  const s = optionStructure(snap(SPOT, book), null);
  assert.equal(s.ceOiWall!.strike, 89_000, 'the heaviest on the board is still reported');
  assert.equal(s.ceOiWallNear!.strike, 77_400, 'and the one within reach is what the screens draw');
  assert.equal(s.peOiWallNear!.strike, 75_600);
  assert.equal(s.wallWithinEm, 2);
  // it says how far each one is, in percent and in expected moves
  assert.ok(Math.abs(s.ceOiWall!.emAway! - Math.abs(89_000 - SPOT) / 900) < 1e-9);
  assert.ok(s.ceOiWallNear!.emAway! <= 2);
});

test('[critical] with nothing heavy near the money the near wall is absent, not the far one moved in', () => {
  const book = [
    leg({ cp: 'C', strike: 89_000, bid: 0.2, mark: 0.2, zero: 0.99, model: 0.99, oi: 500_000 }),
    leg({ cp: 'P', strike: 60_000, bid: 0.2, mark: 0.2, zero: 0.99, model: 0.99, oi: 400_000 }),
  ];
  const s = optionStructure(snap(SPOT, book), null);
  assert.equal(s.ceOiWallNear, null);
  assert.equal(s.peOiWallNear, null);
  assert.equal(s.ceOiWall!.strike, 89_000, 'the board still says where the open interest actually is');
});

test('how far a wall may sit is a setting, and a call above spot is never support', () => {
  const book = [
    leg({ cp: 'C', strike: 79_000, bid: 2, mark: 2, zero: 0.99, model: 0.98, oi: 90_000 }),
    leg({ cp: 'P', strike: 74_000, bid: 2, mark: 2, zero: 0.99, model: 0.98, oi: 90_000 }),
  ];
  // 79,000 is 2.9 expected moves away: outside the default, inside a wider one
  assert.equal(optionStructure(snap(SPOT, book), null).ceOiWallNear, null);
  assert.equal(optionStructure(snap(SPOT, book), null, 4).ceOiWallNear!.strike, 79_000);
  // and a put is only ever looked for below spot, a call only above it
  const s = optionStructure(snap(SPOT, book), null, 10);
  assert.ok(s.peOiWallNear!.strike <= SPOT);
  assert.ok(s.ceOiWallNear!.strike >= SPOT);
});

