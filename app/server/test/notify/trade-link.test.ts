import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, initialTrade } from '../../src/trading/machine.js';
import { alertFor, type AlertContext } from '../../src/notify/messages.js';
import { plain } from '../../src/notify/telegram.js';
import { deskUrlOf } from '../../src/config.js';
import type { OrderRole, TradeEvent, TradeState } from '../../src/trading/types.js';
import { ceProduct, planFor } from '../trading/harness.js';

/**
 * A fill's message links to the trade on the phone (6 Oct 2026), when the desk knows its own address
 * (`DESK_URL`) -- and says nothing different without it.
 */

const AT = Date.UTC(2026, 9, 6, 6, 0, 0);
const PLAN = planFor(ceProduct());
const start = (): TradeState => initialTrade({
  tradeId: 'C-BTC-80000-071026-1791268000000', symbol: PLAN.symbol, productId: 111, optionSide: 'CE',
  requestedSize: 100, at: AT, contractValue: 0.001,
});
const fill = (role: OrderRole, size: number, price: number): TradeEvent => ({
  t: 'fill', role, side: role === 'entry' ? 'sell' : 'buy', size, price, orderId: `o-${role}`, at: AT,
});

function lastAlert(events: TradeEvent[], ctx: AlertContext) {
  let s = start();
  let a = null;
  for (const e of [{ t: 'entry_submitted', clientOrderId: 'c', size: 100, at: AT } as TradeEvent, ...events]) {
    const next = applyEvent(s, e);
    a = alertFor(e, s, next, PLAN, ctx) ?? a;
    s = next;
  }
  return a!;
}

const LINK = '📱 <a href="https://delta.thannigo.in/m?trade=C-BTC-80000-071026-1791268000000">Open this trade</a>';

test('an entry fill and an exit fill link to the trade on the phone', () => {
  const ctx: AlertContext = { mode: 'live', deskUrl: 'https://delta.thannigo.in' };
  assert.ok(lastAlert([fill('entry', 100, 20)], ctx).text.includes(LINK));
  assert.ok(lastAlert([fill('entry', 100, 20), fill('take_profit', 100, 2)], ctx).text.includes(LINK));
});

test('[critical] with no desk address the message is exactly what it was', () => {
  const without = lastAlert([fill('entry', 100, 20)], { mode: 'live' }).text;
  assert.doesNotMatch(without, /<a |Open this trade/);
  const withNull = lastAlert([fill('entry', 100, 20)], { mode: 'live', deskUrl: null }).text;
  assert.equal(withNull, without);
});

test('when Telegram refuses the markup, the plain text keeps the link\'s address', () => {
  assert.equal(plain(`x\n${LINK}`), 'x\n📱 Open this trade: https://delta.thannigo.in/m?trade=C-BTC-80000-071026-1791268000000');
});

test('DESK_URL: an http(s) origin, trailing slash and path dropped; anything else is no link at all', () => {
  assert.equal(deskUrlOf('https://delta.thannigo.in/'), 'https://delta.thannigo.in');
  assert.equal(deskUrlOf(' https://delta.thannigo.in/some/path '), 'https://delta.thannigo.in');
  assert.equal(deskUrlOf('http://127.0.0.1:8099'), 'http://127.0.0.1:8099');
  assert.equal(deskUrlOf(''), null);
  assert.equal(deskUrlOf(undefined), null);
  assert.equal(deskUrlOf('delta.thannigo.in'), null);
  assert.equal(deskUrlOf('javascript:alert(1)'), null);
});
