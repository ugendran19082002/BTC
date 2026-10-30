import { one, query, rows } from '../db/pool.js';
import { migrate, type Migration } from '../db/migrate.js';
import { brokerAccounts } from '../delta/accounts.js';
import { journal, tradingService } from '../trading/service.js';
import { daysReport, type DayRow } from '../trading/pnl-history.js';
import { istDate, istMinutes } from '../strategy/schedule.js';
import { deskMetrics } from '../observability/desk-metrics.js';
import { noteError } from '../observability/errors.js';
import { ledgerAlert } from '../notify/messages.js';
import { readWallet, walletDayOf, type WalletDay, type WalletEntry, type WalletRead } from './wallet.js';

/**
 * The ledger (owner, 29 Oct 2026: "a ledger on the phone, day by day -- profit, loss, charges, others; my system's
 * P&L and the Delta app's reconciled, checked every day at 11:59 PM and synced by hand -- best practice, UI, backend,
 * DB"): each broker account's IST day, as the desk booked it and as Delta's wallet has it, side by side and judged.
 *
 * The desk's side is the P&L calendar's own day (`daysReport`): every fill in the day, the profit and the loss of each
 * exit, Delta's charges on each fill by the formula the statement matches. Delta's side is the day's wallet entries
 * (`wallet.ts`). They are compared on the net -- booked less charges -- within `TOLERANCE_USD`, and the charges apart.
 *
 * A day is checked by itself at 11:59 PM IST: the strategies are flat from 5:29 PM and enter from 7:00 AM, so nothing
 * is open and the two sides count the same trades. A day missed (the desk down at 11:59 PM) is checked when it next
 * runs, the last week of them, one a minute while Delta's quota is quiet. Any day can be checked again by hand.
 * Every check is kept (`ledger_days`), the desk's figures as they were when it was made; the screen also works the
 * desk's day afresh, and says when it has changed since.
 */

const MIGRATIONS: Migration[] = [{
  id: 'ledger-001-days',
  up: `
    CREATE TABLE IF NOT EXISTS ledger_days (
      broker_account_id BIGINT  NOT NULL,
      day               TEXT    NOT NULL,
      desk              JSONB   NOT NULL,
      delta             JSONB,
      status            TEXT    NOT NULL CHECK (status IN ('match', 'mismatch', 'open', 'unread', 'paper')),
      diff_usd          DOUBLE PRECISION,
      detail            TEXT    NOT NULL DEFAULT '',
      how               TEXT    NOT NULL CHECK (how IN ('auto', 'manual')),
      checked_at        BIGINT  NOT NULL,
      PRIMARY KEY (broker_account_id, day)
    );
    CREATE INDEX IF NOT EXISTS ledger_days_by_day ON ledger_days (day DESC);
  `,
}];

let ready: Promise<void> | null = null;
export function ledgerSchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

/** Within this, the desk's net and Delta's are the same day: about ₹4, the rounding of a thousand fills' fees. */
export const TOLERANCE_USD = 0.05;
const DAY_MS = 86_400_000;
/** The furthest back a day may be checked, or shown: Delta's wallet and the journal both hold more, the screen needs no more. */
export const LEDGER_MAX_DAYS = 92;
/** 11:59 PM IST: the day's own check. */
const CHECK_AT_MIN = 23 * 60 + 59;
/** How far back a day missed is checked by itself. */
const CATCH_UP_DAYS = 7;

export type LedgerStatus = 'match' | 'mismatch' | 'open' | 'unread' | 'paper';
/** The desk's own day: the P&L calendar's row, and how many trades were still open when it was read. */
export type DeskDay = Pick<DayRow, 'realisedUsd' | 'profitUsd' | 'lossUsd' | 'chargesUsd' | 'netUsd' | 'trades'> & { open: number };
export type LedgerRow = {
  accountId: number; day: string; desk: DeskDay; delta: WalletDay | null; status: LedgerStatus;
  diffUsd: number | null; detail: string; how: 'auto' | 'manual'; checkedAt: number;
};

