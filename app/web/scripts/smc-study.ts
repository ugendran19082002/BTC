/**
 * The chart engine (src/lib/smc) replayed over every cached 5-minute BTCUSD
 * candle, one at a time -- the same code the chart runs, on real history.
 *
 *   app/server/node_modules/.bin/tsx app/web/scripts/smc-study.ts
 *
 * Writes research/SMC-STUDY.txt: the funnel (how setups end), the trades by
 * year before and after fees, and every big move -- did a trade catch it, and
 * if not, which rule stopped one. Nothing is fitted here; the engine's rules
 * are fixed, so every year is out of sample.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESK_SMC_OPTIONS, runSmc, SCALE_OUT, SmcEngine, sessionOf } from '../src/lib/smc/engine';
import { aggregate, trendTimeline } from '../src/lib/smc/context';
import type { Bar, Setup, SmcOptions } from '../src/lib/smc/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '../../../cache/candles/BTCUSD-5m');
const OUT = join(HERE, '../../../research/SMC-STUDY.txt');
/** Taker fee a side on Delta's BTC perpetual; a round trip is twice this. */
const FEE = 0.0005;
/** Maker fee a side: a resting take-profit limit order. Stops, time exits and market entries pay the taker fee. */
const MAKER = 0.0002;
/** A big move: at least this far, close to close, inside an hour. */
const BIG_PCT = 1.0;
const HOUR_BARS = 12;

const bars: Bar[] = readdirSync(CACHE).filter((f) => f.endsWith('.json')).sort()
  .flatMap((f) => JSON.parse(readFileSync(join(CACHE, f), 'utf8')) as Bar[])
  .sort((a, b) => a.time - b.time)
  .filter((b, i, xs) => i === 0 || b.time > xs[i - 1]!.time);

const lines: string[] = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const year = (i: number) => new Date(bars[i]!.time * 1000).getUTCFullYear();
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
const f2 = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);

