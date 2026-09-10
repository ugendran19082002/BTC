import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillChargesUsd, tradeCharges } from '../../src/trading/charges.js';
import { applyEvent, initialTrade } from '../../src/trading/machine.js';
import type { TradeEvent } from '../../src/trading/types.js';

/*
 * Real fills from the account's Delta trade-history export, 10 September 2026.
 * Spot is recovered from Delta's own "Value Notional" column. The expected
 * figure is Delta's "Fees paid", which already includes GST.
 */
const STATEMENT = [
  { what: 'buy back 425 C-80200 @ 2 (market)', price: 2, qty: 425, notional: 33224.375, feesPaid: 0.035105 },
  { what: 'buy back 425 P-76400 @ 2 (market)', price: 2, qty: 425, notional: 33378.14, feesPaid: 0.035105 },
  { what: 'sell 225 C-80200 @ 12', price: 12, qty: 225, notional: 17596.89, feesPaid: 0.11151 },
  { what: 'sell 200 C-80200 @ 12', price: 12, qty: 200, notional: 15640.96, feesPaid: 0.09912 },
  { what: 'sell 46 P-76400 @ 15', price: 15, qty: 46, notional: 3595.8982, feesPaid: 0.028497 },
  { what: 'sell 14 P-76400 @ 15', price: 15, qty: 14, notional: 1094.4024, feesPaid: 0.008673 },
];

for (const row of STATEMENT) {
  test(`[critical] matches Delta's statement to the last digit: ${row.what}`, () => {
    const spot = row.notional / (row.qty * 0.001);
    const c = fillChargesUsd({ price: row.price, contracts: row.qty, contractValue: 0.001, spot });
    assert.equal(c.totalUsd.toFixed(6), row.feesPaid.toFixed(6));
  });
}

test('the fee is 3.5% of premium plus 18% GST on it', () => {
  // 425 x 2 x 0.001 = $0.85 premium; 3.5% = 0.02975; GST 0.005355
  const c = fillChargesUsd({ price: 2, contracts: 425, contractValue: 0.001, spot: 78_000 });
  assert.equal(c.feeUsd.toFixed(6), '0.029750');
  assert.equal(c.gstUsd.toFixed(6), '0.005355');
});

test('on an expensive option the notional rate is the smaller half, and is what is charged', () => {
  // premium 2000 x 1 x 0.001 = $2, cap $0.07; notional 80,000 x 0.001 = $80, 0.01% = $0.008
  const c = fillChargesUsd({ price: 2_000, contracts: 1, contractValue: 0.001, spot: 80_000 });
  assert.equal(c.feeUsd.toFixed(6), '0.008000');
  assert.equal(c.totalUsd.toFixed(6), '0.009440');
});

test('without a spot the cap alone prices it, and on cheap options that changes nothing', () => {
  const withSpot = fillChargesUsd({ price: 12, contracts: 225, contractValue: 0.001, spot: 78_208 });
  const without = fillChargesUsd({ price: 12, contracts: 225, contractValue: 0.001, spot: null });
  assert.equal(without.totalUsd, withSpot.totalUsd);
});

test('an option that settles worthless costs nothing to settle', () => {
  assert.equal(fillChargesUsd({ price: 0, contracts: 425, contractValue: 0.001, spot: 78_000 }).totalUsd, 0);
});

test('a trade is charged on every fill, entry and exit kept apart, and "since" keeps only the later ones', () => {
  const AT = Date.UTC(2026, 8, 10, 1, 30);
  let s = initialTrade({ tradeId: 't', symbol: 'C-BTC-80200-100926', productId: 1, optionSide: 'CE', requestedSize: 425, at: AT, contractValue: 0.001 });
  const events: TradeEvent[] = [
    { t: 'entry_submitted', clientOrderId: 'c', size: 425, at: AT },
    { t: 'fill', role: 'entry', side: 'sell', size: 200, price: 12, orderId: 'e', at: AT },
    { t: 'fill', role: 'entry', side: 'sell', size: 225, price: 12, orderId: 'e', at: AT + 60_000 },
    { t: 'fill', role: 'exit', side: 'buy', size: 425, price: 2, orderId: 'x', at: AT + 5 * 3_600_000 },
  ];
  for (const e of events) s = applyEvent(s, e);

  const all = tradeCharges(s, { spot: 78_000 });
  assert.equal(all.entryUsd.toFixed(6), (0.09912 + 0.11151).toFixed(6));
  assert.equal(all.exitUsd.toFixed(6), '0.035105');
  assert.equal(all.totalUsd.toFixed(6), (0.09912 + 0.11151 + 0.035105).toFixed(6));

  const later = tradeCharges(s, { spot: 78_000, since: AT + 30_000 });
  assert.equal(later.totalUsd.toFixed(6), (0.11151 + 0.035105).toFixed(6));
});
