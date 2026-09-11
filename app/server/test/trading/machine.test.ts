import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEvent, initialTrade, isDone, mustReconcile, needsProtection, protectionSize, recompute, replay,
} from '../../src/trading/machine.js';
import type { TradeEvent, TradeState } from '../../src/trading/types.js';

const AT = 1_700_000_000_000;

const start = (): TradeState => initialTrade({
  tradeId: 't1', symbol: 'C-BTC-80000-080926', productId: 1,
  optionSide: 'CE', requestedSize: 100, at: AT,
});

const fill = (size: number, price: number, role: TradeEvent extends never ? never : 'entry' | 'take_profit' | 'stop_loss' | 'exit' = 'entry'): TradeEvent => ({
  t: 'fill', role, side: role === 'entry' ? 'sell' : 'buy', size, price, orderId: `o-${role}`, at: AT,
});

test('a fresh trade holds nothing and is waiting on its gates', () => {
  const s = start();
  assert.equal(s.position, 0);
  assert.equal(s.phase, 'precheck');
  assert.equal(isDone(s), false);
});

test('the position is counted from fills, not from what was requested', () => {
  const s = replay(start(), [
    { t: 'entry_submitted', clientOrderId: 'c', size: 100, at: AT },
    fill(40, 100.5),
  ]);
  assert.equal(s.requestedSize, 100);
  assert.equal(s.entrySize, 40);
  assert.equal(s.position, -40);
  assert.equal(protectionSize(s), 40, 'a stop covers what is held, never what was asked for');
});

test('several entry fills average by size, not by count', () => {
  const s = replay(start(), [
    { t: 'entry_submitted', clientOrderId: 'c', size: 100, at: AT },
    fill(90, 100), fill(10, 90),
  ]);
  assert.equal(s.entryAvgPrice, 99, '(90×100 + 10×90) / 100');
});

test('a closed trade is flat at exactly zero, never at minus zero', () => {
  const s = replay(start(), [fill(100, 100.5), fill(100, 90, 'take_profit')]);
  assert.equal(Object.is(s.position, 0), true, 'a -0 position reads as a bug in every comparison');
  assert.equal(s.phase, 'flat');
  // through the contract size: a price is quoted per BTC, a contract is 0.001
  assert.equal(s.realisedPnl, (100.5 - 90) * 100 * 0.001);
});

test('a half-filled exit leaves the rest on and does not report flat', () => {
  const s = replay(start(), [fill(100, 100.5), fill(40, 111, 'stop_loss')]);
  assert.equal(s.position, -60);
  assert.notEqual(s.phase, 'flat');
  assert.equal(isDone(s), false);
});

test('[critical] a target or stop that fills in part is still working, not a finished exit', () => {
  // 11 September: a 425 target bought back 203 and 222 stayed short. Calling
  // that "exit_pending" took the stop off the 222 and stopped watching it.
  const s = replay(start(), [fill(100, 100.5), fill(40, 90, 'take_profit')]);
  assert.equal(s.phase, 'position_open', 'the phase it had before the piece filled');
  assert.equal(s.exitWinner, null, 'nothing has won while contracts are still short');
  assert.equal(s.realisedPnl, (100.5 - 90) * 40 * 0.001, 'the part bought back is booked');
});

test('a market exit that fills in part is still closing', () => {
  const s = replay(start(), [fill(100, 100.5), fill(40, 101, 'exit')]);
  assert.equal(s.phase, 'exit_pending');
  assert.equal(s.exitWinner, 'manual');
});

test('the exit that closes the position is the one recorded as the exit', () => {
  // half at the target, the rest stopped out: what ended the trade was the stop,
  // which is also what the Orders screen reads off the last fill
  const s = replay(start(), [fill(100, 100.5), fill(50, 90, 'take_profit'), fill(50, 111, 'stop_loss')]);
  assert.equal(s.exitWinner, 'stop_loss');
  assert.equal(s.position, 0);
  assert.equal(s.phase, 'flat');
});

test('a submit with no answer refuses to move until the exchange is read', () => {
  const s = applyEvent(start(), { t: 'entry_submit_unknown', at: AT });
  assert.equal(s.phase, 'entry_unknown');
  assert.equal(mustReconcile(s), true);
});

test('a position with no stop behind it is an alarm, not a phase', () => {
  const s = replay(start(), [fill(100, 100.5), { t: 'protection_failed', reason: 'API down', at: AT }]);
  assert.equal(s.phase, 'unprotected');
  assert.ok(s.alarm?.startsWith('POSITION UNPROTECTED'));
  assert.equal(needsProtection(s), true);
});

test('protection failing on a trade that is already flat raises nothing', () => {
  const s = replay(start(), [
    fill(100, 100.5), fill(100, 90, 'take_profit'),
    { t: 'protection_failed', reason: 'API down', at: AT },
  ]);
  assert.equal(s.alarm, null, 'there is nothing at risk to be unprotected');
  assert.equal(s.phase, 'flat');
});

