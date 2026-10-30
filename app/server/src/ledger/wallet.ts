import { signedPage, type Creds } from '../delta/signed.js';

/**
 * Delta's own record of an account's money, a day at a time (owner, 29 Oct 2026: "my system and the Delta app's P&L,
 * reconciled -- checked every day at 11:59 PM, and synced by hand"). Read from `GET /v2/wallet/transactions` (its API
 * reference, Wallet): every entry on the wallet -- commission on a fill, a settlement, a cash credit or debit, funding,
 * a deposit -- with the balance after it.
 *
 * Nothing here assumes how Delta books an option (decision 0002): which type carries a premium, and whether a fee is a
 * negative amount or a positive debit, are not in its reference. So the day is read whole, and split by what an entry
 * is, not by what it is thought to carry:
 *
 *   - **trading** -- everything a trade moves: cash credits and debits, settlements, fill appropriations;
 *   - **charges** -- commission and fees, less rebates and fee credits;
 *   - **funding** -- the perpetual's funding (the desk trades options; said apart so it is never hidden);
 *   - **transfers** -- money moved in or out (deposits, withdrawals, sub-account and fund transfers): not P&L;
 *   - **others** -- credits Delta grants (bonuses, rewards, interest, compensation): money, but not trading.
 *
 * And each type's sign is read off Delta's own balance column: an entry whose balance moved by minus its amount is a
 * debit written positive, and is counted so.
 */

export type Bucket = 'trading' | 'charges' | 'funding' | 'transfers' | 'others';

const TYPES: Record<Bucket, readonly string[]> = {
  trading: ['cashflow', 'settlement', 'fill_appropriation', 'spot_trade'],
  charges: ['commission', 'liquidation_fee', 'commission_rebate', 'trading_credits_paid', 'trading_fee_credits_paid_liquidation_fee', 'trading_credits_reverted'],
  funding: ['funding'],
  transfers: ['deposit', 'withdrawal', 'withdrawal_cancellation', 'sub_account_transfer', 'external_deposit', 'conversion', 'credit_line',
    'fund_deposit', 'fund_withdrawal', 'fund_wallet_deposit', 'fund_wallet_withdrawal'],
  others: ['referral_bonus', 'promo_credit', 'trading_credits', 'trading_credits_forfeited', 'interest_credit', 'trading_competition',
    'fund_reward', 'trade_farming_reward', 'revert', 'raf_bonus', 'incident_compensation'],
};
const BUCKET_OF = new Map<string, Bucket>(Object.entries(TYPES).flatMap(([b, ts]) => ts.map((t) => [t, b as Bucket] as const)));
/** A type Delta adds later is counted with the others, and named, so it is seen rather than guessed at. */
export const bucketOf = (type: string): { bucket: Bucket; known: boolean } => {
  const b = BUCKET_OF.get(type);
  return b ? { bucket: b, known: true } : { bucket: 'others', known: false };
};

/** The assets an account's money is kept in on Delta India: entries in any other are counted apart, never added in. */
const USD = new Set(['USD', 'USDT', 'USDC']);

/**
 * A moment as Delta writes one, in ms: its order replies carry `created_at` as microseconds in a string
 * ("1725865012000000", its API reference), its product listings an ISO time. A number is read by its size --
 * microseconds, milliseconds or seconds -- and anything else as a date; null when it is neither. (29 Oct 2026: the
 * first live checks read one wallet entry a day where the desk had hundreds of fills, and `Date.parse` of a
 * microsecond string is NaN.)
 */
export function timeOf(v: unknown): number | null {
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n >= 1e15 ? Math.floor(n / 1_000) : n >= 1e12 ? Math.floor(n) : Math.floor(n * 1_000);
  }
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * What a day's read was, kept with the check: how many pages, how many rows Delta gave, how many were the day's, how
 * many fell outside it or had no time that could be read, and the first and last times as Delta wrote them -- so a day
 * that does not add up can be traced to the read, not guessed at.
 */
export type WalletRead = { pages: number; rows: number; kept: number; outside: number; unparsed: number; firstAt: string | null; lastAt: string | null };

/** One wallet entry as Delta gives it. */
export type WalletEntry = { id: string; at: number; type: string; amount: number; balance: number; asset: string };

export type WalletDay = {
  /** trading + charges + funding: the day's money from trading, the figure the desk's own net is checked against. */
  netUsd: number;
  tradingUsd: number;
  /** Charges as Delta booked them, a negative number for money paid. */
  chargesUsd: number;
  fundingUsd: number;
  othersUsd: number;
  transfersUsd: number;
  /** The balance before the day's first entry and after its last; null with no entry. */
  openingUsd: number | null;
  closingUsd: number | null;
  entries: number;
  /** Each type: how many, and what they came to -- so a figure that does not match can be traced to its kind. */
  byType: Record<string, { n: number; usd: number }>;
  /** Types not in the list above, counted with the others. */
  unknownTypes: string[];
  /** Entries in another asset, left out of every figure. */
  otherAssets: number;
  /** False when the pages ran past the ceiling: the figures are of what was read. */
  complete: boolean;
  /** How the day was read (`readWallet`); absent where the entries were handed in. */
  read?: WalletRead;
};

