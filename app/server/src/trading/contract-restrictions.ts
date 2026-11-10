/**
 * Contracts the exchange will only reduce (19 Oct 2026, the error log: Delta refused two sales of P-BTC-78800-191026
 * at 23:41 and 23:48 IST, "only_reduce_only_orders_allowed" -- one contract, not the market; the second signal sold
 * the same strike into the same refusal). Noted by the exchange adapter at the refusal; read by the strike picker,
 * which then sells the next strike out. Held for a while, not for ever: Delta lifts it, and a contract a little
 * further out may be the best again by evening. In memory: a restart forgets, and the first refusal notes it again.
 */
export const REDUCE_ONLY_HOLD_MS = 2 * 3_600_000;
const until = new Map<string, number>();

/** Note `symbol` as reduce-only from `now`. True the first time (or once a hold has run out): the time to say so. */
export function noteReduceOnly(symbol: string, now = Date.now()): boolean {
  sweep(until, now);
  const fresh = !((until.get(symbol) ?? 0) > now);
  until.set(symbol, now + REDUCE_ONLY_HOLD_MS);
  return fresh;
}
/** Whether `symbol` is held as reduce-only at `now`. */
export function isReduceOnly(symbol: string, now = Date.now()): boolean {
  return (until.get(symbol) ?? 0) > now;
}
/** A hold run out is forgotten when another is noted: a read changes nothing. */
function sweep(m: Map<string, number>, now: number): void {
  for (const [k, t] of m) if (t <= now) m.delete(k);
}
/** Every contract held as reduce-only now, with until when: for the screens and the log. */
export function reduceOnlyContracts(now = Date.now()): { symbol: string; until: number }[] {
  return [...until].filter(([s]) => isReduceOnly(s, now)).map(([symbol, t]) => ({ symbol, until: t }));
}
/*
 * A contract holding as many of the account's orders as Delta allows (19 Oct 2026, 13:32 IST: two sales of
 * C-BTC-83400-191026 refused, "max_orders_count_exceeded", with 61 of the desk's trades open on it -- each with a
 * target and a stop resting). Passed over as a reduce-only one is, for less long: the cap frees as its trades close.
 */
export const FULL_HOLD_MS = 30 * 60_000;
/*
 * Delta's own most of an account's open orders on one contract (10 Nov 2026, the error log: 309 refusals
 * "max_orders_count_exceeded" from 08:25 IST, High holding 50 protected trades on each of four strikes -- 100 orders --
 * and the 51st to 53rd sold with neither a stop nor a target behind them, the strike limit then at 20% of 300 = 60).
 * Every trade rests two orders there, its target and its stop.
 */
export const DELTA_ORDERS_PER_CONTRACT = 100;
/**
 * The most of one account's trades a contract may hold, whatever the strike limit's per cent says: both exits of each
 * resting, and four orders spare -- two entries working at once, and a close, which is an order too.
 */
export const CONTRACT_TRADES_MAX = Math.floor(DELTA_ORDERS_PER_CONTRACT / 2) - 2;
/**
 * The strike limit in force: the per cent's number (`pctCap`, null where the per cent sets none), held under
 * `CONTRACT_TRADES_MAX`; `byDelta` when it is Delta's ceiling, not the per cent, that sets it.
 */
export function strikeLimitOf(pctCap: number | null): { most: number; byDelta: boolean } {
  return pctCap !== null && pctCap <= CONTRACT_TRADES_MAX
    ? { most: pctCap, byDelta: false }
    : { most: CONTRACT_TRADES_MAX, byDelta: true };
}
const fullUntil = new Map<string, number>();
/** Note `symbol` as full of orders from `now`. True the first time (or once a hold has run out): the time to say so. */
export function noteContractFull(symbol: string, now = Date.now()): boolean {
  sweep(fullUntil, now);
  const fresh = !((fullUntil.get(symbol) ?? 0) > now);
  fullUntil.set(symbol, now + FULL_HOLD_MS);
  return fresh;
}
export function isContractFull(symbol: string, now = Date.now()): boolean {
  return (fullUntil.get(symbol) ?? 0) > now;
}
/** Whether the strike picker passes `symbol` over now: reduce-only, or full of the account's orders. */
export const isPassedOver = (symbol: string, now = Date.now()): boolean => isReduceOnly(symbol, now) || isContractFull(symbol, now);

/** For the tests. */
export function clearReduceOnly(): void { until.clear(); fullUntil.clear(); }
