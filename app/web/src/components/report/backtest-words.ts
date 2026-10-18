import { time12 } from '@/lib/time';
import type { BacktestParams, SavedQuery } from '@/types/signal-backtest';
import { strikeBlocksWords } from '@/lib/backtest-strike-blocks';
import { breakEvenWords, tslWords } from '@/lib/backtest-tsl';

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

/** "perp SL skipped · perp TGT skipped": the perp levels left out, in a few words; null with both used. */
export function skipPerpWords(p: Pick<BacktestParams, 'skipPerpSl' | 'skipPerpTgt'>): string | null {
  const out = [p.skipPerpSl ? 'perp SL skipped' : null, p.skipPerpTgt ? 'perp TGT skipped' : null].filter(Boolean);
  return out.length ? out.join(' · ') : null;
}

/** "perp SL ≥ 10× ATR · TGT ≥ 20× ATR": the widening with volatility in a few words; null with none. */
export function perpWidenWords(p: Pick<BacktestParams, 'widenSlAtr' | 'widenTgtAtr' | 'widenMode'>): string | null {
  const sl = p.widenSlAtr ?? 0, tg = p.widenTgtAtr ?? 0;
  if (!(sl > 0) && !(tg > 0)) return null;
  return `perp ${[sl > 0 ? `SL ≥ ${sl}× ATR` : null, tg > 0 ? `TGT ≥ ${tg}× ATR` : null].filter(Boolean).join(' · ')} (${p.widenMode === 'calm' ? 'widens with volatility, back when calm' : 'widens with volatility, kept widest'})`;
}

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
    !byStrategy && p.stopPct > 0 ? tslWords(p.tsl) : null,
    !byStrategy ? breakEvenWords(p.breakEven) : null,
    !byStrategy ? perpWidenWords(p) : null,
    !byStrategy ? skipPerpWords(p) : null,
    !byStrategy && floor !== PREMIUM_FLOOR ? (floor > 0 ? `premium ≥ $${floor}` : 'no premium floor') : null,
    !byStrategy ? (p.window === 'desk' ? '9:30 PM → 3:59 PM' : p.window === 'all' ? 'whole day' : p.hoursFrom && p.hoursTo ? `${time12(p.hoursFrom)} → ${time12(p.hoursTo)}` : null) : null,
    !byStrategy && (range(p.slMin, p.slMax) || range(p.tgtMin, p.tgtMax))
      ? [range(p.slMin, p.slMax) && `SL ${range(p.slMin, p.slMax)}`, range(p.tgtMin, p.tgtMax) && `TGT ${range(p.tgtMin, p.tgtMax)}`].filter(Boolean).join(', ') + ' pts'
      : null,
    !byStrategy ? strikeBlocksWords(p.strikeBlocks) : null,
    !byStrategy && p.noEntry?.on && p.noEntry.windows.length ? `no entry ${p.noEntry.windows.map((w) => `${time12(w.from)} – ${time12(w.to)}`).join(', ')}` : null,
    p.vol && p.vol !== 'off' ? `${p.vol} volatility${p.volBy === 'iv' ? ' by ATM IV' : ''}` : null,
    p.deskMax > 0 ? `at most ${p.deskMax} open · CE ${p.cePct}% · PE ${p.pePct}%` : 'no open limit',
    withFilters && q.tfs.length ? `on ${q.tfs.map((t) => (t === 'chain' ? 'TF chain' : t)).join(', ')}` : null,
    withFilters && q.methods.length ? `${q.methods.length} method${q.methods.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
}

/**
 * Settings put over a run together, each in a few words -- only those that were (`BacktestPortfolioResult.over`).
 * The same words a saved backtest's own line uses, so "delta ≤ 0.10" over the run reads as it does under a name.
 */
export function overWords(p: Partial<BacktestParams>): string[] {
  const range = (min = 0, max = 0) => [min > 0 ? `≥ ${min}` : null, max > 0 ? `≤ ${max}` : null].filter(Boolean).join(' ');
  const out: string[] = [];
  if (p.rule !== undefined && p.value !== undefined) out.push(p.rule === 'delta' ? `strike delta ≤ ${p.value.toFixed(2)}` : `strike premium ≤ $${p.value}`);
  if (p.targetPct !== undefined) {
    out.push(p.targetSteps?.length
      ? `target ${Math.round(p.targetPct * 100)}% → ${Math.round(p.targetSteps[p.targetSteps.length - 1]!.pct * 100)}% by time (${p.targetSteps.length} step${p.targetSteps.length === 1 ? '' : 's'})`
      : p.targetPct > 0 ? `target ${targetLabel(p.targetPct)}` : 'no target');
  }
  if (p.stopPct !== undefined) out.push(p.stopPct > 0 ? `stop ${stopLabel(p.stopPct)}` : 'no stop');
  if (p.tsl !== undefined) out.push(tslWords(p.tsl) ?? 'no trailing SL');
  if (p.breakEven !== undefined) out.push(breakEvenWords(p.breakEven) ?? 'no SL to entry');
  if (p.skipPerpSl !== undefined || p.skipPerpTgt !== undefined) out.push(skipPerpWords(p) ?? 'the perp SL and TGT used');
  if (p.widenSlAtr !== undefined || p.widenTgtAtr !== undefined) out.push(perpWidenWords(p) ?? 'perp SL and TGT the signal\'s own');
  if (p.lots !== undefined) out.push(`${p.lots} lot${p.lots === 1 ? '' : 's'} a signal`);
  if (p.minPremium !== undefined) out.push(p.minPremium > 0 ? `premium ≥ $${p.minPremium}` : 'no premium floor');
  if (p.slMin !== undefined) {
    const sl = range(p.slMin, p.slMax), tgt = range(p.tgtMin, p.tgtMax);
    out.push(sl || tgt ? `${[sl && `SL ${sl}`, tgt && `TGT ${tgt}`].filter(Boolean).join(', ')} pts` : 'no SL / TGT range');
  }
  if (p.noEntry?.on && p.noEntry.windows.length) out.push(`no entry ${p.noEntry.windows.map((w) => `${time12(w.from)} – ${time12(w.to)}`).join(', ')}`);
  if (p.strikeBlocks !== undefined) out.push(strikeBlocksWords(p.strikeBlocks) ?? 'one strike rule all day');
  if (p.vol !== undefined) out.push(p.vol === 'off' ? 'every volatility' : `${p.vol} volatility only${p.volBy === 'iv' ? ' (ATM IV)' : ''}`);
  return out;
}
