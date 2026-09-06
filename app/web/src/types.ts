export type ZeroChance = {
  model: number;
  adjusted: number | null;
  historical: number | null;
  sample: number | null;
  gap: number | null;
  comparableHorizon: boolean;
  outsideTable: boolean;
};

export type Leg = {
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

export type Move = {
  hours: number;
  label: string;
  changeUsd: number | null;
  changePct: number | null;
  rangeUsd: number | null;
  rangePct: number | null;
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
};

export type Hedge = { strike: number; price: number; gapStrikes: number; widthUsd: number };

export type SideRecommendation = {
  side: 'CE' | 'PE';
  leg: Leg;
  lots: number;
  price: number;
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
  bothZeroChance: number | null;
  marginUsd: number;
  totalMaxLossUsd: number | null;
  rewardToRisk: number | null;
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

export type OptionStructure = {
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
  components: { name: string; value: number; weight: number; note: string }[];
};

export type Check = { ok: boolean; severity: 'block' | 'warn' | 'info'; text: string };

export type Verdict = {
  action: 'ENTER' | 'WAIT' | 'STAND_ASIDE';
  headline: string;
  detail: string;
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
  contracts: number;
};

export type ChainResponse = {
  snapshot: SnapshotMeta;
  legs: Leg[];
  bias: Bias;
  picks: Pick[];
  market: MarketRead | null;
  structure: OptionStructure;
  forecast: Forecast | null;
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

export type FloorRow = { floor: number; summary: Summary; medianOtmPct: number | null };
export type FloorResponse = { rows: FloorRow[] };

export type AccountResponse = {
  configured: boolean;
  message?: string;
  error?: string;
  availableUsd?: number;
  availableInr?: number;
  maxLots?: number;
  positions?: {
    product_symbol?: string;
    size?: number;
    entry_price?: string;
    unrealized_pnl?: string;
  }[];
};
