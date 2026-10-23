import { json, post } from '@/api/client';
import { pickQuery, sessionPickQuery, sessionQuery, sweepCellQuery, sweepQuery, volQuery, type VolTradesPick } from '@/api/signal-backtest';
import { noEntryQuery } from '@/lib/backtest-no-entry';
import type { NoEntry, StrikeBlock } from '@/types/strategy';
import { backtestBlockProblems } from '@/lib/backtest-strike-blocks';
import type { BacktestParams, BreakEven, Chase, Tsl } from '@/types/signal-backtest';
import { breakEvenQuery, tslQuery } from '@/lib/backtest-tsl';
import { chaseQuery } from '@/lib/backtest-chase';
import type { SessionAsk, SessionStudyResult, SessionTradesPick, TradePick, VolAsk, VolStudyResult, WinSweepAsk, WinSweepCellKey, WinSweepResult } from '@/types/signal-backtest';
import type { BacktestPortfolio, BacktestPortfolioResult, BtDayTrades, BacktestSave, BacktestSaves, LiveCheck, SavedQuery } from '@/types/signal-backtest';

/** Every saved backtest and portfolio, by name. */
export const getBacktestSaves = () => json<BacktestSaves>('/api/backtest-saves');

/** Keep settings under a name; with `id`, the same saved one again. The server checks the settings as it checks the screen's. */
export const saveBacktest = (s: { id?: string; name: string; query: SavedQuery; group?: string | null }) =>
  post<{ ok: true; save: BacktestSave }>('/api/backtest-saves', s);
/** A copy of a saved backtest, its settings and its group, as "<name> copy" (a free name). */
export const cloneBacktestSave = (id: string) =>
  post<{ ok: true; save: BacktestSave }>(`/api/backtest-saves/${encodeURIComponent(id)}/clone`, {});
/** A group renamed, every saved backtest in it with it; `to` null takes them out of any group. */
export const renameBacktestGroup = (from: string, to: string | null) =>
  post<{ ok: true; moved: number }>('/api/backtest-saves/group', { from, to });
/** A copy of a portfolio, the same saved backtests in order, as "<name> copy". */
export const clonePortfolio = (id: string) =>
  post<{ ok: true; portfolio: BacktestPortfolio }>(`/api/backtest-portfolios/${encodeURIComponent(id)}/clone`, {});

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

/** The SL, delta and lots as saved against the same by volatility, over a run together's saved backtests: asked exactly as the run is. */
export const getPortfolioVolStudy = (a: VolAsk, ids: readonly string[], range: { from: string; to: string }, limit: PortfolioLimit = 'shared', cap: PortfolioCap | null = null, hours: PortfolioHours = AS_SAVED, over: PortfolioOver = {}) => {
  const p = runSearch(ids, range, limit, cap, hours, over);
  for (const [k, v] of volQuery(a)) p.set(k, v);
  return json<VolStudyResult>(`/api/backtest-portfolio/vol-study?${p}`);
};

/** One expiry day of the run's study, trade by trade, each with its saved backtest and level. */
export const getPortfolioVolStudyTrades = (a: VolAsk, pick: VolTradesPick, ids: readonly string[], range: { from: string; to: string }, limit: PortfolioLimit = 'shared', cap: PortfolioCap | null = null, hours: PortfolioHours = AS_SAVED, over: PortfolioOver = {}) => {
  const p = runSearch(ids, range, limit, cap, hours, over);
  for (const [k, v] of volQuery(a)) p.set(k, v);
  p.set('day', pick.day); p.set('side', pick.side); p.set('by', pick.by);
  return json<BtDayTrades>(`/api/backtest-portfolio/vol-study/trades?${p}`);
};

