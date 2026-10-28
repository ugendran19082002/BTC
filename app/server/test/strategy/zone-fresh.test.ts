import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZONE_FRESH_DEFAULT_S, zoneFreshOf, zoneFreshProblem } from '../../src/strategy/types.js';
import { zoneFillFreshMs, zoneFreshFor } from '../../src/strategy/runner.js';

/**
 * The fill window, one account's (owner, 28 Oct 2026: "the fill window on the screen, dynamic: UI, backend, DB"): how late
 * a zone fill may still be entered, seconds by time frame. Stored as JSON; whatever cannot be read is the default.
 */

test('[critical] the defaults are the runner\'s own limits, time frame by time frame', () => {
  for (const tf of ['3m', '5m', '15m', '30m', '1h', '2h', '4h'] as const) assert.equal(ZONE_FRESH_DEFAULT_S[tf] * 1_000, zoneFillFreshMs(tf), tf);
});

test('[critical] stored: each time frame its own figure; one not set, out of range or unreadable keeps the default', () => {
  assert.deepEqual(zoneFreshOf(null), { ...ZONE_FRESH_DEFAULT_S });
  assert.deepEqual(zoneFreshOf(''), { ...ZONE_FRESH_DEFAULT_S });
  assert.deepEqual(zoneFreshOf('not json'), { ...ZONE_FRESH_DEFAULT_S });
  assert.deepEqual(zoneFreshOf('[1,2]'), { ...ZONE_FRESH_DEFAULT_S });
  const got = zoneFreshOf(JSON.stringify({ '5m': 120, '1h': 5, '4h': 900.5, '7m': 60 }));
  assert.deepEqual([got['5m'], got['1h'], got['4h'], got['3m']], [120, 300, 600, 90]);
  assert.equal(zoneFreshFor(JSON.stringify({ '5m': 120 }), '5m'), 120_000);
  assert.equal(zoneFreshFor(JSON.stringify({ '5m': 120 }), '15m'), 150_000);
});

test('what may be saved: whole seconds, 10 to 1800, known time frames; null is back to the defaults', () => {
  assert.equal(zoneFreshProblem(null), null);
  assert.equal(zoneFreshProblem({}), null);
  assert.equal(zoneFreshProblem({ '3m': 10, '4h': 1_800 }), null);
  assert.match(zoneFreshProblem({ '3m': 9 })!, /from 10 to 1800/);
  assert.match(zoneFreshProblem({ '3m': 1_801 })!, /from 10 to 1800/);
  assert.match(zoneFreshProblem({ x: 60 })!, /No time frame "x"/);
  assert.match(zoneFreshProblem('90')!, /seconds by time frame/);
});
