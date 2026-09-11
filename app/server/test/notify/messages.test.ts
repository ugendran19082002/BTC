import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, initialTrade } from '../../src/trading/machine.js';
import { alertFor, type Alert, type AlertContext } from '../../src/notify/messages.js';
import type { TradePlan } from '../../src/trading/engine.js';
import type { OrderRole, TradeEvent, TradeState } from '../../src/trading/types.js';
import { ceProduct, planFor } from '../trading/harness.js';

// 06:59 IST on 10 September 2026 -- the time of the real 425-lot entry.
const AT = Date.UTC(2026, 8, 10, 1, 29, 0);
const PLAN = planFor(ceProduct());   // BTC 80,000 CE, target 90, stop 110

const start = (): TradeState => initialTrade({
  tradeId: 't1', symbol: PLAN.symbol, productId: 111, optionSide: 'CE',
  requestedSize: 100, at: AT, contractValue: 0.001,
});

const submitted = (size = 100): TradeEvent => ({ t: 'entry_submitted', clientOrderId: 'c', size, at: AT });

const fill = (role: OrderRole, size: number, price: number): TradeEvent => ({
  t: 'fill', role, side: role === 'entry' ? 'sell' : 'buy', size, price, orderId: `o-${role}`, at: AT,
});

/** Every alert the events produce, in order, exactly as the service would see them. */
function alerts(events: TradeEvent[], plan: TradePlan = PLAN, ctx: AlertContext = { mode: 'live' }): (Alert | null)[] {
  let s = start();
  return events.map((e) => {
    const next = applyEvent(s, e);
    const a = alertFor(e, s, next, plan, ctx);
    s = next;
    return a;
  });
}
const last = (...args: Parameters<typeof alerts>) => alerts(...args).at(-1) ?? null;

test('an entry fill says what was sold, how much, at what price, and what it paid', () => {
  const a = last([submitted(), fill('entry', 100, 100.5)]);
  assert.ok(a);
  assert.equal(a.key, 't1:entry');
  assert.match(a.text, /SOLD BTC 80,000 CE/);
  assert.match(a.text, /Filled <b>100<\/b> of 100 @ <b>100\.5<\/b>/);
  // 100.5 x 100 contracts x 0.001 BTC = $10.05, at 85 = 854.25
  assert.match(a.text, /Premium collected: <b>₹854<\/b> \(\$10\.05\)/);
  assert.match(a.text, /🎯 Target 90\.0/);
  assert.match(a.text, /🛑 Stop 110\.0/);
  assert.match(a.text, /06:59 IST/);
  assert.doesNotMatch(a.text, /still working/);
});

test('a partial entry fill says so, and that the rest is still working', () => {
  const a = last([submitted(425), fill('entry', 26, 10)]);
  assert.ok(a);
  assert.match(a.text, /Filled <b>26<\/b> of 425/);
  assert.match(a.text, /still working/);
});

test('every piece of one entry shares a key, so the phone gets one message rather than one per piece', () => {
  const [, first, second] = alerts([submitted(), fill('entry', 60, 100.5), fill('entry', 40, 99.5)]);
  assert.equal(first?.key, second?.key);
  // the second carries the whole entry, at the size-weighted average
  assert.match(second!.text, /Filled <b>100<\/b> of 100 @ <b>100\.1<\/b> avg/);
});

test('an entry cancelled part-filled replaces "still working" with what actually happened', () => {
  const a = last([submitted(425), fill('entry', 26, 10), { t: 'entry_cancelled', remaining: 399, at: AT }]);
  assert.ok(a);
  assert.equal(a.key, 't1:entry');
  assert.match(a.text, /Filled <b>26<\/b> of 425/);
  assert.match(a.text, /other 399 were cancelled/);
  assert.doesNotMatch(a.text, /still working/);
});

test('a target fill is announced as a win with booked P&L, on its own key', () => {
  const a = last([submitted(), fill('entry', 100, 100.5), fill('take_profit', 100, 90)]);
  assert.ok(a);
  assert.equal(a.key, 't1:exit');
  assert.match(a.text, /✅ <b>TARGET HIT · BTC 80,000 CE<\/b>/);
  assert.match(a.text, /Bought back <b>100<\/b> @ <b>90\.0<\/b>  \(entry 100\.5\)/);
  // (100.5 - 90) x 100 x 0.001 = $1.05, at 85 = 89.25
  assert.match(a.text, /🟢 P&amp;L: <b>\+₹89<\/b> \(\+\$1\.05\)/);
  assert.match(a.text, /Position is <b>flat<\/b>/);
});

test('a stop-loss fill is announced as a loss, with the minus sign on both currencies', () => {
  const a = last([submitted(), fill('entry', 100, 100.5), fill('stop_loss', 100, 110)]);
  assert.ok(a);
  assert.match(a.text, /🛑 <b>STOP-LOSS HIT/);
  // (100.5 - 110) x 100 x 0.001 = -$0.95, at 85 = -80.75
  assert.match(a.text, /🔴 P&amp;L: <b>-₹81<\/b> \(-\$0\.95\)/);
});

/*
 * 11 September 2026: 425 sold at 12.0, target 0.70, no stop. 200 bought back at
 * 09:08, 3 more at 09:09 -- two messages, both titled "TARGET HIT", the second
 * saying "Bought back 203". It was the total, and it read like 203 more.
 */
