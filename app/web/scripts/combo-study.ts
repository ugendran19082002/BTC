/**
 * Strategy search, declared before it ran -- the families with outside
 * evidence first, the layers as filters on the one plan that held up, and the
 * SMC plan against the trend.
 *
 * Part 1 -- daily trend following on Binance's BTCUSDT perpetual, 2020-01 to
 * 2026-08. 2020-23 is data no study here has touched. Literature defaults,
 * nothing tuned; daily positions, fees 0.05% a side on every change:
 *   D0 buy and hold (the benchmark)
 *   D1 time-series momentum, 20 days: long if the last 20 days rose, else short
 *   D2 the same, 60 days
 *   D3 the trend plan (lib/trend/breakout.ts) on daily candles: 20-day channel
 *   D4 the same with a 55-day channel
 *   D5 EMA 20 over EMA 100: long, else short
 *   D6 D1 sized to 40% annual volatility (20-day realised), at most 2x
 *
 * Part 2 -- the trend plan on 1H and 4H (Delta's cached candles), and the same
 * trades kept only when one layer agreed at the signal close:
 *   F1 volatility expanding: ATR at least 1.3x its 100-candle median
 *   F2 a volume burst: the signal candle 1.5x its 20-candle mean volume
 *   F3 the signal candle's taker delta (Binance) in the trade's direction
 *   F4 open interest (Binance) up over the last 4 hours
 *   F5 London or New York hours (07-20 UTC)
 *   F6 the daily trend agrees: the close over its 20-day average for a long
 *
 * Part 3 -- the desk's SMC trades by the trend plan's position at the entry:
 * with it, against it, or the plan flat.
 *
 * Caution, written before the numbers: 2026 has already judged the trend plan,
 * so Parts 2 and 3 on 2026 are a check, not a clean test. The paper log is.
 *
 *   cd app/web && ../server/node_modules/.bin/tsx scripts/combo-study.ts
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bar, Setup } from '../src/lib/smc/types';
import { DESK_SMC_OPTIONS, runSmc, SmcEngine } from '../src/lib/smc/engine';
import { aggregate, trendTimeline } from '../src/lib/smc/context';
import { runTrend, TREND_OPTIONS, type TrendBar, type TrendTrade } from '../src/lib/trend/breakout';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../..');
const BIN = join(ROOT, 'cache/binance');
const OUT = join(ROOT, 'research/COMBO-STUDY.txt');
const FEE = 0.0005;
const M5 = 300;
const H = 3600;
const DAY = 86_400;
const lines: string[] = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const yearOf = (t: number) => new Date(t * 1000).getUTCFullYear();
const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

// ================================================================ Part 1

const daily: TrendBar[] = readdirSync(join(BIN, 'daily')).filter((f) => f.endsWith('.csv')).sort()
  .flatMap((f) => readFileSync(join(BIN, 'daily', f), 'utf8').split('\n'))
  .map((l) => l.split(','))
  .filter((c) => c.length > 5 && /^\d/.test(c[0]!))
  .map((c) => ({ time: Math.floor(Number(c[0]) / 1000), open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]) }))
  .sort((a, b) => a.time - b.time);

/** Daily returns of a position series (the position held over day i is decided at the close of day i-1), fees on every change. */
function pnl(pos: number[]): { t: number; r: number }[] {
  const out: { t: number; r: number }[] = [];
  for (let i = 1; i < daily.length; i++) {
    const p = pos[i - 1] ?? 0;
    const prev = pos[i - 2] ?? 0;
    const r = p * (daily[i]!.close / daily[i - 1]!.close - 1) - Math.abs(p - prev) * FEE;
    out.push({ t: daily[i]!.time, r });
  }
  return out;
}
/** A trade list as a daily position series; the exit day earns only to the exit price. */
function tradesPnl(trades: readonly TrendTrade[]): { t: number; r: number }[] {
  const r = new Array<number>(daily.length).fill(0);
  for (const tr of trades) {
    const end = tr.exitAt ?? daily.length - 1;
    for (let i = tr.at + 1; i <= end; i++) {
      const to = i === tr.exitAt ? tr.exit! : daily[i]!.close;
      r[i]! += tr.dir * (to / daily[i - 1]!.close - 1);
    }
    r[tr.at]! -= FEE;
    if (tr.exitAt !== null) r[tr.exitAt]! -= FEE;
  }
  return r.slice(1).map((v, k) => ({ t: daily[k + 1]!.time, r: v }));
}
function perf(xs: { t: number; r: number }[]) {
  const n = xs.length;
  if (!n) return 'n 0';
  const mean = xs.reduce((a, x) => a + x.r, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x.r - mean) ** 2, 0) / Math.max(1, n - 1));
  let eq = 1; let peak = 1; let dd = 0;
  for (const x of xs) { eq *= 1 + x.r; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); }
  const years = n / 365;
  return `CAGR ${pct(eq ** (1 / years) - 1).padStart(7)}  Sharpe ${(sd > 0 ? (mean / sd) * Math.sqrt(365) : 0).toFixed(2).padStart(5)}  max drawdown ${pct(dd).padStart(7)}`;
}
function dailyRow(name: string, xs: { t: number; r: number }[]) {
  say(`== ${name}`);
  say(`   2020-23  ${perf(xs.filter((x) => yearOf(x.t) <= 2023))}`);
  say(`   2024-26  ${perf(xs.filter((x) => yearOf(x.t) >= 2024))}`);
}

