import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyStore } from '../../src/strategy/store.js';
import { MemorySettings } from '../../src/db/settings.js';
import { closePool, query } from '../../src/db/pool.js';
import { DEFAULT_CONFIG, validateConfig } from '../../src/strategy/types.js';

/**
 * The store, and the one property that keeps it safe: a day can be claimed
 * exactly once. Everything else here is ordinary CRUD; `claim` is the part
 * that decides whether a restart can enter a second position.
 */
// One database for the file. A fresh store is the schema emptied and the seed
// migration forgotten, so `open()` seeds the three strategies again as it
// would on a new desk.
await StrategyStore.open(new MemorySettings());
const fresh = async () => {
  await query('TRUNCATE strategy.strategies, strategy.runs, strategy.adds, strategy.rebalances');
  await query("DELETE FROM public.schema_migrations WHERE id = 'strategy-002-seed'");
  return StrategyStore.open(new MemorySettings());
};
/** A second process on the same database. */
const reopen = () => StrategyStore.open(new MemorySettings());
after(() => closePool());

test('the migration seeds the three researched strategies', async () => {
  const s = await fresh();
  const all = (await s.all());
  assert.deepEqual(all.map((x) => x.id).sort(), ['baseline', 'double', 'locked']);
});

test('only the one the record favours is armed', async () => {
  const s = await fresh();
  const on = (await s.all()).filter((x) => x.enabled).map((x) => x.id);
  assert.deepEqual(on, ['double'], 'a fresh desk must not arm three strategies at once');
});

test('the seeded strategies differ in the two settings the research turned on', async () => {
  const s = await fresh();
  const by = Object.fromEntries((await s.all()).map((x) => [x.id, x.config]));
  assert.equal(by.baseline!.probGate, null);
  assert.equal(by.locked!.probGate, 0.95);
  assert.equal(by.locked!.doubleWhenOneSided, false);
  assert.equal(by.double!.probGate, 0.95);
  assert.equal(by.double!.doubleWhenOneSided, true);
});

test('a saved strategy reads back with every field', async () => {
  const s = await fresh();
  await s.save({
    id: 'mine', name: 'My rule', enabled: true,
    config: { ...DEFAULT_CONFIG, lots: 42, legs: 'CE', premium: { mode: 'atMost', usd: 11 } },
  });
  const got = (await s.get('mine'))!;
  assert.equal(got.name, 'My rule');
  assert.equal(got.enabled, true);
  assert.equal(got.config.lots, 42);
  assert.equal(got.config.legs, 'CE');
  assert.deepEqual(got.config.premium, { mode: 'atMost', usd: 11 });
});

test('saving again changes it rather than adding a second', async () => {
  const s = await fresh();
  await s.save({ id: 'mine', name: 'A', enabled: false, config: DEFAULT_CONFIG });
  await s.save({ id: 'mine', name: 'B', enabled: true, config: { ...DEFAULT_CONFIG, lots: 3 } });
  assert.equal((await s.all()).filter((x) => x.id === 'mine').length, 1);
  assert.equal((await s.get('mine'))!.name, 'B');
  assert.equal((await s.get('mine'))!.config.lots, 3);
});

test('a config written before a field existed gets the default, not undefined', async () => {
  const s = await fresh();
  await s.save({ id: 'old', name: 'old', enabled: false, config: DEFAULT_CONFIG });
  // simulate an older row that predates probGate
  const raw = { ...DEFAULT_CONFIG } as Record<string, unknown>;
  delete raw.probGate;
  await s.save({ id: 'old', name: 'old', enabled: false, config: raw as never });
  assert.equal((await s.get('old'))!.config.probGate, DEFAULT_CONFIG.probGate);
});

test('turning one on does not disturb the others', async () => {
  const s = await fresh();
  await s.setEnabled('baseline', true);
  assert.equal((await s.get('baseline'))!.enabled, true);
  assert.equal((await s.get('locked'))!.enabled, false);
  assert.equal((await s.get('double'))!.enabled, true);
});

test('enabling something that does not exist says so rather than creating it', async () => {
  const s = await fresh();
  assert.equal(await s.setEnabled('ghost', true), null);
  assert.equal(await s.get('ghost'), null);
});

/* --------------------------------------------------------------- claims --- */

test('[critical] a day can only be claimed once', async () => {
  const s = await fresh();
  assert.equal(await s.claim('double', '2026-09-10'), true);
  assert.equal(await s.claim('double', '2026-09-10'), false, 'the second claim is what a restart looks like');
});

