import { candles, type Candle } from './delta.js';
import { readMarket } from './moves.js';
import { momentumSignal, type MomentumSignal } from '../domain/momentum-signal.js';

/**
 * The Live screen's momentum call, in one read.
 *
 * One snapshot, one timestamp, one set of bars: `asOf` is on the response.
 *
 * The multi-timeframe ladder, its readiness, the measured band to settlement,
 * the expiry prediction, the stability and penalty reads and the per-strike
 * safety were removed on 28 Sep 2026 with the panels that showed them. See
 * docs/TODO.md.
 */

/** Four and a half days of 5m bars: enough for the 1h break rule's sixty closed hours plus its cooldown. */
const LOOKBACK_SEC = 108 * 3600;

/**
 * How long the *bar-derived* part of the read may be reused.
 *
 * The candle fetch and the momentum call are decided at bar closes and cannot
 * change between them. The price is taken from the live tick on every request,
 * because a screen that claims to be LTP-based must not serve a twenty-second-
 * old price out of a cache.
 */
const TTL_MS = 20_000;

export type LiveRead = {
  asOf: number;
  /**
   * The **last traded price**, not a candle close. The last completed 5-minute
   * close ran 36.8 points behind the ticker on 27 Sep 2026; it is only the
   * fallback, and `spotFrom` says which one this is.
   */
  spot: number;
  /** Where `spot` came from, and how old it is. A price with no provenance is a price nobody can check. */
  spotFrom: 'ticker' | 'candle-close';
  spotAgeMs: number | null;
  /** The live momentum call, with its stop, its target and its measured record. */
  momentum: MomentumSignal;
  /** Named so the screen never has to guess why something is missing. */
  missing: string[];
};

/** The half that is decided at bar closes, and so may be reused between them. */
type BarPart = {
  momentum: MomentumSignal;
  close: number;
  missing: string[];
};

let cache: { at: number; part: BarPart } | null = null;
let inflight: Promise<BarPart> | null = null;

export async function liveRead(input: {
  now?: number;
  /**
   * The last traded price. Null falls back to the last 5-minute close, and
   * `spotFrom` says which happened.
   *
   * Signals are NOT computed from it: `momentumSignal` reads closed bars,
   * because that is what its measured record was taken on. See
   * `domain/momentum-signal.ts`.
   */
  ltp?: number | null;
  fetchBars?: (start: number, end: number) => Promise<Candle[]>;
}): Promise<LiveRead> {
  const now = input.now ?? Date.now();
  const part = await barPart(now, input.fetchBars);

  // The tick first, the candle close only as a fallback -- applied outside the
  // cache, so it is this request's price and not the price the cache was filled with.
  const usable = input.ltp != null && Number.isFinite(input.ltp) && input.ltp > 0;
  const missing = [...part.missing];
  if (!usable) missing.push('No live tick — the price is the last 5-minute close, which may be minutes old.');

  return {
    asOf: now,
    spot: usable ? input.ltp! : part.close,
    spotFrom: usable ? 'ticker' : 'candle-close',
    // The tick's own age is not exposed by `liveSpot`; null says "unknown"
    // rather than implying a freshness nobody measured.
    spotAgeMs: null,
    momentum: part.momentum,
    missing,
  };
}

/** The bar-derived half, cached for `TTL_MS` and shared between concurrent callers. */
async function barPart(
  now: number,
  fetch?: (start: number, end: number) => Promise<Candle[]>,
): Promise<BarPart> {
  if (cache && now - cache.at < TTL_MS) return cache.part;
  if (inflight) return inflight;

  const fetchBars = fetch ?? ((s: number, e: number) => candles('BTCUSD', s, e, '5m'));
  const nowSec = Math.floor(now / 1000);

  inflight = (async (): Promise<BarPart> => {
    const [market, bars5m] = await Promise.all([
      readMarket().catch(() => null),
      fetchBars(nowSec - LOOKBACK_SEC, nowSec).catch(() => [] as Candle[]),
    ]);
    const missing: string[] = [];
    if (!bars5m.length) missing.push('No 5-minute bars — the momentum call cannot be made.');
    const part: BarPart = {
      momentum: momentumSignal({ bars5m, nowSec }),
      close: market?.spot ?? bars5m[bars5m.length - 1]?.close ?? 0,
      missing,
    };
    cache = { at: now, part };
    return part;
  })().finally(() => { inflight = null; });

  return inflight;
}
