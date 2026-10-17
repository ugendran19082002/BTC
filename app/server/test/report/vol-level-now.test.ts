import { after, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * How volatile it is now, for a live signal (17 Oct 2026, delta by volatility): `volLevelNow` reads the tables the
 * backtest reads -- the board's ATM IV every five minutes, the perp's minutes -- against the five expiry days
 * before, as `ivReader` and `volReader` do at a backtest's fill. Nothing it cannot read is a level.
 */
const { query, closePool } = await import('../../src/db/pool.js');
const { optionSnapshotsSchema } = await import('../../src/market/option-snapshots.js');
const { flowSchema } = await import('../../src/market/flow.js');
const { sessionDayOf, sessionOf } = await import('../../src/report/market-day.js');
const { volLevelNow, clearSignalBacktestCache } = await import('../../src/report/signal-backtest.js');
await optionSnapshotsSchema(); await flowSchema();
after(async () => { await closePool(); });

const MIN = 60_000, DAY = 86_400_000;
const today = sessionDayOf(Date.now());
const codeOf = (day: string) => `${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(2, 4)}`;
const back = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);
/** The ATM pair of a day's own contract every five minutes, from `fromMin` into its session, at an IV of `ivOf(minute)`. */
async function board(day: string, ivOf: (m: number) => number, fromMin = 0, toMin = 1_440) {
  const at: number[] = [], iv: number[] = [];
  for (let m = fromMin; m < toMin; m += 5) { at.push(sessionOf(day).from + m * MIN); iv.push(ivOf(m)); }
  for (const cp of ['C', 'P']) {
    await query(`INSERT INTO option_snapshots (at, symbol, expiry, cp, strike, spot, mark, bid, ask, delta, mark_iv)
      SELECT a, $3, $4, $5, 84000, 84000, 500, 499, 501, 0.5, v FROM unnest($1::bigint[], $2::float8[]) AS t(a, v) ON CONFLICT DO NOTHING`,
      [at, iv, `${cp}-BTC-84000-${codeOf(day)}`, codeOf(day), cp]);
  }
}
/** The perp a minute at a time over [from, to), each minute's range `size` points. */
async function tape(from: number, to: number, size: number) {
  const at: number[] = [], px: number[] = [];
  for (let t = Math.floor(from / MIN) * MIN; t < to; t += MIN) { at.push(t); px.push(84_000 + ((t / MIN) % 7) * size / 7); }
  await query(`INSERT INTO trade_flow_1m (at, buy_volume, sell_volume, buy_count, sell_count, large_buy_volume, large_sell_volume, vwap, high, low)
    SELECT a, 1, 1, 1, 1, 0, 0, p, p + $3, p - $3 FROM unnest($1::bigint[], $2::float8[]) AS t(a, p) ON CONFLICT DO NOTHING`, [at, px, size / 2]);
}

test('[critical] by ATM IV: the latest reading against the same hour of the days before; stale or none, unknown', async () => {
  // Five days before, IV 40-60 every hour; today 70 up to an hour ago, then 41.
  for (let n = 1; n <= 5; n++) await board(back(n), (m) => 40 + (20 * ((m / 5) % 12)) / 11);
  const now = Date.now(), into = Math.floor((now - sessionOf(today).from) / MIN);
  await board(today, (m) => (m < into - 60 ? 70 : 41), 0, into + 1);
  clearSignalBacktestCache();
  assert.equal(await volLevelNow('iv', now), 'low', 'the latest reading, 41: under the low third');
  assert.equal(await volLevelNow('iv', now - 70 * MIN), 'high', 'an hour ago, 70: over the high third');
  // No reading in the six minutes before: unknown, never low.
  clearSignalBacktestCache();
  assert.equal(await volLevelNow('iv', now + 30 * MIN), null);
});

test('[critical] by ATR 2h: the last two hours of 15-minute candles against the five days before; failing, unknown', async () => {
  const now = Date.now();
  // Five quiet days (10-point minutes), then the last two hours four times as wide.
  for (let n = 1; n <= 5; n++) { const s = sessionOf(back(n)); await tape(s.from, s.to, 10); }
  await tape(now - 3 * 3_600_000, now, 40);
  clearSignalBacktestCache();
  assert.equal(await volLevelNow('atr', now), 'high');
  // Kept a minute: asked again within it, not read again.
  await query('DELETE FROM trade_flow_1m WHERE at >= $1', [now - 3 * 3_600_000]);
  assert.equal(await volLevelNow('atr', now), 'high');
  // Read again after it: no candles in the last two hours, unknown.
  assert.equal(await volLevelNow('atr', now + 2 * MIN), null);
});