/** The SL, delta and win % by session over a run together's saved backtests: asked exactly as the run is. */
export const getPortfolioSessionStudy = (a: SessionAsk, ids: readonly string[], range: { from: string; to: string }, limit: PortfolioLimit = 'shared', cap: PortfolioCap | null = null, hours: PortfolioHours = AS_SAVED, over: PortfolioOver = {}) => {
  const p = runSearch(ids, range, limit, cap, hours, over);
  for (const [k, v] of sessionQuery(a)) p.set(k, v);
  return json<SessionStudyResult>(`/api/backtest-portfolio/session-study?${p}`);
};
export const getPortfolioSessionStudyTrades = (a: SessionAsk, pick: SessionTradesPick, ids: readonly string[], range: { from: string; to: string }, limit: PortfolioLimit = 'shared', cap: PortfolioCap | null = null, hours: PortfolioHours = AS_SAVED, over: PortfolioOver = {}) => {
  const p = runSearch(ids, range, limit, cap, hours, over);
  for (const [k, v] of [...sessionQuery(a), ...sessionPickQuery(pick)]) p.set(k, v);
  return json<BtDayTrades>(`/api/backtest-portfolio/session-study/trades?${p}`);
};

/**
 * Methods by win % at several bars over some of a run's saved backtests (`ids`, those ticked): asked as the run is, less
 * its own methods by win % -- the sweep picks at every bar itself.
 */
export const getPortfolioWinSweep = (a: WinSweepAsk, ids: readonly string[], range: { from: string; to: string }, limit: PortfolioLimit = 'shared', cap: PortfolioCap | null = null, hours: PortfolioHours = AS_SAVED, over: PortfolioOver = {}) => {
  const p = runSearch(ids, range, limit, cap, hours, { ...over, winPick: undefined });
  for (const [k, v] of sweepQuery({ ...a, split: false })) p.set(k, v);
  return json<WinSweepResult>(`/api/backtest-portfolio/win-sweep?${p}`);
};

/** One cell of the run's sweep, trade by trade: the row's saved backtest alone, asked as the run is. */
export const getPortfolioWinSweepTrades = (a: WinSweepAsk, row: string, cell: WinSweepCellKey, range: { from: string; to: string }, limit: PortfolioLimit = 'shared', cap: PortfolioCap | null = null, hours: PortfolioHours = AS_SAVED, over: PortfolioOver = {}) => {
  const p = runSearch([row], range, limit, cap, hours, { ...over, winPick: undefined });
  for (const [k, v] of [...sweepQuery({ ...a, split: false }), ...sweepCellQuery(row, cell)]) if (k !== 'w_pcts' && k !== 'w_trades') p.set(k, v);
  return json<BtDayTrades>(`/api/backtest-portfolio/win-sweep/trades?${p}`);
};

