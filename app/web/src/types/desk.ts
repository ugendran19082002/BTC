export type ZeroChance = {
  model: number;
  adjusted: number | null;
  historical: number | null;
  sample: number | null;
  gap: number | null;
  comparableHorizon: boolean;
  outsideTable: boolean;
};

/**
 * What one strike is worth on average, and whether it clears the eligibility
 * rules. Computed server-side in `domain/ev.ts` from the same payout model the
 * recommendation uses, so the board and the card can never disagree.
 *
 * `signal` is description, not instruction: the EV rule behind it has never
 * been tested across 2024, 2025 and 2026 the way the premium floor and the RSI
 * gate were, and no gate reads it. The screen says so wherever it appears.
 */
export type LegEv = {
  payoutPerBtc: number | null;
  evPerBtc: number | null;
  evUsd: number | null;
  chargesUsd: number;
  volumeToOi: number | null;
  breakeven: number | null;
  maxProfitUsd: number | null;
  /** null means unbounded — a naked short has no worst case. */
  maxLossUsd: number | null;
  /** Traded today over open interest, banded: under 5%, 5–15%, over 15%. */
  liquidity: 'low' | 'normal' | 'high' | null;
  /** The credit as a share of the margin it ties up, and of the expected move. */
  premiumYieldPct: number | null;
  premiumPerExpectedMove: number | null;
  /** 0–100, ranking this strike against the rest of its board. */
  score: number | null;
  /**
   * The score's name. Floored by the rules in both directions: a hard rule
   * failing is `avoid` whatever the score, a soft one caps it at `watch`.
   */
  tier: 'strong' | 'candidate' | 'watch' | 'avoid';
  /** Where the expected value came from, for a reader who wants to argue. */
  breakdown: {
    pWin: number;
    premiumPerBtc: number;
    pLoss: number;
    expectedLossPerBtc: number;
    feesUsd: number;
    evUsd: number;
  } | null;
  checks: Check[];
  signal: 'sell' | 'watch' | 'avoid';
};

/**
 * What open interest has done since roughly an hour ago.
 *
 * Absent — not zero — until the desk has a bucket to compare against. Delta's
 * ticker carries the current figure and no previous one, so this only exists
 * because the desk remembers; "no change" and "not running long enough to know"
 * are different facts and the board must not print one as the other.
 */
export type OiChange = {
  change: number;
  changePct: number | null;
  /** How far back the comparison actually reached. */
  overMinutes: number;
  /** What BTC did over the same window, so the two are read together. */
  spotChangePct: number | null;
};

export type Leg = {
  ev: LegEv;
  oiChange: OiChange | null;
  cp: 'C' | 'P';
  strike: number;
  off: number;
  moneyness: 'ITM' | 'ATM' | 'OTM';
  ltp: number | null;
  mark: number | null;
  bid: number | null;
  ask: number | null;
  sellPrice: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  oi: number | null;
  volume: number | null;
  ageMin: number | null;
  probs: { expireWorthless: number | null; touch: number | null; nearZero: number | null };
  /**
   * How far this strike sits from spot in expected moves. 1.0 means today's
   * expected move reaches it exactly — the same statement on a quiet day and a
   * violent one, which "$1,400 away" is not.
   */
  emBuffer: number | null;
  distancePct: number;
  intrinsic: number;
  extrinsic: number | null;
  gammaExposure: number | null;
  pOtm: number | null;
  edge: number | null;
  emDistance: number | null;
  zero: ZeroChance | null;
  zeroByDistance: ZeroChance | null;
  score: number | null;
  reasons: string[];
};

export type TimeframeRead = {
  tf: '5m' | '15m' | '1h' | '4h' | '1d';
  bars: number;
  close: number;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  rsi14: number | null;
  atrPct: number | null;
  trend: -1 | 0 | 1;
  label: string;
};

/**
 * The label of the day's move -- since 05:30 IST, like every other "today" --
 * which the header and the moves table both pick out of the list. The same
 * string the server writes in `market/moves.ts`.
 */
export const TODAY_MOVE = 'today, since 05:30';

export type Move = {
  hours: number;
  /** A fixed window ("last 1h"), or `TODAY_MOVE`. */
  label: string;
  changeUsd: number | null;
  changePct: number | null;
  rangeUsd: number | null;
  rangePct: number | null;
};

export type VolumePulse = {
  tf: string;
  current: number;
  median: number;
  /** current ÷ median. 1 is an ordinary bar. */
  spike: number | null;
};

export type MarketRead = {
  spot: number;
  return24h: number | null;
  dailyRsiPrior: number | null;
  timeframes: TimeframeRead[];
  agreement: number;
  regime: string;
  realisedVol: number | null;
  moves: Move[];
  max24hRangeUsd: number | null;
  max24hRangePct: number | null;
  volume: VolumePulse[];
  /** The high and low of the last 24 hours, from the hourly bars. */
  high24h: number | null;
  low24h: number | null;
};

/**
 * Whether something is happening right now.
 *
 * `score` is null when not one of the five readings could be taken — which is
 * different from a quiet tape, and the card draws nothing rather than reporting
 * calm it cannot see. A part with a null `note` is one the desk has no history
 * for yet; it contributes nothing rather than contributing zero.
 */
