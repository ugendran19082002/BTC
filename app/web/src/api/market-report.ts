import { json } from '@/api/client';
import type { MarketBreakdownResponse, MarketReportResponse } from '@/types/market-report';

const withAccount = (p: URLSearchParams, account: number | null) => { if (account !== null) p.set('account', String(account)); return p; };

/** Each expiry day of a range with its figures, its kind and both records' totals. */
export const getMarketReport = (range: { from: string; to: string }, account: number | null) =>
  json<MarketReportResponse>(`/api/market-report?${withAccount(new URLSearchParams({ from: range.from, to: range.to }), account)}`);

/** One expiry day opened: both records by pair, timeframe, method and strategy. */
export const getMarketBreakdown = (day: string, account: number | null) =>
  json<MarketBreakdownResponse>(`/api/market-report/breakdown?${withAccount(new URLSearchParams({ day }), account)}`);
