import { describe, expect, it } from 'vitest';
import {
  defaultAddUntil, fromParts, hhmmOf, inRange, isHhmm, minutesOf, parseTyped, partsOf, spanLabel, time12, wrapsMidnight,
} from '@/lib/time';

/**
 * Stored as 24-hour, read as 12-hour. The server has the same helpers, so these
 * pin the same answers it gives -- a time shown one way and saved another is
 * the mistake this whole change exists to stop.
 */
describe('reading a time', () => {
  it('[critical] says AM and PM, midnight and noon included', () => {
    expect(time12('00:00')).toBe('12:00 AM');
    expect(time12('05:30')).toBe('5:30 AM');
    expect(time12('12:00')).toBe('12:00 PM');
    expect(time12('17:29')).toBe('5:29 PM');
    expect(time12('23:59')).toBe('11:59 PM');
  });

  it('splits into the parts a clock face shows, and back', () => {
    expect(partsOf('17:29')).toEqual({ hour: 5, minute: 29, period: 'PM' });
    expect(partsOf('00:15')).toEqual({ hour: 12, minute: 15, period: 'AM' });
    for (const t of ['00:00', '05:30', '11:59', '12:00', '12:30', '17:29', '23:59']) {
      const { hour, minute, period } = partsOf(t);
      expect(fromParts(hour, minute, period)).toBe(t);
    }
  });

  it('counts minutes both ways and wraps at midnight', () => {
    expect(minutesOf('05:30')).toBe(330);
    expect(hhmmOf(330)).toBe('05:30');
    expect(hhmmOf(-1)).toBe('23:59');
  });

  it('knows a real 24-hour time from anything else', () => {
    expect(isHhmm('09:05')).toBe(true);
    for (const bad of ['24:00', '5:30', '05:60', '5:30 PM', '']) expect(isHhmm(bad)).toBe(false);
  });
});

describe('what somebody types', () => {
  it('[critical] takes the ways a time is written, and says which moment it is', () => {
    expect(parseTyped('5:29 pm')).toBe('17:29');
    expect(parseTyped('5:29PM')).toBe('17:29');
    expect(parseTyped('5.29 p')).toBe('17:29');
    expect(parseTyped('5 pm')).toBe('17:00');
    expect(parseTyped('529pm')).toBe('17:29');
    expect(parseTyped('12 am')).toBe('00:00');
    expect(parseTyped('12:30 pm')).toBe('12:30');
    expect(parseTyped('17:29')).toBe('17:29');
    expect(parseTyped('1729')).toBe('17:29');
    expect(parseTyped('0530')).toBe('05:30');
  });

  it('refuses what is not clearly a time rather than guessing', () => {
    for (const bad of ['', 'soon', '13 pm', '5:75', '25:00', '0 am']) expect(parseTyped(bad)).toBeNull();
  });
});

describe('ranges and spans', () => {
  it('is inclusive at both ends, and either end may be missing', () => {
    expect(inRange('05:31', '05:31', '17:28')).toBe(true);
    expect(inRange('17:28', '05:31', '17:28')).toBe(true);
    expect(inRange('05:30', '05:31', '17:28')).toBe(false);
    expect(inRange('23:00', '05:31', null)).toBe(true);
  });

  it('[critical] a range that ends before it starts runs past midnight', () => {
    // The exit picker for an 11:30 PM entry: 11:31 PM through to 5:29 PM.
    expect(inRange('23:45', '23:31', '17:29')).toBe(true);
    expect(inRange('05:30', '23:31', '17:29')).toBe(true);
    expect(inRange('17:29', '23:31', '17:29')).toBe(true);
    expect(inRange('17:30', '23:31', '17:29')).toBe(false);
    expect(inRange('23:30', '23:31', '17:29')).toBe(false);
  });

  it('says how long a strategy runs, round midnight if it has to', () => {
    expect(spanLabel('05:30', '17:29')).toBe('11 h 59 min');
    expect(spanLabel('09:00', '09:45')).toBe('45 min');
    expect(spanLabel('09:00', '11:00')).toBe('2 h');
    expect(spanLabel('23:30', '05:30')).toBe('6 h');
    expect(spanLabel('11:00', '09:00')).toBe('22 h');
    expect(spanLabel('09:00', '09:00')).toBe('');   // no window at all
  });

  it('knows which windows cross midnight', () => {
    expect(wrapsMidnight('23:30', '05:30')).toBe(true);
    expect(wrapsMidnight('05:30', '17:29')).toBe(false);
    expect(wrapsMidnight('09:00', '09:00')).toBe(false);
  });

  it('defaults the latest time to add to half an hour before the exit', () => {
    expect(defaultAddUntil('17:29')).toBe('16:59');
    expect(defaultAddUntil('00:20')).toBe('00:19');
  });
});