test('[critical] the claim survives a reopen, because a restart must not re-enter', async () => {
  await fresh();
  assert.equal(await (await reopen()).claim('double', '2026-09-10'), true);
  assert.equal(await (await reopen()).claim('double', '2026-09-10'), false);
});

test('different days and different strategies claim independently', async () => {
  const s = await fresh();
  assert.equal(await s.claim('double', '2026-09-10'), true);
  assert.equal(await s.claim('double', '2026-09-11'), true);
  assert.equal(await s.claim('locked', '2026-09-10'), true);
});

test('lastRunDate is what the scheduler reads to refuse a second entry', async () => {
  const s = await fresh();
  assert.equal(await s.lastRunDate('double'), null);
  await s.claim('double', '2026-09-10');
  assert.equal(await s.lastRunDate('double'), '2026-09-10');
  await s.claim('double', '2026-09-11');
  assert.equal(await s.lastRunDate('double'), '2026-09-11');
});

test('a claim is recorded before the outcome is known, then updated', async () => {
  const s = await fresh();
  await s.claim('double', '2026-09-10');
  assert.equal((await s.runs())[0]!.status, 'skipped');
  await s.finish('double', '2026-09-10', 'placed', 'CE 80800 x20');
  const r = (await s.runs())[0]!;
  assert.equal(r.status, 'placed');
  assert.equal(r.detail, 'CE 80800 x20');
  assert.equal(r.runDate, '2026-09-10');
});

test('finishing a day never creates a second row for it', async () => {
  const s = await fresh();
  await s.claim('double', '2026-09-10');
  await s.finish('double', '2026-09-10', 'failed', 'exchange said no');
  assert.equal((await s.runs()).filter((r) => r.runDate === '2026-09-10').length, 1);
});

