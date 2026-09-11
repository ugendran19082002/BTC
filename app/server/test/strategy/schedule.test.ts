import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRACE_MIN, entryDue, entryWindowEnd, exitDue, istDate, istMinutes, istWeekday, lotsPerLeg, nextEntryAt,
} from '../../src/strategy/schedule.js';
import { DEFAULT_CONFIG, type Strategy } from '../../src/strategy/types.js';

/**
 * The scheduler decides whether real orders are sent, so it owns no clock and
 * every case here is built by hand -- the same rule `trading/machine.ts` keeps.
 *
 * The property the whole file exists for: a strategy enters at most once per
 * IST day. A restart at 05:31, a poll every thirty seconds, and a redeploy at
 * midday must all leave that true.
 */

const strat = (over: Partial<Strategy> = {}): Strategy => ({
  id: 's1', name: 'test', enabled: true,
  config: { ...DEFAULT_CONFIG },
  createdAt: 0, updatedAt: 0,
  ...over,
});

/** A moment, written in IST because everything on this desk is. */
const ist = (iso: string) => Date.parse(`${iso}+05:30`);

// 2026-09-10 is a Thursday.
const THU_0530 = ist('2026-09-10T05:30:00');
const THU_0500 = ist('2026-09-10T05:00:00');
const THU_0545 = ist('2026-09-10T05:45:00');
const THU_0615 = ist('2026-09-10T06:15:00');
const THU_0645 = ist('2026-09-10T06:45:00');
const THU_1800 = ist('2026-09-10T18:00:00');

test('IST helpers agree with the clock the desk runs on', () => {
  assert.equal(istDate(THU_0530), '2026-09-10');
  assert.equal(istMinutes(THU_0530), 5 * 60 + 30);
  assert.equal(istWeekday(THU_0530), 4);                 // Thursday
  // 23:00 UTC is already the next day in IST, which is where a naive
  // implementation gets the day wrong and runs a strategy twice.
  assert.equal(istDate(Date.parse('2026-09-09T23:00:00Z')), '2026-09-10');
});

test('due exactly on time', () => {
  assert.deepEqual(entryDue(strat(), THU_0530, null), { due: true });
});

test('not due before its time', () => {
  const r = entryDue(strat(), THU_0500, null);
  assert.equal(r.due, false);
  assert.match(!r.due ? r.because : '', /waiting for 5:30 AM IST/, 'said as it is read, with AM or PM');
});

test('a late start inside the grace window still trades', () => {
  // The desk was down at 05:30 and came up at 05:45. Twelve hours remain.
  assert.deepEqual(entryDue(strat(), THU_0545, null), { due: true });
});

test('a start 45 minutes late still trades, now the window is an hour', () => {
  // raised from 30 to 60 minutes on 10 September 2026
  assert.equal(GRACE_MIN, 60);
  assert.deepEqual(entryDue(strat(), THU_0615, null), { due: true });
});

test('too late is refused rather than entered as a different trade', () => {
  const r = entryDue(strat(), THU_0645, null);
  assert.equal(r.due, false);
  assert.match(!r.due ? r.because : '', /too late/);
});

test('the grace window is exactly GRACE_MIN, inclusive', () => {
  const edge = THU_0530 + GRACE_MIN * 60_000;
  assert.equal(entryDue(strat(), edge, null).due, true);
  assert.equal(entryDue(strat(), edge + 60_000, null).due, false);
});

test('the entry window for 05:29 closes at 06:30:00, the same minute entryDue stops', () => {
  const s = strat({ config: { ...DEFAULT_CONFIG, entryTime: '05:29' } });
  const end = entryWindowEnd(s, THU_0530);
  assert.equal(end, ist('2026-09-10T06:30:00'));
  assert.equal(entryDue(s, end - 1, null).due, true, 'the last millisecond of 06:29 is still inside');
  assert.equal(entryDue(s, end, null).due, false, '06:30:00 is not');
});

test('[critical] a day that has run does not run again', () => {
  const r = entryDue(strat(), THU_0530, '2026-09-10');
  assert.equal(r.due, false);
  assert.match(!r.due ? r.because : '', /already ran today/);
});

test('[critical] the once-a-day guard is checked before anything else', () => {
  // A strategy switched to a different weekday, or edited mid-morning, must
  // still not re-enter a day it already traded. The guard cannot depend on the
  // other conditions still holding.
  const s = strat({ config: { ...DEFAULT_CONFIG, weekdays: [0] } });   // Sundays only
  const r = entryDue(s, THU_0530, '2026-09-10');
  assert.match(!r.due ? r.because : '', /already ran today/);
});

