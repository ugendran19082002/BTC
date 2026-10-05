import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { istDayRange, methodReport, methodsSchema } from '../../src/entry/catalogue.js';
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
  assert.deepEqual(mtf!.rows.filter((r) => r.n !== null && r.n <= 12).map((r) => r.orderSide),
    ['BUY', 'BUY', 'BUY', 'BUY', 'BUY', 'BUY', 'BUY', 'BUY', 'BUY', 'SELL', 'BUY', 'BUY'], 'each line carries its method\'s order side');
  assert.equal(mtf!.total.orderSide, null, 'a total has none');

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

test('[critical] a date range keeps the signals first seen on those IST days -- the edges to the minute', async () => {
  const at = (iso: string) => Date.parse(iso);
  const seen = (ms: number, exit: number) => query(
    `INSERT INTO entry_setups (method, mode, tf, dir, trigger_at, first_seen, entry_lo, entry_hi, stop, tp1, rr, status, graded_to,
                               fill_price, exit_price, r_net)
     VALUES ('bos', 'mtf', '5m', 1, $1, $2, 100, 101, 90, 120, 1.5, 'tp1', 0, 84000, $3, 1)`, [trigger++, ms, exit]);
  await seen(at('2026-09-30T18:29:00Z'), 84_001); // 23:59 IST, 30 Sep
  await seen(at('2026-09-30T18:30:00Z'), 84_010); // 00:00 IST, 1 Oct
  await seen(at('2026-10-01T18:29:59Z'), 84_100); // 23:59:59 IST, 1 Oct
  await seen(at('2026-10-01T18:30:00Z'), 85_000); // 00:00 IST, 2 Oct
  const bos = async (from?: string, to?: string) => {
    const r = istDayRange(from, to);
    assert.ok(!(r && 'error' in r));
    return (await methodReport(null, false, r as { from: number; to: number } | null)).sections[0]!.rows.find((x) => x.method === 'bos')!;
  };
  assert.deepEqual([(await bos('2026-10-01', '2026-10-01')).trades, (await bos('2026-10-01', '2026-10-01')).netPts], [2, 110], '1 Oct IST: the 00:00 and the 23:59:59');
  assert.equal((await bos('2026-09-30', '2026-09-30')).netPts, 1);
  assert.equal((await bos('2026-09-30', '2026-10-02')).trades, 4, 'a range of days');
  assert.equal((await bos()).trades, 4, 'no range: every signal');
});

test('the range is checked: both ends, real days, in order', () => {
  assert.equal(istDayRange(), null);
  assert.deepEqual(istDayRange('2026-10-01', '2026-10-01'), { from: Date.parse('2026-09-30T18:30:00Z'), to: Date.parse('2026-10-01T18:30:00Z') });
  for (const [f, t] of [['2026-10-01', undefined], ['2026-10-1', '2026-10-02'], ['2026-02-30', '2026-03-01'], ['2026-10-02', '2026-10-01']] as const) {
    assert.ok('error' in (istDayRange(f, t) as object), `${f} .. ${t} refused`);
  }
});

test('[critical] a range to the minute: from 09:00 to 17:30 IST takes 17:30:59 and not 17:31', () => {
  const r = istDayRange('2026-10-01T09:00', '2026-10-01T17:30') as { from: number; to: number };
  assert.equal(r.from, Date.parse('2026-10-01T03:30:00Z'));
  assert.equal(r.to, Date.parse('2026-10-01T12:01:00Z'), '17:30 IST counted whole');
  // A day and a minute mix: from a day's start to a minute of a later day.
  assert.deepEqual(istDayRange('2026-09-30', '2026-10-01T00:00'), { from: Date.parse('2026-09-29T18:30:00Z'), to: Date.parse('2026-09-30T18:31:00Z') });
  for (const [f, t] of [['2026-10-01T24:00', '2026-10-01T25:00'], ['2026-10-01T09:60', '2026-10-01T10:00'], ['2026-10-01T17:30', '2026-10-01T09:00'], ['2026-10-01T9:00', '2026-10-01T10:00']] as const) {
    assert.ok('error' in (istDayRange(f, t) as object), `${f} .. ${t} refused`);
  }
});

test('[critical] the report counts signals by the minute they appeared', async () => {
  const at = (iso: string) => Date.parse(iso);
  const seen = (ms: number) => query(
    `INSERT INTO entry_setups (method, mode, tf, dir, trigger_at, first_seen, entry_lo, entry_hi, stop, tp1, rr, status, graded_to,
                               fill_price, exit_price, r_net)
     VALUES ('mss', 'mtf', '5m', 1, $1, $2, 100, 101, 90, 120, 1.5, 'tp1', 0, 84000, 84010, 1)`, [trigger++, ms]);
  await seen(at('2026-10-01T03:29:59Z')); // 08:59:59 IST
  await seen(at('2026-10-01T03:30:00Z')); // 09:00 IST
  await seen(at('2026-10-01T12:00:59Z')); // 17:30:59 IST
  await seen(at('2026-10-01T12:01:00Z')); // 17:31 IST
  const r = istDayRange('2026-10-01T09:00', '2026-10-01T17:30') as { from: number; to: number };
  const mss = (await methodReport(null, false, r)).sections[0]!.rows.find((x) => x.method === 'mss')!;
  assert.equal(mss.trades, 2, '09:00 and 17:30:59 in; 08:59:59 and 17:31 out');
});

test('[critical] from a minute of a day to that whole day: "today 8:45 AM to 11:59 PM" is a range (2 Oct 2026 bug)', () => {
  // The screen sends the bare day for an end at 11:59 PM; that day's start is before 08:45, its end is not.
  assert.deepEqual(istDayRange('2026-10-02T08:45', '2026-10-02'), { from: Date.parse('2026-10-02T03:15:00Z'), to: Date.parse('2026-10-02T18:30:00Z') });
  // still refused: a start after the whole of the end
  assert.ok('error' in (istDayRange('2026-10-03T00:00', '2026-10-02') as object));
  assert.ok('error' in (istDayRange('2026-10-02T10:01', '2026-10-02T10:00') as object));
  // the same minute is a one-minute range
  assert.deepEqual(istDayRange('2026-10-02T10:00', '2026-10-02T10:00'), { from: Date.parse('2026-10-02T04:30:00Z'), to: Date.parse('2026-10-02T04:31:00Z') });
});
