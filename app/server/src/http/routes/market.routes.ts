import type { FastifyInstance } from 'fastify';
import { tradingService } from '../../trading/service.js';
import { sessionDayOf } from '../../report/market-day.js';
import { REPORT_FIRST_DAY, REPORT_MAX_DAYS, marketBreakdown, marketReport, type ReportFilters } from '../../report/market-report.js';
import { DEFAULT_PARAMS, backtestable, signalBacktest, type BacktestParams } from '../../report/signal-backtest.js';
import { strategyStore } from './strategy.routes.js';
import { GLOBAL_MAX_OPEN_KEY, SIDE_MAX_KEYS, globalMaxOpenOf, ruleTfs, sideMaxOf } from '../../strategy/types.js';
import { accountSetting } from '../../db/settings.js';
import { brokerAccounts } from '../../delta/accounts.js';
import { refuse } from '../refuse.js';
import { accountOf } from '../account-query.js';

/**
 * The market report (13 Oct 2026): every expiry day -- 5:30 PM IST to 5:30 PM IST -- with the kind of day the
 * BTC perp had, and what the signal history and the real orders made on it. Read-only.
 *
 * `?from=&to=` are expiry days (YYYY-MM-DD, the day the contract settles); without them, from 1 Oct 2026 to the
 * day in progress. `?account=` is one broker account's orders (the signal history has no account). `?tf=`,
 * `?method=` and `?strategy=` keep only those timeframes (`chain` for the timeframe chain), entry methods and
 * strategies; a strategy narrows the real orders only.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function rangeOf(q: { from?: unknown; to?: unknown }, now = Date.now()): { from: string; to: string } | string {
  const today = sessionDayOf(now);
  const from = q.from === undefined || q.from === '' ? REPORT_FIRST_DAY : String(q.from);
  const to = q.to === undefined || q.to === '' ? today : String(q.to);
  if (!DAY.test(from) || !DAY.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return 'Dates must be YYYY-MM-DD.';
  if (from > to) return 'The start date must not be after the end date.';
  if (Date.parse(to) - Date.parse(from) > REPORT_MAX_DAYS * 86_400_000) return `At most ${REPORT_MAX_DAYS} days at a time.`;
  return { from, to };
}

function listOf(q: unknown, name: 'tf' | 'method' | 'strategy'): string[] | null {
  const raw = (q as Record<string, unknown> | null | undefined)?.[name];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const keys = [...new Set(raw.split(',').map((k) => k.trim()).filter((k) => k !== '' && k.length <= 120))].slice(0, 200);
  return keys.length ? keys : null;
}
/** The report itself is not filtered any more (13 Oct 2026); the backtest still reads one strategy's orders through the same sums. */
const NO_FILTERS: ReportFilters = { account: null, tfs: null, methods: null, strategies: null };

/**
 * The backtest's settings, checked: `?rule=delta|premium`, `?value=` (a delta from 0.02 to 0.5, or a premium from
 * 10 to 500 dollars), `?lots=` (1 to 1,000), `?tp=` and `?sl=` (the option's own target and stop as shares of the
 * premium; 0 is none), `?window=desk|all`. Absent ones are the defaults.
 */
function backtestParamsOf(q: Record<string, unknown>): BacktestParams | string {
  const num = (name: string, fallback: number) => (q[name] === undefined || q[name] === '' ? fallback : Number(q[name]));
  const rule = q.rule === undefined || q.rule === '' ? DEFAULT_PARAMS.rule : q.rule;
  if (rule !== 'delta' && rule !== 'premium') return 'The strike rule is "delta" or "premium".';
  const value = num('value', rule === 'delta' ? 0.1 : 50);
  if (rule === 'delta' ? !(value >= 0.02 && value <= 0.5) : !(value >= 10 && value <= 500)) {
    return rule === 'delta' ? 'A delta limit is from 0.02 to 0.5.' : 'A premium limit is from 10 to 500 dollars.';
  }
  const lots = num('lots', DEFAULT_PARAMS.lots);
  if (!Number.isInteger(lots) || lots < 1 || lots > 1_000) return 'Lots are a whole number from 1 to 1,000.';
  const targetPct = num('tp', DEFAULT_PARAMS.targetPct), stopPct = num('sl', DEFAULT_PARAMS.stopPct);
  if (!(targetPct >= 0 && targetPct <= 0.99)) return 'The option target is a share of the premium from 0 (none) to 0.99.';
  if (!(stopPct >= 0 && stopPct <= 10)) return 'The option stop is a share of the premium from 0 (none) to 10.';
  const window = q.window === undefined || q.window === '' ? DEFAULT_PARAMS.window : q.window;
  if (window !== 'desk' && window !== 'all' && window !== 'custom') return 'The window is "desk", "all" or "custom".';
  // Custom hours: `?hfrom=22:00&hto=02:00`, IST, the end not included.
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  const hoursFrom = typeof q.hfrom === 'string' ? q.hfrom : '', hoursTo = typeof q.hto === 'string' ? q.hto : '';
  if (window === 'custom' && (!hhmm.test(hoursFrom) || !hhmm.test(hoursTo))) return 'Custom hours are a From and a To time, HH:MM (IST).';
  if (window === 'custom' && hoursFrom === hoursTo) return 'The From and To times must differ.';
  // The desk's own limits, as the Signal Strategies card sets them: at most open 0 (none) to 500; each side 1 to 100%.
  const deskMax = num('max', 0), cePct = num('ce', 100), pePct = num('pe', 100);
  if (!Number.isInteger(deskMax) || deskMax < 0 || deskMax > 500) return 'At most open is a whole number from 0 (no limit) to 500.';
  if (!(cePct >= 1 && cePct <= 100) || !(pePct >= 1 && pePct <= 100)) return 'CE max and PE max are from 1% to 100%.';
  // The SL and TGT range, in BTC points: `?slmin=&slmax=&tgtmin=&tgtmax=`, 0 off.
  const slMin = num('slmin', 0), slMax = num('slmax', 0), tgtMin = num('tgtmin', 0), tgtMax = num('tgtmax', 0);
  for (const v of [slMin, slMax, tgtMin, tgtMax]) if (!(v >= 0 && v <= 20_000)) return 'An SL or TGT distance is from 0 (off) to 20,000 points.';
  if (slMin > 0 && slMax > 0 && slMax < slMin) return 'The SL maximum must not be under its minimum.';
  if (tgtMin > 0 && tgtMax > 0 && tgtMax < tgtMin) return 'The TGT maximum must not be under its minimum.';
  return { rule, value, lots, targetPct, stopPct, window, deskMax, cePct, pePct, slMin, slMax, tgtMin, tgtMax, ...(window === 'custom' ? { hoursFrom, hoursTo } : {}) };
}

