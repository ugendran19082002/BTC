/**
 * The live record of every entry method -- the twelve and the rest, all on the
 * desk since 1 Oct 2026 -- read from the paper log over the last N days: per
 * method and way, set up, filled, closed, won, average R, profit factor, t;
 * then every closed trade by the regime it was taken in (the owner's filters,
 * methods.ts regimeOf). Read-only.
 *
 *   cd app/server && DATABASE_URL=... npx tsx scripts/methods-week.ts [days=7]
 *
 * Read it as a week is: short. A method above the bar after a week has earned
 * another week; one far below it is a strong hint. R per closed trade (TP1,
 * stop, time-out), points over risk.
 */
import { closePool, rows } from '../src/db/pool.js';
import { entrySchema } from '../src/entry/paper.js';
import { METHODS, type Regime } from '../src/entry/methods.js';

const days = Number(process.argv[2] ?? 7);
const since = Date.now() - days * 86_400_000;
await entrySchema();
type Row = { method: string; mode: string; status: string; r_net: number | null; filled: boolean; regime: Regime | null };
const xs = await rows<Row>(
  `SELECT method, mode, status, r_net, fill_price IS NOT NULL AS filled, regime FROM entry_setups WHERE first_seen >= $1`, [since],
);
const R = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`;
type Line = { label: string; set: number; filled: number; n: number; won: number; mean: number; pf: number | null; t: number };
const lineOf = (label: string, ys: readonly Row[]): Line => {
  const rs = ys.filter((y) => ['tp1', 'stop', 'timeout'].includes(y.status) && y.r_net !== null).map((y) => Number(y.r_net));
  const n = rs.length, mean = n ? rs.reduce((a, v) => a + v, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const gw = rs.filter((v) => v > 0).reduce((a, v) => a + v, 0), gl = -rs.filter((v) => v < 0).reduce((a, v) => a + v, 0);
  return { label, set: ys.length, filled: ys.filter((y) => y.filled).length, n, won: n ? rs.filter((v) => v > 0).length / n : 0, mean, pf: gl > 0 ? gw / gl : null, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
};
const show = (l: Line) => console.log(
  `  ${l.label.padEnd(48)} ${String(l.set).padStart(5)} ${String(l.filled).padStart(6)} ${String(l.n).padStart(6)} ${(l.n ? `${Math.round(100 * l.won)}%` : '–').padStart(5)} ${(l.n ? R(l.mean) : '–').padStart(7)} ${(l.pf === null ? '–' : l.pf.toFixed(2)).padStart(5)} ${(l.n > 1 ? l.t.toFixed(2) : '–').padStart(6)}  ${l.mean > 0 && l.t >= 2 && l.n >= 30 ? 'above the bar -- another week' : l.n < 30 ? 'too few yet' : ''}`,
);
console.log(`METHODS WEEK -- the paper log's last ${days} day(s), from ${new Date(since).toISOString().slice(0, 16)}Z (R in points, no fees)`);
console.log(`  ${'method'.padEnd(48)} ${'set'.padStart(5)} ${'filled'.padStart(6)} ${'closed'.padStart(6)} ${'won'.padStart(5)} ${'avg'.padStart(7)} ${'PF'.padStart(5)} ${'t'.padStart(6)}`);
console.log('\n== every method, by way');
for (const m of [...METHODS].sort((a, b) => a.n - b.n)) {
  for (const mode of ['single', 'mtf']) {
    const ys = xs.filter((y) => y.method === m.id && y.mode === mode);
    if (ys.length) show(lineOf(`#${m.n} ${m.name} · ${mode === 'mtf' ? 'with TF' : 'without'}`, ys));
  }
}
show(lineOf('all methods', xs));
console.log('\n== every closed trade, by the regime it was taken in');
const bands: [keyof Regime, string, [number, number][]][] = [
  ['efficiency', 'efficiency (#126)', [[0, 0.3], [0.3, 0.6], [0.6, 1.01]]],
  ['volZ', 'volatility z (#118)', [[-9, -1], [-1, 1], [1, 99]]],
  ['dayRange', "day's range used (#19)", [[0, 0.5], [0.5, 1], [1, 99]]],
  ['autocorr', 'autocorrelation (#123)', [[-1, -0.1], [-0.1, 0.1], [0.1, 1]]],
  ['volumeZ', 'volume z (#119)', [[-9, 0], [0, 2], [2, 99]]],
  ['ethCorr', 'BTC-ETH correlation (#128)', [[-1, 0.5], [0.5, 0.8], [0.8, 1.01]]],
];
for (const [key, label, bs] of bands) {
  for (const [lo, hi] of bs) {
    const ys = xs.filter((y) => y.regime && y.regime[key] !== null && (y.regime[key] as number) >= lo && (y.regime[key] as number) < hi);
    if (ys.length) show(lineOf(`${label} ${lo} .. ${hi}`, ys));
  }
}
await closePool();
