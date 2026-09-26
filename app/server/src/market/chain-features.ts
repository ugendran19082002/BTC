import { migrate, type Migration } from '../db/migrate.js';
import { one, query } from '../db/pool.js';
import { marketSchema, noteOpenInterest, openInterestChange, type OiChange } from './oi-history.js';
import { liveChain, WHOLE_BOARD, type Leg, type Snapshot } from './chain.js';
import { scoreLegs, type ScoredLeg } from '../domain/score.js';
import { optionStructure, type OptionStructure } from '../domain/structure.js';
import { rowAt, quantileShare } from '../domain/outlook.js';
import { loadHorizons } from '../domain/forecast.js';
import { readMarket } from './moves.js';

/**
 * The option board as figures a measurement can use — and a record of them.
 *
 * Two jobs, both display-only:
 *
 * **The board, for the analytics service.** It sends raw marks and volumes and
 * never a verdict: the service buckets them with the very same functions that
 * labelled 735 mornings of history (`analytics/app/chain_features.py`), so a
 * measured reading can only be applied to a state defined the way it was
 * measured. Node deciding "puts are dear" here and Python deciding it there is
 * exactly how the two come apart.
 *
 * **The record, for the measurement that cannot be run yet.** chain.db has one
 * chain a day — 05:30, twelve hours before settlement — which is why only three
 * readings could be measured at all (the straddle, the skew and put/call
 * volume, over that one horizon). Open interest per strike, its change, the
 * walls, max pain and the volume-to-open-interest ratio have no history, so
 * they cannot be tested against anything and are shown as context, never as
 * odds. This writes one row every five minutes so that in a year they can be.
 *
 * Nothing on the trading path reads any of it.
 */

/** 2, 3 and 4 strikes out: far enough to be out of the money, near enough to trade. */
export const SKEW_STEPS = [2, 3, 4] as const;

/** A year of five-minute rows is about 105,000 — small, and the point of keeping them. */
const KEEP_MS = 400 * 24 * 3600_000;
const BUCKET_MS = 5 * 60_000;

const MIGRATIONS: Migration[] = [
  {
    /*
     * Three columns: how often BTC finishes above, inside and below the
     * implied 1σ band for this contract's remaining time, as measured from
     * 735 settled days.
     *
     * These are the same `above / inside / below` figures the outlook card
     * shows in real time, stored here so the series can be read back
     * ("what was the measured above% when we entered?") and eventually
     * measured against ("how often did the card say 42% and the leg expire
     * above the band?").
     *
     * All three are nullable: they are null when the implied band cannot be
     * read (no IV), when there are no measured quantiles, or when there are
     * fewer than two minutes left on the contract.
     */
    id: 'market-014-chain-band-pcts',
    up: `
      ALTER TABLE chain_features ADD COLUMN IF NOT EXISTS band_above  DOUBLE PRECISION;
      ALTER TABLE chain_features ADD COLUMN IF NOT EXISTS band_below  DOUBLE PRECISION;
      ALTER TABLE chain_features ADD COLUMN IF NOT EXISTS band_inside DOUBLE PRECISION;
    `,
  },
];

let _ready: Promise<void> | null = null;
async function chainFeaturesSchema(): Promise<void> {
  await marketSchema();
  if (_ready) return _ready;
  _ready = migrate(MIGRATIONS).then(() => {}, (e) => { _ready = null; throw e; });
  return _ready;
}

export type ChainBoard = {
  hoursLeft: number;
  callAtm: number | null;
  putAtm: number | null;
  /** marks 2, 3 and 4 strikes below the money, in that order */
  putMarks: (number | null)[];
  /** marks 2, 3 and 4 strikes above the money */
  callMarks: (number | null)[];
  /** out-of-the-money volume, each side */
  putVolume: number | null;
  callVolume: number | null;
};

const markAt = (legs: readonly Leg[], cp: 'C' | 'P', strike: number): number | null => {
  const l = legs.find((x) => x.cp === cp && x.strike === strike);
  return l && l.mark !== null && Number.isFinite(l.mark) && l.mark > 0 ? l.mark : null;
};

const sum = (legs: readonly Leg[], keep: (l: Leg) => boolean, pick: (l: Leg) => number | null): number | null => {
  let total = 0;
  let any = false;
  for (const l of legs) {
    if (!keep(l)) continue;
    const v = pick(l);
    if (v === null || !Number.isFinite(v)) continue;
    total += v;
    any = true;
  }
  return any ? total : null;
};

