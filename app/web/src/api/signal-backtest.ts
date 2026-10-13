import { json } from '@/api/client';
import type { BacktestQuery, SignalBacktestResponse } from '@/types/signal-backtest';

/** The signal history traded as options on the contracts' recorded prices, for a range of expiry days and one set of rules. */
export function getSignalBacktest(q: BacktestQuery) {
  const p = new URLSearchParams({
    from: q.from, to: q.to, rule: q.params.rule, value: String(q.params.value), lots: String(q.params.lots),
    tp: String(q.params.targetPct), sl: String(q.params.stopPct), window: q.params.window,
  });
  if (q.tfs.length) p.set('tf', q.tfs.join(','));
  if (q.methods.length) p.set('method', q.methods.join(','));
  if (q.strategy) p.set('strategy', q.strategy);
  return json<SignalBacktestResponse>(`/api/signal-backtest?${p}`);
}