/** An IST day's span, epoch ms. */
export const dayBounds = (day: string) => { const from = Date.parse(`${day}T00:00:00+05:30`); return { from, to: from + DAY_MS }; };
const ZERO: DeskDay = { realisedUsd: 0, profitUsd: 0, lossUsd: 0, chargesUsd: 0, netUsd: 0, trades: 0, open: 0 };

/**
 * One account's days as the desk booked them, from `from` to `to` (IST dates, both in): one read of the journal for
 * the range -- every trade, no page -- and the P&L calendar's own sums.
 */
export async function deskDays(accountId: number | null, from: string, to: string): Promise<Map<string, DeskDay>> {
  const a = dayBounds(from).from, b = dayBounds(to).to;
  // A trade filled in the range was last changed at or after its fill, and by the day after its expiry at the latest.
  const recs = await journal().between(a, b + 2 * DAY_MS, 200_000, accountId, { events: false });
  const report = daysReport(recs, { from, to, spot: tradingService().spot });
  const open = recs.filter((r) => r.state.position !== 0).length;
  const out = new Map<string, DeskDay>();
  for (const d of report.days) {
    out.set(d.day, { realisedUsd: d.realisedUsd, profitUsd: d.profitUsd, lossUsd: d.lossUsd, chargesUsd: d.chargesUsd, netUsd: d.netUsd, trades: d.trades, open: 0 });
  }
  // Still open: said on today's row, where it can make the two sides differ until they close.
  const today = istDate(Date.now());
  if (open > 0 && today >= from && today <= to) out.set(today, { ...(out.get(today) ?? ZERO), open });
  return out;
}

/** The desk's day against Delta's, judged. Pure: the sync and the tests both run it. */
export function judge(desk: DeskDay, delta: WalletDay | null, o: { paper: boolean; unread?: string | null }): { status: LedgerStatus; diffUsd: number | null; detail: string } {
  if (o.paper) return { status: 'paper', diffUsd: null, detail: 'The desk traded on paper: Delta holds none of its trades.' };
  if (!delta) return { status: 'unread', diffUsd: null, detail: o.unread ?? 'Delta\'s wallet could not be read.' };
  /*
   * A read that came back short is not a day that does not match (30 Oct 2026: the first live checks found one wallet
   * entry a day against hundreds of the desk's fills, and called every day "charges differ"). Every trade is at least
   * two fills and each fill a commission, so fewer entries than trades is the read, not the money: said as unread,
   * with what the read saw.
   */
  if (desk.trades > 0 && delta.entries < desk.trades) {
    const r = delta.read;
    const seen = r ? ` Read: ${r.pages} page${r.pages === 1 ? '' : 's'}, ${r.rows} rows from Delta, ${r.kept} of the day, ${r.outside} outside it, ${r.unparsed} with no readable time${r.firstAt ? `; times as Delta wrote them: ${r.firstAt}${r.lastAt && r.lastAt !== r.firstAt ? ` … ${r.lastAt}` : ''}` : ''}.` : '';
    return { status: 'unread', diffUsd: null, detail: `Delta's wallet gave ${delta.entries} entr${delta.entries === 1 ? 'y' : 'ies'} for the desk's ${desk.trades} trade${desk.trades === 1 ? '' : 's'}: the read came back short, so the day is not judged.${seen}` };
  }
  const diffUsd = desk.netUsd - delta.netUsd;
  const notes: string[] = [];
  if (!delta.complete) notes.push('Delta\'s wallet had more entries than were read: the figures are of what was read.');
  if (delta.unknownTypes.length) notes.push(`Counted with the others: ${delta.unknownTypes.join(', ')}.`);
  if (delta.otherAssets) notes.push(`${delta.otherAssets} entries in another asset left out.`);
  if (desk.open > 0) return { status: 'open', diffUsd, detail: [`${desk.open} trade${desk.open === 1 ? '' : 's'} still open: the two sides can differ until ${desk.open === 1 ? 'it closes' : 'they close'}.`, ...notes].join(' ') };
  if (Math.abs(diffUsd) <= TOLERANCE_USD && delta.complete) return { status: 'match', diffUsd, detail: notes.join(' ') };
  const fees = desk.chargesUsd + delta.chargesUsd;          // Delta's charges are negative: equal ones cancel
  const where = Math.abs(fees) > TOLERANCE_USD
    ? `Charges differ by $${Math.abs(fees).toFixed(2)} (desk $${desk.chargesUsd.toFixed(2)}, Delta $${(-delta.chargesUsd).toFixed(2)}).`
    : 'Charges agree: the difference is in what the trades booked.';
  return { status: 'mismatch', diffUsd, detail: [where, ...notes].join(' ') };
}

