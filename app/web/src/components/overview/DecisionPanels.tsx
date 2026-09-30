import type { Leg } from '@/types/desk';

/**
 * The strike the Live screen is about, and finding its leg on the board. All
 * that is left of the decision panels removed on 28 Sep 2026; the screen still
 * selects a strike with it.
 */

/** The strike the Live screen's panels are about: a side and a strike. */
export type Selected = { cp: 'C' | 'P'; strike: number };
export const findLeg = (legs: readonly Leg[], s: Selected | null) =>
  s ? legs.find((l) => l.cp === s.cp && l.strike === s.strike) ?? null : null;
