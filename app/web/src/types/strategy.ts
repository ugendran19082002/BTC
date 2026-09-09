/** The shapes the strategy API returns. Mirrors app/server/src/strategy/types.ts. */

export type PremiumMode = 'atLeast' | 'atMost';
export type LegConfig = 'CE' | 'PE' | 'both';
export type EntryPrice = 'now' | 'offer' | 'set';

export type StrategyConfig = {
  entryTime: string;
  exitTime: string;
  premium: { mode: PremiumMode; usd: number };
  entryPrice: EntryPrice;
  entryLimit: number | null;
  /** Seconds to wait at the offer before crossing. Zero rests until filled. */
  crossAfterSec: number;
  takeProfitPct: number;
  stopLossPct: number;
  lots: number;
  legs: LegConfig;
  /** null means the gate is off. */
  probGate: number | null;
  doubleWhenOneSided: boolean;
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
  premium: { mode: 'atLeast', usd: 15 },
  entryPrice: 'offer',
  entryLimit: null,
  crossAfterSec: 5,
  takeProfitPct: 0.95,
  stopLossPct: 0,
  lots: 10,
  legs: 'both',
  probGate: 0.95,
  doubleWhenOneSided: true,
  weekdays: [0, 1, 2, 3, 4, 5, 6],
};

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
