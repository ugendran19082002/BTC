import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOptionMarks, marksFetchedBy, marksWanted, optionMarksSchema, storeMarks } from '../../src/market/option-marks.js';
import { closePool, one, query, rows } from '../../src/db/pool.js';
import { sessionOf } from '../../src/report/market-day.js';
import type { Candle } from '../../src/market/delta.js';

/**
 * Delta's one-minute mark of the contracts the desk recorded only every five minutes (owner, 13 Oct 2026:
 * "backtest on one-minute option prices; where the database has none, take them from Delta's API").
 *
 * On the real database, with Delta played by a function: which contracts are asked for, that each is asked for
 * once, and that the fetch stops when it is told the desk is busy.
 */

const DAY = '2026-10-07', CODE = '071026';
const span = sessionOf(DAY);
const NOW = span.to + 3_600_000;
const MIN = 60_000;
const reading = (table: string, min: number, symbol: string, cp: 'C' | 'P', strike: number, bid: number | null, spot = 84_000) =>
  query(`INSERT INTO ${table} (at, symbol, expiry, cp, strike, spot, mark, bid, ask) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [span.from + min * MIN, symbol, symbol.split('-')[3], cp, strike, spot, bid === null ? 1 : bid + 1, bid, bid === null ? null : bid + 2]);
const minutes = (n: number, open = 40): Candle[] => Array.from({ length: n }, (_, i) => ({ time: span.from / 1_000 + i * 60, open: open - i * 0.01, high: open, low: open - 1, close: open - (i + 1) * 0.01, volume: 0 }));

beforeEach(async () => {
  await optionMarksSchema();
  await query('TRUNCATE option_snapshots, option_snapshots_1m, option_marks_1m, option_marks_fetched');
  await reading('option_snapshots', 0, `P-BTC-83200-${CODE}`, 'P', 83_200, 40);       // out of the money, worth selling
  await reading('option_snapshots', 5, `P-BTC-83200-${CODE}`, 'P', 83_200, 38);
  await reading('option_snapshots', 0, `C-BTC-85000-${CODE}`, 'C', 85_000, 44);       // the same on the call side
  await reading('option_snapshots', 0, `P-BTC-82000-${CODE}`, 'P', 82_000, 4);        // never bid at 10: nothing would have sold it
  await reading('option_snapshots', 0, `P-BTC-84600-${CODE}`, 'P', 84_600, 700);      // in the money: never sold
  await reading('option_snapshots', 0, `C-BTC-86000-${CODE}`, 'C', 86_000, null);     // no bid at all
  await reading('option_snapshots', 0, 'P-BTC-83200-081026', 'P', 83_200, 90);        // the next day's contract
});
after(() => closePool());

test('[critical] the contracts asked for: of that expiry, out of the money with a bid worth selling at some reading -- and none where the desk has the minutes itself', async () => {
  assert.deepEqual(await marksWanted(DAY, span), [`C-BTC-85000-${CODE}`, `P-BTC-83200-${CODE}`]);
  // once fetched -- candles or none -- a contract is not wanted again
  await storeMarks(`C-BTC-85000-${CODE}`, CODE, [], NOW);
  assert.deepEqual(await marksWanted(DAY, span), [`P-BTC-83200-${CODE}`]);
  // the desk's own minute record over nine tenths of the day: nothing to ask Delta for
  await query(`INSERT INTO option_snapshots_1m (at, symbol, expiry, cp, strike, spot, mark, bid, ask)
               SELECT $1::bigint + g * 60000, $2, $3, 'P', 83200, 84000, 41, 40, 42 FROM generate_series(0, 1339) g`, [span.from, `P-BTC-83200-${CODE}`, CODE]);
  assert.deepEqual(await marksWanted(DAY, span), []);
});

test('[critical] a run fetches each contract once, a minute a row, and never asks for it again', async () => {
  const asked: [string, number, number][] = [];
  const fetch = async (symbol: string, a: number, b: number) => { asked.push([symbol, a, b]); return symbol.startsWith('P') ? minutes(1_440) : []; };
  const first = await fetchOptionMarks({ days: [{ day: DAY, ...span }], now: NOW, pauseMs: 0, fetch });
  assert.deepEqual(first, { days: 1, contracts: 2, candles: 1_440, left: 0 });
  assert.deepEqual(asked, [[`C-BTC-85000-${CODE}`, span.from / 1_000 - 300, span.to / 1_000], [`P-BTC-83200-${CODE}`, span.from / 1_000 - 300, span.to / 1_000]], 'the contract by its own name, over the day and the five minutes before it');
  assert.equal((await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM option_marks_1m'))!.n, 1_440);
  const m = await one<{ at: string; open: number; close: number }>('SELECT at, open, close FROM option_marks_1m WHERE symbol = $1 ORDER BY at LIMIT 1', [`P-BTC-83200-${CODE}`]);
  assert.deepEqual([Number(m!.at), m!.open, m!.close], [span.from, 40, 39.99], 'a minute a row, in milliseconds as every other record');
  assert.deepEqual(await rows('SELECT symbol, candles FROM option_marks_fetched ORDER BY symbol'), [{ symbol: `C-BTC-85000-${CODE}`, candles: 0 }, { symbol: `P-BTC-83200-${CODE}`, candles: 1_440 }], 'a contract with no candles is an answer too');
  assert.deepEqual(Object.fromEntries(await marksFetchedBy([CODE, '081026'])), { [CODE]: { contracts: 2, candles: 1_440 } });

  asked.length = 0;
  assert.deepEqual(await fetchOptionMarks({ days: [{ day: DAY, ...span }], now: NOW, pauseMs: 0, fetch }), { days: 0, contracts: 0, candles: 0, left: 0 });
  assert.deepEqual(asked, [], 'nothing asked a second time');
});

test('[critical] a run is bounded, stops when the desk is busy, leaves a failure for next time -- and never asks about a day still running', async () => {
  const asked: string[] = [];
  const fetch = async (symbol: string) => { asked.push(symbol); return minutes(10); };
  // a day still running: its contract is live, its minutes the desk's own to record
  assert.deepEqual(await fetchOptionMarks({ days: [{ day: DAY, ...span }], now: span.to - 1, pauseMs: 0, fetch }), { days: 0, contracts: 0, candles: 0, left: 0 });
  // one request allowed
  assert.deepEqual(await fetchOptionMarks({ days: [{ day: DAY, ...span }], now: NOW, pauseMs: 0, maxRequests: 1, fetch }), { days: 1, contracts: 1, candles: 10, left: 1 });
  // the desk is busy with Delta: nothing asked
  assert.deepEqual(await fetchOptionMarks({ days: [{ day: DAY, ...span }], now: NOW, pauseMs: 0, busy: () => true, fetch }), { days: 1, contracts: 0, candles: 0, left: 1 });
  assert.deepEqual(asked, [`C-BTC-85000-${CODE}`]);
  // Delta fails: said, nothing recorded as fetched, and asked again on the next run
  const errors: string[] = [];
  const failed = await fetchOptionMarks({ days: [{ day: DAY, ...span }], now: NOW, pauseMs: 0, fetch: async () => { throw new Error('HTTP 429'); }, onError: (e) => errors.push(e.message) });
  assert.deepEqual([failed.contracts, failed.left, errors], [0, 1, ['HTTP 429']]);
  assert.deepEqual(await fetchOptionMarks({ days: [{ day: DAY, ...span }], now: NOW, pauseMs: 0, fetch }), { days: 1, contracts: 1, candles: 10, left: 0 });
});

test('a candle Delta sends without a price is left out; marks older than the five-minute record keeps are dropped', async () => {
  const odd = [...minutes(3), { time: span.from / 1_000 + 600, open: Number.NaN, high: 1, low: 1, close: 1, volume: 0 }];
  assert.equal(await storeMarks(`P-BTC-83200-${CODE}`, CODE, odd, NOW), 3);
  assert.equal(await storeMarks(`P-BTC-83200-${CODE}`, CODE, odd, NOW), 3, 'written again: the same rows, not doubled');
  assert.equal((await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM option_marks_1m'))!.n, 3);
  await fetchOptionMarks({ days: [], now: span.from + 91 * 86_400_000, pauseMs: 0 });
  assert.equal((await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM option_marks_1m'))!.n, 0);
});
