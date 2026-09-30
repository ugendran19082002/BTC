import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIMITS, precheck, type PrecheckInput } from '../../src/trading/precheck.js';
import { slippageOf, targetTickFor } from '../../src/trading/money.js';

/**
 * The exits of a short option, audited on 30 Sep 2026 against the day's six
 * live trades. Every position this desk holds is short, so the stop *and* the
 * target are buy-backs -- which two pieces had read the other way.
 */

const NOW = 1_790_767_882_000;

/** A sell of one contract, with only the fields the exit checks read being the point. */
function input(o: { price: number; stop: number | null; bid: number; ask: number; stopOnOffer?: boolean }): PrecheckInput {
  return {
    now: NOW,
    intent: {
      side: 'sell', size: 10, price: o.price, reduceOnly: false, leverage: 200, crossing: false,
      expect: { underlying: 'BTC', optionSide: 'CE', strike: 84_000, expiryTs: 1_790_768_000 },
      stopPrice: o.stop, takeProfitPrice: null, stopOnOffer: o.stopOnOffer ?? true,
    },
    spot: 83_900,
    product: null,
    quote: { symbol: 'C-BTC-84000-300926', bid: o.bid, ask: o.ask, bidSize: 100, askSize: 100, mark: o.bid, ts: NOW },
    feedHealthy: true,
    tradingEnabled: true,
    account: { availableUsd: 10_000 },
    existingPosition: 0,
    totalShortContracts: 0,
    dayPnlUsd: 0,
    worstCaseLossUsd: 0,
    limits: DEFAULT_LIMITS,
  };
}
const codes = (i: PrecheckInput) => { const r = precheck(i); return r.ok ? [] : r.failures.map((f) => f.code); };

test('[critical] a stop inside the spread is refused: the offer is already there, and the desk would buy back at once', () => {
  // Resting at a 5.80 offer, 10% stop: filled at the 5.00 bid it follows to 5.50 -- under the offer.
  assert.ok(codes(input({ price: 5.8, stop: 6.38, bid: 5, ask: 5.8 })).includes('STOP_INSIDE_SPREAD'));
});

test('[critical] the day\'s real stops (185% over the entry) are nowhere near the spread and pass', () => {
  // 30 Sep 2026, 17:01: CE 84000 offered at 6 over a 5 bid, stop 17.1.
  assert.ok(!codes(input({ price: 6, stop: 17.1, bid: 5, ask: 6 })).includes('STOP_INSIDE_SPREAD'));
  // PE 83800 offered at 39 over a 36 bid, stop 111.2.
  assert.ok(!codes(input({ price: 39, stop: 111.2, bid: 36, ask: 39 })).includes('STOP_INSIDE_SPREAD'));
});

test('a stop judged on a closed bar is not judged on the offer, so the spread does not decide it', () => {
  assert.ok(!codes(input({ price: 5.8, stop: 6.38, bid: 5, ask: 5.8, stopOnOffer: false })).includes('STOP_INSIDE_SPREAD'));
});

test('[critical] a target is a buy-back: filled cheaper than asked is not slippage against the desk, dearer is', () => {
  assert.deepEqual(slippageOf('take_profit', 0.3, 0.2), { points: -0.1, pct: -33.3 });
  assert.deepEqual(slippageOf('take_profit', 0.3, 0.4), { points: 0.1, pct: 33.3 });
  // The day's fills: every target bought back at exactly its price.
  for (const [asked, filled] of [[0.2, 0.2], [0.4, 0.4], [0.1, 0.1]] as const) {
    assert.equal(slippageOf('take_profit', asked, filled)!.points, 0);
  }
});

test('[critical] a target rounds up to the tick, towards filling -- never to the entry', () => {
  assert.equal(targetTickFor(1.05, 0.1, 42), 1.1, 'a buy limit a tick higher is one that fills');
  assert.equal(targetTickFor(0.4, 0.1, 42), 0.4, 'already on the tick: unchanged');
  assert.equal(targetTickFor(0.45, 0.1, 0.5), 0.4, 'rounding up would reach the 0.5 entry: down instead');
  assert.equal(targetTickFor(0.02, 0.1, 5), 0.1, 'never under one tick');
});
