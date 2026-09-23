import { describe, expect, it } from 'vitest';
import { strategyProblems } from '@/lib/strategy-rules';
import { DEFAULT_CONFIG, type StrategyConfig } from '@/types/strategy';

/**
 * The form's own checks. Same rules and same words as the server's
 * validateConfig (app/server/test/strategy/times.test.ts pins those), so what
 * the form says before a save is what the server would say after it.
 */
const cfg = (over: Partial<StrategyConfig> = {}): StrategyConfig => ({ ...DEFAULT_CONFIG, ...over });
const messages = (c: StrategyConfig, name = 'S') => strategyProblems(c, name).map((p) => p.message);

describe('entry and exit', () => {
  it('the defaults are fine', () => {
    expect(strategyProblems(cfg(), 'S')).toEqual([]);
  });

  it('[critical] a window running past the settlement is caught, in AM and PM, on the When tab', () => {
    const [p] = strategyProblems(cfg({ entryTime: '09:00', exitTime: '06:00' }), 'S');
    expect(p).toEqual({
      field: 'exitTime',
      tab: 'when',
      message: 'Exit (6:00 AM) comes after the 5:30 PM settlement that ends the contract entered at 9:00 AM. The last exit is 5:29 PM.',
    });
  });

  it('[critical] an overnight window is allowed: 11:30 PM to 5:30 AM', () => {
    expect(messages(cfg({ entryTime: '23:30', exitTime: '05:30' }))).toEqual([]);
    // a time step inside the window is measured forward from the entry, past midnight
    const step = (at: string) => cfg({ entryTime: '23:30', exitTime: '05:30', stopLossPct: 1, stopSteps: [{ at, value: 2 }] });
    expect(messages(step('05:00'))).toEqual([]);
    expect(messages(step('12:00')).join())
      .toMatch(/must be after entry \(11:30 PM\) and before exit \(5:30 AM\)/);
  });

  it('an exit at the same minute as the entry is no window at all', () => {
    expect(messages(cfg({ entryTime: '09:00', exitTime: '09:00' })).join()).toMatch(/cannot be the same time as entry/);
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

describe('the other settings land on their tabs', () => {

  it('puts each problem where its field is', () => {
    const ps = strategyProblems(cfg({ lots: 0, stopLossPct: 25, weekdays: [] }), 'S');
    expect(ps.map((p) => [p.field, p.tab])).toEqual([
      ['weekdays', 'when'], ['lots', 'sell'], ['stopLossPct', 'trade'],
    ]);
  });
});
