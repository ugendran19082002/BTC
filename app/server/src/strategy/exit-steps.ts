import type { TradeRecord } from '../trading/engine.js';
import type { ExitAsk } from '../trading/order-plan.js';
import { istMinutes } from './schedule.js';
import {
  exitAsk, exitRules, exitValueAt, minutesForward, minutesOf, time12,
  type ExitRule, type Strategy,
} from './types.js';

/**
 * Time-based exits: move a strategy's target and stop as the day goes on.
 *
 *   entry 5:30   target 80%
 *   from  7:30   target 85%
 *   from  9:30   target 90%
 *
 * The value in force is a pure function of the clock (`exitValueAt`), so this
 * keeps no schedule of its own. What it keeps is which stage it last put on
 * each trade, so a stage is applied once, when it begins -- not every tick.
 * Applying it every tick would undo a stop somebody moved by hand from the
 * Edit exits sheet twenty seconds after they moved it.
 *
 * That memory is in-process on purpose. After a restart the stage in force is
 * applied once more, which is the safe direction: the position ends up
 * protected at the level the schedule says, and the journal records the move.
 *
 * Everything outside is passed in, so the whole path runs in a test against
 * the real engine on the paper exchange.
 */

export type ExitStepperDeps = {
  /** The strategy's open trades. */
  openTrades: (strategyId: string) => TradeRecord[] | Promise<TradeRecord[]>;
  /** Move the exits: `TradingService.updateExits`, measured off each trade's own entry. */
  move: (tradeId: string, ask: ExitAsk) => Promise<unknown>;
  /** Said once per trade per stage, keyed by the trade it moved. */
  tell?: (text: string, tradeId: string) => void;
  now: () => number;
};

/** "0:0" is the starting values -- what the entry was placed with. */
const START = '0:0';

export class StrategyExitStepper {
  private readonly applied = new Map<string, string>();

  constructor(private readonly d: ExitStepperDeps) {}

  /**
   * Put the stage in force on every open trade of this strategy that does not
   * have it yet. Returns the trades moved.
   */
  async consider(s: Strategy): Promise<string[]> {
    if (!s.enabled) return [];
    const { target, stop } = exitRules(s.config);
    if (!target.steps.length && !stop.steps.length) return [];

    const minute = istMinutes(this.d.now());
    // After the exit time the position is being closed, and nothing moves it.
    const entry = minutesOf(s.config.entryTime);
    if (minutesForward(entry, minute) >= minutesForward(entry, minutesOf(s.config.exitTime))) return [];

    const t = exitValueAt(target, s.config.entryTime, minute);
    const st = exitValueAt(stop, s.config.entryTime, minute);
    const key = `${t.stage}:${st.stage}`;

    const trades = await this.d.openTrades(s.id);
    const moved: string[] = [];
    for (const trade of trades) {
      const id = trade.state.tradeId;
      if (trade.state.position === 0 || trade.state.entryAvgPrice === null) continue;
      // A trade first seen here was placed with the starting values.
      const prev = this.applied.get(id) ?? START;
      if (prev === key) { this.applied.set(id, key); continue; }
      const [prevTarget, prevStop] = prev.split(':');
      // Only the leg whose stage changed: the other may have been moved by hand.
      const ask: ExitAsk = {
        ...(String(t.stage) !== prevTarget ? exitAsk(target, t.value, 'target') : {}),
        ...(String(st.stage) !== prevStop ? exitAsk(stop, st.value, 'stop') : {}),
      };
      // Not marked until it lands: a move that throws is tried again next tick.
      await this.d.move(id, ask);
      this.applied.set(id, key);
      moved.push(id);
      this.d.tell?.(stepWords(s, trade.plan.symbol, target, t, prevTarget, stop, st, prevStop), id);
    }
    // Forget trades that are gone, so the map does not grow for ever.
    const open = new Set(trades.filter((x) => x.state.position !== 0).map((x) => x.state.tradeId));
    for (const id of [...this.applied.keys()]) if (!open.has(id)) this.applied.delete(id);
    return moved;
  }
}

/** "80%" / "10 pts" / "off" -- a value in its rule's own units. */
export function exitWords(rule: ExitRule, value: number): string {
  if (!(value > 0)) return 'off';
  if (rule.mode === 'price') return `at ${value}`;
  return rule.mode === 'points' ? `${value} pts` : `${Math.round(value * 1000) / 10}%`;
}

function stepWords(
  s: Strategy, symbol: string,
  target: ExitRule, t: { value: number; stage: number }, prevTarget: string | undefined,
  stop: ExitRule, st: { value: number; stage: number }, prevStop: string | undefined,
): string {
  const at = (rule: ExitRule, stage: number) => (stage === 0 ? time12(s.config.entryTime) : time12(rule.steps[stage - 1]!.at));
  const parts: string[] = [];
  if (String(t.stage) !== prevTarget) parts.push(`target ${exitWords(target, t.value)} (from ${at(target, t.stage)})`);
  if (String(st.stage) !== prevStop) parts.push(`stop ${exitWords(stop, st.value)} (from ${at(stop, st.stage)})`);
  return `⏱ ${s.name} · ${symbol}: ${parts.join(', ')}`;
}
