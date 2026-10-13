/** The signal history traded as options, as `/api/signal-backtest` gives it (server: `report/signal-backtest.ts`). */

export type BtExit = 'perp-tgt' | 'perp-sl' | 'option-tgt' | 'option-sl' | 'window-end';
export type BtSkip = 'outside-window' | 'no-entry-window' | 'distance' | 'at-limit' | 'desk-limit' | 'side-limit' | 'no-board' | 'no-strike' | 'no-exit-price';
export type BacktestParams = {
  rule: 'delta' | 'premium'; value: number; lots: number; targetPct: number; stopPct: number; window: 'desk' | 'all' | 'custom';
  /** With `custom`: the signals filled from this IST time to this one, "HH:MM"; it may run past midnight. */
  hoursFrom?: string; hoursTo?: string;
  /** The desk's limits: at most this many open at once (0: none), and each side at most this per cent of it. */
  deskMax: number; cePct: number; pePct: number;
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
  strategies: { id: string; name: string; enabled: boolean; account: string | null; methods: string[]; tfs: string[] }[];
  /** Each trading account's limits as they stand: offered as one tap. */
  deskLimits: { account: string; max: number; ce: number; pe: number }[];
  signals: number; skipped: Record<BtSkip, number>;
  total: BtTot;
  days: (BtTot & { day: string; pattern: string | null; live: boolean })[];
  pairs: BtRow[]; byTf: BtRow[]; byMethod: BtRow[]; byPattern: BtRow[]; byFamily: BtRow[];
  choices: { timeframes: { key: string; name: string }[]; methods: { key: string; name: string; n: number; wins: number; net: number }[] };
};
export type BacktestQuery = { from: string; to: string; params: BacktestParams; tfs: readonly string[]; methods: readonly string[]; strategy?: string | null };
