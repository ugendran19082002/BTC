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
import { SmcEngine } from '../src/lib/smc/engine';
import type { Bar, Setup } from '../src/lib/smc/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '../../../cache/candles/BTCUSD-5m');
const OUT = join(HERE, '../../../research/SMC-STUDY.txt');
/** Taker fee a side on Delta's BTC perpetual; a round trip is twice this. */
const FEE = 0.0005;
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

const t0 = Date.now();
const engine = new SmcEngine({ tfSec: 300 });
for (const b of bars) engine.push(b);
const st = engine.state();
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

writeFileSync(OUT, lines.join('\n') + '\n');
