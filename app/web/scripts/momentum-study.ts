/**
 * Entry, stop and exit for catching big moves -- on the cached Delta BTCUSD
 * history, declared before it ran.
 *
 * Part X: the desk's own SMC entries (DESK_SMC_OPTIONS on 5m, as the desk runs
 * them), the same entries and initial stops, exited differently -- is it the
 * exits that give the moves back?
 *
 *   X0  as the desk exits: 30 / 30 / 40 at >= 2R / 3R / 4R, break-even and
 *       trailing by structure (the engine's own result)
 *   X1  all out at 2R, or the stop
 *   X2  no target: a chandelier stop, 3 ATR(14) under the highest high since
 *       entry (over the lowest low for a short), never loosened
 *   X3  the initial stop until 1R, then break-even, then the chandelier as X2
 *
 * Part E: entries built for momentum, one position at a time, a 2 ATR(14)
 * initial stop, then the same 3 ATR chandelier and no target:
 *
 *   E1  a close beyond the 20-candle high / low, 1H candles
 *   E2  the same, 4H
 *   E3  the same, 15m
 *   E4  E1 only out of a squeeze: Bollinger width (20, 2 sd) in the lowest
 *       quarter of its last 120 candles at the breakout
 *   E5  E1 only with the trend: longs over the 200-candle EMA, shorts under
 *
 * Every exit at the stop price (at the open when it gapped through), checked
 * against the stop known at the previous close -- nothing sees its own candle.
 * X exits held at most 2 days; E exits only by the stop. Fees 0.05% a side in R.
 * Big-move capture: of the hours after which BTC moved 2% or more within four
 * hours, the share the system was positioned for, in that direction.
 *
 * Chosen on 2024-25 (best net R a trade, 50 trades or more), judged once on
 * 2026. An edge needs net R > 0 on both, with t >= 2 on 2026.
 *
 *   cd app/web && ../server/node_modules/.bin/tsx scripts/momentum-study.ts
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bar, Setup } from '../src/lib/smc/types';
import { DESK_SMC_OPTIONS, runSmc, SmcEngine } from '../src/lib/smc/engine';
import { aggregate, trendTimeline } from '../src/lib/smc/context';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../..');
const OUT = join(ROOT, 'research/MOMENTUM-STUDY.txt');
const FEE = 0.0005;
const M5 = 300;
const H = 3600;

const cache = join(ROOT, 'cache/candles/BTCUSD-5m');
const bars: Bar[] = readdirSync(cache).filter((f) => f.endsWith('.json')).sort()
  .flatMap((f) => JSON.parse(readFileSync(join(cache, f), 'utf8')) as Bar[])
  .sort((a, b) => a.time - b.time).filter((b, i, a) => i === 0 || b.time !== a[i - 1]!.time);

/** Wilder's ATR(14) as known at each close. */
function atrOf(xs: readonly Bar[]): number[] {
  const out: number[] = [];
  let atr = 0;
  xs.forEach((b, i) => {
    const tr = i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - xs[i - 1]!.close), Math.abs(b.low - xs[i - 1]!.close));
    atr = i < 14 ? (atr * i + tr) / (i + 1) : (atr * 13 + tr) / 14;
    out.push(atr);
  });
  return out;
}

type Trade = { t: number; dir: 1 | -1; entry: number; exit: number; risk: number; from: number; to: number };
const grossR = (x: Trade) => (x.dir * (x.exit - x.entry)) / x.risk;
const netR = (x: Trade) => grossR(x) - ((x.entry + x.exit) * FEE) / x.risk;

/**
 * Walk a position from candle `i` (entered at its close) until the stop: the
 * chandelier (k ATR from the best price since entry) once `trailFrom` R has
 * been reached, break-even first when `beAt` is set; a target in R when given.
 */
function walk(xs: readonly Bar[], atr: readonly number[], i: number, dir: 1 | -1, entry: number, stop0: number,
  o: { k?: number; trailFrom?: number; beAt?: number; target?: number; maxBars?: number }): { exit: number; to: number } {
  const risk = Math.abs(entry - stop0);
  let stop = stop0;
  let best = entry;
  let trailing = o.trailFrom === 0;
  for (let j = i + 1; j < xs.length; j++) {
    const b = xs[j]!;
    // The stop known at the previous close; a gap through it fills at the open.
    if (dir === 1 ? b.low <= stop : b.high >= stop) return { exit: dir === 1 ? Math.min(stop, b.open) : Math.max(stop, b.open), to: j };
    if (o.target !== undefined) {
      const tgt = entry + dir * o.target * risk;
      if (dir === 1 ? b.high >= tgt : b.low <= tgt) return { exit: tgt, to: j };
    }
    if (o.maxBars !== undefined && j - i >= o.maxBars) return { exit: b.close, to: j };
    // After the close: the best price, then the stop -- only ever tighter.
    best = dir === 1 ? Math.max(best, b.high) : Math.min(best, b.low);
    const inR = (dir * (best - entry)) / risk;
    if (o.beAt !== undefined && inR >= o.beAt) stop = dir === 1 ? Math.max(stop, entry) : Math.min(stop, entry);
    if (o.k !== undefined && (trailing || (o.trailFrom !== undefined && inR >= o.trailFrom))) {
      trailing = true;
      const ch = best - dir * o.k * atr[j]!;
      stop = dir === 1 ? Math.max(stop, ch) : Math.min(stop, ch);
    }
  }
  return { exit: xs[xs.length - 1]!.close, to: xs.length - 1 };
}

