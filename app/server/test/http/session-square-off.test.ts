import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionSquareOff } from '../../src/http/routes/trade.routes.js';

/** A plain "square off" from before 22 Nov is the session guard's when its account hit its limit just before (22 Nov 2026). */
test('[critical] a square-off within 15 minutes after the account\'s session hit is the session\'s; otherwise Close all', () => {
  const hits = [{ account: 1, at: 1_000_000 }, { account: 3, at: 5_000_000 }];
  assert.equal(sessionSquareOff(hits, 1, 1_000_000 + 4 * 60_000), true, '4 minutes after High\'s hit');
  assert.equal(sessionSquareOff(hits, 1, 1_000_000 - 30_000), true, 'the minute of the hit');
  assert.equal(sessionSquareOff(hits, 1, 1_000_000 + 16 * 60_000), false, 'too long after');
  assert.equal(sessionSquareOff(hits, 2, 1_000_000 + 60_000), false, 'another account\'s hit');
  assert.equal(sessionSquareOff([], 1, 1_000_000), false, 'no hit: Close all');
});
