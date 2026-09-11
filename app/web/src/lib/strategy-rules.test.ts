import { describe, expect, it } from 'vitest';
import { strategyProblems } from '@/lib/strategy-rules';
import { DEFAULT_CONFIG, type StrategyConfig } from '@/types/strategy';

/**
 * The form's own checks. Same rules and same words as the server's
 * validateConfig (app/server/test/strategy/times.test.ts pins those), so what
 * the form says before a save is what the server would say after it.
 */
const cfg = (over: Partial<StrategyConfig> = {}): StrategyConfig => ({ ...DEFAULT_CONFIG, ...over });
const add = (addUntil: string, over: Partial<StrategyConfig> = {}) =>
  cfg({ ...over, addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil } });
const messages = (c: StrategyConfig, name = 'S') => strategyProblems(c, name).map((p) => p.message);

describe('entry and exit', () => {
  it('the defaults are fine', () => {
    expect(strategyProblems(cfg(), 'S')).toEqual([]);
  });

  it('[critical] exit must come after entry, said in AM and PM, on the When tab', () => {
    const [p] = strategyProblems(cfg({ entryTime: '09:00', exitTime: '06:00' }), 'S');
    expect(p).toEqual({ field: 'exitTime', tab: 'when', message: 'Exit (6:00 AM) must be later in the day than entry (9:00 AM).' });
  });

  it('[critical] a daytime entry cannot exit at or after the 5:30 PM settlement', () => {
    expect(messages(cfg({ exitTime: '17:30' })).join()).toMatch(/5:30 PM settlement/);
    expect(messages(cfg({ exitTime: '17:29' }))).toEqual([]);
  });

  it('an evening entry may exit later the same evening', () => {
    expect(messages(cfg({ entryTime: '18:00', exitTime: '23:00' }))).toEqual([]);
  });

  it('a name is needed', () => {
    expect(strategyProblems(cfg(), '  ')[0]).toMatchObject({ field: 'name', tab: 'when' });
  });
});

describe('the latest time to add', () => {
  it('[critical] must sit strictly between entry and exit, on the Extras tab', () => {
    expect(messages(add('16:59'))).toEqual([]);
    for (const outside of ['05:30', '04:00', '17:29', '18:00']) {
      const ps = strategyProblems(add(outside), 'S');
      expect(ps).toHaveLength(1);
      expect(ps[0]).toMatchObject({ field: 'addUntil', tab: 'extras' });
      expect(ps[0]!.message).toBe(`The latest time to add (${outside === '05:30' ? '5:30 AM' : outside === '04:00' ? '4:00 AM' : outside === '17:29' ? '5:29 PM' : '6:00 PM'}) must be after entry (5:30 AM) and before exit (5:29 PM).`);
    }
  });

  it('follows the strategy\'s own times', () => {
    expect(messages(add('14:30', { entryTime: '09:00', exitTime: '15:00' }))).toEqual([]);
    expect(messages(add('15:30', { entryTime: '09:00', exitTime: '15:00' })).join()).toMatch(/before exit \(3:00 PM\)/);
  });

  it('is not checked with the add off', () => {
    expect(messages(cfg({ addToOpposite: null }))).toEqual([]);
  });
});

describe('the other settings land on their tabs', () => {
  it('puts each problem where its field is', () => {
    const ps = strategyProblems(cfg({ lots: 0, stopLossPct: 25, weekdays: [], doubleWhenOneSided: true, probGate: null }), 'S');
    expect(ps.map((p) => [p.field, p.tab])).toEqual([
      ['weekdays', 'when'], ['lots', 'sell'], ['stopLossPct', 'trade'], ['doubleWhenOneSided', 'extras'],
    ]);
  });
});