// ── variants: declared before any was run, chosen on 2024-25, judged once on 2026 ──
type Variant = { name: string; opts: Omit<SmcOptions, 'tfSec'>; tfSec?: 300 | 900 | 3600; fees?: FeeModel };
const VARIANTS: Variant[] = [
  { name: 'A  as built: zone stop, close entry', opts: {} },
  { name: 'B  stop beyond the sweep too', opts: { stopAt: 'sweep' } },
  { name: 'C  zone stop, floor 1.0 ATR', opts: { minStopAtr: 1.0 } },
  { name: 'D  zone stop, floor 1.5 ATR', opts: { minStopAtr: 1.5 } },
  { name: 'E  limit entry at the zone', opts: { entry: 'limit' } },
  { name: 'F  limit entry, floor 1.0 ATR', opts: { entry: 'limit', minStopAtr: 1.0 } },
  { name: 'G  + continuation', opts: { continuation: true } },
  { name: 'H  + continuation, floor 1.0 ATR', opts: { continuation: true, minStopAtr: 1.0 } },
  { name: 'I  + continuation, floor 1.5 ATR', opts: { continuation: true, minStopAtr: 1.5 } },
  // Added after the 28 Sep trace: the day's rally was refused for a TP1 of 0.9R.
  { name: 'J  I, no TP1 minimum', opts: { continuation: true, minStopAtr: 1.5, minTp1R: 0 } },
  { name: 'K  I, TP1 = first liquidity over 1.5R', opts: { continuation: true, minStopAtr: 1.5, tp1: 'first-over-min' } },
  // Added after the same trace: the rally never came back to its zone. Enter on the break instead.
  { name: 'L  J, entered at the break (no retest)', opts: { continuation: true, minStopAtr: 1.5, minTp1R: 0, entry: 'break' } },
  // Added on the owner's reference: retest by default, the break only with a displacement candle and the 1H agreeing.
  { name: 'M  J, hybrid: retest, or break if strong+1H', opts: { continuation: true, minStopAtr: 1.5, minTp1R: 0, entry: 'hybrid' } },
  // Round three, declared together before running: fees as they are charged, a higher timeframe, the sessions.
  { name: 'N  L, TP exits at the maker fee', opts: { continuation: true, minStopAtr: 1.5, minTp1R: 0, entry: 'break' }, fees: 'maker-tp' },
  { name: 'O  L on 15m candles', opts: { continuation: true, minStopAtr: 1.5, minTp1R: 0, entry: 'break' }, tfSec: 900 },
  { name: 'P  L on 1H candles', opts: { continuation: true, minStopAtr: 1.5, minTp1R: 0, entry: 'break' }, tfSec: 3600 },
  { name: 'Q  L, London + New York only', opts: { continuation: true, minStopAtr: 1.5, minTp1R: 0, entry: 'break', sessions: ['London', 'New York'] } },
  { name: 'R  O with maker TPs (15m)', opts: { continuation: true, minStopAtr: 1.5, minTp1R: 0, entry: 'break' }, tfSec: 900, fees: 'maker-tp' },
  // Round four, the stop and target frameworks, declared together on the desk's 5m break entry (L):
  { name: 'S  L, targets >= 2R / 3R / 4R at liquidity', opts: { continuation: true, minStopAtr: 1.5, minTp1R: 0, entry: 'break', targetMode: 'r-min', targetR: [2, 3, 4] } },
  { name: 'T  L, targets exactly 2R / 3R / 4R', opts: { continuation: true, minStopAtr: 1.5, minTp1R: 0, entry: 'break', targetMode: 'r-multiple', targetR: [2, 3, 4] } },
  { name: 'U  L, targets >= 1R / 2R / 3R at liquidity', opts: { continuation: true, minStopAtr: 1.5, minTp1R: 0, entry: 'break', targetMode: 'r-min', targetR: [1, 2, 3] } },
  { name: 'V  L, stop at the swing', opts: { continuation: true, minStopAtr: 1.5, minTp1R: 0, entry: 'break', stopAt: 'swing' } },
  { name: 'W  V, targets >= 1R / 2R / 3R', opts: { continuation: true, minStopAtr: 1.5, minTp1R: 0, entry: 'break', stopAt: 'swing', targetMode: 'r-min', targetR: [1, 2, 3] } },
  { name: 'X  V, targets >= 2R / 3R / 4R', opts: { continuation: true, minStopAtr: 1.5, minTp1R: 0, entry: 'break', stopAt: 'swing', targetMode: 'r-min', targetR: [2, 3, 4] } },
  // Round five, the owner's P0 list, on the desk (X with the owner's 1 ATR floor), declared together:
  { name: 'Y  desk, fee <= 0.2R (risk >= 0.5%)', opts: { ...DESK_SMC_OPTIONS, minRiskPct: 0.005 } },
  { name: 'Z  desk, fee <= 0.1R (risk >= 1%)', opts: { ...DESK_SMC_OPTIONS, minRiskPct: 0.01 } },
  { name: 'NC desk, no chase past 1 ATR', opts: { ...DESK_SMC_OPTIONS, maxChaseAtr: 1 } },
  { name: 'YN desk, Y + no chase', opts: { ...DESK_SMC_OPTIONS, minRiskPct: 0.005, maxChaseAtr: 1 } },
];
// The 1H trend as it was known at each moment, from closed 1H candles only -- for the hybrid entry.
const hours = aggregate(bars, 300, 3600);
const htfTrendAt = trendTimeline(runSmc(hours, { tfSec: 3600 }), hours, 3600);
type FeeModel = 'taker' | 'maker-tp';
/** Fees in R: taker both ways, or ('maker-tp') a taker entry, maker on the thirds taken at the targets and taker on the rest. */
const feeRof = (s: Setup, model: FeeModel) => {
  if (model === 'taker') return (2 * FEE * s.fill!.price) / s.fill!.risk;
  const hits = s.events.filter((e) => e.state === 'TP1' || e.state === 'TP2' || e.state === 'TP3').length;
  const atTargets = SCALE_OUT.slice(0, hits).reduce((a, b) => a + b, 0);
  return ((FEE + atTargets * MAKER + (1 - atTargets) * FEE) * s.fill!.price) / s.fill!.risk;
};
const netOf = (xs: Setup[], model: FeeModel = 'taker') => xs.reduce((a, s) => a + s.resultR! - feeRof(s, model), 0);
say('== Variants (net of fees; per trade and total; 2024-25 chooses, 2026 judges)');
const byTf = new Map<number, Bar[]>([[300, bars], [900, aggregate(bars, 300, 900)], [3600, hours]]);
const runs = VARIANTS.map((v) => {
  const tf = v.tfSec ?? 300;
  const src = byTf.get(tf)!;
  const e = new SmcEngine({ tfSec: tf, htfTrendAt: tf < 3600 ? htfTrendAt : undefined, ...v.opts });
  for (const b of src) e.push(b);
  const yr = (i: number) => new Date(src[i]!.time * 1000).getUTCFullYear();
  const done = e.state().setups.filter((x) => x.fill && x.resultR !== null);
  const ins = done.filter((x) => yr(x.fill!.at) < 2026);
  const oos = done.filter((x) => yr(x.fill!.at) >= 2026);
  const per = (xs: Setup[]) => (xs.length ? netOf(xs, v.fees) / xs.length : 0);
  const win = (xs: Setup[]) => pct(xs.filter((x) => x.resultR! > 0).length, xs.length);
  const gross = (xs: Setup[]) => (xs.length ? xs.reduce((a, x) => a + x.resultR!, 0) / xs.length : 0);
  say(`   ${v.name.padEnd(38)} 24-25: n ${String(ins.length).padStart(4)} win ${win(ins).padStart(6)} gross ${f2(gross(ins))} net ${f2(per(ins))}R/trade   2026: n ${String(oos.length).padStart(4)} win ${win(oos).padStart(6)} gross ${f2(gross(oos))} net ${f2(per(oos))}R/trade`);
  return { v, ins: per(ins), n: ins.length };
});
const best = runs.filter((r) => r.n >= 100).sort((a, b) => b.ins - a.ins)[0]!;
say(`   chosen on 2024-25 alone: ${best.v.name.trim()} -- its 2026 row is the honest test`);
say(`   the desk runs: ${JSON.stringify(DESK_SMC_OPTIONS)}`);
say();

