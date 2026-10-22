import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoDue, autoPick, autoWindow, lessExcluded, pickMethods, runAutoMethods, walkForward, type AutoDeps, type DayRecord } from '../../src/strategy/auto-methods.js';
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
    at: now, strategyId: 'due', strategyName: 'due', accountId: 1, source: 'daily', tf: '15m', rule: { winPct: 75, minTrades: 3, days: 7 },
    from: '2026-10-10', to: '2026-10-16', before: ['breakout', 'bos'], after: ['momentum', 'breakout'],
    records: [{ method: 'momentum', trades: 5, wins: 5, net: 0.4 }, { method: 'breakout', trades: 4, wins: 3, net: 0.1 }, { method: 'bos', trades: 6, wins: 2, net: -0.3 }], note: null,
  });
  // Nothing sent (20 Oct 2026, owner: "my strategies are private -- no Telegram for the methods' update"): there is no way to.
  assert.ok(!('tell' in d), 'the update has no channel to send by');
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
    pick: async () => { throw new Error('the backtest took too long'); }, warn: (m) => warned.push(m),
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
  // a strategy that buys is not taken at all (21 Oct 2026: selling only)
  const buys = signal(['a']);
  buys.signal!.action = 'buy';
  assert.ok(validateConfig(buys).some((p) => /only sells options/.test(p)));
  assert.deepEqual(validateConfig(signal(['a'])).filter((p) => /daily update/.test(p)), []);
});

/*
 * Exclude (owner, 18 Oct 2026: "an exclude option -- what I select there must not be chosen; on and off; on, at
 * least one picked"): the methods ticked there are never picked, however they did.
 */
const recordOf = (methods: { method: string; trades: number; wins: number; net: number }[]) =>
  async () => ({ from: '', to: '', priced: null as never, signals: 0, trades: 0, methods: methods.map((m) => ({ ...m, byTf: [] })) });

test('[critical] excluded: never picked, however it did -- and said, so its absence is no mystery', async () => {
  const recs = recordOf([
    { method: 'best', trades: 10, wins: 10, net: 2 }, // 100%, the best -- and excluded
    { method: 'good', trades: 4, wins: 3, net: 1 },
    { method: 'poor', trades: 9, wins: 1, net: -1 },
  ]);
  const now = IST('2026-10-16T21:00:00');
  const a = { ...DEFAULT_AUTO_METHODS, on: true, exclude: { on: true, methods: ['best'] } };
  const run = await autoPick(signal(['poor']), a, now, null, recs);
  assert.deepEqual([run.picked, run.excluded, run.note], [['good'], ['best'], undefined]);
  // off: ticked, and picked as before -- the ticks wait for the next time it is on
  const off = await autoPick(signal(['poor']), { ...a, exclude: { on: false, methods: ['best'] } }, now, null, recs);
  assert.deepEqual([off.picked, off.excluded], [['best', 'good'], undefined]);
});

test('[critical] excluded: nothing else passes -- the list is kept, less the excluded, never emptied', async () => {
  const now = IST('2026-10-16T21:00:00');
  const recs = recordOf([{ method: 'best', trades: 10, wins: 10, net: 2 }]);
  const a = { ...DEFAULT_AUTO_METHODS, on: true, exclude: { on: true, methods: ['best', 'old'] } };
  const run = await autoPick(signal(['old', 'keep']), a, now, null, recs);
  assert.deepEqual([run.picked, run.excluded], [['keep'], ['best']]);
  assert.match(run.note ?? '', /No method but an excluded one won 75% of 3 trades or more: the list was kept, less the 1 excluded method/);
  // every method kept is excluded: kept whole, a strategy is never emptied
  const all = await autoPick(signal(['old']), a, now, null, recs);
  assert.deepEqual(all.picked, ['old']);
  assert.deepEqual(lessExcluded(['old', 'x'], a), ['x']);
  assert.deepEqual(lessExcluded(['old'], { exclude: { on: false, methods: ['old'] } }), ['old']);
});

test('[critical] the run reads Exclude as saved now: a method excluded on the form while the record was worked out is not written', async () => {
  const now = IST('2026-10-16T21:00:10');
  const db = new Map([['s', strategy('s', signal(['breakout']))]]);
  const d: AutoDeps = {
    log: async () => {}, all: async () => [...db.values()], save: async (s) => { db.set(s.id, s); },
    get: async (id) => {
      const s = db.get(id)!;
      return { ...s, config: { ...s.config, signal: { ...s.config.signal!, autoMethods: { ...s.config.signal!.autoMethods!, exclude: { on: true, methods: ['momentum'] } } } } };
    },
    pick: async (_c, _a, at) => ({ at, from: '2026-10-10', to: '2026-10-16', picked: ['momentum', 'bos'], before: ['breakout'] }),
    warn: (m) => assert.fail(m),
  };
  await runAutoMethods(now, d);
  assert.deepEqual(db.get('s')!.config.signal!.methods, ['bos']);
});

