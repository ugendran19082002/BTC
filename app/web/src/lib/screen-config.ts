
/**
 * What the Live screen is deciding *with*: the strategy-configurable settings
 * the reference spec lists, kept in one object so the context bar can show
 * every one of them and every panel reads the same values.
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
  entryIst: string;
  strictness: 'STRICT' | 'BALANCED' | 'AGGRESSIVE';
  sideMode: 'AUTO' | 'CE_ONLY' | 'PE_ONLY' | 'BOTH_ALLOWED';
  riskMode: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
  execution: 'BID' | 'MARK' | 'DEPTH';
  /** Data older than this blocks entry, seconds. */
  freshnessSec: number;
  /** Contracts per order; null follows the desk's lots setting. */
  contracts: number | null;
};

export const DEFAULT_CONFIG: ScreenConfig = {
  horizonMin: 720, entryIst: '05:30', strictness: 'STRICT', sideMode: 'AUTO', riskMode: 'CONSERVATIVE',
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

/** The IST entry time as today's epoch ms, for "time since entry". */
export function entryTodayMs(entryIst: string, nowMs: number): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(entryIst);
  if (!m) return null;
  // IST is UTC+5:30 with no daylight saving.
  const ist = new Date(nowMs + 5.5 * 3_600_000);
  const day = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  return day + (Number(m[1]) * 60 + Number(m[2])) * 60_000 - 5.5 * 3_600_000;
}
