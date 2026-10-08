import type { FastifyInstance } from 'fastify';
import { journal, tradingService } from '../../trading/service.js';
import { daysCsv, daysReport, mtmStats, ofMethods, ofStrategies, tradeStats, type TradeStatsGroup } from '../../trading/pnl-history.js';
import { strategyStore } from './strategy.routes.js';
import { brokerAccounts } from '../../delta/accounts.js';
import { istDate } from '../../strategy/schedule.js';
import { refuse } from '../refuse.js';
import { accountOf } from '../account-query.js';

/**
 * The record as a calendar, and a day as a line.
 *
 * Read-only, and every figure is computed from the journal on the way out --
 * the day rows from the fills, the line from the minute-by-minute samples --
 * so the screen never carries a number the journal cannot reproduce.
 *
 * `?account=<id>` on each: one broker account's trades and readings (the
 * journal's `broker_account_id`); without it, every account's together.
 *
 * `?strategy=<id>,<id>` on the days and the statistics (8 Oct 2026): only the
 * trades those strategies placed -- `manual` for the ones nobody scheduled.
 * Without it, or empty, every trade. `?method=<id>,<id>` beside it: only the
 * signal trades of those entry methods. Both together is both at once.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ninetyDaysAgo = (now: number) => istDate(now - 90 * 86_400_000);

/** A range, checked. Defaults to the last ninety days ending today. */
function rangeOf(q: { from?: unknown; to?: unknown }, now = Date.now()): { from: string; to: string } | string {
  const from = q.from === undefined || q.from === '' ? ninetyDaysAgo(now) : String(q.from);
  const to = q.to === undefined || q.to === '' ? istDate(now) : String(q.to);
  if (!DAY.test(from) || !DAY.test(to)) return 'Dates must be YYYY-MM-DD.';
  if (from > to) return 'The start date must not be after the end date.';
  // The journal is read by when a trade last changed; a year is plenty and
  // keeps one request from walking the whole file.
  if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) return 'At most a year at a time.';
  return { from, to };
}

/** The ids asked for under one name of the query, or null for all of them. More than a screen could list is a mistake, not a filter. */
function listOf(q: unknown, name: 'strategy' | 'method'): string[] | null {
  const raw = (q as Record<string, unknown> | null | undefined)?.[name];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const keys = [...new Set(raw.split(',').map((k) => k.trim()).filter((k) => k !== '' && k.length <= 120))].slice(0, 200);
  return keys.length ? keys : null;
}
const strategiesOf = (q: unknown) => listOf(q, 'strategy');
const methodsOf = (q: unknown) => listOf(q, 'method');
/** The trades a request is about: the strategies it names, and the entry methods. */
const chosenOf = <T extends Parameters<typeof ofStrategies>[0][number]>(records: readonly T[], q: unknown) =>
  ofMethods(ofStrategies(records, strategiesOf(q)), methodsOf(q));