export function registerMarketRoutes(app: FastifyInstance) {
  /**
   * The signal history traded as options on the contracts' own recorded prices (13 Oct 2026): every signal in the
   * trade, an option sold at its fill and bought back at the perp's stop or target, the option's own target or
   * stop, or the window's end. `?from=&to=` are expiry days; `?tf=` and `?method=` narrow it. Read-only, and it
   * takes every signal: no limit on what is open.
   */
  app.get('/api/signal-backtest', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const r = rangeOf(q);
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    const params = backtestParamsOf(q);
    if (typeof params === 'string') return refuse(reply, 400, { error: params });
    /*
     * `?strategy=<id>`: backtest by that saved strategy's own rules instead of the screen's settings (owner, 13 Oct
     * 2026: "a strategy list in the backtest -- choose one and backtest by it, else don't"). The list to choose from
     * comes back with every answer: the signal strategies that sell, each with its account.
     */
    const every = (await strategyStore().all().catch(() => [])).filter(backtestable);
    const askedId = typeof q.strategy === 'string' && q.strategy !== '' ? q.strategy : null;
    const strategy = askedId === null ? null : every.find((s) => s.id === askedId) ?? null;
    if (askedId !== null && !strategy) return refuse(reply, 404, { error: 'No such signal strategy to backtest: it may have been deleted, or it buys rather than sells.' });
    const accountName = (id: number | null | undefined) => { try { return id == null ? null : brokerAccounts().get(id)?.name ?? null; } catch { return null; } };
    const result = await signalBacktest({ ...r, now: Date.now(), params, tfs: listOf(q, 'tf'), methods: listOf(q, 'method'), strategy, spot: tradingService().spot });
    // Each trading account's own limits as they stand, for the screen to offer as one tap.
    const svc = tradingService();
    let deskLimits: { account: string; max: number; ce: number; pe: number }[] = [];
    try {
      deskLimits = brokerAccounts().list().filter((a) => a.active).map((a) => ({
        account: a.name,
        max: globalMaxOpenOf(accountSetting(svc.settings, GLOBAL_MAX_OPEN_KEY, a.id)),
        ce: sideMaxOf(accountSetting(svc.settings, SIDE_MAX_KEYS.CE, a.id)),
        pe: sideMaxOf(accountSetting(svc.settings, SIDE_MAX_KEYS.PE, a.id)),
      })).filter((x) => x.max > 0);
    } catch { /* no account set up: none to offer */ }
    return {
      ...result,
      deskLimits,
      // With its methods and timeframes, so the screen can tick a strategy's methods for the settings (`chain`: the timeframe chain).
      strategies: every.map((s) => ({
        id: s.id, name: s.name, enabled: s.enabled, account: accountName(s.accountId),
        methods: [...s.config.signal!.methods], tfs: s.config.signal!.mode === 'mtf' ? ['chain'] : [...ruleTfs(s.config.signal!)],
      }))
        .sort((a, b) => (a.account ?? '').localeCompare(b.account ?? '') || a.name.localeCompare(b.name, 'en', { numeric: true })),
    };
  });

  /** Each expiry day with its figures, its kind and both records' totals. `?account=` is one broker account's orders. */
  app.get('/api/market-report', async (req, reply) => {
    const r = rangeOf((req.query ?? {}) as { from?: unknown; to?: unknown });
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    return marketReport({ ...r, now: Date.now(), spot: tradingService().spot, ...NO_FILTERS, account: accountOf(req.query) });
  });

  /** One expiry day opened (`?day=`): both records by pair, timeframe, method and strategy. */
  app.get('/api/market-report/breakdown', async (req, reply) => {
    const day = (req.query as { day?: unknown } | null)?.day;
    if (typeof day !== 'string' || !DAY.test(day) || Number.isNaN(Date.parse(day))) return refuse(reply, 400, { error: 'Day must be YYYY-MM-DD.' });
    return marketBreakdown({ from: day, to: day, now: Date.now(), spot: tradingService().spot, day, ...NO_FILTERS, account: accountOf(req.query) });
  });
}
