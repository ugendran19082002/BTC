import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, one, query, rows } from '../../src/db/pool.js';
import { flowSchema } from '../../src/market/flow.js';

/**
 * The chart's saved levels went with its layers (4 Oct 2026). On the desk the
 * table already exists -- `chart-001-annotations` made it -- so the migration
 * that retires it has to drop a table that is there, once, and do nothing on a
 * database that never had it.
 */
after(() => closePool());

test('[critical] chart-002 drops the saved-levels table a desk already has, and is recorded once', async () => {
  // The desk as it stood: the table made by the retired chart-001, with a row in it.
  await query('CREATE TABLE public.chart_annotations (id BIGINT PRIMARY KEY, symbol TEXT NOT NULL)');
  await query("INSERT INTO public.chart_annotations (id, symbol) VALUES (1, 'BTCUSD')");

  await flowSchema();
  const gone = await one<{ t: string | null }>("SELECT to_regclass('public.chart_annotations')::text AS t");
  assert.equal(gone!.t, null, 'the table is dropped');
  const ledger = await rows<{ id: string }>("SELECT id FROM public.schema_migrations WHERE id LIKE 'chart-%'");
  assert.deepEqual(ledger.map((r) => r.id), ['chart-002-drop-annotations'], 'and the ledger says so, once');

  // A second boot finds it done: nothing to drop, nothing thrown, no second row.
  await flowSchema();
  const again = await one<{ n: number }>("SELECT count(*)::int AS n FROM public.schema_migrations WHERE id = 'chart-002-drop-annotations'");
  assert.equal(again!.n, 1);
});

test('the tables the entry methods read are still there', async () => {
  for (const t of ['trade_flow_1m', 'large_prints', 'perp_snapshots', 'option_flow_1m']) {
    const r = await one<{ t: string | null }>('SELECT to_regclass($1)::text AS t', [`public.${t}`]);
    assert.equal(r!.t, t, `${t} is kept`);
  }
});
