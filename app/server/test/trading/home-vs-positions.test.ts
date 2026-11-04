import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netIfClosedAt } from '../../src/trading/close-preview.js';
import { fillChargesUsd, tradeCharges } from '../../src/trading/charges.js';
import { unrealisedPnlUsd } from '../../src/trading/margin.js';
import { realisedBreakdownSinceOf } from '../../src/trading/machine.js';
import { startOfDayIst } from '../../src/strategy/schedule.js';
import type { TradeState } from '../../src/trading/types.js';

/**
 * The phone's Home "Today's P&L" (`todayFigures`: booked since 00:00 IST + open at the mark − charges since 00:00) against
 * Positions' "Total P&L" (`netIfClosedAt`: booked + open at the ask − every charge paid − the charges to close), at the
 * morning's start (owner, 4 Nov 2026: "morning start aakum pothu home pnl amount and position pnl match aakutha ilaya").
 * On 4 Nov at 07:10 IST the four accounts' gaps were the spread to the ask and the charges to close, nothing else. Pinned
 * here, with the same functions the two figures are made by -- and the case that morning did not have: a trade sold the
 * evening before and still open after midnight, whose entry charge is the day before's.
 */
const NOW = Date.parse('2026-11-04T07:10:00+05:30');
const DAY = startOfDayIst(NOW);
const SPOT = 76_000;
const BOOK = { bid: 44, ask: 47, mark: 45.5 };

const short = (enteredAt: number, price: number, contracts: number): TradeState => ({
  position: -contracts, entryAvgPrice: price, realisedPnl: 0, contractValue: 0.001,
  fills: [{ ts: enteredAt, role: 'entry', side: 'sell', size: contracts, price }],
} as unknown as TradeState);

/** Home's day, made as `todayFigures` makes it, over these trades. */
function homeDay(trades: readonly TradeState[]): number {
  let booked = 0, open = 0, charges = 0;
  for (const s of trades) {
    booked += realisedBreakdownSinceOf(s, DAY).realisedUsd;
    charges += tradeCharges(s, { spot: SPOT, since: DAY }).totalUsd;
    open += unrealisedPnlUsd({ entryPrice: s.entryAvgPrice, markPrice: BOOK.mark, size: s.position, contractValue: s.contractValue, long: s.position > 0 }) ?? 0;
  }
  return booked + open - charges;
}
/** Positions' total, made as the trade route makes each `netIfClosedUsd`. */
const positionsTotal = (trades: readonly TradeState[]) =>
  trades.reduce((n, s) => n + (netIfClosedAt({ state: s, price: BOOK.ask, spot: SPOT, paidUsd: tradeCharges(s, { spot: SPOT }).totalUsd }) ?? 0), 0);
const leaving = (s: TradeState) => (BOOK.ask - BOOK.mark) * Math.abs(s.position) * s.contractValue
  + fillChargesUsd({ price: BOOK.ask, contracts: s.position, contractValue: s.contractValue, spot: SPOT }).totalUsd;

test('[critical] sold this morning: the two differ by the cost of leaving alone -- the spread to the ask and the charges to close', () => {
  const today = [short(DAY + 7 * 3_600_000 + 60_000, 45, 1), short(DAY + 7 * 3_600_000 + 120_000, 44, 2)];
  const gap = homeDay(today) - positionsTotal(today);
  assert.ok(Math.abs(gap - today.reduce((n, s) => n + leaving(s), 0)) < 1e-12, `gap ${gap}`);
  assert.ok(gap > 0, 'Home at the mark reads better than closing now');
});

test('[critical] sold before midnight and open in the morning: its entry charge is the day before\'s -- in Positions, not in Home\'s day', () => {
  const overnight = short(DAY - 2 * 3_600_000, 45, 1);
  const before = tradeCharges(overnight, { spot: SPOT }).totalUsd;
  assert.ok(before > 0);
  assert.equal(tradeCharges(overnight, { spot: SPOT, since: DAY }).totalUsd, 0, 'not a charge of today');
  const gap = homeDay([overnight]) - positionsTotal([overnight]);
  assert.ok(Math.abs(gap - (leaving(overnight) + before)) < 1e-12, `gap ${gap}`);
});

test('the day\'s line starts at 00:00 IST, not at 05:30', () => {
  assert.equal(new Date(DAY).toISOString(), '2026-11-03T18:30:00.000Z');
});
