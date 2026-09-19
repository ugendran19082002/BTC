import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { PgTradeStore } from '../../src/trading/store.js';
import { SettingsCache } from '../../src/db/settings.js';
import { closePool, query } from '../../src/db/pool.js';
import { initialTrade } from '../../src/trading/machine.js';
import type { TradeRecord } from '../../src/trading/engine.js';

/**
 * The journal.
 *
 * The bug these exist for: the upsert listed phase, position, state and
 * updated_at, and left `plan` out. So a plan was written once on insert and
 * never again -- every later change was lost on the next read. The exits moved
 * on the exchange and reverted on the screen, which read like the update
 * silently failing when in fact only the record of it did.
 */

// One database for the file; each case starts the journal empty. The settings
// module owns the schema the journal lives in, so it is loaded first, as at boot.
const fresh = async () => {
  await new SettingsCache().load();
  const store = await PgTradeStore.open();
  await query('TRUNCATE trades CASCADE');
  return store;
};
after(() => closePool());

const record = (over: Partial<TradeRecord['plan']> = {}): TradeRecord => ({
  state: initialTrade({
    tradeId: 't1', symbol: 'P-BTC-76800-090926', productId: 1,
    optionSide: 'PE', requestedSize: 1, at: 1_000,
  }),
  plan: {
    tradeId: 't1', symbol: 'P-BTC-76800-090926', optionSide: 'PE', lots: 1, leverage: 200,
    entry: { type: 'limit', limitPrice: 31, timeoutMs: 0, marketFallback: false, chase: null },
    takeProfitPrice: 1.9, stopPrice: null,
    expect: { underlying: 'BTC', optionSide: 'PE', strike: 76_800, expiryTs: 1 },
    ...over,
  },
  events: [],
});

test('[critical] a changed plan survives being written again', async () => {
  const store = await fresh();
  const rec = record();
  await store.save(rec);

  rec.plan = { ...rec.plan, takeProfitPrice: 25.1 };
  await store.save(rec);

  assert.equal((await store.get('t1'))!.plan.takeProfitPrice, 25.1, 'the move was lost on the next read');
});

test('every part of the plan is kept, not only the price', async () => {
  const store = await fresh();
  const rec = record();
  await store.save(rec);

  rec.plan = { ...rec.plan, stopPrice: 80, lots: 4, leverage: 50 };
  await store.save(rec);

  const back = (await store.get('t1'))!.plan;
  assert.equal(back.stopPrice, 80);
  assert.equal(back.lots, 4);
  assert.equal(back.leverage, 50);
});

test('turning an exit off is stored as off, not as its old price', async () => {
  const store = await fresh();
  const rec = record({ takeProfitPrice: 25.1 });
  await store.save(rec);

  rec.plan = { ...rec.plan, takeProfitPrice: null };
  await store.save(rec);

  assert.equal((await store.get('t1'))!.plan.takeProfitPrice, null);
});

test('the state is kept too, and the events are appended rather than rewritten', async () => {
  const store = await fresh();
  const rec = record();
  await store.save(rec);

  rec.state = { ...rec.state, position: -1, entrySize: 1, entryAvgPrice: 31 };
  rec.events.push({ t: 'entry_submitted', clientOrderId: 'c', size: 1, at: 2_000 });
  await store.save(rec);
  rec.events.push({ t: 'fill', role: 'entry', side: 'sell', size: 1, price: 31, orderId: 'o', at: 3_000 });
  await store.save(rec);

  const back = (await store.get('t1'))!;
  assert.equal(back.state.position, -1);
  assert.equal(back.events.length, 2, 'appended once each, not duplicated');
  assert.equal(back.events[0]?.t, 'entry_submitted');
});

test('[critical] the journal survives a reopen: what one process wrote, the next reads back', async () => {
  const a = await fresh();
  const rec = record();
  rec.events.push({ t: 'entry_submitted', clientOrderId: 'c', size: 1, at: 2_000 });
  await a.save(rec);
  const b = await PgTradeStore.open();
  const back = (await b.get('t1'))!;
  assert.equal(back.plan.symbol, 'P-BTC-76800-090926');
  assert.equal(back.events.length, 1);
  assert.deepEqual(await b.all().then((r) => r.map((x) => x.state.tradeId)), ['t1']);
});

test('a second writer cannot duplicate an event: (trade_id, seq) is unique', async () => {
  const store = await fresh();
  const rec = record();
  rec.events.push({ t: 'entry_submitted', clientOrderId: 'c', size: 1, at: 2_000 });
  await store.save(rec);
  // the same record saved from a stale copy that believes nothing was written
  const stale = { ...rec, events: [...rec.events] };
  await store.save(stale);
  assert.equal((await store.events('t1')).length, 1);
});
