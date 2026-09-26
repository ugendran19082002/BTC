import type { BreakRisk } from '@/api/desk';

/**
 * What a measured break hour means for one short option (26 Sep 2026).
 *
 * The server says how far the hour after this kind of break went, as a curve:
 * the share of breaks whose hour reached k ATR the break's way, and the other
 * way. A short call is hurt by up, a short put by down; the distance is from
 * the break's close to the strike, which is where the measurement started.
 * Everything here is arithmetic on that curve -- nothing is estimated here.
 */

export type StrikeRisk = {
  strike: number;
  cp: 'C' | 'P';
  /** Points from the break's close to the strike, on the side that hurts it. Zero or less is already through. */
  distance: number;
  /** Share of measured breaks whose hour reached the strike. */
  chance: number;
  level: 'IN_THE_WAY' | 'WATCH' | 'CLEAR';
};

/** Linear between the measured steps; flat past the last. */
export function curveAt(steps: readonly number[], values: readonly number[], k: number): number {
  if (!steps.length) return 0;
  if (k <= steps[0]!) return values[0] ?? 1;
  for (let i = 1; i < steps.length; i++) {
    if (k <= steps[i]!) {
      const a = steps[i - 1]!; const b = steps[i]!;
      const t = (k - a) / (b - a);
      return values[i - 1]! + t * (values[i]! - values[i - 1]!);
    }
  }
  return values[values.length - 1] ?? 0;
}

/**
 * One in four and one in ten: the measured hour's p75 and p90, the same lines
 * the card draws. A strike inside the first is in the move's way; inside the
 * second is worth watching; outside both, this break alone is no reason to act.
 */
export const IN_THE_WAY = 0.25;
export const WATCH = 0.1;

export function strikeRisk(r: BreakRisk, strike: number, cp: 'C' | 'P'): StrikeRisk {
  const distance = cp === 'C' ? strike - r.entry : r.entry - strike;
  const hurtBy: 'UP' | 'DOWN' = cp === 'C' ? 'UP' : 'DOWN';
  const curve = hurtBy === r.side ? r.reach.with : r.reach.against;
  const chance = distance <= 0 ? 1 : curveAt(r.reach.stepsAtr, curve, distance / r.atr);
  return { strike, cp, distance, chance, level: chance >= IN_THE_WAY ? 'IN_THE_WAY' : chance >= WATCH ? 'WATCH' : 'CLEAR' };
}

/** "1 in 4", the way the card says a share. */
export function oneIn(p: number): string {
  if (p >= 0.95) return 'almost all';
  if (p <= 0.005) return 'almost none';
  const n = Math.round(1 / p);
  return n <= 1 ? 'almost all' : `1 in ${n}`;
}

/** An option symbol's strike and side: `C-BTC-84600-270926` → 84,600 CE. */
export function parseOption(symbol: string): { cp: 'C' | 'P'; strike: number } | null {
  const m = /^([CP])-BTC-(\d+)-\d{6}$/.exec(symbol);
  return m ? { cp: m[1] as 'C' | 'P', strike: Number(m[2]) } : null;
}
