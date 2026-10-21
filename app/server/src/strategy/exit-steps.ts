import type { TradeRecord } from '../trading/engine.js';
import { QUOTA_LADDER } from '../observability/desk-metrics.js';
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
  /**
   * Move the exits: `TradingService.updateExits`, measured off each trade's own
   * entry. `stage` is written on the trade, so a restart carries on from it.
   */
  move: (tradeId: string, ask: ExitAsk, stage: string) => Promise<unknown>;
  /** Said once per trade per stage, keyed by the trade it moved. */
  tell?: (text: string, tradeId: string) => void;
  /**
   * Written on the trade's own journal, for its timeline on the phone (12 Oct 2026): the day's steps once, and each
   * move as it lands. Only ever called for a strategy that has steps, so a fixed target leaves no line.
   */
  note?: (tradeId: string, note: { kind: 'schedule' | 'moved'; title: string; detail?: string }) => Promise<unknown>;
  /**
   * The stop first, the target second (owner, 21 Oct 2026): true while Delta's call quota is to be kept for stops.
   * A target's step then waits -- tried again at the next tick -- and a stop's step goes on: a stop moved by the clock
   * is the stop. Asked for each strategy, whose account's own quota is the one that counts. Absent: never.
   */
  stopsFirst?: (s: Strategy) => boolean;
  now: () => number;
};

/**
 * Above this share of its account's Delta quota a target's step waits for a later tick (21 Oct 2026): a step moves every
 * open trade's target at once -- an edit each, ninety of them -- and the stop watch keeps looking at stops up to 90%.
 * The SL first, the TGT second, the rest after (`QUOTA_LADDER`).
 */
export const TARGET_STEP_QUOTA_PCT = QUOTA_LADDER.target;

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
    // A bought option's exits are one level each, judged by the desk (and steps are refused for it on save).
    if (!s.enabled || s.config.signal?.action === 'buy') return [];
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
    const dynamic = target.steps.length > 0 || stop.steps.length > 0;
    for (const trade of trades) {
      const id = trade.state.tradeId;
      if (trade.state.position === 0 || trade.state.entryAvgPrice === null) continue;
      // The day's steps, said once on a trade of a strategy that has any: the first time it is seen holding a position.
      if (dynamic && this.d.note && !(trade.events ?? []).some((e) => e.t === 'exit_step' && e.kind === 'schedule')) {
        await this.d.note(id, { kind: 'schedule', title: scheduleTitle(target, stop), detail: scheduleWords(s, target, stop) }).catch(() => {});
      }
      // The stage written on the trade wins: it survives a restart, this map
      // does not. A trade with neither was placed with the starting values.
      const prev = trade.plan.exitStage ?? this.applied.get(id) ?? START;
      if (prev === key) { this.applied.set(id, key); continue; }
      const [prevTarget, prevStop] = prev.split(':');
      // The quota kept for stops: a target's step waits, and a stop's goes on alone -- the stage written says so, so
      // the target's is still owed and moves at a later tick.
      const holdTarget = String(t.stage) !== prevTarget && (this.d.stopsFirst?.(s) ?? false);
      const stopMoves = String(st.stage) !== prevStop;
      if (holdTarget && !stopMoves) continue;
      const stage = holdTarget ? `${prevTarget}:${st.stage}` : key;
      // What is said of the move: a held target did not move.
      const tNow = holdTarget ? { ...t, stage: Number(prevTarget) } : t;
      // Only the leg whose stage changed: the other may have been moved by hand.
      const ask: ExitAsk = {
        ...(String(t.stage) !== prevTarget && !holdTarget ? exitAsk(target, t.value, 'target') : {}),
        ...(stopMoves ? exitAsk(stop, st.value, 'stop') : {}),
      };
      // What the exits rest at before the move: read now, as the record may be the one the move changes.
      const was = { target: trade.plan.takeProfitPrice, stop: trade.plan.stopPrice };
      // Not marked until it lands: a move that throws is tried again next tick.
      await this.d.move(id, ask, stage);
      this.applied.set(id, stage);
      moved.push(id);
      this.d.tell?.(stepWords(s, trade.plan.symbol, target, tNow, prevTarget, stop, st, prevStop), id);
      // On the trade's journal too: what moved, from what, at which step -- and the new buy-back price where it is known.
      if (this.d.note) {
        const after = (await Promise.resolve(this.d.openTrades(s.id)).catch(() => [] as TradeRecord[])).find((x) => x.state.tradeId === id) ?? null;
        await this.d.note(id, movedNote(s, target, tNow, prevTarget, stop, st, prevStop, was, after)).catch(() => {});
      }
    }
    // Forget trades that are gone, so the map does not grow for ever.
    const open = new Set(trades.filter((x) => x.state.position !== 0).map((x) => x.state.tradeId));
    for (const id of [...this.applied.keys()]) if (!open.has(id)) this.applied.delete(id);
    return moved;
  }
}

