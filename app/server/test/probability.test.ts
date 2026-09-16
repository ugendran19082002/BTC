import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pExpireWorthless, pTouch, pReachNearZero, d1d2 } from '../src/domain/probability.js';
import { greeks, impliedVol, cdf, expectedMove } from '../src/domain/bs.js';

const S = 80_000;
const T = 12 / (365 * 24); // the twelve-hour horizon the desk trades
const V = 0.5;

const close = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) < tol, `${what}: ${a} vs ${b} (tol ${tol})`);

test('a call and a put on the same strike cannot both expire worthless', () => {
  // N(-d2) + N(d2) = 1, so the two probabilities are complements
  for (const k of [70_000, 79_000, 80_000, 81_000, 95_000]) {
    const c = pExpireWorthless('C', S, k, T, V)!;
    const p = pExpireWorthless('P', S, k, T, V)!;
    close(c + p, 1, 1e-9, `complement at ${k}`);
  }
});

test('at the money is close to a coin flip', () => {
  const p = pExpireWorthless('C', S, S, T, V)!;
  close(p, 0.5, 0.02, 'ATM call');
});

test('further out of the money is always safer', () => {
  let last = 0;
  for (const k of [80_200, 80_600, 81_000, 82_000, 84_000, 90_000]) {
    const p = pExpireWorthless('C', S, k, T, V)!;
    assert.ok(p > last, `call at ${k} should be safer than the previous strike`);
    last = p;
  }
  assert.ok(last > 0.99, 'a very far strike should be nearly certain');
});

test('this is NOT one minus delta -- the bug this file exists to prevent', () => {
  // Delta is a sensitivity. Treating it as a probability overstates safety, and
  // it does so most at exactly the strikes this strategy sells.
  const k = 82_000;
  const g = greeks('C', S, k, T, V);
  const byDelta = 1 - Math.abs(g.delta);
  const proper = pExpireWorthless('C', S, k, T, V)!;
  assert.ok(
    proper > byDelta,
    `N(-d2) ${proper} should exceed 1-|delta| ${byDelta} for an OTM call`,
  );
  assert.ok(proper - byDelta > 0.001, 'the gap should be material, not rounding');
});

test('touching a strike is never less likely than finishing beyond it', () => {
  for (const k of [80_400, 81_000, 82_000, 85_000]) {
    const finish = 1 - pExpireWorthless('C', S, k, T, V)!;
    const touch = pTouch(S, k, T, V)!;
    assert.ok(touch >= finish - 1e-9, `touch ${touch} < finish ${finish} at ${k}`);
  }
});

test('touch is symmetric above and below the money', () => {
  // a strike 2% away should be about as reachable in either direction
  const up = pTouch(S, S * 1.02, T, V)!;
  const down = pTouch(S, S * 0.98, T, V)!;
  close(up, down, 0.02, 'symmetry');
});

test('touch probabilities stay inside [0, 1]', () => {
  for (const k of [40_000, 79_999, 80_001, 200_000]) {
    for (const t of [T, T * 30, T / 100]) {
      const p = pTouch(S, k, t, V)!;
      assert.ok(p >= 0 && p <= 1, `out of range at k=${k} t=${t}: ${p}`);
    }
  }
});

test('more time and more volatility both make a strike less safe', () => {
  const k = 82_000;
  const base = pExpireWorthless('C', S, k, T, V)!;
  assert.ok(pExpireWorthless('C', S, k, T * 2, V)! < base, 'more time');
  assert.ok(pExpireWorthless('C', S, k, T, V * 2)! < base, 'more vol');
});

test('the near-zero simulation is deterministic', () => {
  // Two calls with identical inputs must agree, or the number would flicker on
  // every five-second refresh and look like the market had moved.
  const a = pReachNearZero('C', S, 82_000, T, V);
  const b = pReachNearZero('C', S, 82_000, T, V);
  assert.equal(a, b);
});

test('a worthless strike collapses; an expensive one usually does not', () => {
  const far = pReachNearZero('C', S, 95_000, T, V)!;
  const near = pReachNearZero('C', S, 80_200, T, V)!;
  assert.ok(far > 0.9, `a far strike should reach near-zero often, got ${far}`);
  assert.ok(near < far, 'a near strike should collapse less often than a far one');
});

test('put-call parity holds, which means the pricer is sane', () => {
  for (const k of [78_000, 80_000, 82_000]) {
    const c = greeks('C', S, k, T, V).price;
    const p = greeks('P', S, k, T, V).price;
    close(c - p, S - k, 0.01, `parity at ${k}`); // r = 0
  }
});

test('implied volatility recovers the volatility it was priced with', () => {
  for (const k of [79_000, 80_000, 83_000]) {
    const price = greeks('C', S, k, T, 0.62).price;
    close(impliedVol('C', price, S, k, T)!, 0.62, 1e-4, `round trip at ${k}`);
  }
});

test('implied volatility refuses a price below intrinsic', () => {
  assert.equal(impliedVol('C', 100, S, 70_000, T), null);
});

test('the normal CDF is accurate enough to trust', () => {
  close(cdf(0), 0.5, 1e-9, 'centre');
  close(cdf(1.644854), 0.95, 1e-4, '95th');
  close(cdf(2.326348), 0.99, 1e-4, '99th');
  close(cdf(-3), 0.0013499, 1e-5, 'left tail');
});

