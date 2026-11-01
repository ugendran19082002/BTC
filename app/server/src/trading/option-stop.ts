import type { TradePlan } from './engine.js';
import type { TradeEvent, TradeState } from './types.js';

/**
 * A trade closed by its option stop, told to whoever asked (1 Nov 2026): the strategy runner, which may sell the other
 * side in its place (strategy/types.ts `REENTRY_KEY`). Told once per trade, when its position reaches nothing, by the
 * account's own desk (service.ts `onEvent`), after the journal has it.
 */

export type OptionStop = { plan: TradePlan; state: TradeState };

/**
 * Whether a closed trade went out on its option stop: the stop resting at Delta filled, or the desk's stop watch sent
 * the close (engine.ts `stopIfReached`, whose every reason begins "stop reached"). A close for the perp's levels, the
 * target, the exit time or a hand is not one.
 */
export const optionStopped = (state: Pick<TradeState, 'exitWinner'>, events: readonly TradeEvent[]): boolean =>
  state.exitWinner === 'stop_loss'
  || events.some((e) => e.t === 'exit_submitted' && (e.reason ?? '').startsWith('stop reached'));

const listeners: ((s: OptionStop) => void)[] = [];

/** Be told of every option stop, on every account's desk. */
export function onOptionStop(fn: (s: OptionStop) => void): void { listeners.push(fn); }

/** Tell everyone listening; one that throws is its own bug, never the trade's. */
export function announceOptionStop(s: OptionStop): void {
  for (const fn of listeners) {
    try { fn(s); } catch { /* a listener's failure is its own */ }
  }
}