type Stored = { broker_account_id: string; day: string; desk: DeskDay; delta: WalletDay | null; status: LedgerStatus; diff_usd: number | null; detail: string; how: 'auto' | 'manual'; checked_at: string };
const rowOf = (s: Stored): LedgerRow => ({
  accountId: Number(s.broker_account_id), day: s.day, desk: s.desk, delta: s.delta, status: s.status,
  diffUsd: s.diff_usd, detail: s.detail, how: s.how, checkedAt: Number(s.checked_at),
});

async function save(r: LedgerRow): Promise<void> {
  await ledgerSchema();
  await query(
    `INSERT INTO ledger_days (broker_account_id, day, desk, delta, status, diff_usd, detail, how, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (broker_account_id, day) DO UPDATE SET desk = EXCLUDED.desk, delta = EXCLUDED.delta, status = EXCLUDED.status,
       diff_usd = EXCLUDED.diff_usd, detail = EXCLUDED.detail, how = EXCLUDED.how, checked_at = EXCLUDED.checked_at`,
    [r.accountId, r.day, JSON.stringify(r.desk), r.delta === null ? null : JSON.stringify(r.delta), r.status, r.diffUsd, r.detail, r.how, r.checkedAt],
  );
}

/** The checks kept for a range of days, of one account or of every one. */
export async function ledgerRows(accountId: number | null, from: string, to: string): Promise<LedgerRow[]> {
  await ledgerSchema();
  const xs = await rows<Stored>(
    `SELECT broker_account_id, day, desk, delta, status, diff_usd, detail, how, checked_at FROM ledger_days
      WHERE day >= $1 AND day <= $2 AND ($3::bigint IS NULL OR broker_account_id = $3) ORDER BY day DESC, broker_account_id`,
    [from, to, accountId],
  );
  return xs.map(rowOf);
}

/** The newest check made by itself at 11:59 PM, for "last checked". */
export async function lastAutoCheck(accountId: number | null): Promise<number | null> {
  await ledgerSchema();
  const r = await one<{ at: string | null }>(`SELECT max(checked_at) AS at FROM ledger_days WHERE how = 'auto' AND ($1::bigint IS NULL OR broker_account_id = $1)`, [accountId]);
  return r?.at ? Number(r.at) : null;
}

/** The accounts a day is checked for: switched on, their key readable. */
export function ledgerAccounts(): { id: number; name: string }[] {
  try { return brokerAccounts().list().filter((a) => a.active && a.readable).map((a) => ({ id: a.id, name: a.name })); } catch { return []; }
}

/** Read by the tests in place of Delta. */
export type WalletReader = (accountId: number, fromMs: number, toMs: number) => Promise<{ entries: WalletEntry[]; complete: boolean; read?: WalletRead }>;
const deltaWallet: WalletReader = async (accountId, fromMs, toMs) => {
  const creds = brokerAccounts().credsOf(accountId);
  if (!creds) throw new Error('This account\'s key cannot be opened.');
  return readWallet(creds, fromMs, toMs);
};
let reader: WalletReader = deltaWallet;
/** For the tests: Delta's wallet as they write it. Null puts Delta back. */
export const setWalletReader = (r: WalletReader | null) => { reader = r ?? deltaWallet; };
const deskOnPaper = () => tradingService().mode === 'paper';
let onPaper = deskOnPaper;
/** For the tests, whose desk is held on paper: whether the day was traded on paper. Null asks the desk again. */
export const setLedgerPaper = (f: (() => boolean) | null) => { onPaper = f ?? deskOnPaper; };

