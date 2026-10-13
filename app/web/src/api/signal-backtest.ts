import { json, post } from '@/api/client';
import type { BacktestQuery, MethodOptionRecord, SignalBacktestResponse } from '@/types/signal-backtest';
import type { StrategyConfig } from '@/types/strategy';

/** The signal history traded as options on the contracts' recorded prices, for a range of expiry days and one set of rules. */
export function getSignalBacktest(q: BacktestQuery) {
  const p = new URLSearchParams({
    from: q.from, to: q.to, rule: q.params.rule, value: String(q.params.value), lots: String(q.params.lots),
    tp: String(q.params.targetPct), sl: String(q.params.stopPct), window: q.params.window,
    max: String(q.params.deskMax), ce: String(q.params.cePct), pe: String(q.params.pePct),
  });
  for (const [k, v] of [['slmin', q.params.slMin], ['slmax', q.params.slMax], ['tgtmin', q.params.tgtMin], ['tgtmax', q.params.tgtMax]] as const) if (v) p.set(k, String(v));
  if (q.params.targetSteps?.length) p.set('tsteps', q.params.targetSteps.map((x) => `${x.at}:${Math.round(x.pct * 10_000) / 100}`).join(','));
  if (q.params.vol && q.params.vol !== 'off') p.set('vol', q.params.vol);
  if (q.params.minPremium !== undefined && q.params.minPremium !== 10) p.set('minprem', String(q.params.minPremium));
  if (q.params.window === 'custom' && q.params.hoursFrom && q.params.hoursTo) { p.set('hfrom', q.params.hoursFrom); p.set('hto', q.params.hoursTo); }
  if (q.tfs.length) p.set('tf', q.tfs.join(','));
  if (q.methods.length) p.set('method', q.methods.join(','));
  if (q.strategy) p.set('strategy', q.strategy);
  return json<SignalBacktestResponse>(`/api/signal-backtest?${p}`);
}

/** Every method's record as options under a strategy's rules as they stand on its form -- saved or not; nothing is saved by asking. */
export const getMethodOptionRecord = (config: StrategyConfig) => post<MethodOptionRecord>('/api/signal-backtest/methods', { config });
