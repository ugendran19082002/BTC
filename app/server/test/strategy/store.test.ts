import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StrategyStore } from '../../src/strategy/store.js';
import { DEFAULT_CONFIG, validateConfig } from '../../src/strategy/types.js';

/**
 * The store, and the one property that keeps it safe: a day can be claimed
 * exactly once. Everything else here is ordinary CRUD; `claim` is the part
 * that decides whether a restart can enter a second position.
 */
const fresh = () => new StrategyStore(join(mkdtempSync(join(tmpdir(), 'strat-')), 'trades.db'));

test('the migration seeds the three researched strategies', () => {
  const s = fresh();
  const all = s.all();
  assert.deepEqual(all.map((x) => x.id).sort(), ['baseline', 'double', 'locked']);
});

test('only the one the record favours is armed', () => {
  const s = fresh();
  const on = s.all().filter((x) => x.enabled).map((x) => x.id);
  assert.deepEqual(on, ['double'], 'a fresh desk must not arm three strategies at once');
});

test('the seeded strategies differ in the two settings the research turned on', () => {
  const s = fresh();
  const by = Object.fromEntries(s.all().map((x) => [x.id, x.config]));
  assert.equal(by.baseline!.probGate, null);
  assert.equal(by.locked!.probGate, 0.95);
  assert.equal(by.locked!.doubleWhenOneSided, false);
  assert.equal(by.double!.probGate, 0.95);
  assert.equal(by.double!.doubleWhenOneSided, true);
});

test('a saved strategy reads back with every field', () => {
  const s = fresh();
  s.save({
    id: 'mine', name: 'My rule', enabled: true,
    config: { ...DEFAULT_CONFIG, lots: 42, legs: 'CE', premium: { mode: 'atMost', usd: 11 } },
  });
  const got = s.get('mine')!;
  assert.equal(got.name, 'My rule');
  assert.equal(got.enabled, true);
  assert.equal(got.config.lots, 42);
  assert.equal(got.config.legs, 'CE');
  assert.deepEqual(got.config.premium, { mode: 'atMost', usd: 11 });
});

test('saving again changes it rather than adding a second', () => {
  const s = fresh();
  s.save({ id: 'mine', name: 'A', enabled: false, config: DEFAULT_CONFIG });
  s.save({ id: 'mine', name: 'B', enabled: true, config: { ...DEFAULT_CONFIG, lots: 3 } });
  assert.equal(s.all().filter((x) => x.id === 'mine').length, 1);
  assert.equal(s.get('mine')!.name, 'B');
  assert.equal(s.get('mine')!.config.lots, 3);
});

test('a config written before a field existed gets the default, not undefined', () => {
  const s = fresh();
  s.save({ id: 'old', name: 'old', enabled: false, config: DEFAULT_CONFIG });
  // simulate an older row that predates probGate
  const raw = { ...DEFAULT_CONFIG } as Record<string, unknown>;
  delete raw.probGate;
  s.save({ id: 'old', name: 'old', enabled: false, config: raw as never });
  assert.equal(s.get('old')!.config.probGate, DEFAULT_CONFIG.probGate);
});

test('turning one on does not disturb the others', () => {
  const s = fresh();
  s.setEnabled('baseline', true);
  assert.equal(s.get('baseline')!.enabled, true);
  assert.equal(s.get('locked')!.enabled, false);
  assert.equal(s.get('double')!.enabled, true);
});

test('enabling something that does not exist says so rather than creating it', () => {
  const s = fresh();
  assert.equal(s.setEnabled('ghost', true), null);
  assert.equal(s.get('ghost'), null);
});

/* --------------------------------------------------------------- claims --- */

test('[critical] a day can only be claimed once', () => {
  const s = fresh();
  assert.equal(s.claim('double', '2026-09-10'), true);
  assert.equal(s.claim('double', '2026-09-10'), false, 'the second claim is what a restart looks like');
});

test('[critical] the claim survives a reopen, because a restart must not re-enter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strat-'));
  const path = join(dir, 'trades.db');
  assert.equal(new StrategyStore(path).claim('double', '2026-09-10'), true);
  assert.equal(new StrategyStore(path).claim('double', '2026-09-10'), false);
});

test('different days and different strategies claim independently', () => {
  const s = fresh();
  assert.equal(s.claim('double', '2026-09-10'), true);
  assert.equal(s.claim('double', '2026-09-11'), true);
  assert.equal(s.claim('locked', '2026-09-10'), true);
});

test('lastRunDate is what the scheduler reads to refuse a second entry', () => {
  const s = fresh();
  assert.equal(s.lastRunDate('double'), null);
  s.claim('double', '2026-09-10');
  assert.equal(s.lastRunDate('double'), '2026-09-10');
  s.claim('double', '2026-09-11');
  assert.equal(s.lastRunDate('double'), '2026-09-11');
});

test('a claim is recorded before the outcome is known, then updated', () => {
  const s = fresh();
  s.claim('double', '2026-09-10');
  assert.equal(s.runs()[0]!.status, 'skipped');
  s.finish('double', '2026-09-10', 'placed', 'CE 80800 x20');
  const r = s.runs()[0]!;
  assert.equal(r.status, 'placed');
  assert.equal(r.detail, 'CE 80800 x20');
  assert.equal(r.runDate, '2026-09-10');
});

