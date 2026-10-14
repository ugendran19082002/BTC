/**
 * The "won at least" line both method lists filter by (owner, 14 Oct 2026: "all, profit, loss, win -- 30% by default, a
 * % I can edit; 30 shows 30 and over"): the Backtest's methods dropdown and the signal strategy form, the same rule.
 */

/** Where the line starts until it is changed. */
export const WIN_AT_LEAST_PCT = 30;

/** Whole percent, 0 to 100: what the box will take. */
export const asPct = (v: number): number => Math.min(100, Math.max(0, Math.round(Number(v)) || 0));

/**
 * A share won (0 to 1) read against a whole-percent line: at or over it, so 3 of 10 counts at 30% -- read to a
 * hundredth of a percent, never a float a hair short of it. No share (no trade) never counts.
 */
export const wonAtLeast = (rate: number | null | undefined, pct: number): boolean =>
  rate != null && Number.isFinite(rate) && Math.round(rate * 10_000) >= asPct(pct) * 100;
