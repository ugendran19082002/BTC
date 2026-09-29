/**
 * Volume profile on the cached 5m BTC history, declared before it ran.
 *
 * Each UTC day's profile is the chart's own `volumeProfile` (48 bins over the
 * day's range, value area 70% grown from the POC), taken over the *previous*
 * day and read on the next -- nothing from the day itself.
 *
 *   A1  the 80% rule. The day opens outside yesterday's value area. When two
 *       30-minute periods in a row then close back inside it, trade to the far
 *       side: entry at that close, stop at the day's extreme so far beyond the
 *       value area, target the far edge. Out at the stop (first when a candle
 *       touches both), the target, or the day's last close. As it is, and with
 *       the desk's fee floor (stop at least 0.5% of price).
 *   A2  the POC as a magnet: how often the day trades through yesterday's POC,
 *       against a control level the same distance from the open on the other
 *       side. A magnet would be hit more often than its mirror.
 *
 * Fees 0.05% a side. 2024-25 and 2026 apart; a rule counts only if it is
 * positive on both, with t >= 2 on 2026.
 *
 *   cd app/web && ../server/node_modules/.bin/tsx scripts/profile-study.ts
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bar } from '../src/lib/smc/types';
import { volumeProfile } from '../src/components/desk/chart/flow-layers';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '../../../cache/candles/BTCUSD-5m');
const OUT = join(HERE, '../../../research/PROFILE-STUDY.txt');
const FEE = 0.0005;
const DAY = 86_400;
const M5 = 300;

const bars: Bar[] = readdirSync(CACHE).filter((f) => f.endsWith('.json')).sort()
  .flatMap((f) => JSON.parse(readFileSync(join(CACHE, f), 'utf8')) as Bar[])
  .sort((a, b) => a.time - b.time)
  .filter((b, i, a) => i === 0 || b.time !== a[i - 1]!.time);
const index = new Map(bars.map((b, i) => [b.time, i]));

/** A whole UTC day of 5m candles, or null when any is missing. */
function dayBars(d: number): Bar[] | null {
  const i = index.get(d);
  if (i === undefined) return null;
  const out = bars.slice(i, i + DAY / M5);
  return out.length === DAY / M5 && out[out.length - 1]!.time === d + DAY - M5 ? out : null;
}

type Trade = { year: number; gross: number; net: number };
const lines: string[] = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const r = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}R`;
function report(label: string, ts: Trade[]) {
  const n = ts.length;
  if (!n) { say(`   ${label.padEnd(8)} n 0`); return { n: 0, net: 0, t: 0 }; }
  const net = ts.reduce((a, x) => a + x.net, 0) / n;
  const gross = ts.reduce((a, x) => a + x.gross, 0) / n;
  const sd = Math.sqrt(ts.reduce((a, x) => a + (x.net - net) ** 2, 0) / Math.max(1, n - 1));
  const t = sd > 0 ? net / (sd / Math.sqrt(n)) : 0;
  const win = ts.filter((x) => x.net > 0).length / n;
  say(`   ${label.padEnd(8)} n ${String(n).padStart(4)}  win ${(win * 100).toFixed(1).padStart(5)}%  gross ${r(gross)}  net ${r(net)} a trade (t ${t.toFixed(2)})`);
  return { n, net, t };
}

const first = Math.ceil(bars[0]!.time / DAY) * DAY + DAY;
const a1: Trade[] = [];
const a1f: Trade[] = [];
let days = 0;
const magnet = { y25: { poc: 0, mirror: 0, n: 0 }, y26: { poc: 0, mirror: 0, n: 0 } };

for (let d = first; d + DAY <= bars[bars.length - 1]!.time; d += DAY) {
  const prev = dayBars(d - DAY);
  const today = dayBars(d);
  if (!prev || !today) continue;
  days++;
  const p = volumeProfile(prev, 0, prev.length - 1, 48);
  if (!p) continue;
  const year = new Date(d * 1000).getUTCFullYear();
  const open = today[0]!.open;
  const high = Math.max(...today.map((b) => b.high));
  const low = Math.min(...today.map((b) => b.low));

  // A2: the POC against its mirror, only where the open is not already on it.
  const dist = p.poc - open;
  if (Math.abs(dist) / open > 0.001) {
    const mirror = open - dist;
    const hits = (lvl: number) => low <= lvl && high >= lvl;
    const m = year < 2026 ? magnet.y25 : magnet.y26;
    m.n++; if (hits(p.poc)) m.poc++; if (hits(mirror)) m.mirror++;
  }

  // A1: the 80% rule.
  const above = open > p.vah;
  const below = open < p.val;
  if (!above && !below) continue;
  let inside = 0;
  let extreme = above ? -Infinity : Infinity;
  for (let k = 0; k + 6 <= today.length; k += 6) {
    const period = today.slice(k, k + 6);
    extreme = above ? Math.max(extreme, ...period.map((b) => b.high)) : Math.min(extreme, ...period.map((b) => b.low));
    const close = period[5]!.close;
    inside = close <= p.vah && close >= p.val ? inside + 1 : 0;
    if (inside < 2) continue;
    const entry = close;
    const stop = extreme;
    const target = above ? p.val : p.vah;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0) || (above ? entry <= target : entry >= target)) break;
    let exit = today[today.length - 1]!.close;
    for (const b of today.slice(k + 6)) {
      if (above ? b.high >= stop : b.low <= stop) { exit = stop; break; }
      if (above ? b.low <= target : b.high >= target) { exit = target; break; }
    }
    const gross = (above ? entry - exit : exit - entry) / risk;
    const t = { year, gross, net: gross - ((entry + exit) * FEE) / risk };
    a1.push(t);
    if (risk >= 0.005 * entry) a1f.push(t);
    break;
  }
}

say(`Volume profile on BTCUSD 5m, ${days} UTC days with the day before whole; fees ${FEE * 100}% a side`);
say('Declared before running: see the header of app/web/scripts/profile-study.ts.');
say();
say('== A1 the 80% rule (open outside yesterday\'s value area, two 30m closes back inside -> the far edge)');
const a = report('2024-25', a1.filter((x) => x.year < 2026));
const b = report('2026', a1.filter((x) => x.year >= 2026));
say('== A1 + fee floor (stop >= 0.5% of price)');
const af = report('2024-25', a1f.filter((x) => x.year < 2026));
const bf = report('2026', a1f.filter((x) => x.year >= 2026));
say();
say('== A2 the POC as a magnet (share of days that trade through it, against its mirror from the open)');
for (const [label, m] of [['2024-25', magnet.y25], ['2026', magnet.y26]] as const) {
  const pp = m.poc / m.n;
  const pm = m.mirror / m.n;
  const se = Math.sqrt((pp * (1 - pp) + pm * (1 - pm)) / m.n);
  say(`   ${label.padEnd(8)} days ${m.n}  POC ${(pp * 100).toFixed(1)}%  mirror ${(pm * 100).toFixed(1)}%  difference ${((pp - pm) * 100).toFixed(1)} pts (z ${((pp - pm) / se).toFixed(2)})`);
}
say();
const holds = (x: { net: number }, y: { net: number; t: number }) => x.net > 0 && y.net > 0 && y.t >= 2;
say(`A1 ${holds(a, b) ? 'holds' : 'does not hold'} by the declared rule; with the fee floor it ${holds(af, bf) ? 'holds' : 'does not hold'}.`);
writeFileSync(OUT, lines.join('\n') + '\n');