/**
 * The board the service is asked about.
 *
 * Out of the money on each side, which is what the history counted: puts below
 * the money, calls above it. `hoursLeft` travels with it because the straddle
 * grows with √t and the measurement was taken with twelve hours to go.
 */
export function chainBoard(
  snap: { atm: number; step: number; hoursToExpiry: number },
  legs: readonly Leg[],
): ChainBoard {
  const { atm, step } = snap;
  return {
    hoursLeft: snap.hoursToExpiry,
    callAtm: markAt(legs, 'C', atm),
    putAtm: markAt(legs, 'P', atm),
    putMarks: SKEW_STEPS.map((n) => markAt(legs, 'P', atm - n * step)),
    callMarks: SKEW_STEPS.map((n) => markAt(legs, 'C', atm + n * step)),
    putVolume: sum(legs, (l) => l.cp === 'P' && l.strike < atm, (l) => l.volume),
    callVolume: sum(legs, (l) => l.cp === 'C' && l.strike > atm, (l) => l.volume),
  };
}


/** The measured band frequencies for the contract's remaining time. */
export type ChainBandPcts = {
  /** Share of measured windows that finished above the implied 1σ band. */
  above: number | null;
  /** Share that finished below it. */
  below: number | null;
  /** Share that finished inside it (1 − above − below). */
  inside: number | null;
};

export type ChainRecord = {
  expiry: string;
  ts: number;
  spot: number;
  hoursLeft: number;
  atmIv: number | null;
  board: ChainBoard;
  /** the readings that have no history yet; recorded so that one day they will */
  pcrOi: number | null;
  pcrVolume: number | null;
  ceOi: number | null;
  peOi: number | null;
  ivSkewPts: number | null;
  ceWall: number | null;
  peWall: number | null;
  maxPain: number | null;
  /** open interest added on each side over the last hour, contracts */
  ceOiChange: number | null;
  peOiChange: number | null;
  /** how often BTC finishes above / inside / below the implied band for this contract's remaining time */
  bandPcts?: ChainBandPcts | null;
};

/**
 * Write one row per five-minute bucket per expiry.
 *
 * Throttled by asking the table, like the open-interest table beside it, and
 * wrapped whole: a board that cannot be drawn because a disposable side table
 * would not write is a board broken by its own bookkeeping.
 */
export async function noteChainFeatures(r: ChainRecord): Promise<number | null> {
  try {
    const atMs = Math.floor((r.ts * 1000) / BUCKET_MS) * BUCKET_MS;
    await chainFeaturesSchema();
    const seen = await one('SELECT 1 FROM chain_features WHERE expiry = $1 AND at = $2 LIMIT 1', [r.expiry, atMs]);
    if (seen) return null;
    const bp = r.bandPcts ?? null;
    await query(
      `INSERT INTO chain_features
       (at, expiry, spot, hours_left, atm_iv, call_atm, put_atm, put_marks, call_marks,
        put_volume, call_volume, pcr_oi, pcr_volume, ce_oi, pe_oi, iv_skew_pts,
        ce_wall, pe_wall, max_pain, ce_oi_change, pe_oi_change,
        band_above, band_below, band_inside)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       ON CONFLICT (at, expiry) DO NOTHING`,
      [
        atMs, r.expiry, r.spot, r.hoursLeft, r.atmIv, r.board.callAtm, r.board.putAtm,
        JSON.stringify(r.board.putMarks), JSON.stringify(r.board.callMarks),
        r.board.putVolume, r.board.callVolume, r.pcrOi, r.pcrVolume, r.ceOi, r.peOi, r.ivSkewPts,
        r.ceWall, r.peWall, r.maxPain, r.ceOiChange, r.peOiChange,
        bp?.above ?? null, bp?.below ?? null, bp?.inside ?? null,
      ],
    );
    await query('DELETE FROM chain_features WHERE at < $1', [atMs - KEEP_MS]);
    return atMs;
  } catch {
    return null;
  }
}

const TABLE = 'chain_features';

/** How many five-minute chains have been recorded, and since when. For the screen and the runbook. */
export async function chainHistory(): Promise<{ rows: number; since: number | null; db: string }> {
  try {
    await marketSchema();
    const r = await one<{ n: number; first: number | null }>(`SELECT COUNT(*) AS n, MIN(at) AS first FROM ${TABLE}`);
    return { rows: r?.n ?? 0, since: r?.first ?? null, db: TABLE };
  } catch {
    return { rows: 0, since: null, db: TABLE };
  }
}

