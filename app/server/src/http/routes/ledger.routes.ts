import type { FastifyInstance } from 'fastify';
import { refuse } from '../refuse.js';
import { accountOf } from '../account-query.js';
import { istDate } from '../../strategy/schedule.js';
import {
  LEDGER_MAX_DAYS, TOLERANCE_USD, currentSync, deskDays, ledgerAccounts, ledgerBusy, ledgerRows, lastAutoCheck, startSync,
  type DeskDay, type LedgerRow, type LedgerStatus,
} from '../../ledger/ledger.js';
import type { WalletDay } from '../../ledger/wallet.js';
import { dayTrades } from '../../ledger/day-trades.js';

/**
 * The ledger's routes (ledger/ledger.ts): the days as the desk booked them and as Delta's wallet has them, and a check
 * made by hand. Both read and write nothing but the ledger: a check reads Delta's wallet with the account's own key and
 * keeps what it found -- no order, no setting -- so a view-only phone may ask for one (`VIEW_WRITES` in `http/app.ts`).
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** A day's view: the desk's figures now, and the check kept for it -- of one account, or every account's summed. */
type DayView = {
  day: string;
  desk: DeskDay;
  /** `unchecked`: no check kept; `partial`: some accounts' days are checked and some are not. */
  status: LedgerStatus | 'unchecked' | 'partial';
  diffUsd: number | null;
  detail: string;
  delta: WalletDay | null;
  /** The desk's net as the check found it, and whether it has moved since by more than the tolerance. */
  checkedDeskUsd: number | null;
  changed: boolean;
  checkedAt: number | null;
  how: 'auto' | 'manual' | null;
  /** On "All accounts": each account's own verdict, to say which one is off. */
  perAccount?: { accountId: number; name: string; status: LedgerStatus | 'unchecked'; diffUsd: number | null }[];
};

const ORDER: (LedgerStatus | 'unchecked' | 'partial')[] = ['mismatch', 'unread', 'open', 'partial', 'unchecked', 'paper', 'match'];
const worst = (xs: (LedgerStatus | 'unchecked')[]) => ORDER.find((s) => xs.includes(s as LedgerStatus | 'unchecked')) ?? 'unchecked';

function sumWallet(xs: readonly WalletDay[]): WalletDay | null {
  if (xs.length === 0) return null;
  const byType: WalletDay['byType'] = {};
  for (const x of xs) for (const [t, v] of Object.entries(x.byType)) { const m = byType[t] ?? (byType[t] = { n: 0, usd: 0 }); m.n += v.n; m.usd += v.usd; }
  const add = (k: 'netUsd' | 'tradingUsd' | 'chargesUsd' | 'fundingUsd' | 'othersUsd' | 'transfersUsd') => xs.reduce((n, x) => n + x[k], 0);
  return {
    netUsd: add('netUsd'), tradingUsd: add('tradingUsd'), chargesUsd: add('chargesUsd'), fundingUsd: add('fundingUsd'), othersUsd: add('othersUsd'), transfersUsd: add('transfersUsd'),
    openingUsd: xs.every((x) => x.openingUsd !== null) ? xs.reduce((n, x) => n + x.openingUsd!, 0) : null,
    closingUsd: xs.every((x) => x.closingUsd !== null) ? xs.reduce((n, x) => n + x.closingUsd!, 0) : null,
    entries: xs.reduce((n, x) => n + x.entries, 0), byType, unknownTypes: [...new Set(xs.flatMap((x) => x.unknownTypes))].sort(),
    otherAssets: xs.reduce((n, x) => n + x.otherAssets, 0), complete: xs.every((x) => x.complete),
  };
}

const ZERO: DeskDay = { realisedUsd: 0, profitUsd: 0, lossUsd: 0, chargesUsd: 0, netUsd: 0, trades: 0, open: 0 };

/** One account's day: its kept check as it is, or unchecked. */
function viewOf(day: string, desk: DeskDay, r: LedgerRow | undefined): DayView {
  if (!r) return { day, desk, status: 'unchecked', diffUsd: null, detail: '', delta: null, checkedDeskUsd: null, changed: false, checkedAt: null, how: null };
  return {
    day, desk, status: r.status, diffUsd: r.diffUsd, detail: r.detail, delta: r.delta, checkedDeskUsd: r.desk.netUsd,
    changed: Math.abs(r.desk.netUsd - desk.netUsd) > TOLERANCE_USD, checkedAt: r.checkedAt, how: r.how,
  };
}

