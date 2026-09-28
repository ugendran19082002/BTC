

/** What a timeframe is *for*. The tier sets the weight; `execution` carries none. */
export type Tier = 'direction' | 'structure' | 'setup' | 'pattern' | 'trigger' | 'execution';

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
  /** Which level definition found these breaks — see server `domain/level-mode.ts`. */
  mode: string;
  /** That mode in words. */
  modeLabel: string;
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

export type LiveResponse = {
  asOf: number;
  /** The last traded price. */
  spot: number;
  /** Where `spot` came from. `candle-close` means the tick was unavailable and the number may be minutes old. */
  spotFrom: 'ticker' | 'candle-close';
  spotAgeMs: number | null;
  momentum: MomentumSignal;
  missing: string[];
  expiry: string;
  expiryTs: number;
  hoursToExpiry: number;
  atmIv: number | null;
  atm: number;
};

