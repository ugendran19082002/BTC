/**
 * Each side's own limit under "at most open" (owner, 12 Oct 2026: "CE max 80% and PE max 80%, each on its own --
 * not a split that adds up to 100"; "default 80%"). The server's rule (strategy/types.ts `sideCaps`), so the screen
 * says before a signal what the runner will hold it to.
 */
export type Side = 'CE' | 'PE';

/** A side's most where none has been chosen. */
export const SIDE_MAX_DEFAULT_PCT = 80;

/**
 * How many trades each side may hold: its per cent of the limit to the nearest trade, at least one where the per
 * cent is above nothing. Null where there is no limit: nothing to take a per cent of.
 */
export function sideCaps(cap: number, pct: { CE: number; PE: number }): { CE: number; PE: number } | null {
  if (!(cap > 0)) return null;
  const of = (p: number) => (p <= 0 ? 0 : Math.min(cap, Math.max(1, Math.round((cap * p) / 100))));
  return { CE: of(pct.CE), PE: of(pct.PE) };
}

/** The limits offered by name; any other whole per cent is "custom". 100 is the whole limit: none of a side's own. */
export const SIDE_MAX_PRESETS = [50, 60, 70, 80, 90, 100] as const;

/** Why a side's most cannot be saved, in the server's words; null when it can. */
export function sideMaxProblem(v: number): string | null {
  return Number.isInteger(v) && v >= 0 && v <= 100
    ? null : 'A side\'s limit must be a whole number of per cent of "at most open", from 0 to 100.';
}