/**
 * Each type's sign, from the balance: sorted by time, an entry's balance less the one before is its amount (+1) or
 * minus its amount (−1). The type takes the sign most of its entries show; one never measured is +1.
 */
export function signsOf(entries: readonly WalletEntry[]): Map<string, 1 | -1> {
  const votes = new Map<string, { plus: number; minus: number }>();
  const sorted = [...entries].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  for (let i = 1; i < sorted.length; i++) {
    const e = sorted[i]!, before = sorted[i - 1]!;
    if (e.asset !== before.asset || e.amount === 0) continue;
    const moved = e.balance - before.balance;
    const eps = Math.max(1e-9, Math.abs(e.amount) * 1e-6);
    const v = votes.get(e.type) ?? { plus: 0, minus: 0 };
    if (Math.abs(moved - e.amount) <= eps) v.plus += 1;
    else if (Math.abs(moved + e.amount) <= eps) v.minus += 1;
    votes.set(e.type, v);
  }
  return new Map([...votes].map(([t, v]) => [t, v.minus > v.plus ? -1 : 1] as const));
}

/** A day of entries summed into its buckets. Pure: what the reader below and the tests both run. */
export function walletDayOf(entries: readonly WalletEntry[], complete = true, read?: WalletRead): WalletDay {
  const usd = entries.filter((e) => USD.has(e.asset));
  const signs = signsOf(usd);
  const day: WalletDay = {
    netUsd: 0, tradingUsd: 0, chargesUsd: 0, fundingUsd: 0, othersUsd: 0, transfersUsd: 0,
    openingUsd: null, closingUsd: null, entries: usd.length, byType: {}, unknownTypes: [], otherAssets: entries.length - usd.length, complete,
    ...(read ? { read } : {}),
  };
  const unknown = new Set<string>();
  for (const e of usd) {
    const amount = e.amount * (signs.get(e.type) ?? 1);
    const { bucket, known } = bucketOf(e.type);
    if (!known) unknown.add(e.type);
    const key = `${bucket === 'trading' ? 'tradingUsd' : bucket === 'charges' ? 'chargesUsd' : bucket === 'funding' ? 'fundingUsd' : bucket === 'transfers' ? 'transfersUsd' : 'othersUsd'}` as const;
    day[key] += amount;
    const t = day.byType[e.type] ?? (day.byType[e.type] = { n: 0, usd: 0 });
    t.n += 1; t.usd += amount;
  }
  day.netUsd = day.tradingUsd + day.chargesUsd + day.fundingUsd;
  day.unknownTypes = [...unknown].sort();
  if (usd.length) {
    const sorted = [...usd].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    const first = sorted[0]!, last = sorted[sorted.length - 1]!;
    day.openingUsd = first.balance - first.amount * (signs.get(first.type) ?? 1);
    day.closingUsd = last.balance;
  }
  return day;
}

/** The most pages one day is read in: a hundred entries a page, so twenty thousand -- five times a busy day's. */
const MAX_PAGES = 200;

/**
 * Every wallet entry of one account from `fromMs` up to (not incl.) `toMs`: Delta's times in microseconds, its cursor
 * followed to the last page. A page Delta refuses or does not answer throws, as every signed read does.
 */
export async function readWallet(creds: Creds, fromMs: number, toMs: number): Promise<{ entries: WalletEntry[]; complete: boolean; read: WalletRead }> {
  type Row = { id: number | string; amount: string | number; balance: string | number; transaction_type: string; asset_symbol?: string | number | null; created_at: unknown };
  const out: WalletEntry[] = [];
  const read: WalletRead = { pages: 0, rows: 0, kept: 0, outside: 0, unparsed: 0, firstAt: null, lastAt: null };
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: string = `?start_time=${Math.floor(fromMs) * 1_000}&end_time=${Math.floor(toMs) * 1_000 - 1}&page_size=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    const r = await signedPage<Row[]>(creds, { method: 'GET', path: '/v2/wallet/transactions', query });
    read.pages += 1;
    for (const x of r.result ?? []) {
      read.rows += 1;
      const raw = x.created_at === undefined || x.created_at === null ? null : String(x.created_at);
      read.firstAt ??= raw;
      read.lastAt = raw;
      const at = timeOf(x.created_at);
      if (at === null) { read.unparsed += 1; continue; }
      if (at < fromMs || at >= toMs) { read.outside += 1; continue; }            // held to the day here as well as asked
      out.push({ id: String(x.id), at, type: String(x.transaction_type), amount: Number(x.amount) || 0, balance: Number(x.balance) || 0, asset: String(x.asset_symbol ?? 'USD') });
    }
    if (!r.after || (r.result ?? []).length === 0) { const entries = dedupe(out); read.kept = entries.length; return { entries, complete: true, read }; }
    after = r.after;
  }
  const entries = dedupe(out);
  read.kept = entries.length;
  return { entries, complete: false, read };
}

const dedupe = (xs: WalletEntry[]) => { const seen = new Set<string>(); return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true))); };
