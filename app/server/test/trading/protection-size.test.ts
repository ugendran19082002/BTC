import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientId, missingProtection } from '../../src/trading/engine.js';
import { applyEvent, initialTrade } from '../../src/trading/machine.js';
import type { TradeRecord } from '../../src/trading/engine.js';
import type { TradeState } from '../../src/trading/types.js';

/**
 * Protection has to cover the position, not merely exist.
 *
 * 10 September 2026, live. A 425-contract entry rested at the offer and filled
 * in pieces. Protection went on after the first 26, and from then on the trade
 * read as "protected" every second: an id was present, and it belonged to the
 * trade, which was everything `missingProtection` checked. `protect()` was
 * therefore never called again, and when the entry reached 425 the book still
 * held a take-profit for 26.
 *
 * Delta's own screen showed it plainly -- position 425, reduce-only order 26 --
 * and the desk showed a shield. 399 contracts with no exit behind them.
 *
 * An id proves an order exists. Only the size proves it covers anything.
 */
const TRADE = 'P-BTC-76400-100926-1789003759731';

const recordFor = (position: number, protection: Partial<TradeState['protection']>): TradeRecord => {
  let state = initialTrade({
    tradeId: TRADE, symbol: 'P-BTC-76400-100926', productId: 1,
    optionSide: 'PE', requestedSize: 425, at: 1_789_003_759_731,
  });
  state = { ...state, position, protection: { takeProfit: null, stopLoss: null, ...protection } };
  return {
    state,
    plan: { takeProfitPrice: 0.8, stopPrice: null } as TradeRecord['plan'],
    events: [],
  };
};

test('[critical] a target covering less than the position reads as missing', () => {
  // The incident, exactly: 425 short, protection placed for 26.
  const rec = recordFor(-425, { takeProfit: clientId(TRADE, 'take_profit', 0), size: 26 });
  assert.equal(missingProtection(rec), true,
    'this is what makes protect() run again and resize the order');
});

test('a target covering the whole position is protected', () => {
  const rec = recordFor(-425, { takeProfit: clientId(TRADE, 'take_profit', 0), size: 425 });
  assert.equal(missingProtection(rec), false);
});

test('covering more than the position is resized to what is left', () => {
  // A partial exit leaves the stop larger than what is left. This used to read
  // as protected, so protect() never ran and nothing trimmed it -- and Delta
  // does not promise to keep a reduce-only order bigger than the position.
  const rec = recordFor(-200, { takeProfit: clientId(TRADE, 'take_profit', 0), size: 425 });
  assert.equal(missingProtection(rec), true);
});

test('[critical] a record written before size was tracked re-checks rather than being trusted', () => {
  const rec = recordFor(-425, { takeProfit: clientId(TRADE, 'take_profit', 0) });
  assert.equal(missingProtection(rec), true);
});

test('a foreign id is still missing, whatever size it claims', () => {
  const other = 'C-BTC-80200-100926-1789003757024';
  const rec = recordFor(-425, { takeProfit: clientId(other, 'take_profit', 0), size: 425 });
  assert.equal(missingProtection(rec), true);
});

test('no protection at all is missing', () => {
  assert.equal(missingProtection(recordFor(-425, {})), true);
});

test('a flat trade is never acted on, though it reads as missing', () => {
  /*
   * Position zero with a target in the plan does read as missing here, and
   * always did -- there is no id, so there is nothing that covers anything.
   * Nothing acts on it: pollInner checks `position !== 0` before asking, and
   * protect() returns immediately when protectionSize is zero. The guard lives
   * at the caller, and this pins that it is the caller's job rather than
   * quietly changing what this function means.
   */
  assert.equal(missingProtection(recordFor(0, { takeProfit: null, size: 0 })), true);
});

/* ------------------------------------------------------- the reducer ------ */

test('the placed event records the size it covers', () => {
  const start = initialTrade({
    tradeId: TRADE, symbol: 'P-BTC-76400-100926', productId: 1,
    optionSide: 'PE', requestedSize: 425, at: 1,
  });
  const filled = applyEvent(
    { ...start, position: -26 },
    { t: 'protection_placed', takeProfit: 'x', stopLoss: null, size: 26, at: 2 },
  );
  assert.equal(filled.protection.size, 26);
});

test('an event without a size falls back to the position it was placed at', () => {
  const start = initialTrade({
    tradeId: TRADE, symbol: 'P-BTC-76400-100926', productId: 1,
    optionSide: 'PE', requestedSize: 425, at: 1,
  });
  const s = applyEvent(
    { ...start, position: -26 },
    { t: 'protection_placed', takeProfit: 'x', stopLoss: null, at: 2 },
  );
  assert.equal(s.protection.size, 26);
});

test('[critical] the incident replays: 26 covered, then the entry finishes at 425', () => {
  let s = initialTrade({
    tradeId: TRADE, symbol: 'P-BTC-76400-100926', productId: 1,
    optionSide: 'PE', requestedSize: 425, at: 1,
  });
  s = applyEvent(s, { t: 'fill', role: 'entry', side: 'sell', size: 26, price: 15, orderId: 'o1', at: 2 });
  s = applyEvent(s, { t: 'protection_placed', takeProfit: 'x', stopLoss: null, size: 26, at: 3 });
  assert.equal(s.protection.size, 26);

  // the rest of the entry prints
  s = applyEvent(s, { t: 'fill', role: 'entry', side: 'sell', size: 399, price: 15, orderId: 'o1', at: 4 });
  assert.equal(s.position, -425);

  const rec: TradeRecord = {
    state: { ...s, protection: { ...s.protection, takeProfit: clientId(TRADE, 'take_profit', 0) } },
    plan: { takeProfitPrice: 0.8, stopPrice: null } as TradeRecord['plan'],
    events: [],
  };
  assert.equal(missingProtection(rec), true,
    'the desk must notice the order it placed no longer covers what it holds');
});
