import { after, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The entry record worked out by the database (17 Oct 2026) is the record worked out row by row, to the last digit:
 * every method and way, every count and sum, the drawdown in close order, and the totals in the order the ways first
 * appear. Two thousand setups of every kind: ties in close time, no fill, no exit, no R, gates switched off.
 */
const { query, rows, closePool } = await import('../../src/db/pool.js');
const { entrySchema, recordFromRows, recordFromSql, RECORD_SQL } = await import('../../src/entry/paper.js');
await entrySchema();
after(async () => { await closePool(); });

let seed = 7;
const rnd = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;

test('[critical] the record by SQL equals the record row by row: every figure of every method, way and total', async () => {
  const STATUSES = ['tp1', 'stop', 'timeout', 'expired', 'open', 'filled'] as const;
  const values: unknown[][] = [];
  for (let i = 0; i < 2_000; i++) {
    const status = pick(STATUSES), closed = status === 'tp1' || status === 'stop' || status === 'timeout';
    const fill = rnd() < 0.85 ? 84_000 + Math.round(rnd() * 400) : null;
    const exit = closed && rnd() < 0.9 ? 84_000 + Math.round(rnd() * 400) : null;
    values.push([
      pick(['breakout', 'bos', 'fvg-retest', 'trap']), pick(['single', 'mtf']), pick(['5m', '15m', '1h']), pick([1, -1]), 1_790_000_000 + i,
      1_790_000_000_000 + i * 1_000, 84_000, 84_050, 83_700, 84_500, 1.5, status,
      fill, exit, closed && rnd() < 0.85 ? 1_790_000_100_000 + Math.floor(rnd() * 400) * 60_000 : null,
      closed && rnd() < 0.95 ? Math.round((rnd() * 4 - 1.5) * 100) / 100 : null,
      1_790_000_100_000 + Math.floor(rnd() * 400) * 60_000, rnd() < 0.1 ? ['spread'] : [],
    ]);
  }
  for (const v of values) {
    await query(`INSERT INTO entry_setups (method, mode, tf, dir, trigger_at, first_seen, entry_lo, entry_hi, stop, tp1, rr, status,
      fill_price, exit_price, exit_at, r_net, graded_to, gates_off) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, v);
  }
  const all = await rows<any>('SELECT method, mode, tf, status, r_net, first_seen, gates_off, dir, fill_price, exit_price FROM entry_setups ORDER BY coalesce(exit_at, graded_to), id');
  const want = recordFromRows(all.map((r) => ({ ...r, first_seen: Number(r.first_seen) })));
  const got = recordFromSql(await rows<any>(RECORD_SQL));
  const close = (a: unknown, b: unknown, where: string) => {
    if (typeof a === 'number' && typeof b === 'number') assert.ok(Math.abs(a - b) < 1e-9, `${where}: ${a} vs ${b}`);
    else assert.deepEqual(a, b, where);
  };
  for (const part of ['records', 'totals', 'totalsAll'] as const) {
    assert.equal(got[part].length, want[part].length, part);
    got[part].forEach((g, i) => {
      const w = want[part][i]!;
      for (const k of Object.keys(w) as (keyof typeof w)[]) close(g[k], w[k], `${part}[${i}] ${w.method}/${w.mode}/${w.tf} ${String(k)}`);
    });
  }
  assert.ok(want.records.length >= 20 && want.totals.length >= 6, 'a varied enough record to mean something');
  assert.ok(want.records.some((r) => r.gatesOff > 0) && want.records.some((r) => r.maxDrawdownR! < 0));
});

test('[critical] an empty table is an empty record, not an error', async () => {
  await query('DELETE FROM entry_setups');
  assert.deepEqual(recordFromSql(await rows<any>(RECORD_SQL)), { records: [], totals: [], totalsAll: [] });
});

test('[critical] fresh in the background: the first ask waits; a change is fresh when quick, the last answer when slow; one refresh at a time', async () => {
  const { freshInBackground, bumpDataVersion } = await import('../../src/entry/version.js');
  let calls = 0;
  let slow = false;
  const read = () => new Promise<number>((done) => { calls++; const n = calls; setTimeout(() => done(n), slow ? 400 : 5); });
  const ask = freshInBackground(read, 60_000, 100);
  assert.equal(await ask(1_000), 1, 'the first ask waits for its answer');
  assert.equal(await ask(2_000), 1); assert.equal(calls, 1, 'nothing read again: nothing changed');
  bumpDataVersion();
  assert.equal(await ask(3_000), 2, 'the data moved on and the refresh was quick: fresh');
  slow = true; bumpDataVersion();
  assert.equal(await ask(4_000), 2, 'slow: the last answer, after waiting no more than its limit');
  assert.equal(await ask(4_050), 2); assert.equal(calls, 3, 'never two at a time');
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(await ask(4_600), 3, 'the slow refresh\u2019s answer once it is in');
});
