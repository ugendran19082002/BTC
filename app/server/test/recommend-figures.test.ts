import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommend } from '../src/domain/recommend.js';
import type { ScoredLeg } from '../src/domain/score.js';
import type { Snapshot } from '../src/market/chain.js';

/**
 * The summary lines under "What to sell", checked against Delta's own rules.
 *
 * On 10 September 2026 the card read, for 10 lots split 5 CE / 5 PE:
 *   Margin used $5.00 · Expected profit +$0.094 · Return on margin 1.88%
 * and it looked wrong, because it was. Margin was a flat $0.50 a lot -- the
 * backtest's figure at a $100k spot -- where Delta's "Funds req." at a $77k spot
 * is about $0.386. Delta's charges were not taken off anything. And the chance
 * both legs expire worthless multiplied the two, as if a call and a put could
 * both finish in the money on the same day.
 *
 * The book below is the live chain at 22:15 IST that evening, with the screen's
 * settings: Safest, 98.8%, $10 floor, 10 lots, no hedge.
 */

const SPOT = 77_028.5;
const LOT = 0.001;

const leg = (cp: 'C' | 'P', strike: number, bid: number, ask: number, mark: number, zero: number, model: number) =>
  ({
    cp, strike, off: 0, moneyness: 'OTM', ltp: null, mark, bid, ask, sellPrice: bid,
    pOtm: model,
    zero: { model, adjusted: zero, historical: zero, sample: 500, gap: null, comparableHorizon: true, outsideTable: false },
    zeroByDistance: null, edge: null, emDistance: 1, score: null,
    probs: { expireWorthless: model, touch: 0.05, nearZero: 0.5 },
    distancePct: ((strike - SPOT) / SPOT) * 100,
  }) as unknown as ScoredLeg;

const snap = (spot = SPOT) => ({ spot, step: 200, expiry: '110926' }) as unknown as Snapshot;

const BOOK = [
  leg('C', 79_600, 18, 19, 18.7399, 0.9882, 0.96686),
  leg('P', 74_000, 13.7, 14, 10.9560, 1, 0.97935),
];
const onScreen = (spot = SPOT) => recommend(snap(spot), BOOK, null, 10, 10, 0, 'safety', 0.988);

/** Delta's fee on one fill: min(0.01% of notional, 3.5% of premium) + 18% GST. */
const charge = (price: number, lots: number, spot = SPOT) =>
  Math.min(0.0001 * spot * lots * LOT, 0.035 * price * lots * LOT) * 1.18;

const near = (actual: number | null, expected: number, eps = 1e-9, what = '') =>
  assert.ok(actual !== null && Math.abs(actual - expected) < eps, `${what}: ${actual} is not ${expected}`);

test('the book splits as the screen showed: 5 lots each side', () => {
  const r = onScreen();
  assert.equal(r.ok, true);
  assert.deepEqual(r.sides.map((s) => [s.side, s.lots]), [['CE', 5], ['PE', 5]]);
  near(r.totalCreditUsd, (18 + 13.7) * 5 * LOT, 1e-12, 'premium at the bid');
});

test('[critical] margin is Delta\'s Funds req. at today\'s spot, not a flat $0.50 a lot', () => {
  const r = onScreen();
  // spot / 200 x 0.001 per lot, plus the fee without GST -- the order ticket's number
  const perLot = (price: number) => (SPOT / 200) * LOT + Math.min(0.0001 * SPOT * LOT, 0.035 * price * LOT);
  near(r.marginUsd, perLot(18) * 5 + perLot(13.7) * 5, 1e-9, 'margin');
  assert.ok(r.marginUsd < 3.9 && r.marginUsd > 3.8, `about $3.86, not $5.00 (got ${r.marginUsd})`);
  near(r.marginInr, r.marginUsd * 85, 1e-9, 'margin in rupees');
});

test('at a $100k spot the margin comes back to the old $0.50 a lot, which is where that number came from', () => {
  const r = onScreen(100_000);
  near(r.marginUsd / 10, 0.5, 0.001, 'margin per lot at 100k');
});

test('[critical] Delta\'s charges come off what you keep', () => {
  const r = onScreen();
  near(r.chargesUsd, charge(18, 5) + charge(13.7, 5), 1e-12, 'charges');
  near(r.netCreditUsd, r.totalCreditUsd - r.chargesUsd, 1e-12, 'kept if both expire worthless');
  near(r.netCreditInr, r.netCreditUsd * 85, 1e-9, 'kept, in rupees');
});

test('[critical] expected profit is after charges, and return on margin uses the real margin', () => {
  const r = onScreen();
  // the history-weighted payout per leg, unchanged: mark x (1 - real) / (1 - model)
  const ce = (18 - 18.7399 * ((1 - 0.9882) / (1 - 0.96686))) * 5 * LOT;
  const pe = (13.7 - 10.956 * ((1 - 1) / (1 - 0.97935))) * 5 * LOT;
  near(r.expectedProfitUsd, ce + pe - r.chargesUsd, 1e-9, 'expected profit');
  near(r.returnOnMarginPct, (r.expectedProfitUsd! / r.marginUsd) * 100, 1e-9, 'return on margin');
});

test('[critical] a call and a put cannot both lose, so the chance both win is 1 minus each chance of losing', () => {
  const book = [
    leg('C', 79_600, 18, 19, 18.7, 0.99, 0.97),
    leg('P', 74_000, 14, 15, 14.2, 0.99, 0.97),
  ];
  const r = recommend(snap(), book, null, 10, 10, 0, 'safety', 0.98);
  near(r.bothZeroChance, 0.98, 1e-12, 'both expire worthless');
  assert.notEqual(r.bothZeroChance, 0.99 * 0.99, 'the product counts a day on which both lose');
});

test('when nothing qualifies, the margin shown is still Delta\'s for the lots asked for', () => {
  const r = recommend(snap(), BOOK, null, 50, 10, 0, 'safety', 0.988);   // a $50 floor nothing clears
  assert.equal(r.ok, false);
  near(r.marginUsd, 10 * (SPOT / 200) * LOT, 1e-9, 'margin for 10 lots');
  assert.equal(r.chargesUsd, 0);
});
