import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyStore } from '../../src/strategy/store.js';
import { MemorySettings } from '../../src/db/settings.js';
import { closePool, query } from '../../src/db/pool.js';
import { entryDue, exitDue, istDate } from '../../src/strategy/schedule.js';
import { DEFAULT_CONFIG, type Strategy } from '../../src/strategy/types.js';

/**
 * The failure this whole subsystem exists to prevent: entering twice.
 *
 * A scheduler is a loop, and a loop that places orders is one bug away from
 * placing all of them. These are the ways it actually happens -- a poll running
 * faster than a fill, a restart mid-run, a redeploy at the wrong minute, two
 * workers -- written as tests rather than as hopes.
 *
 * Every case drives the real store against a real database file, because the
 * property being tested is the UNIQUE constraint and an in-memory fake would
 * only prove the fake agrees with the code. ARCHITECTURE.md rule 2.
 */
// One database for the file; a fresh store starts with an empty run journal.
await StrategyStore.open(new MemorySettings());
const fresh = async () => {
  await query('TRUNCATE strategy_runs, strategy_adds, strategy_rebalances');
  return StrategyStore.open(new MemorySettings());
};
after(() => closePool());

const strat = (over: Partial<Strategy> = {}): Strategy => ({
  id: 'double', name: 'Double', enabled: true,
  config: { ...DEFAULT_CONFIG }, createdAt: 0, updatedAt: 0, ...over,
});

const ist = (iso: string) => Date.parse(`${iso}+05:30`);
const THU_0530 = ist('2026-09-10T05:30:00');

/**
 * One turn of the scheduler loop, written the way it must be written: claim
 * the day BEFORE acting, and act only if the claim was won.
 */
async function tick(s: StrategyStore, strategy: Strategy, now: number, placed: string[]): Promise<void> {
  const due = entryDue(strategy, now, await s.lastRunDate(strategy.id));
  if (!due.due) return;
  const day = istDate(now);
  if (!(await s.claim(strategy.id, day, now))) return;      // somebody else has it
  placed.push(day);                                          // <- the orders would go here
  await s.finish(strategy.id, day, 'placed', 'ok');
}

test('[critical] a loop polling every second enters once', async () => {
  const s = await fresh();
  const placed: string[] = [];
  // 600 ticks across the ten minutes after the entry time.
  for (let i = 0; i < 600; i++) await tick(s, strat(), THU_0530 + i * 1_000, placed);
  assert.deepEqual(placed, ['2026-09-10']);
});

test('[critical] a tick storm in the same millisecond still enters once', async () => {
  const s = await fresh();
  const placed: string[] = [];
  // All two hundred in flight at once: only the claim decides.
  await Promise.all(Array.from({ length: 200 }, () => tick(s, strat(), THU_0530, placed)));
  assert.equal(placed.length, 1);
});

test('[critical] a restart mid-day does not re-enter', async () => {
  await fresh();
  const placed: string[] = [];

  await tick(await StrategyStore.open(new MemorySettings()), strat(), THU_0530, placed);
  // process dies, comes back four minutes later, still inside the grace window
  await tick(await StrategyStore.open(new MemorySettings()), strat(), THU_0530 + 4 * 60_000, placed);
  // and again, and again
  await tick(await StrategyStore.open(new MemorySettings()), strat(), THU_0530 + 10 * 60_000, placed);
  assert.equal(placed.length, 1, 'a redeploy at 05:34 is the normal case, not the exotic one');
});

test('[critical] two workers racing the same day produce one entry', async () => {
  // Both read "not run yet" before either writes. Only the claim decides.
  await fresh();
  const a = await StrategyStore.open(new MemorySettings());
  const b = await StrategyStore.open(new MemorySettings());
  const day = '2026-09-10';

  assert.equal(await a.lastRunDate('double'), null);
  assert.equal(await b.lastRunDate('double'), null);      // both saw an empty journal

  const [wonA, wonB] = await Promise.all([a.claim('double', day), b.claim('double', day)]);
  assert.equal([wonA, wonB].filter(Boolean).length, 1, 'exactly one may win');
});

test('the day rolls over and the next day enters once', async () => {
  const s = await fresh();
  const placed: string[] = [];
  for (let d = 0; d < 5; d++) {
    for (let i = 0; i < 50; i++) await tick(s, strat(), THU_0530 + d * 86_400_000 + i * 1_000, placed);
  }
  assert.deepEqual(placed, [
    '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14',
  ]);
});

test('a strategy disarmed mid-window stops entering, and does not catch up later', async () => {
  const s = await fresh();
  const placed: string[] = [];
  await tick(s, strat({ enabled: false }), THU_0530, placed);
  await tick(s, strat({ enabled: false }), THU_0530 + 60_000, placed);
  assert.equal(placed.length, 0);
  // re-armed the next day: it trades that day, not the one it missed
  await tick(s, strat(), THU_0530 + 86_400_000, placed);
  assert.deepEqual(placed, ['2026-09-11']);
});

test('a claim that is never finished still blocks the day', async () => {
  // The process died between claiming and hearing back. Marked-and-not-traded
  // loses a day; traded-and-not-marked doubles a position. This is the safe
  // direction and the test pins it deliberately.
  const s = await fresh();
  await s.claim('double', '2026-09-10');
  const placed: string[] = [];
  await tick(s, strat(), THU_0530, placed);
  assert.equal(placed.length, 0);
  assert.equal((await s.runs())[0]!.status, 'skipped');
  assert.match((await s.runs())[0]!.detail, /not yet run/);
});

test('two strategies on the same day do not block each other', async () => {
  const s = await fresh();
  const placed: string[] = [];
  for (let i = 0; i < 20; i++) {
    await tick(s, strat({ id: 'double' }), THU_0530, placed);
    await tick(s, strat({ id: 'locked' }), THU_0530, placed);
  }
  assert.equal(placed.length, 2);
  assert.equal((await s.runs()).length, 2);
});

/* ------------------------------------------------------- exits and loops -- */

test('the exit may be asked repeatedly without a guard', () => {
  // Unlike entry, this is meant to be idempotent at the caller: closing a flat
  // position is a no-op, and refusing to ask twice is how a position is left on.
  const s = strat();
  const at = ist('2026-09-10T17:35:00');
  for (let i = 0; i < 50; i++) assert.equal(exitDue(s, at + i * 1_000, true).due, true);
  assert.equal(exitDue(s, at, false).due, false);
});

test('a tick before the entry time never claims the day', async () => {
  const s = await fresh();
  const placed: string[] = [];
  for (let i = 0; i < 300; i++) await tick(s, strat(), THU_0530 - (i + 1) * 1_000, placed);
  assert.equal(placed.length, 0);
  assert.equal(await s.lastRunDate('double'), null, 'an early tick must not spend the day');
});

test('a tick long after the window never claims the day either', async () => {
  const s = await fresh();
  const placed: string[] = [];
  for (let i = 0; i < 300; i++) await tick(s, strat(), THU_0530 + 3 * 3_600_000 + i * 1_000, placed);
  assert.equal(placed.length, 0);
  assert.equal(await s.lastRunDate('double'), null,
    'a late tick must leave the day unspent, so tomorrow is unaffected');
});

test('the journal never grows a second row for one strategy-day', async () => {
  const s = await fresh();
  for (let i = 0; i < 100; i++) {
    await s.claim('double', '2026-09-10');
    await s.finish('double', '2026-09-10', 'placed', `attempt ${i}`);
  }
  assert.equal((await s.runs()).filter((r) => r.runDate === '2026-09-10').length, 1);
});
