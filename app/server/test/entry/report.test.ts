import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { methodReport, methodsSchema } from '../../src/entry/catalogue.js';
import { entrySchema } from '../../src/entry/paper.js';
import { METHODS } from '../../src/entry/methods.js';
import { closePool, query } from '../../src/db/pool.js';

after(closePool);

/**
 * The report (owner, 1 Oct 2026): every method, with the timeframe chain and
 * without it -- signals, trades, wins, losses, win rate, profit, loss and net,
 * in points and R. Seeded with trades whose figures are known by hand.
 */

let trigger = 1_790_000_000;
const add = (method: string, mode: 'mtf' | 'single', tf: string, status: string, dir: 1 | -1,
  fill: number | null, exit: number | null, r: number | null, gatesOff: string[] = []) => query(
  `INSERT INTO entry_setups (method, mode, tf, dir, trigger_at, first_seen, entry_lo, entry_hi, stop, tp1, rr, status, graded_to,
                             fill_price, exit_price, r_net, gates_off)
   VALUES ($1, $2, $3, $4, $5, 0, 100, 101, 90, 120, 1.5, $6, 0, $7, $8, $9, $10)`,
  [method, mode, tf, dir, trigger++, status, fill, exit, r, gatesOff]);

test('[critical] two sections, every method in each, with the figures by hand', async () => {
  await methodsSchema();
  await entrySchema();
  await add('breakout', 'mtf', '5m', 'tp1', 1, 84_000, 84_150, 1.5);    // +150 pts, +1.5R
  await add('breakout', 'mtf', '5m', 'stop', 1, 84_000, 83_900, -1);    // -100 pts, -1R
  await add('breakout', 'mtf', '5m', 'timeout', -1, 84_000, 84_020, -0.2); // a short out 20 against: a loss
  await add('breakout', 'mtf', '5m', 'expired', 1, null, null, null);   // a signal, never a trade
  await add('breakout', 'single', '15m', 'stop', -1, 84_000, 84_100, -1);
  await add('breakout', 'single', '5m', 'tp1', 1, 84_000, 84_060, 2, ['rr']); // a gate off: left out

  const { sections: [mtf, single] } = await methodReport();
  assert.equal(mtf!.mode, 'mtf');
  assert.equal(mtf!.rows.length, METHODS.length, `all ${METHODS.length} methods, a line each`);
  assert.equal(single!.rows.length, METHODS.length);
  assert.deepEqual(mtf!.rows.map((r) => r.n), METHODS.map((m) => m.n), 'in the desk\'s 1-81 order');

  const b = mtf!.rows.find((r) => r.method === 'breakout')!;
  assert.deepEqual(
    { signals: b.signals, trades: b.trades, wins: b.wins, losses: b.losses, profitPts: b.profitPts, lossPts: b.lossPts, netPts: b.netPts },
    { signals: 4, trades: 3, wins: 1, losses: 2, profitPts: 150, lossPts: 120, netPts: 30 });
  assert.ok(Math.abs(b.winPct! - 100 / 3) < 1e-9);
  assert.ok(Math.abs(b.netR - 0.3) < 1e-9 && Math.abs(b.lossR - 1.2) < 1e-9);

  const s = single!.rows.find((r) => r.method === 'breakout')!;
  assert.deepEqual([s.signals, s.trades, s.wins, s.losses, s.netPts], [2, 2, 1, 1, -40],
    'every signal counts by default, as in the history -- the gate-off TRADE included');
  assert.equal(single!.gatesOffSignals, 1, 'and the section says how many were taken with a gate off');

  const quiet = mtf!.rows.find((r) => r.method === 'momentum')!;
  assert.deepEqual([quiet.signals, quiet.trades, quiet.winPct], [0, 0, null], 'no trades: no win rate, not 0%');

  assert.deepEqual([mtf!.total.trades, mtf!.total.wins, mtf!.total.netPts], [3, 1, 30], 'the section total adds its lines');
});

test('one timeframe narrows the section without the chain; the chain\'s entry is always 5m', async () => {
  const { sections: [mtf, single] } = await methodReport('5m');
  const s = single!.rows.find((r) => r.method === 'breakout')!;
  assert.deepEqual([s.trades, s.netPts], [1, 60], 'the 5m TP1 only: the 15m stop is not a 5m trade');
  assert.equal(mtf!.rows.find((r) => r.method === 'breakout')!.trades, 3);
});

test('[critical] every gate on: only the setups taken under the rules as designed', async () => {
  const { sections: [, single] } = await methodReport(null, true);
  const s = single!.rows.find((r) => r.method === 'breakout')!;
  assert.deepEqual([s.signals, s.trades, s.wins, s.losses, s.netPts], [1, 1, 0, 1, -100], 'the gate-off TRADE is in neither figure');
  assert.equal(single!.gatesOffSignals, 0);
});

test('[critical] without the chain, one section per timeframe -- and they add up to All', async () => {
  const { sections: [, all], singleByTf } = await methodReport();
  assert.deepEqual(Object.keys(singleByTf), ['3m', '5m', '15m', '30m', '1h', '4h']);
  const line = (tf: '3m' | '5m' | '15m') => singleByTf[tf]!.rows.find((r) => r.method === 'breakout')!;
  assert.deepEqual([line('15m').trades, line('15m').netPts], [1, -100], 'the 15m stop');
  assert.deepEqual([line('5m').trades, line('5m').netPts], [1, 60], 'the 5m TP1');
  assert.equal(line('3m').trades, 0);
  for (const tf of Object.keys(singleByTf) as (keyof typeof singleByTf)[]) {
    assert.equal(singleByTf[tf]!.rows.length, all!.rows.length, `${tf}: every method a line`);
  }
  const sum = (k: 'trades' | 'netPts' | 'signals') => Object.values(singleByTf).reduce((a, s) => a + s!.total[k], 0);
  assert.deepEqual([sum('signals'), sum('trades'), sum('netPts')], [all!.total.signals, all!.total.trades, all!.total.netPts]);
});