const t0 = Date.now();
const engine = new SmcEngine({ tfSec: 300, htfTrendAt, ...DESK_SMC_OPTIONS });
for (const b of bars) engine.push(b);
const st = engine.state();
say(`== Detail for the desk's options: ${JSON.stringify(DESK_SMC_OPTIONS)}`);
say(`SMC engine replay · ${bars.length.toLocaleString()} 5m candles · ${new Date(bars[0]!.time * 1000).toISOString().slice(0, 10)} → ${new Date(bars[bars.length - 1]!.time * 1000).toISOString().slice(0, 10)} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
say(`fees: ${FEE * 100}% a side (taker), charged in R on the whole position`);
say();

// ── funnel ──────────────────────────────────────────────────────────────
const setups = st.setups;
const planned = setups.filter((s) => s.entry !== null);
const filled = setups.filter((s) => s.fill !== null);
const done = filled.filter((s) => s.resultR !== null);
say('== Funnel');
say(`   setups started (a sweep): ${setups.length.toLocaleString()}  ·  planned (READY): ${planned.length.toLocaleString()} (${pct(planned.length, setups.length)})  ·  filled: ${filled.length} (${pct(filled.length, planned.length)} of plans)  ·  finished: ${done.length}`);
const days = (bars[bars.length - 1]!.time - bars[0]!.time) / 86_400;
say(`   ≈ ${(filled.length / days).toFixed(2)} trades a day, ${(planned.length / days).toFixed(2)} plans a day`);
const why = new Map<string, number>();
for (const s of setups) if (s.closedAt !== null && !s.fill) {
  const k = `${s.events[s.events.length - 1]!.state.toLowerCase()}: ${s.events[s.events.length - 1]!.note.replace(/[\d.,–-]+R?/g, '#')}`;
  why.set(k, (why.get(k) ?? 0) + 1);
}
say('   how setups ended without a trade:');
for (const [k, v] of [...why].sort((a, b) => b[1] - a[1]).slice(0, 12)) say(`     ${String(v).padStart(6)}  ${pct(v, setups.length).padStart(6)}  ${k}`);
say();

// ── trades by year ──────────────────────────────────────────────────────
const feeR = (s: Setup) => (2 * FEE * s.fill!.price) / s.fill!.risk;
const table = (label: string, xs: Setup[]) => {
  if (!xs.length) { say(`   ${label.padEnd(10)} n 0`); return; }
  const gross = xs.map((s) => s.resultR!);
  const net = xs.map((s) => s.resultR! - feeR(s));
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const tp1 = xs.filter((s) => s.events.some((e) => e.state === 'TP1')).length;
  say(`   ${label.padEnd(10)} n ${String(xs.length).padStart(4)}  win ${pct(gross.filter((r) => r > 0).length, xs.length).padStart(6)}  TP1 ${pct(tp1, xs.length).padStart(6)}  SL ${pct(xs.filter((s) => s.state === 'STOPPED').length, xs.length).padStart(6)}` +
    `  avg ${f2(mean(gross))}R  net ${f2(mean(net))}R  fee ${mean(xs.map(feeR)).toFixed(2)}R  total net ${f2(net.reduce((a, b) => a + b, 0))}R  MFE ${mean(xs.map((s) => s.mfeR ?? 0)).toFixed(2)}R`);
};
say('== Trades (every year is out of sample: nothing was fitted)');
for (const y of [...new Set(done.map((s) => year(s.fill!.at)))].sort()) table(String(y), done.filter((s) => year(s.fill!.at) === y));
table('long', done.filter((s) => s.dir === 'bull'));
table('short', done.filter((s) => s.dir === 'bear'));
table('ALL', done);
const ends = new Map<string, number>();
for (const s of done) ends.set(s.state, (ends.get(s.state) ?? 0) + 1);
say(`   exits: ${[...ends].map(([k, v]) => `${k} ${v}`).join(' · ')}`);
say();

// ── big moves ───────────────────────────────────────────────────────────
type Move = { from: number; to: number; dir: 'bull' | 'bear'; pct: number };
const moves: Move[] = [];
for (let i = HOUR_BARS; i < bars.length; i++) {
  const p = ((bars[i]!.close - bars[i - HOUR_BARS]!.close) / bars[i - HOUR_BARS]!.close) * 100;
  if (Math.abs(p) < BIG_PCT) continue;
  const last = moves[moves.length - 1];
  if (last && i - HOUR_BARS <= last.to) { if (Math.abs(p) > Math.abs(last.pct)) Object.assign(last, { to: i, pct: p }); continue; }
  moves.push({ from: i - HOUR_BARS, to: i, dir: p > 0 ? 'bull' : 'bear', pct: p });
}
say(`== Big moves: ${moves.length} one-hour moves of ${BIG_PCT}% or more (≈ ${(moves.length / days).toFixed(2)} a day)`);
const missed = new Map<string, number>();
let caught = 0;
let caughtR = 0;
for (const m of moves) {
  const trade = filled.find((s) => s.dir === m.dir && s.fill!.at >= m.from - 6 && s.fill!.at <= m.to);
  if (trade) { caught++; caughtR += trade.resultR ?? 0; continue; }
  const near = setups.filter((s) => s.dir === m.dir && s.createdAt >= m.from - 36 && s.createdAt <= m.to);
  const reason = !near.length ? 'no setup: no sweep of opposite liquidity before the move'
    : (() => { const s = near[near.length - 1]!; const e = s.events[s.events.length - 1]!; return s.closedAt === null ? `still ${s.state.toLowerCase()}` : `${e.state.toLowerCase()}: ${e.note.replace(/[\d.,–-]+R?/g, '#')}`; })();
  missed.set(reason, (missed.get(reason) ?? 0) + 1);
}
say(`   caught (a trade in the move's direction entered during it): ${caught} of ${moves.length} (${pct(caught, moves.length)}), avg ${caught ? f2(caughtR / caught) : '—'}R`);
say('   missed, by what stopped a trade:');
for (const [k, v] of [...missed].sort((a, b) => b[1] - a[1]).slice(0, 10)) say(`     ${String(v).padStart(5)}  ${pct(v, moves.length).padStart(6)}  ${k}`);

// ── segments (P2): described, not selected on ────────────────────────────
say();
say('== Segments of the desk\'s trades (descriptive only: nothing is chosen from these)');
const seg = (label: string, xs: Setup[]) => {
  if (!xs.length) { say(`   ${label.padEnd(24)} n 0`); return; }
  say(`   ${label.padEnd(24)} n ${String(xs.length).padStart(5)}  win ${pct(xs.filter((s) => s.resultR! > 0).length, xs.length).padStart(6)}  gross ${f2(xs.reduce((a, s) => a + s.resultR!, 0) / xs.length)}R  net ${f2(netOf(xs) / xs.length)}R`);
};
const entryKind = (s: Setup) => (s.id.startsWith('C') ? 'continuation' : 'reversal (sweep)');
for (const k of ['reversal (sweep)', 'continuation']) seg(k, done.filter((s) => entryKind(s) === k));
for (const k of ['Asia', 'London', 'New York', null] as const) seg(`session ${k ?? 'off-hours'}`, done.filter((s) => sessionOf(bars[s.fill!.at]!.time) === k));
seg('1H agrees', done.filter((s) => s.htf === s.dir));
seg('1H against', done.filter((s) => s.htf !== null && s.htf !== s.dir));
seg('1H unknown', done.filter((s) => s.htf === null));

// ── setup quality: which combinations to avoid, or keep ───────────────────
/*
 * Every feature is known at the entry. A slice counts only if it is positive
 * on 2024-25 with t >= 2 AND positive again on 2026 -- declared before the
 * table was first printed. Slicing a dozen ways always finds a slice that
 * looks good by luck; that bar is what separates it from one that holds.
 */
say();
say('== Setup quality (net R a trade after fees; holds = 2024-25 > 0 with t >= 2, and 2026 > 0)');
const netR = (x: Setup) => x.resultR! - feeRof(x, 'taker');
const stat = (xs: Setup[]) => {
  const v = xs.map(netR);
  const n = v.length;
  const mean = n ? v.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
};
const yearOf = (x: Setup) => year(x.fill!.at);
const features: [string, (x: Setup) => string][] = [
  ['kind', (x) => (x.id.startsWith('C') ? 'continuation' : 'reversal')],
  ['liquidity swept', (x) => (x.id.startsWith('C') ? '(none)' : /\((\w+)\)/.exec(x.confirmations[0]!.name)?.[1] ?? '?')],
  ['break', (x) => /^(MSS|CHoCH|BOS)/.exec(x.events.find((e) => e.state === 'READY')!.note)?.[1] ?? '?'],
  ['POI', (x) => x.poi!.kind],
  ['displacement', (x) => (st.tags.some((t) => t.name === 'Displacement' && t.dir === x.dir && t.at > x.createdAt - 30 && t.at <= x.fill!.at) ? 'candle' : 'gap only')],
  ['volume on entry', (x) => (st.tags.some((t) => t.at === x.fill!.at && t.name === 'Volume spike') ? 'spike' : st.tags.some((t) => t.at === x.fill!.at && t.name === 'Volume dry-up') ? 'dry-up' : 'normal')],
  ['session', (x) => sessionOf(bars[x.fill!.at]!.time) ?? 'off-hours'],
  ['1H', (x) => (x.htf === null ? 'unknown' : x.htf === x.dir ? 'agrees' : 'against')],
  ['risk % of price', (x) => { const p = (x.fill!.risk / x.fill!.price) * 100; return p < 0.75 ? '0.50-0.75%' : p < 1 ? '0.75-1.00%' : '>= 1.00%'; }],
];
const holds: string[] = [];
for (const [name, f] of features) {
  const values = [...new Set(done.map(f))].sort();
  for (const v of values) {
    const xs = done.filter((x) => f(x) === v);
    const ins = stat(xs.filter((x) => yearOf(x) < 2026));
    const oos = stat(xs.filter((x) => yearOf(x) >= 2026));
    const ok = ins.mean > 0 && ins.t >= 2 && oos.mean > 0 && oos.n >= 20;
    if (ok) holds.push(`${name} = ${v}`);
    say(`   ${(name + ' = ' + v).padEnd(34)} 24-25 n ${String(ins.n).padStart(4)} ${f2(ins.mean)}R t ${ins.t.toFixed(1).padStart(5)}   2026 n ${String(oos.n).padStart(4)} ${f2(oos.mean)}R${ok ? '   HOLDS' : ''}`);
  }
}
say(`   slices that hold: ${holds.length ? holds.join(' · ') : 'none'}`);

writeFileSync(OUT, lines.join('\n') + '\n');

// The record is research/SMC-STUDY.txt's; the chart no longer shows it (its setups went on 30 Sep 2026).
