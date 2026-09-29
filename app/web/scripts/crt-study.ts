/**
 * The CRT family on the cached 5m BTC history, declared before it ran.
 *
 * One model, four reference ranges:
 *
 *   A reference range [L, H] completes. In the watch window after it, the
 *   first side swept (a 5m wick beyond H or L) and then reclaimed (a 5m close
 *   back inside, the same candle or a later one) is traded back into the
 *   range: entry at the reclaim close, stop at the sweep's extreme, target the
 *   opposite side of the range. Out at the stop, the target, or the watch
 *   window's last close. Stop first when one candle touches both.
 *   No trade when the target pays under 1R, or when the reclaim close is
 *   already beyond the far side. One trade per window.
 *
 *   CRT-1H   previous 1H candle, watched through the next hour
 *   CRT-4H   previous 4H candle (UTC), watched through the next four hours
 *   CRT-1D   previous UTC day (the PDH / PDL sweep, Turtle-Soup-like), the next day
 *   ASIA     the Asia range (00-07 UTC), watched through London and New York (07-20 UTC)
 *
 * Each as it is, and with the desk's fee floor (stop at least 0.5% of price).
 * Fees 0.05% a side. Chosen on 2024-25 -- the best net R a trade among those
 * with 100 trades or more -- and that one judged on 2026. Every row is printed.
 *
 *   app/server/node_modules/.bin/tsx app/web/scripts/crt-study.ts
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bar } from '../src/lib/smc/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '../../../cache/candles/BTCUSD-5m');
const OUT = join(HERE, '../../../research/CRT-STUDY.txt');
const FEE = 0.0005;
const FLOOR = 0.005;
const M5 = 300;

const bars: Bar[] = readdirSync(CACHE).filter((f) => f.endsWith('.json')).sort()
  .flatMap((f) => JSON.parse(readFileSync(join(CACHE, f), 'utf8')) as Bar[])
  .sort((a, b) => a.time - b.time)
  .filter((b, i, a) => i === 0 || b.time !== a[i - 1]!.time);
const index = new Map(bars.map((b, i) => [b.time, i]));

/** The 5m candles from `from` (inclusive) to `to` (exclusive), or null when any is missing. */
function span(from: number, to: number): Bar[] | null {
  const i = index.get(from);
  const n = (to - from) / M5;
  if (i === undefined) return null;
  const out = bars.slice(i, i + n);
  return out.length === n && out[n - 1]!.time === to - M5 ? out : null;
}

type Window = { ref: Bar[]; watch: Bar[] };

/** Consecutive `sec` buckets: each completed one is the reference, the next the watch. */
function buckets(sec: number): Window[] {
  const out: Window[] = [];
  const first = Math.ceil(bars[0]!.time / sec) * sec;
  const last = bars[bars.length - 1]!.time;
  for (let t = first; t + 2 * sec <= last; t += sec) {
    const ref = span(t, t + sec);
    const watch = ref && span(t + sec, t + 2 * sec);
    if (ref && watch) out.push({ ref, watch });
  }
  return out;
}

function asia(): Window[] {
  const out: Window[] = [];
  const DAY = 86_400;
  for (let d = Math.ceil(bars[0]!.time / DAY) * DAY; d + DAY <= bars[bars.length - 1]!.time; d += DAY) {
    const ref = span(d, d + 7 * 3600);
    const watch = ref && span(d + 7 * 3600, d + 20 * 3600);
    if (ref && watch) out.push({ ref, watch });
  }
  return out;
}

type Trade = { year: number; gross: number; net: number; win: boolean };

