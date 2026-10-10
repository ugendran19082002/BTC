/**
 * The next 17:30 IST (12:00 UTC): the daily contract's settlement, then Delta's launch auction to 17:34. Shared by
 * the Market screen and Home's price moves, in a module of its own (10 Oct 2026) so Home does not bring Market with it.
 */
export function nextSettlement(now: number): number {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0);
  return now < today ? today : today + 86_400_000;
}
