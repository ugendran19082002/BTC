/**
 * The entry section's shapes, mirroring app/server/src/entry/types.ts: twelve
 * entry methods, each read with the timeframe chain and without it.
 */

export type EntryTf = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '4h';
export type EntryMode = 'mtf' | 'single';
export type EntryState = 'TRADE' | 'WAIT' | 'NO_TRADE';

export type EntryStep = { tf: EntryTf | null; label: string; ok: boolean | null };
/** A hard gate: its rule, what was read, the verdict. `ok` null: not read, or not part of this mode -- refuses nothing, never "passed". */
export type EntryGate = {
  key: string; label: string; rule: string; value: string | null; ok: boolean | null; why: string | null;
  /** Switched on. Off: still read and shown, but it refuses nothing. */
  enabled: boolean;
};
/** Telegram alerts for one way's TRADEs. */
export type EntryAlertSetting = {
  mode: EntryMode; enabled: boolean; changedAt: number | null;
  /** Timeframes it alerts on: without the chain the owner's pick (5m by default); with it, 5m. */
  tfs: EntryTf[];
};
/** One alert the server tried to send, and what became of it. */
export type EntryAlertLog = {
  at: number; mode: EntryMode; tf: EntryTf; method: string; n: number | null; name: string; dir: 1 | -1;
  status: 'sent' | 'failed'; error: string | null;
};
export type EntryAlerts = { alerts: EntryAlertSetting[]; telegram: boolean; recent?: EntryAlertLog[] };

/** A gate's switch, as the settings list shows it. `locked`: why it cannot be switched off. */
export type EntryGateSetting = { key: string; label: string; enabled: boolean; locked: string | null; changedAt: number | null };
export type EntryPlan = {
  entryLo: number; entryHi: number; stop: number;
  tp1: number; tp2: number | null; tp3: number | null;
  tpWhy: string[];
  /** Why the stop and each target are where they are, in words (the method's own SL/TP rule). */
  why?: { stop: string; tp1: string; tp2: string | null; tp3: string | null };
  /** Reward to TP1 over risk, in points from the fill edge. */
  rr: number;
};

export type MethodRead = {
  id: string;
  n: number;
  /** The label on the screen: the number, lettered when shared (16a, 16b, 16c). */
  code: string;
  name: string;
  group: 'breakout' | 'pullback' | 'reversal' | 'flow';
  /** What the method looks for, in one line. */
  summary: string;
  mode: EntryMode;
  tf: EntryTf;
  dir: 'long' | 'short' | null;
  state: EntryState;
  steps: EntryStep[];
  gates: EntryGate[];
  /** Only on TRADE. */
  plan: EntryPlan | null;
  /** Setup quality 0-100. Not a probability. */
  score: number | null;
  scoreParts: { name: string; max: number; got: number | null }[];
  alignment: number | null;
  reason: string;
  triggerTime: number | null;
  /** A TRADE's state and clock in the paper log (board only); null until the recorder writes it, within the minute. */
  paper?: SetupClock | null;
};

/** One timeframe of the chain: its trend and what its last swings did. */
export type TimeframeRow = {
  tf: EntryTf;
  role: string;
  trend: -1 | 0 | 1;
  label: 'Bullish' | 'Bearish' | 'Neutral' | 'Not read';
  structure: string;
};

export type EntryBoard = {
  at: number;
  tf: EntryTf;
  reads: MethodRead[];
  /** The without panel's timeframe is chart-only (1m): no reads without the chain. */
  viewOnly?: boolean;
  /** Delta's mark price and BTC index for the perpetual (epoch ms): the fair-price check, and context. */
  quote?: { mark: number | null; index: number | null; at: number } | null;
  chain: { tf: EntryTf; role: string; weight: number }[];
  timeframes: TimeframeRow[];
  /** The perpetual's last trade when the board was read (the server's tape); null with the socket down. */
  ltp?: { price: number; at: number } | null;
};

export type EntryRecord = {
  method: string; mode: EntryMode; tf: EntryTf;
  setups: number; trades: number; wins: number; expired: number; working: number;
  avgR: number | null; sumR: number | null;
  profitFactor: number | null; maxDrawdownR: number | null;
  avgWinR: number | null; avgLossR: number | null;
  since: number | null;
  /** Setups logged while a gate was switched off: kept apart, in none of the figures. */
  gatesOff?: number;
  /** Points made at TP1, lost at the stop, and the net -- from the fill to the exit. */
  tgtPts?: number; slPts?: number; netPts?: number;
};

/** `totals`: every gate on (the rules). `totalsAll`: gate-off setups included -- shown apart, labelled. */
export type EntryRecordResponse = { records: EntryRecord[]; totals: EntryRecord[]; totalsAll?: EntryRecord[]; recent: unknown[] };

