import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hoursSinceDeskOpen } from '../src/market/chain.js';

/**
 * The header's "+88 pts" is measured from 05:30 IST, the same moment as the
 * day's P&L beside it -- all day, not only while the morning contract runs.
 */

const IST = (y: number, m: number, d: number, hh: number, mm: number) =>
  Date.UTC(y, m - 1, d, hh - 5, mm - 30) / 1000;

test('[critical] counts from 05:30 IST today, and keeps counting after the 17:30 settlement', () => {
  assert.equal(hoursSinceDeskOpen(IST(2026, 9, 14, 5, 30)), 0);
  assert.equal(hoursSinceDeskOpen(IST(2026, 9, 14, 8, 0)), 2.5);
  assert.equal(hoursSinceDeskOpen(IST(2026, 9, 14, 17, 30)), 12);
  // the evening: the front contract is tomorrow's, but the day is still today's
  assert.equal(hoursSinceDeskOpen(IST(2026, 9, 14, 19, 33)), 14.05);
});

test('just before 05:30 the day is nearly over, not about to begin', () => {
  assert.equal(hoursSinceDeskOpen(IST(2026, 9, 15, 5, 29)), 23 + 59 / 60);
  assert.equal(hoursSinceDeskOpen(IST(2026, 9, 15, 5, 30)), 0);
});
