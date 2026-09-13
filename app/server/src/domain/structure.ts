import type { Snapshot, Leg } from '../market/chain.js';
import { LOT_BTC } from './score.js';

/**
 * What the option board itself is saying: where open interest and gamma sit,
 * how puts are priced against calls, and whether options are rich or cheap
 * against what BTC has actually been doing.
 *
 * All of it is description. None of it is wired into the recommendation,
 * because none of it survived the screen in feature_screen.py -- see TODO.md
 * for what was tested and rejected. It is here so the reader can see the board,
 * not so the engine can quietly start trading it.
 */

export type Wall = { strike: number; value: number } | null;

/** The strike where the open options are worth least to the people holding them. */
export type MaxPain = { strike: number; payoutUsd: number } | null;

/**
 * The band between the heaviest put strike and the heaviest call strike.
 *
 * It is where open interest sits, which is not the same fact as where BTC will
 * finish, and the screen says so. Kept because the two walls are the levels
 * traders actually watch, and reading them off a table of two dozen strikes is
 * work the page can do instead.
 */
export type OiRange = { low: number; high: number; widthUsd: number; widthPct: number } | null;

export type OptionStructure = {
  ceOi: number;
  peOi: number;
  ceVolume: number;
  peVolume: number;
  pcrOi: number | null;
  pcrVolume: number | null;
  /** where open interest is heaviest on each side */
  ceOiWall: Wall;
  peOiWall: Wall;
  /** gamma x open interest, summed per strike across both sides */
  gammaWall: Wall;
  atmIv: number | null;
  /** put IV minus call IV at roughly 25 delta, in percentage points */
  ivSkewPts: number | null;
  /** implied minus realised, in percentage points; positive means options are rich */
  volPremiumPts: number | null;
  /** the strike that would leave option holders with the smallest payout */
  maxPain: MaxPain;
  /** heaviest put strike up to heaviest call strike */
  oiRange: OiRange;
  /** one, two and three standard deviations by settlement */
  ranges: { sigma: number; low: number; high: number }[];
};

function nearestDelta(legs: Leg[], target: number): Leg | null {
  const withDelta = legs.filter((l) => l.delta !== null && l.iv !== null);
  if (!withDelta.length) return null;
  return withDelta.reduce((a, b) =>
    Math.abs(Math.abs(b.delta!) - target) < Math.abs(Math.abs(a.delta!) - target) ? b : a,
  );
}

function heaviest(legs: Leg[], pick: (l: Leg) => number | null): Wall {
  let best: Wall = null;
  for (const l of legs) {
    const v = pick(l);
    if (v === null || !Number.isFinite(v)) continue;
    if (best === null || v > best.value) best = { strike: l.strike, value: v };
  }
  return best;
}

/**
 * Max pain: the settlement price at which the open options pay out least.
 *
 * Every listed strike is tried as a settlement price and the intrinsic value of
 * every other strike is totalled against it, weighted by open interest. The
 * smallest total wins.
 *
 * It is widely read as a magnet and this desk does not treat it as one -- it is
 * a summary of where the open contracts sit, and it moves whenever the open
 * interest does. Nothing reads it but the screen.
 */
function maxPainStrike(legs: Leg[]): MaxPain {
  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const priced = legs.filter((l) => l.oi !== null && Number.isFinite(l.oi));
  if (strikes.length < 2 || !priced.length) return null;

  let best: MaxPain = null;
  for (const settle of strikes) {
    let payoutUsd = 0;
    for (const l of priced) {
      const intrinsic = l.cp === 'C'
        ? Math.max(0, settle - l.strike)
        : Math.max(0, l.strike - settle);
      payoutUsd += l.oi! * intrinsic * LOT_BTC;
    }
    if (best === null || payoutUsd < best.payoutUsd) best = { strike: settle, payoutUsd };
  }
  return best;
}

/** The band between the two walls, when they are the right way round. */
function oiRangeOf(peWall: Wall, ceWall: Wall, spot: number): OiRange {
  if (!peWall || !ceWall || peWall.strike >= ceWall.strike) return null;
  const widthUsd = ceWall.strike - peWall.strike;
  return {
    low: peWall.strike,
    high: ceWall.strike,
    widthUsd,
    widthPct: spot > 0 ? (widthUsd / spot) * 100 : 0,
  };
}

export function optionStructure(
  snap: Snapshot,
  realisedVolPct: number | null,
): OptionStructure {
  const ce = snap.legs.filter((l) => l.cp === 'C');
  const pe = snap.legs.filter((l) => l.cp === 'P');
  const sum = (xs: Leg[], f: (l: Leg) => number | null) =>
    xs.reduce((a, l) => a + (f(l) ?? 0), 0);

  const ceOi = sum(ce, (l) => l.oi);
  const peOi = sum(pe, (l) => l.oi);
  const ceVolume = sum(ce, (l) => l.volume);
  const peVolume = sum(pe, (l) => l.volume);

  // gamma exposure is a property of the strike, not of one side
  const byStrike = new Map<number, number>();
  for (const l of snap.legs) {
    if (l.gammaExposure === null) continue;
    byStrike.set(l.strike, (byStrike.get(l.strike) ?? 0) + l.gammaExposure);
  }
  let gammaWall: Wall = null;
  for (const [strike, value] of byStrike) {
    if (gammaWall === null || value > gammaWall.value) gammaWall = { strike, value };
  }

  const c25 = nearestDelta(ce, 0.25);
  const p25 = nearestDelta(pe, 0.25);
  const ivSkewPts =
    c25?.iv != null && p25?.iv != null ? (p25.iv - c25.iv) * 100 : null;

  const em = snap.expectedMove;
  const ranges = em === null
    ? []
    : [1, 2, 3].map((sigma) => ({
        sigma,
        low: snap.spot - em * sigma,
        high: snap.spot + em * sigma,
      }));

  const ceOiWall = heaviest(ce, (l) => l.oi);
  const peOiWall = heaviest(pe, (l) => l.oi);

  return {
    ceOi,
    peOi,
    ceVolume,
    peVolume,
    pcrOi: ceOi > 0 ? peOi / ceOi : null,
    pcrVolume: ceVolume > 0 ? peVolume / ceVolume : null,
    ceOiWall,
    peOiWall,
    gammaWall,
    maxPain: maxPainStrike(snap.legs),
    oiRange: oiRangeOf(peOiWall, ceOiWall, snap.spot),
    atmIv: snap.atmIv,
    ivSkewPts,
    volPremiumPts:
      snap.atmIv !== null && realisedVolPct !== null
        ? snap.atmIv * 100 - realisedVolPct
        : null,
    ranges,
  };
}
