import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, query } from '../../src/db/pool.js';
import { PgTradeStore } from '../../src/trading/store.js';
import { SettingsCache } from '../../src/db/settings.js';
import { rig, peProduct, planFor, quote } from './harness.js';

/**
 * The day's booked P&L is held until the journal is next written (4 Oct 2026):
 * the status asked for it every second and every trade of the day was read
 * again each time. The answer must be the one a fresh read would give, always.
 */
after(() => closePool());
beforeEach(async () => { await new SettingsCache().load(); await PgTradeStore.open(); await query('TRUNCATE trades CASCADE'); await query('TRUNCATE trade_events'); });

const PE = peProduct().symbol;

test('[critical] the held figure is the fresh one: unchanged between writes, and moved by the very next save', async () => {
  const store = await PgTradeStore.open();
  // The engine on its memory journal makes the records; each stage is saved to the real one, as the service does.
  const r = rig({ products: [peProduct()], quotes: [quote(PE, 100.5, 101)] });
  const from = r.now() - 1;
  const fresh = (store as unknown as { realisedRead: (f: number) => Promise<{ realisedUsd: number; profitUsd: number; lossUsd: number }> }).realisedRead.bind(store);
  let reads = 0;
  (store as unknown as { realisedRead: (f: number) => Promise<unknown> }).realisedRead = (f) => { reads++; return fresh(f); };

  assert.deepEqual(await store.realisedBreakdownSince(from), { realisedUsd: 0, profitUsd: 0, lossUsd: 0 });

  const plan = planFor(peProduct(), { lots: 10, stopPrice: 300, takeProfitPrice: 1 });
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  await store.save(r.store.peek(plan.tradeId)!);
  const open = await store.realisedBreakdownSince(from);
  assert.equal(open.realisedUsd, 0, 'in the trade, nothing booked');

  // Asked many times with nothing written: the same answer, and the database is not asked.
  const before = reads;
  for (let i = 0; i < 20; i++) assert.deepEqual(await store.realisedBreakdownSince(from), open);
  assert.equal(reads, before, 'twenty asks between writes, no read');

  // The option is bought back dearer: a loss is booked by a save, and the next ask has it.
  r.ex.tick(quote(PE, 120, 120.5, { ts: r.now() }));
  await r.engine.closeNow(plan.tradeId, 'test close');
  await r.engine.poll(plan.tradeId);
  await store.save(r.store.peek(plan.tradeId)!);
  const closed = await store.realisedBreakdownSince(from);
  assert.ok(closed.realisedUsd < 0, 'the loss shows on the first ask after the save');
  assert.ok(closed.lossUsd > 0);
  assert.equal(reads, before + 1, 'read again, once, because the journal was written');
  assert.deepEqual(closed, await fresh(from), 'and it is exactly what a fresh read gives');

  // A different day's start is a different question: not answered from the held one.
  await store.realisedBreakdownSince(from + 86_400_000);
  assert.equal(reads, before + 2);
});

test('the caller cannot change the held figure by changing what it was given', async () => {
  const store = await PgTradeStore.open();
  const a = await store.realisedBreakdownSince(1);
  a.realisedUsd = 999;
  assert.equal((await store.realisedBreakdownSince(1)).realisedUsd, 0);
});
