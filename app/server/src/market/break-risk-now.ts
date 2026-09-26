import { candles, type Candle } from './delta.js';
import { breakRisk, type BreakRisk } from '../domain/break-risk.js';
import { BREAK_CARRY, REACH_STEPS_ATR } from '../domain/break-carry.data.js';

/**
 * The live break-risk read: the last four and a half days of five-minute
 * BTCUSD bars, through the rule the study measured.
 *
 * Four and a half days because the hourly check wants sixty closed hours for
 * its window and thirty more for the cooldown. One fetch per thirty seconds
 * however many screens ask: a break is read at bar closes, the smallest of
 * which is fifteen minutes apart, so a fresher answer would be the same one.
 */

const LOOKBACK_SEC = 108 * 3600;
const TTL_MS = 30_000;

let cache: { at: number; risk: BreakRisk | null } | null = null;
let inflight: Promise<{ at: number; risk: BreakRisk | null }> | null = null;

export async function breakRiskNow(
  now = Date.now(),
  fetchBars: (start: number, end: number) => Promise<Candle[]> = (s, e) => candles('BTCUSD', s, e, '5m'),
): Promise<{ at: number; risk: BreakRisk | null }> {
  if (cache && now - cache.at < TTL_MS) return cache;
  if (inflight) return inflight;
  const nowSec = Math.floor(now / 1000);
  inflight = fetchBars(nowSec - LOOKBACK_SEC, nowSec)
    .then((bars) => {
      cache = { at: now, risk: breakRisk(bars, nowSec, BREAK_CARRY, REACH_STEPS_ATR) };
      return cache;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** For tests: forget the last read. */
export function resetBreakRiskCache(): void {
  cache = null;
  inflight = null;
}