/**
 * The board, recorded: what the chain route writes after it has drawn one.
 * Idempotent by five-minute bucket, so the route and the scheduled recorder
 * can both call it. The OI changes are the per-strike hour deltas the route
 * already computed; without them the change columns are null, not zero.
 */
/**
 * Compute band_above / band_below / band_inside for a snap.
 *
 * Uses the same measured-quantile lookup the outlook card does:
 * given IV and the contract's remaining time, what share of measured
 * windows finished above / inside / below the implied 1σ band?
 * Pure; null when IV or quantiles are not available.
 */
function bandPctsOf(snap: Pick<Snapshot, 'spot' | 'atmIv' | 'hoursToExpiry'>): ChainBandPcts {
  if (!snap.atmIv || !(snap.hoursToExpiry > 0)) return { above: null, below: null, inside: null };
  const minutes = snap.hoursToExpiry * 60;
  const horizons = loadHorizons();
  const m = rowAt(horizons, minutes);
  if (!m) return { above: null, below: null, inside: null };
  const implied = snap.spot * snap.atmIv * Math.sqrt(minutes / (365 * 24 * 60));
  const impliedPct = (implied / snap.spot) * 100;
  const belowShare = quantileShare(m.quantiles, -impliedPct);
  const aboveShare = quantileShare(m.quantiles, impliedPct);
  if (belowShare === null || aboveShare === null) return { above: null, below: null, inside: null };
  const above = 1 - aboveShare;
  const below = belowShare;
  const inside = Math.max(0, 1 - above - below);
  return { above, below, inside };
}

export async function recordBoard(snap: Snapshot, scored: readonly ScoredLeg[], structure: OptionStructure, oiChanges: Map<string, OiChange>): Promise<number | null> {
  const board = chainBoard(snap, scored);
  const ce = scored.filter((l) => l.cp === 'C');
  const pe = scored.filter((l) => l.cp === 'P');
  const oiSum = (legs: readonly ScoredLeg[]) => legs.reduce((t, l) => t + (l.oi ?? 0), 0);
  const oiMoved = (legs: readonly ScoredLeg[]) => legs.reduce((t, l) => t + (oiChanges.get(`${l.cp}${l.strike}`)?.change ?? 0), 0);
  return noteChainFeatures({
    expiry: snap.expiry, ts: snap.ts, spot: snap.spot, hoursLeft: snap.hoursToExpiry,
    atmIv: snap.atmIv, board,
    pcrOi: structure.pcrOi, pcrVolume: structure.pcrVolume,
    ceOi: oiSum(ce), peOi: oiSum(pe),
    ivSkewPts: structure.ivSkewPts,
    ceWall: structure.ceOiWall?.strike ?? null,
    peWall: structure.peOiWall?.strike ?? null,
    maxPain: structure.maxPain?.strike ?? null,
    ceOiChange: oiChanges.size ? oiMoved(ce) : null,
    peOiChange: oiChanges.size ? oiMoved(pe) : null,
    bandPcts: bandPctsOf(snap),
  });
}

/**
 * The board every five minutes whether or not anyone is looking: the
 * "an hour ago" reads (OI, the ATM premiums, IV) need a record that has no
 * gaps, and the chain route only writes when a browser asks for the board.
 * The nearest live expiry, the whole board, from the tickers already cached.
 */
export async function captureBoard(nowMs = Date.now(), wallWithinEm = 1.25, realisedVolPct: number | null = null): Promise<number | null> {
  const snap = await liveChain(WHOLE_BOARD);
  if (!snap.live) return null;
  const scored = scoreLegs(snap);
  await noteOpenInterest({ ...snap, atmIv: snap.atmIv }, scored);
  const oiChanges = await openInterestChange(snap, scored, 1);
  const structure = optionStructure(snap, realisedVolPct, wallWithinEm);
  void nowMs;
  // Pre-warm the measured-move table if needed, so bandPctsOf can read it.
  // The chain route always has this warmed; the scheduled recorder may not,
  // especially on startup.
  if (!loadHorizons().length) await readMarket().catch(() => {});
  return recordBoard(snap, scored, structure, oiChanges);
}