test('[critical] a target that fills in pieces says how many of how many, and that it is still resting', () => {
  const plan = planFor(ceProduct(), { takeProfitPrice: 0.7, stopPrice: null });
  const [, , first, second] = alerts(
    [submitted(425), fill('entry', 425, 12), fill('take_profit', 200, 0.7), fill('take_profit', 3, 0.7)],
    plan,
  );
  assert.match(first!.text, /🎯 <b>TARGET PART-FILLED · BTC 80,000 CE<\/b>/);
  assert.match(first!.text, /Bought back <b>200<\/b> of 425 @ <b>0\.7<\/b>/);
  assert.match(second!.text, /Bought back <b>203<\/b> of 425 @ <b>0\.7<\/b>/, 'the total so far, said as a total');
  // (12 - 0.7) x 203 x 0.001 = $2.2939, at 85 = 194.98 -- the +₹195 of the real alert
  assert.match(second!.text, /Booked so far: <b>\+₹195<\/b> \(\+\$2\.29\)/);
  assert.match(second!.text, /Still short <b>222<\/b> — target resting at 0\.7/);
  assert.doesNotMatch(second!.text, /TARGET HIT/, 'not hit: 222 are still short');
  assert.equal(first!.key, second!.key, 'and one key, so pieces close together are one message');
});

test('the piece that closes the position is the target hit', () => {
  const plan = planFor(ceProduct(), { takeProfitPrice: 0.7, stopPrice: null });
  const a = last([submitted(425), fill('entry', 425, 12), fill('take_profit', 203, 0.7), fill('take_profit', 222, 0.7)], plan);
  assert.match(a!.text, /✅ <b>TARGET HIT/);
  assert.match(a!.text, /Bought back <b>425<\/b> @ <b>0\.7<\/b>/);
  assert.doesNotMatch(a!.text, / of 425/);
  assert.match(a!.text, /Position is <b>flat<\/b>/);
});

test('a partial close says how much is still on', () => {
  const a = last([submitted(), fill('entry', 100, 100.5), fill('exit', 40, 95)]);
  assert.ok(a);
  assert.match(a.text, /CLOSED AT MARKET/);
  assert.match(a.text, /Still short <b>60<\/b> — exit working/);
});

test('a trade running without a stop says so in the entry alert', () => {
  const a = last([submitted(), fill('entry', 100, 100.5)], planFor(ceProduct(), { stopPrice: null }));
  assert.match(a!.text, /No stop-loss/);
});

test('a paper fill says PAPER on the first line, and a live one never does', () => {
  const events = [submitted(), fill('entry', 100, 100.5)];
  const paper = last(events, PLAN, { mode: 'paper' })!;
  assert.match(paper.text.split('\n')[0]!, /PAPER/);
  assert.match(paper.text, /simulated, no real order/);
  assert.doesNotMatch(last(events, PLAN, { mode: 'live' })!.text, /PAPER/);
});

test('a strategy trade and a hand-placed one are told apart', () => {
  const events = [submitted(), fill('entry', 100, 100.5)];
  assert.match(last(events, planFor(ceProduct(), { strategyId: 's1' }))!.text, /· strategy ·/);
  assert.match(last(events)!.text, /· manual ·/);
});

test('nothing that did not print is announced', () => {
  const [sub, , placed] = alerts([
    submitted(),
    fill('entry', 100, 100.5),
    { t: 'protection_placed', takeProfit: 'tp', stopLoss: 'sl', size: 100, at: AT },
  ]);
  assert.equal(sub, null);
  assert.equal(placed, null);
  assert.equal(last([{ t: 'precheck_failed', reason: 'Spread is 18%', at: AT }]), null);
});

test('found flat on the exchange without an exit fill is announced, and says the P&L is unknown', () => {
  const a = last([submitted(), fill('entry', 100, 100.5), { t: 'reconciled', position: 0, at: AT }]);
  assert.ok(a);
  assert.equal(a.key, 't1:exit');
  assert.match(a.text, /POSITION CLOSED/);
  assert.match(a.text, /could not be counted from fills/);
});

test('a reconcile that changes nothing, or confirms a close already announced, is silent', () => {
  // Protected, as a real position with a stop is -- an unprotected one is a problem alert, tested separately.
  assert.equal(last([
    submitted(), fill('entry', 100, 100.5),
    { t: 'protection_placed', takeProfit: 'tp', stopLoss: 'sl', size: 100, at: AT },
    { t: 'reconciled', position: -100, at: AT },
  ]), null);
  assert.equal(last([
    submitted(), fill('entry', 100, 100.5), fill('take_profit', 100, 90), { t: 'reconciled', position: 0, at: AT },
  ]), null);
});

test('every & in every message is an entity, because Telegram refuses the whole message otherwise', () => {
  const all = [
    ...alerts([submitted(425), fill('entry', 26, 10), fill('entry', 399, 10), fill('stop_loss', 425, 20)]),
    ...alerts([submitted(), fill('entry', 100, 100.5), { t: 'reconciled', position: 0, at: AT }], PLAN, { mode: 'paper' }),
  ].filter((a): a is Alert => a !== null);
  assert.ok(all.length >= 4);
  for (const a of all) assert.doesNotMatch(a.text, /&(?!amp;|lt;|gt;|quot;)/, a.text);
});
