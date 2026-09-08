/** Black-Scholes with r = 0, which is how Delta prices its crypto options. */

const SQRT_2PI = Math.sqrt(2 * Math.PI);

function pdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/** Abramowitz & Stegun 7.1.26 based normal CDF; ~1e-7 absolute error. */
export function cdf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}

export type Greeks = {
  price: number;
  delta: number;
  gamma: number;
  /** per 1 percentage point of IV */
  vega: number;
  /** per calendar day */
  theta: number;
};

/**
 * @param s spot
 * @param k strike
 * @param t time to expiry in years
 * @param v implied volatility as a fraction (0.65 = 65%)
 */
export function greeks(cp: 'C' | 'P', s: number, k: number, t: number, v: number): Greeks {
  if (t <= 0 || v <= 0 || s <= 0) {
    const intrinsic = cp === 'C' ? Math.max(0, s - k) : Math.max(0, k - s);
    return { price: intrinsic, delta: cp === 'C' ? (s > k ? 1 : 0) : s < k ? -1 : 0, gamma: 0, vega: 0, theta: 0 };
  }
  const sq = v * Math.sqrt(t);
  const d1 = (Math.log(s / k) + 0.5 * v * v * t) / sq;
  const d2 = d1 - sq;
  const price =
    cp === 'C' ? s * cdf(d1) - k * cdf(d2) : k * cdf(-d2) - s * cdf(-d1);
  return {
    price,
    delta: cp === 'C' ? cdf(d1) : cdf(d1) - 1,
    gamma: pdf(d1) / (s * sq),
    vega: (s * pdf(d1) * Math.sqrt(t)) / 100,
    theta: (-(s * pdf(d1) * v) / (2 * Math.sqrt(t))) / 365,
  };
}

/** Invert the price for implied volatility by bisection. Returns null if unattainable. */
export function impliedVol(
  cp: 'C' | 'P',
  price: number,
  s: number,
  k: number,
  t: number,
): number | null {
  const intrinsic = cp === 'C' ? Math.max(0, s - k) : Math.max(0, k - s);
  if (!(price > intrinsic) || t <= 0) return null;
  let lo = 0.01;
  let hi = 5;
  if (greeks(cp, s, k, t, hi).price < price) return null;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (greeks(cp, s, k, t, mid).price < price) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Expected move over the horizon implied by an at-the-money vol. */
export function expectedMove(spot: number, atmIv: number, years: number): number {
  return spot * atmIv * Math.sqrt(years);
}
