import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyStore } from '../../src/strategy/store.js';
import { closePool } from '../../src/db/pool.js';
import {
  DEFAULT_CONFIG, hhmmOf, isHhmm, minutesOf, time12, validateConfig, type StrategyConfig,
} from '../../src/strategy/types.js';

/**
 * The times a strategy runs on.
 *
 * Stored and sent as 24-hour "HH:MM" IST, because "5:30" alone is two
 * different moments. Read back to a person as 12-hour with AM or PM. And checked
 * the way the day actually runs: entry, then the latest time to add, then exit --
 * all before the 5:30 PM settlement for a position entered before it.
 */

const cfg = (over: Partial<StrategyConfig> = {}): StrategyConfig => ({ ...DEFAULT_CONFIG, ...over });

// ------------------------------------------------------------- reading

test('[critical] 24-hour in, 12-hour with AM or PM out -- midnight and noon included', () => {
  assert.equal(time12('00:00'), '12:00 AM');
  assert.equal(time12('00:05'), '12:05 AM');
  assert.equal(time12('05:30'), '5:30 AM');
  assert.equal(time12('11:59'), '11:59 AM');
  assert.equal(time12('12:00'), '12:00 PM');
  assert.equal(time12('17:29'), '5:29 PM');
  assert.equal(time12('23:59'), '11:59 PM');
});

test('minutes and "HH:MM" turn into each other and back', () => {
  for (const t of ['00:00', '05:30', '12:00', '16:59', '23:59']) assert.equal(hhmmOf(minutesOf(t)), t);
  assert.equal(hhmmOf(-1), '23:59', 'wraps rather than printing a negative time');
});

test('only a real 24-hour time counts as one', () => {
  for (const ok of ['00:00', '09:05', '23:59']) assert.equal(isHhmm(ok), true, ok);
  for (const bad of ['24:00', '5:30', '05:60', '5:30 PM', '', null, 530]) assert.equal(isHhmm(bad), false, String(bad));
});

// ------------------------------------------------------------- entry and exit

test('the default times are valid', () => {
  assert.deepEqual(validateConfig(cfg()), []);
});

test('[critical] a window that runs past the settlement is refused, in the times as they are read', () => {
  // 9:00 AM to 6:00 AM is twenty-one hours the long way round, and the contract
  // it holds expires at 5:30 PM on the way. What bounds a window is settlement,
  // not the clock: see the overnight cases below.
  const bad = validateConfig(cfg({ entryTime: '09:00', exitTime: '06:00' }));
  assert.ok(
    bad.includes('Exit (6:00 AM) comes after the 5:30 PM settlement that ends the contract entered at 9:00 AM. The last exit is 5:29 PM.'),
    bad.join(' | '),
  );
});

test('an exit at the same minute as the entry is no window at all', () => {
  assert.ok(validateConfig(cfg({ entryTime: '09:00', exitTime: '09:00' })).some((p) => /cannot be the same time as entry/.test(p)));
});

test('[critical] a daytime entry cannot exit at or after the 5:30 PM settlement', () => {
  const at = validateConfig(cfg({ entryTime: '05:30', exitTime: '17:30' }));
  assert.ok(at.some((p) => /5:30 PM settlement/.test(p)), at.join(' | '));
  assert.ok(validateConfig(cfg({ entryTime: '05:30', exitTime: '18:00' })).some((p) => /The last exit is 5:29 PM/.test(p)));
  assert.deepEqual(validateConfig(cfg({ entryTime: '05:30', exitTime: '17:29' })), [], '5:29 PM is the last minute');
});

test('an evening entry holds tomorrow\'s contract, so it may exit later the same evening', () => {
  assert.deepEqual(validateConfig(cfg({ entryTime: '18:00', exitTime: '23:30' })), []);
});

/*
 * Overnight windows, asked for on 12 September 2026: a strategy entered at
 * 11:30 PM and exiting at 5:30 AM would not save, because "later in the day"
 * read the clock rather than the strategy's own window.
 */

test('[critical] an exit earlier on the clock than the entry means the next morning, and saves', () => {
  assert.deepEqual(validateConfig(cfg({ entryTime: '23:30', exitTime: '05:30' })), []);
});

test('[critical] an overnight window still has to end before the settlement that ends its contract', () => {
  // 11:30 PM to 5:29 PM is nearly eighteen hours and just inside; a minute more
  // is a position Delta has already settled.
  assert.deepEqual(validateConfig(cfg({ entryTime: '23:30', exitTime: '17:29' })), []);
  assert.ok(validateConfig(cfg({ entryTime: '23:30', exitTime: '17:30' })).some((p) => /5:30 PM settlement/.test(p)));
});

test('a time that is not a time is refused in words, with an example', () => {
  const bad = validateConfig(cfg({ entryTime: '25:00', exitTime: 'soon' }));
  assert.ok(bad.includes('Entry time must be a time of day, like 5:30 AM.'));
  assert.ok(bad.includes('Exit time must be a time of day, like 5:29 PM.'));
});

// ------------------------------------------------------------- the latest time to add

// ------------------------------------------------------------- stored

