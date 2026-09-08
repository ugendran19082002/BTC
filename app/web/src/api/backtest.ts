import type { BacktestResponse, ByYearResponse, Params } from '@/types/desk';
import { post } from '@/api/client';

export function runBacktest(params: Partial<Params>) {
  return post<BacktestResponse>('/api/backtest', params);
}

export function runByYear(params: Partial<Params>) {
  return post<ByYearResponse>('/api/backtest/byyear', params);
}

