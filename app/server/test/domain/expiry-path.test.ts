import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { expiryPath, scaleTo, strikeSafety, PATH_MINUTES } from '../../src/domain/expiry-path.js';
import { ladder } from '../../src/domain/hierarchy.js';
import type { HorizonRow } from '../../src/domain/forecast.js';

/** The real shape of chain.db's `horizons`, trimmed to the columns this file reads. */
const row = (minutes: number, label: string, median: number, p68: number, p95: number, pUp = 0.5): HorizonRow => ({
  minutes, label, windows: 105_000, moveMedian: median, moveP68: p68, moveP95: p95,
  moveWorst: 12, rangeMedian: median * 2, rangeP68: p68 * 2, rangeP95: p95 * 2,
  pUp, pUpTrend: 0.49, sampleDays: 364, quantiles: [],
});

// The measured table, as it actually stands on 2026-09-06.
const HORIZONS: HorizonRow[] = [
  row(5, '5m', 0.0558, 0.0923, 0.2759, 0.4942),
  row(15, '15m', 0.0975, 0.1585, 0.4765, 0.4952),
  row(60, '1h', 0.1931, 0.3160, 0.9516, 0.5004),
  row(120, '2h', 0.2741, 0.4488, 1.3831, 0.5035),
  row(240, '4h', 0.3905, 0.6488, 1.9767, 0.5026),
  row(720, '12h', 0.7719, 1.2574, 3.3208, 0.5062),
];

const SPOT = 84_000;

describe('scaling a horizon that was not measured', () => {
  test('a measured horizon comes back exactly, and says it was measured', () => {
    const s = scaleTo(HORIZONS, 60)!;
    assert.equal(s.medianPct, 0.1931);
    assert.equal(s.interpolated, false);
    assert.equal(s.windows, 105_000);
  });

  test('[critical] 30m is interpolated between 15m and 1h, and admits it', () => {
    const s = scaleTo(HORIZONS, 30)!;
    assert.equal(s.interpolated, true);
    assert.equal(s.windows, 0, 'an interpolated row stands on no windows of its own');
    assert.ok(s.medianPct > 0.0975 && s.medianPct < 0.1931, 'between its two anchors');
  });

  test('interpolation is linear in root-time, which is how diffusion scales', () => {
    // Halfway in √t between 15m and 60m is √30 ≈ 5.48, between 3.87 and 7.75.
    const s = scaleTo(HORIZONS, 30)!;
    const f = (Math.sqrt(30) - Math.sqrt(15)) / (Math.sqrt(60) - Math.sqrt(15));
    assert.ok(Math.abs(s.medianPct - (0.0975 + (0.1931 - 0.0975) * f)) < 1e-9);
  });

  test('past the end of the table it extrapolates from the last anchor by root-time', () => {
    const s = scaleTo(HORIZONS, 1440)!;
    assert.equal(s.interpolated, true);
    assert.ok(Math.abs(s.medianPct - 0.7719 * Math.sqrt(1440 / 720)) < 1e-9);
  });

  test('a longer horizon is never a smaller move', () => {
    let last = 0;
    for (const m of [5, 15, 30, 60, 120, 240, 480, 720]) {
      const s = scaleTo(HORIZONS, m)!;
      assert.ok(s.p95Pct >= last, `${m}m went backwards`);
      last = s.p95Pct;
    }
  });

  test('an empty table scales to nothing rather than to zero', () => {
    assert.equal(scaleTo([], 60), null);
  });
});