/** Check one account's day now: the desk's figures, Delta's wallet, judged and kept. Never throws: a failure is a row. */
export async function checkDay(accountId: number, day: string, how: 'auto' | 'manual', now = Date.now()): Promise<LedgerRow> {
  const desk = (await deskDays(accountId, day, day)).get(day) ?? ZERO;
  const paper = onPaper();
  let delta: WalletDay | null = null;
  let unread: string | null = null;
  if (!paper) {
    const { from, to } = dayBounds(day);
    try {
      const w = await reader(accountId, from, Math.min(to, now + 1));
      delta = walletDayOf(w.entries, w.complete, w.read);
    } catch (e) {
      unread = `Delta's wallet could not be read: ${(e as Error).message}`;
    }
  }
  const j = judge(desk, delta, { paper, unread });
  const row: LedgerRow = { accountId, day, desk, delta, ...j, how, checkedAt: now };
  await save(row);
  return row;
}

let running: Promise<LedgerRow[]> | null = null;
/** Whether a check is being made now: one at a time, by hand or by itself. */
export const ledgerBusy = () => running !== null;

/** Check a day for the accounts asked (every one, with none), one after another. One run at a time; a second waits for the first. */
export function checkDays(day: string, accountIds: readonly number[] | null, how: 'auto' | 'manual'): Promise<LedgerRow[]> {
  const run = async () => {
    const ids = accountIds ?? ledgerAccounts().map((a) => a.id);
    const out: LedgerRow[] = [];
    for (const id of ids) out.push(await checkDay(id, day, how));
    return out;
  };
  const next = (running ?? Promise.resolve([])).then(run, run).finally(() => { if (running === next) running = null; });
  running = next;
  return next;
}

/** Delta's quota this busy, the catching-up waits: an order matters more than yesterday's ledger. */
const QUIET_PCT = 50;
const autoDone = new Set<string>();

/**
 * Once a minute (index.ts): at 11:59 PM IST, today's check for every account not yet checked by itself today; and
 * otherwise, one missed day of the last week, the oldest first, while Delta's quota is quiet. A mismatch found by
 * itself is said once on the phone.
 */
export async function ledgerTick(now = Date.now()): Promise<void> {
  if (running) return;
  const accounts = ledgerAccounts();
  if (accounts.length === 0) return;
  const today = istDate(now);
  if (istMinutes(now) >= CHECK_AT_MIN) {
    const due = accounts.filter((a) => !autoDone.has(`${a.id}|${today}`));
    if (due.length) {
      const kept = await ledgerRows(null, today, today);
      const left = due.filter((a) => !kept.some((r) => r.accountId === a.id && r.how === 'auto'));
      for (const a of due) autoDone.add(`${a.id}|${today}`);
      if (left.length) { await announce(await checkDays(today, left.map((a) => a.id), 'auto'), accounts); return; }
    }
  }
  if (deskMetrics().delta.usedPct > QUIET_PCT) return;
  const from = istDate(now - CATCH_UP_DAYS * DAY_MS), yesterday = istDate(now - DAY_MS);
  const kept = await ledgerRows(null, from, yesterday);
  for (let n = CATCH_UP_DAYS; n >= 1; n--) {
    const day = istDate(now - n * DAY_MS);
    const missing = accounts.filter((a) => !kept.some((r) => r.accountId === a.id && r.day === day));
    if (missing.length) { await announce(await checkDays(day, [missing[0]!.id], 'auto'), accounts); return; }
  }
}

async function announce(checked: readonly LedgerRow[], accounts: readonly { id: number; name: string }[]): Promise<void> {
  for (const r of checked) {
    if (r.status !== 'mismatch') continue;
    try {
      const svc = tradingService();
      svc.notifier?.notify(ledgerAlert({ account: accounts.find((a) => a.id === r.accountId)?.name ?? `Account ${r.accountId}`, day: r.day, deskUsd: r.desk.netUsd, deltaUsd: r.delta?.netUsd ?? 0, detail: r.detail }));
    } catch (e) {
      noteError({ source: 'server', level: 'warn', where: 'ledger', message: `ledger alert not sent: ${(e as Error).message}` });
    }
  }
}
