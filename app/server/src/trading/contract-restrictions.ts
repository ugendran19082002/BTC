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
  const fresh = !((until.get(symbol) ?? 0) > now);
  until.set(symbol, now + REDUCE_ONLY_HOLD_MS);
  return fresh;
}
/** Whether `symbol` is held as reduce-only at `now`. */
export function isReduceOnly(symbol: string, now = Date.now()): boolean {
  const t = until.get(symbol);
  if (t === undefined) return false;
  if (t <= now) { until.delete(symbol); return false; }
  return true;
}
/** Every contract held as reduce-only now, with until when: for the screens and the log. */
export function reduceOnlyContracts(now = Date.now()): { symbol: string; until: number }[] {
  return [...until].filter(([s]) => isReduceOnly(s, now)).map(([symbol, t]) => ({ symbol, until: t }));
}
/** For the tests. */
export function clearReduceOnly(): void { until.clear(); }
