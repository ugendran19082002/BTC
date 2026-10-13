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

/** Saved backtests run together over one range of expiry days, with their total: as one account, or each on its own limit. */
export const getBacktestPortfolio = (ids: readonly string[], range: { from: string; to: string }, limit: PortfolioLimit = 'shared', cap: PortfolioCap | null = null, hours: PortfolioHours = AS_SAVED) =>
  json<BacktestPortfolioResult>(`/api/backtest-portfolio?${new URLSearchParams({
    ids: ids.join(','), from: range.from, to: range.to,
    ...(limit === 'own' ? { limit: 'own' } : cap ? { max: String(cap.max), ce: String(cap.ce), pe: String(cap.pe) } : {}),
    ...(hours.window === 'saved' ? {} : { hours: hours.window, ...(hours.window === 'custom' ? { hfrom: hours.hoursFrom ?? '', hto: hours.hoursTo ?? '' } : {}) }),
  })}`);

/**
 * The hours a run together is held to: `saved`, each saved backtest's own; or the desk's hours, the whole expiry
 * day, or hours of the owner's own -- put over every one of them worked by settings, for the run only.
 */
export type PortfolioHours = { window: 'saved' | 'desk' | 'all' | 'custom'; hoursFrom?: string; hoursTo?: string };
export const AS_SAVED: PortfolioHours = { window: 'saved' };

/** One account's limit as it is asked for: at most this many open together, and each side this per cent of it. */
export type PortfolioCap = { max: number; ce: number; pe: number };

/**
 * Whose limit on open trades a run together is held to: `shared`, one account's -- the largest "at most open" among
 * the saved backtests, for all of them together, as the desk's limit is the account's -- or `own`, each its own.
 */
export type PortfolioLimit = 'shared' | 'own';