say(`Strategy search -- declared before running: see the header of app/web/scripts/combo-study.ts. Fees ${FEE * 100}% a side.`);
say();
say(`Part 1 -- daily trend following, Binance BTCUSDT perpetual, ${new Date(daily[0]!.time * 1000).toISOString().slice(0, 10)} to ${new Date(daily[daily.length - 1]!.time * 1000).toISOString().slice(0, 10)} (${daily.length} days)`);
{
  const closes = daily.map((d) => d.close);
  dailyRow('D0 buy and hold', pnl(closes.map(() => 1)));
  const tsmom = (k: number) => closes.map((c, i) => (i >= k ? (c > closes[i - k]! ? 1 : -1) : 0));
  dailyRow('D1 time-series momentum, 20 days', pnl(tsmom(20)));
  dailyRow('D2 time-series momentum, 60 days', pnl(tsmom(60)));
  dailyRow('D3 trend plan, 20-day channel, 2 ATR stop, 3 ATR trail', tradesPnl(runTrend(daily).trades));
  dailyRow('D4 trend plan, 55-day channel', tradesPnl(runTrend(daily, { ...TREND_OPTIONS, lookback: 55 }).trades));
  const ema = (k: number) => { const out: number[] = []; closes.forEach((c, i) => out.push(i === 0 ? c : out[i - 1]! + (2 / (k + 1)) * (c - out[i - 1]!))); return out; };
  const e20 = ema(20); const e100 = ema(100);
  dailyRow('D5 EMA 20 over EMA 100', pnl(closes.map((_, i) => (i >= 100 ? (e20[i]! > e100[i]! ? 1 : -1) : 0))));
  const sized = tsmom(20).map((p, i) => {
    if (i < 21) return 0;
    const rs = Array.from({ length: 20 }, (_, k) => Math.log(closes[i - k]! / closes[i - k - 1]!));
    const m = rs.reduce((a, x) => a + x, 0) / 20;
    const vol = Math.sqrt(rs.reduce((a, x) => a + (x - m) ** 2, 0) / 19) * Math.sqrt(365);
    return p * Math.min(2, 0.4 / Math.max(vol, 1e-6));
  });
  dailyRow('D6 D1 sized to 40% annual volatility', pnl(sized));
}

// ================================================================ Part 2

