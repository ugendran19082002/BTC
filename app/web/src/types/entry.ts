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
  /** Reward to TP1 over risk, after taker fees both ways. */
  rr: number;
};

export type MethodRead = {
  id: string;
  n: number;
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
  triggerAt: number; firstSeen: number; lastSeen: number; score: number | null; reason: string;
  entryLo: number | null; entryHi: number | null; stop: number | null; tp1: number | null; rr: number | null;
  gatesOff: string[];
  /** The market when it was first seen: the perpetual's last trade, Delta's BTC index. */
  ltp: number | null; indexPrice: number | null;
  outcome: { status: string; fillPrice: number | null; exitPrice: number | null; exitAt: number | null; rNet: number | null } | null;
};

/** Over every signal matching the filters: TP1 hits and points made, stops and points lost, the net. */
export type EntrySignalSummary = {
  trades: number; tp1: number; tp1Pts: number; stops: number; slPts: number; timeouts: number;
  netPts: number; netR: number; open: number;
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
