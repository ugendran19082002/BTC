import type { FastifyInstance } from 'fastify';
import { tradingService } from '../../trading/service.js';
import { daysCsv, daysReport, mtmStats } from '../../trading/pnl-history.js';
import { istDate } from '../../strategy/schedule.js';
import { refuse } from '../refuse.js';

/**
 * The record as a calendar, and a day as a line.
 *
 * Read-only, and every figure is computed from the journal on the way out --
 * the day rows from the fills, the line from the minute-by-minute samples --
 * so the screen never carries a number the journal cannot reproduce.
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

export function registerReportRoutes(app: FastifyInstance) {
  const svc = tradingService();

  /** Every trading day in the range, with the running total. */
  app.get('/api/report/days', async (req, reply) => {
    const r = rangeOf((req.query ?? {}) as { from?: unknown; to?: unknown });
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    // From a day before the range: a trade opened the evening before and
    // closed inside it is inside it, and it is fills that decide, not rows.
    const records = svc.store.between(Date.parse(r.from) - 2 * 86_400_000, Date.parse(r.to) + 2 * 86_400_000, 5_000);
    return { mode: svc.mode, ...daysReport(records, { ...r, spot: svc.spot }) };
  });

  app.get('/api/report/days.csv', async (req, reply) => {
    const r = rangeOf((req.query ?? {}) as { from?: unknown; to?: unknown });
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    const records = svc.store.between(Date.parse(r.from) - 2 * 86_400_000, Date.parse(r.to) + 2 * 86_400_000, 5_000);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="pnl-${r.from}-to-${r.to}.csv"`);
    return daysCsv(daysReport(records, { ...r, spot: svc.spot }));
  });

  /** One day, minute by minute. Today unless asked otherwise. */
  app.get('/api/report/mtm', async (req, reply) => {
    const q = (req.query ?? {}) as { day?: unknown };
    const day = q.day === undefined || q.day === '' ? istDate(Date.now()) : String(q.day);
    if (!DAY.test(day)) return refuse(reply, 400, { error: 'Day must be YYYY-MM-DD.' });
    const samples = svc.store.mtmSamples(day);
    return {
      mode: svc.mode,
      day,
      samples,
      stats: mtmStats(samples),
      /** Days that have a line, newest first, so the picker offers only those. */
      days: svc.store.mtmDays(),
    };
  });
}