test('[critical] Exclude on needs at least one method; off may keep none', () => {
  const with_ = (exclude: unknown) => autoMethodsProblems({ ...DEFAULT_AUTO_METHODS, exclude });
  assert.deepEqual(with_({ on: true, methods: [] }), ['Pick at least one method to exclude, or switch Exclude off.']);
  assert.deepEqual(with_({ on: false, methods: [] }), []);
  assert.deepEqual(with_({ on: true, methods: ['a'] }), []);
  assert.deepEqual(with_(null), []);
  assert.equal(with_({ on: true, methods: ['a', 'a'] }).length, 1);
  assert.equal(with_({ on: 'yes', methods: ['a'] }).length, 1);
  assert.equal(with_(['a']).length, 1);
  // and a save refuses it
  assert.ok(validateConfig(signal(['a'], { exclude: { on: true, methods: [] } })).includes('Pick at least one method to exclude, or switch Exclude off.'));
});

test('a rule\'s time frame in a word: the chain, one, or several joined in the desk\'s order', async () => {
  const { tfLabel } = await import('../../src/strategy/types.js');
  assert.equal(tfLabel({ mode: 'mtf', tf: '5m' }), 'chain');
  assert.equal(tfLabel({ mode: 'single', tf: '15m' }), '15m');
  assert.equal(tfLabel({ mode: 'single', tf: '15m', tfs: ['15m', '1h'] }), '15m+1h');
  assert.equal(tfLabel(null), null);
});

/*
 * Walk-forward with an untouched holdout (18 Oct 2026, the R&D audit): each test day traded with what the rule picked
 * from the days before it alone; the last days reported apart; every method and the list as it stands beside it.
 */
const rec = (method: string, trades: number, wins: number, net: number) => ({ method, trades, wins, net });
const DAYS: DayRecord[] = [
  { day: '2026-10-01', methods: [rec('a', 4, 4, 2), rec('b', 4, 1, -2)] },
  { day: '2026-10-02', methods: [rec('a', 4, 1, -3), rec('b', 4, 4, 5)] },   // test: picked from 10-01 alone -- a
  { day: '2026-10-03', methods: [rec('a', 1, 0, -1), rec('b', 1, 0, -1)] },  // test: picked from 10-02 -- b
  { day: '2026-10-04', methods: [rec('a', 2, 2, 4), rec('b', 2, 0, -4)] },   // test: 10-03 passes nothing -- b kept
  { day: '2026-10-05', methods: [rec('a', 3, 3, 3), rec('b', 3, 0, -3)] },   // holdout: picked from 10-04 -- a
];
const RULE = { winPct: 75, minTrades: 2, days: 1, exclude: null };

test('[critical] walk-forward: each day traded with the pick of the days before it alone -- never its own', () => {
  const w = walkForward(DAYS, RULE, ['a', 'b'], { testFrom: '2026-10-02', holdout: 1 });
  assert.deepEqual(w.days.map((d) => [d.day, d.picked.join(), d.kept, d.rule.net]), [
    ['2026-10-02', 'a', false, -3],      // a won 10-01 and lost on its own day: the day after is what counts
    ['2026-10-03', 'b', false, -1],
    ['2026-10-04', 'b', true, -4],       // nothing passed on 10-03: the list before it kept, as the desk keeps it
    ['2026-10-05', 'a', false, 3],
  ]);
  // what it would have been with its own day known: a +5 on 10-02 -- the look-ahead the walk does not have
  assert.equal(w.days[0]!.all.net, 2);
});

test('[critical] the holdout: the last days apart, with every method and the list as it stands on the same days', () => {
  const w = walkForward(DAYS, RULE, ['a'], { testFrom: '2026-10-02', holdout: 1 });
  assert.equal(w.holdoutFrom, '2026-10-05');
  assert.deepEqual([w.walk.rule.days, w.walk.rule.net, w.walk.rule.upDays, w.walk.rule.downDays, w.walk.rule.worstDay], [3, -8, 0, 3, { day: '2026-10-04', net: -4 }]);
  assert.deepEqual([w.walk.all.net, w.walk.current.net], [2 - 2 + 0, -3 - 1 + 4]);
  assert.deepEqual([w.holdout!.rule.days, w.holdout!.rule.net, w.holdout!.all.net, w.holdout!.current.net], [1, 3, 0, 3]);
  // none held out: one line
  assert.equal(walkForward(DAYS, RULE, ['a'], { testFrom: '2026-10-02', holdout: 0 }).holdout, null);
});

