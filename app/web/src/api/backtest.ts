import type { BacktestResponse, ByYearResponse, FloorResponse, Params } from '@/types/desk';
import { post } from '@/api/client';

export function runBacktest(params: Partial<Params>) {
  return post<BacktestResponse>('/api/backtest', params);
}

export function runByYear(params: Partial<Params>) {
  return post<ByYearResponse>('/api/backtest/byyear', params);
}

export function runFloors(params: Partial<Params> & { floors?: number[] }) {
  return post<FloorResponse>('/api/floors', params);
}
