/**
 * The Live screen's own shapes, mirroring `app/server/src/market/live-read.ts`.
 *
 * Kept flat and kept here, the same way `types/trade.ts` mirrors the trading
 * engine: the screen should be readable without opening the server, and a
 * field that changes shape should break the build rather than arrive as
 * `undefined` in a panel.
 */

export type Way = 'UP' | 'DOWN' | 'SIDE';

/** What a timeframe is *for*. The tier sets the weight; `execution` carries none. */
export type Tier = 'direction' | 'structure' | 'setup' | 'pattern' | 'trigger' | 'execution';

export type LadderRow = {
  tf: string;
  tier: Tier;
  weight: number;
  trend: -1 | 0 | 1;
  momentum: 'bullish' | 'bearish' | 'neutral' | null;
  structure: -1 | 0 | 1;
  vwapDistPct: number | null;
  adx: number | null;
  way: Way;
  /** 0..1 — the share of this frame's own sub-votes that agreed. Scales its weight. */
  conviction: number;
};

export type Ladder = {
  rows: LadderRow[];
  tiers: Partial<Record<Tier, Way>>;
  score: number;
  /** −1..+1, the weighted read divided by the weight that voted. */
  normalised: number;
  bias: Way;
  alignment: number;
  text: string;
  /** Frames disagreeing with `bias`. Never hidden. */
  against: string[];
};

export type Readiness = {
  ready: boolean;
  side: 'UP' | 'DOWN' | null;
  blockers: string[];
};

export type PathRow = {
  label: string;
  minutes: number;
  interpolated: boolean;
  windows: number;
  medianUsd: number;
  p68Usd: number;
  p95Usd: number;
  low68: number;
  high68: number;
  low95: number;
  high95: number;
  impliedUsd: number | null;
  pUp: number;
  leanUsd: number;
};

export type ExpiryPath = {
  spot: number;
  hoursToExpiry: number;
  rows: PathRow[];
  settlement: PathRow | null;
  /** The largest |pUp − 50| anywhere in the measured table, in percentage points. */
  directionEdgePct: number;
  sampleWindows: number;
  sampleDays: number;
  watch: 'UPPER' | 'LOWER' | 'BOTH';
  note: string;
};

export type MomentumPlan = {
  entry: number;
  stop: number;
  target: number;
  rr: number;
  riskPts: number;
  rewardPts: number;
  policy: string;
};

export type Measured = {
  policy: string;
  tf: string;
  n: number;
  hitRate: number;
  netR: number;
  avgR: number;
  outOfSample: { year: string; n: number; hitRate: number; netR: number } | null;
  from: string;
  to: string;
};

export type MomentumSignal = {
  state: 'COILED' | 'CONFIRMED' | 'NONE';
  tf: string | null;
  side: 'UP' | 'DOWN' | null;
  level: number | null;
  levelLow?: number | null;
  atr: number | null;
  at: number | null;
  plan: MomentumPlan | null;
  measured: Measured | null;
  /** A call the replay never showed a profit for may be displayed, but not as a trade. */
  verdict: 'TRADEABLE' | 'INFORMATIONAL';
  compression: number | null;
  headline: string;
  warnings: string[];
};

export type StrikeSafety = {
  strike: number;
  cp: 'C' | 'P';
  distanceUsd: number;
  distanceInP95: number | null;
  pExpireWorthless: number | null;
  pTouch: number | null;
  outsideMeasured95: boolean;
  why: string;
};

export type LiveResponse = {
  asOf: number;
  spot: number;
  ladder: Ladder;
  readiness: Readiness;
  path: ExpiryPath | null;
  momentum: MomentumSignal;
  weights: { tier: Tier; weight: number }[];
  missing: string[];
  expiry: string;
  expiryTs: number;
  hoursToExpiry: number;
  atmIv: number | null;
  atm: number;
  strikes: StrikeSafety[];
};

