import { exitPrice, exitValueProblem, type ExitLeg } from '@/lib/strategy-exits';

/**
 * How the ticket and Edit exits read one exit:
 *
 *   pct     a share: keep 80% of the premium / stop 150% over the entry
 *   points  a distance: 12 points under the entry / 54 over it
 *   price   the level itself: target at 4 / stop at 70
 *
 * `price` is here and not on a strategy, because only here is the entry known
 * while the exit is typed: a strategy's strike is chosen when it runs, and a
 * stop typed as 70 could sit under a 90 entry.
 */
export type TicketExitMode = 'pct' | 'points' | 'price';

/** One exit: ticked or not, how it is read, and each mode's own number -- so switching back finds it. */
export type ExitInput = { on: boolean; mode: TicketExitMode; pct: number; points: number; price: number };

/** The value in force in its own units, or zero when unticked. */
export const valueOf = (x: ExitInput): number =>
  (!x.on ? 0 : x.mode === 'points' ? x.points : x.mode === 'price' ? x.price : x.pct);

/** What the place, preview and protection calls take. The modes not in use go as zero, or not at all. */
export function exitAskOf(target: ExitInput, stop: ExitInput) {
  return {
    takeProfitPct: target.on && target.mode === 'pct' ? target.pct : 0,
    takeProfitPoints: target.on && target.mode === 'points' ? target.points : 0,
    stopLossPct: stop.on && stop.mode === 'pct' ? stop.pct : 0,
    stopLossPoints: stop.on && stop.mode === 'points' ? stop.points : 0,
    ...(target.on && target.mode === 'price' && target.price > 0 ? { takeProfitPrice: target.price } : {}),
    ...(stop.on && stop.mode === 'price' && stop.price > 0 ? { stopPrice: stop.price } : {}),
  };
}

/** The level one exit would rest at, off an entry: the typed price itself in `price` mode. */
export function levelOf(leg: ExitLeg, x: ExitInput, entry: number | null): number | null {
  if (!x.on) return null;
  if (x.mode === 'price') return x.price > 0 ? Math.round(x.price * 10) / 10 : null;
  return exitPrice(leg, x.mode, valueOf(x), entry);
}

/**
 * How far a level sits from the entry, both ways a person reads it: points and
 * per cent. "70 against a 16 entry" is +54 pts, +338%.
 */
export function distanceOf(level: number | null, entry: number | null): { points: number; pct: number } | null {
  if (level === null || entry === null || !(entry > 0)) return null;
  const points = Math.round((level - entry) * 100) / 100;
  return { points, pct: Math.round(((level - entry) / entry) * 1000) / 10 };
}

/** Why an exit as typed cannot be sent, or null. An unticked exit is never a problem. */
export function inputProblem(leg: ExitLeg, x: ExitInput, entry: number | null = null): string | null {
  if (!x.on) return null;
  if (x.mode !== 'price') return exitValueProblem(leg, x.mode, x.mode === 'points' ? x.points : x.pct);
  // The server's words (order-plan.ts exitPriceProblem), said before the button.
  if (!(x.price > 0)) return leg === 'target' ? 'Type the price to buy back at.' : 'Type the price to stop at.';
  if (entry === null) return null;
  if (leg === 'target' && !(x.price < entry)) {
    return `A target of ${x.price} must be under the ${entry} entry: a short makes money as the price falls.`;
  }
  if (leg === 'stop' && !(x.price > entry)) {
    return `A stop of ${x.price} must be over the ${entry} entry: at or under it, it fires at once.`;
  }
  return null;
}

/**
 * The patch for switching mode. Switching to `price` with no price yet starts
 * from the level the old mode meant -- 80% off 16 opens as 3.2 -- so the box
 * never opens on a zero that would read as "no exit".
 */
export function switchMode(leg: ExitLeg, x: ExitInput, mode: TicketExitMode, entry: number | null): Partial<ExitInput> {
  if (mode === 'price' && !(x.price > 0)) {
    const was = levelOf(leg, { ...x, on: true }, entry);
    return { mode, ...(was !== null ? { price: was } : {}) };
  }
  return { mode };
}
