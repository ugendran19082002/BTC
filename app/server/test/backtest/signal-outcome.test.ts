import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSignalOutcome, outcomeFor } from '../../src/backtest/signal-outcome.js';
import type { Candle } from '../../src/market/delta.js';
import type { Plan } from '../../src/domain/market-state.js';

const bar = (high: number, low: number): Candle =>
  ({ time: 0, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 1 });

const long: Plan = { side: 'UP', trigger: 86_800, target1: 87_200, target2: 87_600, invalidation: 86_400 };
const short: Plan = { side: 'DOWN', trigger: 86_200, target1: 85_800, target2: 85_400, invalidation: 86_600 };

test('[critical] a setup whose trigger was never reached did not happen', () => {
  /*
   * The bug that made the history useless (24 Sep 2026). A breakout watch says
   * "over 86,800 this goes to 87,200". If price never reached 86,800 there was
   * no trade to be right or wrong about -- and the old grader called it WRONG,
   * so the screen filled with red for calls that were never anything but a
   * plan. Nothing happened. That is what it says now.
   */
  const never = [bar(86_700, 86_500), bar(86_650, 86_400)];
  assert.equal(outcomeFor({ plan: long, side: 'UP', stage: 'WATCH', after: never }), 'NOT_TRIGGERED');
  // and the same for a breakdown that never broke down
  assert.equal(
    outcomeFor({ plan: short, side: 'DOWN', stage: 'WATCH', after: [bar(86_500, 86_300)] }),
    'NOT_TRIGGERED',
  );
});

test('[critical] once it triggers, the target before the invalidation is the target hit', () => {
  const triggered = [bar(86_900, 86_700), bar(87_250, 86_850)];
  assert.equal(outcomeFor({ plan: long, side: 'UP', stage: 'WATCH', after: triggered }), 'TARGET_HIT');
  assert.equal(
    outcomeFor({ plan: short, side: 'DOWN', stage: 'WATCH', after: [bar(86_150, 85_750)] }),
    'TARGET_HIT',
  );
});

test('[critical] triggered and then through the invalidation is invalidated', () => {
  assert.equal(
    outcomeFor({ plan: long, side: 'UP', stage: 'WATCH', after: [bar(86_900, 86_700), bar(86_800, 86_350)] }),
    'INVALIDATED',
  );
  // A bar that reached both counts against: the order is not in the bar.
  assert.equal(
    outcomeFor({ plan: long, side: 'UP', stage: 'CONFIRMED', after: [bar(87_300, 86_300)] }),
    'INVALIDATED',
  );
});

test('[critical] a confirmed state is already through its trigger', () => {
  // Price was past the level when the desk called it, so the trigger is not
  // asked for again -- only what happened next.
  assert.equal(
    outcomeFor({ plan: long, side: 'UP', stage: 'CONFIRMED', after: [bar(87_250, 86_900)] }),
    'TARGET_HIT',
  );
});

test('triggered, and then neither, is expired -- not a miss', () => {
  // Price drifted. Counting that either way would be choosing an answer
  // rather than measuring one.
  assert.equal(
    outcomeFor({ plan: long, side: 'UP', stage: 'WATCH', after: [bar(86_900, 86_700), bar(87_100, 86_900)] }),
    'EXPIRED',
  );
  assert.equal(outcomeFor({ plan: long, side: 'UP', stage: 'WATCH', after: [] }), 'EXPIRED');
});

test('a call with no plan behind it is not graded at all', () => {
  assert.equal(outcomeFor({ plan: null, side: null, stage: 'RANGE', after: [bar(87_300, 86_300)] }), 'NOT_GRADED');
  assert.equal(outcomeFor({ plan: long, side: null, stage: 'RANGE', after: [bar(87_300, 86_300)] }), 'NOT_GRADED');
});

test('[critical] signal evaluation records first hit, timestamps, and excursions (MFE/MAE)', () => {
  const bars: Candle[] = [
    { time: 100, open: 86600, high: 86750, low: 86550, close: 86700, volume: 10 },
    { time: 105, open: 86700, high: 86950, low: 86700, close: 86900, volume: 15 },
    { time: 110, open: 86900, high: 87250, low: 86900, close: 87000, volume: 20 },
    { time: 115, open: 87000, high: 87050, low: 86800, close: 86850, volume: 10 },
  ];
  const audit = evaluateSignalOutcome({
    plan: long,
    side: 'UP',
    stage: 'WATCH',
    callAt: 95_000,
    closeAtCall: 86_600,
    windowMs: 30 * 60_000,
    after: bars,
  });

  assert.equal(audit.outcome, 'TARGET_HIT');
  assert.equal(audit.firstHit, 'TARGET');
  assert.equal(audit.firstHitPrice, 87_200);
  assert.equal(audit.firstHitTime, 110_000);
  assert.equal(audit.triggeredAt, 105_000);
  assert.equal(audit.mfePrice, 87_250);
  assert.equal(audit.mfe, 450); // 87,250 - 86,800
});
