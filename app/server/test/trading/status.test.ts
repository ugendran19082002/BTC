import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialTrade, replay } from '../../src/trading/machine.js';
import { istDayEnd, istDayStart, istToday, orderOutcomeOf, orderStatusOf } from '../../src/trading/status.js';
import type { TradeEvent, TradeState } from '../../src/trading/types.js';

const AT = Date.UTC(2026, 8, 8, 12, 0, 0);

const start = (): TradeState => initialTrade({
  tradeId: 't1', symbol: 'C-BTC-81000-090926', productId: 1,
  optionSide: 'CE', requestedSize: 1, at: AT,
});

const fill = (size: number, price: number, role: 'entry' | 'take_profit' = 'entry'): TradeEvent => ({
  t: 'fill', role, side: role === 'entry' ? 'sell' : 'buy', size, price, orderId: 'o1', at: AT,
});

const statusOf = (events: TradeEvent[]) => orderStatusOf(replay(start(), events), events);

test('a trade that filled and closed is completed', () => {
  assert.equal(statusOf([fill(1, 19), fill(1, 16, 'take_profit')]), 'completed');
});

test('a trade that filled and is still on is pending, not completed', () => {
  // it happened, but a list of finished orders is not where it belongs yet
  assert.equal(statusOf([fill(1, 19)]), 'pending');
});

test('an order resting on the book is pending', () => {
  assert.equal(statusOf([{ t: 'entry_submitted', clientOrderId: 'c', size: 1, at: AT }]), 'pending');
});

test('a trade the gates refused is rejected', () => {
  assert.equal(statusOf([{ t: 'precheck_failed', reason: 'Spread is 18%', at: AT }]), 'rejected');
});

test('a trade the exchange refused is rejected too', () => {
  assert.equal(statusOf([{ t: 'entry_rejected', reason: 'bad_schema', at: AT }]), 'rejected');
});

test('an order taken back off the book is cancelled, not rejected', () => {
  // the distinction is the whole point: rejected is worth investigating,
  // cancelled is somebody changing their mind
  assert.equal(statusOf([
    { t: 'entry_submitted', clientOrderId: 'c', size: 1, at: AT },
    { t: 'entry_cancelled', remaining: 1, at: AT },
  ]), 'cancelled');
});

test('a partly filled order that was then cancelled still counts as completed', () => {
  // contracts changed hands; what happened to the remainder does not undo that
  assert.equal(statusOf([
    { t: 'entry_submitted', clientOrderId: 'c', size: 10, at: AT },
    fill(4, 19),
    { t: 'entry_cancelled', remaining: 6, at: AT },
    fill(4, 16, 'take_profit'),
  ]), 'completed');
});

test('an abort with no reason recorded reads as rejected rather than as nothing', () => {
  const s = { ...start(), phase: 'aborted' as const };
  assert.equal(orderStatusOf(s, []), 'rejected');
});

test('the outcome line says what actually happened', () => {
  const events = [fill(1, 19), fill(1, 16, 'take_profit')];
  const s = replay(start(), events);
  assert.match(orderOutcomeOf(s, events), /sold 1, bought back at 16\.00/);

  const open = replay(start(), [fill(3, 19)]);
  assert.match(orderOutcomeOf(open, [fill(3, 19)]), /short 3/);

  const refused: TradeEvent[] = [{ t: 'precheck_failed', reason: 'Spread is 18%', at: AT }];
  assert.match(orderOutcomeOf(replay(start(), refused), refused), /Spread is 18%/);
});

test('a half-exited trade is still pending, and says what is left', () => {
  const events = [fill(10, 19), fill(4, 16, 'take_profit')];
  const s = replay(start(), events);
  assert.equal(orderStatusOf(s, events), 'pending', 'four bought back, six still short');
  assert.match(orderOutcomeOf(s, events), /short 6/);
});

// ------------------------------------------------------------- date windows

test('an IST day starts at 18:30 the previous evening in UTC', () => {
  assert.equal(istDayStart('2026-09-08'), Date.UTC(2026, 8, 7, 18, 30, 0));
});

test('a day is exactly twenty-four hours long', () => {
  assert.equal(istDayEnd('2026-09-08')! - istDayStart('2026-09-08')!, 86_400_000);
});

test('the end is exclusive, so two consecutive days do not overlap', () => {
  assert.equal(istDayEnd('2026-09-08'), istDayStart('2026-09-09'));
});

test('a malformed date is refused rather than guessed at', () => {
  for (const bad of ['', '8 Sept', '2026-9-8', '2026-13-01x', 'today']) {
    assert.equal(istDayStart(bad), null, `"${bad}" should not parse`);
  }
});

test("today in IST is the evening's date, not yesterday's", () => {
  // 21:00 IST on the 8th is 15:30 UTC on the 8th
  assert.equal(istToday(Date.UTC(2026, 8, 8, 15, 30)), '2026-09-08');
  // 01:00 IST on the 9th is 19:30 UTC on the 8th -- still the 9th in Chennai
  assert.equal(istToday(Date.UTC(2026, 8, 8, 19, 30)), '2026-09-09');
});