export function registerReportRoutes(app: FastifyInstance) {
  const svc = tradingService();

  /** Every trading day in the range, with the running total. */
  app.get('/api/report/days', async (req, reply) => {
    const r = rangeOf((req.query ?? {}) as { from?: unknown; to?: unknown });
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    // From a day before the range: a trade opened the evening before and
    // closed inside it is inside it, and it is fills that decide, not rows.
    // From the whole journal, by the account named (none: every account's): an account with no desk still has its record.
    const records = chosenOf(
      await journal().between(Date.parse(r.from) - 2 * 86_400_000, Date.parse(r.to) + 2 * 86_400_000, 5_000, accountOf(req.query)),
      req.query,
    );
    return { mode: svc.mode, ...daysReport(records, { ...r, spot: svc.spot }) };
  });

  // The P&L calendar as a spreadsheet that opens cleanly in Excel.
  app.get('/api/report/days.csv', async (req, reply) => {
    const r = rangeOf((req.query ?? {}) as { from?: unknown; to?: unknown });
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    const records = chosenOf(
      await journal().between(Date.parse(r.from) - 2 * 86_400_000, Date.parse(r.to) + 2 * 86_400_000, 5_000, accountOf(req.query)),
      req.query,
    );
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="pnl-${r.from}-to-${r.to}.csv"`);
    return daysCsv(daysReport(records, { ...r, spot: svc.spot }));
  });

  /**
   * How the closed trades did in the range: win rate, profit factor, average win and loss -- overall, by strategy,
   * by broker account and by method-and-timeframe pair, after charges (`tradeStats`). Each group carries a name to show: the strategy's
   * current name, "By hand" for a trade nobody scheduled, the account's name.
   *
   * With `?strategy=` every figure is of those strategies' trades alone. `strategies` is the list to choose from,
   * and is not narrowed by the choice: every strategy with a trade closed in the range, each with its count and
   * net, and any strategy asked for that has none -- so a choice remembered from another range can still be seen
   * and taken off.
   *
   * `?method=` the same way, with `methods` its list. Each list is of the trades the *other* choice leaves: the
   * methods to choose from are those of the strategies chosen, and the strategies those of the methods chosen --
   * so neither list offers something the other choice has already emptied, and neither is narrowed by its own.
   */
  app.get('/api/report/stats', async (req, reply) => {
    const r = rangeOf((req.query ?? {}) as { from?: unknown; to?: unknown });
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    const every = await journal().between(Date.parse(r.from) - 2 * 86_400_000, Date.parse(r.to) + 2 * 86_400_000, 5_000, accountOf(req.query));
    const asked = strategiesOf(req.query);
    const askedMethods = methodsOf(req.query);
    const records = chosenOf(every, req.query);
    const stats = tradeStats(records, { ...r, spot: svc.spot });
    // A deleted strategy keeps the name its trades were placed under.
    const strategyNames = new Map<string, string>();
    for (const rec of every) if (rec.plan.strategyId && rec.plan.strategyName) strategyNames.set(rec.plan.strategyId, rec.plan.strategyName);
    for (const x of await strategyStore().all().catch(() => [])) strategyNames.set(x.id, x.name);
    const methodNames = new Map<string, string>();
    for (const rec of every) if (rec.plan.signal) methodNames.set(rec.plan.signal.method, `#${rec.plan.signal.n} ${rec.plan.signal.name}`);
    const accountNames = new Map<string, string>();
    try { for (const a of brokerAccounts().list()) accountNames.set(String(a.id), a.name); } catch { /* none set up */ }
    const named = (g: TradeStatsGroup, name: string) => ({ ...g, name });
    const strategyName = (key: string) => (key === 'manual' ? 'By hand' : strategyNames.get(key) ?? key);
    // Each list from the trades the other choice leaves, and not narrowed by its own.
    const choices = (groups: readonly TradeStatsGroup[], chosen: readonly string[] | null, name: (key: string) => string) => [
      ...groups.map((g) => ({ key: g.key, name: name(g.key), trades: g.trades, netUsd: g.netUsd })),
      ...(chosen ?? []).filter((k) => !groups.some((g) => g.key === k)).map((k) => ({ key: k, name: name(k), trades: 0, netUsd: 0 })),
    ];
    const strategies = choices(asked ? tradeStats(ofMethods(every, askedMethods), { ...r, spot: svc.spot }).byStrategy : stats.byStrategy, asked, strategyName);
    const methods = choices(
      askedMethods ? tradeStats(ofStrategies(every, asked), { ...r, spot: svc.spot }).byMethod : stats.byMethod,
      askedMethods, (key) => methodNames.get(key) ?? key,
    );
    return {
      mode: svc.mode,
      from: stats.from,
      to: stats.to,
      overall: stats.overall,
      strategies,
      methods,
      byStrategy: stats.byStrategy.map((g) => named(g, strategyName(g.key))),
      byAccount: stats.byAccount.map((g) => named(g, g.key === 'none' ? 'No account' : accountNames.get(g.key) ?? `Account ${g.key}`)),
      byOption: stats.byOption.map((g) => named(g, g.key)),
      byAction: stats.byAction.map((g) => named(g, g.key === 'buy' ? 'Bought' : 'Sold')),
      byMethod: stats.byMethod.map((g) => named(g, methodNames.get(g.key) ?? g.key)),
      // A method on a timeframe: the method's name, and the timeframe said the way the trade lists say it.
      byPair: stats.byPair.map((g) => {
        const [method = g.key, mode, tf = ''] = g.key.split('|');
        return { ...named(g, methodNames.get(method) ?? method), tf: mode === 'mtf' ? `${tf} + TF chain` : tf };
      }),
    };
  });

  /** One day, minute by minute. Today unless asked otherwise. */
  app.get('/api/report/mtm', async (req, reply) => {
    const q = (req.query ?? {}) as { day?: unknown };
    const day = q.day === undefined || q.day === '' ? istDate(Date.now()) : String(q.day);
    if (!DAY.test(day)) return refuse(reply, 400, { error: 'Day must be YYYY-MM-DD.' });
    // The account named; with none ("All accounts"), the default account's line -- two accounts' lines do not add up to one.
    const account = accountOf(req.query) ?? svc.accountId;
    const samples = await journal().mtmSamples(day, account);
    return {
      mode: svc.mode,
      day,
      samples,
      stats: mtmStats(samples),
      /** Days that have a line, newest first, so the picker offers only those. */
      days: await journal().mtmDays(120, account),
    };
  });
}
