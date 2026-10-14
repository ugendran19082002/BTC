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
  /** An option is not sold for less than this many dollars; 0 is no floor. Absent: the desk's own 10. */
  minPremium?: number;
};

/** Backtested trades: dollars after charges, the same trades' perp points, and each exit with how many of its trades made money. */
export type BtTot = {
  n: number; wins: number; losses: number; net: number; won: number; lost: number; perpPts: number;
  /** The exchange's fees and GST on every fill, dollars: `net` is after them. */
  charges: number;
  exits: Partial<Record<BtExit, { n: number; wins: number; net: number }>>;
};
/** What a day's options were priced on: the desk's own one-minute record, Delta's one-minute mark with the desk's spread, or the five-minute record alone. */
export type BoardGrain = 'own-1m' | 'mark-1m' | '5m';
export type BtRow = BtTot & { key: string; name: string; tf?: string; days?: number };
export type SignalBacktestResponse = {
  from: string; to: string; params: BacktestParams;
  /** The strategy backtested, what of it could not be replayed, and what its real orders made in the range. Null: the screen's own settings. */
  strategy: { id: string; name: string; accountId: number | null; caveats: string[]; real: { n: number; wins: number; open: number; net: number } } | null;
  /** The signal strategies there are to backtest by: those that sell. */
  strategies: { id: string; name: string; enabled: boolean; account: string | null; methods: string[]; tfs: string[]; target?: { pct: number; steps: { at: string; pct: number }[] } | null }[];
  /** The margin the trades shown would have held, by the desk's 200x estimate. */
  margin: { peakUsd: number; peakDay: string | null; peakAt: number | null; peakOpen: number; /** The lots open at that moment, together. An older server sends none. */ peakLots?: number; avgDailyPeakUsd: number; avgTradeUsd: number };
  /** Each trading account's limits as they stand: offered as one tap. */
  deskLimits: { account: string; max: number; ce: number; pe: number }[];
  signals: number; skipped: Record<BtSkip, number>;
  total: BtTot;
  days: (BtTot & { day: string; pattern: string | null; live: boolean; grain?: BoardGrain })[];
  /** Expiry days by what their options were priced on. An older server sends none. */
  priced?: Record<BoardGrain, number>;
  pairs: BtRow[]; byTf: BtRow[]; byMethod: BtRow[]; byPattern: BtRow[]; byFamily: BtRow[];
  /** By the volatility when each signal filled: low, medium, high. An older server sends none. */
  byVol?: BtRow[];
  choices: { timeframes: { key: string; name: string }[]; methods: { key: string; name: string; n: number; wins: number; net: number }[] };
};
export type BacktestQuery = { from: string; to: string; params: BacktestParams; tfs: readonly string[]; methods: readonly string[]; strategy?: string | null };

/**
 * Every method's record as options under one strategy's rules as they stand on its form (`POST
 * /api/signal-backtest/methods`): each method on all its signals in the strategy's way and timeframes, sold and
 * bought back as the strategy would, in dollars after charges.
 */
export type MethodOptionRecord = {
  from: string; to: string;
  priced?: Record<BoardGrain, number>;
  /** What of the strategy could not be replayed, in words. */
  caveats: string[];
  signals: number; trades: number;
  methods: { method: string; trades: number; wins: number; net: number; byTf: { tf: string; trades: number; wins: number; net: number }[] }[];
};

