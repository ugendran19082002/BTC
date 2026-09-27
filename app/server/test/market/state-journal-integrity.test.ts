import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { noteState, stateHistorySchema, recentStates, hitRate } from '../../src/market/state-history.js';
import { query, rows, one } from '../../src/db/pool.js';
import type { StateRead } from '../../src/market/state-read.js';

/**
 * What the signal journal must guarantee, asserted against a real PostgreSQL.
 *
 * The journal is the only answer to "is this signal any good?", and every number
 * on the card is a count over these rows. So the things that can quietly corrupt
 * that count get tests, not comments:
 *
 *  - a duplicate call must be impossible, not merely unlikely
 *  - entry / target / stop must be stored as they were at the call
 *  - `confirmed` and the graded `outcome` must not contradict each other
 */

/** A minimal StateRead — only the fields `noteState` actually persists. */
function read(over: {
  tf?: string; at?: number; event?: string; stage?: string;
  side?: 'UP' | 'DOWN' | null; confirmed?: boolean;
  trigger?: number; target1?: number; target2?: number; invalidation?: number;
} = {}): StateRead {
  const plan = over.trigger === undefined ? null : {
    side: over.side ?? 'UP',
    trigger: over.trigger,
    target1: over.target1 ?? over.trigger + 100,
    target2: over.target2 ?? over.trigger + 200,
    invalidation: over.invalidation ?? over.trigger - 100,
  };
  return {
    tf: (over.tf ?? '5m') as StateRead['tf'],
    at: over.at ?? 1_790_000_000_000,
    bars: [{ time: 1_790_000_000, open: 84_000, high: 84_100, low: 83_900, close: 84_050, volume: 1 }],
    state: {
      event: over.event ?? 'RANGE',
      stage: over.stage ?? 'RANGE',
      side: over.side ?? null,
      confirmed: over.confirmed ?? false,
      confidence: 50,
      level: { resistance: 84_200, support: 83_800 },
      plan,
      words: 'words',
      insight: 'insight',
      volumeRatio: 1,
      parts: {},
      checks: [],
    },
    inputs: { atr: 100 },
    patterns: { shown: [] },
    indicators: { shown: [] },
    context: null,
  } as unknown as StateRead;
}

before(async () => {
  await stateHistorySchema();
  await query('DELETE FROM market_states');
});

describe('a duplicate call cannot be recorded', () => {
  test('[critical] the same (event, stage) twice in a row inserts once — enforced by the database', async () => {
    await query('DELETE FROM market_states');
    const first = await noteState(read({ tf: '5m', at: 1_790_000_000_000, event: 'RANGE', stage: 'RANGE' }));
    assert.ok(first, 'the first call was not recorded');

    /*
     * Straight to SQL, bypassing `noteState`'s own read-then-skip. This is what
     * a second process does when both read "no change" at the same instant: the
     * trigger is the only thing standing between that race and a double-counted
     * row.
     */
    const dup = await one<{ id: number }>(
      `INSERT INTO market_states (at, tf, event, stage, confirmed, confidence, close)
       VALUES ($1,'5m','RANGE','RANGE',false,50,84050) RETURNING id`,
      [1_790_000_001_000],
    );
    // `one()` yields null for no rows, which is what a trigger's RETURN NULL gives.
    assert.equal(dup, null, 'the database accepted a duplicate consecutive state');

    const all = await rows<{ n: string }>('SELECT count(*)::text AS n FROM market_states');
    assert.equal(all[0]!.n, '1', 'more than one row survived');
  });

  test('[critical] a genuine change is still recorded', async () => {
    await query('DELETE FROM market_states');
    await noteState(read({ event: 'RANGE', stage: 'RANGE', at: 1_790_000_000_000 }));
    const changed = await noteState(read({ event: 'BREAKOUT_CONFIRMED', stage: 'CONFIRMED', at: 1_790_000_060_000 }));
    assert.ok(changed, 'a real state change was skipped');
  });

  test('the same state on a different timeframe is not a duplicate', async () => {
    await query('DELETE FROM market_states');
    await noteState(read({ tf: '5m', event: 'RANGE', stage: 'RANGE' }));
    const other = await noteState(read({ tf: '1h', event: 'RANGE', stage: 'RANGE' }));
    assert.ok(other, '1h was treated as a duplicate of 5m');
  });

  test('[critical] a state that changes and comes back is recorded again', async () => {
    // RANGE → BREAKOUT → RANGE is three calls, not one. The rule is about the
    // *previous* row, never about the whole history.
    await query('DELETE FROM market_states');
    await noteState(read({ event: 'RANGE', stage: 'RANGE', at: 1_790_000_000_000 }));
    await noteState(read({ event: 'BREAKOUT_CONFIRMED', stage: 'CONFIRMED', at: 1_790_000_060_000 }));
    const back = await noteState(read({ event: 'RANGE', stage: 'RANGE', at: 1_790_000_120_000 }));
    assert.ok(back, 'the return to RANGE was lost');
    const all = await recentStates(null, 10);
    assert.equal(all.length, 3);
  });
});

