/**
 * Money in and out of each account (owner, 20 Nov 2026: "ledger total withdraw, total investment add, user friendly,
 * phone side"), worked out from the wallet entries every ledger day already keeps (`ledger_days.delta.byType`) -- nothing
 * asked of Delta. In: deposits and money moved in from another account; out: withdrawals and money moved out. Trading,
 * charges, funding and settlement are not money in or out, they are what the money did.
 *
 * A day synced before 20 Nov kept one net figure a type, so a day with money both in and out of one kind shows only the
 * difference; a day synced since keeps both (`inUsd` / `outUsd`, wallet.ts). "Balance" is the wallet after the last
 * entry of the latest day read -- Delta's own figure, margin in use included -- and "profit" is that less what was put
 * in net: what the money has made, as the wallet stood then.
 */
import { rows } from '../db/pool.js';

/** The wallet entry types that are money in or out, by Delta's names: the sign of each says which. */
export const MONEY_TYPES: readonly string[] = [
  'deposit', 'external_deposit', 'fund_deposit', 'fund_wallet_deposit',
  'withdrawal', 'withdrawal_cancellation', 'fund_withdrawal', 'fund_wallet_withdrawal',
  'sub_account_transfer',
];

type TypeSum = { n: number; usd: number; inUsd?: number; outUsd?: number };
export type FlowDay = { account: number; day: string; byType: Record<string, TypeSum> | null; closingUsd: number | null };
export type Flows = {
  /** Money put in (deposits, money moved in), in dollars; a positive number. */
  inUsd: number;
  /** Money taken out (withdrawals, money moved out), in dollars; a positive number. */
  outUsd: number;
  /** In less out. */
  netUsd: number;
  /** How many movements, in and out. */
  moves: number;
  /** The first and last day with any money in or out; null with none. */
  firstMoveDay: string | null;
  lastMoveDay: string | null;
};

const ZERO: Flows = { inUsd: 0, outUsd: 0, netUsd: 0, moves: 0, firstMoveDay: null, lastMoveDay: null };

/** The money in and out over the days given (any accounts). Pure: what the route and the tests both run. */
export function flowsOf(days: readonly FlowDay[]): Flows {
  const out: Flows = { ...ZERO };
  for (const d of [...days].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
    let moved = false;
    for (const type of MONEY_TYPES) {
      const t = d.byType?.[type];
      if (!t || !(t.n > 0)) continue;
      // Kept gross since 20 Nov 2026; before it, one net figure: its sign says which way.
      const inUsd = typeof t.inUsd === 'number' ? t.inUsd : Math.max(0, t.usd);
      const outUsd = typeof t.outUsd === 'number' ? t.outUsd : Math.max(0, -t.usd);
      if (inUsd === 0 && outUsd === 0) continue;
      out.inUsd += inUsd;
      out.outUsd += outUsd;
      out.moves += t.n;
      moved = true;
    }
    if (moved) {
      out.firstMoveDay ??= d.day;
      out.lastMoveDay = d.day;
    }
  }
  out.netUsd = out.inUsd - out.outUsd;
  return out;
}

/** The wallet as the latest day read left it, per account, summed: and that day (the earliest of them, every account). */
export function walletOf(days: readonly FlowDay[]): { balanceUsd: number | null; asOf: string | null; accounts: number } {
  const latest = new Map<number, FlowDay>();
  for (const d of days) {
    if (d.closingUsd === null || !Number.isFinite(d.closingUsd)) continue;
    const was = latest.get(d.account);
    if (!was || d.day > was.day) latest.set(d.account, d);
  }
  if (!latest.size) return { balanceUsd: null, asOf: null, accounts: 0 };
  const all = [...latest.values()];
  return {
    balanceUsd: all.reduce((n, d) => n + d.closingUsd!, 0),
    asOf: all.reduce((m, d) => (d.day < m ? d.day : m), all[0]!.day),
    accounts: all.length,
  };
}

/**
 * The ledger's money in and out for one account (or every account, `null`): since the first day read, and over
 * `from`..`to`; the wallet as last read, and what the money has made against it.
 */
export async function ledgerFlows(account: number | null, from: string, to: string) {
  const rs = await rows<{ broker_account_id: string | number; day: string; by_type: Record<string, TypeSum> | null; closing: string | number | null }>(
    `SELECT broker_account_id, day, delta->'byType' AS by_type, delta->>'closingUsd' AS closing
       FROM ledger_days
      WHERE delta IS NOT NULL AND ($1::bigint IS NULL OR broker_account_id = $1)`,
    [account],
  );
  const days: FlowDay[] = rs.map((r) => ({
    account: Number(r.broker_account_id), day: String(r.day), byType: r.by_type,
    closingUsd: r.closing === null || r.closing === undefined ? null : Number(r.closing),
  }));
  const allTime = flowsOf(days);
  const range = flowsOf(days.filter((d) => d.day >= from && d.day <= to));
  const wallet = walletOf(days);
  const since = days.reduce<string | null>((m, d) => (m === null || d.day < m ? d.day : m), null);
  return {
    account, from, to, since, daysRead: days.length,
    allTime, range,
    wallet,
    /** The wallet less what was put in net: what the money has made, as the wallet stood on `wallet.asOf`. */
    profitUsd: wallet.balanceUsd === null ? null : wallet.balanceUsd - allTime.netUsd,
  };
}
