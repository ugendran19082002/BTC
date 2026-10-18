import type { BacktestParams, BreakEven, Tsl, TslUnit } from '@/types/signal-backtest';

/**
 * A trailing SL on the backtest's option stop (owner, 18 Oct 2026: "TSL in the backtest -- points and per cent; as
 * the price moves from the entry, the SL moves"): every `move` the premium falls from the price sold, the stop comes
 * down `by`, each in premium points or a per cent of the price sold; never back up. The server's rules
 * (`report/signal-backtest.ts`), in its words, so the screen says what the server would refuse before it asks.
 */
export const TSL_MAX: Record<TslUnit, number> = { pts: 1_000, pct: 100 };
export const TSL_DEFAULT: Tsl = { move: 5, moveUnit: 'pts', by: 5, byUnit: 'pts' };

export function tslProblems(t: Tsl, stopPct: number): string[] {
  const bad: string[] = [];
  for (const [v, u, what] of [[t.move, t.moveUnit, 'The price move'], [t.by, t.byUnit, 'The SL move']] as const) {
    if (!(Number.isFinite(v) && v > 0 && v <= TSL_MAX[u])) bad.push(`${what} is more than 0 and at most ${u === 'pts' ? `${TSL_MAX.pts} points` : '100%'}.`);
  }
  if (!bad.length && t.moveUnit === t.byUnit && t.by > t.move) bad.push('The SL cannot move further than the price did: the SL move must be at most the price move.');
  if (!(stopPct > 0)) bad.push('A trailing SL needs an option stop to move: set the option stop.');
  return bad;
}

/** The setting as the server reads it, `5pts:5pts`; null where it is off or wrong (the editor says what is wrong). */
export function tslQuery(p: Pick<BacktestParams, 'tsl' | 'stopPct'>): string | null {
  const t = p.tsl;
  return t && !tslProblems(t, p.stopPct).length ? `${t.move}${t.moveUnit}:${t.by}${t.byUnit}` : null;
}

const amount = (v: number, u: TslUnit) => (u === 'pts' ? `${v} pt${v === 1 ? '' : 's'}` : `${v}%`);
/** "TSL every 5 pts → SL −5 pts": short, for the settings' lines. */
export const tslWords = (t: Tsl | null | undefined): string | null => (t ? `TSL every ${amount(t.move, t.moveUnit)} → SL −${amount(t.by, t.byUnit)}` : null);

/**
 * The rule worked through on a premium, so it reads as the trader will see it: sold at `entry` with the stop at
 * `stop`, the premium at each of three lower prices and where the stop then stands. The server's step (`tslTrail`).
 */
export function tslExample(t: Tsl, entry: number, stop: number): { premium: number; stop: number }[] {
  const step = (v: number, u: TslUnit) => (u === 'pts' ? v : (v / 100) * entry);
  const move = step(t.move, t.moveUnit), by = step(t.by, t.byUnit);
  if (!(move > 0)) return [];
  const out: { premium: number; stop: number }[] = [];
  for (let k = 1; k <= 3 && entry - k * move > 0; k++) out.push({ premium: entry - k * move, stop: stop - k * by });
  return out;
}

/** The break-even's rule, the server's words (`breakEvenProblems`): [] when right. */
export function breakEvenProblems(b: BreakEven): string[] {
  return Number.isFinite(b.move) && b.move > 0 && b.move <= TSL_MAX[b.unit] ? [] : [`The move to break-even is more than 0 and at most ${b.unit === 'pts' ? `${TSL_MAX.pts} points` : '100%'}.`];
}
/** The break-even as the server reads it, `10pct`; null where it is off or wrong. */
export const breakEvenQuery = (b: BreakEven | null | undefined): string | null => (b && !breakEvenProblems(b).length ? `${b.move}${b.unit}` : null);
/** "SL to entry after 10%": a few words; null with none. */
export const breakEvenWords = (b: BreakEven | null | undefined): string | null => (b ? `SL to entry after ${amount(b.move, b.unit)}` : null);
export const BREAK_EVEN_DEFAULT: BreakEven = { move: 25, unit: 'pct' };

/** The most the perp's widening may ask for, in ATRs of the 1m candles (the server's `WIDEN_ATR_MAX`). */
export const WIDEN_ATR_MAX = 100;
