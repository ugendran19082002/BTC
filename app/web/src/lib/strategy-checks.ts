import type { LegConfig, Strategy, StrategyConfig } from '@/types/strategy';
import { exitRules, exitWords, type ExitLeg } from '@/lib/strategy-exits';
import { time12 } from '@/lib/time';

/**
 * Things that are allowed but probably not meant -- said as warnings, not
 * refused. Each one is a mistake a real strategy on this desk actually had
 * (22 Sep 2026): "UG-CE" selling puts beside "UG-PE", 200 lots on one strike
 * between them, and a 7:30 step that repeated the 80% before it.
 */

const sides = (legs: LegConfig): ('CE' | 'PE')[] => (legs === 'both' ? ['CE', 'PE'] : [legs]);

/** A name that says one side while the strategy sells the other. */
export function nameWarning(name: string, legs: LegConfig): string | null {
  const says = (tag: 'CE' | 'PE') => new RegExp(`(^|[^A-Z])${tag}([^A-Z]|$)`, 'i').test(name);
  const ce = says('CE');
  const pe = says('PE');
  if (ce && !pe && legs === 'PE') return 'The name says CE, but this sells a put (PE).';
  if (pe && !ce && legs === 'CE') return 'The name says PE, but this sells a call (CE).';
  return null;
}

/** Steps that repeat the value before them -- they change nothing -- or go back the other way. */
export function stepWarnings(c: StrategyConfig, leg: ExitLeg): string[] {
  const rule = exitRules(c)[leg];
  const out: string[] = [];
  let prev = rule.value;
  for (const st of rule.steps) {
    if (st.value === prev) {
      out.push(`The ${time12(st.at)} step keeps ${exitWords(rule.mode, st.value)} -- it changes nothing. Remove it, or give it a new value.`);
    } else if (leg === 'target' && rule.mode === 'pct' && st.value < prev) {
      out.push(`The ${time12(st.at)} step lowers the target from ${exitWords('pct', prev)} to ${exitWords('pct', st.value)}: it takes profit sooner than the step before.`);
    }
    prev = st.value;
  }
  return out;
}

/**
 * Two strategies that would enter the same leg at the same minute on the same
 * day: each is fine alone, and together they sell twice the lots on one strike.
 */
export function overlapWarnings(strategies: readonly Pick<Strategy, 'id' | 'name' | 'config'>[]): { ids: string[]; text: string }[] {
  const out: { ids: string[]; text: string }[] = [];
  for (let i = 0; i < strategies.length; i++) {
    for (let j = i + 1; j < strategies.length; j++) {
      const a = strategies[i]!;
      const b = strategies[j]!;
      if (a.config.entryTime !== b.config.entryTime) continue;
      if (!a.config.weekdays.some((d) => b.config.weekdays.includes(d))) continue;
      const shared = sides(a.config.legs).filter((l) => sides(b.config.legs).includes(l));
      if (!shared.length) continue;
      const lots = a.config.lots + b.config.lots;
      out.push({
        ids: [a.id, b.id],
        text: `${a.name} and ${b.name} both sell ${shared.join(' + ')} at ${time12(a.config.entryTime)} -- `
          + `with the same strike rule that is ${lots} lots on one strike when both are on.`,
      });
    }
  }
  return out;
}