describe('the plan is stored as it was at the call', () => {
  test('[critical] entry, target and stop survive the round trip exactly', async () => {
    await query('DELETE FROM market_states');
    await noteState(read({
      event: 'BREAKDOWN_CONFIRMED', stage: 'CONFIRMED', side: 'DOWN', confirmed: true,
      trigger: 83_750, target1: 83_540, target2: 83_330, invalidation: 83_960,
    }));
    const [r] = await recentStates(null, 1);
    assert.ok(r?.plan, 'the plan was not stored');
    assert.equal(r.plan!.trigger, 83_750);
    assert.equal(r.plan!.target1, 83_540);
    assert.equal(r.plan!.invalidation, 83_960);
  });

  test('a state with no plan stores no plan rather than zeros', async () => {
    await query('DELETE FROM market_states');
    await noteState(read({ event: 'RANGE', stage: 'RANGE' }));
    const [r] = await recentStates(null, 1);
    assert.equal(r?.plan, null);
  });
});

describe('confirmed and the graded outcome cannot contradict each other', () => {
  test('[critical] a confirmed call records when it was confirmed', async () => {
    await query('DELETE FROM market_states');
    await noteState(read({
      event: 'BREAKOUT_CONFIRMED', stage: 'CONFIRMED', side: 'UP', confirmed: true, trigger: 84_200,
    }));
    const [r] = await rows<{ confirmed: boolean; confirmed_at: number | null }>(
      'SELECT confirmed, confirmed_at FROM market_states ORDER BY at DESC LIMIT 1',
    );
    assert.equal(r!.confirmed, true);
    assert.ok(r!.confirmed_at !== null, 'confirmed with no confirmed_at — the timestamp is how "late" is measured');
  });

  test('[critical] an unconfirmed call has no confirmation time', async () => {
    await query('DELETE FROM market_states');
    await noteState(read({ event: 'BREAKOUT_WATCH', stage: 'WATCH', side: 'UP', confirmed: false, trigger: 84_200 }));
    const [r] = await rows<{ confirmed: boolean; confirmed_at: number | null }>(
      'SELECT confirmed, confirmed_at FROM market_states ORDER BY at DESC LIMIT 1',
    );
    assert.equal(r!.confirmed, false);
    assert.equal(r!.confirmed_at, null, 'an unconfirmed call claimed a confirmation time');
  });

  test('[critical] the hit rate counts only graded calls, so an ungraded row cannot inflate it', async () => {
    await query('DELETE FROM market_states');
    await noteState(read({ event: 'BREAKOUT_CONFIRMED', stage: 'CONFIRMED', side: 'UP', confirmed: true, trigger: 84_200 }));
    const rate = await hitRate(null);
    assert.equal(rate.graded, 0, 'an ungraded call was counted');
    assert.equal(rate.correct, 0);
  });
});
