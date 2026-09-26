import { candles, type Candle } from './delta.js';
import { readMarket } from './moves.js';
import { ladder, readiness, TIER_WEIGHT, TIER_ORDER, type Ladder, type Readiness } from '../domain/hierarchy.js';
import { expiryPath, strikeSafety, type ExpiryPath, type StrikeSafety } from '../domain/expiry-path.js';
import { momentumSignal, type MomentumSignal } from '../domain/momentum-signal.js';
import { loadHorizons } from '../domain/forecast.js';

/**
 * Everything the Live screen decides with, in one read.
 *
 * One request, not eight. The old screen polled `/api/chain`, `/api/perp`,
 * `/api/movement`, `/api/term`, `/api/break-risk`, `/api/market-state`, its
 * history and `/api/changes` separately, on four different intervals, and then
 * had to reason about panels built from market reads taken seconds apart. A
 * hierarchy whose 12-hour row is eleven seconds older than its 5-minute row is
 * a hierarchy that can contradict itself on screen while every part of it is
 * correct.
 *
 * So: one snapshot, one timestamp, one set of bars. `asOf` is on the response
 * and the screen prints it.
 *
 * The 5-minute bars are fetched once and every timeframe is folded out of
 * them, for the same reason.
 */

/** Four and a half days of 5m bars: enough for the 1h break rule's sixty closed hours plus its cooldown. */
const LOOKBACK_SEC = 108 * 3600;

/** A break is read at bar closes, the smallest fifteen minutes apart; a fresher answer is the same answer. */
const TTL_MS = 20_000;

export type LiveRead = {
  asOf: number;
  spot: number;
  /** The weighted multi-timeframe ladder -- the screen's direction section. */
  ladder: Ladder;
  /** Whether the ladder allows a trade, and everything blocking it. */
  readiness: Readiness;
  /** The measured band to settlement. Null before the horizons table has loaded. */
  path: ExpiryPath | null;
  /** The live momentum call, with its stop, its target and its measured record. */
  momentum: MomentumSignal;
  /** The weights the ladder decided with, so the screen can print them beside the table. */
  weights: { tier: string; weight: number }[];
  /** Named so the screen never has to guess why a row is missing. */
  missing: string[];
};

let cache: { at: number; read: LiveRead } | null = null;
let inflight: Promise<LiveRead> | null = null;

export async function liveRead(input: {
  now?: number;
  hoursToExpiry: number;
  atmIv: number | null;
  fetchBars?: (start: number, end: number) => Promise<Candle[]>;
} ): Promise<LiveRead> {
  const now = input.now ?? Date.now();
  // The expiry and the IV change between contracts, so they are not part of
  // what the cache can answer for; only the bars and the market read are.
  if (cache && now - cache.at < TTL_MS && cache.read.path?.hoursToExpiry === input.hoursToExpiry) return cache.read;
  if (inflight) return inflight;

  const fetchBars = input.fetchBars ?? ((s: number, e: number) => candles('BTCUSD', s, e, '5m'));
  const nowSec = Math.floor(now / 1000);

  inflight = (async (): Promise<LiveRead> => {
    const [market, bars5m] = await Promise.all([
      readMarket().catch(() => null),
      fetchBars(nowSec - LOOKBACK_SEC, nowSec).catch(() => [] as Candle[]),
    ]);

    const missing: string[] = [];
    const reads = market?.hierarchy ?? [];
    if (!reads.length) missing.push('No timeframe could be read — the candle feed returned nothing.');
    const l = ladder(reads);
    const r = readiness(l);

    const spot = market?.spot ?? bars5m[bars5m.length - 1]?.close ?? 0;

    const horizons = loadHorizons();
    if (!horizons.length) missing.push('chain.db has no measured horizons — the settlement band cannot be drawn.');
    const path = expiryPath({
      spot, hoursToExpiry: input.hoursToExpiry, atmIv: input.atmIv, horizons, ladder: l,
    });

    if (!bars5m.length) missing.push('No 5-minute bars — the momentum call cannot be made.');
    const momentum = momentumSignal({ bars5m, nowSec });

    // Which frames the ladder wanted and did not get.
    const got = new Set(l.rows.map((x) => x.tf));
    for (const tf of ['12h', '6h', '4h', '2h', '1h', '30m', '15m', '5m'] as const) {
      if (!got.has(tf)) missing.push(`${tf} has too few bars to read.`);
    }

    const read: LiveRead = {
      asOf: now,
      spot,
      ladder: l,
      readiness: r,
      path,
      momentum,
      weights: TIER_ORDER.map((tier) => ({ tier, weight: TIER_WEIGHT[tier] })),
      missing,
    };
    cache = { at: now, read };
    return read;
  })().finally(() => { inflight = null; });

  return inflight;
}

/** One strike, judged against the measured band. Cheap; the screen calls it per strike it shows. */
export function safetyOf(input: {
  cp: 'C' | 'P';
  strike: number;
  spot: number;
  hoursToExpiry: number;
  atmIv: number | null;
  path: ExpiryPath | null;
}): StrikeSafety | null {
  return strikeSafety(input);
}

/** For tests: forget the last read. */
export function resetLiveReadCache(): void {
  cache = null;
  inflight = null;
}
