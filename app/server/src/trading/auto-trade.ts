import type { BestTrade } from '../domain/best-trade.js';

/**
 * Selling the best pick by itself.
 *
 * The best-pick card already names one trade and the numbers it was chosen on.
 * This places it — once, per strike, per contract — while the switch is armed.
 * The decision is here and pure so that every rule about *not* trading can be
 * tested without an exchange, which is the half that matters: an auto-trader is
 * judged by what it refuses to do.
 *
 * ## The rules, and why each one exists
 *
 *   **Armed, and nothing else.** Off is the default and stays off through a
 *   deploy. Nobody gets an automatic order because a switch was left on by a
 *   release.
 *
 *   **Never a "best of none".** On a morning where no strike clears the hard
 *   rules the card still names the closest one, marked as not a recommendation.
 *   That card is for a person to read, never for a machine to sell.
 *
 *   **One strike, once per contract.** A pick that goes CE 78,800 → CE 79,000 →
 *   CE 78,800 is one piece of news about 78,800, and the desk must not sell it
 *   twice. Keyed by side, strike and expiry, kept per contract, so 5:31 PM
 *   starts a clean sheet without a clock in sight.
 *
 *   **A cap per contract**, one by default: the pick moving strike is not an
 *   invitation to hold four short options at once.
 *
 *   **Never on top of an open position in the same contract**, whoever opened
 *   it — a position the desk is already carrying is not somewhere to add blind.
 *
 *   **A refusal is remembered.** A strike the gates turned down is not tried
 *   again this contract: the alternative is asking Delta the same question every
 *   minute for eleven hours.
 *
 * The order itself goes through `service.place()`, which is the same engine,
 * the same prechecks and the same protection as the ticket. Nothing here can
 * place an order that a person could not place by hand from the card.
 */

export type AutoTradeSettings = {
  on: boolean;
  /** Lots per order. Five by default, which is the size the card is read at. */
  lots: number;
  /** Buy back this far down: 95 means the target sits at 5% of the sale price. */
  targetPct: number;
  /** 0 means no stop, as on the ticket. A short with no stop says so, loudly. */
  stopPct: number;
  /** Rest at the offer and walk to the bid over this many seconds. */
  chaseSeconds: number;
  /** How many automatic trades one contract may get at all. */
  maxPerContract: number;
};

export const AUTO_TRADE_DEFAULTS: AutoTradeSettings = {
  on: false,
  lots: 5,
  targetPct: 95,
  stopPct: 0,
  chaseSeconds: 5,
  maxPerContract: 1,
};

/**
 * The limits, which are themselves settings.
 *
 * A desk that cannot change its own ceiling ends up with a number in the source
 * standing between somebody and a trade they meant to make. So these are
 * editable from the card like everything else -- and behind them sit
 * `AUTO_TRADE_CEILINGS`, which are not: a mistyped ceiling must not be able to
 * turn a 5-lot rule into a fifty-thousand-lot one, and a target above 99% is
 * arithmetic, not a preference.
 */
export type AutoTradeLimits = {
  maxLots: number;
  minTargetPct: number;
  maxTargetPct: number;
  maxStopPct: number;
  maxChaseSec: number;
  maxPerContract: number;
};

export const AUTO_TRADE_LIMITS: AutoTradeLimits = {
  maxLots: 1_000,
  minTargetPct: 1,
  maxTargetPct: 99,
  maxStopPct: 500,
  maxChaseSec: 600,
  maxPerContract: 10,
};

/** What no setting may pass, whoever types it. */
export const AUTO_TRADE_CEILINGS = {
  maxLots: 100_000,
  /** A target is a share of the premium kept: 100% would be buying back at nothing. */
  maxTargetPct: 99,
  maxStopPct: 10_000,
  /** Ten minutes is the exchange's own patience with a working order. */
  maxChaseSec: 600,
  maxPerContract: 100,
} as const;

/** Limits from a browser, brought inside the ceilings. */
export function cleanAutoTradeLimits(raw: Partial<AutoTradeLimits> | null | undefined): AutoTradeLimits {
  const n = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : fallback);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const d = AUTO_TRADE_LIMITS;
  const c = AUTO_TRADE_CEILINGS;
  const minTargetPct = clamp(n(raw?.minTargetPct, d.minTargetPct), 1, c.maxTargetPct);
  return {
    maxLots: clamp(n(raw?.maxLots, d.maxLots), 1, c.maxLots),
    minTargetPct,
    // The top of the target range can never sit under its own floor.
    maxTargetPct: clamp(n(raw?.maxTargetPct, d.maxTargetPct), minTargetPct, c.maxTargetPct),
    maxStopPct: clamp(n(raw?.maxStopPct, d.maxStopPct), 0, c.maxStopPct),
    maxChaseSec: clamp(n(raw?.maxChaseSec, d.maxChaseSec), 0, c.maxChaseSec),
    maxPerContract: clamp(n(raw?.maxPerContract, d.maxPerContract), 1, c.maxPerContract),
  };
}

