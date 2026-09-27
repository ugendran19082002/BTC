import { candles, type Candle } from './delta.js';
import { readMarket } from './moves.js';
import { ladder, readiness, TIER_WEIGHT, TIER_ORDER, type Ladder, type Readiness } from '../domain/hierarchy.js';
import { expiryPath, strikeSafety, type ExpiryPath, type StrikeSafety } from '../domain/expiry-path.js';
import { expiryPrediction, type ExpiryPrediction } from '../domain/expiry-prediction.js';
import { momentumSignal, type MomentumSignal } from '../domain/momentum-signal.js';
import { loadHorizons } from '../domain/forecast.js';
import { penaltiesFor, stabilityOf, type Penalty, type Stability } from '../domain/stability.js';
import { ADX_TRENDING } from '../domain/hierarchy.js';
import { recentStates } from './state-history.js';

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

/**
 * How long the *bar-derived* part of the read may be reused.
 *
 * Only the expensive, slow-moving half is cached: the candle fetch, the
 * timeframe ladder and the momentum call, all of which are decided at bar
 * closes and cannot change between them. The price and everything measured from
 * it -- the band's centre, every strike distance -- is recomputed on every
 * request from the live tick, because a screen that claims to be LTP-based must
 * not serve a twenty-second-old price out of a cache.
 */
const TTL_MS = 20_000;

export type LiveRead = {
  asOf: number;
  /**
   * The price every mark on this screen is measured from: the **last traded
   * price**, not a candle close.
   *
   * It used to be `readMarket().spot`, which is
   * `timeframes.find(t => t.tf === '5m').close` -- the last *completed*
   * five-minute candle. Measured on 27 Sep 2026 that ran 36.8 points behind the
   * ticker, so the settlement band was centred in the wrong place and a strike
   * 404 away was reported as 358. Two prices on one screen, and the wrong one
   * feeding the arithmetic.
   */
  spot: number;
  /** Where `spot` came from, and how old it is. A price with no provenance is a price nobody can check. */
  spotFrom: 'ticker' | 'candle-close';
  spotAgeMs: number | null;
  /** The weighted multi-timeframe ladder -- the screen's direction section. */
  ladder: Ladder;
  /** Whether the ladder allows a trade, and everything blocking it. */
  readiness: Readiness;
  /** The measured band to settlement. Null before the horizons table has loaded. */
  path: ExpiryPath | null;
  /**
   * Where the contract most probably settles, and the target ladder to it.
   *
   * The band's edges are measured; its percentage is modelled. They are carried
   * apart, and the screen shows them apart.
   */
  prediction: ExpiryPrediction | null;
  /** The live momentum call, with its stop, its target and its measured record. */
  momentum: MomentumSignal;
  /** The weights the ladder decided with, so the screen can print them beside the table. */
  weights: { tier: string; weight: number }[];
  /**
   * Whether the read has been holding its direction — `docs/New.md` §32.
   * Measured over the journal, which is the only record of what the screen
   * actually said. Null when the journal cannot be read.
   */
  stability: Stability | null;
  /**
   * Reasons to read the screen's confidence *down* — `docs/New.md` §33.
   *
   * Deliberately not merged into `readiness.blockers`: a blocker says "you may
   * not act", a penalty says "you may, but this is worth less than it looks".
   * Merging them turns a hard rule into a suggestion.
   */
  penalties: Penalty[];
  /** Named so the screen never has to guess why a row is missing. */
  missing: string[];
};

/** The half that is decided at bar closes, and so may be reused between them. */
type BarPart = {
  ladder: Ladder;
  readiness: Readiness;
  momentum: MomentumSignal;
  close: number;
  missing: string[];
};

let cache: { at: number; part: BarPart } | null = null;
let inflight: Promise<BarPart> | null = null;

