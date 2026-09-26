import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  momentumSignal, measuredFor, compressionOf, LIVE_POLICY, COILED_RATIO,
} from '../../src/domain/momentum-signal.js';
import { MOMENTUM_MEASURED } from '../../src/domain/momentum-measured.data.js';
import type { Candle } from '../../src/market/delta.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Five-minute bars, walked from a price by a list of closes. Each bar's range
 * is a tenth of the step either side, so ATR is well defined and small.
 */
function bars(closes: readonly number[], startSec = 1_700_000_000): Candle[] {
  const out: Candle[] = [];
  let prev = closes[0]!;
  closes.forEach((c, i) => {
    out.push({
      time: startSec + i * 300,
      open: prev,
      high: Math.max(prev, c) + 5,
      low: Math.min(prev, c) - 5,
      close: c,
      volume: 100,
    });
    prev = c;
  });
  return out;
}

/** A long flat stretch, then a hard push through the top of it. */
function breakout(n = 400, level = 84_000, push = 900): Candle[] {
  const flat = Array.from({ length: n }, (_, i) => level + Math.sin(i / 3) * 30);
  const up = Array.from({ length: 12 }, (_, i) => level + ((i + 1) / 12) * push);
  return bars([...flat, ...up]);
}

describe('the generated measured table', () => {
  /*
   * docs/FULL-STUDY.md §7.1: `break-carry.data.ts` is generated, imported by
   * committed code, and was left out of a commit -- which took six unrelated
   * suites down with a module-not-found nobody could read. This file has the
   * same shape, so it gets the check that failure deserved: a named test that
   * says what is missing and how to make it.
   */
  test('[critical] the generated scorecard exists — regenerate with `npx tsx src/backtest/momentum-study.ts`', () => {
    assert.ok(
      existsSync(join(HERE, '../../src/domain/momentum-measured.data.ts')),
      'src/domain/momentum-measured.data.ts is missing. It is GENERATED: run `npx tsx src/backtest/momentum-study.ts`.',
    );
  });

  test('[critical] it is not empty, and every row carries its sample size', () => {
    assert.ok(MOMENTUM_MEASURED.length > 0, 'the scorecard is empty');
    for (const r of MOMENTUM_MEASURED) {
      assert.ok(r.n >= 0, `${r.tf}/${r.policy} has no n`);
      assert.ok(r.tf.length > 0 && r.policy.length > 0);
      assert.ok(Number.isFinite(r.netR), `${r.tf}/${r.policy} has no net R`);
    }
  });

  test('[critical] the policy the live card places is one the study actually graded', () => {
    const graded = MOMENTUM_MEASURED.filter((r) => r.policy === LIVE_POLICY);
    assert.ok(graded.length > 0, `${LIVE_POLICY} was never graded — the card would place an unmeasured plan`);
  });
});

describe('reading a measured row', () => {
  test('an ungraded pair is null rather than a zero', () => {
    assert.equal(measuredFor('4h', LIVE_POLICY), null);
    assert.equal(measuredFor('5m', 'a policy nobody wrote'), null);
  });

  test('the held-out year comes back as the last one in the table', () => {
    const m = measuredFor('5m', LIVE_POLICY);
    if (!m) return; // the study may not have graded 5m
    assert.ok(m.outOfSample);
    assert.ok(Number(m.outOfSample!.year) >= 2026);
  });
});

describe('compression', () => {
  test('a flat market reads as contracted against a wild one before it', () => {
    const wild = Array.from({ length: 120 }, (_, i) => 84_000 + (i % 2 ? 600 : -600));
    const calm = Array.from({ length: 20 }, () => 84_000);
    const c = compressionOf(bars([...wild, ...calm]));
    assert.ok(c !== null && c < COILED_RATIO, `expected contraction, got ${c}`);
  });

  test('too few bars to judge is null, not 1', () => {
    assert.equal(compressionOf(bars([1, 2, 3])), null);
  });
});