/** What has been traded automatically for one contract, and how it went. */
export type AutoTradeLedger = {
  expiry: string;
  /** `CE-78600` → what happened. A key present is a key never tried again. */
  entries: Record<string, { at: number; status: 'placed' | 'refused'; tradeId?: string; detail?: string }>;
};

export type AutoTradeDecision =
  | { act: 'skip'; why: string }
  | {
      act: 'place';
      key: string;
      symbol: string;
      side: 'CE' | 'PE';
      strike: number;
      lots: number;
      takeProfitPct: number;
      stopLossPct: number;
      chaseSeconds: number;
      /** What the card said when it chose this strike — for the message. */
      why: string;
    };

export type AutoTradeInput = {
  settings: AutoTradeSettings;
  best: BestTrade;
  snap: { expiry: string; expiryTs: number; live: boolean };
  /** Symbols the desk already has a position or a working order in. */
  openSymbols: readonly string[];
  ledger: AutoTradeLedger;
  /** How the symbol is spelled for this side and strike. */
  symbolFor: (side: 'CE' | 'PE', strike: number) => string;
};

export const autoTradeKey = (side: 'CE' | 'PE', strike: number): string => `${side}-${strike}`;

/** Every reason not to trade, then the trade. */
export function decideAutoTrade(input: AutoTradeInput): AutoTradeDecision {
  const { settings: s, best, snap, ledger } = input;
  if (!s.on) return { act: 'skip', why: 'off' };
  if (!snap.live) return { act: 'skip', why: 'not a live board' };
  if (!best.pick) return { act: 'skip', why: best.why ?? 'nothing to sell' };
  // The card marks this one "not a recommendation" in so many words. A machine
  // must not read past that.
  if (best.bestOfNone) return { act: 'skip', why: 'no strike clears the hard rules today' };

  const key = autoTradeKey(best.pick.side, best.pick.strike);
  const done = ledger.expiry === snap.expiry ? ledger.entries : {};
  const seen = done[key];
  if (seen) {
    return {
      act: 'skip',
      why: seen.status === 'placed'
        ? `${key} was already sold automatically for this contract`
        : `${key} was refused earlier for this contract`,
    };
  }
  const placed = Object.values(done).filter((e) => e.status === 'placed').length;
  if (placed >= s.maxPerContract) {
    return { act: 'skip', why: `${placed} automatic trade${placed === 1 ? '' : 's'} already on this contract` };
  }

  const symbol = input.symbolFor(best.pick.side, best.pick.strike);
  if (input.openSymbols.includes(symbol)) {
    return { act: 'skip', why: `already holding ${symbol}` };
  }

  return {
    act: 'place',
    key,
    symbol,
    side: best.pick.side,
    strike: best.pick.strike,
    lots: s.lots,
    takeProfitPct: s.targetPct / 100,
    stopLossPct: s.stopPct / 100,
    chaseSeconds: s.chaseSeconds,
    why: best.pick.reasons.join(' · '),
  };
}

/** Settings as stored, with every number brought inside the limits in force. */
export function cleanAutoTradeSettings(
  raw: Partial<AutoTradeSettings>,
  limits: AutoTradeLimits = AUTO_TRADE_LIMITS,
): AutoTradeSettings {
  const n = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    on: raw.on === true,
    lots: Math.round(clamp(n(raw.lots, AUTO_TRADE_DEFAULTS.lots), 1, limits.maxLots)),
    targetPct: Math.round(clamp(n(raw.targetPct, AUTO_TRADE_DEFAULTS.targetPct),
      limits.minTargetPct, limits.maxTargetPct)),
    stopPct: Math.round(clamp(n(raw.stopPct, AUTO_TRADE_DEFAULTS.stopPct), 0, limits.maxStopPct)),
    chaseSeconds: Math.round(clamp(n(raw.chaseSeconds, AUTO_TRADE_DEFAULTS.chaseSeconds), 0, limits.maxChaseSec)),
    maxPerContract: Math.round(clamp(n(raw.maxPerContract, AUTO_TRADE_DEFAULTS.maxPerContract), 1, limits.maxPerContract)),
  };
}