test('the exchange overrules us, in both directions', () => {
  const held = replay(start(), [fill(100, 100.5), { t: 'protection_placed', takeProfit: 'tp', stopLoss: 'sl', at: AT }]);
  assert.equal(held.position, -100);

  const closed = applyEvent(held, { t: 'reconciled', position: 0, at: AT });
  assert.equal(closed.position, 0);
  assert.equal(closed.phase, 'flat');

  const trimmed = applyEvent(held, { t: 'reconciled', position: -70, at: AT });
  assert.equal(trimmed.position, -70);
  assert.equal(protectionSize(trimmed), 70);
});

test('a reconcile that finds a position with no live stop raises the alarm', () => {
  const s = replay(start(), [fill(100, 100.5), { t: 'reconciled', position: -100, at: AT }]);
  assert.equal(s.phase, 'unprotected');
  assert.ok(s.alarm);
});

test('cancelling an unfilled entry ends the trade without a position', () => {
  const s = replay(start(), [
    { t: 'entry_submitted', clientOrderId: 'c', size: 100, at: AT },
    { t: 'entry_timeout', at: AT },
    { t: 'entry_cancelled', remaining: 100, at: AT },
  ]);
  assert.equal(s.position, 0);
  assert.equal(s.phase, 'aborted');
  assert.equal(isDone(s), true);
});

test('cancelling the rest of a partly filled entry keeps the part that filled', () => {
  const s = replay(start(), [
    { t: 'entry_submitted', clientOrderId: 'c', size: 100, at: AT },
    fill(40, 100.5),
    { t: 'entry_cancelled', remaining: 60, at: AT },
  ]);
  assert.equal(s.position, -40);
  assert.equal(s.phase, 'position_open');
  assert.match(s.note ?? '', /filled 40 of 100/);
});

test('[critical] booked profit is in dollars, through the contract size', () => {
  // "booked today +$3.00" on a trade that made a third of a cent: the machine
  // multiplied the price difference by the contracts and stopped there
  const s = replay(start(), [fill(1, 19), fill(1, 16, 'take_profit')]);
  assert.ok(Math.abs(s.realisedPnl - 0.003) < 1e-9, `got ${s.realisedPnl}`);
  assert.ok(s.realisedPnl < 0.01, 'a one-lot scalp cannot make three dollars');
});

test('a contract size other than the default is honoured', () => {
  const whole = initialTrade({
    tradeId: 't2', symbol: 'X', productId: 1, optionSide: 'CE',
    requestedSize: 1, at: AT, contractValue: 1,
  });
  const s = replay(whole, [fill(1, 19), fill(1, 16, 'take_profit')]);
  assert.equal(s.realisedPnl, 3, 'one whole BTC a contract really would be three dollars');
});

test('replaying the journal rebuilds the same trade, which is what a restart does', () => {
  const events: TradeEvent[] = [
    { t: 'entry_submitted', clientOrderId: 'c', size: 100, at: AT },
    fill(60, 100.5), fill(40, 99.5),
    { t: 'protection_placed', takeProfit: 'tp', stopLoss: 'sl', at: AT },
    fill(100, 92, 'take_profit'),
  ];
  const a = replay(start(), events);
  const b = replay(start(), events);
  assert.deepEqual(a, b);
  assert.equal(a.phase, 'flat');
  assert.equal(a.entryAvgPrice, (60 * 100.5 + 40 * 99.5) / 100);
});

  test('recompute rebuilds the derived figures from the fills', () => {
    const s = replay(start(), [fill(2, 19), fill(2, 16, 'take_profit')]);
    // a row written by the old code, with the thousand-fold P&L still in it
    const stale = { ...s, realisedPnl: 6, entryAvgPrice: null, exitSize: 0 };
    const fixed = recompute(stale);
    assert.ok(Math.abs(fixed.realisedPnl - 0.006) < 1e-9, `got ${fixed.realisedPnl}`);
    assert.equal(fixed.entryAvgPrice, 19, 'the averages come back too');
    assert.equal(fixed.exitSize, 2);
  });

  test('recompute is idempotent, so reading twice does not drift', () => {
    const s = replay(start(), [fill(2, 19), fill(2, 16, 'take_profit')]);
    assert.deepEqual(recompute(recompute(s)), recompute(s));
  });

  test('a trade with no fills recomputes to nothing rather than to NaN', () => {
    const fixed = recompute(start());
    assert.equal(fixed.realisedPnl, 0);
    assert.equal(fixed.entryAvgPrice, null);
  });

  test('an older row with no contract size falls back to Delta’s 0.001', () => {
    const s = replay(start(), [fill(1, 19), fill(1, 16, 'take_profit')]);
    const legacy = { ...s, contractValue: undefined as unknown as number };
    assert.ok(Math.abs(recompute(legacy).realisedPnl - 0.003) < 1e-9);
  });
