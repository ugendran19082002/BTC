import { time12 } from '@/lib/time';
import type { BacktestParams, SavedQuery } from '@/types/signal-backtest';

/**
 * A backtest's settings as the screen starts with them, and in words. Apart from the screen itself
 * (`SignalBacktest.tsx`) so that the saved backtests and the strategy form -- which shows the Backtest screen's own
 * method list beside the strategy's (`useOptionRecord`) -- can say them without carrying the screen along.
 */

/** The desk's own rules: what the screen opens on, and what a setting never chosen is. */
export const BACKTEST_DEFAULTS: BacktestParams = { rule: 'delta', value: 0.1, lots: 10, targetPct: 0.9, stopPct: 3, window: 'desk', deskMax: 0, cePct: 100, pePct: 100 };
/** The least premium an option is sold for where none is set, dollars. */
export const PREMIUM_FLOOR = 10;

export const targetLabel = (v: number) => (v > 0 ? `${Math.round(v * 100)}%` : 'No target');
export const stopLabel = (v: number) => (v > 0 ? `+${Math.round(v * 100)}%` : 'No stop');

/**
 * A set of settings in one line: what a result is of. Said on the folded settings panel and on the result -- and,
 * with its filters, under each saved backtest's name.
 */
export function settingsWords(q: SavedQuery, strategies: readonly { id: string; name: string }[], withFilters = false): string {
  const p: BacktestParams = { ...BACKTEST_DEFAULTS, ...q.params };
  const byStrategy = q.strategy !== null;
  const range = (min = 0, max = 0) => [min > 0 ? `≥ ${min}` : null, max > 0 ? `≤ ${max}` : null].filter(Boolean).join(' ');
  const target = p.targetSteps?.length
    ? `${Math.round(p.targetPct * 100)}% → ${Math.round(p.targetSteps[p.targetSteps.length - 1]!.pct * 100)}% by time (${p.targetSteps.length} steps)`
    : targetLabel(p.targetPct);
  const floor = p.minPremium ?? PREMIUM_FLOOR;
  return [
    byStrategy ? `by ${strategies.find((x) => x.id === q.strategy)?.name ?? 'a strategy'}'s rules` : null,
    !byStrategy ? (p.rule === 'delta' ? `delta ≤ ${p.value.toFixed(2)}` : `premium ≤ $${p.value}`) : null,
    !byStrategy ? `${p.lots} lot${p.lots === 1 ? '' : 's'}` : null,
    !byStrategy ? `TGT ${target}` : null,
    !byStrategy ? `SL ${stopLabel(p.stopPct)}` : null,
    !byStrategy && floor !== PREMIUM_FLOOR ? (floor > 0 ? `premium ≥ $${floor}` : 'no premium floor') : null,
    !byStrategy ? (p.window === 'desk' ? '9:30 PM → 3:59 PM' : p.window === 'all' ? 'whole day' : p.hoursFrom && p.hoursTo ? `${time12(p.hoursFrom)} → ${time12(p.hoursTo)}` : null) : null,
    !byStrategy && (range(p.slMin, p.slMax) || range(p.tgtMin, p.tgtMax))
      ? [range(p.slMin, p.slMax) && `SL ${range(p.slMin, p.slMax)}`, range(p.tgtMin, p.tgtMax) && `TGT ${range(p.tgtMin, p.tgtMax)}`].filter(Boolean).join(', ') + ' pts'
      : null,
    p.vol && p.vol !== 'off' ? `${p.vol} volatility` : null,
    p.deskMax > 0 ? `at most ${p.deskMax} open · CE ${p.cePct}% · PE ${p.pePct}%` : 'no open limit',
    withFilters && q.tfs.length ? `on ${q.tfs.map((t) => (t === 'chain' ? 'TF chain' : t)).join(', ')}` : null,
    withFilters && q.methods.length ? `${q.methods.length} method${q.methods.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
}
