import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextExpiry } from '../src/market/chain.js';

/**
 * The simulation runs once per ticker batch.
 *
 * Measured inside the container on 17 September: 350ms of `liveChain` on a
 * 74-strike board, none of it network -- the tickers were cached -- all of it
 * the near-zero simulation, repeated on every chain request, every strategy
 * tick and every best-pick check. On one thread that is every status and
 * price poll waiting behind it. The inputs cannot change between two reads
 * of the same batch, so the second read must not do the arithmetic again.
 */

// The nearest daily contract, whichever day the test runs on.
const expiry = nextExpiry(Math.floor(Date.now() / 1000)).expiry;

const SPOT = 77_000;
const ticker = (cp: 'C' | 'P', strike: number, mark: number) => ({
  symbol: `${cp}-BTC-${strike}-${expiry}`,
  contract_type: cp === 'C' ? 'call_options' : 'put_options',
  underlying_asset_symbol: 'BTC',
  strike_price: String(strike),
  close: mark, mark_price: String(mark), spot_price: String(SPOT), oi: '500', volume: 100,
  greeks: { delta: cp === 'C' ? '0.05' : '-0.05', gamma: '0', theta: '0', vega: '0', rho: '0', spot: String(SPOT) },
  quotes: { best_bid: String(mark - 0.3), best_ask: String(mark + 0.3), bid_size: '100', ask_size: '100', mark_iv: '0.45', bid_iv: null, ask_iv: null },
});

const board = [
  ticker('C', 78_000, 40), ticker('C', 78_200, 30), ticker('C', 78_400, 22), ticker('C', 78_600, 16),
  ticker('P', 76_000, 40), ticker('P', 75_800, 30), ticker('P', 75_600, 22), ticker('P', 75_400, 16),
  ticker('C', 77_000, 300), ticker('P', 77_000, 300),
];

test('[critical] two reads of one ticker batch share the simulated probabilities', async () => {
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response(JSON.stringify({ success: true, result: board }), { status: 200 });
  }) as typeof fetch;
  try {
    const { liveChain, WHOLE_BOARD } = await import('../src/market/chain.js');
    const a = await liveChain(WHOLE_BOARD);
    const b = await liveChain(WHOLE_BOARD);
    assert.equal(fetches, 1, 'one batch');
    assert.ok(a.legs.length >= 8);
    for (const la of a.legs) {
      const lb = b.legs.find((l) => l.cp === la.cp && l.strike === la.strike)!;
      assert.equal(lb.probs, la.probs, `${la.cp} ${la.strike}: the same object, not the same arithmetic again`);
    }
    const simulated = a.legs.filter((l) => l.probs.nearZero !== null);
    assert.ok(simulated.length >= 4, 'the out-of-the-money strikes were simulated at all');
    // The window is a display setting; the probabilities are the batch's.
    const narrow = await liveChain(1);
    assert.ok(narrow.legs.length < a.legs.length);
    for (const ln of narrow.legs) {
      assert.equal(ln.probs, a.legs.find((l) => l.cp === ln.cp && l.strike === ln.strike)!.probs);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
