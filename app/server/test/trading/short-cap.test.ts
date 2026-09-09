import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LIMITS, maxShortContractsFor, precheck, type PrecheckInput,
} from '../../src/trading/precheck.js';

/**
 * The total-short cap, made settable from the screen.
 *
 * Written after a live refusal nobody could explain from the desk: 410
 * contracts were already short, the ticket offered "775 lots at 200x", and the
 * gate answered "Would take total short to 820, limit is 500". Every number on
 * that screen was right and none of them agreed.
 *
 * The rule the cap has to keep is the one `maxDailyLossUsd` already keeps: the
 * browser may ask the desk to risk *less*, never more. A cap above what the
 * margin can carry can never fire, and a gate that cannot fire is worse than no
 * gate, because it reads as protection.
 */

test('with nothing chosen, the margin ceiling is the cap', () => {
  assert.equal(maxShortContractsFor(900, null), 900);
});

test('a smaller choice lowers the cap', () => {
  assert.equal(maxShortContractsFor(900, 500), 500);
});

test('[critical] a choice above the margin ceiling cannot raise the cap', () => {
  // The whole point. Asking for 5,000 on margin that covers 900 must not
  // produce a limit of 5,000 -- it produces 900, and the gate still bites.
  assert.equal(maxShortContractsFor(900, 5_000), 900);
});

test('an unknown ceiling falls back to the fixed default rather than to no limit', () => {
  // No spot or no balance read yet. The dangerous answer here is Infinity.
  assert.equal(maxShortContractsFor(null, null), DEFAULT_LIMITS.maxShortContracts);
  assert.equal(maxShortContractsFor(null, 5_000), DEFAULT_LIMITS.maxShortContracts);
  assert.equal(maxShortContractsFor(null, 50), 50);
});

test('a nonsense ceiling is treated as no ceiling, not as zero', () => {
  // A zero cap would refuse every order on the desk, which is a worse failure
  // than the one it is guarding against.
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(maxShortContractsFor(bad, null), DEFAULT_LIMITS.maxShortContracts);
  }
});

test('a nonsense choice leaves the ceiling standing', () => {
  for (const bad of [0, -5, Number.NaN]) {
    assert.equal(maxShortContractsFor(900, bad), 900);
  }
});

test('fractional numbers are floored, never rounded up', () => {
  // Rounding up would let a cap of 500.9 permit 501 contracts.
  assert.equal(maxShortContractsFor(900.9, null), 900);
  assert.equal(maxShortContractsFor(900, 500.9), 500);
});

test('a sub-contract choice is ignored rather than halting the desk', () => {
  assert.equal(maxShortContractsFor(900, 0.4), 900);
});

test('[critical] a ceiling below one contract never becomes a cap of zero', () => {
  // floor(0.5) is 0, and a cap of 0 refuses every order on the desk -- a worse
  // failure than the one the cap exists to prevent.
  assert.equal(maxShortContractsFor(0.5, null), DEFAULT_LIMITS.maxShortContracts);
  // An explicit choice of 1 is still honoured: asking to risk less is allowed.
  assert.equal(maxShortContractsFor(0.5, 1), 1);
});

/**
 * The gate itself, on the board from the incident: 80,800 CE, bid 25 / ask 28,
 * spot 78,607.8, $305.59 free. Resting at the offer, so the spread and depth
 * gates do not apply -- the cap is the only thing under test.
 */
const NOW = 1_700_000_000_000;
const EXPIRY_TS = Math.floor(NOW / 1000) + 63_000;

const gateInput = (totalShort: number, size: number, cap: number): PrecheckInput => ({
  now: NOW,
  intent: {
    side: 'sell',
    size,
    expect: { underlying: 'BTC', optionSide: 'CE', strike: 80_800, expiryTs: EXPIRY_TS },
    price: 26,
    reduceOnly: false,
    leverage: 200,
    crossing: false,
    stopPrice: null,
  },
  spot: 78_607.8,
  product: {
    symbol: 'C-BTC-80800-090926', productId: 1, underlying: 'BTC', optionSide: 'CE',
    strike: 80_800, expiryTs: EXPIRY_TS, tickSize: 0.1, lotSize: 1,
    contractValue: 0.001, state: 'live',
  },
  quote: {
    symbol: 'C-BTC-80800-090926', bid: 25, ask: 28,
    bidSize: 5_000, askSize: 5_000, mark: 26.19, at: NOW,
  },
  feedHealthy: true,
  tradingEnabled: true,
  account: { availableUsd: 305.59 },
  existingPosition: 0,
  totalShortContracts: totalShort,
  dayPnlUsd: 0,
  worstCaseLossUsd: 0,
  limits: { ...DEFAULT_LIMITS, maxShortContracts: cap },
});

test('the live refusal reproduces: 410 short, 410 more, cap 500', () => {
  const res = precheck(gateInput(410, 410, 500));
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.failures.some((f) => f.code === 'MAX_POSITION'));
  assert.ok(
    !res.ok && res.failures.some((f) => f.message.includes('820') && f.message.includes('500')),
    'the refusal has to name both numbers, or it cannot be acted on',
  );
});

test('the same order passes once the cap is raised to what margin allows', () => {
  const res = precheck(gateInput(410, 410, 900));
  assert.equal(res.ok, true);
});

test('exactly at the cap is allowed; one contract over is not', () => {
  assert.equal(precheck(gateInput(410, 90, 500)).ok, true);
  assert.equal(precheck(gateInput(410, 91, 500)).ok, false);
});
