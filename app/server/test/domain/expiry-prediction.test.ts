import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { expiryPrediction } from '../../src/domain/expiry-prediction.js';
import { expiryPath } from '../../src/domain/expiry-path.js';
import type { HorizonRow } from '../../src/domain/forecast.js';

const row = (minutes: number, label: string, median: number, p68: number, p95: number): HorizonRow => ({
  minutes, label, windows: 105_119, moveMedian: median, moveP68: p68, moveP95: p95,
  moveWorst: 12, rangeMedian: median * 2, rangeP68: p68 * 2, rangeP95: p95 * 2,
  pUp: 0.502, pUpTrend: 0.49, sampleDays: 364, quantiles: [],
});

const HORIZONS: HorizonRow[] = [
  row(5, '5m', 0.0558, 0.0923, 0.2759),
  row(60, '1h', 0.1931, 0.3160, 0.9516),
  row(720, '12h', 0.7719, 1.2574, 3.3208),
];

const SPOT = 84_595;
const path = (hours = 20.6) => expiryPath({ spot: SPOT, hoursToExpiry: hours, atmIv: 0.253, horizons: HORIZONS, ladder: null });
const pred = (over: Partial<Parameters<typeof expiryPrediction>[0]> = {}) =>
  expiryPrediction({ spot: SPOT, hoursToExpiry: 20.6, atmIv: 0.253, path: path(), strikeStep: 200, ...over });

describe('the settlement band', () => {
  test('[critical] it is the measured 68% move, not the 95% — "most probable", not "almost certain"', () => {
    const p = pred()!;
    const settle = path()!.settlement!;
    // The half-width used must be p68, not p95.
    assert.ok(Math.abs((p.band.high - p.band.low) / 2 - settle.p68Usd) < 200, 'the band is not the 68% one');
    assert.ok(p.band.high - p.band.low < settle.p95Usd * 2, 'the band is as wide as the 95% one');
  });

  test('[critical] it is symmetric around spot — no arrow is smuggled in', () => {
    const p = pred()!;
    assert.equal(p.band.high - SPOT, SPOT - p.band.low);
  });

  test('[critical] the three probabilities add to one, so a reader can check them', () => {
    const p = pred()!;
    assert.ok(p.band.pInside !== null && p.band.pBelow !== null && p.band.pAbove !== null);
    assert.ok(Math.abs(p.band.pInside! + p.band.pBelow! + p.band.pAbove! - 1) < 1e-9);
  });

  test('[critical] the WIDTH is rounded to the strike step, not the edges', () => {
    /*
     * Rounding each edge to the grid looks tidier and breaks symmetry: with spot
     * at 84,595 on a 200 grid the two edges land different distances away, and
     * the range acquires a lean the data does not support.
     */
    const p = pred({ strikeStep: 200 })!;
    assert.equal((p.band.high - p.band.low) % 400, 0, 'the half-width is not a whole number of steps');
    assert.equal(p.band.high - SPOT, SPOT - p.band.low);
  });

  test('[critical] the band is marked measured only when it came from measured windows', () => {
    assert.equal(pred()!.bandMeasured, true);
    const noHorizons = expiryPrediction({ spot: SPOT, hoursToExpiry: 20.6, atmIv: 0.253, path: null });
    assert.equal(noHorizons!.bandMeasured, false);
    assert.match(noHorizons!.note, /nothing here is measured/);
  });

  test('without an IV the band still draws but claims no probability', () => {
    const p = expiryPrediction({ spot: SPOT, hoursToExpiry: 20.6, atmIv: null, path: path() })!;
    assert.ok(p.band.high > p.band.low);
    assert.equal(p.band.pInside, null);
  });

  test('the note keeps measured and modelled apart', () => {
    assert.match(pred()!.note, /measured windows/);
    assert.match(pred()!.note, /Black–Scholes/);
  });
});

describe('the target ladder', () => {
  test('[critical] every rung is a measured percentile, never an invented multiple', () => {
    const froms = pred()!.targets.map((t) => t.from);
    assert.deepEqual([...new Set(froms)].sort(), ['68%', '95%', 'typical']);
  });

  test('[critical] up and down are mirror images — the data gives no direction', () => {
    const p = pred()!;
    for (const label of ['T1', 'T2', 'T3'] as const) {
      const up = p.targets.find((t) => t.side === 'UP' && t.label === label)!;
      const down = p.targets.find((t) => t.side === 'DOWN' && t.label === label)!;
      assert.equal(up.price - SPOT, SPOT - down.price, `${label} is lopsided`);
      assert.ok(Math.abs(up.movePct + down.movePct) < 1e-9);
    }
  });

  test('[critical] a further rung is never more likely to be touched', () => {
    const p = pred()!;
    for (const side of ['UP', 'DOWN'] as const) {
      const t = (l: string) => p.targets.find((x) => x.side === side && x.label === l)!;
      assert.ok(t('T1').pTouch! >= t('T2').pTouch!, `${side} T2 beat T1`);
      assert.ok(t('T2').pTouch! >= t('T3').pTouch!, `${side} T3 beat T2`);
    }
  });

  test('six rungs: three each way', () => {
    assert.equal(pred()!.targets.length, 6);
  });

  test('[critical] touch odds are absent without an IV rather than guessed', () => {
    const p = expiryPrediction({ spot: SPOT, hoursToExpiry: 20.6, atmIv: null, path: path() })!;
    for (const t of p.targets) assert.equal(t.pTouch, null);
  });

  test('a settled contract predicts nothing', () => {
    assert.equal(expiryPrediction({ spot: SPOT, hoursToExpiry: 0, atmIv: 0.253, path: path() }), null);
    assert.equal(expiryPrediction({ spot: 0, hoursToExpiry: 5, atmIv: 0.253, path: path() }), null);
  });
});
