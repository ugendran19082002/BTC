import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StrategyStore } from '../../src/strategy/store.js';
import {
  DEFAULT_CONFIG, defaultAddUntil, hhmmOf, isHhmm, minutesOf, time12, validateConfig, type StrategyConfig,
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
const withAdd = (addUntil: unknown, over: Partial<StrategyConfig> = {}) =>
  cfg({ ...over, addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil } as StrategyConfig['addToOpposite'] });

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

test('the latest time to add defaults to half an hour before the exit', () => {
  assert.equal(defaultAddUntil('17:29'), '16:59');
  assert.equal(defaultAddUntil('12:00'), '11:30');
  assert.equal(defaultAddUntil('00:20'), '00:19', 'a strategy shorter than that gets the minute before');
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

test('the latest time to add sits inside an overnight window too', () => {
  const night = { entryTime: '23:30', exitTime: '05:30' };
  assert.deepEqual(validateConfig(withAdd('05:00', night)), [], 'half an hour before the exit, after midnight');
  assert.deepEqual(validateConfig(withAdd('23:45', night)), [], 'a quarter of an hour after the entry, before midnight');
  for (const outside of ['23:30', '05:30', '12:00']) {
    assert.ok(
      validateConfig(withAdd(outside, night)).some((p) => /must be after entry \(11:30 PM\) and before exit \(5:30 AM\)/.test(p)),
      outside,
    );
  }
});

test('a time that is not a time is refused in words, with an example', () => {
  const bad = validateConfig(cfg({ entryTime: '25:00', exitTime: 'soon' }));
  assert.ok(bad.includes('Entry time must be a time of day, like 5:30 AM.'));
  assert.ok(bad.includes('Exit time must be a time of day, like 5:29 PM.'));
});

// ------------------------------------------------------------- the latest time to add

test('[critical] the latest time to add must sit between entry and exit', () => {
  assert.deepEqual(validateConfig(withAdd('16:59')), [], 'between 5:30 AM and 5:29 PM');
  assert.deepEqual(validateConfig(withAdd('05:31')), [], 'a minute after entry is allowed');
  assert.deepEqual(validateConfig(withAdd('17:28')), [], 'a minute before exit is allowed');
  for (const outside of ['05:30', '05:00', '17:29', '17:45']) {
    const bad = validateConfig(withAdd(outside));
    assert.ok(bad.some((p) => /must be after entry \(5:30 AM\) and before exit \(5:29 PM\)/.test(p)), `${outside}: ${bad.join(' | ')}`);
  }
});

test('the check follows the strategy\'s own times, not the defaults', () => {
  const day = { entryTime: '09:00', exitTime: '15:00' };
  assert.deepEqual(validateConfig(withAdd('14:30', day)), []);
  assert.ok(validateConfig(withAdd('16:59', day)).some((p) => /before exit \(3:00 PM\)/.test(p)));
});

test('a latest time to add that is not a time is refused', () => {
  assert.ok(validateConfig(withAdd('4:59 PM')).some((p) => /latest time to add must be a time of day/.test(p)));
  assert.ok(validateConfig(withAdd(undefined)).some((p) => /latest time to add must be a time of day/.test(p)));
});

test('with the add switched off, there is no latest time to check', () => {
  assert.deepEqual(validateConfig(cfg({ addToOpposite: null })), []);
});

// ------------------------------------------------------------- stored

const freshPath = () => join(mkdtempSync(join(tmpdir(), 'times-')), 'trades.db');

test('[critical] a saved add without a latest time reads back with half an hour before its exit', () => {
  const s = new StrategyStore(freshPath());
  s.save({ id: 'old', name: 'Old', enabled: false, config: { ...cfg({ exitTime: '15:00' }), addToOpposite: { minPriceUsd: 3, maxMultiple: 2 } as never } });
  assert.equal(s.get('old')!.config.addToOpposite?.addUntil, '14:30');
});

test('[critical] the migration writes the latest time into strategies stored before it, and only those', () => {
  const path = freshPath();
  const first = new StrategyStore(path);
  first.save({ id: 'old', name: 'Old', enabled: false, config: { ...cfg(), addToOpposite: { minPriceUsd: 3, maxMultiple: 2 } as never } });
  first.save({ id: 'set', name: 'Set', enabled: false, config: withAdd('12:00') });

  // pretend 007 had never run
  const raw = new DatabaseSync(path);
  raw.prepare("DELETE FROM migrations WHERE id = '007-add-until'").run();
  raw.close();

  const again = new StrategyStore(path);
  assert.ok(again.applied.includes('007-add-until'));
  const stored = (id: string) => JSON.parse((new DatabaseSync(path).prepare('SELECT config FROM strategies WHERE id = ?').get(id) as { config: string }).config);
  assert.equal(stored('old').addToOpposite.addUntil, '16:59', 'written into the row itself, not only filled on read');
  assert.equal(stored('set').addToOpposite.addUntil, '12:00', 'a time somebody chose is left alone');
  assert.equal(stored('double').addToOpposite, null, 'a strategy with the add off is untouched');
});
