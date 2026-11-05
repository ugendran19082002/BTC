import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netIfClosedAt } from '../../src/trading/close-preview.js';
import { fillChargesUsd, tradeCharges } from '../../src/trading/charges.js';
import { closePriceOf, unrealisedPnlUsd } from '../../src/trading/margin.js';
import { realisedBreakdownSinceOf } from '../../src/trading/machine.js';
import { startOfDayIst } from '../../src/strategy/schedule.js';
import type { TradeState } from '../../src/trading/types.js';

/**
 * The phone's Home "Today's P&L" (`todayFigures`) against Positions' "Total P&L" (`netIfClosedAt`: booked + open at the
 * ask − every charge paid − the charges to close), at the morning's start (owner, 4 Nov 2026: "morning start aakum pothu
 * home pnl amount and position pnl match aakutha ilaya"). On 4 Nov at 07:10 IST the gaps were the spread from the mark to
 * the ask and the charges to close: Home priced open trades at the mark. From 5 Nov ("market price enkayum use pana
 * kudathu ... ask and bid") Home prices them at the ask and counts the charges to close, so the two agree -- but for the
 * case that morning did not have: a trade sold the evening before and still open after midnight, whose entry charge is
 * the day before's, in Positions and not in the day.
 */
const NOW = Date.parse('2026-11-04T07:10:00+05:30');
const DAY = startOfDayIst(NOW);
const SPOT = 76_000;
const BOOK = { bid: 44, ask: 47, mark: 45.5 };

const short = (enteredAt: number, price: number, contracts: number): TradeState => ({
  position: -contracts, entryAvgPrice: price, realisedPnl: 0, contractValue: 0.001,
  fills: [{ ts: enteredAt, role: 'entry', side: 'sell', size: contracts, price }],
} as unknown as TradeState);

/** Home's day, made as `todayFigures` makes it, over these trades: open at the price a close trades at, charges to close in. */
function homeDay(trades: readonly TradeState[]): number {
  let booked = 0, open = 0, charges = 0;
  for (const s of trades) {
    const px = closePriceOf(s.position, BOOK, BOOK.mark)!;
    booked += realisedBreakdownSinceOf(s, DAY).realisedUsd;
    charges += tradeCharges(s, { spot: SPOT, since: DAY }).totalUsd
      + fillChargesUsd({ price: px, contracts: s.position, contractValue: s.contractValue, spot: SPOT }).totalUsd;
    open += unrealisedPnlUsd({ entryPrice: s.entryAvgPrice, markPrice: px, size: s.position, contractValue: s.contractValue, long: s.position > 0 }) ?? 0;
  }
  return booked + open - charges;
}
/** Positions' total, made as the trade route makes each `netIfClosedUsd`. */
const positionsTotal = (trades: readonly TradeState[]) =>
  trades.reduce((n, s) => n + (netIfClosedAt({ state: s, price: BOOK.ask, spot: SPOT, paidUsd: tradeCharges(s, { spot: SPOT }).totalUsd }) ?? 0), 0);

test('[critical] a short closes at the ask, a long at the bid; the mark only with that side unquoted', () => {
  assert.equal(closePriceOf(-1, BOOK, BOOK.mark), BOOK.ask);
  assert.equal(closePriceOf(1, BOOK, BOOK.mark), BOOK.bid);
  assert.equal(closePriceOf(-1, { bid: 44, ask: null }, BOOK.mark), BOOK.mark);
  assert.equal(closePriceOf(-1, { bid: 44, ask: 0 }, BOOK.mark), BOOK.mark);
  assert.equal(closePriceOf(-1, null, null), null);
});

test('[critical] sold this morning: Home\'s day is Positions\' total -- both what closing everything now would leave', () => {
  const today = [short(DAY + 7 * 3_600_000 + 60_000, 45, 1), short(DAY + 7 * 3_600_000 + 120_000, 44, 2)];
  const gap = homeDay(today) - positionsTotal(today);
  assert.ok(Math.abs(gap) < 1e-12, `gap ${gap}`);
});

test('[critical] sold before midnight and open in the morning: its entry charge is the day before\'s -- in Positions, not in Home\'s day', () => {
  const overnight = short(DAY - 2 * 3_600_000, 45, 1);
  const before = tradeCharges(overnight, { spot: SPOT }).totalUsd;
  assert.ok(before > 0);
  assert.equal(tradeCharges(overnight, { spot: SPOT, since: DAY }).totalUsd, 0, 'not a charge of today');
  const gap = homeDay([overnight]) - positionsTotal([overnight]);
  assert.ok(Math.abs(gap - before) < 1e-12, `gap ${gap}`);
});

test('the day\'s line starts at 00:00 IST, not at 05:30', () => {
  assert.equal(new Date(DAY).toISOString(), '2026-11-03T18:30:00.000Z');
});
