/**
 * The candidate entry methods (#13-#37, src/entry/candidates.ts) replayed over
 * the cached 5m history, through the same plan, gates and grading as the
 * twelve -- the evidence for which, if any, join the desk.
 *
 *   cd app/server && npx tsx scripts/methods-study.ts [from-month] [to-month]
 *   -> research/METHODS-STUDY.txt
 *
 * Declared before it was run (1 Oct 2026):
 *   - Data: Delta's BTCUSD 5m candles in cache/candles (2024-01 .. 2026-08);
 *     1H folded from them. No tape, book, OI or option history: the gates that
 *     need them are not read (they refuse nothing), as in entry-study.ts.
 *   - Each candidate read on 5m alone (`readMethod`, mode 'single'), every
 *     closed bar; a TRADE is graded once by `gradeRow` on the bars after it:
 *     a resting limit at the zone, filled within 12 bars or expired, then the
 *     stop, TP1 or 48 bars. TGT1 between 1R and 2R, else 1.5R; R in points
 *     over risk, no fee term -- the live rules.
 *   - 2024-25 and 2026 reported apart; nothing tuned on either.
 *   - THE BAR to join the desk: average R above zero in 2024-25 AND in 2026,
 *     t >= 2 over both, and at least 200 closed trades. Anything short of it
 *     is reported and left out.
 *   - #19 (range consumed: today's range so far over yesterday's) is read
 *     beside every setup and reported as a filter, not as an entry.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../src/market/delta.js';
import { CANDIDATES, prevDay } from '../src/entry/candidates.js';
import { MIN_BARS, readMethod } from '../src/entry/engine.js';
import { gradeRow, type PaperRow } from '../src/entry/paper.js';
import { trendOf } from '../src/entry/prims.js';
import type { EntryContext } from '../src/entry/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../..');
const CACHE = join(ROOT, 'cache/candles/BTCUSD-5m');
const OUT = join(ROOT, 'research/METHODS-STUDY.txt');
const [fromMonth = '2024-01', toMonth = '9999-99'] = process.argv.slice(2);
const M5 = 300;
/** Two days of 5m bars: the previous day's profile needs all of yesterday (a naked POC keeps its own memory). */
const WINDOW = 600;

const bars: Candle[] = readdirSync(CACHE).filter((f) => f.endsWith('.json')).sort()
  .flatMap((f) => JSON.parse(readFileSync(join(CACHE, f), 'utf8')) as Candle[])
  .sort((a, b) => a.time - b.time)
  .filter((b, i, xs) => i === 0 || b.time !== xs[i - 1]!.time);

function fold(src: readonly Candle[], toSec: number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null, n = 0;
  const per = toSec / M5;
  for (const b of src) {
    const t = Math.floor(b.time / toSec) * toSec;
    if (!cur || cur.time !== t) { if (cur && n === per) out.push(cur); cur = { ...b, time: t }; n = 1; }
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; n++; }
  }
  if (cur && n === per) out.push(cur);
  return out;
}
const h1 = fold(bars, 3_600), h4 = fold(bars, 14_400);
const closedAt = (xs: readonly Candle[], sec: number, now: number, n = 200) => {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid]!.time + sec <= now) lo = mid + 1; else hi = mid; }
  return xs.slice(Math.max(0, lo - n), lo);
};

type Graded = { id: string; year: number; htf: boolean; consumed: number | null; row: PaperRow };
const graded: Graded[] = [];
const seen = new Set<string>();
const month = (t: number) => new Date(t * 1000).toISOString().slice(0, 7);
const start = Math.max(WINDOW, bars.findIndex((b) => month(b.time) >= fromMonth));
const t0 = Date.now();

