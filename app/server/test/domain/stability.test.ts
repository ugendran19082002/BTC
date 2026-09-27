import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  stabilityOf, penaltiesFor, WINDOW_MS, MIN_CALLS, UNSTABLE_FLIPS, type Call,
} from '../../src/domain/stability.js';

const NOW = 1_790_500_000_000;

/** Calls at one-minute spacing, newest last in the list as written. */
const calls = (...sides: (('UP' | 'DOWN' | null))[]): Call[] =>
  sides.map((side, i) => ({ at: NOW - (sides.length - 1 - i) * 60_000, side }));

describe('whether the read is holding its direction', () => {
  test('[critical] New.md\'s stable example is stable', () => {
    // UP UP UP SIDE UP
    const s = stabilityOf(calls('UP', 'UP', 'UP', null, 'UP'), NOW);
    assert.equal(s.verdict, 'STABLE');
    assert.equal(s.flips, 0, 'a range call between two up-calls is not a flip');
    assert.equal(s.leaning, 'UP');
  });

  test('[critical] New.md\'s unstable example is unstable', () => {
    // UP DOWN UP DOWN SIDE
    const s = stabilityOf(calls('UP', 'DOWN', 'UP', 'DOWN', null), NOW);
    assert.equal(s.verdict, 'UNSTABLE');
    assert.ok(s.flips >= UNSTABLE_FLIPS);
    assert.match(s.text, /noise with a direction printed on it/);
  });

  test('[critical] a range call between two same-side calls is never a flip', () => {
    assert.equal(stabilityOf(calls('UP', null, 'UP'), NOW).flips, 0);
    assert.equal(stabilityOf(calls('DOWN', null, null, 'DOWN'), NOW).flips, 0);
  });

  test('one change of side is choppy, not unstable — a turn is allowed', () => {
    const s = stabilityOf(calls('DOWN', 'DOWN', 'DOWN', 'UP'), NOW);
    assert.equal(s.flips, 1);
    assert.notEqual(s.verdict, 'UNSTABLE');
  });

  test('[critical] too few sided calls says so rather than claiming stability', () => {
    const s = stabilityOf(calls('UP', 'UP'), NOW);
    assert.equal(s.verdict, 'TOO_FEW');
    assert.match(s.text, /too few/i);
    // And it must not be mistaken for the good case.
    assert.notEqual(s.verdict, 'STABLE');
  });

  test('no calls at all is not an error and not stability', () => {
    const s = stabilityOf([], NOW);
    assert.equal(s.verdict, 'TOO_FEW');
    assert.equal(s.n, 0);
    assert.equal(s.ageMs, null);
    assert.match(s.text, /No calls/);
  });

  test('[critical] calls older than the window are ignored', () => {
    const old: Call[] = [
      { at: NOW - WINDOW_MS - 60_000, side: 'UP' },
      { at: NOW - WINDOW_MS - 120_000, side: 'DOWN' },
      { at: NOW - WINDOW_MS - 180_000, side: 'UP' },
    ];
    assert.equal(stabilityOf(old, NOW).n, 0);
  });

  test('a call from the future is ignored rather than producing a negative age', () => {
    const s = stabilityOf([{ at: NOW + 60_000, side: 'UP' }], NOW);
    assert.equal(s.n, 0);
  });

  test('persistence is the majority share, and bounded', () => {
    const s = stabilityOf(calls('UP', 'UP', 'UP', 'DOWN'), NOW);
    assert.equal(s.persistence, 3 / 4);
    assert.ok(s.persistence > 0 && s.persistence <= 1);
  });

  test('an even split leans nowhere', () => {
    const s = stabilityOf(calls('UP', 'DOWN', 'UP', 'DOWN'), NOW);
    assert.equal(s.leaning, null);
  });

  test('the age is measured from the newest call', () => {
    assert.equal(stabilityOf(calls('UP', 'UP', 'UP'), NOW).ageMs, 0);
  });

  test('every verdict carries a sentence a person can act on', () => {
    for (const c of [calls('UP', 'UP', 'UP'), calls('UP', 'DOWN', 'UP', 'DOWN'), calls('UP', 'UP', 'DOWN'), []]) {
      const s = stabilityOf(c, NOW);
      assert.ok(s.text.length > 20, `too terse: ${s.text}`);
    }
  });

  test('MIN_CALLS is the documented floor', () => {
    assert.equal(stabilityOf(calls(...Array(MIN_CALLS - 1).fill('UP')), NOW).verdict, 'TOO_FEW');
    assert.notEqual(stabilityOf(calls(...Array(MIN_CALLS).fill('UP')), NOW).verdict, 'TOO_FEW');
  });
});

describe('why confidence should be read down', () => {
  const base = {
    against: [] as string[],
    spotFrom: 'ticker' as const,
    missing: [] as string[],
    stability: null,
    maxAdx: 30,
    adxFloor: 20,
  };

  test('a clean read has no penalties', () => {
    assert.deepEqual(penaltiesFor(base), []);
  });

  test('[critical] a stale price is named first — it corrupts every distance', () => {
    const p = penaltiesFor({ ...base, spotFrom: 'candle-close' });
    assert.equal(p[0]!.reason, 'Stale price');
    assert.match(p[0]!.detail, /5-minute close/);
  });

  test('disagreeing frames are named, not counted', () => {
    const p = penaltiesFor({ ...base, against: ['5m', '15m'] });
    assert.match(p[0]!.detail, /5m, 15m/);
  });

  test('a trendless market is a penalty, with the number that says so', () => {
    const p = penaltiesFor({ ...base, maxAdx: 11 });
    assert.equal(p[0]!.reason, 'Nothing is trending');
    assert.match(p[0]!.detail, /11, under 20/);
  });

  test('[critical] an unstable read is a penalty and says why', () => {
    const s = stabilityOf(calls('UP', 'DOWN', 'UP', 'DOWN'), NOW);
    const p = penaltiesFor({ ...base, stability: s });
    assert.equal(p[0]!.reason, 'Low signal stability');
    assert.equal(p[0]!.detail, s.text);
  });

  test('a choppy read is a softer penalty, not the same words', () => {
    const choppy = stabilityOf(calls('UP', 'UP', 'DOWN'), NOW);
    const p = penaltiesFor({ ...base, stability: choppy });
    assert.equal(p[0]!.reason, 'Mixed signal');
  });

  test('a stable read adds no penalty', () => {
    const stable = stabilityOf(calls('UP', 'UP', 'UP', 'UP'), NOW);
    assert.deepEqual(penaltiesFor({ ...base, stability: stable }), []);
  });

  test('every penalty has both a short reason and an explanation', () => {
    const p = penaltiesFor({
      ...base, spotFrom: 'candle-close', against: ['5m'], maxAdx: 5,
      missing: ['12h has too few bars to read.'],
      stability: stabilityOf(calls('UP', 'DOWN', 'UP', 'DOWN'), NOW),
    });
    assert.ok(p.length >= 5);
    for (const x of p) {
      assert.ok(x.reason.length > 3 && x.reason.length < 30, `bad reason: ${x.reason}`);
      assert.ok(x.detail.length > 25, `detail too terse: ${x.detail}`);
    }
  });
});
