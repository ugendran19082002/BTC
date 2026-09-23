import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { RETIRED_KEYS, StrategyStore } from '../../src/strategy/store.js';
import { closePool, query, rows } from '../../src/db/pool.js';
import { DEFAULT_CONFIG, validateConfig } from '../../src/strategy/types.js';

/**
 * The store, and the one property that keeps it safe: a day can be claimed
 * exactly once. Everything else here is ordinary CRUD; `claim` is the part
 * that decides whether a restart can enter a second position.
 */
// One database for the file. A fresh store is the tables emptied and the
// three seeded strategies put back as a new desk has them.
await StrategyStore.open();
// The seeded rows, as a new desk has them; every case starts from exactly these.
const seeded = await rows('SELECT * FROM strategies');
const fresh = async () => {
  await query('TRUNCATE strategies, strategy_runs');
  for (const r of seeded) {
    await query(
      'INSERT INTO strategies (id, name, enabled, config, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [r.id, r.name, r.enabled, JSON.stringify(r.config), r.created_at, r.updated_at],
    );
  }
  return StrategyStore.open();
};
/** A second process on the same database. */
const reopen = () => StrategyStore.open();
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

test('[critical] the retired settings are gone from every seeded strategy', async () => {
  // strategy-002 still writes them (it has shipped and is never edited);
  // strategy-004 strips them, so a fresh desk and the live one end the same.
  const s = await fresh();
  const raw = await rows<{ id: string; config: Record<string, unknown> }>('SELECT id, config FROM strategies');
  for (const r of raw) {
    for (const k of RETIRED_KEYS) assert.equal(k in r.config, false, `${r.id} still carries ${k}`);
  }
  for (const x of await s.all()) {
    for (const k of RETIRED_KEYS) assert.equal(k in x.config, false, `${x.id} reads back ${k}`);
  }
});

test('a config still carrying a retired key reads back without it', async () => {
  const s = await fresh();
  await query('UPDATE strategies SET config = config || $1::jsonb WHERE id = $2', [JSON.stringify({ probGate: 0.95, rebalance: { enabled: true } }), 'double']);
  const got = (await s.get('double'))!.config as Record<string, unknown>;
  assert.equal('probGate' in got, false);
  assert.equal('rebalance' in got, false);
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

test('no days at all is refused, because it can never run', () => {
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, weekdays: [] })
    .some((m) => /at least one day/.test(m)));
});