test('finishing a day never creates a second row for it', () => {
  const s = fresh();
  s.claim('double', '2026-09-10');
  s.finish('double', '2026-09-10', 'failed', 'exchange said no');
  assert.equal(s.runs().filter((r) => r.runDate === '2026-09-10').length, 1);
});

test('deleting a strategy keeps its history', () => {
  const s = fresh();
  s.claim('double', '2026-09-10');
  s.finish('double', '2026-09-10', 'placed', 'done');
  s.remove('double');
  assert.equal(s.get('double'), null);
  assert.equal(s.runs().some((r) => r.strategyId === 'double'), true,
    'what happened still happened');
});

/* ------------------------------------------------------------ validation -- */

test('a good config has nothing to say about it', () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
});

test('every objection is returned at once, not one at a time', () => {
  const bad = validateConfig({ ...DEFAULT_CONFIG, entryTime: '25:00', lots: 0, weekdays: [] });
  assert.ok(bad.length >= 3, 'a form that reveals objections one by one is one people abandon');
});

test('an exit before its entry is refused', () => {
  const bad = validateConfig({ ...DEFAULT_CONFIG, entryTime: '17:00', exitTime: '05:30' });
  assert.ok(bad.some((m) => /later in the day/.test(m)));
});

test('doubling without the gate is explained rather than silently ignored', () => {
  const bad = validateConfig({ ...DEFAULT_CONFIG, probGate: null, doubleWhenOneSided: true });
  assert.ok(bad.some((m) => /probability gate/.test(m)));
});

test('doubling on a single-leg strategy is explained', () => {
  const bad = validateConfig({ ...DEFAULT_CONFIG, legs: 'PE', doubleWhenOneSided: true });
  assert.ok(bad.some((m) => /both legs/.test(m)));
});

test('no days at all is refused, because it can never run', () => {
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, weekdays: [] })
    .some((m) => /at least one day/.test(m)));
});

// ------------------------------------------------ adding to the other leg

const addRow = (s: StrategyStore, boughtBack: number, status: 'placing' | 'skipped' = 'placing') => s.recordAdd({
  strategyId: 's', runDate: '2026-09-11', sourceTradeId: 'CE-1', sourceSide: 'CE',
  symbol: 'P-BTC-74000-110926', boughtBack, status, detail: 'CE target bought back', at: 1,
});

test('[critical] the same bought-back contracts get one decision, however many times they are written', () => {
  const s = fresh();
  const first = addRow(s, 425);
  assert.equal(first?.contracts, 425);
  assert.equal(addRow(s, 425), null, 'a second write for the same 425 is refused by the journal itself');
  assert.equal(s.addedFor('CE-1'), 425);
});

test('[critical] a later piece gets a row for only what is new', () => {
  const s = fresh();
  addRow(s, 200);
  assert.equal(addRow(s, 203)?.contracts, 3);
  assert.equal(s.addedFor('CE-1'), 203);
});

test('[critical] the journal outlives a restart: a new store on the same file still knows', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'strat-')), 'trades.db');
  addRow(new StrategyStore(dir), 425);
  assert.equal(new StrategyStore(dir).addedFor('CE-1'), 425);
  assert.equal(addRow(new StrategyStore(dir), 425), null);
});

test('an add is finished with its outcome and the trade it went onto', () => {
  const s = fresh();
  const row = addRow(s, 425)!;
  s.finishAdd(row.id, 'placed', 'added 425', 'PE-1');
  const [got] = s.adds();
  assert.equal(got?.status, 'placed');
  assert.equal(got?.addedToTradeId, 'PE-1');
});

test('the add setting saves and reads back, and a strategy saved before it existed reads as off', () => {
  const s = fresh();
  s.save({ id: 'add', name: 'Add', enabled: false, config: { ...DEFAULT_CONFIG, addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil: '12:15' } } });
  assert.deepEqual(s.get('add')!.config.addToOpposite, { minPriceUsd: 3, maxMultiple: 2, addUntil: '12:15' });
  assert.equal(s.get('double')!.config.addToOpposite, null, 'seeded before the setting existed');
});

test('the add setting is checked before it is saved', () => {
  const add = (over: object, cfg: object = {}) =>
    validateConfig({ ...DEFAULT_CONFIG, ...cfg, addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil: '16:59', ...over } });
  assert.deepEqual(add({}), []);
  assert.ok(add({ minPriceUsd: 0 }).some((p) => /minimum price/.test(p)));
  assert.ok(add({ maxMultiple: 0 }).some((p) => /between 0 and 20/.test(p)));
  assert.ok(add({}, { legs: 'CE', doubleWhenOneSided: false }).some((p) => /needs both legs/.test(p)));
  assert.ok(add({}, { takeProfitPct: 0 }).some((p) => /needs a target/.test(p)));
  assert.deepEqual(validateConfig({ ...DEFAULT_CONFIG, addToOpposite: null }), []);
});
