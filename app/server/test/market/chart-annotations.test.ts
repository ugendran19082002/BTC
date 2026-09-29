import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { annotationsSchema, clearAnnotations, createAnnotation, listAnnotations } from '../../src/market/chart-annotations.js';
import { appliedMigrations } from '../../src/db/migrate.js';
import { closePool, query } from '../../src/db/pool.js';

after(() => closePool());

test('[critical] the annotations table is a ledger migration, applied once, and a table that already exists is left as it is', async () => {
  // A database from before the ledger: the table is already there, with a row in it.
  await query(`CREATE TABLE IF NOT EXISTS public.chart_annotations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, symbol TEXT NOT NULL DEFAULT 'BTCUSD', tf TEXT NOT NULL DEFAULT '5m',
    kind TEXT NOT NULL, from_time BIGINT NOT NULL, to_time BIGINT NOT NULL, price_low DOUBLE PRECISION NOT NULL,
    price_high DOUBLE PRECISION NOT NULL, label TEXT, meta JSONB, created_at BIGINT NOT NULL)`);
  await query(`INSERT INTO public.chart_annotations (kind, from_time, to_time, price_low, price_high, created_at) VALUES ('sl', 1, 2, 80000, 80000, 3)`);

  await annotationsSchema();
  await annotationsSchema();
  const ids = (await appliedMigrations()).map((m) => m.id).filter((id) => id === 'chart-001-annotations');
  assert.deepEqual(ids, ['chart-001-annotations']);
  assert.equal((await listAnnotations('BTCUSD', '5m')).length, 1, 'the existing row survives');

  const made = await createAnnotation({ symbol: 'BTCUSD', tf: '5m', kind: 'tp', fromTime: 10, toTime: 20, priceLow: 81_000, priceHigh: 81_000, label: 'TP1', meta: null });
  assert.equal(made.label, 'TP1');
  assert.equal((await listAnnotations('BTCUSD', '5m')).length, 2);
  await clearAnnotations('BTCUSD', '5m');
  assert.equal((await listAnnotations('BTCUSD', '5m')).length, 0);
});
