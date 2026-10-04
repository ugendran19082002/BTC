import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, one, query, rows } from '../../src/db/pool.js';
import { StrategyStore } from '../../src/strategy/store.js';

/**
 * The trend plan's paper log went on 4 Oct 2026 with its recorder and route.
 * On the desk the table exists -- the retired `trend-001` made it -- so the
 * migration has to drop a table that is there, once, and leave the signal
 * strategies' own tables alone.
 */
after(() => closePool());

test('[critical] strategy-007 drops the trend paper table a desk already has, once, and keeps the strategies', async () => {
  await query('CREATE TABLE public.trend_paper (id BIGINT PRIMARY KEY, tf TEXT NOT NULL, entry_time BIGINT NOT NULL)');
  await query("INSERT INTO public.trend_paper (id, tf, entry_time) VALUES (1, '1H', 1790000000)");

  await StrategyStore.open();
  const gone = await one<{ t: string | null }>("SELECT to_regclass('public.trend_paper')::text AS t");
  assert.equal(gone!.t, null, 'the table is dropped');
  const ledger = await rows<{ id: string }>("SELECT id FROM public.schema_migrations WHERE id LIKE '%trend%'");
  assert.deepEqual(ledger.map((r) => r.id), ['strategy-007-drop-trend-paper'], 'and the ledger says so, once');

  await StrategyStore.open(); // a second boot: nothing to drop, nothing thrown
  for (const t of ['strategies', 'strategy_signal_runs']) {
    const r = await one<{ t: string | null }>('SELECT to_regclass($1)::text AS t', [`public.${t}`]);
    assert.equal(r!.t, t, `${t} is kept`);
  }
});
