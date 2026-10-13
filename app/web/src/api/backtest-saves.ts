import { json, post } from '@/api/client';
import type { BacktestPortfolio, BacktestPortfolioResult, BacktestSave, BacktestSaves, SavedQuery } from '@/types/signal-backtest';

/** Every saved backtest and portfolio, by name. */
export const getBacktestSaves = () => json<BacktestSaves>('/api/backtest-saves');

/** Keep settings under a name; with `id`, the same saved one again. The server checks the settings as it checks the screen's. */
export const saveBacktest = (s: { id?: string; name: string; query: SavedQuery }) =>
  post<{ ok: true; save: BacktestSave }>('/api/backtest-saves', s);

/** Delete a saved backtest: it leaves its portfolios, and one left with fewer than two is deleted with it and named. */
export const deleteBacktestSave = (id: string) =>
  json<{ ok: true; portfoliosDeleted: string[] }>(`/api/backtest-saves/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const savePortfolio = (p: { id?: string; name: string; saveIds: string[] }) =>
  post<{ ok: true; portfolio: BacktestPortfolio }>('/api/backtest-portfolios', p);

export const deletePortfolio = (id: string) =>
  json<{ ok: true }>(`/api/backtest-portfolios/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** Saved backtests run together over one range of expiry days, with their total. */
export const getBacktestPortfolio = (ids: readonly string[], range: { from: string; to: string }) =>
  json<BacktestPortfolioResult>(`/api/backtest-portfolio?${new URLSearchParams({ ids: ids.join(','), from: range.from, to: range.to })}`);
