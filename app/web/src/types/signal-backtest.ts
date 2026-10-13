/** The signal history traded as options, as `/api/signal-backtest` gives it (server: `report/signal-backtest.ts`). */

export type BtExit = 'perp-tgt' | 'perp-sl' | 'option-tgt' | 'option-sl' | 'window-end';
export type BtSkip = 'outside-window' | 'no-entry-window' | 'distance' | 'volatility' | 'at-limit' | 'desk-limit' | 'side-limit' | 'no-board' | 'no-strike' | 'no-exit-price';
export type BacktestParams = {
  rule: 'delta' | 'premium'; value: number; lots: number; targetPct: number; stopPct: number; window: 'desk' | 'all' | 'custom';
  /** With `custom`: the signals filled from this IST time to this one, "HH:MM"; it may run past midnight. */
  hoursFrom?: string; hoursTo?: string;
  /** The desk's limits: at most this many open at once (0: none), and each side at most this per cent of it. */
  deskMax: number; cePct: number; pePct: number;
  /** A signal only if its SL and TGT are in range: BTC points from the perp entry, minimum and maximum, 0 off. */
  slMin?: number; slMax?: number; tgtMin?: number; tgtMax?: number;
  /** A target by the clock: `targetPct` to begin with, then each step's share of the premium kept from its IST time. Absent or empty: fixed. */
  targetSteps?: { at: string; pct: number }[];
  /** Only signals that filled while the market was this volatile; `off` or absent, all. */
  vol?: 'off' | 'low' | 'medium' | 'high';
};

/** Backtested trades: dollars after charges, the same trades' perp points, and each exit with how many of its trades made money. */
export type BtTot = {
  n: number; wins: number; losses: number; net: number; won: number; lost: number; perpPts: number;
  /** The exchange's fees and GST on every fill, dollars: `net` is after them. */
  charges: number;
  exits: Partial<Record<BtExit, { n: number; wins: number; net: number }>>;
};
export type BtRow = BtTot & { key: string; name: string; tf?: string; days?: number };
export type SignalBacktestResponse = {
  from: string; to: string; params: BacktestParams;
  /** The strategy backtested, what of it could not be replayed, and what its real orders made in the range. Null: the screen's own settings. */
  strategy: { id: string; name: string; accountId: number | null; caveats: string[]; real: { n: number; wins: number; open: number; net: number } } | null;
  /** The signal strategies there are to backtest by: those that sell. */
  strategies: { id: string; name: string; enabled: boolean; account: string | null; methods: string[]; tfs: string[]; target?: { pct: number; steps: { at: string; pct: number }[] } | null }[];
  /** The margin the trades shown would have held, by the desk's 200x estimate. */
  margin: { peakUsd: number; peakDay: string | null; peakAt: number | null; peakOpen: number; avgDailyPeakUsd: number; avgTradeUsd: number };
  /** Each trading account's limits as they stand: offered as one tap. */
  deskLimits: { account: string; max: number; ce: number; pe: number }[];
  signals: number; skipped: Record<BtSkip, number>;
  total: BtTot;
  days: (BtTot & { day: string; pattern: string | null; live: boolean })[];
  pairs: BtRow[]; byTf: BtRow[]; byMethod: BtRow[]; byPattern: BtRow[]; byFamily: BtRow[];
  /** By the volatility when each signal filled: low, medium, high. An older server sends none. */
  byVol?: BtRow[];
  choices: { timeframes: { key: string; name: string }[]; methods: { key: string; name: string; n: number; wins: number; net: number }[] };
};
export type BacktestQuery = { from: string; to: string; params: BacktestParams; tfs: readonly string[]; methods: readonly string[]; strategy?: string | null };
