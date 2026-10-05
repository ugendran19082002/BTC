import type { Trade } from '@/types/trade';

/**
 * A bought option's target and stop as prices, off the price paid (the server's `longLevels`): the target over
 * it, the stop under it. Null for a leg that is off, and for a short, which keeps its levels on the plan itself.
 */
export function longLevels(plan: Trade['plan'] | null | undefined, entry: number | null): { target: number | null; stop: number | null } {
  const own = plan?.longExits;
  if (!own || entry === null || !(entry > 0)) return { target: null, stop: null };
  const levelOf = (r: { mode: string; value: number } | null | undefined, up: boolean): number | null =>
    (!r || !(r.value > 0) ? null
      : r.mode === 'pct' ? entry * (1 + (up ? r.value : -r.value))
        : r.mode === 'points' ? entry + (up ? r.value : -r.value) : r.value);
  return { target: levelOf(own.target, true), stop: levelOf(own.stop, false) };
}

/** Bought to open: by the plan, or -- on a record without one -- by its entry fills being buys. */
export const isLongTrade = (t: Pick<Trade, 'plan' | 'fills'>): boolean =>
  t.plan?.action === 'buy' || (t.fills ?? []).some((f) => f.role === 'entry' && f.side === 'buy');