test('deleting a strategy keeps its history', async () => {
  const s = await fresh();
  await s.claim('double', '2026-09-10');
  await s.finish('double', '2026-09-10', 'placed', 'done');
  await s.remove('double');
  assert.equal(await s.get('double'), null);
  assert.equal((await s.runs()).some((r) => r.strategyId === 'double'), true,
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

test('an exit the contract does not live to see is refused', () => {
  // 5:00 PM to 5:30 AM: the contract entered at 5:00 PM expires half an hour
  // later, so there is nothing left to close the next morning. An overnight
  // window is allowed (see times.test.ts) -- one that outlives its contract is not.
  const bad = validateConfig({ ...DEFAULT_CONFIG, entryTime: '17:00', exitTime: '05:30' });
  assert.ok(bad.some((m) => /5:30 PM settlement/.test(m)), bad.join(' | '));
});

test('[critical] both score bars are whole numbers out of a hundred, or off', () => {
  const ok = (over: Record<string, unknown>) => validateConfig({ ...DEFAULT_CONFIG, ...over });
  assert.deepEqual(ok({ minSellScore: null, maxShockScore: null }), []);
  assert.deepEqual(ok({ minSellScore: 65, maxShockScore: 25 }), []);
  assert.deepEqual(ok({ minSellScore: 1, maxShockScore: 100 }), [], 'both ends are usable');

  assert.ok(ok({ minSellScore: 0 }).some((m) => /sell-score bar/.test(m)));
  assert.ok(ok({ minSellScore: 101 }).some((m) => /sell-score bar/.test(m)));
  assert.ok(ok({ minSellScore: 65.5 }).some((m) => /sell-score bar/.test(m)),
    'the score is a whole number, so a bar of 65.5 is a bar nobody can read back');
  assert.ok(ok({ maxShockScore: 0 }).some((m) => /sudden-move risk limit/.test(m)));
  assert.ok(ok({ maxShockScore: 101 }).some((m) => /sudden-move risk limit/.test(m)));
});

test('[critical] a strategy saved before the score bars reads as off, not as zero', async () => {
  // A zero bar would refuse every strike; a zero risk limit would hold every
  // day. The hydrate merge decides this, and it decides it for every strategy
  // already in the database.
  const s = await fresh();
  const before = (await s.all()).find((x) => x.id === 'double')!;
  assert.equal(before.config.minSellScore, null);
  assert.equal(before.config.maxShockScore, null);
});

test('the score bars survive a save and come back as they went in', async () => {
  const s = await fresh();
  await s.save({
    id: 'gated', name: 'Gated', enabled: false,
    config: { ...DEFAULT_CONFIG, minSellScore: 70, maxShockScore: 25 },
  });
  const back = (await s.get('gated'))!;
  assert.equal(back.config.minSellScore, 70);
  assert.equal(back.config.maxShockScore, 25);
});

test('[critical] doubling without the gate is fine: it covers every refusal now', () => {
  const ok = validateConfig({ ...DEFAULT_CONFIG, probGate: null, doubleWhenOneSided: true });
  assert.deepEqual(ok, [], `no objection expected: ${ok.join(' ')}`);
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

test('[critical] the same bought-back contracts get one decision, however many times they are written', async () => {
  const s = await fresh();
  const first = await addRow(s, 425);
  assert.equal(first?.contracts, 425);
  assert.equal(await addRow(s, 425), null, 'a second write for the same 425 is refused by the journal itself');
  assert.equal(await s.addedFor('CE-1'), 425);
});

test('[critical] a later piece gets a row for only what is new', async () => {
  const s = await fresh();
  await addRow(s, 200);
  assert.equal((await addRow(s, 203))?.contracts, 3);
  assert.equal(await s.addedFor('CE-1'), 203);
});

test('[critical] the journal outlives a restart: a new store on the same database still knows', async () => {
  await fresh();
  await addRow(await reopen(), 425);
  assert.equal(await (await reopen()).addedFor('CE-1'), 425);
  assert.equal(await addRow(await reopen(), 425), null);
});

test('[critical] two callers deciding about the same piece at once get one row between them', async () => {
  const s = await fresh();
  const both = await Promise.all([await addRow(s, 425), await addRow(s, 425)]);
  assert.equal(both.filter((r) => r !== null).length, 1, 'the lock inside recordAdd serialises them');
  assert.equal(await s.addedFor('CE-1'), 425);
});

test('an add is finished with its outcome and the trade it went onto', async () => {
  const s = await fresh();
  const row = (await addRow(s, 425))!;
  await s.finishAdd(row.id, 'placed', 'added 425', 'PE-1');
  const [got] = await s.adds();
  assert.equal(got?.status, 'placed');
  assert.equal(got?.addedToTradeId, 'PE-1');
});

test('the add setting saves and reads back, and a strategy saved before it existed reads as off', async () => {
  const s = await fresh();
  await s.save({ id: 'add', name: 'Add', enabled: false, config: { ...DEFAULT_CONFIG, addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil: '12:15' } } });
  assert.deepEqual((await s.get('add'))!.config.addToOpposite, { minPriceUsd: 3, maxMultiple: 2, addUntil: '12:15' });
  await s.save({ id: 'add2', name: 'Add', enabled: false, config: { ...DEFAULT_CONFIG, addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil: '12:15', crossAfterSec: 90 } } });
  assert.equal((await s.get('add2'))!.config.addToOpposite!.crossAfterSec, 90, 'the add\'s own seconds survive a save');
  assert.equal((await s.get('double'))!.config.addToOpposite, null, 'seeded before the setting existed');
});

test('the add setting is checked before it is saved', () => {
  const add = (over: object, cfg: object = {}) =>
    validateConfig({ ...DEFAULT_CONFIG, ...cfg, addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil: '16:59', ...over } });
  assert.deepEqual(add({}), []);
  assert.ok(add({ minPriceUsd: 0 }).some((p) => /minimum price/.test(p)));
  assert.ok(add({ maxMultiple: 0 }).some((p) => /between 0 and 20/.test(p)));
  assert.ok(add({}, { legs: 'CE', doubleWhenOneSided: false }).some((p) => /needs both legs/.test(p)));
  assert.ok(add({}, { takeProfitPct: 0 }).some((p) => /needs a target/.test(p)));
  // "If not filled, sell at bid after N seconds", on the add itself
  assert.deepEqual(add({ crossAfterSec: 0 }), []);
  assert.deepEqual(add({ crossAfterSec: 600 }), []);
  assert.deepEqual(add({ crossAfterSec: null }), [], 'cleared means the entry\'s own seconds');
  assert.ok(add({ crossAfterSec: 601 }).some((p) => /0 to 600/.test(p)));
  assert.ok(add({ crossAfterSec: -1 }).some((p) => /0 to 600/.test(p)));
  assert.ok(add({ crossAfterSec: 1.5 }).some((p) => /whole number/.test(p)));
  assert.deepEqual(validateConfig({ ...DEFAULT_CONFIG, addToOpposite: null }), []);
});