/** What a saved backtest asks: the screen's own settings and filters. `strategy` is a saved strategy's id, or null. */
export type SavedQuery = { params: BacktestParams; tfs: string[]; methods: string[]; strategy: string | null };
export type BacktestSave = { id: string; name: string; query: SavedQuery; createdAt: number; updatedAt: number };
/** A name, and the saved backtests run together under it, in order. */
export type BacktestPortfolio = { id: string; name: string; saveIds: string[]; createdAt: number; updatedAt: number };
export type BacktestSaves = { saves: BacktestSave[]; portfolios: BacktestPortfolio[] };
/** Several saved backtests over the same days: each as it is alone, and their total. */
export type BacktestPortfolioResult = {
  from: string; to: string;
  /**
   * The one limit they were traded under together, as one account -- at most `max` open across all of them, `ce`
   * calls and `pe` puts -- and how many signals found it full. Null: each kept its own limit and they were added up.
   */
  shared?: { max: number; ce: number; pe: number; cePct: number; pePct: number; turnedAway: number } | null;
  /**
   * The hours the run was held to, over every member worked by settings; `own` names the members a strategy works,
   * which kept that strategy's hours. Null or absent: each as it was saved.
   */
  hours?: { window: BacktestParams['window']; hoursFrom?: string; hoursTo?: string; own: string[] } | null;
  /**
   * The settings put over the run -- only those switched on -- as the server read them; `own` as for the hours.
   * Null or absent: none, each as it was saved. A target put over it carries `targetSteps` ([] where it is fixed).
   */
  over?: { settings: Partial<BacktestParams>; own: string[] } | null;
  members: { id: string; name: string; problem: string | null; signals: number; total: BtTot; marginPeakUsd: number; priced: Record<BoardGrain, number> | null }[];
  total: BtTot;
  days: { day: string; live: boolean; n: number; wins: number; net: number; charges: number; byMember: number[] }[];
  /** The most held at once across all of them, laid on one clock; and the sum of each one's own most, which it never exceeds. */
  margin: { peakUsd: number; peakDay: string | null; peakAt: number | null; peakOpen: number; /** The lots open at that moment, together. An older server sends none. */ peakLots?: number; avgDailyPeakUsd: number; sumOfPeaksUsd: number };
};

/** Signals on one side only -- an order on the desk with no trade in the backtest, or the other way -- by why, with the first few. */
export type LiveCheckWhy = { why: string; n: number; first: { at: number; method: string; tf: string; dir: 1 | -1 }[] };
export type LiveCheckCount = { why: string; n: number };
/** One strategy: what the desk did with the signals of its methods, and what the backtest of its own rules does with the same. */
export type LiveCheckRow = {
  id: string; name: string; account: string | null;
  live: { placed: number; refused: number; skipped: number };
  /** The other side's fate of the signals, and the backtest's. */
  fate: { live: LiveCheckFate; backtest: LiveCheckFate };
  liveWhy: { refused: LiveCheckCount[]; skipped: LiveCheckCount[] };
  backtest: number;
  backtestSkipped: LiveCheckCount[];
  same: number;
  backtestOnly: LiveCheckWhy[]; liveOnly: LiveCheckWhy[];
};
/** What became of the signals on one side: taken, still waiting, and the kinds of not taken -- the last four the desk's alone. */
export type LiveCheckFate = { taken: number; waiting: number; notTaken: number; skipped: number; refused: number; rejected: number; expired: number; cancelled: number };
/** Trades counted with their money, as a day's row reads them: how many, how many made money, the net after charges (USD). */
export type LiveCheckMoney = { n: number; wins: number; net: number };
/** The backtest against the live desk, signal for signal (`/api/signal-backtest/live-check`, `/api/backtest-portfolio/live-check`). */
export type LiveCheck = {
  from: string; to: string;
  liveFrom: number | null; liveTo: number | null; until: number;
  /** What is on the backtest's side: each strategy by its own rules, or saved backtests / the screen's settings by name. */
  against: { kind: 'strategies' } | { kind: 'portfolio'; name: string };
  /** A row a strategy, or a saved backtest. */
  strategies: LiveCheckRow[];
  total: { placed: number; refused: number; skipped: number; backtest: number; backtestSkipped: number; same: number; backtestOnly: number; liveOnly: number };
  /** Against saved backtests: the desk's orders none of them trades, by why. A strategy's own are on its row. */
  liveOnly: LiveCheckWhy[];
  liveWhy: { refused: LiveCheckCount[]; skipped: LiveCheckCount[] };
  /** What is set apart and not compared: the backtest's trades of signals the desk has no record of, the desk's orders outside the rules as they stand. */
  notCompared: { backtest: number; desk: number };
  notComparedWhy: { backtest: LiveCheckWhy[]; desk: LiveCheckWhy[] };
  /** The backtest's money, and -- against settings or saved backtests -- the live rules' with them. Null on the desk's side: decisions, not finished orders. */
  money: { real: LiveCheckMoney | null; backtest: LiveCheckMoney };
  /** Each expiry day: the other side's takes and the backtest's trades, how many are the same signal, and the money where it is a replay. */
  days: { day: string; live: boolean; placed: number; backtest: number; same: number; real: LiveCheckMoney | null; bt: LiveCheckMoney; fate: { live: LiveCheckFate; backtest: LiveCheckFate } }[];
  /** The fates over the whole range. */
  fate: { live: LiveCheckFate; backtest: LiveCheckFate };
};
