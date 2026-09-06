import { cdf, greeks } from './bs.js';

/**
 * The three different questions people mean by "will it expire at zero".
 *
 * They have different answers and must not be mixed:
 *
 *   P(expire OTM)   where price lands at settlement.        N(-d2) / N(d2)
 *   P(touch strike) whether it gets there at any point.      first-passage
 *   P(near zero)    whether the premium collapses first.     simulated
 *
 * Delta is none of them. It is a sensitivity, and using it as a probability --
 * which this desk did until now -- overstates safety for out-of-the-money
 * strikes, because delta and N(d2) diverge exactly where the strikes worth
 * selling live.
 */

/** With r = 0, which is how Delta prices crypto options. */
export function d1d2(s: number, k: number, t: number, v: number) {
  const sq = v * Math.sqrt(t);
  const d1 = (Math.log(s / k) + 0.5 * v * v * t) / sq;
  return { d1, d2: d1 - sq };
}

/** Probability the option finishes worthless under the model. */
export function pExpireWorthless(
  cp: 'C' | 'P',
  s: number,
  k: number,
  t: number,
  v: number,
): number | null {
  if (!(t > 0) || !(v > 0) || !(s > 0) || !(k > 0)) return null;
  const { d2 } = d1d2(s, k, t, v);
  // a call dies below its strike, a put above it
  return cp === 'C' ? cdf(-d2) : cdf(d2);
}

/**
 * Probability the spot touches the strike at any time before expiry.
 *
 * Always higher than the chance of finishing there — price can cross and come
 * back — and it is the number that matters if a breach would make you close.
 * First-passage for log-price with drift -sigma^2/2.
 */
export function pTouch(
  s: number,
  k: number,
  t: number,
  v: number,
): number | null {
  if (!(t > 0) || !(v > 0) || !(s > 0) || !(k > 0)) return null;
  const b = Math.log(k / s);
  const mu = -0.5 * v * v;
  const sig = v * Math.sqrt(t);
  if (sig === 0) return b === 0 ? 1 : 0;

  if (b > 0) {
    // barrier above: P(max >= b)
    const p =
      cdf((-b + mu * t) / sig) +
      Math.exp((2 * mu * b) / (v * v)) * cdf((-b - mu * t) / sig);
    return Math.min(1, Math.max(0, p));
  }
  // barrier below: P(min <= b), by symmetry of the same formula
  const a = -b;
  const nu = -mu;
  const p =
    cdf((-a + nu * t) / sig) +
    Math.exp((2 * nu * a) / (v * v)) * cdf((-a - nu * t) / sig);
  return Math.min(1, Math.max(0, p));
}

/**
 * Probability the option's own price falls to `threshold` at some point before
 * expiry, which is what "book it at near zero" actually needs.
 *
 * Path-dependent, so it is simulated rather than solved: geometric Brownian
 * paths at a fixed step, repriced with Black-Scholes at each step. Deliberately
 * modest -- a few thousand paths on a coarse grid is enough to separate 40%
 * from 90%, and pretending to more precision than the volatility input deserves
 * would be false comfort.
 */
export function pReachNearZero(
  cp: 'C' | 'P',
  s: number,
  k: number,
  t: number,
  v: number,
  threshold = 0.1,
  paths = 2000,
  steps = 24,
): number | null {
  if (!(t > 0) || !(v > 0) || !(s > 0) || !(k > 0)) return null;
  const dt = t / steps;
  const drift = -0.5 * v * v * dt;
  const vol = v * Math.sqrt(dt);
  let hit = 0;

  // deterministic seed: the same chain must not produce a different number on
  // every refresh, which would look like the market moved when it did not
  let seed = Math.floor(s) * 73856093 ^ Math.floor(k) * 19349663 ^ Math.floor(t * 1e6);
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const gauss = () => {
    // Box-Muller, one draw per call is fine at this path count
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };

  for (let p = 0; p < paths; p++) {
    let price = s;
    for (let i = 1; i <= steps; i++) {
      price *= Math.exp(drift + vol * gauss());
      const left = t - i * dt;
      const px = left <= 0
        ? (cp === 'C' ? Math.max(0, price - k) : Math.max(0, k - price))
        : greeks(cp, price, k, left, v).price;
      if (px <= threshold) {
        hit++;
        break;
      }
    }
  }
  return hit / paths;
}

export type StrikeProbabilities = {
  /** lands out of the money at settlement */
  expireWorthless: number | null;
  /** reaches the strike at any point before settlement */
  touch: number | null;
  /** the option's own price collapses to near nothing before settlement */
  nearZero: number | null;
};

export function strikeProbabilities(
  cp: 'C' | 'P',
  s: number,
  k: number,
  t: number,
  v: number | null,
  withSimulation: boolean,
): StrikeProbabilities {
  if (v === null) return { expireWorthless: null, touch: null, nearZero: null };
  return {
    expireWorthless: pExpireWorthless(cp, s, k, t, v),
    touch: pTouch(s, k, t, v),
    nearZero: withSimulation ? pReachNearZero(cp, s, k, t, v) : null,
  };
}