test('the expected move scales with the square root of time', () => {
  const one = expectedMove(S, V, T)!;
  const four = expectedMove(S, V, T * 4)!;
  close(four / one, 2, 1e-9, 'four times the time doubles the move');
});

test('d2 sits below d1 by exactly one volatility unit', () => {
  const { d1, d2 } = d1d2(S, 82_000, T, V);
  close(d1 - d2, V * Math.sqrt(T), 1e-12, 'separation');
});

import { zeroChance } from '../src/domain/calibration.js';

test('every strike gets its own adjusted probability, not a bucket average', () => {
  // Two strikes inside the same five-point bucket must not come back identical:
  // that was the bug where a call and a put with different open interest showed
  // the same number and looked broken.
  const a = zeroChance(0.905, 12);
  const b = zeroChance(0.945, 12);
  if (a?.adjusted !== null && a !== null && b !== null && b.adjusted !== null) {
    assert.notEqual(a.adjusted, b.adjusted, 'same bucket, different strikes, same number');
    assert.ok(b.adjusted! > a.adjusted!, 'the safer strike should read safer');
  }
});

test('the adjusted probability stays a probability', () => {
  for (const m of [0.01, 0.2, 0.5, 0.8, 0.95, 0.999]) {
    const z = zeroChance(m, 12);
    if (z?.adjusted != null) {
      assert.ok(z.adjusted >= 0 && z.adjusted <= 1, `out of range at ${m}: ${z.adjusted}`);
    }
  }
});

test('the adjustment is a correction, never a replacement', () => {
  // it should stay near the model, not snap to some bucket rate far away
  for (const m of [0.3, 0.6, 0.9, 0.99]) {
    const z = zeroChance(m, 12);
    if (z?.adjusted != null) {
      assert.ok(Math.abs(z.adjusted - m) < 0.08, `moved too far from the model at ${m}`);
    }
  }
});

test('a longer horizon is flagged, because the table was built on 12-hour trades', () => {
  assert.equal(zeroChance(0.95, 12)?.comparableHorizon, true);
  assert.equal(zeroChance(0.95, 24)?.comparableHorizon, false);
});

/**
 * The closed form itself, pinned against the formula it claims to be.
 *
 * First passage of a driftless log-price to a barrier:
 *
 *   b = ln(K/S)      mu = -sigma^2 / 2      sig = sigma * sqrt(T)
 *   P = N((-b + mu*T)/sig) + exp(2*mu*b / sigma^2) * N((-b - mu*T)/sig)
 *
 * Written out here rather than referenced, because a formula the code is the
 * only statement of is a formula nobody can check the code against. Below the
 * money the same expression is used on the mirrored barrier.
 */
test('[critical] touch matches the barrier-hitting formula, term for term', () => {
  const s = 75_820;
  const t = 12 / (365 * 24);
  const v = 0.30;
  const byHand = (k: number) => {
    const b = Math.log(k / s);
    const mu = -0.5 * v * v;
    const sig = v * Math.sqrt(t);
    const above = b > 0;
    const a = above ? b : -b;
    const nu = above ? mu : -mu;
    const N = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
    return N((-a + nu * t) / sig) + Math.exp((2 * nu * a) / (v * v)) * N((-a - nu * t) / sig);
  };
  for (const k of [74_400, 74_800, 76_800, 78_000]) {
    assert.ok(Math.abs(pTouch(s, k, t, v)! - byHand(k)) < 1e-9, `${k}: ${pTouch(s, k, t, v)} vs ${byHand(k)}`);
  }
});

/** Abramowitz-Stegun 7.1.26, good to 1.5e-7 -- enough to check a formula by. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const tt = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * tt - 1.453152027) * tt) + 1.421413741) * tt - 0.284496736) * tt + 0.254829592) * tt * Math.exp(-z * z);
  return sign * y;
}

test('[critical] the 16 September put: worthless at expiry is one question, touched is another', () => {
  // Spot 75,820, PE 74,400, 12 hours, 30% vol -- the example the desk was read
  // against. The two numbers are far apart, and that gap is the whole point of
  // showing both: a strike almost certain to expire worthless is still reached
  // often enough to sit through a drawdown.
  const s = 75_820;
  const k = 74_400;
  const t = 12 / (365 * 24);
  const v = 0.30;
  const settle = pExpireWorthless('P', s, k, t, v)!;
  const touch = pTouch(s, k, t, v)!;
  assert.ok(settle > 0.9, `expire worthless ${settle}`);
  assert.ok(touch > (1 - settle) * 1.5, `touch ${touch} should be well above the ${1 - settle} chance of finishing there`);
  assert.ok(touch < settle, 'and still the smaller of the two, on a strike this far out');
});

test('at the money it is certain to be touched, and far out it is not', () => {
  const t = 12 / (365 * 24);
  assert.ok(pTouch(75_820, 75_820, t, 0.3)! > 0.999, 'the barrier is where price already is');
  assert.ok(pTouch(75_820, 120_000, t, 0.3)! < 0.001);
});

test('touch rises with time and with volatility, never falls', () => {
  const s = 75_820;
  const k = 74_400;
  const hour = 1 / (365 * 24);
  assert.ok(pTouch(s, k, hour, 0.3)! < pTouch(s, k, 12 * hour, 0.3)!);
  assert.ok(pTouch(s, k, 12 * hour, 0.2)! < pTouch(s, k, 12 * hour, 0.5)!);
});
