import { json } from '@/api/client';
import type { TimeWindow } from '@/lib/market-report';
import type { MarketBreakdownResponse, MarketReportResponse } from '@/types/market-report';

const withAccount = (p: URLSearchParams, account: number | null) => { if (account !== null) p.set('account', String(account)); return p; };
/** The window of each day asked for: only the trades entered in it (29 Oct 2026). None, the whole day. */
const withWindow = (p: URLSearchParams, w: TimeWindow | null | undefined) => { if (w) { p.set('fromTime', w.from); p.set('toTime', w.to); } return p; };

/** Each expiry day of a range with its figures, its kind and both records' totals. */
export const getMarketReport = (range: { from: string; to: string }, account: number | null, window?: TimeWindow | null) =>
  json<MarketReportResponse>(`/api/market-report?${withWindow(withAccount(new URLSearchParams({ from: range.from, to: range.to }), account), window)}`);

/** One expiry day opened: both records by pair, timeframe, method and strategy. */
export const getMarketBreakdown = (day: string, account: number | null, window?: TimeWindow | null) =>
  json<MarketBreakdownResponse>(`/api/market-report/breakdown?${withWindow(withAccount(new URLSearchParams({ day }), account), window)}`);
