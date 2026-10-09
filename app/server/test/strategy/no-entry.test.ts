import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_NO_ENTRY_WINDOWS, minutesOf, noEntryProblems, noEntryWindowAt, validateConfig, DEFAULT_CONFIG, type NoEntry } from '../../src/strategy/types.js';

/**
 * A signal strategy's no-entry windows (owner, 9 Oct 2026: "no entry window ... from time to time"): which
 * moment falls in one, and what is refused before it can be saved. The runner's use is in
 * test/e2e/signal-strategy.test.ts.
 */
const on = (...windows: [string, string][]): NoEntry => ({ on: true, windows: windows.map(([from, to]) => ({ from, to })) });
const at = (n: NoEntry | null, hhmm: string) => noEntryWindowAt({ noEntry: n }, minutesOf(hhmm));

test('[critical] from is in the window, to is not; off, or absent, is no window', () => {
  const n = on(['17:00', '18:00']);
  assert.deepEqual(at(n, '17:00'), { from: '17:00', to: '18:00' });
  assert.deepEqual(at(n, '17:59'), { from: '17:00', to: '18:00' });
  assert.equal(at(n, '18:00'), null, 'entries open again at the to time');
  assert.equal(at(n, '16:59'), null);
  assert.equal(at({ ...n, on: false }, '17:30'), null, 'switched off: the times are kept and not read');
  assert.equal(at(null, '17:30'), null, 'a strategy saved before it existed');
});

test('[critical] a window past midnight, and the second of several', () => {
  const n = on(['09:00', '09:30'], ['23:30', '00:30']);
  assert.deepEqual(at(n, '23:45'), { from: '23:30', to: '00:30' });
  assert.deepEqual(at(n, '00:10'), { from: '23:30', to: '00:30' });
  assert.equal(at(n, '00:30'), null);
  assert.deepEqual(at(n, '09:15'), { from: '09:00', to: '09:30' });
  assert.equal(at(n, '12:00'), null);
});

test('[critical] held to the strategy\'s own entry and exit: wholly inside, never all of it, never two over the same minutes', () => {
  const p = (n: unknown, entry = '05:30', exit = '17:29') => noEntryProblems(n, entry, exit, true);
  const inside = (w: string) => `${w} must lie inside this strategy's 5:30 AM – 5:29 PM: from 5:30 AM or later, until 5:29 PM or earlier.`;
  assert.deepEqual(p(on(['17:00', '17:15'])), []);
  assert.deepEqual(p({ on: false, windows: [] }), [], 'off with nothing in it is fine');
  assert.deepEqual(p({ on: false, windows: [{ from: '18:00', to: '19:00' }] }), [], 'off: the kept times are not judged');
  // The edges are the strategy's own: from its entry, until its exit.
  assert.deepEqual(p(on(['05:30', '06:00'])), []);
  assert.deepEqual(p(on(['17:00', '17:29'])), []);
  // Outside, or partly outside -- refused whole, never half-applied.
  assert.deepEqual(p(on(['18:00', '19:00'])), [inside('The no-entry window (6:00 PM – 7:00 PM)')]);
  assert.deepEqual(p(on(['17:00', '18:00'])), [inside('The no-entry window (5:00 PM – 6:00 PM)')]);
  assert.deepEqual(p(on(['05:00', '06:00'])), [inside('The no-entry window (5:00 AM – 6:00 AM)')]);
  // All of it: no signal could ever be taken.
  assert.deepEqual(p(on(['05:30', '17:29'])), ['The no-entry window (5:30 AM – 5:29 PM) covers all of 5:30 AM – 5:29 PM: no signal could be taken. Switch the strategy off instead.']);
  // Several: each said by its number; two over the same minutes, said once, by both numbers.
  assert.deepEqual(p(on(['09:00', '09:30'], ['20:00', '21:00'])), [inside('No-entry window 2 (8:00 PM – 9:00 PM)')]);
  assert.deepEqual(p(on(['10:00', '11:00'], ['09:00', '10:30'])), ['No-entry windows 1 and 2 overlap: make them one window.']);
  assert.deepEqual(p(on(['09:00', '10:00'], ['10:00', '11:00'])), [], 'end to end is not an overlap: the until time is open again');
  // An overnight strategy, 11:30 PM to 5:29 AM: 1:00 AM is inside it, 11:00 PM is not.
  assert.deepEqual(p(on(['01:00', '02:00']), '23:30', '05:29'), []);
  assert.deepEqual(p(on(['23:45', '00:15']), '23:30', '05:29'), [], 'a window over midnight inside an overnight strategy');
  assert.equal(p(on(['23:00', '23:45']), '23:30', '05:29').length, 1);
  // Not a time, empty, too many, not a shape.
  assert.deepEqual(p(on()), ['Add a no-entry window, or switch it off.']);
  assert.deepEqual(p(on(['10:00', '10:00'])), ['The no-entry window is empty: from and until are both 10:00 AM.']);
  assert.deepEqual(p(on(['10:00', '25:00'])), ['The no-entry window needs a from and an until time, like 5:00 PM.']);
  assert.deepEqual(p(on(...Array.from({ length: MAX_NO_ENTRY_WINDOWS + 1 }, (_, i) => [`0${i}:00`, `0${i}:30`] as [string, string]))), [`At most ${MAX_NO_ENTRY_WINDOWS} no-entry windows.`]);
  assert.deepEqual(p({ on: 'yes', windows: [] }), ['The no-entry window must be on or off, with its times.']);
  // The strategy's own times wrong: said under their own fields, not again here.
  assert.deepEqual(p(on(['10:00', '11:00']), 'soon', '17:29'), []);
});

test('[critical] a clock strategy has no no-entry window: it enters once, at its own time', () => {
  assert.deepEqual(noEntryProblems(on(['09:00', '10:00']), '05:30', '17:29', false),
    ['A no-entry window is for a signal strategy: a clock strategy enters once, at its entry time.']);
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, noEntry: on(['09:00', '10:00']) }).includes('A no-entry window is for a signal strategy: a clock strategy enters once, at its entry time.'));
  assert.deepEqual(validateConfig({ ...DEFAULT_CONFIG, noEntry: { on: false, windows: [{ from: '09:00', to: '10:00' }] } }), [], 'off: nothing to object to');
});
