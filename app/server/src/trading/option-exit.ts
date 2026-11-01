import type { TradePlan } from './engine.js';
import type { TradeEvent, TradeState } from './types.js';

/**
 * A trade closed by its option's own stop or target, told to whoever asked (1 Nov 2026): the strategy runner, which may
 * sell again in its place (strategy/types.ts `REENTRY_KEY`). Told once per trade, when its position reaches nothing, by
 * the account's own desk (service.ts `onEvent`), after the journal has it.
 */

export type OptionExitKind = 'stop' | 'target';
export type OptionExit = { plan: TradePlan; state: TradeState; by: OptionExitKind };

/**
 * How a closed trade went out, when it was the option's own level: its stop -- the stop resting at Delta filled, or the
 * desk's stop watch sent the close (engine.ts `stopIfReached`, whose every reason begins "stop reached") -- or its
 * target, resting at Delta. Null for a close on the perp's levels, the exit time or a hand. A stop judged while the
 * target filled is a stop: the trade was going out on it.
 */
export function optionExitOf(state: Pick<TradeState, 'exitWinner'>, events: readonly TradeEvent[]): OptionExitKind | null {
  if (state.exitWinner === 'stop_loss') return 'stop';
  if (events.some((e) => e.t === 'exit_submitted' && (e.reason ?? '').startsWith('stop reached'))) return 'stop';
  return state.exitWinner === 'take_profit' ? 'target' : null;
}

const listeners: ((x: OptionExit) => void)[] = [];

/** Be told of every option stop and target, on every account's desk. */
export function onOptionExit(fn: (x: OptionExit) => void): void { listeners.push(fn); }

/** Tell everyone listening; one that throws is its own bug, never the trade's. */
export function announceOptionExit(x: OptionExit): void {
  for (const fn of listeners) {
    try { fn(x); } catch { /* a listener's failure is its own */ }
  }
}
