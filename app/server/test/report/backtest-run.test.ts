import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { isMainThread } from 'node:worker_threads';
import { signalBacktest, clearSignalBacktestCache, stopBacktestThread, useBacktestThread } from '../../src/report/backtest-run.js';
import { DEFAULT_PARAMS, signalBacktestHere } from '../../src/report/signal-backtest.js';
import { sessionDayOf, sessionOf } from '../../src/report/market-day.js';
import { optionMarksSchema } from '../../src/market/option-marks.js';
import { flowSchema } from '../../src/market/flow.js';
import { entrySchema } from '../../src/entry/paper.js';
import { methodsSchema } from '../../src/entry/catalogue.js';
import { closePool, query } from '../../src/db/pool.js';

/**
 * Where a backtest is worked (13 Oct 2026): in a thread of its own once the server asks for one, so that seconds
 * of reading and arithmetic never hold up the thread that looks at every open trade's stop each second.
 *
 * A day with a perp tape, one put a minute at a time and three signals, on the real database: the thread must
 * give what working it here gives, forget when told to, and -- where no thread can be started -- the backtest
 * must still be answered here, with the trouble said.
 */

const DAY = new Date(Date.parse(`${sessionDayOf(Date.now())}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
const { from } = sessionOf(DAY);
const ASK = { from: DAY, to: DAY, now: Date.now(), params: { ...DEFAULT_PARAMS, window: 'all' as const }, tfs: null, methods: null };
const figures = (r: Awaited<ReturnType<typeof signalBacktestHere>>) => ({ signals: r.signals, n: r.total.n, net: r.total.net, charges: r.total.charges, exits: r.total.exits, days: r.days.map((d) => [d.day, d.n, d.grain]), priced: r.priced, margin: r.margin });

before(async () => {
  await Promise.all([flowSchema(), entrySchema(), methodsSchema(), optionMarksSchema()]);
  await query('TRUNCATE trade_flow_1m, entry_setups, option_snapshots, option_snapshots_1m, option_marks_1m, option_marks_fetched');
  // the perp climbs from 84,000 to 84,600 over the day; the put decays from 40 to 4, read every minute by the desk itself
  await query(`INSERT INTO trade_flow_1m (at, buy_volume, sell_volume, buy_count, sell_count, large_buy_volume, large_sell_volume, vwap, high, low)
               SELECT $1::bigint + g * 60000, 1, 1, 1, 1, 0, 0, 84000 + g * 600.0 / 1439, 84003 + g * 600.0 / 1439, 83997 + g * 600.0 / 1439 FROM generate_series(0, 1439) g`, [from]);
  const code = `${DAY.slice(8, 10)}${DAY.slice(5, 7)}${DAY.slice(2, 4)}`;
  // And two more puts further out, priced alike: one trade per contract (14 Oct 2026), so each of the day's
  // overlapping signals sells a strike of its own.
  for (const strike of [83_200, 83_000, 82_800]) {
    await query(`INSERT INTO option_snapshots_1m (at, symbol, expiry, cp, strike, spot, mark, bid, ask, delta)
                 SELECT $1::bigint + g * 60000, $2, $3, 'P', $4, 84000, 41 - 36 * g / 1439.0, 40 - 36 * g / 1439.0, 42 - 36 * g / 1439.0, -0.09 FROM generate_series(0, 1439) g`, [from, `P-BTC-${strike}-${code}`, code, strike]);
  }
  let trigger = 1_780_000_000;
  for (const [min, tf] of [[30, '15m'], [200, '1h'], [700, '15m']] as const) {
    const filled = Math.floor(from / 1_000) + min * 60;
    await query(
      `INSERT INTO entry_setups (method, mode, tf, dir, trigger_at, first_seen, entry_lo, entry_hi, stop, tp1, rr, graded_to, status, filled_at, fill_price, exit_at, exit_price, r_net)
       VALUES ('breakout', 'single', $1, 1, $2, $3, 84000, 84050, 83700, 84500, 1.5, 0, 'tp1', $4, 84000, $5, 84500, 1)`,
      [tf, trigger += 900, (filled - 60) * 1_000, filled, filled + 1_800]);
  }
});
after(async () => { await stopBacktestThread(); await closePool(); });

test('[critical] a backtest worked in its own thread gives what working it here gives', async () => {
  assert.ok(isMainThread);
  const here = await signalBacktestHere(ASK);
  assert.deepEqual([here.signals, here.total.n, here.priced], [3, 3, { 'own-1m': 1, 'mark-1m': 0, '5m': 0 }], 'three signals traded, on the desk\'s own minute record');
  assert.ok(here.total.net !== 0);

  const trouble: string[] = [];
  useBacktestThread((m) => trouble.push(m));
  const there = await signalBacktest(ASK);
  assert.deepEqual(figures(there), figures(here));
  assert.deepEqual(JSON.parse(JSON.stringify(there.byTf)), JSON.parse(JSON.stringify(here.byTf)));

  // other settings, and the time frame filter, through the thread
  const narrowed = await signalBacktest({ ...ASK, params: { ...ASK.params, lots: 1 }, tfs: ['1h'] });
  assert.deepEqual([narrowed.signals, narrowed.total.n], [1, 1]);

  // what it keeps is forgotten when told to: a signal added afterwards is seen
  const filled = Math.floor(from / 1_000) + 900 * 60;
  await query(
    `INSERT INTO entry_setups (method, mode, tf, dir, trigger_at, first_seen, entry_lo, entry_hi, stop, tp1, rr, graded_to, status, filled_at, fill_price, exit_at, exit_price, r_net)
     VALUES ('breakout', 'single', '4h', 1, 1790000000, $1, 84000, 84050, 83700, 84500, 1.5, 0, 'tp1', $2, 84000, $3, 84500, 1)`, [(filled - 60) * 1_000, filled, filled + 1_800]);
  assert.equal((await signalBacktest(ASK)).signals, 3, 'a settled day already worked is kept');
  await clearSignalBacktestCache();
  assert.equal((await signalBacktest(ASK)).signals, 4);
  assert.deepEqual(trouble, []);
});

test('[critical] a backtest that cannot be meant is refused in the thread\'s own words, and the thread goes on', async () => {
  useBacktestThread();
  await assert.rejects(() => signalBacktest({ ...ASK, params: null as never }), /Cannot read|null|undefined/);
  assert.equal((await signalBacktest(ASK)).signals, 4, 'the next one is answered');
});

test('[critical] where no thread can be started the backtest is worked here, and the trouble is said once', async () => {
  await stopBacktestThread();
  const trouble: string[] = [];
  useBacktestThread((m) => trouble.push(m), new URL('./no-such-worker.js', import.meta.url));
  const r = await signalBacktest(ASK);
  assert.equal(r.signals, 4, 'answered all the same');
  assert.ok(trouble.some((m) => /no backtest thread could be started/.test(m)), trouble.join(' | '));
  const said = trouble.length;
  assert.equal((await signalBacktest({ ...ASK, params: { ...ASK.params, lots: 2 } })).signals, 4);
  assert.equal(trouble.length, said, 'not tried, and not said, again straight away');
});