for (let i = start; i < bars.length - 1; i++) {
  const b = bars[i]!;
  if (month(b.time) > toMonth) break;
  const now = b.time + M5;
  // 1H back two weeks (the previous week), 4H back two months (the previous month).
  const frames = { '5m': bars.slice(i + 1 - WINDOW, i + 1), '1h': closedAt(h1, 3_600, now, 400), '4h': closedAt(h4, 14_400, now, 400) };
  const ctx: EntryContext = { now: now * 1000, frames, flow: [], walls: [], spreadPct: null, options: null, bigMove: null };
  let regime: { htf: Record<'1h' | '4h', -1 | 0 | 1>; consumed: number | null } | null = null;
  for (const c of CANDIDATES) {
    const m = { ...c, group: 'breakout', summary: '' } as unknown as Parameters<typeof readMethod>[0];
    const r = readMethod(m, 'single', '5m', ctx);
    if (r.state !== 'TRADE' || !r.plan || r.triggerTime === null || !r.dir) continue;
    const key = `${c.id}:${r.dir}:${r.triggerTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dir = r.dir === 'long' ? 1 : -1;
    if (!regime) {
      const pd = prevDay(frames['1h'], now);
      const day = frames['5m'].filter((x) => x.time >= now - (now % 86_400));
      const consumed = pd && day.length ? (Math.max(...day.map((x) => x.high)) - Math.min(...day.map((x) => x.low))) / (pd.hi - pd.lo) : null;
      regime = { htf: { '1h': frames['1h'].length >= MIN_BARS ? trendOf(frames['1h']) : 0, '4h': frames['4h'].length >= MIN_BARS ? trendOf(frames['4h']) : 0 }, consumed };
    }
    const htf = !(regime.htf['1h'] === -dir && regime.htf['4h'] === -dir) && regime.htf['1h'] !== -dir;
    let row: PaperRow = {
      dir, tf: '5m', triggerAt: r.triggerTime, firstSeen: now * 1000,
      entryLo: r.plan.entryLo, entryHi: r.plan.entryHi, stop: r.plan.stop, tp1: r.plan.tp1,
      status: 'open', filledAt: null, fillPrice: null, exitAt: null, exitPrice: null, rNet: null, gradedTo: b.time,
    };
    row = gradeRow(row, bars.slice(i + 1, i + 1 + 12 + 48 + 2));
    graded.push({ id: c.id, year: new Date(b.time * 1000).getUTCFullYear(), htf, consumed: regime.consumed, row });
  }
  if (i % 20_000 === 0) process.stderr.write(`${month(b.time)} ${graded.length} setups, ${Math.round((Date.now() - t0) / 1000)} s\n`);
}

// ------------------------------------------------------------------ report
const lines: string[] = [];
const say = (s = '') => lines.push(s);
const R = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`;
type Stat = { n: number; mean: number; t: number; win: number; pf: number | null; total: number };
function stat(xs: readonly Graded[]): Stat {
  const rs = xs.filter((g) => ['tp1', 'stop', 'timeout'].includes(g.row.status) && g.row.rNet !== null).map((g) => g.row.rNet!);
  const n = rs.length, mean = n ? rs.reduce((a, v) => a + v, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const gw = rs.filter((v) => v > 0).reduce((a, v) => a + v, 0), gl = -rs.filter((v) => v < 0).reduce((a, v) => a + v, 0);
  return { n, mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, win: n ? rs.filter((v) => v > 0).length / n : 0, pf: gl > 0 ? gw / gl : null, total: mean * n };
}
const cell = (s: Stat) => (s.n ? `${String(s.n).padStart(5)} ${`${Math.round(100 * s.win)}%`.padStart(4)} ${R(s.mean).padStart(7)} ${(s.pf ?? 0).toFixed(2).padStart(5)} ${s.t.toFixed(2).padStart(6)}` : '–'.padStart(5).padEnd(31));
const passes = (a: Stat, b: Stat, all: Stat) => a.mean > 0 && b.mean > 0 && all.t >= 2 && all.n >= 200;

say('METHODS STUDY -- candidate entry methods #13-#37 replayed on cached 5m history, graded like the paper log (R in points, no fees)');
say(`generated by app/server/scripts/methods-study.ts on ${new Date().toISOString().slice(0, 10)}; ${bars.length} 5m bars, from ${fromMonth}`);
say('the bar to join the desk: avg R > 0 in 2024-25 AND in 2026, t >= 2 over both, >= 200 closed trades');
for (const [title, keep] of [['all setups', (_g: Graded) => true], ['higher timeframes not against (1H, or 1H and 4H)', (g: Graded) => g.htf]] as const) {
  say();
  say(`== ${title}`);
  say(`  ${'method'.padEnd(34)} ${'2024-25: n  won    avg    PF      t'.padEnd(36)}   ${'2026: n  won    avg    PF      t'.padEnd(36)}   verdict`);
  for (const c of CANDIDATES) {
    const xs = graded.filter((g) => g.id === c.id && keep(g));
    const a = stat(xs.filter((g) => g.year <= 2025)), b = stat(xs.filter((g) => g.year === 2026)), all = stat(xs);
    say(`  ${`${c.n} ${c.name}`.padEnd(34)} ${cell(a)}   ${cell(b)}   ${passes(a, b, all) ? 'PASSES' : all.n < 200 ? 'too few' : 'no edge'}`);
  }
}
say();
say('== #19 range consumed (today\'s range so far / yesterday\'s), all candidates together');
for (const [label, lo, hi] of [['0-25%', 0, 0.25], ['25-50%', 0.25, 0.5], ['50-75%', 0.5, 0.75], ['75-100%', 0.75, 1], ['>100%', 1, Infinity]] as const) {
  say(`  ${label.padEnd(9)} ${cell(stat(graded.filter((g) => g.consumed !== null && g.consumed >= lo && g.consumed < hi)))}`);
}
say();
say('Read: avg is R per closed trade (TP1, stop or time-out), points over risk; t is avg over its standard error (|t| < 2: not');
say('distinguishable from zero). The bar was set before the run; a method that misses it is not on the desk.');
writeFileSync(OUT, `${lines.join('\n')}\n`);
process.stdout.write(`${lines.join('\n')}\n`);
