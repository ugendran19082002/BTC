import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candles, type Candle } from '../market/delta.js';

/**
 * BTCUSD history for the research scripts, cached one file per month.
 *
 * Delta answers at most a couple of thousand bars a request, so two and a half
 * years of five-minute bars is a hundred-odd requests; cached, the study can
 * be rerun as often as the rules change without asking Delta again. A month is
 * only written once it is over -- the current month is fetched every run, so
 * the cache never freezes a half-finished month.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../cache/candles');
const STEP_SEC: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 };
const PER_REQUEST = 1_800;

function monthsBetween(start: Date, end: Date): { from: number; to: number; key: string }[] {
  const out: { from: number; to: number; key: string }[] = [];
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (d < end) {
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    out.push({ from: d.getTime() / 1000, to: Math.min(next.getTime(), end.getTime()) / 1000, key: d.toISOString().slice(0, 7) });
    d.setTime(next.getTime());
  }
  return out;
}

async function fetchRange(symbol: string, resolution: string, from: number, to: number): Promise<Candle[]> {
  const step = STEP_SEC[resolution];
  if (!step) throw new Error(`no step for ${resolution}`);
  const out: Candle[] = [];
  for (let t = from; t < to; t += step * PER_REQUEST) {
    const chunk = await candles(symbol, t, Math.min(to, t + step * PER_REQUEST) - 1, resolution);
    out.push(...chunk);
  }
  // Delta can answer an overlapping bar at a chunk edge: one bar per timestamp, oldest first.
  const byTime = new Map(out.map((c) => [c.time, c]));
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Every bar from `start` to `end`, oldest first, from the cache where the month is complete. */
export async function cachedCandles(symbol: string, resolution: string, start: Date, end: Date, log = (_: string) => {}): Promise<Candle[]> {
  const dir = join(ROOT, `${symbol}-${resolution}`);
  mkdirSync(dir, { recursive: true });
  const nowSec = Date.now() / 1000;
  const all: Candle[] = [];
  for (const m of monthsBetween(start, end)) {
    const file = join(dir, `${m.key}.json`);
    const complete = m.to <= nowSec - 3600;
    if (complete && existsSync(file)) {
      all.push(...(JSON.parse(readFileSync(file, 'utf8')) as Candle[]));
      continue;
    }
    log(`fetching ${symbol} ${resolution} ${m.key}`);
    const bars = await fetchRange(symbol, resolution, m.from, m.to);
    if (complete && bars.length) writeFileSync(file, JSON.stringify(bars));
    all.push(...bars);
  }
  return all.filter((c) => c.time >= start.getTime() / 1000 && c.time < end.getTime() / 1000);
}
