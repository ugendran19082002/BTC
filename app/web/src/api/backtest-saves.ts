import { json, post } from '@/api/client';
import { pickQuery } from '@/api/signal-backtest';
import type { TradePick } from '@/types/signal-backtest';
import type { BacktestPortfolio, BacktestPortfolioResult, BtDayTrades, BacktestSave, BacktestSaves, LiveCheck, SavedQuery } from '@/types/signal-backtest';

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
export const getBacktestPortfolio = (ids: readonly string[], range: { from: string; to: string }, limit: PortfolioLimit = 'shared', cap: PortfolioCap | null = null, hours: PortfolioHours = AS_SAVED, over: PortfolioOver = {}) =>
  json<BacktestPortfolioResult>(`/api/backtest-portfolio?${runSearch(ids, range, limit, cap, hours, over)}`);

/** The same run laid beside the live desk, signal for signal: asked exactly as the run is, with the name it goes by. */
export const getPortfolioLiveCheck = (name: string, ids: readonly string[], range: { from: string; to: string }, limit: PortfolioLimit = 'shared', cap: PortfolioCap | null = null, hours: PortfolioHours = AS_SAVED, over: PortfolioOver = {}) => {
  const p = runSearch(ids, range, limit, cap, hours, over);
  p.set('name', name);
  return json<LiveCheck>(`/api/backtest-portfolio/live-check?${p}`);
};

/** A run together's trades, one by one -- of a day, a session, a method (`TradePick`): asked exactly as the run is. */
export const getPortfolioTrades = (pick: TradePick, ids: readonly string[], range: { from: string; to: string }, limit: PortfolioLimit = 'shared', cap: PortfolioCap | null = null, hours: PortfolioHours = AS_SAVED, over: PortfolioOver = {}) => {
  const p = runSearch(ids, range, limit, cap, hours, over);
  for (const [k, v] of pickQuery(pick)) p.set(k, v);
  return json<BtDayTrades>(`/api/backtest-portfolio/trades?${p}`);
};

/** A run together as the server reads it: the days, the saved backtests, whose limit, the hours and the settings over the run. */
function runSearch(ids: readonly string[], range: { from: string; to: string }, limit: PortfolioLimit, cap: PortfolioCap | null, hours: PortfolioHours, over: PortfolioOver): URLSearchParams {
  return new URLSearchParams({
    ids: ids.join(','), from: range.from, to: range.to,
    ...(limit === 'own' ? { limit: 'own' } : cap ? { max: String(cap.max), ce: String(cap.ce), pe: String(cap.pe) } : {}),
    ...(hours.window === 'saved' ? {} : { hours: hours.window, ...(hours.window === 'custom' ? { hfrom: hours.hoursFrom ?? '', hto: hours.hoursTo ?? '' } : {}) }),
    ...overQuery(over),
  });
}

/**
 * Settings put over a run together (owner, 14 Oct 2026): each its own switch. One that is here is taken for the
 * run and applied to every saved backtest in it; one that is not is each saved backtest's own. Nothing is saved.
 */
export type PortfolioOver = {
  strike?: { rule: 'delta' | 'premium'; value: number };
  /** The option's own target: one share all day, or -- with steps -- one that moves by the clock. */
  target?: { targetPct: number; targetSteps?: { at: string; pct: number }[] };
  stop?: { stopPct: number };
  lots?: { lots: number };
  minPremium?: { minPremium: number };
  /** The SL and TGT range, BTC points, the four together; 0 is off. */
  range?: { slMin: number; slMax: number; tgtMin: number; tgtMax: number };
};

/** The run's settings as the route reads them: the single backtest's own names, each under `o_`. */
export function overQuery(o: PortfolioOver): Record<string, string> {
  const q: Record<string, string> = {};
  if (o.strike) { q.o_rule = o.strike.rule; q.o_value = String(o.strike.value); }
  if (o.target) {
    q.o_tp = String(o.target.targetPct);
    if (o.target.targetSteps?.length) q.o_tsteps = o.target.targetSteps.map((x) => `${x.at}:${Math.round(x.pct * 10_000) / 100}`).join(',');
  }
  if (o.stop) q.o_sl = String(o.stop.stopPct);
  if (o.lots) q.o_lots = String(o.lots.lots);
  if (o.minPremium) q.o_minprem = String(o.minPremium.minPremium);
  // All four, zeros too: "no range, for all of them" is a setting, not the absence of one.
  if (o.range) { q.o_slmin = String(o.range.slMin); q.o_slmax = String(o.range.slMax); q.o_tgtmin = String(o.range.tgtMin); q.o_tgtmax = String(o.range.tgtMax); }
  return q;
}

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
