import type { ExitRule } from '@/lib/strategy-exits';

/**
 * Where a sold option's stop can sit, and what the desk does with one asked for past that (8 Oct 2026).
 *
 * A strategy's order goes out at 200x, and there the exchange closes a short out a fixed distance over what it was
 * sold for: half of BTC over the leverage, about $203 with BTC at 81,000, whatever the premium (server:
 * `liquidationRoom` in trading/margin.ts). A stop of "300%" is under that on a $50 premium and over it on a $70
 * one; the desk holds a share or points stop to nine tenths of the room (server: `stopRoomInside` in
 * trading/order-plan.ts) rather than refuse the order. The same arithmetic here, so the form can say it before the
 * trade does: on the night the first delta strategies ran, a 300% stop showed as 251% on a $73 entry and read as
 * a mistake.
 */
export const STRATEGY_LEVERAGE = 200;
const MAINTENANCE_FRACTION = 0.5;
export const STOP_INSIDE_CLOSE_OUT = 0.9;

/** How far over its entry a short is closed out at the strategies' leverage, in the option's own price. */
export const closeOutRoom = (spot: number): number => (spot * (1 - MAINTENANCE_FRACTION)) / STRATEGY_LEVERAGE;

/** The furthest over its entry a strategy's share or points stop is placed: nine tenths of the room, rounded down to the tick. */
export const stopHold = (spot: number): number => Math.floor(closeOutRoom(spot) * STOP_INSIDE_CLOSE_OUT * 10) / 10;

export type StopHoldNote = {
  /** The close-out's distance over the entry, and the hold inside it. */
  room: number; hold: number;
  /** A share stop stands as asked on an entry up to this premium; null for a points stop. */
  fitsUpTo: number | null;
  /** A points stop is itself past the hold, so every trade's stop is held. Always false for a share. */
  alwaysHeld: boolean;
};

/**
 * What to say under a sold strategy's stop: nothing for no stop, or one typed as a price (that is judged as
 * typed), or without BTC's price to work the room out from.
 */
export function stopHoldNote(rule: Pick<ExitRule, 'mode' | 'value'>, spot: number | null | undefined): StopHoldNote | null {
  if (!spot || !(spot > 0) || !(rule.value > 0) || rule.mode === 'price') return null;
  const room = closeOutRoom(spot);
  const hold = stopHold(spot);
  if (rule.mode === 'points') return { room, hold, fitsUpTo: null, alwaysHeld: rule.value > hold };
  return { room, hold, fitsUpTo: Math.floor((hold / rule.value) * 10) / 10, alwaysHeld: false };
}

/** The stop a strategy trade gets on an entry: as asked, or held. For the form's worked example. */
export function heldStopFor(entry: number, rule: Pick<ExitRule, 'mode' | 'value'>, spot: number): { stop: number; asked: number; held: boolean } {
  const asked = rule.mode === 'points' ? entry + rule.value : entry * (1 + rule.value);
  const cap = Math.floor((entry + stopHold(spot)) * 10 + 1e-9) / 10;
  return asked > cap ? { stop: cap, asked, held: true } : { stop: Math.round(asked * 10) / 10, asked, held: false };
}