export type SuddenMove = {
  score: number | null;
  band: 'normal' | 'watch' | 'high' | 'sudden';
  parts: {
    name: string;
    value: number;
    weight: number;
    note: string | null;
    /**
     * The headline and the two numbers behind it. A ratio on its own says how
     * unusual something is and nothing about whether it is worth anything.
     */
    detail?: { headline: string; now: string; before: string } | null;
  }[];
  reasons: string[];
  direction: number | null;
  directionLabel: string;
  /** What the direction is made of, each −1..+1 and named. */
  directionParts: { name: string; value: number }[];
  /** The window every reading above was taken over, in minutes. */
  window: number;
  /**
   * How often BTC has actually moved more than a percent over the next window
   * of the length chosen above — counted off the measured percentiles, not
   * assumed.
   */
  odds: {
    overMinutes: number;
    thresholdPct: number;
    up: number;
    down: number;
    /** Stayed inside the threshold — the outcome the other two leave out. */
    inside: number;
    /** `up + down`, kept because it is the number a seller asks for. */
    either: number;
    /** Half of all windows moved less than this, either way, in percent. */
    typicalPct: number;
    /** Nineteen in twenty stayed inside this, in percent. */
    outerPct: number;
  } | null;
};

export type Hedge = { strike: number; price: number; gapStrikes: number; widthUsd: number };

export type SideRecommendation = {
  side: 'CE' | 'PE';
  leg: Leg;
  lots: number;
  price: number;
  askPrice: number | null;
  creditUsd: number;
  creditInr: number;
  zeroChance: number | null;
  modelChance: number | null;
  sample: number | null;
  pExpireWorthless: number | null;
  pTouch: number | null;
  pNearZero: number | null;
  hedge: Hedge | null;
  hedgeRequested: boolean;
  maxProfit: number;
  maxLoss: number | null;
  breakeven: number;
  order: string;
  hedgeOrder: string | null;
};

export type Recommendation = {
  ok: boolean;
  why: string | null;
  hedgeMissing: boolean;
  sides: SideRecommendation[];
  split: { ce: number; pe: number };
  splitReason: string;
  totalCreditUsd: number;
  totalCreditInr: number;
  /** Delta's charges to open, GST included. */
  chargesUsd: number;
  chargesInr: number;
  /** Premium less charges: what is kept if every leg expires worthless. */
  netCreditUsd: number;
  netCreditInr: number;
  bothZeroChance: number | null;
  marginUsd: number;
  totalMaxLossUsd: number | null;
  rewardToRisk: number | null;
  mode: 'premium' | 'safety';
  safetyBar: number;
  expectedProfitUsd: number | null;
  expectedProfitInr: number | null;
  returnOnMarginPct: number | null;
  marginInr: number;
  usdinr: number;
  splitAlternatives: readonly {
    name: string;
    profitFactor: number;
    worstDayUsd: number;
    returnOverDrawdown: number;
    chosen: boolean;
  }[];
};

export type ForecastRow = {
  label: string;
  hours: number;
  impliedUsd: number | null;
  impliedPct: number | null;
  typicalPct: number;
  likelyPct: number;
  outerPct: number;
  worstPct: number;
  rangePct: number;
  pUp: number;
  low: number;
  high: number;
  isExpiry: boolean;
};

export type Forecast = {
  spot: number;
  sampleWindows: number;
  sampleDays: number;
  rows: ForecastRow[];
  directionEdgePts: number;
};

export type Wall = { strike: number; value: number } | null;

export type MaxPain = { strike: number; payoutUsd: number } | null;
export type OiRange = { low: number; high: number; widthUsd: number; widthPct: number } | null;

export type OptionStructure = {
  maxPain: MaxPain;
  oiRange: OiRange;
  ceOi: number;
  peOi: number;
  ceVolume: number;
  peVolume: number;
  pcrOi: number | null;
  pcrVolume: number | null;
  ceOiWall: Wall;
  peOiWall: Wall;
  gammaWall: Wall;
  atmIv: number | null;
  ivSkewPts: number | null;
  volPremiumPts: number | null;
  ranges: { sigma: number; low: number; high: number }[];
};

export type SnapshotMeta = {
  ts: number;
  live: boolean;
  expiry: string;
  expiryTs: number;
  isDaily: boolean;
  isNextEntry: boolean;
  nextEntryTs: number;
  step: number;
  tte: number;
  hoursToExpiry: number;
  spot: number;
  atm: number;
  atmIv: number | null;
  expectedMove: number | null;
  expectedMoveAtEntry: number | null;
  coverage: Coverage;
};

export type Coverage = {
  requested: number;
  above: number;
  below: number;
  highest: number | null;
  lowest: number | null;
  truncated: boolean;
};

export type Pick = {
  side: 'CE' | 'PE';
  leg: Leg;
  hedge: Leg | null;
  naked: boolean;
  hedgeGapUsed: number | null;
  netCreditUsd: number;
  maxLossUsd: number | null;
  breakeven: number;
};

