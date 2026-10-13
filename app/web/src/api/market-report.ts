import { json } from '@/api/client';
import type { MarketBreakdownResponse, MarketQuery, MarketReportResponse, MarketScope } from '@/types/market-report';

function paramsOf(q: MarketQuery, scope: MarketScope = {}): string {
  const p = new URLSearchParams({ from: q.from, to: q.to });
  if (q.account !== null) p.set('account', String(q.account));
  if (q.tfs.length) p.set('tf', q.tfs.join(','));
  if (q.methods.length) p.set('method', q.methods.join(','));
  if (q.strategies.length) p.set('strategy', q.strategies.join(','));
  if (scope.day) p.set('day', scope.day);
  if (scope.pattern) p.set('pattern', scope.pattern);
  if (scope.family) p.set('family', scope.family);
  return p.toString();
}

/** Each expiry day with its figures, its kind and its results; the results by kind of day and by family. */
export const getMarketReport = (q: MarketQuery) => json<MarketReportResponse>(`/api/market-report?${paramsOf(q)}`);

/** One day, one kind of day, one family or the whole range: both records by pair, timeframe, method and strategy. */
export const getMarketBreakdown = (q: MarketQuery, scope: MarketScope) => json<MarketBreakdownResponse>(`/api/market-report/breakdown?${paramsOf(q, scope)}`);
