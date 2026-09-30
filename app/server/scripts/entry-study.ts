/**
 * The entry section's twelve methods replayed over the cached 5m history,
 * graded the way the paper log grades them, after taker fees.
 *
 *   cd app/server && npx tsx scripts/entry-study.ts [from-month] [to-month]
 *   -> research/ENTRY-STUDY.txt
 *
 * Declared before it was run (30 Sep 2026):
 *   - Data: Delta's BTCUSD 5m candles in cache/candles (2024-01 .. 2026-08).
 *     1H and 4H are folded from them; 1m, 3m, the tape, the book and the
 *     option board were not recorded over this history.
 *   - "Without timeframe": each method read on 5m alone, exactly as the live
 *     engine reads it (`readMethod`, mode 'single'), every closed bar.
 *   - "With the HTF chain": the same TRADEs kept only when 4H, 1H, 30m and 15m
 *     are not against them and 1H and 4H are not both against (the live
 *     chain's higher half; its 3m and 1m steps need data this history lacks).
 *   - Each TRADE graded once by `gradeRow` on the 5m bars that follow it: a
 *     resting limit at the zone, filled within 12 bars or expired, then the
 *     stop, TP1 or 48 bars; a bar touching the stop and TP1 is the stop.
 *   - Methods 11 (order flow) and 12 (options) need the tape and the option
 *     board: they cannot be replayed from candles and are reported as such.
 *   - 2024-25 and 2026 are reported apart; nothing is tuned on either.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../src/market/delta.js';
import { METHODS } from '../src/entry/methods.js';
import { MIN_BARS, readMethod } from '../src/entry/engine.js';
import { gradeRow, type PaperRow } from '../src/entry/paper.js';
import { trendOf } from '../src/entry/prims.js';
import type { EntryContext, Tf } from '../src/entry/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../..');
const CACHE = join(ROOT, 'cache/candles/BTCUSD-5m');
const OUT = join(ROOT, 'research/ENTRY-STUDY.txt');
const [fromMonth = '2024-01', toMonth = '9999-99'] = process.argv.slice(2);

const M5 = 300;
const WINDOW = 300;

const bars: Candle[] = readdirSync(CACHE).filter((f) => f.endsWith('.json')).sort()
  .flatMap((f) => JSON.parse(readFileSync(join(CACHE, f), 'utf8')) as Candle[])
  .sort((a, b) => a.time - b.time)
  .filter((b, i, xs) => i === 0 || b.time !== xs[i - 1]!.time);

/** Whole buckets only, stamped at their open, each known once its last 5m bar has closed. */
function fold(src: readonly Candle[], toSec: number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let n = 0;
  const per = toSec / M5;
  for (const b of src) {
    const t = Math.floor(b.time / toSec) * toSec;
    if (!cur || cur.time !== t) {
      if (cur && n === per) out.push(cur);
      cur = { ...b, time: t };
      n = 1;
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
      n++;
    }
  }
  if (cur && n === per) out.push(cur);
  return out;
}
const higher: Record<'15m' | '30m' | '1h' | '4h', { sec: number; bars: Candle[] }> = {
  '15m': { sec: 900, bars: fold(bars, 900) },
  '30m': { sec: 1_800, bars: fold(bars, 1_800) },
  '1h': { sec: 3_600, bars: fold(bars, 3_600) },
  '4h': { sec: 14_400, bars: fold(bars, 14_400) },
};
/** The closed higher-timeframe bars as of `now` (epoch s): the newest `n`. */
function closedAt(tf: keyof typeof higher, now: number, n = 200): Candle[] {
  const { sec, bars: xs } = higher[tf];
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid]!.time + sec <= now) lo = mid + 1; else hi = mid; }
  return xs.slice(Math.max(0, lo - n), lo);
}

type Graded = { method: string; year: number; htf: boolean; row: PaperRow };
const graded: Graded[] = [];
const seen = new Set<string>();
const month = (t: number) => new Date(t * 1000).toISOString().slice(0, 7);
const start = Math.max(WINDOW, bars.findIndex((b) => month(b.time) >= fromMonth));
const t0 = Date.now();

