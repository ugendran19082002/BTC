/**
 * Order flow, open interest, funding and the biggest traders' positioning,
 * from Binance's public BTCUSDT perpetual history (data.binance.vision, cached
 * in cache/binance) -- the dominant BTC venue, as a proxy for Delta, whose own
 * flow the desk has only recorded since September 2026. Declared before it ran.
 *
 *   B1  CVD divergence. A 5m close at a new 1-hour high while the day's CVD is
 *       below where it was at the previous high (and the mirror at lows): fade
 *       it for an hour. Against the base -- every new 1-hour high / low faded.
 *   B2  The desk's SMC trades (the engine, DESK_SMC_OPTIONS, on the cached
 *       Delta 5m candles) split by whether the entry candle's taker delta on
 *       Binance agreed with the trade's direction.
 *   C1  Perp OI and price over the last hour, read as the desk reads them (new
 *       longs / new shorts / short covering / long unwinding / flat), against
 *       the next hour's and four hours' return.
 *   C2  Funding at its extremes -- the top and bottom tenth, the thresholds
 *       taken from 2024-25 -- against the next 24 hours' return.
 *   D   The top traders' long / short position ratio (Binance's top 20% of
 *       accounts by margin): its 4-hour change at the extremes (top and bottom
 *       tenth, thresholds from 2024-25) against the next four hours' return.
 *
 * Returns in basis points; a round trip costs 10 bp (0.05% a side). A reading
 * holds only if its sign is the same in 2024-25 and 2026, |t| >= 2 on 2026,
 * and it pays more than the round trip where it is a trade.
 *
 *   cd app/web && ../server/node_modules/.bin/tsx scripts/flow-study.ts
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bar, Setup } from '../src/lib/smc/types';
import { DESK_SMC_OPTIONS, runSmc, SmcEngine } from '../src/lib/smc/engine';
import { aggregate, trendTimeline } from '../src/lib/smc/context';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../..');
const BIN = join(ROOT, 'cache/binance');
const OUT = join(ROOT, 'research/FLOW-STUDY.txt');
const FEE = 0.0005;
const RT_BP = 2 * FEE * 1e4;
const M5 = 300;
const H = 3600;

// ---------------------------------------------------------------- data

type Flow = { close: number; vol: number; buy: number; trades: number };
const flow = new Map<number, Flow>();
for (const f of readdirSync(join(BIN, 'klines')).filter((x) => x.endsWith('.csv')).sort()) {
  for (const line of readFileSync(join(BIN, 'klines', f), 'utf8').split('\n')) {
    const c = line.split(',');
    if (c.length < 11 || !/^\d/.test(c[0]!)) continue;
    const t = Math.floor(Number(c[0]) / 1000 / M5) * M5;
    const b = flow.get(t) ?? { close: 0, vol: 0, buy: 0, trades: 0 };
    b.close = Number(c[4]); b.vol += Number(c[5]); b.buy += Number(c[9]); b.trades += Number(c[8]);
    flow.set(t, b);
  }
}
const times = [...flow.keys()].sort((a, b) => a - b);

type Metric = { oi: number; topPos: number };
const metrics = new Map<number, Metric>();
for (const f of readdirSync(join(BIN, 'metrics')).filter((x) => x.endsWith('.csv'))) {
  for (const line of readFileSync(join(BIN, 'metrics', f), 'utf8').split('\n')) {
    const c = line.split(',');
    if (c.length < 8 || !/^\d{4}-/.test(c[0]!)) continue;
    const t = Date.parse(c[0]!.replace(' ', 'T') + 'Z') / 1000;
    metrics.set(t, { oi: Number(c[2]), topPos: Number(c[5]) });
  }
}

const funding: { t: number; rate: number }[] = [];
for (const f of readdirSync(join(BIN, 'funding')).filter((x) => x.endsWith('.csv'))) {
  for (const line of readFileSync(join(BIN, 'funding', f), 'utf8').split('\n')) {
    const c = line.split(',');
    if (c.length < 3 || !/^\d/.test(c[0]!)) continue;
    funding.push({ t: Math.round(Number(c[0]) / 1000 / M5) * M5, rate: Number(c[2]) });
  }
}
funding.sort((a, b) => a.t - b.t);

const closeAt = (t: number) => flow.get(Math.floor(t / M5) * M5 - M5)?.close; // the close of the candle ending at t
const retBp = (from: number, to: number) => {
  const a = closeAt(from); const b = closeAt(to);
  return a && b ? ((b - a) / a) * 1e4 : null;
};
const yearOf = (t: number) => new Date(t * 1000).getUTCFullYear();

// ---------------------------------------------------------------- reporting

const lines: string[] = [];
const say = (s = '') => { lines.push(s); console.log(s); };
type Stat = { n: number; mean: number; t: number };
function stat(xs: number[]): Stat {
  const n = xs.length;
  if (n < 2) return { n, mean: n ? xs[0]! : 0, t: 0 };
  const mean = xs.reduce((a, x) => a + x, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  return { n, mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
}
const fmt = (s: Stat, unit = 'bp') => `n ${String(s.n).padStart(5)}  mean ${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(2)} ${unit} (t ${s.t.toFixed(2).padStart(6)})`;
const bySplit = (xs: { t: number; v: number }[]) => [stat(xs.filter((x) => yearOf(x.t) < 2026).map((x) => x.v)), stat(xs.filter((x) => yearOf(x.t) >= 2026).map((x) => x.v))] as const;
function row(label: string, xs: { t: number; v: number }[], unit = 'bp') {
  const [a, b] = bySplit(xs);
  say(`   ${label.padEnd(30)} 2024-25 ${fmt(a, unit)}   2026 ${fmt(b, unit)}`);
  return [a, b] as const;
}
const holds = (a: Stat, b: Stat, cost = 0) => Math.sign(a.mean) === Math.sign(b.mean) && Math.abs(b.t) >= 2 && Math.abs(b.mean) > cost && Math.abs(a.mean) > cost;
const verdicts: string[] = [];

say(`Order flow, OI, funding and top traders -- Binance BTCUSDT perpetual, ${new Date(times[0]! * 1000).toISOString().slice(0, 10)} to ${new Date(times[times.length - 1]! * 1000).toISOString().slice(0, 10)}`);
say(`${times.length.toLocaleString()} 5m candles from 1m klines, ${metrics.size.toLocaleString()} 5m OI / top-trader rows, ${funding.length} funding prints. Round trip ${RT_BP} bp.`);
say('Declared before running: see the header of app/web/scripts/flow-study.ts.');

// ---------------------------------------------------------------- B1

say();
say('== B1 CVD divergence at a new 1-hour close high / low, faded for an hour (bp, before fees)');
{
  const base: { t: number; v: number }[] = [];
  const div: { t: number; v: number }[] = [];
  let cvd = 0; let day = -1;
  const cvdAt = new Map<number, number>();
  for (const t of times) {
    const d = Math.floor(t / 86_400);
    if (d !== day) { day = d; cvd = 0; }
    const f = flow.get(t)!;
    cvd += 2 * f.buy - f.vol;
    cvdAt.set(t, cvd);
  }
  let busyUntil = 0;
  for (let i = 12; i + 12 < times.length; i++) {
    const t = times[i]!;
    if (t < busyUntil || times[i - 12] !== t - 12 * M5 || times[i + 12] !== t + 12 * M5) continue;
    const prev = times.slice(i - 12, i);
    const c = flow.get(t)!.close;
    const hi = prev.reduce((m, x) => (flow.get(x)!.close > flow.get(m)!.close ? x : m), prev[0]!);
    const lo = prev.reduce((m, x) => (flow.get(x)!.close < flow.get(m)!.close ? x : m), prev[0]!);
    const next = flow.get(times[i + 12]!)!.close;
    const sameDay = (x: number) => Math.floor(x / 86_400) === Math.floor(t / 86_400);
    if (c > flow.get(hi)!.close) {
      const v = ((c - next) / c) * 1e4; // short
      base.push({ t, v });
      if (sameDay(hi) && cvdAt.get(t)! < cvdAt.get(hi)!) { div.push({ t, v }); busyUntil = t + 12 * M5; }
    } else if (c < flow.get(lo)!.close) {
      const v = ((next - c) / c) * 1e4; // long
      base.push({ t, v });
      if (sameDay(lo) && cvdAt.get(t)! > cvdAt.get(lo)!) { div.push({ t, v }); busyUntil = t + 12 * M5; }
    }
  }
  row('every new 1h extreme, faded', base);
  const [a, b] = row('with CVD divergence, faded', div);
  verdicts.push(`B1 CVD divergence fade: ${holds(a, b, RT_BP) ? 'HOLDS' : 'does not hold'} (net of the ${RT_BP} bp round trip: ${(a.mean - RT_BP).toFixed(1)} / ${(b.mean - RT_BP).toFixed(1)} bp).`);
}

// ---------------------------------------------------------------- B2

say();
say('== B2 the desk\'s SMC trades, split by the entry candle\'s taker delta (net R a trade, taker fees)');
{
  const cache = join(ROOT, 'cache/candles/BTCUSD-5m');
  const bars: Bar[] = readdirSync(cache).filter((f) => f.endsWith('.json')).sort()
    .flatMap((f) => JSON.parse(readFileSync(join(cache, f), 'utf8')) as Bar[])
    .sort((a, b) => a.time - b.time).filter((b, i, a) => i === 0 || b.time !== a[i - 1]!.time);
  const hours = aggregate(bars, M5, H);
  const htfTrendAt = trendTimeline(runSmc(hours, { tfSec: H }), hours, H);
  const engine = new SmcEngine({ tfSec: M5, htfTrendAt, ...DESK_SMC_OPTIONS });
  for (const b of bars) engine.push(b);
  const done = engine.state().setups.filter((s: Setup) => s.fill && s.resultR !== null);
  const all: { t: number; v: number }[] = [];
  const agree: { t: number; v: number }[] = [];
  const against: { t: number; v: number }[] = [];
  for (const s of done) {
    const t = bars[s.fill!.at]!.time;
    const net = s.resultR! - (2 * FEE * s.fill!.price) / s.fill!.risk;
    all.push({ t, v: net });
    const f = flow.get(t);
    if (!f) continue;
    const delta = 2 * f.buy - f.vol;
    (Math.sign(delta) === (s.dir === 'bull' ? 1 : -1) ? agree : against).push({ t, v: net });
  }
  row('every desk trade', all, 'R');
  const [a, b] = row('entry delta agrees', agree, 'R');
  row('entry delta against', against, 'R');
  verdicts.push(`B2 delta-agreeing SMC trades: ${a.mean > 0 && b.mean > 0 && b.t >= 2 ? 'an EDGE' : 'no edge'} (${a.mean.toFixed(3)}R / ${b.mean.toFixed(3)}R a trade after fees).`);
}

// ---------------------------------------------------------------- C1

say();
say('== C1 perp OI and price over the last hour, and what came next (bp)');
{
  const read = (oiPct: number, pxPct: number) =>
    Math.abs(oiPct) < 0.5 || Math.abs(pxPct) < 0.1 ? 'flat' : oiPct > 0 ? (pxPct > 0 ? 'new longs' : 'new shorts') : (pxPct > 0 ? 'short covering' : 'long unwinding');
  const next1: Record<string, { t: number; v: number }[]> = {};
  const next4: Record<string, { t: number; v: number }[]> = {};
  for (const [t, m] of metrics) {
    if (t % H !== 0) continue;
    const then = metrics.get(t - H);
    const px = retBp(t - H, t);
    const n1 = retBp(t, t + H);
    const n4 = retBp(t, t + 4 * H);
    if (!then || px === null || n1 === null || n4 === null || !(then.oi > 0)) continue;
    const k = read(((m.oi - then.oi) / then.oi) * 100, px / 100);
    (next1[k] ??= []).push({ t, v: n1 });
    (next4[k] ??= []).push({ t, v: n4 });
  }
  for (const k of ['new longs', 'new shorts', 'short covering', 'long unwinding', 'flat']) {
    row(`${k}: next 1h`, next1[k] ?? []);
    const [a, b] = row(`${k}: next 4h`, next4[k] ?? []);
    if (k !== 'flat') verdicts.push(`C1 ${k} -> next 4h: ${holds(a, b, RT_BP) ? 'HOLDS' : 'does not hold'} (${a.mean.toFixed(1)} / ${b.mean.toFixed(1)} bp).`);
  }
}

// ---------------------------------------------------------------- C2

say();
say('== C2 funding at its extremes (tenths from 2024-25) and the next 24 hours (bp)');
{
  const ins = funding.filter((f) => yearOf(f.t) < 2026).map((f) => f.rate).sort((a, b) => a - b);
  const lo = ins[Math.floor(ins.length * 0.1)]!;
  const hi = ins[Math.floor(ins.length * 0.9)]!;
  say(`   thresholds: bottom tenth <= ${(lo * 100).toFixed(4)}%, top tenth >= ${(hi * 100).toFixed(4)}% a period`);
  const pick = (f: (r: number) => boolean) => funding.filter((x) => f(x.rate)).flatMap((x) => { const v = retBp(x.t, x.t + 24 * H); return v === null ? [] : [{ t: x.t, v }]; });
  row('every funding print', pick(() => true));
  const [a, b] = row('top tenth (crowded longs)', pick((r) => r >= hi));
  const [c, d] = row('bottom tenth (crowded shorts)', pick((r) => r <= lo));
  verdicts.push(`C2 high funding -> next 24h: ${holds(a, b, RT_BP) ? 'HOLDS' : 'does not hold'}; low funding: ${holds(c, d, RT_BP) ? 'HOLDS' : 'does not hold'}.`);
}

// ---------------------------------------------------------------- D

say();
say('== D top traders\' long / short position ratio: its 4-hour change at the extremes, and the next 4 hours (bp)');
{
  const changes: { t: number; d: number }[] = [];
  for (const [t, m] of metrics) {
    if (t % H !== 0) continue;
    const then = metrics.get(t - 4 * H);
    if (then && then.topPos > 0 && m.topPos > 0) changes.push({ t, d: m.topPos - then.topPos });
  }
  const ins = changes.filter((c) => yearOf(c.t) < 2026).map((c) => c.d).sort((a, b) => a - b);
  const lo = ins[Math.floor(ins.length * 0.1)]!;
  const hi = ins[Math.floor(ins.length * 0.9)]!;
  say(`   thresholds: 4h change <= ${lo.toFixed(3)} (top traders cutting longs), >= ${hi.toFixed(3)} (adding longs)`);
  const pick = (f: (d: number) => boolean) => changes.filter((c) => f(c.d)).flatMap((c) => { const v = retBp(c.t, c.t + 4 * H); return v === null ? [] : [{ t: c.t, v }]; });
  row('every hour', pick(() => true));
  const [a, b] = row('top traders adding longs', pick((d) => d >= hi));
  const [c, e] = row('top traders cutting longs', pick((d) => d <= lo));
  verdicts.push(`D top traders adding longs -> next 4h: ${holds(a, b, RT_BP) ? 'HOLDS' : 'does not hold'}; cutting: ${holds(c, e, RT_BP) ? 'HOLDS' : 'does not hold'}.`);
}

say();
say('== Verdicts, by the declared rule');
for (const v of verdicts) say(`   ${v}`);
writeFileSync(OUT, lines.join('\n') + '\n');
