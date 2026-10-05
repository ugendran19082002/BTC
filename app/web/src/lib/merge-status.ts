import type { TradeStatus } from '@/types/trade';

/**
 * Several accounts' desks as one (5 Oct 2026): the "All accounts" tab on Positions and on P&L.
 *
 * Each account that is switched on trades on a desk of its own, with its own wallet, positions, day and limits.
 * Added together here rather than asked of the server, so each part is the same answer that account's own tab
 * shows: money and P&L are sums, positions and open trades are every account's (each trade tagged with whose it
 * is), and the day's loss budget left is each account's own limit less its own losses, added -- one account at
 * its limit does not use up another's. A figure an account cannot give (Delta's wallet on paper) leaves the sum
 * out rather than counting as nothing.
 */
export type StatusPart = { account: { id: number; name: string }; status: TradeStatus };

const sum = (xs: (number | null | undefined)[]): number => xs.reduce<number>((n, x) => n + (x ?? 0), 0);
/** A sum only when every part has the figure: a total missing one account is a wrong total. */
const sumAll = (xs: (number | null | undefined)[]): number | null =>
  (xs.length > 0 && xs.every((x) => x !== null && x !== undefined) ? sum(xs) : null);

export function mergeStatuses(parts: readonly StatusPart[]): TradeStatus | null {
  if (parts.length === 0) return null;
  const first = parts[0]!.status;
  const st = parts.map((p) => p.status);
  const todayOf = (s: TradeStatus) => s.today ?? {
    realisedUsd: s.realisedTodayUsd ?? 0, unrealisedUsd: s.unrealisedPnlUsd ?? 0, chargesUsd: 0,
    netUsd: (s.realisedTodayUsd ?? 0) + (s.unrealisedPnlUsd ?? 0),
  };
  const lostOf = (s: TradeStatus) => Math.max(0, -(s.realisedTodayUsd ?? 0));
  const totalOf = (s: TradeStatus) => (s.walletUsd != null ? s.walletUsd : null);

  return {
    ...first,
    balanceUsd: sumAll(st.map((s) => s.balanceUsd)),
    walletUsd: sumAll(st.map((s) => s.walletUsd)),
    marginUsedUsd: sumAll(st.map((s) => s.marginUsedUsd)),
    unrealisedPnlUsd: sum(st.map((s) => s.unrealisedPnlUsd)),
    realisedTodayUsd: sum(st.map((s) => s.realisedTodayUsd)),
    lossTodayUsd: sum(st.map((s) => s.today?.lossUsd ?? s.lossTodayUsd)),
    today: {
      realisedUsd: sum(st.map((s) => todayOf(s).realisedUsd)),
      unrealisedUsd: sum(st.map((s) => todayOf(s).unrealisedUsd)),
      chargesUsd: sum(st.map((s) => todayOf(s).chargesUsd)),
      netUsd: sum(st.map((s) => todayOf(s).netUsd)),
      lossUsd: sum(st.map((s) => s.today?.lossUsd ?? s.lossTodayUsd)),
      profitUsd: sum(st.map((s) => s.today?.profitUsd)),
    },
    positions: st.flatMap((s) => s.positions),
    open: parts.flatMap((p) => p.status.open.map((t) => ({ ...t, account: p.account }))),
    alarms: st.flatMap((s) => s.alarms),
    // Each account's room is its own; there is no one number for several.
    room: undefined,
    limits: {
      ...first.limits,
      maxShortContracts: sum(st.map((s) => s.limits.maxShortContracts)),
      maxLongContracts: sum(st.map((s) => s.limits.maxLongContracts ?? 0)),
      maxDailyLossUsd: sum(st.map((s) => s.limits.maxDailyLossUsd)),
    },
    combined: {
      accounts: parts.map((p) => ({
        id: p.account.id,
        name: p.account.name,
        totalUsd: totalOf(p.status),
        availableUsd: p.status.balanceUsd,
        openPnlUsd: p.status.unrealisedPnlUsd ?? 0,
        netTodayUsd: todayOf(p.status).netUsd,
        positions: p.status.open.filter((t) => t.position !== 0).length,
      })),
      lossLeftUsd: sum(st.map((s) => Math.max(0, s.limits.maxDailyLossUsd - lostOf(s)))),
      lossLimitUsd: sum(st.map((s) => s.limits.maxDailyLossUsd)),
    },
  };
}
