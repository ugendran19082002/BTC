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
  probGate: number | null;
  doubleWhenOneSided: boolean;
  /**
   * Sell a leg only if its strike scores at least this out of 100 — the board's
   * own sell score. null is off; older strategies lack it.
   *
   * Refuses the day, like the probability gate: the strike is what it is.
   */
  minSellScore?: number | null;
  /**
   * Enter only while the sudden-move risk score is at most this, out of 100.
   * null is off; older strategies lack it.
   *
   * Waits rather than refusing — the next tick looks again, until the entry
   * window closes.
   */
  maxShockScore?: number | null;
  /**
   * When one leg's target buys contracts back, sell as many more of the other
   * leg -- while its bid is at least `minPriceUsd` and its price is under
   * `maxMultiple` times what it was sold for. null is off; older strategies lack it.
   */
  addToOpposite?: AddToOpposite | null;
  /** Null is off, which is what every strategy saved before this had. */
  rebalance?: RebalanceRule | null;
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
};

/**
 * Dynamic one-sided rebalance: buy back part of the side that fell, sell the
 * same number again on the side that rose, stage by stage. Every number here is
 * typed on the screen -- the stages are "…n", not three.
 */
export type RebalanceRule = {
  enabled: boolean;
  lotsPerStep: number;
  steps: number;
  upStartPct: number;
  downStartPct: number;
  incrementPct: number;
  confirmTicks: number;
  /** Latest IST time a stage may fire, "HH:MM". The exit still runs after it. */
  endTime: string;
  lockDirection: boolean;
  maxLotsPerSide: number | null;
  allowPartial: boolean;
  maxSpreadPct: number | null;
  /**
   * If the rebalance sell has not filled, sell at the bid after this many
   * seconds. Null is the strategy's own entry seconds; zero rests at the offer.
   */
  crossAfterSec?: number | null;
};

export type RebalanceLimits = {
  maxSteps: number;
  maxLotsPerStep: number;
  maxUpPct: number;
  maxDownPct: number;
  maxIncrementPct: number;
  maxConfirmTicks: number;
  maxLotsPerSide: number;
};

/** What a rule starts as before the desk's own defaults arrive from the server. */
export const DEFAULT_REBALANCE: RebalanceRule = {
  enabled: true,
  lotsPerStep: 30,
  steps: 3,
  upStartPct: 30,
  downStartPct: 20,
  incrementPct: 10,
  confirmTicks: 2,
  endTime: '13:30',
  lockDirection: true,
  maxLotsPerSide: 200,
  allowPartial: true,
  maxSpreadPct: 0.15,
  crossAfterSec: null,
};

/** Stage n's thresholds, and what they mean in money against a sale price. */
export function stageThresholds(
  rule: Pick<RebalanceRule, 'steps' | 'upStartPct' | 'downStartPct' | 'incrementPct'>,
  base: number | null,
): { stage: number; upPct: number; downPct: number; upPrice: number | null; downPrice: number | null }[] {
  const out = [];
  for (let i = 0; i < Math.max(0, Math.min(100, Math.round(rule.steps))); i++) {
    const upPct = rule.upStartPct + rule.incrementPct * i;
    const downPct = rule.downStartPct + rule.incrementPct * i;
    out.push({
      stage: i + 1,
      upPct,
      downPct,
      upPrice: base === null ? null : Math.round(base * (1 + upPct / 100) * 100) / 100,
      downPrice: base === null ? null : Math.round(base * (1 - downPct / 100) * 100) / 100,
    });
  }
  return out;
}

/**
 * The most one side can ever reach, so the cap can be set to fit rather than
 * guessed. Each stage moves lots from the fallen side to the risen one, and the
 * fallen side is what runs out: 700 + 700 with 30 a stage over 3 stages reaches
 * 790 at most.
 */
export function mostOneSideCanReach(rule: Pick<RebalanceRule, 'lotsPerStep' | 'steps'>, lots: number): number {
  return lots + Math.min(lots, Math.max(0, Math.round(rule.lotsPerStep * rule.steps)));
}

/** What the position becomes after each stage, from the lots it opened with. */
export function stagePositions(rule: RebalanceRule, lots: number): { stage: number; up: number; down: number }[] {
  const out = [];
  let up = lots;
  let down = lots;
  for (let i = 0; i < Math.max(0, Math.min(100, Math.round(rule.steps))); i++) {
    const step = rule.allowPartial ? Math.min(rule.lotsPerStep, down) : (down >= rule.lotsPerStep ? rule.lotsPerStep : 0);
    const room = rule.maxLotsPerSide === null ? step : Math.max(0, Math.min(step, rule.maxLotsPerSide - up));
    down -= room;
    up += room;
    out.push({ stage: i + 1, up, down });
  }
  return out;
}

export type AddToOpposite = {
  minPriceUsd: number;
  maxMultiple: number;
  /** The latest IST time an add may be made, 24-hour "HH:MM", between entry and exit. */
  addUntil: string;
  /**
   * If the add has not filled, sell at the bid after this many seconds. Null,
   * or absent on a strategy saved before the control existed, means the entry's
   * own seconds -- which is what those strategies have been doing. Zero rests
   * at the offer and never crosses; the add window still ends it.
   */
  crossAfterSec?: number | null;
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
  strikeRule: 'premium',
  strikeStep: 0,
  premium: { mode: 'atLeast', usd: 15 },
  entryPrice: 'offer',
  entryLimit: null,
  crossAfterSec: 5,
  maxCrossSpreadPct: 0.15,
  takeProfitPct: 0.95,
  stopLossPct: 0,
  lots: 10,
  legs: 'both',
  graceMin: 60,
  probGate: 0.95,
  doubleWhenOneSided: true,
  minSellScore: null,
  maxShockScore: null,
  addToOpposite: null,
  rebalance: null,
  weekdays: [0, 1, 2, 3, 4, 5, 6],
};

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
