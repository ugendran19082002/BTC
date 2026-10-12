/**
 * "At most open" shared between calls and puts (owner, 12 Oct 2026: "60 as 40 and 20, or 30 and 30 -- it should
 * follow the max open"). The server's rule (strategy/types.ts `sideCaps`), so the screen says before a signal what
 * the runner will hold it to.
 */

/** How many of each side may be open: the calls' share of the cap to the nearest trade, the puts the rest. Null: nothing to share. */
export function sideCaps(cap: number, cePct: number | null | undefined): { CE: number; PE: number } | null {
  if (!(cap > 0) || cePct === null || cePct === undefined) return null;
  const ce = Math.min(cap, Math.max(0, Math.round((cap * cePct) / 100)));
  return { CE: ce, PE: cap - ce };
}

/** The splits offered by name; any other whole per cent is "custom". */
export const SPLIT_PRESETS = [30, 40, 50, 60, 70] as const;

/** Why a custom share cannot be saved, in the server's words; null when it can. */
export function ceShareProblem(v: number): string | null {
  return Number.isInteger(v) && v >= 0 && v <= 100
    ? null : 'The CE share must be a whole number of per cent, from 0 to 100 -- or none, for no split.';
}
