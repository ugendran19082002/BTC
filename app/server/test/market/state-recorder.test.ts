import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_MS } from '../../src/market/state-recorder.js';
import { STATE_TFS, STATE_TF_MINUTES } from '../../src/market/state-read.js';

/**
 * The recorder that stopped the journal depending on a viewer.
 *
 * The bug was not in any function -- `noteState` was correct -- it was in *who
 * called it*: only `GET /api/market-state`, so the journal covered the hours
 * somebody had the page open, on the timeframe they had selected. These are the
 * properties that keep it from drifting back.
 */

describe('the recorder\'s cadence', () => {
  test('[critical] every timeframe the desk reads has a cadence — none can be silently skipped', () => {
    for (const tf of STATE_TFS) {
      assert.ok(CHECK_MS[tf] !== undefined, `${tf} has no check interval, so it would never be recorded`);
      assert.ok(CHECK_MS[tf] > 0);
    }
  });

  test('[critical] no timeframe is checked less often than once a bar', () => {
    // A state that changed and reverted inside one unchecked bar is a call the
    // journal never saw. Checking at least once a bar bounds that.
    for (const tf of STATE_TFS) {
      const barMs = STATE_TF_MINUTES[tf] * 60_000;
      assert.ok(
        CHECK_MS[tf] <= barMs,
        `${tf}: checked every ${CHECK_MS[tf] / 1000}s but its bar is ${barMs / 1000}s — a whole bar could pass unread`,
      );
    }
  });

  test('a slower timeframe is not checked more often than a faster one', () => {
    const sorted = [...STATE_TFS].sort((a, b) => STATE_TF_MINUTES[a] - STATE_TF_MINUTES[b]);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(
        CHECK_MS[sorted[i]!] >= CHECK_MS[sorted[i - 1]!],
        `${sorted[i]} is checked more often than the faster ${sorted[i - 1]}`,
      );
    }
  });

  test('nothing is checked more than once a minute — six candle fetches a minute is the ceiling', () => {
    for (const tf of STATE_TFS) {
      assert.ok(CHECK_MS[tf] >= 60_000, `${tf} would fetch candles more than once a minute`);
    }
  });
});