test('[critical] the walk honours Exclude, as the daily update does', () => {
  const w = walkForward(DAYS, { ...RULE, exclude: { on: true, methods: ['a'] } }, ['a', 'b'], { testFrom: '2026-10-02', holdout: 0 });
  assert.ok(w.days.every((d) => !d.picked.includes('a')), 'never picked, and out of the list it starts from');
  assert.equal(w.rule.excluded, 1);
});

test('[critical] 22 Oct 2026: a run due late in the evening that the desk was down for is caught up after midnight -- where the update was running; switched on in the morning, it waits for its time', () => {
  const s = (last: number | null) => strategy('x', signal(['a'], { at: '23:30', last: last === null ? null : { at: last, from: '', to: '', picked: [], before: [] } }));
  // Ran on the 15th at 23:30; the desk was down from 23:00 on the 16th until 00:20 on the 17th.
  assert.equal(autoDue(s(IST('2026-10-15T23:30:20')), IST('2026-10-17T00:20:00')), true, 'the 16th\'s run, caught up');
  assert.equal(autoDue(s(IST('2026-10-17T00:20:30')), IST('2026-10-17T00:21:00')), false, 'and once only');
  assert.equal(autoDue(s(IST('2026-10-17T00:20:30')), IST('2026-10-17T23:30:00')), true, 'the 17th\'s at its own time');
  // Never run: switched on at 10 AM, its first run is tonight's, not last night's.
  assert.equal(autoDue(s(null), IST('2026-10-17T10:00:00')), false);
  // Off for a week, switched on again in the morning: last night's is not caught up either -- it was not running.
  assert.equal(autoDue(s(IST('2026-10-09T23:30:20')), IST('2026-10-17T10:00:00')), false);
});

test('[critical] 22 Oct 2026: every run leaves its row -- switched off, deleted, or not accepted while its record was worked out', async () => {
  const now = IST('2026-10-16T21:00:10');
  const make = () => new Map<string, Strategy>([
    ['gone', strategy('gone', signal(['breakout']))],
    ['off', strategy('off', signal(['breakout']))],
    ['bad', strategy('bad', signal(['bos']))],
  ]);
  const db = make();
  const logged: Parameters<AutoDeps['log']>[0][] = [];
  const d: AutoDeps = {
    log: async (u) => { logged.push(u); },
    all: async () => [...db.values()],
    // Meanwhile: 'gone' deleted, 'off' switched off.
    get: async (id) => {
      if (id === 'gone') return null;
      const s = db.get(id)!;
      if (id === 'bad') return s;
      return { ...s, config: { ...s.config, signal: { ...s.config.signal!, autoMethods: { ...s.config.signal!.autoMethods!, on: false } } } };
    },
    save: async () => assert.fail('nothing is written'),
    // For 'bad', a method no longer in the catalogue: its settings would not be accepted with it.
    pick: async (c, _a, at) => c.signal!.methods.includes('bos')
      ? { at, from: '2026-10-10', to: '2026-10-16', picked: ['no-such-method'], before: ['bos'], records: [] }
      : { at, from: '2026-10-10', to: '2026-10-16', picked: ['momentum'], before: ['breakout'], records: [{ method: 'momentum', trades: 5, wins: 5, net: 0.4 }] },
    warn: () => {},
  };
  assert.deepEqual(await runAutoMethods(now, d), []);
  assert.deepEqual(logged.slice(0, 2).map((u) => [u.strategyId, u.before, u.after, u.note]), [
    ['gone', ['breakout'], ['breakout'], 'The strategy was deleted while its record was worked out: nothing was written.'],
    ['off', ['breakout'], ['breakout'], 'The daily update was switched off while its record was worked out: the list was left as it was.'],
  ]);
  const bad = logged.find((u) => u.strategyId === 'bad');
  assert.ok(bad, logged.map((u) => u.strategyId).join(','));
  assert.deepEqual([bad!.before, bad!.after], [['bos'], ['bos']]);
  assert.match(bad!.note!, /^Not saved -- the strategy's settings would not be accepted with it: .*No such method.* The list was left as it was\.$/);
  assert.deepEqual(logged[0]!.records, [{ method: 'momentum', trades: 5, wins: 5, net: 0.4 }], 'and the record it was worked on');
});
