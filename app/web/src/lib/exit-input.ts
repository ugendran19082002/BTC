import type { ExitMode } from '@/types/strategy';
import { exitPrice, exitValueProblem, type ExitLeg } from '@/lib/strategy-exits';

/**
 * One exit as the order ticket and the Edit exits sheet hold it: ticked or
 * not, read as a percentage or as fixed points, with each mode's number kept
 * so switching back finds it where it was left.
 */
export type ExitInput = { on: boolean; mode: ExitMode; pct: number; points: number };

/** The value in force: the mode's own number, or zero when unticked. */
export const valueOf = (x: ExitInput): number => (!x.on ? 0 : x.mode === 'points' ? x.points : x.pct);

/** What the place, preview and protection calls take. The unused mode goes as zero. */
export function exitAskOf(target: ExitInput, stop: ExitInput) {
  return {
    takeProfitPct: target.on && target.mode === 'pct' ? target.pct : 0,
    takeProfitPoints: target.on && target.mode === 'points' ? target.points : 0,
    stopLossPct: stop.on && stop.mode === 'pct' ? stop.pct : 0,
    stopLossPoints: stop.on && stop.mode === 'points' ? stop.points : 0,
  };
}

/** The level one exit would rest at, off an entry. */
export const levelOf = (leg: ExitLeg, x: ExitInput, entry: number | null): number | null =>
  exitPrice(leg, x.mode, valueOf(x), entry);

/** Why an exit as typed cannot be sent, or null. An unticked exit is never a problem. */
export const inputProblem = (leg: ExitLeg, x: ExitInput): string | null =>
  x.on ? exitValueProblem(leg, x.mode, x.mode === 'points' ? x.points : x.pct) : null;