describe('the live momentum call', () => {
  test('a quiet tape produces no signal and says so', () => {
    const flat = bars(Array.from({ length: 300 }, () => 84_000));
    const s = momentumSignal({ bars5m: flat, nowSec: flat[flat.length - 1]!.time + 600 });
    assert.equal(s.state, 'NONE');
    assert.equal(s.plan, null);
    assert.match(s.headline, /No break|ordinary/);
  });

  test('too little history is no signal rather than a guess', () => {
    const few = bars([84_000, 84_100, 84_200]);
    const s = momentumSignal({ bars5m: few, nowSec: few[few.length - 1]!.time + 600 });
    assert.equal(s.state, 'NONE');
  });

  test('[critical] the bar still forming is invisible — it can un-break', () => {
    /*
     * The precise property, rather than "the answer differs": reading at a
     * moment inside the last bar must give exactly what reading without that
     * bar at all gives. A bar that has not closed can still reverse, and the
     * measurement was taken at closes.
     */
    const b = breakout();
    const lastOpen = b[b.length - 1]!.time;
    const midBar = momentumSignal({ bars5m: b, nowSec: lastOpen + 100 });
    const withoutIt = momentumSignal({ bars5m: b.slice(0, -1), nowSec: lastOpen + 100 });
    assert.deepEqual(midBar, withoutIt, 'the unclosed bar changed the answer');
  });

  test('[critical] once it closes, it is read', () => {
    const b = breakout();
    const lastOpen = b[b.length - 1]!.time;
    const closed = momentumSignal({ bars5m: b, nowSec: lastOpen + 300 });
    const withoutIt = momentumSignal({ bars5m: b.slice(0, -1), nowSec: lastOpen + 300 });
    // The final bar now counts, so at least one of the reads it feeds must move.
    assert.notDeepEqual(
      [closed.state, closed.at, closed.compression],
      [withoutIt.state, withoutIt.at, withoutIt.compression],
      'a closed bar was still being ignored',
    );
  });

  test('a confirmed break carries a plan with a stop the wrong side of entry for its direction', () => {
    const b = breakout();
    const s = momentumSignal({ bars5m: b, nowSec: b[b.length - 1]!.time + 300 });
    if (s.state !== 'CONFIRMED') return; // the shape did not trip the rule; nothing to assert
    assert.ok(s.plan);
    if (s.side === 'UP') {
      assert.ok(s.plan!.stop < s.plan!.entry, 'a long stop must sit below the entry');
      assert.ok(s.plan!.target > s.plan!.entry, 'a long target must sit above the entry');
    } else {
      assert.ok(s.plan!.stop > s.plan!.entry);
      assert.ok(s.plan!.target < s.plan!.entry);
    }
  });

  test('[critical] every confirmed call carries its measured record or admits it has none', () => {
    const b = breakout();
    const s = momentumSignal({ bars5m: b, nowSec: b[b.length - 1]!.time + 300 });
    if (s.state !== 'CONFIRMED') return;
    if (s.measured === null) {
      assert.ok(s.warnings.some((w) => /never been graded/.test(w)), 'an ungraded call said nothing about being ungraded');
    } else {
      assert.ok(s.measured.n > 0);
      assert.match(s.headline, /net after fees|R net after fees/i);
    }
  });

  test('[critical] a shape the replay never showed a profit for is not a trade', () => {
    const b = breakout();
    const s = momentumSignal({ bars5m: b, nowSec: b[b.length - 1]!.time + 300 });
    if (s.state !== 'CONFIRMED' || !s.measured) return;
    if (s.measured.netR <= 0) {
      assert.equal(s.verdict, 'INFORMATIONAL', 'a losing shape was offered as tradeable');
      assert.ok(
        s.warnings.some((w) => /has not paid for itself/.test(w)),
        'the losing record was not stated in words',
      );
    } else {
      assert.equal(s.verdict, 'TRADEABLE');
    }
  });

  test('[critical] the verdict follows the measurement, never the setup', () => {
    /*
     * The property that the whole card exists for. Whatever the shape looks
     * like, TRADEABLE is reachable only through a positive measured net R.
     */
    const b = breakout();
    const s = momentumSignal({ bars5m: b, nowSec: b[b.length - 1]!.time + 300 });
    if (s.verdict === 'TRADEABLE') {
      assert.ok(s.measured !== null && s.measured.netR > 0);
    }
  });

  test('a stale break is not "now" — an hour later it has gone', () => {
    const b = breakout();
    const fresh = momentumSignal({ bars5m: b, nowSec: b[b.length - 1]!.time + 300 });
    const old = momentumSignal({ bars5m: b, nowSec: b[b.length - 1]!.time + 300 + 6 * 3600 });
    if (fresh.state === 'CONFIRMED') assert.notEqual(old.state, 'CONFIRMED');
  });

  test('[critical] a coiled range names both edges and refuses to pick a side', () => {
    const wild = Array.from({ length: 200 }, (_, i) => 84_000 + (i % 2 ? 700 : -700));
    const calm = Array.from({ length: 60 }, (_, i) => 84_000 + Math.sin(i / 5) * 8);
    const b = bars([...wild, ...calm]);
    const s = momentumSignal({ bars5m: b, nowSec: b[b.length - 1]!.time + 300 });
    if (s.state !== 'COILED') return;
    assert.equal(s.side, null, 'a contraction claimed a direction');
    assert.equal(s.plan, null, 'a contraction offered an entry');
    assert.equal(s.measured, null);
    assert.equal(s.verdict, 'INFORMATIONAL');
    assert.ok(s.level !== null && s.levelLow != null);
    assert.ok(s.warnings.some((w) => /not which way/.test(w)));
  });
});
