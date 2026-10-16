import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoDue, autoPick, autoWindow, pickMethods, runAutoMethods, type AutoDeps } from '../../src/strategy/auto-methods.js';
import { DEFAULT_AUTO_METHODS, DEFAULT_CONFIG, autoMethodsProblems, validateConfig, type AutoMethods, type Strategy, type StrategyConfig } from '../../src/strategy/types.js';

/**
 * The methods' daily update (owner, 16 Oct 2026: "daily, a time chosen, the methods picked by a win %, auto update
 * on and off in the signal strategy form").
 */
const IST = (s: string) => Date.parse(`${s}+05:30`);
const signal = (methods: string[], auto: Partial<AutoMethods> | null = {}): StrategyConfig => ({
  ...DEFAULT_CONFIG, trigger: 'signal',
  signal: { mode: 'single', tf: '15m', methods, target: 'tp1', maxOpen: 100, action: 'sell', ...(auto ? { autoMethods: { ...DEFAULT_AUTO_METHODS, on: true, ...auto } } : {}) },
});
const strategy = (id: string, config: StrategyConfig): Strategy => ({ id, name: id, enabled: true, config, accountId: 1, createdAt: 0, updatedAt: 0 });

test('[critical] the days looked at are the last finished expiry days: the one being traded is left out', () => {
  // 9:00 PM on 16 Oct: the 16 Oct expiry settled at 5:30 PM, the 17 Oct one is trading.
  assert.deepEqual(autoWindow(IST('2026-10-16T21:00:00'), 7), { from: '2026-10-10', to: '2026-10-16' });
  // 10 AM on 16 Oct: the 16 Oct expiry is still trading.
  assert.deepEqual(autoWindow(IST('2026-10-16T10:00:00'), 1), { from: '2026-10-15', to: '2026-10-15' });
});

test('[critical] picked: won the share asked of enough trades, at or over, best net first', () => {
  const recs = [
    { method: 'a', trades: 4, wins: 3, net: 0.2 },  // 75%: in, at the line
    { method: 'b', trades: 10, wins: 9, net: 0.9 }, // 90%: in, first
    { method: 'c', trades: 2, wins: 2, net: 0.5 },  // 100% of too few
    { method: 'd', trades: 8, wins: 5, net: 1.0 },  // 62%
  ];
  assert.deepEqual(pickMethods(recs, { winPct: 75, minTrades: 3 }), ['b', 'a']);
  assert.deepEqual(pickMethods(recs, { winPct: 60, minTrades: 1 }), ['d', 'b', 'c', 'a']);
});

test('[critical] due once a day, after its time; caught up after a restart; off is never due', () => {
  const s = (last: number | null, auto: Partial<AutoMethods> = {}) => strategy('x', signal(['a'], { at: '21:00', ...auto, last: last === null ? null : { at: last, from: '', to: '', picked: [], before: [] } }));
  assert.equal(autoDue(s(null), IST('2026-10-16T20:59:00')), false, 'before the time');
  assert.equal(autoDue(s(null), IST('2026-10-16T21:00:00')), true);
  assert.equal(autoDue(s(null), IST('2026-10-16T23:40:00')), true, 'the server was down at 9 PM: run when it is back');
  assert.equal(autoDue(s(IST('2026-10-16T21:00:30')), IST('2026-10-16T21:05:00')), false, 'ran today already');
  assert.equal(autoDue(s(IST('2026-10-16T20:00:00')), IST('2026-10-16T21:01:00')), true, 'a "Pick now" before the time does not stand for the day\'s run');
  assert.equal(autoDue(s(IST('2026-10-15T21:00:30')), IST('2026-10-16T21:00:00')), true, 'the next day');
  assert.equal(autoDue(s(null, { on: false }), IST('2026-10-16T21:00:00')), false);
  assert.equal(autoDue(strategy('y', signal(['a'], null)), IST('2026-10-16T21:00:00')), false, 'a strategy saved before it');
});

test('[critical] nothing passes: the list is kept and the run says why -- a strategy is never emptied', async () => {
  const run = await autoPick(signal(['a', 'b']), { ...DEFAULT_AUTO_METHODS, on: true }, IST('2026-10-16T21:00:00'), null,
    async () => ({ from: '', to: '', priced: null as never, signals: 0, trades: 0, methods: [{ method: 'z', trades: 9, wins: 1, net: -1, byTf: [] }] }));
  assert.deepEqual(run.picked, ['a', 'b']);
  assert.match(run.note ?? '', /No method won 75% of 3 trades or more: the list was kept/);
});

