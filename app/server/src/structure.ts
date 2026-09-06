import type { Snapshot, Leg } from './chain.js';

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

  return {
    ceOi,
    peOi,
    ceVolume,
    peVolume,
    pcrOi: ceOi > 0 ? peOi / ceOi : null,
    pcrVolume: ceVolume > 0 ? peVolume / ceVolume : null,
    ceOiWall: heaviest(ce, (l) => l.oi),
    peOiWall: heaviest(pe, (l) => l.oi),
    gammaWall,
    atmIv: snap.atmIv,
    ivSkewPts,
    volPremiumPts:
      snap.atmIv !== null && realisedVolPct !== null
        ? snap.atmIv * 100 - realisedVolPct
        : null,
    ranges,
  };
}
