import { after, test } from 'node:test';
import { closePool } from '../../src/db/pool.js';
import assert from 'node:assert/strict';
import { initialTrade, replay } from '../../src/trading/machine.js';
import { istDayEnd, istDayStart, istToday, orderOutcomeOf, orderStatusOf } from '../../src/trading/status.js';
import type { TradeEvent, TradeState } from '../../src/trading/types.js';

/** A desk on this process's database, the way index.ts builds one. */
async function freshService() {
  const { TradingService } = await import('../../src/trading/service.js');
  const { PgTradeStore } = await import('../../src/trading/store.js');
  const { SettingsCache } = await import('../../src/db/settings.js');
  return new TradingService({ settings: await new SettingsCache().load(), store: await PgTradeStore.open() });
}
after(() => closePool());

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
  // one trade is one row: the piece already bought back is on it, not missing from it
  assert.equal(orderOutcomeOf(s, events), 'sold 10, bought back 4 at 16.00, short 6');
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

/**
 * One fan-out per second, however many tabs are watching.
 *
 * Measured on 16 September before this existed: 355 status calls in fifteen
 * minutes averaging 994ms — a one-second poll saturating its own server,
 * because the reads under it were cached for 800ms and a request that took a
 * second missed every cache. The fix is not a longer cache; it is that callers
 * inside the window share one computation.
 */
test('[critical] callers inside the window share one computation, and one answer', async () => {
  const svc = await freshService();
  let runs = 0;
  const slow = () => new Promise<number>((r) => setTimeout(() => r(++runs), 30));
  const [a, b, c] = await Promise.all([
    svc.coalesce('k', 1_000, slow),
    svc.coalesce('k', 1_000, slow),
    svc.coalesce('k', 1_000, slow),
  ]);
  assert.equal(runs, 1, 'three callers, one fan-out');
  assert.deepEqual([a, b, c], [1, 1, 1]);
  // inside the window: still the same answer, no new work
  assert.equal(await svc.coalesce('k', 1_000, slow), 1);
  assert.equal(runs, 1);
});

test('after the window a fresh computation runs, and a failure does not poison the cache', async () => {
  const svc = await freshService();
  let runs = 0;
  const t0 = 1_000_000;
  assert.equal(await svc.coalesce('k', 500, async () => ++runs, t0), 1);
  assert.equal(await svc.coalesce('k', 500, async () => ++runs, t0 + 600), 2, 'past the window');
  await assert.rejects(svc.coalesce('k', 500, async () => { throw new Error('delta down'); }, t0 + 1_300));
  // the last good answer is still served inside its own window, and a retry works
  assert.equal(await svc.coalesce('k', 500, async () => ++runs, t0 + 1_400), 3);
});

test('different keys do not share', async () => {
  const svc = await freshService();
  assert.equal(await svc.coalesce('a', 1_000, async () => 'A'), 'A');
  assert.equal(await svc.coalesce('b', 1_000, async () => 'B'), 'B');
});

/**
 * Delta off the request path.
 *
 * Coalescing stopped two tabs doing two fan-outs; it did not stop the fan-out
 * being on the request path, and every poll still waited ~850ms for Delta. The
 * server now refreshes the status on its own clock and a request reads the
 * last answer at once.
 */
test('[critical] a request reads the last background answer without waiting', async () => {
  const svc = await freshService();
  let runs = 0;
  svc.provideStatus(async () => { await new Promise((r) => setTimeout(r, 40)); return { n: ++runs }; });
  await new Promise((r) => setTimeout(r, 60));          // the first background refresh lands
  const t0 = Date.now();
  const got = await svc.status<{ n: number }>();
  assert.ok(Date.now() - t0 < 15, 'served from memory, not from a fan-out');
  assert.equal(got.n, 1);
  svc.stop();
});

test('a stale answer is not served: the request waits for a fresh one', async () => {
  const svc = await freshService();
  let runs = 0;
  svc.provideStatus(async () => ({ n: ++runs }));
  await new Promise((r) => setTimeout(r, 20));
  const late = Date.now() + 10_000;                      // pretend ten seconds have passed
  const got = await svc.status<{ n: number }>(late);
  assert.equal(got.n, 2, 'recomputed, because the last one was too old');
  svc.stop();
});

test('with nothing computed yet the first request computes, and says so if it cannot', async () => {
  const svc = await freshService();
  await assert.rejects(svc.status(), /status not provided/);
  svc.stop();
});