test('[critical] the run: each due strategy picked, read again, only its list and last run written, one message for all', async () => {
  const now = IST('2026-10-16T21:00:10');
  const db = new Map<string, Strategy>([
    ['due', strategy('due', signal(['breakout', 'bos']))],
    ['later', strategy('later', signal(['basis'], { at: '22:00' }))],
    ['off', strategy('off', signal(['basis'], { on: false }))],
  ]);
  const told: string[] = [];
  const logged: Parameters<AutoDeps['log']>[0][] = [];
  const d: AutoDeps = {
    log: async (u) => { logged.push(u); },
    all: async () => [...db.values()],
    get: async (id) => {
      const s = db.get(id)!;
      // The owner saved the form while the record was worked out: their change is kept.
      return id === 'due' ? { ...s, config: { ...s.config, stopLossPct: 2.5 } } : s;
    },
    save: async (s) => { db.set(s.id, s); },
    pick: async (_c, _a, at) => ({ at, from: '2026-10-10', to: '2026-10-16', picked: ['momentum', 'breakout'], before: ['breakout', 'bos'],
      records: [{ method: 'momentum', trades: 5, wins: 5, net: 0.4 }, { method: 'breakout', trades: 4, wins: 3, net: 0.1 }, { method: 'bos', trades: 6, wins: 2, net: -0.3 }] }),
    tell: (t) => told.push(t),
    warn: () => assert.fail('no warning expected'),
  };
  assert.deepEqual(await runAutoMethods(now, d), ['due']);
  const saved = db.get('due')!.config;
  assert.deepEqual(saved.signal!.methods, ['momentum', 'breakout']);
  assert.equal(saved.signal!.autoMethods!.last!.at, now);
  assert.equal(saved.stopLossPct, 2.5, 'the form\'s save in the meantime survives');
  assert.deepEqual(db.get('later')!.config.signal!.methods, ['basis']);
  assert.equal(saved.signal!.autoMethods!.last!.records, undefined, 'the records go to the log, not into the config');
  // kept: the day's change, with the rule, the days, the lists and every record behind it
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0], {
    at: now, strategyId: 'due', strategyName: 'due', accountId: 1, source: 'daily', rule: { winPct: 75, minTrades: 3, days: 7 },
    from: '2026-10-10', to: '2026-10-16', before: ['breakout', 'bos'], after: ['momentum', 'breakout'],
    records: [{ method: 'momentum', trades: 5, wins: 5, net: 0.4 }, { method: 'breakout', trades: 4, wins: 3, net: 0.1 }, { method: 'bos', trades: 6, wins: 2, net: -0.3 }], note: null,
  });
  assert.equal(told.length, 1);
  assert.match(told[0]!, /<b>due<\/b>: 2 → 2 methods, \+1 −1 \(win ≥75% on 3\+, 10 Oct – 16 Oct\)/);
  // ran: not again today
  assert.deepEqual(await runAutoMethods(now + 60_000, d), []);
});

test('a failed record keeps the list, says why, and is not tried again every minute', async () => {
  const now = IST('2026-10-16T21:00:10');
  const db = new Map([['s', strategy('s', signal(['trap']))]]);
  const warned: string[] = [];
  const logged: Parameters<AutoDeps['log']>[0][] = [];
  const d: AutoDeps = {
    log: async (u) => { logged.push(u); },
    all: async () => [...db.values()], get: async (id) => db.get(id) ?? null, save: async (s) => { db.set(s.id, s); },
    pick: async () => { throw new Error('the backtest took too long'); }, tell: () => {}, warn: (m) => warned.push(m),
  };
  await runAutoMethods(now, d);
  assert.deepEqual(db.get('s')!.config.signal!.methods, ['trap']);
  assert.match(db.get('s')!.config.signal!.autoMethods!.last!.note ?? '', /could not be had: the backtest took too long/);
  assert.equal(warned.length, 1);
  assert.deepEqual([logged.length, logged[0]!.before, logged[0]!.after], [1, ['trap'], ['trap']], 'a day it did nothing is kept too, with why');
  assert.match(logged[0]!.note ?? '', /could not be had/);
  assert.deepEqual(await runAutoMethods(now + 60_000, d), []);
});

test('[critical] its settings are checked before a save', () => {
  assert.deepEqual(autoMethodsProblems(DEFAULT_AUTO_METHODS), []);
  assert.deepEqual(autoMethodsProblems(undefined), []);
  const bad = autoMethodsProblems({ on: true, at: '9pm', winPct: 0, minTrades: 1.5, days: 31 });
  assert.equal(bad.length, 4);
  // a strategy that buys has no record as options to pick by
  const buys = signal(['a']);
  buys.signal!.action = 'buy';
  assert.ok(validateConfig(buys).some((p) => /strategy that buys cannot use it/.test(p)));
  assert.deepEqual(validateConfig(signal(['a'])).filter((p) => /daily update/.test(p)), []);
});