function trade(w: Window, floor: boolean): Trade | null {
  const H = Math.max(...w.ref.map((b) => b.high));
  const L = Math.min(...w.ref.map((b) => b.low));
  let side: 'short' | 'long' | null = null;
  let extreme = 0;
  for (let i = 0; i < w.watch.length; i++) {
    const b = w.watch[i]!;
    if (side === null) {
      if (b.high > H && b.low < L) return null; // both sides in one candle: no read
      if (b.high > H) { side = 'short'; extreme = b.high; } else if (b.low < L) { side = 'long'; extreme = b.low; } else continue;
    } else {
      extreme = side === 'short' ? Math.max(extreme, b.high) : Math.min(extreme, b.low);
    }
    const reclaimed = side === 'short' ? b.close < H : b.close > L;
    if (!reclaimed) continue;
    const entry = b.close;
    const stop = extreme;
    const target = side === 'short' ? L : H;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) return null;
    if (side === 'short' ? entry <= target : entry >= target) return null;
    if (Math.abs(target - entry) / risk < 1) return null;
    if (floor && risk < FLOOR * entry) return null;
    let exit = w.watch[w.watch.length - 1]!.close;
    for (let j = i + 1; j < w.watch.length; j++) {
      const c = w.watch[j]!;
      if (side === 'short' ? c.high >= stop : c.low <= stop) { exit = stop; break; }
      if (side === 'short' ? c.low <= target : c.high >= target) { exit = target; break; }
    }
    const gross = (side === 'short' ? entry - exit : exit - entry) / risk;
    const fee = ((entry + exit) * FEE) / risk;
    return { year: new Date(b.time * 1000).getUTCFullYear(), gross, net: gross - fee, win: gross - fee > 0 };
  }
  return null;
}

type Row = { n: number; win: number; gross: number; net: number; t: number; total: number };
function stats(ts: Trade[]): Row {
  const n = ts.length;
  if (!n) return { n: 0, win: 0, gross: 0, net: 0, t: 0, total: 0 };
  const net = ts.reduce((a, x) => a + x.net, 0) / n;
  const sd = Math.sqrt(ts.reduce((a, x) => a + (x.net - net) ** 2, 0) / Math.max(1, n - 1));
  return {
    n, win: ts.filter((x) => x.win).length / n, gross: ts.reduce((a, x) => a + x.gross, 0) / n,
    net, t: sd > 0 ? net / (sd / Math.sqrt(n)) : 0, total: ts.reduce((a, x) => a + x.net, 0),
  };
}

const lines: string[] = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const r = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}R`;
const fmtRow = (label: string, s: Row) =>
  `   ${label.padEnd(10)} n ${String(s.n).padStart(5)}  win ${(s.win * 100).toFixed(1).padStart(5)}%  gross ${r(s.gross)}  net ${r(s.net)} a trade (t ${s.t.toFixed(2).padStart(6)})  total ${s.total.toFixed(1)}R`;

const families: [string, Window[]][] = [
  ['CRT-1H', buckets(3600)],
  ['CRT-4H', buckets(4 * 3600)],
  ['CRT-1D', buckets(86_400)],
  ['ASIA', asia()],
];

say(`CRT family on BTCUSD 5m, ${new Date(bars[0]!.time * 1000).toISOString().slice(0, 10)} to ${new Date(bars[bars.length - 1]!.time * 1000).toISOString().slice(0, 10)}, fees ${FEE * 100}% a side`);
say('Declared before running: see the header of app/web/scripts/crt-study.ts.');
say();
const choices: { name: string; train: Row; test: Row }[] = [];
for (const [name, windows] of families) {
  for (const floor of [false, true]) {
    const all = windows.map((w) => trade(w, floor)).filter((x): x is Trade => x !== null);
    const label = `${name}${floor ? ' +floor' : ''}`;
    const train = stats(all.filter((x) => x.year < 2026));
    const test = stats(all.filter((x) => x.year >= 2026));
    say(`== ${label}  (${windows.length} windows)`);
    say(fmtRow('2024-25', train));
    say(fmtRow('2026', test));
    choices.push({ name: label, train, test });
  }
}
say();
const eligible = choices.filter((c) => c.train.n >= 100).sort((a, b) => b.train.net - a.train.net);
const pick = eligible[0];
if (pick) {
  say(`Chosen on 2024-25: ${pick.name}, net ${r(pick.train.net)} a trade over ${pick.train.n} trades.`);
  say(`Judged once on 2026: net ${r(pick.test.net)} a trade over ${pick.test.n} trades (t ${pick.test.t.toFixed(2)}).`);
  say(pick.train.net > 0 && pick.test.net > 0 && pick.test.t >= 2
    ? 'Positive in both periods and significant on 2026.'
    : 'Not an edge by the declared rule: it needed to be positive on 2024-25 and again on 2026 with t >= 2.');
}
writeFileSync(OUT, lines.join('\n') + '\n');