const cache = join(ROOT, 'cache/candles/BTCUSD-5m');
const bars: Bar[] = readdirSync(cache).filter((f) => f.endsWith('.json')).sort()
  .flatMap((f) => JSON.parse(readFileSync(join(cache, f), 'utf8')) as Bar[])
  .sort((a, b) => a.time - b.time).filter((b, i, a) => i === 0 || b.time !== a[i - 1]!.time);

const flow = new Map<number, { vol: number; buy: number }>();
for (const f of readdirSync(join(BIN, 'klines')).filter((x) => x.endsWith('.csv'))) {
  for (const line of readFileSync(join(BIN, 'klines', f), 'utf8').split('\n')) {
    const c = line.split(',');
    if (c.length < 11 || !/^\d/.test(c[0]!)) continue;
    const t = Math.floor(Number(c[0]) / 1000 / M5) * M5;
    const b = flow.get(t) ?? { vol: 0, buy: 0 };
    b.vol += Number(c[5]); b.buy += Number(c[9]);
    flow.set(t, b);
  }
}
const oi = new Map<number, number>();
for (const f of readdirSync(join(BIN, 'metrics')).filter((x) => x.endsWith('.csv'))) {
  for (const line of readFileSync(join(BIN, 'metrics', f), 'utf8').split('\n')) {
    const c = line.split(',');
    if (c.length < 8 || !/^\d{4}-/.test(c[0]!)) continue;
    oi.set(Date.parse(c[0]!.replace(' ', 'T') + 'Z') / 1000, Number(c[2]));
  }
}
const dailyClose = new Map(aggregate(bars, M5, DAY).map((d) => [d.time, d.close]));
const dayTimes = [...dailyClose.keys()].sort((a, b) => a - b);

