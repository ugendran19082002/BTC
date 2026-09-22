import type { Snapshot } from './chain.js';
import type { MarketRead } from './moves.js';
import type { OiChange } from './oi-history.js';
import type { OptionStructure } from '../domain/structure.js';
import { suddenMove, type ShockWindow, type SuddenMove } from '../domain/shock.js';

/**
 * One sudden-move reading from a live board, assembled the way the live screen
 * assembles it, from parts the chain route already holds.
 *
 * Read-only: it writes no bucket. The poller behind the chain route owns the
 * history, and a second writer filing the same board under its own clock
 * would put two rows in a five-minute bucket that is meant to hold one.
 */

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
