import { hoursSinceDeskOpen, type Snapshot } from './chain.js';
import { readMarket, type MarketRead } from './moves.js';
import { openInterestChange, ivChange, type OiChange, type OiSnapshotLeg } from './oi-history.js';
import { optionStructure, type OptionStructure } from '../domain/structure.js';
import { suddenMove, type ShockWindow, type SuddenMove } from '../domain/shock.js';

/**
 * One sudden-move reading from a live board, assembled the way the live screen
 * assembles it.
 *
 * Two callers need this reading and they arrive from opposite directions. The
 * chain route already holds the market, the structure, the open-interest
 * changes and the IV change, because it returns them; the strategy gate holds a
 * snapshot and nothing else. Two assemblies of the same reading is how a gate
 * ends up refusing on a figure that is not the one on screen, so the shaping
 * lives in `shockFrom` and both go through it — the route with what it has, the
 * gate through `shockNow`, which fetches the rest.
 *
 * Read-only: neither writes a bucket. The poller behind the chain route owns
 * the history, and a second writer filing the same board under its own clock
 * would put two rows in a five-minute bucket that is meant to hold one.
 */
export const SHOCK_GATE_WINDOW: ShockWindow = 5;

/** The reading, from parts the caller already has. */
export function shockFrom(i: {
  snap: Pick<Snapshot, 'spot' | 'atmIv'>;
  market: MarketRead | null;
  structure: OptionStructure;
  oiChanges: Map<string, OiChange>;
  iv: { changePct: number; overMinutes: number; from: number; to: number } | null;
  window: ShockWindow;
}): SuddenMove {
  return suddenMove({
    spot: i.snap.spot,
    atmIv: i.snap.atmIv,
    market: i.market,
    structure: i.structure,
    oiChanges: i.oiChanges,
    iv: i.iv,
    window: i.window,
  });
}

/** The reading, from a snapshot alone. Fetches what it does not have. */
export async function shockNow(
  snap: Snapshot,
  legs: readonly OiSnapshotLeg[],
  window: ShockWindow = SHOCK_GATE_WINDOW,
): Promise<SuddenMove> {
  // The same span the chain route asks for: what has happened since the desk's
  // day began at 05:30 IST, rather than a fixed day of history.
  const market = await readMarket(hoursSinceDeskOpen(snap.ts)).catch(() => null);
  const iv = await ivChange({ expiry: snap.expiry, ts: snap.ts, atmIv: snap.atmIv }, 15);

  return shockFrom({
    snap,
    market,
    structure: optionStructure(snap, market?.realisedVol ?? null),
    oiChanges: await openInterestChange(snap, legs, 1),
    iv: iv && { changePct: iv.changePct, overMinutes: iv.overMinutes, from: iv.from, to: iv.to },
    window,
  });
}
