import { json, post } from '@/api/client';
import type { BacktestQuery, BtDayTrades, LiveCheck, TradePick, MethodOptionRecord, SignalBacktestResponse, VolAsk, VolStudyResult } from '@/types/signal-backtest';
import type { AutoMethodsRun, StrategyConfig, WalkForward } from '@/types/strategy';
import { noEntryQuery } from '@/lib/backtest-no-entry';
import { strikeBlocksQuery } from '@/lib/backtest-strike-blocks';
import { tslQuery } from '@/lib/backtest-tsl';

/** A backtest's question as the server reads it: the days, the settings, the filters, the strategy. Shared with its live check, so both are of the same thing. */
function searchOf(q: BacktestQuery): URLSearchParams {
  const p = new URLSearchParams({
    from: q.from, to: q.to, rule: q.params.rule, value: String(q.params.value), lots: String(q.params.lots),
    tp: String(q.params.targetPct), sl: String(q.params.stopPct), window: q.params.window,
    max: String(q.params.deskMax), ce: String(q.params.cePct), pe: String(q.params.pePct),
  });
  for (const [k, v] of [['slmin', q.params.slMin], ['slmax', q.params.slMax], ['tgtmin', q.params.tgtMin], ['tgtmax', q.params.tgtMax]] as const) if (v) p.set(k, String(v));
  if (q.params.targetSteps?.length) p.set('tsteps', q.params.targetSteps.map((x) => `${x.at}:${Math.round(x.pct * 10_000) / 100}`).join(','));
  if (q.params.vol && q.params.vol !== 'off') p.set('vol', q.params.vol);
  if (q.params.volBy === 'iv') p.set('volby', 'iv');
  if (q.params.minPremium !== undefined && q.params.minPremium !== 10) p.set('minprem', String(q.params.minPremium));
  if (q.params.window === 'custom' && q.params.hoursFrom && q.params.hoursTo) { p.set('hfrom', q.params.hoursFrom); p.set('hto', q.params.hoursTo); }
  // Only windows that are right for the hours: the editor says what is wrong with any other.
  const noEntry = noEntryQuery(q.params);
  if (noEntry) p.set('noentry', noEntry);
  // Only blocks right for the hours, as the windows: the editor says what is wrong with any other.
  const blocks = strikeBlocksQuery(q.params);
  if (blocks) p.set('sblocks', blocks);
  // A trailing SL only where it is right: the editor says what is wrong with any other.
  const tsl = tslQuery(q.params);
  if (tsl) p.set('tsl', tsl);
  // The perp's trails, where they are right: the editor says what is wrong with any other.
  const trail = (v: number | undefined) => (v !== undefined && v > 0 && v <= 20 ? String(v) : null);
  if (trail(q.params.trailSlAtr)) p.set('ptsl', trail(q.params.trailSlAtr)!);
  if (trail(q.params.trailTgtAtr)) p.set('pttgt', trail(q.params.trailTgtAtr)!);
  if (q.tfs.length) p.set('tf', q.tfs.join(','));
  if (q.methods.length) p.set('method', q.methods.join(','));
  if (q.strategy) p.set('strategy', q.strategy);
  return p;
}

/** The signal history traded as options on the contracts' recorded prices, for a range of expiry days and one set of rules. */
export const getSignalBacktest = (q: BacktestQuery) => json<SignalBacktestResponse>(`/api/signal-backtest?${searchOf(q)}`);

/**
 * The same backtest laid beside the live desk, signal for signal: by a strategy, its own rules against its own
 * record; by the screen's settings, those settings against what the desk did with each signal under any strategy.
 */
/** The backtest on the screen's trades, one by one: of a day, a session of the day, a method (`TradePick`). */
export const getBacktestTrades = (q: BacktestQuery, pick: TradePick) => {
  const p = searchOf(q);
  for (const [k, v] of pickQuery(pick)) p.set(k, v);
  return json<BtDayTrades>(`/api/signal-backtest/trades?${p}`);
};
/** A pick as the routes read it: `day`, `sfrom`/`sto`, `smethod`. */
export function pickQuery(pick: TradePick): [string, string][] {
  return [
    ...(pick.day ? [['day', pick.day]] as [string, string][] : []),
    ...(pick.slotFrom != null ? [['sfrom', String(pick.slotFrom)]] as [string, string][] : []),
    ...(pick.slotTo != null ? [['sto', String(pick.slotTo)]] as [string, string][] : []),
    ...(pick.method ? [['smethod', pick.method]] as [string, string][] : []),
  ];
}
/** What is set by volatility, as the routes read it (`volRuleOf`): each rule switched, and its three levels. */
export function volQuery(a: VolAsk): [string, string][] {
  const out: [string, string][] = [['vsl', a.sl ? '1' : '0'], ['vdelta', a.delta ? '1' : '0'], ['vlots', a.lots ? '1' : '0']];
  if (a.sl) out.push(['vh', String(a.sl.high)], ['vm', String(a.sl.medium)], ['vl', String(a.sl.low)]);
  if (a.delta) out.push(['dh', String(a.delta.high)], ['dm', String(a.delta.medium)], ['dl', String(a.delta.low)]);
  if (a.lots) out.push(['lh', String(a.lots.high)], ['lm', String(a.lots.medium)], ['ll', String(a.lots.low)]);
  return out;
}
/**
 * The option's SL, strike delta and lots as set, against the same by volatility, on the same signals (17 Oct 2026).
 * Report only: nothing is saved or changed.
 */
export const getVolStudy = (q: BacktestQuery, a: VolAsk) => {
  const p = searchOf(q);
  for (const [k, v] of volQuery(a)) p.set(k, v);
  return json<VolStudyResult>(`/api/signal-backtest/vol-study?${p}`);
};
/** One expiry day of the study, trade by trade: one side (as set, or by volatility), one way of reading the level. */
export type VolTradesPick = { day: string; side: 'fixed' | 'by-vol'; by: 'atr' | 'iv' };
export const getVolStudyTrades = (q: BacktestQuery, a: VolAsk, pick: VolTradesPick) => {
  const p = searchOf(q);
  for (const [k, v] of volQuery(a)) p.set(k, v);
  p.set('day', pick.day); p.set('side', pick.side); p.set('by', pick.by);
  return json<BtDayTrades>(`/api/signal-backtest/vol-study/trades?${p}`);
};
export const getLiveCheck = (q: BacktestQuery) => json<LiveCheck>(`/api/signal-backtest/live-check?${searchOf(q)}`);

/** Every method's record as options under a strategy's rules as they stand on its form -- saved or not; nothing is saved by asking. */
export const getMethodOptionRecord = (config: StrategyConfig) => post<MethodOptionRecord>('/api/signal-backtest/methods', { config });
/** The methods' daily update, now, on the form's draft: the list it would set by the draft's own win rate, trades and days. Nothing is saved. */
export const pickMethodsNow = (config: StrategyConfig) => post<AutoMethodsRun>('/api/strategies/auto-methods/pick', { config });
/** The draft's daily-update rule walked forward over finished days, the last `holdout` held out (`walkForward`). Read-only. */
export const walkMethodsForward = (config: StrategyConfig, o: { holdout: number }) => post<WalkForward>('/api/strategies/auto-methods/walk-forward', { config, holdout: o.holdout });
