import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSE_SETTLE_SEC, closedOnly, wholeUntil } from '../../src/entry/read.js';

/**
 * A candle is whole only if it closed before the data was asked for. The
 * series cache answers stale while it refreshes, so at 12:05:03 it can hand
 * back data asked for at 12:04:45 -- in which the 12:04 minute holds only its
 * first 45 seconds. Read as closed, that minute was graded and signalled on
 * part of its data, and never again (1 Oct 2026).
 */

const M = 1_790_035_200; // a minute boundary, epoch s
const bar = (t: number) => ({ time: t, open: 1, high: 1, low: 1, close: 1, volume: 1 });

test('[critical] a minute that closed after the data was asked for is not closed in that data, whatever the clock says now', () => {
  const bars = [bar(M - 120), bar(M - 60), bar(M)];
  const now = M + 3; // 12:05:03
  const stale = wholeUntil((M - 15) * 1000, now); // asked for at 12:04:45
  assert.deepEqual(closedOnly(bars, 60, stale).map((b) => b.time), [M - 120], 'the 12:04 minute was still forming then');
  const fresh = wholeUntil((M + 3) * 1000, now); // asked for at 12:05:03
  assert.deepEqual(closedOnly(bars, 60, fresh).map((b) => b.time), [M - 120, M - 60], 'asked after the minute turned: 12:04 is whole');
});

test('a just-closed minute gets a moment to settle at the venue, and nothing is ever later than now', () => {
  assert.equal(wholeUntil((M + 1) * 1000, M + 30), M + 1 - CLOSE_SETTLE_SEC, 'asked one second after the close: not yet whole');
  assert.deepEqual(closedOnly([bar(M - 60)], 60, wholeUntil((M + 1) * 1000, M + 30)), []);
  assert.equal(wholeUntil((M + 100) * 1000, M + 10), M + 10, 'never past now');
  assert.equal(wholeUntil(0, M), -CLOSE_SETTLE_SEC, 'no data at all: nothing is whole');
});
