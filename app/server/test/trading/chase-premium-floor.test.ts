import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TradePlan } from '../../src/trading/engine.js';
import { ceProduct, planFor, quote, rig } from './harness.js';

/*
 * The walk toward the bid never sells under the premium floor (12 Nov 2026 audit). The gate checked the first price
 * only: an entry sent at 11 on an 8 / 10 book passed a $10 floor, and the walk then sold it at 9 -- 54 entries that
 * day at 6.90-9.00, every strategy's floor $10. The floor is the one the gate holds the entry to: the strategy's own,
 * else the desk's.
 */

const CE = ceProduct().symbol;

/** The live strategies' entry on 12 Nov: sent at 11, four steps of 1.25 s, held at the mid only past a 30% spread. */
const entryAt = (over: { limitPrice?: number; minPremiumUsd?: number; timeoutMs?: number } = {}): TradePlan =>
  planFor(ceProduct(), {
    lots: 1, stopPrice: null, takeProfitPrice: null,
    ...(over.minPremiumUsd === undefined ? {} : { minPremiumUsd: over.minPremiumUsd }),
    entry: {
      type: 'limit', limitPrice: over.limitPrice ?? 11, timeoutMs: over.timeoutMs ?? 0, marketFallback: false,
      chase: { steps: 4, everyMs: 1_250, maxCrossSpreadPct: 0.3 },
    },
  });

/** Move the clock half a second at a time on an unchanged book, polling each time. */
async function hold(r: ReturnType<typeof rig>, plan: TradePlan, seconds: number, bid: number, ask: number) {
  for (let i = 0; i < seconds * 2; i += 1) {
    r.advance(500);
    r.ex.tick(quote(CE, bid, ask, { mark: (bid + ask) / 2, ts: r.now() }));
    await r.engine.poll(plan.tradeId);
  }
}

const restingEntry = async (r: ReturnType<typeof rig>) =>
  (await r.ex.getOpenOrders(CE)).find((o) => !o.reduceOnly) ?? null;

test('[critical] the 12 Nov entry: sent at 11 on an 8 / 10 book with a $10 floor, it rests at 10 -- never sold at 9 or 8', async () => {
  const r = rig({ quotes: [quote(CE, 8, 10, { mark: 9 })] });
  const plan = entryAt({ minPremiumUsd: 10 });
  const opened = await r.engine.open(plan);
  assert.equal(opened.ok, true, JSON.stringify(opened));

  // Well past the four steps, which on their own would walk 11 -> 8 (a 22% spread: the mid does not hold it).
  await hold(r, plan, 8, 8, 10);

  assert.equal((await restingEntry(r))?.limitPrice, 10, 'resting at the floor');
  assert.equal(r.store.peek(plan.tradeId)!.state.position, 0, 'nothing sold under $10');
  assert.deepEqual(r.swallowed, []);
});

test('[critical] at the floor it fills once a buyer pays the floor, and at no less', async () => {
  const r = rig({ quotes: [quote(CE, 8, 10, { mark: 9 })] });
  const plan = entryAt({ minPremiumUsd: 10 });
  await r.engine.open(plan);
  await hold(r, plan, 8, 8, 10);

  await hold(r, plan, 1, 10, 10.5);   // the bid comes up to the floor

  const st = r.store.peek(plan.tradeId)!.state;
  assert.equal(st.position, -1, 'sold');
  assert.ok(st.fills[0]!.price >= 10, `filled at ${st.fills[0]!.price}, not under the floor`);
});

test('[critical] a bid over the floor is walked to as before: the floor changes nothing above it', async () => {
  const r = rig({ quotes: [quote(CE, 12, 13, { mark: 12.5 })] });
  const plan = entryAt({ limitPrice: 13, minPremiumUsd: 10 });
  await r.engine.open(plan);
  await hold(r, plan, 8, 12, 13);

  const st = r.store.peek(plan.tradeId)!.state;
  assert.equal(st.position, -1);
  assert.equal(st.fills[0]!.price, 12, 'at the bid, as the walk always did');
});

test('[critical] a book that never comes up to the floor: cancelled when the window closes, nothing sold, nothing left resting', async () => {
  const r = rig({ quotes: [quote(CE, 8, 10, { mark: 9 })] });
  const plan = entryAt({ minPremiumUsd: 10, timeoutMs: 10_000 });
  await r.engine.open(plan);
  await hold(r, plan, 12, 8, 10);

  const st = r.store.peek(plan.tradeId)!.state;
  assert.equal(st.position, 0, 'nothing sold');
  assert.equal(st.phase, 'aborted', 'the entry ended');
  assert.equal(await restingEntry(r), null);
});

test('[critical] no floor of its own: the desk\'s floor holds the walk, as it holds the gate', async () => {
  const r = rig({ quotes: [quote(CE, 6, 8, { mark: 7 })], limits: { minPremiumUsd: 7.5 } });
  const plan = entryAt({ limitPrice: 9 });
  assert.equal(plan.minPremiumUsd, undefined);
  await r.engine.open(plan);
  await hold(r, plan, 8, 6, 8);

  assert.equal((await restingEntry(r))?.limitPrice, 7.5, 'resting at the desk floor');
  assert.equal(r.store.peek(plan.tradeId)!.state.position, 0);
});

test('a strategy floor under the desk\'s is its own: the walk goes down to it, as the gate lets it', async () => {
  const r = rig({ quotes: [quote(CE, 6, 8, { mark: 7 })], limits: { minPremiumUsd: 10 } });
  const plan = entryAt({ limitPrice: 9, minPremiumUsd: 6.5 });
  await r.engine.open(plan);
  await hold(r, plan, 8, 6, 8);

  assert.equal((await restingEntry(r))?.limitPrice, 6.5, 'the strategy\'s 6.50, not the desk\'s 10 nor the 6 bid');
});

test('a floor on the tick stays on it: $10 is 10.0, not one tick over', async () => {
  const r = rig({ quotes: [quote(CE, 9.95, 10.4, { mark: 10.2 })] });
  const plan = entryAt({ limitPrice: 10.5, minPremiumUsd: 10 });
  await r.engine.open(plan);
  await hold(r, plan, 8, 9.9, 10.4);
  assert.equal((await restingEntry(r))?.limitPrice, 10);
});