export type Bias = {
  score: number;
  label: string;
  pcr: number | null;
  ivSkew: number | null;
  components: { name: string; value: number; weight: number; note: string; means: string }[];
};

export type Check = { ok: boolean; severity: 'block' | 'warn' | 'info'; text: string };

export type Verdict = {
  action: 'ENTER' | 'WAIT' | 'STAND_ASIDE';
  headline: string;
  detail: string | null;
  checks: Check[];
  orders: string[];
  nextWindow: string | null;
};

export type ExpiryOption = {
  expiry: string;
  expiryTs: number;
  iso: string;
  hoursAway: number;
  isDaily: boolean;
  isNextEntry: boolean;
  /** true for the first listed expiry — the one the desk defaults to */
  isDefault: boolean;
  contracts: number;
};

/**
 * Whether the tape says a side today, and whether the desk's gates would take
 * it. Mirrors `domain/direction.ts`.
 *
 * Description, not instruction: the lots are still split by the tested 70/30
 * rule in the recommendation. This is the reading beside it, and on most days
 * it says no side, which is the point of having it.
 */
export type DirectionInput = { key: string; label: string; value: number | null; why: string };
export type DirectionGate = {
  key: 'direction' | 'timeframes' | 'expectedMove' | 'structure' | 'execution';
  label: string;
  /** Null when there was nothing to read, which is never a pass. */
  pass: boolean | null;
  why: string;
};
export type DirectionVerdict = {
  score: number | null;
  side: 'bullish' | 'bearish' | null;
  inputs: DirectionInput[];
  gates: DirectionGate[];
  passed: number;
  readable: number;
  confirmed: boolean;
  summary: string;
};

/** The chance BTC finishes between the two strikes the desk would sell. */
export type Containment = {
  low: number;
  high: number;
  probability: number | null;
  /** Each short's distance from spot, in expected moves. */
  lowBuffer: number | null;
  highBuffer: number | null;
};

/**
 * One trade, named, with the numbers it was chosen on. Mirrors
 * `domain/best-trade.ts`.
 *
 * Ranked on credit-against-risk, the settlement odds, distance in expected
 * moves and liquidity. Touch is carried and deliberately not ranked on: a touch
 * is a drawdown, not a loss.
 */
export type BestTradeLeg = {
  cp: 'C' | 'P';
  side: 'CE' | 'PE';
  strike: number;
  premiumUsd: number;
  expiryOtm: number | null;
  touch: number | null;
  nearZero: number | null;
  emBuffer: number | null;
  delta: number | null;
  liquidity: number;
  creditUsd: number;
  /** Null when nothing caps it: a naked short has no worst case. */
  maxLossUsd: number | null;
  creditRisk: number | null;
  hedge: { strike: number; askUsd: number; widthUsd: number } | null;
  rank: number;
  reasons: string[];
};

export type BestTrade = {
  pick: BestTradeLeg | null;
  runnersUp: BestTradeLeg[];
  eligible: number;
  why: string | null;
  /** True when the tested engine picked the same strike. */
  agreesWithEngine: boolean;
};

export type ChainResponse = {
  snapshot: SnapshotMeta;
  legs: Leg[];
  bias: Bias;
  picks: Pick[];
  market: MarketRead | null;
  structure: OptionStructure;
  /** One per window: 5m, 15m, 1h, 4h. The screen picks; the server computes all four. */
  shocks: SuddenMove[];
  forecast: Forecast | null;
  direction: DirectionVerdict;
  containment: Containment | null;
  best: BestTrade;
  recommendation: Recommendation;
  requireHedge: boolean;
  verdict: Verdict;
  usdinr: number;
};

export type Band = { min: number; max: number };
export type Params = {
  ce: Band | null;
  pe: Band | null;
  priceSource: 'ltp' | 'mark';
  maxAgeMin: number;
  pick: 'highest' | 'lowest';
  lots: number;
  slippage: number;
  skipWeekdays: number[];
  hedgeGap: number;
  from?: string;
  to?: string;
};

export type Summary = {
  days: number;
  wins: number;
  losses: number;
  winPct: number;
  totalUsd: number;
  totalInr: number;
  avgUsd: number;
  grossWin: number;
  grossLoss: number;
  profitFactor: number;
  worstDayUsd: number;
  worstDate: string | null;
  bestDayUsd: number;
  maxDrawdownUsd: number;
  returnOverMdd: number;
};

export type TradeDay = {
  date: string;
  weekday: number;
  spot: number;
  settle: number;
  legs: {
    side: 'CE' | 'PE';
    strike: number;
    entry: number;
    exit: number;
    hedgeStrike: number | null;
    pnlUsd: number;
  }[];
  pnlUsd: number;
  pnlInr: number;
  cum: number;
};

export type BacktestResponse = {
  params: Params;
  summary: Summary;
  trades: TradeDay[];
  truncated: boolean;
  totalDays: number;
};

export type ByYearResponse = {
  overall: Summary;
  years: (Summary & { year: string })[];
};

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type CandlesResponse = {
  tf: string;
  resolution: string;
  bars: Candle[];
  /** Present when the feed refused; the board still works without the chart. */
  error?: string;
};
