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

describe('the launch auction and the minimum premium -- the server\'s words', () => {
  it('[critical] an entry from 5:30 to 5:34 PM is refused on the When tab; 5:35 PM is fine', () => {
    const at = (entryTime: string) => strategyProblems(cfg({ entryTime, exitTime: '05:00' }), 'S');
    expect(at('17:30')).toEqual([{
      field: 'entryTime', tab: 'when',
      message: 'Delta runs a launch auction for the new contract from 5:30 to 5:35 PM; an entry at 5:30 PM would be sent into it. Enter at 5:35 PM or later.',
    }]);
    expect(at('17:34').map((p) => p.field)).toEqual(['entryTime']);
    expect(at('17:35')).toEqual([]);
  });

  it('a minimum premium under one tick is refused; empty is the desk\'s', () => {
    expect(messages(cfg({ minPremiumUsd: 0.05 }))).toEqual(["The minimum premium must be at least $0.10, or left empty for the desk's $5."]);
    expect(messages(cfg({ minPremiumUsd: null }))).toEqual([]);
    expect(messages(cfg({ minPremiumUsd: 0.5 }))).toEqual([]);
  });
});

describe('a signal strategy: the server\'s signalRuleProblems, in its words', () => {
  const sig = (r: Partial<NonNullable<StrategyConfig['signal']>> = {}) =>
    cfg({ trigger: 'signal', signal: { mode: 'mtf', tf: '5m', methods: ['breakout'], target: 'tp1', maxOpen: 1, ...r } });
  it('a whole rule passes', () => {
    expect(messages(sig())).toEqual([]);
  });
  it('[critical] each part refused, on its own tab', () => {
    expect(messages(sig({ methods: [] }))).toContain('Pick at least one method whose signals to take.');
    expect(messages(sig({ mode: 'single', tf: '2m' as never }))).toContain('Pick a timeframe: 3m, 5m, 15m, 30m, 1h, 4h.');
    expect(messages(sig({ target: 'tp4' as never }))).toContain('The target must be TGT1, TGT2 or TGT3.');
    expect(messages(sig({ maxOpen: 101 }))).toContain('At most 1 to 100 of its trades open at once.');
    expect(messages(cfg({ trigger: 'signal' }))).toContain('A signal strategy needs its signals: the way, the timeframe and at least one method.');
    const tabs = Object.fromEntries(strategyProblems(sig({ methods: [], maxOpen: 0 }), 'S').map((p) => [p.field, p.tab]));
    expect(tabs).toEqual({ signalMethods: 'signal', maxOpen: 'trade' });
  });
  it('a clock strategy carrying an old rule is not judged on it', () => {
    expect(messages(cfg({ trigger: 'time', signal: { mode: 'mtf', tf: '5m', methods: [], target: 'tp1', maxOpen: 1 } }))).toEqual([]);
  });
});
