/** The shapes the strategy API returns. Mirrors app/server/src/strategy/types.ts. */

export type PremiumMode = 'atLeast' | 'atMost';
export type LegConfig = 'CE' | 'PE' | 'both';
export type EntryPrice = 'now' | 'offer' | 'set';

export type StrategyConfig = {
  /** IST, 24-hour "HH:MM". Shown as 12-hour with AM or PM. */
  entryTime: string;
  /** IST, 24-hour "HH:MM", later than entry and before the 17:30 settlement for a daytime entry. */
  exitTime: string;
  premium: { mode: PremiumMode; usd: number };
  entryPrice: EntryPrice;
  entryLimit: number | null;
  /** Seconds to wait at the offer before crossing. Zero rests until filled. */
  crossAfterSec: number;
  /** Sell at the bid only while the spread is at most this (0.15 = 15%). Older strategies may lack it. */
  maxCrossSpreadPct?: number;
  takeProfitPct: number;
  stopLossPct: number;
  lots: number;
  legs: LegConfig;
  /** null means the gate is off. */
  probGate: number | null;
  doubleWhenOneSided: boolean;
  /**
   * When one leg's target buys contracts back, sell as many more of the other
   * leg -- while its bid is at least `minPriceUsd` and its price is under
   * `maxMultiple` times what it was sold for. null is off; older strategies lack it.
   */
  addToOpposite?: AddToOpposite | null;
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
};

export type AddToOpposite = {
  minPriceUsd: number;
  maxMultiple: number;
  /** The latest IST time an add may be made, 24-hour "HH:MM", between entry and exit. */
  addUntil: string;
};

/** Half an hour before the default 5:29 PM exit. Turning the add on uses the strategy's own exit. */
export const DEFAULT_ADD_TO_OPPOSITE: AddToOpposite = { minPriceUsd: 3, maxMultiple: 2, addUntil: '16:59' };

/** One decision to add to the other leg -- the skips too, with their reason. */
export type StrategyAdd = {
  id: number;
  strategyId: string;
  runDate: string;
  sourceTradeId: string;
  sourceSide: 'CE' | 'PE';
  symbol: string | null;
  contracts: number;
  status: 'placing' | 'placed' | 'skipped' | 'refused' | 'failed';
  detail: string;
  addedToTradeId: string | null;
  at: number;
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
  /** Every decision to add to the other leg. Absent from an older server. */
  adds?: StrategyAdd[];
};

export const DEFAULT_CONFIG: StrategyConfig = {
  entryTime: '05:30',
  exitTime: '17:29',
  premium: { mode: 'atLeast', usd: 15 },
  entryPrice: 'offer',
  entryLimit: null,
  crossAfterSec: 5,
  maxCrossSpreadPct: 0.15,
  takeProfitPct: 0.95,
  stopLossPct: 0,
  lots: 10,
  legs: 'both',
  probGate: 0.95,
  doubleWhenOneSided: true,
  addToOpposite: null,
  weekdays: [0, 1, 2, 3, 4, 5, 6],
};

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
