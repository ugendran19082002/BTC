import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureOptionSnapshots, lastOptionSnapshot, optionHistory, optionSnapshotsSchema, snapshotRows,
  OPTION_SNAPSHOT_BUCKET_MS, OPTION_SNAPSHOT_KEEP_MS,
} from '../../src/market/option-snapshots.js';
import { closePool, one, query } from '../../src/db/pool.js';
import type { Ticker } from '../../src/market/delta.js';

const T0 = Date.UTC(2026, 8, 19, 6, 2, 30); // 11:32:30 IST, inside the 06:00 UTC bucket
const tk = (symbol: string, cp: 'C' | 'P', strike: number, mark: string, over: Partial<Ticker> = {}): Ticker => ({
  symbol, contract_type: cp === 'C' ? 'call_options' : 'put_options', underlying_asset_symbol: 'BTC',
  strike_price: String(strike), close: 101, mark_price: mark, spot_price: '77900', oi: '12', oi_contracts: '12400', volume: 3100,
  greeks: { delta: '0.36', gamma: '0.00042', theta: '-12.8', vega: '38.6', rho: '1.2', spot: '77900' },
  quotes: { best_bid: '352', best_ask: '368', bid_size: '40', ask_size: '55', mark_iv: '0.478', bid_iv: '0.47', ask_iv: '0.49' },
  ...over,
});
const board = [
  tk('C-BTC-78000-190926', 'C', 78_000, '360'), tk('P-BTC-78000-190926', 'P', 78_000, '356'),
  tk('C-BTC-78000-200926', 'C', 78_000, '900'),
  tk('C-BTC-78000-270926', 'C', 78_000, '2100'),   // a third expiry: out of scope
  tk('C-BTC-78000-180926', 'C', 78_000, '1'),      // settled: out of scope
];

beforeEach(async () => { await optionSnapshotsSchema(); await query('TRUNCATE option_snapshots'); });
after(() => closePool());

test('[critical] the two nearest live expiries, every strike, and nothing else', () => {
  const rows = snapshotRows(board, Math.floor(T0 / 1000));
  assert.deepEqual([...new Set(rows.map((r) => r.expiry))].sort(), ['190926', '200926']);
  assert.equal(rows.length, 3);
  const c = rows.find((r) => r.symbol === 'C-BTC-78000-190926')!;
  assert.deepEqual(
    [c.mark, c.bid, c.ask, c.bidSize, c.askSize, c.markIv, c.delta, c.gamma, c.theta, c.vega, c.rho, c.oi, c.volume, c.spot, c.last],
    [360, 352, 368, 40, 55, 0.478, 0.36, 0.00042, -12.8, 38.6, 1.2, 12400, 3100, 77900, 101],
    'oi_contracts preferred over the coin-denominated oi',
  );
});

test('[critical] one bucket is written once, however often it is asked, and every column round-trips', async () => {
  const first = await captureOptionSnapshots(board, T0);
  assert.deepEqual(first, { at: Math.floor(T0 / OPTION_SNAPSHOT_BUCKET_MS) * OPTION_SNAPSHOT_BUCKET_MS, rows: 3 });
  assert.equal(await captureOptionSnapshots(board, T0 + 60_000), null, 'same five minutes: nothing written');
  assert.equal((await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM option_snapshots'))!.n, 3);

  const [p] = await optionHistory('C-BTC-78000-190926', 0);
  assert.deepEqual(p, { at: first!.at, spot: 77900, mark: 360, bid: 352, ask: 368, markIv: 0.478, delta: 0.36, oi: 12400, volume: 3100 });
  const theta = await one<{ theta: number; gamma: number; ask_size: number }>(
    "SELECT theta, gamma, ask_size FROM option_snapshots WHERE symbol = 'C-BTC-78000-190926'");
  assert.deepEqual(theta, { theta: -12.8, gamma: 0.00042, ask_size: 55 });
});

test('the next bucket writes again, and history comes back oldest first', async () => {
  await captureOptionSnapshots(board, T0);
  await captureOptionSnapshots(board.map((t) => (t.symbol === 'C-BTC-78000-190926' ? { ...t, mark_price: '390' } : t)), T0 + OPTION_SNAPSHOT_BUCKET_MS);
  const h = await optionHistory('C-BTC-78000-190926', 0);
  assert.deepEqual(h.map((x) => x.mark), [360, 390]);
  assert.equal((await lastOptionSnapshot())!.rows, 3);
});

test('a year is kept; older rows go as it writes', async () => {
  await captureOptionSnapshots(board, T0 - OPTION_SNAPSHOT_KEEP_MS - OPTION_SNAPSHOT_BUCKET_MS * 2);
  await captureOptionSnapshots(board, T0);
  const oldest = await one<{ at: number }>('SELECT MIN(at) AS at FROM option_snapshots');
  assert.ok(oldest!.at >= T0 - OPTION_SNAPSHOT_KEEP_MS);
});

test('a board with nothing in scope writes nothing', async () => {
  assert.equal(await captureOptionSnapshots([], T0), null);
});