/** Every account's day summed: the desk's figures over all of them, the checks kept summed where every one has one. */
function viewOfAll(day: string, desk: DeskDay, rs: readonly LedgerRow[], accounts: readonly { id: number; name: string }[]): DayView {
  const perAccount = accounts.map((a) => {
    const r = rs.find((x) => x.accountId === a.id);
    return { accountId: a.id, name: a.name, status: (r?.status ?? 'unchecked') as LedgerStatus | 'unchecked', diffUsd: r?.diffUsd ?? null };
  });
  const checked = rs.filter((r) => accounts.some((a) => a.id === r.accountId));
  const all = checked.length === accounts.length && accounts.length > 0;
  const status = checked.length === 0 ? 'unchecked' : !all ? 'partial' : worst(perAccount.map((p) => p.status));
  const checkedDesk = all ? checked.reduce((n, r) => n + r.desk.netUsd, 0) : null;
  return {
    day, desk, status, perAccount,
    diffUsd: all && checked.every((r) => r.diffUsd !== null) ? checked.reduce((n, r) => n + r.diffUsd!, 0) : null,
    detail: checked.filter((r) => r.status === 'mismatch' || r.status === 'unread').map((r) => `${accounts.find((a) => a.id === r.accountId)?.name}: ${r.detail}`).join(' '),
    delta: all ? sumWallet(checked.flatMap((r) => (r.delta ? [r.delta] : []))) : null,
    checkedDeskUsd: checkedDesk, changed: checkedDesk !== null && Math.abs(checkedDesk - desk.netUsd) > TOLERANCE_USD,
    checkedAt: checked.length ? Math.max(...checked.map((r) => r.checkedAt)) : null,
    how: checked.length ? (checked.some((r) => r.how === 'manual') ? 'manual' : 'auto') : null,
  };
}