for (let i = start; i < bars.length - 1; i++) {
  const b = bars[i]!;
  if (month(b.time) > toMonth) break;
  const now = b.time + M5;
  const frames = {
    '5m': bars.slice(i + 1 - WINDOW, i + 1),
    '15m': closedAt('15m', now), '30m': closedAt('30m', now), '1h': closedAt('1h', now), '4h': closedAt('4h', now),
  };
  const ctx: EntryContext = { now: now * 1000, frames, flow: [], walls: [], spreadPct: null, options: null, bigMove: null };
  let htfTrend: Partial<Record<Tf, -1 | 0 | 1>> | null = null;
  for (const m of METHODS) {
    if (m.id === 'order-flow' || m.id === 'options-flow') continue;
    const r = readMethod(m, 'single', '5m', ctx);
    if (r.state !== 'TRADE' || !r.plan || r.triggerTime === null || !r.dir) continue;
    const key = `${m.id}:${r.dir}:${r.triggerTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dir = r.dir === 'long' ? 1 : -1;
    htfTrend ??= Object.fromEntries((['4h', '1h', '30m', '15m'] as const).map((tf) => [tf, frames[tf].length >= MIN_BARS ? trendOf(frames[tf]) : 0]));
    const against = (tf: Tf) => htfTrend![tf] === -dir;
    const htf = !(['4h', '1h', '30m', '15m'] as const).some(against) && !(against('1h') && against('4h'));
    let row: PaperRow = {
      dir, tf: '5m', triggerAt: r.triggerTime, firstSeen: now * 1000,
      entryLo: r.plan.entryLo, entryHi: r.plan.entryHi, stop: r.plan.stop, tp1: r.plan.tp1,
      status: 'open', filledAt: null, fillPrice: null, exitAt: null, exitPrice: null, rNet: null, gradedTo: b.time,
    };
    row = gradeRow(row, bars.slice(i + 1, i + 1 + 12 + 48 + 2));
    graded.push({ method: m.id, year: new Date(b.time * 1000).getUTCFullYear(), htf, row });
  }
  if (i % 20_000 === 0) process.stderr.write(`${month(b.time)} ${graded.length} setups, ${Math.round((Date.now() - t0) / 1000)} s\n`);
}

// ------------------------------------------------------------------ report
const lines: string[] = [];
const say = (s = '') => lines.push(s);
const R = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`;
function row(label: string, xs: Graded[]) {
  const closed = xs.filter((g) => g.row.rNet !== null && g.row.status !== 'expired' && g.row.status !== 'open' && g.row.status !== 'filled');
  const rs = closed.map((g) => g.row.rNet!);
  const n = rs.length;
  const mean = n ? rs.reduce((a, v) => a + v, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  const wins = rs.filter((v) => v > 0).length;
  const gw = rs.filter((v) => v > 0).reduce((a, v) => a + v, 0);
  const gl = -rs.filter((v) => v < 0).reduce((a, v) => a + v, 0);
  const expired = xs.filter((g) => g.row.status === 'expired').length;
  say(`  ${label.padEnd(22)} ${String(xs.length).padStart(6)} ${String(expired).padStart(7)} ${String(n).padStart(6)}  ${n ? `${Math.round((100 * wins) / n)}%`.padStart(4) : '   –'}  ${n ? R(mean).padStart(7) : '      –'}  ${n ? R(mean * n).padStart(9) : '        –'}  ${gl > 0 ? (gw / gl).toFixed(2).padStart(5) : '    –'}  ${n > 1 ? t.toFixed(2).padStart(6) : '     –'}`);
}
say(`ENTRY STUDY -- the entry section's methods replayed on cached 5m history, graded like the paper log, after fees`);
say(`generated by app/server/scripts/entry-study.ts on ${new Date().toISOString().slice(0, 10)}; ${bars.length} 5m bars ${month(bars[0]!.time)}..${month(bars[bars.length - 1]!.time)}, from ${fromMonth}`);
say(`methods 11 (order flow) and 12 (options) need the tape and the option board: not replayable from candles.`);
for (const [title, pick] of [['Without timeframe (5m alone)', (_g: Graded) => true], ['With the HTF chain (4H/1H/30m/15m not against)', (g: Graded) => g.htf]] as const) {
  for (const [period, inP] of [['2024-25', (g: Graded) => g.year < 2026], ['2026', (g: Graded) => g.year >= 2026]] as const) {
    say();
    say(`== ${title} -- ${period}`);
    say(`  ${'method'.padEnd(22)} ${'TRADEs'.padStart(6)} ${'expired'.padStart(7)} ${'closed'.padStart(6)}  ${'win'.padStart(4)}  ${'avg'.padStart(7)}  ${'total'.padStart(9)}  ${'PF'.padStart(5)}  ${'t'.padStart(6)}`);
    for (const m of METHODS) {
      if (m.id === 'order-flow' || m.id === 'options-flow') continue;
      row(`${m.n} ${m.name}`, graded.filter((g) => g.method === m.id && pick(g) && inP(g)));
    }
    row('all ten', graded.filter((g) => pick(g) && inP(g)));
  }
}
say();
say('Read: avg is R per closed trade after Delta\'s 0.05% taker fee both ways; t is avg over its standard error (|t| < 2: not');
say('distinguishable from zero). A method is not believed on this table: it is the history the live paper log is then held to.');
writeFileSync(OUT, lines.join('\n') + '\n');
process.stdout.write(lines.join('\n') + '\n');