type Row = { n: number; net: number; t: number };
function rowOf(rs: number[]): Row {
  const n = rs.length;
  if (!n) return { n: 0, net: 0, t: 0 };
  const net = rs.reduce((a, x) => a + x, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, x) => a + (x - net) ** 2, 0) / Math.max(1, n - 1));
  return { n, net, t: sd > 0 ? net / (sd / Math.sqrt(n)) : 0 };
}
const R = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}R`;
const fmt = (r: Row) => `n ${String(r.n).padStart(4)}  net ${R(r.net)} (t ${r.t.toFixed(2).padStart(5)})`;

say();
say('Part 2 -- the trend plan and one layer at a time (net R a trade after fees; a filter helps only if it beats the base in both halves)');
for (const [label, tfSec] of [['1H', H], ['4H', 4 * H]] as const) {
  const xs = aggregate(bars, M5, tfSec);
  const st = runTrend(xs);
  const last = xs[xs.length - 1]!.close;
  const trades = st.trades.map((t) => {
    const exit = t.exit ?? last;
    return { t, time: xs[t.at]!.time, net: (t.dir * (exit - t.entry)) / t.risk - ((t.entry + exit) * FEE) / t.risk };
  });
  const atr = st.atr;
  const filters: [string, (t: TrendTrade) => boolean | null][] = [
    ['F1 volatility expanding', (t) => {
      if (t.at < 100) return null;
      const past = atr.slice(t.at - 100, t.at).sort((a, b) => a - b);
      return atr[t.at]! >= 1.3 * past[50]!;
    }],
    ['F2 volume burst', (t) => {
      if (t.at < 20) return null;
      const mean = xs.slice(t.at - 20, t.at).reduce((a, b) => a + b.volume, 0) / 20;
      return xs[t.at]!.volume >= 1.5 * mean;
    }],
    ['F3 taker delta agrees (Binance)', (t) => {
      let d = 0; let seen = 0;
      for (let s = xs[t.at]!.time; s < xs[t.at]!.time + tfSec; s += M5) { const f = flow.get(s); if (f) { d += 2 * f.buy - f.vol; seen++; } }
      return seen ? Math.sign(d) === t.dir : null;
    }],
    ['F4 open interest up over 4h (Binance)', (t) => {
      const end = xs[t.at]!.time + tfSec;
      const now = oi.get(end - M5) ?? oi.get(end); const then = oi.get(end - 4 * H - M5) ?? oi.get(end - 4 * H);
      return now !== undefined && then !== undefined ? now > then : null;
    }],
    ['F5 London / New York hours', (t) => { const h = new Date((xs[t.at]!.time + tfSec) * 1000).getUTCHours(); return h >= 7 && h < 20; }],
    ['F6 the daily trend agrees', (t) => {
      const end = xs[t.at]!.time + tfSec;
      const k = dayTimes.findIndex((d) => d + DAY > end) - 1; // the last whole day before the signal
      if (k < 20) return null;
      const avg = dayTimes.slice(k - 19, k + 1).reduce((a, d) => a + dailyClose.get(d)!, 0) / 20;
      return t.dir === 1 ? dailyClose.get(dayTimes[k]!)! > avg : dailyClose.get(dayTimes[k]!)! < avg;
    }],
  ];
  const split = (rs: typeof trades) => [rowOf(rs.filter((x) => yearOf(x.time) < 2026).map((x) => x.net)), rowOf(rs.filter((x) => yearOf(x.time) >= 2026).map((x) => x.net))] as const;
  const [b1, b2] = split(trades);
  say(`== ${label}`);
  say(`   base                                  2024-25 ${fmt(b1)}   2026 ${fmt(b2)}`);
  for (const [name, f] of filters) {
    const kept = trades.filter((x) => f(x.t) === true);
    const [a, b] = split(kept);
    const helps = a.net > b1.net && b.net > b2.net;
    say(`   ${name.padEnd(37)} 2024-25 ${fmt(a)}   2026 ${fmt(b)}   ${helps ? 'better in both' : ''}`);
  }
}

// ================================================================ Part 3

say();
say('Part 3 -- the desk\'s SMC trades by the trend plan\'s position at the entry (net R a trade after fees)');
{
  const hours = aggregate(bars, M5, H);
  const htfTrendAt = trendTimeline(runSmc(hours, { tfSec: H }), hours, H);
  const engine = new SmcEngine({ tfSec: M5, htfTrendAt, ...DESK_SMC_OPTIONS });
  for (const b of bars) engine.push(b);
  const done = engine.state().setups.filter((s: Setup) => s.fill && s.resultR !== null);
  for (const [label, tfSec] of [['1H', H], ['4H', 4 * H]] as const) {
    const xs = aggregate(bars, M5, tfSec);
    const st = runTrend(xs);
    /** The plan's direction at a time: the trade open at the last close before it. */
    const dirAt = (sec: number): 1 | -1 | 0 => {
      for (const t of st.trades) {
        const from = xs[t.at]!.time + tfSec;
        const to = t.exitAt === null ? Infinity : xs[t.exitAt]!.time + tfSec;
        if (from <= sec && sec < to) return t.dir;
      }
      return 0;
    };
    const groups: Record<string, { time: number; net: number }[]> = { 'with the plan': [], 'against the plan': [], 'plan flat': [] };
    for (const s of done) {
      const time = bars[s.fill!.at]!.time + M5;
      const net = s.resultR! - (2 * FEE * s.fill!.price) / s.fill!.risk;
      const d = dirAt(time);
      const want = s.dir === 'bull' ? 1 : -1;
      groups[d === 0 ? 'plan flat' : d === want ? 'with the plan' : 'against the plan']!.push({ time, net });
    }
    say(`== against the ${label} trend plan`);
    for (const [k, rs] of Object.entries(groups)) {
      const a = rowOf(rs.filter((x) => yearOf(x.time) < 2026).map((x) => x.net));
      const b = rowOf(rs.filter((x) => yearOf(x.time) >= 2026).map((x) => x.net));
      say(`   ${k.padEnd(18)} 2024-25 ${fmt(a)}   2026 ${fmt(b)}`);
    }
  }
}
writeFileSync(OUT, lines.join('\n') + '\n');