/** A run together as the server reads it: the days, the saved backtests, whose limit, the hours and the settings over the run. */
function runSearch(ids: readonly string[], range: { from: string; to: string }, limit: PortfolioLimit, cap: PortfolioCap | null, hours: PortfolioHours, over: PortfolioOver): URLSearchParams {
  return new URLSearchParams({
    ids: ids.join(','), from: range.from, to: range.to,
    ...(limit === 'own' ? { limit: 'own' } : cap ? {
      max: String(cap.max), ce: String(cap.ce), pe: String(cap.pe),
      ...(cap.sk !== undefined && cap.sk < 100 ? { sk: String(cap.sk), ...(cap.skf === 'skip' ? { skf: 'skip' } : {}) } : {}),
    } : {}),
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
  /** The volatility filter and what it reads, as the single backtest's: over a saved backtest by a strategy too. */
  vol?: { vol: 'off' | 'low' | 'medium' | 'high'; volBy: 'atr' | 'iv' };
  /** A strike rule by time of day over the run: the blocks after each member's own rule, held to the whole day; [] is one rule all day. */
  strikeBlocks?: { blocks: StrikeBlock[] };
  /** The SL and TGT range, BTC points, the four together; 0 is off. */
  range?: { slMin: number; slMax: number; tgtMin: number; tgtMax: number };
  /** No-entry windows for every one of them (15 Oct 2026), held to the whole expiry day: each keeps its own hours. */
  noEntry?: NoEntry;
  /** A trailing SL on every member's option stop (18 Oct 2026); null takes each member's own away for the run. */
  tsl?: { tsl: Tsl | null };
  /** The perp's SL and TGT widened with volatility over every member, the two together; 0 is off for the run. */
  perpWiden?: { slAtr: number; tgtAtr: number; mode?: 'widest' | 'calm' };
  /**
   * Methods by win % for the run (19 Oct 2026): each member by settings given its methods that won `pct`% or more of
   * `minTrades`+ trades -- on the `days` finished days before the run (`before`), or on the run's own (`same`, in-sample).
   */
  winPick?: { pct: number; minTrades: number; on: 'before' | 'first' | 'same' | 'custom'; days: number; pickFrom?: string; pickTo?: string };
  /** The perp's SL and TGT left out over every member, the two together; false is used. */
  skipPerp?: { sl: boolean; tgt: boolean };
  /** The option's stop to the price sold over every member; null takes each one's own away for the run. */
  breakEven?: { be: BreakEven | null };
  /** The chase guard over every member, a strategy's too (22 Oct 2026); null takes each one's own away for the run. */
  chase?: { chase: Chase | null };
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
  // Only windows right for the whole day; the editor says what is wrong with any other.
  const ne = o.noEntry ? noEntryQuery({ window: 'all', noEntry: { ...o.noEntry, on: true } } as BacktestParams) : null;
  if (ne) q.o_noentry = ne;
  if (o.vol) { q.o_vol = o.vol.vol; q.o_volby = o.vol.volBy; }
  // Only blocks right for the whole day; the editor says what is wrong with any other.
  // A trailing SL for the run, checked as if a stop were set: each member keeps its own stop unless the run sets one.
  if (o.tsl) {
    const t = o.tsl.tsl;
    if (t === null) q.o_tsl = 'off';
    else { const s = tslQuery({ tsl: t, stopPct: o.stop?.stopPct ?? 3 }); if (s) q.o_tsl = s; }
  }
  if (o.breakEven) { const s = o.breakEven.be === null ? 'off' : breakEvenQuery(o.breakEven.be); if (s) q.o_be = s; }
  if (o.chase) { const s = o.chase.chase === null ? 'off' : chaseQuery(o.chase.chase); if (s) q.o_chase = s; }
  // Only a pick that is right: the run's settings say what is wrong with any other.
  if (o.winPick && o.winPick.pct >= 1 && o.winPick.pct <= 100 && Number.isInteger(o.winPick.minTrades) && o.winPick.minTrades >= 1 && o.winPick.minTrades <= 100) { q.o_win = String(o.winPick.pct); q.o_wintrades = String(o.winPick.minTrades); q.o_winon = o.winPick.on; if (o.winPick.on === 'custom') { q.o_winfrom = o.winPick.pickFrom ?? ''; q.o_winto = o.winPick.pickTo ?? ''; } else q.o_windays = String(o.winPick.days); }
  if (o.skipPerp) { q.o_noperpsl = o.skipPerp.sl ? '1' : '0'; q.o_noperptgt = o.skipPerp.tgt ? '1' : '0'; }
  if (o.perpWiden) { q.o_wsl = String(o.perpWiden.slAtr); q.o_wtgt = String(o.perpWiden.tgtAtr); q.o_wmode = o.perpWiden.mode ?? 'widest'; }
  if (o.strikeBlocks && !backtestBlockProblems({ window: 'all', strikeBlocks: o.strikeBlocks.blocks }).length) q.o_sblocks = JSON.stringify(o.strikeBlocks.blocks);
  return q;
}

/**
 * The hours a run together is held to: `saved`, each saved backtest's own; or the desk's hours, the whole expiry
 * day, or hours of the owner's own -- put over every one of them worked by settings, for the run only.
 */
export type PortfolioHours = { window: 'saved' | 'desk' | 'all' | 'custom'; hoursFrom?: string; hoursTo?: string };
export const AS_SAVED: PortfolioHours = { window: 'saved' };

/** One account's limit as it is asked for: at most this many open together, and each side this per cent of it. */
export type PortfolioCap = {
  max: number; ce: number; pe: number;
  /** The most on one strike, per cent of `max` (100 or absent: none), and at it the next strike out or skip. */
  sk?: number; skf?: 'next' | 'skip';
};

/**
 * Whose limit on open trades a run together is held to: `shared`, one account's -- the largest "at most open" among
 * the saved backtests, for all of them together, as the desk's limit is the account's -- or `own`, each its own.
 */
export type PortfolioLimit = 'shared' | 'own';
