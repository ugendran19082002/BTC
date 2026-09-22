import type { ExitMode, ExitStep, PremiumMode, StrategyConfig } from '@/types/strategy';
import { hhmmOf, isHhmm, minutesForward, minutesOf, time12 } from '@/lib/time';

/**
 * A strategy's two exits, read as a percentage or as points, and moved through
 * the day by time steps:
 *
 *   entry 5:30   target 80%
 *   from  7:30   target 85%
 *   from  9:30   target 90%
 *
 * The same rules, and the same words, as `strategy/types.ts` on the server --
 * which stays the authority and answers a save it will not take.
 */

export type ExitLeg = 'target' | 'stop';
export type ExitRule = { mode: ExitMode; value: number; steps: ExitStep[] };

/** A target keeps at most 99% of the premium: 100% is a buy at zero, which no limit rests at. */
export const MAX_TARGET_PCT = 0.99;
/** A stop may sit far above 100% -- a short option can multiply -- but 2000% is a typo. */
export const MAX_STOP_PCT = 20;
/** The most a fixed exit may sit from the entry, in the option's own price. */
export const MAX_EXIT_POINTS = 10_000;
export const MAX_EXIT_STEPS = 24;

/** Both exits of a config; a strategy saved before modes and steps reads as a percentage, all day. */
export function exitRules(c: StrategyConfig): Record<ExitLeg, ExitRule> {
  const targetMode: ExitMode = c.targetMode === 'points' ? 'points' : 'pct';
  const stopMode: ExitMode = c.stopMode === 'points' ? 'points' : 'pct';
  return {
    target: { mode: targetMode, value: targetMode === 'points' ? (c.takeProfitPoints ?? 0) : c.takeProfitPct, steps: c.targetSteps ?? [] },
    stop: { mode: stopMode, value: stopMode === 'points' ? (c.stopLossPoints ?? 0) : c.stopLossPct, steps: c.stopSteps ?? [] },
  };
}

/** The config fields one rule is stored in -- the other mode's value is kept, not wiped. */
export function withExitRule(c: StrategyConfig, leg: ExitLeg, rule: ExitRule): StrategyConfig {
  return leg === 'target'
    ? {
        ...c, targetMode: rule.mode, targetSteps: rule.steps,
        ...(rule.mode === 'points' ? { takeProfitPoints: rule.value } : { takeProfitPct: rule.value }),
      }
    : {
        ...c, stopMode: rule.mode, stopSteps: rule.steps,
        ...(rule.mode === 'points' ? { stopLossPoints: rule.value } : { stopLossPct: rule.value }),
      };
}

/** Whether a rule does anything at the entry. */
export const exitOn = (r: ExitRule) => r.value > 0;

function valueProblem(leg: ExitLeg, mode: ExitMode, v: number): string | null {
  const Leg = leg === 'target' ? 'Take profit' : 'Stop loss';
  if (!Number.isFinite(v) || v < 0) return `${Leg} cannot be negative or blank.`;
  if (mode === 'points') {
    return v > MAX_EXIT_POINTS ? `${Leg} must be at most ${MAX_EXIT_POINTS.toLocaleString('en-US')} points from the entry.` : null;
  }
  if (leg === 'target') return v > MAX_TARGET_PCT ? 'Take profit must be between 0 and 99% of the credit.' : null;
  return v > MAX_STOP_PCT ? 'Stop loss must be between 0 and 2000% of the credit.' : null;
}

/**
 * Everything wrong with one exit, start and steps. Each step must fall after
 * the entry and before the exit -- the position is gone by then -- and after
 * the step before it.
 */
