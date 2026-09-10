import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, initialTrade } from '../../src/trading/machine.js';
import { alertFor, missedEntryAlert, runAlertFor, type Alert, type RunOutcome } from '../../src/notify/messages.js';
import type { TradePlan } from '../../src/trading/engine.js';
import type { TradeEvent, TradeState } from '../../src/trading/types.js';
import { ceProduct, planFor } from '../trading/harness.js';

// 17:17 IST on 10 September 2026 -- when the 1-lot test exit happened.
const AT = Date.UTC(2026, 8, 10, 11, 47, 0);
const LIVE = { mode: 'live' as const };

/** Every alert the events produce, in order, as the service would see them. */
function alerts(events: TradeEvent[], opts: { wantsProtection?: boolean; plan?: TradePlan } = {}): (Alert | null)[] {
  const plan = opts.plan ?? planFor(ceProduct(), { tradeId: 't1' });
  let s: TradeState = initialTrade({
    tradeId: 't1', symbol: plan.symbol, productId: 111, optionSide: 'CE',
    requestedSize: 1, at: AT, contractValue: 0.001, wantsProtection: opts.wantsProtection ?? false,
  });
  return events.map((e) => {
    const next = applyEvent(s, e);
    const a = alertFor(e, s, next, plan, LIVE);
    s = next;
    return a;
  });
}

const submitted: TradeEvent = { t: 'entry_submitted', clientOrderId: 'c', size: 1, at: AT };
const sold: TradeEvent = { t: 'fill', role: 'entry', side: 'sell', size: 1, price: 7.4, orderId: 'o1', at: AT };
const failedProtection = (reason: string): TradeEvent => ({ t: 'protection_failed', reason, at: AT });

test('Delta refusing an order is an alert, with Delta’s reason', () => {
  const [, a] = alerts([submitted, { t: 'entry_rejected', reason: 'insufficient_margin & more', at: AT }]);
  assert.ok(a);
  assert.equal(a.key, 't1:problem');
  assert.match(a.text, /🚨 <b>ORDER REJECTED · BTC 80,000 CE<\/b>/);
  assert.match(a.text, /insufficient_margin &amp; more/);
  assert.match(a.text, /Nothing was sold/);
});

test('not knowing whether an order exists is an alert, and says nothing is sent twice', () => {
  const [, a] = alerts([submitted, { t: 'entry_submit_unknown', at: AT }]);
  assert.match(a!.text, /ORDER STATUS UNKNOWN/);
  assert.match(a!.text, /no second order is sent/);
});

test('an exit that did not go through is an alert, with what is still open', () => {
  const out = alerts([
    submitted, sold,
    { t: 'exit_submitted', role: 'manual', clientOrderId: 'x', at: AT },
    failedProtection('manual exit failed: No answer from Delta for /v2/orders.'),
  ]);
  const a = out.at(-1)!;
  assert.match(a.text, /🚨 <b>EXIT FAILED · BTC 80,000 CE<\/b>/);
  assert.match(a.text, /Still short <b>1<\/b>/);
  assert.match(a.text, /Close now/);
});

test('a position left with no stop is an alert once, not on every retry', () => {
  const out = alerts([submitted, sold, failedProtection('API down'), failedProtection('API down')], { wantsProtection: true });
  assert.match(out[2]!.text, /🚨 <b>NO STOP-LOSS · BTC 80,000 CE<\/b>/);
  assert.match(out[2]!.text, /Short <b>1<\/b> with nothing protecting it/);
  assert.equal(out[3], null, 'the retry a few seconds later does not buzz the phone again');
});

test('a target that could not go on, on a trade that chose to run without a stop, stays quiet', () => {
  const out = alerts([submitted, sold, failedProtection('target refused')], { wantsProtection: false });
  assert.equal(out.at(-1), null);
});

test('a gate refusing a hand-placed order is not an alert -- the screen already said so', () => {
  assert.deepEqual(alerts([{ t: 'precheck_failed', reason: 'Spread is 18%', at: AT }]), [null]);
});

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
  strategy: 'Double one-sided', status: 'placed', detail: 'CE 80200 x425 @ 12, PE 76400 x425 @ 15',
  failedLegs: [], at: AT, ...over,
});

test('an auto-trade that could place nothing is an alert, with each leg’s reason', () => {
  const a = runAlertFor(outcome({
    status: 'failed',
    failedLegs: ['CE 80200: Needs $3.93 at 200x, have $0.18.', 'PE 76400: Needs $3.93 at 200x, have $0.18.'],
  }), LIVE)!;
  assert.match(a.text, /🚨 <b>AUTO-TRADE FAILED · Double one-sided<\/b>/);
  assert.match(a.text, /nothing was sold today/);
  assert.match(a.text, /• CE 80200: Needs \$3\.93 at 200x/);
  assert.match(a.text, /• PE 76400/);
  assert.match(a.text, /17:17 IST · auto-trading · LIVE/);
});

test('an auto-trade that went on one-sided says which leg failed, and that the other is kept', () => {
  const a = runAlertFor(outcome({ status: 'placed', failedLegs: ['PE 76400: spread too wide'] }), LIVE)!;
  assert.match(a.text, /⚠️ <b>AUTO-TRADE PARTLY PLACED/);
  assert.match(a.text, /• PE 76400: spread too wide/);
  assert.match(a.text, /legs that went on are kept/);
});

test('a clean auto-trade sends nothing here -- its fills are announced instead', () => {
  assert.equal(runAlertFor(outcome(), LIVE), null);
});

test('a day that stood aside says so and why, so a quiet phone is never a mystery', () => {
  const a = runAlertFor(outcome({ status: 'refused', detail: 'CE: best bid 11.2 is under the $15 floor' }), LIVE)!;
  assert.match(a.text, /ℹ️ <b>STOOD ASIDE TODAY · Double one-sided<\/b>/);
  assert.match(a.text, /under the \$15 floor/);
  assert.match(a.text, /No order was placed/);
});

test('an entry window that closed with nothing tried is an alert, naming the window', () => {
  const a = missedEntryAlert('Baseline', '05:29', 60, AT, LIVE);
  assert.match(a.text, /🚨 <b>ENTRY MISSED · Baseline<\/b>/);
  assert.match(a.text, /between 05:29 and 60 minutes after it/);
  assert.equal(a.key, 'missed:Baseline:2026-09-10');
});

test('a paper-mode problem says PAPER on the first line', () => {
  const a = runAlertFor(outcome({ status: 'failed', failedLegs: ['CE: x'] }), { mode: 'paper' })!;
  assert.match(a.text.split('\n')[0]!, /PAPER/);
});

test('every & and < in every problem alert is escaped, because Telegram refuses the message otherwise', () => {
  const all = [
    ...alerts([submitted, { t: 'entry_rejected', reason: 'a < b & c', at: AT }]),
    runAlertFor(outcome({ status: 'refused', detail: 'bid < floor & ask > cap' }), LIVE),
    runAlertFor(outcome({ status: 'failed', failedLegs: ['CE <x> & y'] }), LIVE),
    missedEntryAlert('A & B <test>', '05:29', 60, AT, LIVE),
  ].filter((a): a is Alert => a !== null);
  assert.ok(all.length >= 4);
  for (const a of all) {
    const withoutTags = a.text.replace(/<\/?(b|i)>/g, '');
    assert.doesNotMatch(withoutTags, /&(?!amp;|lt;|gt;|quot;)|<|>/, a.text);
  }
});
