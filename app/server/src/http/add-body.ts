import type { AddRequest } from '../trading/engine.js';

/**
 * A person's add, as the position card sends it, checked and shaped.
 *
 * Pure and separate from the route for the reason every parser here is: the
 * objections are the part worth testing, and a route that needs a live
 * exchange to exercise its input checks is one whose input checks go untested.
 *
 * The strategy's adds pass through `strategy/add.ts` with a floor the strategy
 * chose; a person's floor is the price they typed, so nothing is ever sold
 * under what they asked for. The money gates -- margin, the short cap, the
 * daily loss, the spread -- are not here: the engine runs them, once, on the
 * preview and again on the add, and this only makes sure what reaches them is
 * a number.
 */
export type AddBody = {
  tradeId?: unknown;
  lots?: unknown;
  /** The price to start at. Absent means the offer, which the route fills in. */
  limitPrice?: unknown;
  /** Seconds to walk toward the bid. Absent means the desk's usual five. */
  chaseSeconds?: unknown;
  /** Minutes the add may work for. Absent means five. */
  timeoutMin?: unknown;
};

export type ParsedAdd = {
  tradeId: string;
  lots: number;
  limitPrice: number | null;
  chaseSeconds: number;
  timeoutMs: number;
};

/**
 * `timeoutMin` is how long the add may work before whatever is unfilled is
 * cancelled. An hour, because that is what the window is for: an add by hand
 * is "sell more of this if the price comes to me", and a five-minute window
 * answers a question nobody asked -- either it fills in the first seconds of
 * the chase or it needs long enough for the market to come back. Four hours is
 * the ceiling; the strategy's own adds carry their own windows and do not read
 * this.
 */
export const ADD_DEFAULTS = { chaseSeconds: 5, timeoutMin: 60, maxTimeoutMin: 240, maxChaseSec: 600 } as const;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Returns the objections, all at once, or the shaped request. */
export function parseAddBody(b: AddBody): { ok: true; add: ParsedAdd } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const tradeId = typeof b.tradeId === 'string' ? b.tradeId.trim() : '';
  if (!tradeId) problems.push('tradeId is required');

  const lots = num(b.lots);
  if (lots === null || !Number.isInteger(lots) || lots < 1) problems.push('Lots must be a whole number, at least 1.');

  const limitPrice = num(b.limitPrice);
  if (b.limitPrice !== undefined && b.limitPrice !== null && (limitPrice === null || !(limitPrice > 0))) {
    problems.push('The price must be a number above zero, or left blank to start at the offer.');
  }

  const chase = b.chaseSeconds === undefined ? ADD_DEFAULTS.chaseSeconds : num(b.chaseSeconds);
  if (chase === null || !Number.isInteger(chase) || chase < 0 || chase > ADD_DEFAULTS.maxChaseSec) {
    problems.push(`Chase must be a whole number of seconds from 0 to ${ADD_DEFAULTS.maxChaseSec}.`);
  }

  const timeoutMin = b.timeoutMin === undefined ? ADD_DEFAULTS.timeoutMin : num(b.timeoutMin);
  if (timeoutMin === null || !(timeoutMin > 0) || timeoutMin > ADD_DEFAULTS.maxTimeoutMin) {
    problems.push(`The window must be more than 0 and at most ${ADD_DEFAULTS.maxTimeoutMin} minutes.`);
  }

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    add: {
      tradeId,
      lots: lots!,
      limitPrice: b.limitPrice === undefined || b.limitPrice === null ? null : limitPrice,
      chaseSeconds: chase!,
      timeoutMs: Math.round(timeoutMin! * 60_000),
    },
  };
}

/** The engine's request from a parsed body and the price it starts at. */
export function toAddRequest(p: ParsedAdd, startPrice: number, maxCrossSpreadPct: number | null): AddRequest {
  return {
    size: p.lots,
    limitPrice: startPrice,
    chaseSeconds: p.chaseSeconds,
    maxCrossSpreadPct,
    // A person's floor is the price they typed: never sold under it. Starting
    // at the offer, the floor is the bid -- the walk may reach it, not pass it.
    floorPrice: p.limitPrice ?? startPrice,
    timeoutMs: p.timeoutMs,
    source: { manual: true },
  };
}