/** "Dynamic target on" / "Dynamic stop on" / both: which exits move by the clock. */
function scheduleTitle(target: ExitRule, stop: ExitRule): string {
  const which = [target.steps.length ? 'target' : null, stop.steps.length ? 'stop' : null].filter(Boolean).join(' and ');
  return `Dynamic ${which} on`;
}

/** One exit's day in words: "70% · 75% from 11:30 PM · 80% from 1:30 AM". */
function ruleDay(rule: ExitRule): string {
  return [exitWords(rule, rule.value), ...rule.steps.map((st) => `${exitWords(rule, st.value)} from ${time12(st.at)}`)].join(' · ');
}

function scheduleWords(s: Strategy, target: ExitRule, stop: ExitRule): string {
  const parts: string[] = [];
  if (target.steps.length) parts.push(`Target ${ruleDay(target)}`);
  if (stop.steps.length) parts.push(`Stop ${ruleDay(stop)}`);
  return `${parts.join('. ')}. Set by ${s.name}.`;
}

/** The stage a leg was at, in its rule's words: 0 is the starting value, n the nth step. */
function stageWords(rule: ExitRule, stage: string | undefined): string | null {
  const n = Number(stage);
  if (!Number.isInteger(n) || n < 0 || n > rule.steps.length) return null;
  return exitWords(rule, n === 0 ? rule.value : rule.steps[n - 1]!.value);
}

/** What one step did, for the trade's timeline: "Target moved to 75%" / "11:30 PM step · was 70% · buy-back 6 → 5". */
function movedNote(
  s: Strategy,
  target: ExitRule, t: { value: number; stage: number }, prevTarget: string | undefined,
  stop: ExitRule, st: { value: number; stage: number }, prevStop: string | undefined,
  before: { target: number | null | undefined; stop: number | null | undefined }, after: TradeRecord | null,
): { kind: 'moved'; title: string; detail: string } {
  const at = (rule: ExitRule, stage: number) => (stage === 0 ? time12(s.config.entryTime) : time12(rule.steps[stage - 1]!.at));
  const px = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n * 100) / 100) : null);
  const titles: string[] = [];
  const details: string[] = [];
  if (String(t.stage) !== prevTarget) {
    titles.push(`Target moved to ${exitWords(target, t.value)}`);
    const was = stageWords(target, prevTarget);
    const a = px(before.target), b = px(after?.plan.takeProfitPrice);
    details.push([`${at(target, t.stage)} step`, was ? `was ${was}` : null, a && b && a !== b ? `buy-back ${a} → ${b}` : b ? `buy-back ${b}` : null].filter(Boolean).join(' · '));
  }
  if (String(st.stage) !== prevStop) {
    titles.push(`Stop moved to ${exitWords(stop, st.value)}`);
    const was = stageWords(stop, prevStop);
    const a = px(before.stop), b = px(after?.plan.stopPrice);
    details.push([`${at(stop, st.stage)} step`, was ? `was ${was}` : null, a && b && a !== b ? `stop ${a} → ${b}` : b ? `stop ${b}` : null].filter(Boolean).join(' · '));
  }
  return { kind: 'moved', title: titles.join(' · '), detail: details.join('. ') };
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
