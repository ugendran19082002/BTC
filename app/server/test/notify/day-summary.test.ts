import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialTrade, replay } from '../../src/trading/machine.js';
import { bookWentFlat, daySummaryFor, type DayContext } from '../../src/notify/messages.js';
import type { TradePlan, TradeRecord } from '../../src/trading/engine.js';
import type { OrderRole, ProductSpec, TradeEvent } from '../../src/trading/types.js';
import { ceProduct, peProduct, planFor } from '../trading/harness.js';

const HOUR = 3_600_000;
const DAY_START = Date.UTC(2026, 8, 10, 0, 0, 0);   // 05:30 IST, Thursday 10 September 2026
const CLOSE = DAY_START + 12 * HOUR - 60_000;        // 17:29 IST, when the strategy exits

const ctx = (over: Partial<DayContext> = {}): DayContext => ({
  mode: 'live', dayStart: DAY_START, at: CLOSE, spot: 80_000, workingOrders: 0, ...over,
});

const fill = (role: OrderRole, size: number, price: number, at = CLOSE): TradeEvent => ({
  t: 'fill', role, side: role === 'entry' ? 'sell' : 'buy', size, price, orderId: `o-${role}`, at,
});

function trade(id: string, product: ProductSpec, events: TradeEvent[], over: Partial<TradePlan> = {}): TradeRecord {
  const plan = planFor(product, { tradeId: id, ...over });
  const all: TradeEvent[] = [{ t: 'entry_submitted', clientOrderId: `c-${id}`, size: 100, at: DAY_START + 1_000 }, ...events];
  const init = initialTrade({
    tradeId: id, symbol: product.symbol, productId: product.productId, optionSide: product.optionSide,
    requestedSize: 100, at: DAY_START, contractValue: 0.001,
  });
  return { plan, events: all, state: replay(init, all) };
}

// Sold at 100.5, bought back at the 90 target: +$1.05 gross.
const WIN = trade('t-ce', ceProduct(), [fill('entry', 100, 100.5, DAY_START + 1.5 * HOUR), fill('take_profit', 100, 90)]);
// Sold at 50, stopped at 60: -$1.00 gross.
const LOSS = trade('t-pe', peProduct(), [fill('entry', 100, 50, DAY_START + 1.6 * HOUR), fill('stop_loss', 100, 60)]);
const OPEN = trade('t-open', ceProduct(), [fill('entry', 100, 100.5, DAY_START + 2 * HOUR)]);

test('the summary adds the day up: premium, gross, charges, and net', () => {
  const a = daySummaryFor([LOSS, WIN], ctx());
  assert.ok(a);
  assert.equal(a.key, 'day:2026-09-10');
  assert.match(a.text, /📊 <b>DAY SUMMARY · Thu 10 Sep 2026<\/b>/);
  assert.match(a.text, /All positions closed · LIVE/);
  assert.match(a.text, /Trades: <b>2<\/b> · ✅ 1 won · 🔻 1 lost/);
  // (100.5 + 50) x 100 x 0.001 = $15.05, at 85 = 1,279.25
  assert.match(a.text, /Premium collected: <b>₹1,279<\/b> \(\$15\.05\)/);
  // 1.05 - 1.00 = $0.05, at 85 = 4.25
  assert.match(a.text, /Gross P&amp;L: <b>\+₹4\.25<\/b> \(\+\$0\.05\)/);
  // 3.5% of premium on both sides of both trades, plus 18% GST:
  // (0.35175 + 0.315 + 0.175 + 0.21) x 1.18 = $1.241065, at 85 = 105.49
  assert.match(a.text, /Charges \(est\.\): -₹105 \(-\$1\.24\)/);
  // and that turns a small win into a loss, which is the reason the line exists
  assert.match(a.text, /🔴 <b>Net P&amp;L: -₹101 \(-\$1\.19\)<\/b>/);
  assert.match(a.text, /17:29 IST · charges are estimates/);
});

test('each trade gets one line saying how it ended, in the order they were opened', () => {
  const a = daySummaryFor([LOSS, WIN], ctx())!;
  const win = a.text.indexOf('✅ BTC 80,000 CE · 100 @ 100.5 → 90.0 · +₹89');
  const loss = a.text.indexOf('🛑 BTC 77,000 PE · 100 @ 50.0 → 60.0 · -₹85');
  assert.ok(win > 0, a.text);
  assert.ok(loss > win, a.text);
});

test('a winning day says how much of the premium it kept, and a losing one does not pretend to', () => {
  // 1.05 of 10.05
  assert.match(daySummaryFor([WIN], ctx())!.text, /Kept 10% of the premium/);
  assert.doesNotMatch(daySummaryFor([LOSS], ctx())!.text, /Kept/);
});

test('positions still open and orders that never filled are not in it, and a day with nothing closed says nothing', () => {
  const never = trade('t-never', ceProduct(), []);
  assert.equal(daySummaryFor([OPEN, never], ctx()), null);
  assert.match(daySummaryFor([WIN, OPEN, never], ctx())!.text, /Trades: <b>1<\/b>/);
});

test('a trade closed before the day began belongs to the day before', () => {
  const yesterday = trade('t-old', ceProduct(), [
    fill('entry', 100, 100.5, DAY_START - 10 * HOUR), fill('take_profit', 100, 90, DAY_START - HOUR),
  ]);
  assert.equal(daySummaryFor([yesterday], ctx()), null);
});

test('a position closed on Delta without a fill is listed, and left out of the totals out loud', () => {
  const offDesk = trade('t-off', ceProduct(), [
    fill('entry', 100, 100.5, DAY_START + HOUR), { t: 'reconciled', position: 0, at: CLOSE },
  ]);
  const a = daySummaryFor([WIN, offDesk], ctx())!;
  assert.match(a.text, /closed on Delta · P&amp;L unknown/);
  assert.match(a.text, /1 trade closed on Delta without a fill — not in the P&amp;L totals/);
  assert.match(a.text, /Gross P&amp;L: <b>\+₹89<\/b>/);
});

test('orders still resting with no position are mentioned', () => {
  assert.match(daySummaryFor([WIN], ctx({ workingOrders: 1 }))!.text, /1 order still working, no position yet/);
});

test('a paper day says PAPER on its first line', () => {
  assert.match(daySummaryFor([WIN], ctx({ mode: 'paper' }))!.text.split('\n')[0]!, /PAPER/);
});

test('without a spot, the fee comes from the premium cap alone -- which is what binds on options this cheap', () => {
  assert.equal(daySummaryFor([LOSS, WIN], ctx({ spot: null }))!.text, daySummaryFor([LOSS, WIN], ctx())!.text);
});

test('the day is over only when the last position closes, not the first of two legs', () => {
  const closing = { ...WIN.state, position: -100 };
  assert.equal(bookWentFlat(closing, WIN.state, [WIN.state]), true);
  assert.equal(bookWentFlat(closing, WIN.state, [WIN.state, OPEN.state]), false);
  // nothing closed at all
  assert.equal(bookWentFlat(WIN.state, WIN.state, [WIN.state]), false);
});

test('every & in the summary is an entity', () => {
  const offDesk = trade('t-off', ceProduct(), [fill('entry', 100, 100.5, DAY_START + HOUR), { t: 'reconciled', position: 0, at: CLOSE }]);
  const a = daySummaryFor([WIN, LOSS, offDesk], ctx({ workingOrders: 2, mode: 'paper' }))!;
  assert.doesNotMatch(a.text, /&(?!amp;|lt;|gt;|quot;)/, a.text);
});
