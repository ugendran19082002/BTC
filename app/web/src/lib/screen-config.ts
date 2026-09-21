
/**
 * What the Live screen is deciding *with*: the desk's settings, kept in one
 * object so every panel reads the same values and each gate can say its limit.
 *
 * Contract-fixed values (expiry, tick, contract value) are never in here;
 * they come from the selected contract. Dynamic values (prices, greeks, odds)
 * are never in here either; they come from the chain. This is only the
 * operator's choices, and each has a documented effect below.
 */
export type ScreenConfig = {
  /** Prediction horizon the outlook is read at, minutes. */
  horizonMin: number;
  /** The configured entry time, IST "HH:MM". Entry shown is *now*; this is the strategy window it is judged against. */
  strictness: 'STRICT' | 'BALANCED' | 'AGGRESSIVE';
  sideMode: 'AUTO' | 'CE_ONLY' | 'PE_ONLY' | 'BOTH_ALLOWED';
  riskMode: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
  execution: 'BID' | 'MARK' | 'DEPTH';
  /** Data older than this blocks entry, seconds. */
  freshnessSec: number;
  /** Contracts per order; null follows the desk's lots setting. */
  contracts: number | null;
};

/**
 * The desk's defaults. BALANCED strictness: up to two soft gates may fail and
 * the side is WATCH rather than NOT PREFERRED -- under STRICT no soft failure
 * is allowed, so WATCH can never appear and the four outcomes are really two
 * (chosen 21 Sep 2026). CONSERVATIVE risk keeps the safety numbers tight:
 * P(touch) ≤ 25 %, ≥ 1.25 EM away, half-spread ≤ 5 % of the premium.
 */
export const DEFAULT_CONFIG: ScreenConfig = {
  horizonMin: 720, strictness: 'BALANCED', sideMode: 'AUTO', riskMode: 'CONSERVATIVE',
  execution: 'BID', freshnessSec: 30, contracts: null,
};

export type Thresholds = {
  /** Probability of touch at or under which a strike passes. */
  maxPot: number;
  /** Distance in expected moves at or over which a strike is safe. */
  minEmDistance: number;
  /** Half-spread as a share of premium at or under which execution passes. */
  maxSlippage: number;
  /** Tail loss allowed as a multiple of the desk's daily loss limit. */
  tailLimitFactor: number;
  /** Contracts allowed as a share of the desk's short cap. */
  sizeFactor: number;
  /** How many soft-gate failures still count as WATCH. */
  softFailsAllowed: number;
};

/** Risk mode sets the safety numbers; strictness sets how many soft failures are tolerated. Hard limits never loosen past the desk's own caps. */
export function thresholds(c: Pick<ScreenConfig, 'strictness' | 'riskMode'>): Thresholds {
  const risk = c.riskMode === 'CONSERVATIVE'
    ? { maxPot: 0.25, minEmDistance: 1.25, maxSlippage: 0.05, tailLimitFactor: 0.5, sizeFactor: 0.25 }
    : c.riskMode === 'BALANCED'
      ? { maxPot: 0.35, minEmDistance: 1.0, maxSlippage: 0.1, tailLimitFactor: 1.0, sizeFactor: 0.5 }
      : { maxPot: 0.45, minEmDistance: 0.75, maxSlippage: 0.15, tailLimitFactor: 1.0, sizeFactor: 1.0 };
  return { ...risk, softFailsAllowed: c.strictness === 'STRICT' ? 0 : c.strictness === 'BALANCED' ? 2 : 4 };
}
