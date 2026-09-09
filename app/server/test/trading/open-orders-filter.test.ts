import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeltaExchange } from '../../src/trading/exchange/delta.js';

/**
 * Delta ignores `product_symbol` on GET /v2/orders when `states` is set.
 *
 * Observed on the live account, 10 September 2026. Two positions were open --
 * a 76,800 PE and an 80,800 CE -- and exactly one protective order existed
 * between them. Asking Delta for the CE's orders returned the PE's:
 *
 *   UNFILTERED open orders: 1
 *       P-BTC-76800-100926 buy limit 25.6 reduce true size 410
 *   FILTERED C-BTC-80800-100926 -> 1 orders: P-BTC-76800-100926@25.6
 *   FILTERED P-BTC-76800-100926 -> 1 orders: P-BTC-76800-100926@25.6
 *
 * Both rows on the screen read "target 25.60". The CE's own plan said 2.30 and
 * nothing for it was on the book at all, because `protect()` reconciles against
 * this list, found a reduce-only order, and concluded the position was already
 * protected. A live short with nothing behind it and a shield saying otherwise.
 *
 * `clearProtection()` reads the same list, so closing one position could have
 * cancelled the other one's target.
 *
 * No test caught it because `PaperExchange.getOpenOrders` filters correctly.
 * The simulator was written to the reading of the docs the engine was written
 * to, so both agreed and the venue disagreed with both. ARCHITECTURE.md rule 2,
 * a second time.
 *
 * These tests stub the transport, so they pin *our* filtering rather than
 * Delta's -- which is the only half we control.
 */

const row = (symbol: string, id: number, limit: string) => ({
  id,
  client_order_id: `c${id}`,
  product_id: id,
  product_symbol: symbol,
  side: 'buy' as const,
  order_type: 'limit_order',
  size: 410,
  unfilled_size: 410,
  limit_price: limit,
  state: 'open',
  reduce_only: true,
});

/** An exchange that answers every symbol with the whole account, as Delta does. */
function leakyExchange(rows: ReturnType<typeof row>[]) {
  const ex = new DeltaExchange(null as never);
  const seen: string[] = [];
  // The transport is private to TypeScript only; at runtime it is a property.
  (ex as unknown as { call: (r: { query?: string }) => Promise<unknown> }).call = async (r) => {
    seen.push(r.query ?? '');
    return rows;                    // the filter in the query is ignored
  };
  return { ex, seen };
}

const PE = 'P-BTC-76800-100926';
const CE = 'C-BTC-80800-100926';

test('[critical] a venue that ignores the symbol filter cannot leak another contract', async () => {
  const { ex } = leakyExchange([row(PE, 1, '25.6')]);
  const forCe = await ex.getOpenOrders(CE);
  assert.deepEqual(forCe, [], 'the CE has no orders; the PE\'s must not appear on it');
});

test('the symbol that does own the order still gets it', async () => {
  const { ex } = leakyExchange([row(PE, 1, '25.6')]);
  const forPe = await ex.getOpenOrders(PE);
  assert.equal(forPe.length, 1);
  assert.equal(forPe[0]!.symbol, PE);
  assert.equal(forPe[0]!.limitPrice, 25.6);
});

test('a mixed book is split by symbol rather than by position in the list', async () => {
  // The old code took the first reduce-only order it found, so ordering alone
  // decided which position's level appeared on which row.
  const { ex } = leakyExchange([row(PE, 1, '25.6'), row(CE, 2, '2.3')]);
  const ce = await ex.getOpenOrders(CE);
  const pe = await ex.getOpenOrders(PE);
  assert.equal(ce.length, 1);
  assert.equal(ce[0]!.limitPrice, 2.3, 'the CE row must show the CE level, not the first one');
  assert.equal(pe.length, 1);
  assert.equal(pe[0]!.limitPrice, 25.6);
});

test('asking for no symbol still returns the whole account', async () => {
  // close-all and reconciliation want everything; the filter must not apply
  // when none was asked for.
  const { ex } = leakyExchange([row(PE, 1, '25.6'), row(CE, 2, '2.3')]);
  assert.equal((await ex.getOpenOrders()).length, 2);
});

test('the filter is still sent, so a venue that honours it sends less', async () => {
  const { ex, seen } = leakyExchange([row(PE, 1, '25.6')]);
  await ex.getOpenOrders(PE);
  assert.ok(seen[0]!.includes('product_symbol='), 'the query should still ask');
  assert.ok(seen[0]!.includes('states=open,pending'));
});

test('an unknown symbol gets nothing rather than everything', async () => {
  const { ex } = leakyExchange([row(PE, 1, '25.6'), row(CE, 2, '2.3')]);
  assert.deepEqual(await ex.getOpenOrders('C-BTC-99999-100926'), []);
});

/* ------------------------------------------------------------------------ */

import { clientId, missingProtection, ownsClientId } from '../../src/trading/engine.js';

/**
 * The second half of the same incident.
 *
 * Adopting the PE's order was the first mistake. The one that made it permanent
 * was `missingProtection` asking only whether *an* id was recorded, not whether
 * it was one of this trade's. With the foreign id sitting in state the trade
 * read as protected, `protect()` was never called again, and the CE stayed
 * naked for as long as it stayed open.
 */
const CE_TRADE = 'C-BTC-80800-100926-1788979887592';
const PE_TRADE = 'P-BTC-76800-100926-1788977273296';

const rec = (tradeId: string, protection: { takeProfit?: string | null; stopLoss?: string | null }) =>
  ({
    plan: { takeProfitPrice: 2.3, stopPrice: null },
    state: { tradeId, protection: { takeProfit: null, stopLoss: null, ...protection } },
  }) as unknown as Parameters<typeof missingProtection>[0];

test('an id this trade issued is recognised as its own', () => {
  assert.ok(ownsClientId(CE_TRADE, clientId(CE_TRADE, 'take_profit', 0)));
});

test('[critical] the id from the incident is not this trade\'s', () => {
  // 009261788977273296T0 -- the PE's seed, recorded against the CE.
  assert.equal(ownsClientId(CE_TRADE, clientId(PE_TRADE, 'take_profit', 0)), false);
});

test('[critical] a foreign protection id reads as missing, so protect() runs again', () => {
  const adopted = rec(CE_TRADE, { takeProfit: clientId(PE_TRADE, 'take_profit', 0) });
  assert.equal(missingProtection(adopted), true, 'this is what makes the desk repair itself');
});

test('the trade\'s own id still reads as protected, so nothing thrashes', () => {
  const proper = rec(CE_TRADE, { takeProfit: clientId(CE_TRADE, 'take_profit', 0) });
  assert.equal(missingProtection(proper), false);
});

test('no id at all is still missing', () => {
  assert.equal(missingProtection(rec(CE_TRADE, { takeProfit: null })), true);
});
