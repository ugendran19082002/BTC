/**
 * The research track's forward evidence, read from the paper log: every
 * research candidate (and the twelve, for comparison) over the last N days,
 * per method and per way -- set up, filled, closed, won, average R, profit
 * factor, t -- against the bar the replay used. Read-only.
 *
 *   cd app/server && DATABASE_URL=... npx tsx scripts/research-week.ts [days=7]
 *
 * Read it as a week is: short. A candidate above the bar after one week is a
 * candidate for another week, not for the desk; one far below it is a strong
 * hint. Averages are R per closed trade (TP1, stop, time-out), points over risk.
 */
import { closePool, rows } from '../src/db/pool.js';
import { entrySchema } from '../src/entry/paper.js';
import { METHODS, RESEARCH } from '../src/entry/methods.js';

const days = Number(process.argv[2] ?? 7);
const since = Date.now() - days * 86_400_000;
await entrySchema();
const xs = await rows<{ method: string; mode: string; research: boolean; status: string; r_net: number | null; filled: boolean }>(
  `SELECT method, mode, research, status, r_net, fill_price IS NOT NULL AS filled FROM entry_setups WHERE first_seen >= $1`, [since],
);
const name = (id: string) => [...METHODS, ...RESEARCH].find((m) => m.id === id);
const R = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`;
type Line = { label: string; set: number; filled: number; n: number; won: number; mean: number; pf: number | null; t: number };
const lineOf = (label: string, ys: typeof xs): Line => {
  const rs = ys.filter((y) => ['tp1', 'stop', 'timeout'].includes(y.status) && y.r_net !== null).map((y) => Number(y.r_net));
  const n = rs.length, mean = n ? rs.reduce((a, v) => a + v, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const gw = rs.filter((v) => v > 0).reduce((a, v) => a + v, 0), gl = -rs.filter((v) => v < 0).reduce((a, v) => a + v, 0);
  return { label, set: ys.length, filled: ys.filter((y) => y.filled).length, n, won: n ? rs.filter((v) => v > 0).length / n : 0, mean, pf: gl > 0 ? gw / gl : null, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
};
const show = (l: Line) => console.log(
  `  ${l.label.padEnd(40)} ${String(l.set).padStart(5)} ${String(l.filled).padStart(6)} ${String(l.n).padStart(6)} ${(l.n ? `${Math.round(100 * l.won)}%` : '–').padStart(5)} ${(l.n ? R(l.mean) : '–').padStart(7)} ${(l.pf === null ? '–' : l.pf.toFixed(2)).padStart(5)} ${(l.n > 1 ? l.t.toFixed(2) : '–').padStart(6)}  ${l.mean > 0 && l.t >= 2 && l.n >= 30 ? 'above the bar -- another week' : l.n < 30 ? 'too few yet' : ''}`,
);
console.log(`RESEARCH WEEK -- the paper log's last ${days} day(s), from ${new Date(since).toISOString().slice(0, 16)}Z (R in points, no fees)`);
console.log(`  ${'method'.padEnd(40)} ${'set'.padStart(5)} ${'filled'.padStart(6)} ${'closed'.padStart(6)} ${'won'.padStart(5)} ${'avg'.padStart(7)} ${'PF'.padStart(5)} ${'t'.padStart(6)}`);
for (const [title, research] of [['the twelve (for comparison)', false], ['the research track', true]] as const) {
  console.log(`\n== ${title}`);
  const mine = xs.filter((y) => y.research === research);
  const ids = [...new Set(mine.map((y) => y.method))].sort((a, b) => (name(a)?.n ?? 999) - (name(b)?.n ?? 999));
  for (const id of ids) {
    const m = name(id);
    for (const mode of ['single', 'mtf']) {
      const ys = mine.filter((y) => y.method === id && y.mode === mode);
      if (ys.length) show(lineOf(`#${m?.n ?? '?'} ${m?.name ?? id} · ${mode === 'mtf' ? 'with TF' : 'without'}`, ys));
    }
  }
  show(lineOf(`all of ${title}`, mine));
}
await closePool();
