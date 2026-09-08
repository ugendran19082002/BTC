import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteTradeStore } from '../../src/trading/store.js';
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

const fresh = () => new SqliteTradeStore(join(mkdtempSync(join(tmpdir(), 'trades-')), 'trades.db'));

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

test('[critical] a changed plan survives being written again', () => {
  const store = fresh();
  const rec = record();
  store.save(rec);

  rec.plan = { ...rec.plan, takeProfitPrice: 25.1 };
  store.save(rec);

  assert.equal(store.get('t1')!.plan.takeProfitPrice, 25.1, 'the move was lost on the next read');
});

test('every part of the plan is kept, not only the price', () => {
  const store = fresh();
  const rec = record();
  store.save(rec);

  rec.plan = { ...rec.plan, stopPrice: 80, lots: 4, leverage: 50 };
  store.save(rec);

  const back = store.get('t1')!.plan;
  assert.equal(back.stopPrice, 80);
  assert.equal(back.lots, 4);
  assert.equal(back.leverage, 50);
});

test('turning an exit off is stored as off, not as its old price', () => {
  const store = fresh();
  const rec = record({ takeProfitPrice: 25.1 });
  store.save(rec);

  rec.plan = { ...rec.plan, takeProfitPrice: null };
  store.save(rec);

  assert.equal(store.get('t1')!.plan.takeProfitPrice, null);
});

test('the state is kept too, and the events are appended rather than rewritten', () => {
  const store = fresh();
  const rec = record();
  store.save(rec);

  rec.state = { ...rec.state, position: -1, entrySize: 1, entryAvgPrice: 31 };
  rec.events.push({ t: 'entry_submitted', clientOrderId: 'c', size: 1, at: 2_000 });
  store.save(rec);
  rec.events.push({ t: 'fill', role: 'entry', side: 'sell', size: 1, price: 31, orderId: 'o', at: 3_000 });
  store.save(rec);

  const back = store.get('t1')!;
  assert.equal(back.state.position, -1);
  assert.equal(back.events.length, 2, 'appended once each, not duplicated');
  assert.equal(back.events[0]?.t, 'entry_submitted');
});
