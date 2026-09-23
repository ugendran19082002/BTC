import type { Leg } from '@/types/desk';

/** The strike the Live screen's panels are about: a side and a strike. */
export type Selected = { cp: 'C' | 'P'; strike: number };
export const findLeg = (legs: readonly Leg[], s: Selected | null) =>
  s ? legs.find((l) => l.cp === s.cp && l.strike === s.strike) ?? null : null;
