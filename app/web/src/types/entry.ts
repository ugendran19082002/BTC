/**
 * The entry section's shapes, mirroring app/server/src/entry/types.ts: twelve
 * entry methods, each read with the timeframe chain and without it.
 */

export type EntryTf = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '4h';
export type EntryMode = 'mtf' | 'single';
export type EntryState = 'TRADE' | 'WAIT' | 'NO_TRADE';

export type EntryStep = { tf: EntryTf | null; label: string; ok: boolean | null };
export type EntryGate = { key: string; label: string; ok: boolean; why: string | null };
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

export type EntryBoard = {
  at: number;
  tf: EntryTf;
  reads: MethodRead[];
  chain: { tf: EntryTf; role: string; weight: number }[];
};

export type EntryRecord = {
  method: string; mode: EntryMode; tf: EntryTf;
  setups: number; trades: number; wins: number; expired: number; working: number;
  avgR: number | null; sumR: number | null; since: number | null;
};

/** What the price chart draws for the chosen setup. */
export type EntryOverlay = {
  dir: 'long' | 'short';
  entryLo: number; entryHi: number; stop: number;
  tp1: number; tp2: number | null; tp3: number | null;
  rr: number;
  label: string;
  triggerTime: number | null;
};
