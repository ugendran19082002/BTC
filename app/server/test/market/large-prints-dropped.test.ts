import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, one, query, rows } from '../../src/db/pool.js';
import { flowSchema } from '../../src/market/flow.js';

/**
 * The large orders' own table went on 4 Oct 2026: written every minute, read
 * by nothing since the chart's bubbles were removed. On the desk the table is
 * there with a year's rows -- the retired `market-015` made it -- so the
 * migration has to drop a table that exists, once, and leave the minute rows
 * the entry methods read alone.
 */
after(() => closePool());

test('[critical] market-017 drops the large orders\' table a desk already has, once, and keeps the minute rows', async () => {
  // The desk as it stood: the table made by the retired market-015, with a row in it.
  await query('CREATE TABLE public.large_prints (at BIGINT NOT NULL, side TEXT NOT NULL, price DOUBLE PRECISION NOT NULL, size DOUBLE PRECISION NOT NULL, PRIMARY KEY (at, side))');
  await query("INSERT INTO public.large_prints (at, side, price, size) VALUES (1790000000000, 'buy', 81000, 400)");

  await flowSchema();
  const gone = await one<{ t: string | null }>("SELECT to_regclass('public.large_prints')::text AS t");
  assert.equal(gone!.t, null, 'the table is dropped');
  const ledger = await rows<{ id: string }>("SELECT id FROM public.schema_migrations WHERE id LIKE '%large-prints%'");
  assert.deepEqual(ledger.map((r) => r.id), ['market-017-drop-large-prints'], 'and the ledger says so, once');

  // A second boot finds it done: nothing to drop, nothing thrown.
  await flowSchema();
  const kept = await one<{ t: string | null }>("SELECT to_regclass('public.trade_flow_1m')::text AS t");
  assert.equal(kept!.t, 'trade_flow_1m', 'the minute rows, with their large-trade counts, stay');
});