export async function liveRead(input: {
  now?: number;
  hoursToExpiry: number;
  atmIv: number | null;
  /**
   * The last traded price. Everything that is a *mark* -- the band's centre,
   * every strike distance -- is measured from this rather than from a candle
   * close. Null falls back to the close, and `spotFrom` says which happened.
   *
   * Signals are NOT computed from it: `momentumSignal` and the state rules read
   * closed bars, because that is what their measured records were taken on. See
   * `domain/momentum-signal.ts`.
   */
  ltp?: number | null;
  /** The chain's strike step, so the predicted range lands on strikes that exist. */
  strikeStep?: number;
  fetchBars?: (start: number, end: number) => Promise<Candle[]>;
}): Promise<LiveRead> {
  const now = input.now ?? Date.now();
  const part = await barPart(now, input.fetchBars);

  /*
   * The tick first, the candle close only as a fallback -- and applied here,
   * outside the cache, so it is this request's price and not the price the cache
   * was filled with. A five-minute close can be five minutes old; on a desk
   * measuring "how far is this strike" that is a five-minute-old answer to a
   * question about now. Measured 27 Sep 2026: 36.8 points, which turned a strike
   * 404 away into one reported as 358.
   */
  const usable = input.ltp != null && Number.isFinite(input.ltp) && input.ltp > 0;
  const spot = usable ? input.ltp! : part.close;
  const spotFrom: 'ticker' | 'candle-close' = usable ? 'ticker' : 'candle-close';

  const horizons = loadHorizons();
  const missing = [...part.missing];

  /*
   * Stability over the journal rather than over anything recomputed here: the
   * rows are what the screen actually said, and a read that flip-flopped is a
   * read whose direction is noise even when every individual call was correct.
   */
  const stability = await recentStates(null, 60)
    .then((rows) => stabilityOf(
      rows.map((r) => ({ at: r.at, side: r.side === 'UP' || r.side === 'DOWN' ? r.side : null })),
      now,
    ))
    .catch(() => null);
  if (!usable) missing.push('No live tick — marks are measured from the last 5-minute close, which may be minutes old.');
  if (!horizons.length) missing.push('chain.db has no measured horizons — the settlement band cannot be drawn.');

  const path = expiryPath({
    spot, hoursToExpiry: input.hoursToExpiry, atmIv: input.atmIv, horizons, ladder: part.ladder,
  });
  const prediction = expiryPrediction({
    spot, hoursToExpiry: input.hoursToExpiry, atmIv: input.atmIv, path, strikeStep: input.strikeStep,
  });

  const adxs = part.ladder.rows.filter((r) => r.weight > 0 && r.adx !== null).map((r) => r.adx!);
  const penalties = penaltiesFor({
    against: part.ladder.against,
    spotFrom,
    missing,
    stability,
    maxAdx: adxs.length ? Math.max(...adxs) : null,
    adxFloor: ADX_TRENDING,
  });

  return {
    asOf: now,
    spot,
    spotFrom,
    stability,
    penalties,
    // The tick's own age is not exposed by `liveSpot`; null says "unknown"
    // rather than implying a freshness nobody measured.
    spotAgeMs: null,
    ladder: part.ladder,
    readiness: part.readiness,
    path,
    prediction,
    momentum: part.momentum,
    weights: TIER_ORDER.map((tier) => ({ tier, weight: TIER_WEIGHT[tier] })),
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
    const reads = market?.hierarchy ?? [];
    if (!reads.length) missing.push('No timeframe could be read — the candle feed returned nothing.');
    const l = ladder(reads);
    const r = readiness(l);

    if (!bars5m.length) missing.push('No 5-minute bars — the momentum call cannot be made.');
    const momentum = momentumSignal({ bars5m, nowSec });

    const got = new Set(l.rows.map((x) => x.tf));
    for (const tf of ['12h', '6h', '4h', '2h', '1h', '30m', '15m', '5m'] as const) {
      if (!got.has(tf)) missing.push(`${tf} has too few bars to read.`);
    }

    const part: BarPart = {
      ladder: l,
      readiness: r,
      momentum,
      close: market?.spot ?? bars5m[bars5m.length - 1]?.close ?? 0,
      missing,
    };
    cache = { at: now, part };
    return part;
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