describe('the path to settlement', () => {
  const path = expiryPath({ spot: SPOT, hoursToExpiry: 6, atmIv: 0.45, horizons: HORIZONS, ladder: null })!;

  test('[critical] the cone is symmetric — it is a band, not a forecast', () => {
    for (const r of path.rows) {
      assert.equal(r.high68 - SPOT, SPOT - r.low68, `${r.label} is lopsided`);
      assert.equal(r.high95 - SPOT, SPOT - r.low95, `${r.label} is lopsided`);
    }
  });

  test('[critical] the measured lean is reported, and it is next to nothing', () => {
    // 0.62 percentage points is the largest |pUp − 0.5| in the real table.
    assert.ok(path.directionEdgePct < 1, `direction edge was ${path.directionEdgePct}`);
    for (const r of path.rows) {
      assert.ok(Math.abs(r.leanUsd) < r.p68Usd, `${r.label}: the lean outgrew the band it sits in`);
    }
  });

  test('[critical] the note says the band is measured and the direction is not', () => {
    assert.match(path.note, /band is measured/);
    assert.match(path.note, /direction is not/);
    assert.match(path.note, /105,000|1,05,000/);
  });

  test('every horizon inside the contract is drawn, and none beyond it', () => {
    const labels = path.rows.map((r) => r.label);
    assert.ok(labels.includes('5m'));
    assert.ok(labels.includes('2h'));
    assert.equal(labels[labels.length - 1], 'expiry');
    // 6 hours to go: nothing past 2h from PATH_MINUTES, then settlement.
    assert.equal(path.rows.length, PATH_MINUTES.length + 1);
  });

  test('a contract expiring in twenty minutes drops the horizons past it', () => {
    const short = expiryPath({ spot: SPOT, hoursToExpiry: 20 / 60, atmIv: 0.45, horizons: HORIZONS, ladder: null })!;
    assert.deepEqual(short.rows.map((r) => r.label), ['5m', '15m', 'expiry']);
  });

  test('the settlement row is the last row, and is the one strikes are judged against', () => {
    assert.equal(path.settlement, path.rows[path.rows.length - 1]);
    assert.equal(path.settlement!.label, 'expiry');
  });

  test('the implied move comes from IV and disappears without one', () => {
    assert.ok(path.rows[0]!.impliedUsd! > 0);
    const noIv = expiryPath({ spot: SPOT, hoursToExpiry: 6, atmIv: null, horizons: HORIZONS, ladder: null })!;
    assert.equal(noIv.rows[0]!.impliedUsd, null);
  });

  test('[critical] the hierarchy picks which edge to watch and never moves the band', () => {
    const down = ladder([]);
    const withLadder = expiryPath({ spot: SPOT, hoursToExpiry: 6, atmIv: 0.45, horizons: HORIZONS, ladder: down });
    assert.equal(withLadder!.watch, 'BOTH');
    for (let i = 0; i < path.rows.length; i++) {
      assert.equal(withLadder!.rows[i]!.p95Usd, path.rows[i]!.p95Usd, 'the ladder changed the band');
    }
  });

  test('no spot, or no table, is no path', () => {
    assert.equal(expiryPath({ spot: 0, hoursToExpiry: 6, atmIv: 0.45, horizons: HORIZONS, ladder: null }), null);
    assert.equal(expiryPath({ spot: SPOT, hoursToExpiry: 6, atmIv: 0.45, horizons: [], ladder: null }), null);
  });
});

describe('how safe one strike is', () => {
  const path = expiryPath({ spot: SPOT, hoursToExpiry: 12, atmIv: 0.45, horizons: HORIZONS, ladder: null })!;

  test('[critical] distance is quoted in measured moves, not in dollars alone', () => {
    const far = strikeSafety({ cp: 'C', strike: 90_000, spot: SPOT, hoursToExpiry: 12, atmIv: 0.45, path })!;
    assert.ok(far.distanceInP95! > 1);
    assert.equal(far.outsideMeasured95, true);
    assert.match(far.why, /x the measured 95% move/);
  });

  test('[critical] a strike inside the measured band is named as inside it', () => {
    const near = strikeSafety({ cp: 'C', strike: 84_500, spot: SPOT, hoursToExpiry: 12, atmIv: 0.45, path })!;
    assert.equal(near.outsideMeasured95, false);
    assert.match(near.why, /inside the band that has been reached/);
  });

  test('a call further away is always at least as safe as a nearer one', () => {
    const near = strikeSafety({ cp: 'C', strike: 85_000, spot: SPOT, hoursToExpiry: 12, atmIv: 0.45, path })!;
    const far = strikeSafety({ cp: 'C', strike: 88_000, spot: SPOT, hoursToExpiry: 12, atmIv: 0.45, path })!;
    assert.ok(far.pExpireWorthless! >= near.pExpireWorthless!);
    assert.ok(far.pTouch! <= near.pTouch!);
  });

  test('[critical] touching is always at least as likely as finishing through', () => {
    for (const k of [84_500, 85_000, 86_000, 88_000]) {
      const s = strikeSafety({ cp: 'C', strike: k, spot: SPOT, hoursToExpiry: 12, atmIv: 0.45, path })!;
      assert.ok(s.pTouch! >= 1 - s.pExpireWorthless! - 1e-9, `${k}: touch was rarer than finishing through`);
    }
  });

  test('without an IV the probabilities are absent, not guessed', () => {
    const s = strikeSafety({ cp: 'P', strike: 80_000, spot: SPOT, hoursToExpiry: 12, atmIv: null, path })!;
    assert.equal(s.pExpireWorthless, null);
    assert.equal(s.pTouch, null);
    // The measured distance still works: it needs no model.
    assert.ok(s.distanceInP95! > 0);
  });

  test('without a path there is no measured distance, and it says so', () => {
    const s = strikeSafety({ cp: 'P', strike: 80_000, spot: SPOT, hoursToExpiry: 12, atmIv: 0.45, path: null })!;
    assert.equal(s.distanceInP95, null);
    assert.match(s.why, /No measured move/);
  });
});
