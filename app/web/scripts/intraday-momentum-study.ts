/**
 * Intraday time-series momentum on BTC (Shen, Urquhart & Wang, Financial
 * Review 2022): the day's first half hour predicts its last half hour. Tested
 * on the cached 5-minute candles, UTC days (00:00 UTC = 05:30 IST), with the
 * two signals the paper uses, declared before this ran:
 *
 *   A  sign(first half hour)                        → trade the last half hour
 *   B  sign(first half hour + second-to-last half hour) → trade the last half hour
 *
 * Entered at the last half hour's open, out at the day's close, taker fees
 * both ways. 2024-25 and 2026 reported apart; nothing is fitted.
 *
 *   app/server/node_modules/.bin/tsx app/web/scripts/intraday-momentum-study.ts
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bar } from '../src/lib/smc/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '../../../cache/candles/BTCUSD-5m');
const OUT = join(HERE, '../../../research/INTRADAY-MOMENTUM.txt');
const FEE = 0.0005; // a side
const DAY = 86_400;

const bars: Bar[] = readdirSync(CACHE).filter((f) => f.endsWith('.json')).sort()
  .flatMap((f) => JSON.parse(readFileSync(join(CACHE, f), 'utf8')) as Bar[])
  .sort((a, b) => a.time - b.time);
const at = new Map(bars.map((b) => [b.time, b]));

type Day = { year: number; first: number; penult: number; last: number };
const days: Day[] = [];
for (let d = Math.ceil(bars[0]!.time / DAY) * DAY; d + DAY <= bars[bars.length - 1]!.time; d += DAY) {
  const o = (t: number) => at.get(d + t)?.open;
  const c = (t: number) => at.get(d + t)?.close;
  const [o0, c30, o2300, c2325, o2330, c2355] = [o(0), c(25 * 60), o(23 * 3600), c(23 * 3600 + 25 * 60), o(23 * 3600 + 30 * 60), c(23 * 3600 + 55 * 60)];
  if ([o0, c30, o2300, c2325, o2330, c2355].some((x) => x === undefined)) continue;
  days.push({
    year: new Date(d * 1000).getUTCFullYear(),
    first: c30! / o0! - 1, penult: c2325! / o2300! - 1, last: c2355! / o2330! - 1,
  });
}

const lines: string[] = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const bps = (x: number) => `${x >= 0 ? '+' : ''}${(x * 1e4).toFixed(2)} bp`;
const report = (label: string, signal: (d: Day) => number, xs: Day[]) => {
  const trades = xs.filter((d) => signal(d) !== 0).map((d) => Math.sign(signal(d)) * d.last);
  const n = trades.length;
  const gross = trades.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(trades.reduce((a, b) => a + (b - gross) ** 2, 0) / (n - 1));
  const net = gross - 2 * FEE;
  const hit = trades.filter((r) => r > 0).length / n;
  say(`   ${label.padEnd(22)} n ${String(n).padStart(4)}  hit ${(hit * 100).toFixed(1)}%  gross ${bps(gross)} (t ${(gross / (sd / Math.sqrt(n))).toFixed(2)})  net ${bps(net)} a trade  (fees ${bps(2 * FEE)})`);
};

say(`BTC intraday time-series momentum · ${days.length} UTC days with every half hour present · fees ${FEE * 100}% a side`);
say(`   mean |last half hour| = ${bps(days.reduce((a, d) => a + Math.abs(d.last), 0) / days.length)} -- what a perfect call would make before fees`);
say();
for (const [name, sig] of [
  ['A first half hour', (d: Day) => d.first],
  ['B first + penultimate', (d: Day) => d.first + d.penult],
] as const) {
  say(`== ${name}`);
  report('2024-25', sig, days.filter((d) => d.year < 2026));
  report('2026', sig, days.filter((d) => d.year >= 2026));
}
writeFileSync(OUT, lines.join('\n') + '\n');