/** One signal from the server's journal, with what became of it if it was a TRADE. */
export type EntrySignal = {
  method: string; n: number | null; name: string; mode: EntryMode; tf: EntryTf; dir: 1 | -1; state: 'WAIT' | 'TRADE';
  /** The method's screen label, lettered when its number is shared (16a). */
  code?: string | null;
  triggerAt: number; firstSeen: number; lastSeen: number; score: number | null; reason: string;
  entryLo: number | null; entryHi: number | null; stop: number | null; tp1: number | null; rr: number | null;
  gatesOff: string[];
  /** The market when it was first seen: the perpetual's last trade, Delta's BTC index. */
  ltp: number | null; indexPrice: number | null;
  outcome: EntrySignalOutcome | null;
  /** The rest of the plan, and why each level is where it is (null on rows from before 1 Oct 2026). */
  tp2: number | null; tp3: number | null;
  why: { stop: string | null; tp1: string | null; tp2: string | null; tp3: string | null } | null;
  /** When the trigger bar closed (epoch s), and how long after it the server first saw the signal (ms). */
  barCloseAt: number; seenAfterMs: number;
  /** The Telegram alert, if one was tried: when (epoch ms) and whether it went. */
  alert: { at: number; status: 'sent' | 'failed' } | null;
};

/** What became of a TRADE in the paper log, with its times (epoch s) and how the fill and exit stood against the plan. */
export type EntrySignalOutcome = {
  status: string; fillPrice: number | null; exitPrice: number | null; exitAt: number | null; rNet: number | null;
  filledAt: number | null; fillBy: number; timeoutAt: number | null;
  /** The zone's near edge, where a resting limit fills; + points means the fill was better (opened inside the zone). */
  fillEdge: number; fillBetterPts: number | null;
  /** The level the exit aimed at (SL or TP1), points past it against the trade, and why: at the level, a gap, or time. */
  exitLevel: number | null; exitPastPts: number | null; exitWhy: 'level' | 'gap' | 'time' | null;
  /** TGT1 / TGT2 / TGT3: when each was reached (epoch s); the runner after TGT1, its stop at breakeven. */
  tp1At: number | null; tp2At: number | null; tp3At: number | null;
  runner: 'running' | 'done' | null; runnerEnd: 'be' | 'tp2' | 'tp3' | 'timeout' | null;
  /** Why an expired setup was never filled: its window passed, the stop came first, or price ran to TGT1 without it. */
  expireWhy: ExpireWhy | null;
};

/** Why a setup expired -- never filled. */
export type ExpireWhy = 'window' | 'stop' | 'target';

/**
 * A setup's clock in the paper log: seen (ms), may fill until `fillBy`, filled
 * in the 1m bar at `filledAt`, times out at `timeoutAt`, out at `exitAt` (epoch
 * s), and when its Telegram alert was tried (ms).
 */
export type SetupClock = {
  status: string; firstSeen: number; fillBy: number; filledAt: number | null; fillPrice: number | null;
  timeoutAt: number | null; exitAt: number | null; exitPrice: number | null; alertAt: number | null;
  tp1At: number | null; tp2At: number | null; tp3At: number | null;
  runner: 'running' | 'done' | null; runnerEnd: 'be' | 'tp2' | 'tp3' | 'timeout' | null;
  expireWhy: ExpireWhy | null;
};

/** Over every signal matching the filters: TP1 hits and points made, stops and points lost, the net. */
export type EntrySignalSummary = {
  trades: number; tp1: number; tp1Pts: number; stops: number; slPts: number; timeouts: number;
  timeoutPts: number;
  /** Target pts − SL pts + time-out pts, exactly (each trade to the whole point). */
  netPts: number; open: number;
  /** How many runners went on to reach TGT2, and TGT3. */
  tp2: number; tp3: number;
};
export type EntrySignalPage = { signals: EntrySignal[]; total: number; summary: EntrySignalSummary };

/** What the price chart draws for the chosen setup. */
export type EntryOverlay = {
  dir: 'long' | 'short';
  entryLo: number; entryHi: number; stop: number;
  tp1: number; tp2: number | null; tp3: number | null;
  rr: number;
  label: string;
  triggerTime: number | null;
};

/** One method's line in the Methods report: its signals, and how its closed paper trades went. */
export type MethodReportRow = {
  n: number | null; method: string; name: string;
  signals: number; trades: number; wins: number; losses: number;
  /** Wins over trades, 0-100; null with no trade yet. */
  winPct: number | null;
  /** Points from the fill to the exit, in the trade's favour: won, lost (positive), and the net. */
  profitPts: number; lossPts: number; netPts: number;
  /** The same in R (points over the risk to the stop). No fees. */
  profitR: number; lossR: number; netR: number;
};
export type MethodReportSection = {
  mode: EntryMode; label: string; rows: MethodReportRow[]; total: MethodReportRow;
  /** Of the signals counted, how many were taken with a hard gate switched off. */
  gatesOffSignals: number;
};
export type MethodReportResponse = {
  tf: EntryTf | null; everyGate?: boolean; sections: MethodReportSection[];
  /** The IST days the signals were first seen on, when a range was asked for. */
  from?: string | null; to?: string | null;
  /** Without the chain, one section per timeframe (3m-4h): the report's timeframe tabs. */
  singleByTf: Partial<Record<EntryTf, MethodReportSection>>;
};