// ---------------------------------------------------------------- reporting

const lines: string[] = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const yearOf = (t: number) => new Date(t * 1000).getUTCFullYear();
type Row = { n: number; win: number; gross: number; net: number; t: number; total: number; dd: number };
function rowOf(ts: Trade[]): Row {
  const n = ts.length;
  if (!n) return { n: 0, win: 0, gross: 0, net: 0, t: 0, total: 0, dd: 0 };
  const nets = ts.map(netR);
  const net = nets.reduce((a, x) => a + x, 0) / n;
  const sd = Math.sqrt(nets.reduce((a, x) => a + (x - net) ** 2, 0) / Math.max(1, n - 1));
  let eq = 0; let peak = 0; let dd = 0;
  for (const x of nets) { eq += x; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  return { n, win: nets.filter((x) => x > 0).length / n, gross: ts.reduce((a, x) => a + grossR(x), 0) / n, net, t: sd > 0 ? net / (sd / Math.sqrt(n)) : 0, total: eq, dd };
}
const R = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}R`;
const fmt = (r: Row) => `n ${String(r.n).padStart(5)}  win ${(r.win * 100).toFixed(0).padStart(3)}%  gross ${R(r.gross)}  net ${R(r.net)} (t ${r.t.toFixed(2).padStart(5)})  total ${r.total.toFixed(0).padStart(5)}R  worst run ${r.dd.toFixed(0)}R`;

// Big moves: hours after which BTC moved 2% or more within four hours, in that direction.
const hours = aggregate(bars, M5, H);
const bigMoves: { t: number; dir: 1 | -1 }[] = [];
for (let i = 0; i + 4 < hours.length; i++) {
  const r = (hours[i + 4]!.close - hours[i]!.close) / hours[i]!.close;
  if (Math.abs(r) >= 0.02) bigMoves.push({ t: hours[i]!.time + H, dir: r > 0 ? 1 : -1 });
}
function capture(ts: Trade[], tfSec: number): [number, number] {
  const periods = [bigMoves.filter((m) => yearOf(m.t) < 2026), bigMoves.filter((m) => yearOf(m.t) >= 2026)];
  const open = ts.map((x) => ({ from: x.t, to: x.t + (x.to - x.from) * tfSec, dir: x.dir }));
  return periods.map((ms) => ms.filter((m) => open.some((o) => o.dir === m.dir && o.from <= m.t && o.to > m.t)).length / Math.max(1, ms.length)) as [number, number];
}

type Result = { name: string; ins: Row; oos: Row; cap: [number, number] };
const results: Result[] = [];
function record(name: string, ts: Trade[], tfSec: number) {
  const ins = rowOf(ts.filter((x) => yearOf(x.t) < 2026));
  const oos = rowOf(ts.filter((x) => yearOf(x.t) >= 2026));
  const cap = capture(ts, tfSec);
  results.push({ name, ins, oos, cap });
  say(`== ${name}`);
  say(`   2024-25  ${fmt(ins)}`);
  say(`   2026     ${fmt(oos)}`);
  say(`   big moves (2% in 4h) positioned for: ${(cap[0] * 100).toFixed(0)}% / ${(cap[1] * 100).toFixed(0)}%   (${bigMoves.filter((m) => yearOf(m.t) < 2026).length} / ${bigMoves.filter((m) => yearOf(m.t) >= 2026).length} such hours)`);
}

say(`Entries, stops and exits for big moves -- BTCUSD, ${new Date(bars[0]!.time * 1000).toISOString().slice(0, 10)} to ${new Date(bars[bars.length - 1]!.time * 1000).toISOString().slice(0, 10)}, fees ${FEE * 100}% a side`);
say('Declared before running: see the header of app/web/scripts/momentum-study.ts.');
say();

// ---------------------------------------------------------------- X: the desk's entries, other exits

{
  const htfTrendAt = trendTimeline(runSmc(hours, { tfSec: H }), hours, H);
  const engine = new SmcEngine({ tfSec: M5, htfTrendAt, ...DESK_SMC_OPTIONS });
  for (const b of bars) engine.push(b);
  const fills = engine.state().setups.filter((s: Setup) => s.fill && s.stop !== null && s.resultR !== null);
  const atr5 = atrOf(bars);
  const x0: Trade[] = [];
  const x1: Trade[] = [];
  const x2: Trade[] = [];
  const x3: Trade[] = [];
  for (const s of fills) {
    const i = s.fill!.at;
    const dir: 1 | -1 = s.dir === 'bull' ? 1 : -1;
    const entry = s.fill!.price;
    const stop = s.stop!;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;
    const t = bars[i]!.time;
    const closeIdx = s.closedAt ?? i + 1;
    x0.push({ t, dir, entry, risk, exit: entry + dir * s.resultR! * risk, from: i, to: closeIdx });
    const mk = (w: { exit: number; to: number }): Trade => ({ t, dir, entry, risk, exit: w.exit, from: i, to: w.to });
    x1.push(mk(walk(bars, atr5, i, dir, entry, stop, { target: 2, maxBars: 576 })));
    x2.push(mk(walk(bars, atr5, i, dir, entry, stop, { k: 3, trailFrom: 0, maxBars: 576 })));
    x3.push(mk(walk(bars, atr5, i, dir, entry, stop, { k: 3, trailFrom: 1, beAt: 1, maxBars: 576 })));
  }
  say(`Part X -- the desk's ${x0.length} SMC entries on 5m, exited four ways`);
  record('X0 as the desk exits (>= 2R / 3R / 4R ladder, structure trail)', x0, M5);
  record('X1 all out at 2R', x1, M5);
  record('X2 no target, chandelier 3 ATR from entry', x2, M5);
  record('X3 break-even at 1R, then chandelier 3 ATR', x3, M5);
  say();
}

