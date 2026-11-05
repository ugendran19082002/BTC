import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { clearTradesRange, tradesSavedBetween } from '../../src/report/trades-range.js';
import { closePool, query } from '../../src/db/pool.js';
import { initTradingService, tradingService } from '../../src/trading/service.js';

/**
 * The bug itself, on the database (4 Nov 2026): a range holding more than 5,000 trades. The reports read the newest
 * 5,000 and a week lost its older half. Now every one is there; an old trade saved again is there once, as saved now; a
 * deleted one is gone.
 */
const DAY = 86_400_000, IST = 5.5 * 3_600_000;
const NOW = Date.now();
const TODAY = Math.floor((NOW + IST) / DAY) * DAY - IST;

before(async () => {
  await initTradingService();
  await query('DELETE FROM trades');
  // 500 a day for the twelve days before today, and 300 in the last minute or so -- before now, at any hour, midnight
  // included: 6,300 in all.
  await query(`
    INSERT INTO trades (trade_id, symbol, phase, position, plan, state, updated_at, broker_account_id)
    SELECT 'r-' || d || '-' || i, 'P-BTC-70000-010126', 'flat', 0,
           jsonb_build_object('tradeId', 'r-' || d || '-' || i, 'symbol', 'P-BTC-70000-010126', 'action', 'sell'),
           jsonb_build_object('tradeId', 'r-' || d || '-' || i, 'symbol', 'P-BTC-70000-010126', 'phase', 'flat', 'position', 0, 'contractValue', 0.001, 'v', 1,
             'fills', jsonb_build_array(jsonb_build_object('ts', $1::bigint - d * $2::bigint + 3600000 + i, 'role', 'entry', 'side', 'sell', 'size', 1, 'price', 40))),
           $1::bigint - d * $2::bigint + 3600000 + i * 10, NULL
      FROM generate_series(1, 12) d, generate_series(1, 500) i`, [TODAY, DAY]);
  await query(`
    INSERT INTO trades (trade_id, symbol, phase, position, plan, state, updated_at, broker_account_id)
    SELECT 'r-0-' || i, 'P-BTC-70000-010126', 'flat', 0, jsonb_build_object('tradeId', 'r-0-' || i, 'action', 'sell'),
           jsonb_build_object('tradeId', 'r-0-' || i, 'phase', 'flat', 'position', 0, 'contractValue', 0.001, 'fills', '[]'::jsonb),
           $1::bigint - 60000 - i * 10, NULL
      FROM generate_series(1, 300) i`, [NOW]);
  clearTradesRange();
});
after(async () => { await query('DELETE FROM trades'); tradingService().stop(); await closePool(); });

const ids = (r: { records: { state: unknown }[] }) => r.records.map((x) => (x.state as { tradeId: string }).tradeId);

test('[critical] more than 5,000 trades in the range: every one of them, each once', async () => {
  const r = await tradesSavedBetween(TODAY - 12 * DAY, NOW + 1_000, null, NOW);
  assert.equal(r.records.length, 6_300);
  assert.equal(new Set(ids(r)).size, 6_300);
  assert.equal(r.truncated, false);
});

test('[critical] an old trade saved again is there once, as saved now; a deleted one is gone', async () => {
  await tradesSavedBetween(TODAY - 12 * DAY, NOW + 1_000, null, NOW);
  await query(`UPDATE trades SET updated_at = $1, state = jsonb_set(state, '{v}', '2') WHERE trade_id = 'r-9-7'`, [NOW - 500]);
  await query(`DELETE FROM trades WHERE trade_id = 'r-11-3'`);
  const r = await tradesSavedBetween(TODAY - 12 * DAY, NOW + 1_000, null, NOW);
  assert.equal(r.records.length, 6_299);
  const again = r.records.filter((x) => (x.state as { tradeId: string }).tradeId === 'r-9-7');
  assert.equal(again.length, 1);
  assert.equal((again[0]!.state as unknown as { v: number }).v, 2);
  assert.ok(!ids(r).includes('r-11-3'));
});
