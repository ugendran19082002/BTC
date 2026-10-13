import type { FastifyInstance } from 'fastify';
import { tradingService } from '../../trading/service.js';
import { PATTERNS, FAMILIES, sessionDayOf, type PatternFamily, type PatternKey } from '../../report/market-day.js';
import { REPORT_FIRST_DAY, REPORT_MAX_DAYS, marketBreakdown, marketReport, type ReportFilters, type Scope } from '../../report/market-report.js';
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
const filtersOf = (q: unknown): ReportFilters => ({ account: accountOf(q), tfs: listOf(q, 'tf'), methods: listOf(q, 'method'), strategies: listOf(q, 'strategy') });

/** `?day=`, `?pattern=` or `?family=`: what the breakdown is of. None of them is the whole range. */
function scopeOf(q: { day?: unknown; pattern?: unknown; family?: unknown }): Scope | string {
  if (typeof q.day === 'string' && q.day !== '') return DAY.test(q.day) ? { kind: 'day', day: q.day } : 'Day must be YYYY-MM-DD.';
  if (typeof q.pattern === 'string' && q.pattern !== '') {
    return PATTERNS.some((p) => p.key === q.pattern) ? { kind: 'pattern', key: q.pattern as PatternKey } : 'No such market pattern.';
  }
  if (typeof q.family === 'string' && q.family !== '') {
    return FAMILIES.some((f) => f.key === q.family) ? { kind: 'family', key: q.family as PatternFamily } : 'No such family of market patterns.';
  }
  return { kind: 'all' };
}

export function registerMarketRoutes(app: FastifyInstance) {
  /** Each expiry day with its figures, its kind and its results; the results by kind of day and by family. */
  app.get('/api/market-report', async (req, reply) => {
    const r = rangeOf((req.query ?? {}) as { from?: unknown; to?: unknown });
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    return marketReport({ ...r, now: Date.now(), spot: tradingService().spot, ...filtersOf(req.query) });
  });

  /** One day, one kind of day, one family or the whole range: both records by pair, timeframe, method and strategy. */
  app.get('/api/market-report/breakdown', async (req, reply) => {
    const r = rangeOf((req.query ?? {}) as { from?: unknown; to?: unknown });
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    const scope = scopeOf((req.query ?? {}) as { day?: unknown; pattern?: unknown; family?: unknown });
    if (typeof scope === 'string') return refuse(reply, 400, { error: scope });
    return marketBreakdown({ ...r, now: Date.now(), spot: tradingService().spot, scope, ...filtersOf(req.query) });
  });
}