// ---------------------------------------------------------------- E: momentum entries

function breakout(tfSec: number, name: string, filter?: (xs: readonly Bar[], i: number, dir: 1 | -1) => boolean) {
  const xs = tfSec === M5 ? bars : aggregate(bars, M5, tfSec);
  const atr = atrOf(xs);
  const trades: Trade[] = [];
  let i = 20;
  while (i < xs.length - 1) {
    const b = xs[i]!;
    const prev = xs.slice(i - 20, i);
    const hi = Math.max(...prev.map((x) => x.high));
    const lo = Math.min(...prev.map((x) => x.low));
    const dir: 1 | -1 | 0 = b.close > hi ? 1 : b.close < lo ? -1 : 0;
    if (dir === 0 || (filter && !filter(xs, i, dir))) { i++; continue; }
    const entry = b.close;
    const stop = entry - dir * 2 * atr[i]!;
    const w = walk(xs, atr, i, dir, entry, stop, { k: 3, trailFrom: 0 });
    trades.push({ t: b.time, dir, entry, risk: Math.abs(entry - stop), exit: w.exit, from: i, to: w.to });
    i = w.to + 1; // one position at a time
  }
  record(name, trades, tfSec);
}

say('Part E -- momentum entries: 20-candle breakout, 2 ATR stop, 3 ATR chandelier, no target');
breakout(H, 'E1 breakout, 1H');
breakout(4 * H, 'E2 breakout, 4H');
breakout(900, 'E3 breakout, 15m');
breakout(H, 'E4 breakout out of a squeeze, 1H', (xs, i) => {
  if (i < 140) return false;
  const width = (k: number) => {
    const w = xs.slice(k - 19, k + 1).map((x) => x.close);
    const m = w.reduce((a, x) => a + x, 0) / 20;
    const sd = Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / 20);
    return (4 * sd) / m;
  };
  const past = Array.from({ length: 120 }, (_, j) => width(i - 1 - j)).sort((a, b) => a - b);
  return width(i - 1) <= past[29]!;
});
{
  const hs = aggregate(bars, M5, H);
  const ema: number[] = [];
  hs.forEach((b, i) => ema.push(i === 0 ? b.close : ema[i - 1]! + (2 / 201) * (b.close - ema[i - 1]!)));
  breakout(H, 'E5 breakout with the 200 EMA trend, 1H', (xs, i, dir) => i >= 200 && (dir === 1 ? xs[i]!.close > ema[i]! : xs[i]!.close < ema[i]!));
}

// ---------------------------------------------------------------- verdict

say();
const eligible = results.filter((r) => r.ins.n >= 50).sort((a, b) => b.ins.net - a.ins.net);
const pick = eligible[0];
if (pick) {
  say(`Chosen on 2024-25: ${pick.name} -- net ${R(pick.ins.net)} a trade over ${pick.ins.n}.`);
  say(`Judged once on 2026: net ${R(pick.oos.net)} a trade over ${pick.oos.n} (t ${pick.oos.t.toFixed(2)}); big moves positioned for ${(pick.cap[1] * 100).toFixed(0)}%.`);
  say(pick.ins.net > 0 && pick.oos.net > 0 && pick.oos.t >= 2 ? 'An edge by the declared rule.' : 'Not an edge by the declared rule (net R > 0 on both, t >= 2 on 2026).');
}
writeFileSync(OUT, lines.join('\n') + '\n');