test('yesterday having run does not block today', () => {
  assert.deepEqual(entryDue(strat(), THU_0530, '2026-09-09'), { due: true });
});

test('a strategy that is off never runs', () => {
  const r = entryDue(strat({ enabled: false }), THU_0530, null);
  assert.equal(r.due, false);
  assert.match(!r.due ? r.because : '', /off/);
});

test('a day it was not asked to trade is skipped', () => {
  const s = strat({ config: { ...DEFAULT_CONFIG, weekdays: [0, 6] } });   // weekends
  const r = entryDue(s, THU_0530, null);
  assert.match(!r.due ? r.because : '', /not one of its days/);
});

test('an entry after its own exit time is refused', () => {
  const s = strat({ config: { ...DEFAULT_CONFIG, entryTime: '18:00', exitTime: '17:29' } });
  const r = entryDue(s, THU_1800, null);
  assert.equal(r.due, false);
  assert.match(!r.due ? r.because : '', /past its own exit/);
});

/* ---------------------------------------------------------------- exits --- */

test('the exit has no grace window -- late is still wanted', () => {
  // Deliberately not symmetrical with entry. An exit missed at 17:29 is still
  // wanted at 18:00; failing to ask costs the position.
  assert.deepEqual(exitDue(strat(), THU_1800, true), { due: true });
});

test('the exit does not fire before its time', () => {
  assert.equal(exitDue(strat(), THU_0545, true).due, false);
});

test('nothing open, nothing to close', () => {
  const r = exitDue(strat(), THU_1800, false);
  assert.equal(r.due, false);
  assert.match(!r.due ? r.because : '', /nothing open/);
});

test('asking twice to exit is allowed, because asking once too few is not', () => {
  assert.equal(exitDue(strat(), THU_1800, true).due, true);
  assert.equal(exitDue(strat(), THU_1800 + 60_000, true).due, true);
});

/* ------------------------------------------------------------ next entry --- */

test('the next entry is today when today is still open', () => {
  assert.equal(nextEntryAt(strat(), THU_0500, null), THU_0530);
});

test('the next entry rolls to tomorrow once today has run', () => {
  const at = nextEntryAt(strat(), THU_0530, '2026-09-10');
  assert.equal(istDate(at!), '2026-09-11');
  assert.equal(istMinutes(at!), 330);
});

test('the next entry skips days the strategy does not trade', () => {
  // Thursday, trading Mondays only -> the following Monday.
  const s = strat({ config: { ...DEFAULT_CONFIG, weekdays: [1] } });
  const at = nextEntryAt(s, THU_0530, null);
  assert.equal(istWeekday(at!), 1);
  assert.equal(istDate(at!), '2026-09-14');
});

test('a strategy that is off has no next entry', () => {
  assert.equal(nextEntryAt(strat({ enabled: false }), THU_0530, null), null);
});

/* ---------------------------------------------------------------- lots ---- */

test('both legs qualifying get one lot each', () => {
  assert.deepEqual(lotsPerLeg(strat(), ['CE', 'PE']), { CE: 10, PE: 10 });
});

test('[critical] one leg surviving the gate carries two lots', () => {
  assert.deepEqual(lotsPerLeg(strat(), ['CE']), { CE: 20, PE: 0 });
});

test('doubling needs the gate on -- without it no leg was ever refused', () => {
  const s = strat({ config: { ...DEFAULT_CONFIG, probGate: null } });
  assert.deepEqual(lotsPerLeg(s, ['CE']), { CE: 10, PE: 0 });
});

test('doubling needs both legs configured', () => {
  // A CE-only strategy always has exactly one leg; doubling it would silently
  // run at twice the size the person asked for, every day.
  const s = strat({ config: { ...DEFAULT_CONFIG, legs: 'CE' } });
  assert.deepEqual(lotsPerLeg(s, ['CE']), { CE: 10, PE: 0 });
});

test('doubling switched off leaves one lot', () => {
  const s = strat({ config: { ...DEFAULT_CONFIG, doubleWhenOneSided: false } });
  assert.deepEqual(lotsPerLeg(s, ['PE']), { CE: 0, PE: 10 });
});

test('no leg qualifying sells nothing', () => {
  assert.deepEqual(lotsPerLeg(strat(), []), { CE: 0, PE: 0 });
});
