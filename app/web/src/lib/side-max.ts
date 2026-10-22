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

/**
 * The most open at once on one strike (owner's list #1, 22 Oct 2026), a per cent of "at most open" as each side's is
 * (owner: "strike max as a %, based on max open"); the server's rule (strategy/types.ts `strikeCapOf`): 10% where none
 * is chosen, to the nearest trade and at least one; 100% is no limit of its own, and so is no "at most open".
 */
export const STRIKE_MAX_DEFAULT_PCT = 10;
export const STRIKE_MAX_PRESETS = [5, 10, 15, 20, 30, 50, 100] as const;
export function strikeCapOf(cap: number, pct: number): number | null {
  if (!(cap > 0) || pct >= 100) return null;
  return Math.min(cap, Math.max(1, Math.round((cap * pct) / 100)));
}
/** Why the most on one strike cannot be saved, in the server's words; null when it can. */
export function strikeMaxProblem(v: number): string | null {
  return Number.isInteger(v) && v >= 1 && v <= 100 ? null : 'The most on one strike must be a whole number of per cent of "at most open", from 1 to 100.';
}
/** "PE 83000" for "P-BTC-83000-221026". */
export const strikeWords = (symbol: string): string => {
  const m = /^([CP])-BTC-(\d+)-/.exec(symbol);
  return m ? `${m[1] === 'C' ? 'CE' : 'PE'} ${m[2]}` : symbol;
};