export function exitRuleProblems(leg: ExitLeg, rule: ExitRule, entryTime: string, exitTime: string): string[] {
  const bad: string[] = [];
  const Leg = leg === 'target' ? 'Take profit' : 'Stop loss';
  const first = valueProblem(leg, rule.mode, rule.value);
  if (first) bad.push(first);
  if (rule.steps.length > MAX_EXIT_STEPS) bad.push(`${Leg} can change at most ${MAX_EXIT_STEPS} times a day.`);
  const windowOk = isHhmm(entryTime) && isHhmm(exitTime);
  const entry = windowOk ? minutesOf(entryTime) : 0;
  const span = windowOk ? minutesForward(entry, minutesOf(exitTime)) : 0;
  let last = 0;
  rule.steps.forEach((st, i) => {
    const n = i + 1;
    if (!isHhmm(st.at)) {
      bad.push(`${Leg} step ${n} needs a time of day, like 7:30 AM.`);
    } else if (windowOk) {
      const at = minutesForward(entry, minutesOf(st.at));
      if (at === 0 || at >= span) {
        bad.push(`${Leg} step ${n} (${time12(st.at)}) must be after entry (${time12(entryTime)}) and before exit (${time12(exitTime)}).`);
      } else if (at <= last) {
        bad.push(`${Leg} step ${n} (${time12(st.at)}) must come after step ${n - 1}.`);
      }
      last = Math.max(last, at);
    }
    const p = valueProblem(leg, rule.mode, st.value);
    if (p) bad.push(`Step ${n}: ${p}`);
  });
  return bad;
}

/** Why a premium fallback is not usable, or null. The server's words. */
export function premiumFallbackProblem(p: { mode: PremiumMode; usd: number; fallbackUsd?: number | null }): string | null {
  const f = p.fallbackUsd;
  if (f === null || f === undefined) return null;
  if (!(f > 0) || f > 10_000) return 'The fallback premium must be a positive number of dollars.';
  if (p.mode === 'atMost' && !(f > p.usd)) return `The fallback must be above $${p.usd}: it is tried when nothing is at or below $${p.usd}.`;
  if (p.mode === 'atLeast' && !(f < p.usd)) return `The fallback must be below $${p.usd}: it is tried when nothing pays $${p.usd}.`;
  return null;
}

/** A sensible first fallback: two and a half times an at-most cap, half an at-least floor. */
export const suggestedFallback = (p: { mode: PremiumMode; usd: number }): number =>
  p.mode === 'atMost' ? Math.round(p.usd * 2.5) : Math.max(1, Math.round(p.usd / 2));

/**
 * Fill the steps in one go: every `everyMin` from the entry, the value moving
 * by `by` each time -- "every 2 hours, 5% more" -- up to the exit.
 *
 * Stops early rather than writing steps that change nothing: once a target has
 * reached its 99% ceiling, or a value has fallen to zero, another step would
 * only be noise in the table.
 */
export function fillSteps(o: {
  leg: ExitLeg; mode: ExitMode; entryTime: string; exitTime: string; start: number; everyMin: number; by: number;
}): ExitStep[] {
  if (!isHhmm(o.entryTime) || !isHhmm(o.exitTime) || !(o.everyMin >= 1)) return [];
  const entry = minutesOf(o.entryTime);
  const span = minutesForward(entry, minutesOf(o.exitTime));
  const ceiling = o.mode === 'points' ? MAX_EXIT_POINTS : o.leg === 'target' ? MAX_TARGET_PCT : MAX_STOP_PCT;
  const steps: ExitStep[] = [];
  let value = o.start;
  for (let at = o.everyMin; at < span && steps.length < MAX_EXIT_STEPS; at += o.everyMin) {
    const next = round(Math.min(ceiling, Math.max(0, value + o.by)));
    if (next === value) break;
    value = next;
    steps.push({ at: hhmmOf(entry + at), value });
  }
  return steps;
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** "80%" / "10 pts" / "off". */
export function exitWords(mode: ExitMode, value: number): string {
  if (!(value > 0)) return 'off';
  return mode === 'points' ? `${value} pts` : `${Math.round(value * 1000) / 10}%`;
}

/**
 * The price an exit would buy back at, off an entry: the same arithmetic as
 * the server's `targetFor` / `stopFor`, for showing the level while it is typed.
 */
export function exitPrice(leg: ExitLeg, mode: ExitMode, value: number, entry: number | null): number | null {
  if (entry === null || !(value > 0)) return null;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  if (leg === 'stop') return mode === 'points' ? r1(entry + value) : r1(entry * (1 + value));
  return mode === 'points'
    ? Math.max(0.1, r1(Math.max(entry * 0.01, entry - value)))
    : r1(entry * (1 - Math.min(MAX_TARGET_PCT, value)));
}