export function registerLedgerRoutes(app: FastifyInstance) {
  /**
   * The ledger for a range of IST days (`from`, `to`; the last seven without them; at most 92): each day the desk's
   * profit, loss, charges and net worked out now, and the check kept for it -- Delta's side, the verdict, when and how
   * it was made. `?account=<id>`: one broker account; without it every account's, each one's verdict beside the sum.
   */
  app.get('/api/ledger', async (req, reply) => {
    const q = (req.query ?? {}) as { from?: string; to?: string };
    const today = istDate(Date.now());
    const to = q.to ?? today, from = q.from ?? shift(to, -6);
    if (!DAY.test(from) || !DAY.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return refuse(reply, 400, { error: 'Dates must be YYYY-MM-DD.' });
    if (from > to) return refuse(reply, 400, { error: 'The start date must not be after the end date.' });
    if ((Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > LEDGER_MAX_DAYS) return refuse(reply, 400, { error: `At most ${LEDGER_MAX_DAYS} days at a time.` });
    const account = accountOf(req.query);
    const accounts = ledgerAccounts();
    const [desk, kept, lastAutoAt, sync] = await Promise.all([deskDays(account, from, to), ledgerRows(account, from, to), lastAutoCheck(account), currentSync()]);
    const days = [...new Set([...desk.keys(), ...kept.map((r) => r.day)])].sort().reverse().map((day) => {
      const d = desk.get(day) ?? ZERO;
      const rs = kept.filter((r) => r.day === day);
      return account === null ? viewOfAll(day, d, rs, accounts) : viewOf(day, d, rs[0]);
    });
    const sumDesk = (k: keyof DeskDay) => days.reduce((n, d) => n + d.desk[k], 0);
    const judged = days.filter((d) => d.delta !== null && d.status !== 'paper' && d.status !== 'unread');
    return {
      from, to, account, accounts, busy: ledgerBusy() || sync?.status === 'running', sync, lastAutoAt, toleranceUsd: TOLERANCE_USD, days,
      totals: {
        desk: { realisedUsd: sumDesk('realisedUsd'), profitUsd: sumDesk('profitUsd'), lossUsd: sumDesk('lossUsd'), chargesUsd: sumDesk('chargesUsd'), netUsd: sumDesk('netUsd'), trades: sumDesk('trades') },
        delta: judged.length ? sumWallet(judged.map((d) => d.delta!)) : null,
        days: days.length,
        checked: days.filter((d) => d.status !== 'unchecked' && d.status !== 'partial').length,
        matched: days.filter((d) => d.status === 'match').length,
        mismatched: days.filter((d) => d.status === 'mismatch').length,
      },
    };
  });

  /**
   * One day's trades, each on its line (`ledger/day-trades.ts`): strike, CE or PE, sold or bought, when and at what it
   * went in and came out, how it closed, Delta's charges, what it booked and its net -- and the day's own figures beside
   * them, the ledger row's. `?account=<id>`; without it, every account's.
   */
  app.get('/api/ledger/day', async (req, reply) => {
    const day = (req.query as { day?: unknown } | null)?.day;
    if (typeof day !== 'string' || !DAY.test(day) || Number.isNaN(Date.parse(day))) return refuse(reply, 400, { error: 'Day must be YYYY-MM-DD.' });
    if (day > istDate(Date.now())) return refuse(reply, 400, { error: 'A day still to come has no trades.' });
    return { day, account: accountOf(req.query), ...(await dayTrades(accountOf(req.query), day)) };
  });

  /**
   * Sync with Delta (30 Oct 2026, owner: "sync by the days chosen; the loading state after a refresh; no duplicate
   * sync -- save it in the backend; one at a time, best practice"): `day` (today without one), or `from` and `to` (the
   * days the screen shows), for `accountId` or every account. Kept as a job and answered at once (202) with it: the
   * screen follows it on `GET /api/ledger` (`sync`), after a refresh as before. One at a time: asked while one runs,
   * that one is answered (`already`), and nothing new is started -- however many taps, phones or processes ask.
   */
  app.post('/api/ledger/sync', async (req, reply) => {
    const b = (req.body ?? {}) as { day?: unknown; from?: unknown; to?: unknown; accountId?: unknown };
    const today = istDate(Date.now());
    const given = (v: unknown) => v !== undefined && v !== null && v !== '';
    const dayProblem = (d: string) => (!DAY.test(d) || Number.isNaN(Date.parse(d)) ? 'Days must be YYYY-MM-DD.'
      : d > today ? 'A day still to come has nothing to check.'
        : (Date.parse(today) - Date.parse(d)) / DAY_MS >= LEDGER_MAX_DAYS ? `Only the last ${LEDGER_MAX_DAYS} days can be checked.` : null);
    const accounts = ledgerAccounts();
    let accountId: number | null = null;
    if (given(b.accountId)) {
      accountId = Number(b.accountId);
      if (!accounts.some((a) => a.id === accountId)) return refuse(reply, 400, { error: 'No such account switched on, or its key cannot be opened.' });
    }
    if (accounts.length === 0) return refuse(reply, 409, { error: 'No broker account is switched on: there is no Delta wallet to check against.' });

    let days: string[];
    if (given(b.from) || given(b.to)) {
      if (!given(b.from) || !given(b.to)) return refuse(reply, 400, { error: 'Give both days of the range.' });
      const from = String(b.from), to = String(b.to) > today ? today : String(b.to);
      const problem = dayProblem(from) ?? dayProblem(to);
      if (problem) return refuse(reply, 400, { error: problem });
      if (from > to) return refuse(reply, 400, { error: 'The start day must not be after the end day.' });
      days = [];
      for (let d = from; d <= to; d = shift(d, 1)) days.push(d);
    } else {
      const day = given(b.day) ? String(b.day) : today;
      const problem = dayProblem(day);
      if (problem) return refuse(reply, 400, { error: problem === 'Days must be YYYY-MM-DD.' ? 'Day must be YYYY-MM-DD.' : problem });
      days = [day];
    }
    const started = await startSync(days, accountId);
    reply.code(started.already ? 200 : 202);
    return started;
  });
}
