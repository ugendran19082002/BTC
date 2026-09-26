/** The shapes the strategy API returns. Mirrors app/server/src/strategy/types.ts. */

export type PremiumMode = 'atLeast' | 'atMost';
export type LegConfig = 'CE' | 'PE' | 'both';
export type EntryPrice = 'now' | 'offer' | 'set';

/** How the strike is chosen: by what it pays, or by where it sits. */
export type StrikeRule =
  | 'premium'
  | 'strict'
  /**
   * At the open-interest wall — the heaviest put strike for a PE, the heaviest
   * call strike for a CE, out of the money only.
   *
   * Differently untested from the other two: the premium rule carries a
   * 733-day record, `strict` carries none but is only a way of naming a strike
   * a person already chose, and this one is a claim — that the heaviest strike
   * is a better one to sell. Open interest is the thing `feature_screen.py`
   * tested as a trading rule and rejected. The form says so.
   */
  | 'oiWall';

/** How far from the money a strict rule may reach, either way. */
export const MAX_STRIKE_STEP = 20;

/** 0 -> "ATM", 2 -> "OTM 2", -1 -> "ITM 1". */
export function strikeLabel(step: number): string {
  if (!Number.isFinite(step) || step === 0) return 'ATM';
  return step > 0 ? `OTM ${step}` : `ITM ${-step}`;
}

/**
 * An exit read as a share (0.8 = 80%), as points from the entry, or as the
 * price itself -- the level, whatever the entry; its balance (level minus
 * entry) is re-measured from the entry that happens.
 */
export type MonitorOn = 'ltp' | 'close';

export type ExitMode = 'pct' | 'points' | 'price';

/** From `at` (IST "HH:MM"), the exit becomes `value`, in its rule's units. Zero turns it off. */
export type ExitStep = { at: string; value: number };

export type StrategyConfig = {
  /** IST, 24-hour "HH:MM". Shown as 12-hour with AM or PM. */
  entryTime: string;
  /** IST, 24-hour "HH:MM", later than entry and before the 17:30 settlement for a daytime entry. */
  exitTime: string;
  /** How the strike is chosen. Strategies saved before this read as 'premium'. */
  strikeRule: StrikeRule;
  /**
   * Which strike, counted from the money, when `strikeRule` is 'strict'.
   * 0 = ATM, +n = OTM n, -n = ITM n, over the strikes actually listed.
   */
  strikeStep: number;
  /**
   * `fallbackUsd`: tried only when `usd` finds no strike -- "at most $20, else
   * the last strike at or under $50". Above `usd` for at-most, below it for
   * at-least. Null or absent is no fallback.
   */
  premium: { mode: PremiumMode; usd: number; fallbackUsd?: number | null };
  entryPrice: EntryPrice;
  entryLimit: number | null;
  /** Seconds to wait at the offer before crossing. Zero rests until filled. */
  crossAfterSec: number;
  /** Sell at the bid only while the spread is at most this (0.15 = 15%). Older strategies may lack it. */
  maxCrossSpreadPct?: number;
  takeProfitPct: number;
  /** Above 1 is allowed: a short option can multiply. 2000% is the typo guard. */
  stopLossPct: number;
  /** How the target is read: a share of the credit, or points under the entry. Absent is 'pct'. */
  targetMode?: ExitMode;
  /** Target as points under the entry price. Absent is 0. */
  takeProfitPoints?: number;
  /** Target as the price itself, in `price` mode. Absent is 0. */
  takeProfitAt?: number;
  /** From each step's time, the target becomes its value, in `targetMode` units. */
  targetSteps?: ExitStep[];
  /** How the stop is read: a share of the entry, or points over it. Absent is 'pct'. */
  stopMode?: ExitMode;
  /**
   * What the stop and the target are watched on: the touch, or the bar's close.
   *
   * `ltp` fires the moment the mark reaches the level, which is what a resting
   * stop at the exchange does. `close` waits for the bar to finish -- a wick
   * through a level is not a break, and a thin option's mark can print a price
   * nothing traded at. The difference is real money both ways, so it is the
   * operator's choice per strategy.
   */
  monitorOn?: MonitorOn;
  /** Stop as points over the entry price. Absent is 0. */
  stopLossPoints?: number;
  /** Stop as the price itself, in `price` mode: 70 is 70, whatever the entry. Absent is 0. */
  stopLossAt?: number;
  /** From each step's time, the stop becomes its value, in `stopMode` units. */
  stopSteps?: ExitStep[];
  lots: number;
  legs: LegConfig;
  /** null means the gate is off. */
  /**
   * How late an entry may still be taken, in minutes after its time.
   *
   * A desk that was down at 05:30 and comes up at 05:34 should still trade; one
   * that comes up at 09:00 should not. How long "still fine" lasts belongs to
   * the strategy: an hour into a twelve-hour contract is nothing, ten minutes
   * into a signal is everything. Absent on strategies saved before this
   * existed, which read as 60.
   */
  graceMin: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
};

export type Strategy = {
  id: string;
  name: string;
  enabled: boolean;
  config: StrategyConfig;
  createdAt: number;
  updatedAt: number;
  lastRunDate: string | null;
  ranToday: boolean;
  nextEntryAt: number | null;
  /** Why it is not entering right now, in the server's own words. */
  status: string;
};

export type StrategyRun = {
  id: number;
  strategyId: string;
  runDate: string;
  status: 'placed' | 'refused' | 'failed' | 'skipped';
  detail: string;
  at: number;
};

export type StrategyStatus = {
  today: string;
  schedulerOn: boolean;
  /** Whether the loop that actually places the orders is installed. */
  runnerInstalled?: boolean;
  mode: 'live' | 'paper';
  /** For pricing a size in the editor while it is being typed. */
  balanceUsd: number | null;
  spot: number | null;
  strategies: Strategy[];
  runs: StrategyRun[];
};

export const DEFAULT_CONFIG: StrategyConfig = {
  entryTime: '05:30',
  exitTime: '17:29',
  strikeRule: 'premium',
  strikeStep: 0,
  premium: { mode: 'atLeast', usd: 15, fallbackUsd: null },
  entryPrice: 'offer',
  entryLimit: null,
  crossAfterSec: 5,
  maxCrossSpreadPct: 0.15,
  takeProfitPct: 0.95,
  stopLossPct: 0,
  targetMode: 'pct',
  monitorOn: 'ltp',
  takeProfitPoints: 0,
  takeProfitAt: 0,
  targetSteps: [],
  stopMode: 'pct',
  stopLossPoints: 0,
  stopLossAt: 0,
  stopSteps: [],
  lots: 10,
  legs: 'both',
  graceMin: 60,
  weekdays: [0, 1, 2, 3, 4, 5, 6],
};

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
