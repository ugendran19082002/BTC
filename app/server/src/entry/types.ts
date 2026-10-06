import type { Candle } from '../market/delta.js';
import type { HeatMinute } from '../market/book-heat.js';
import type { DerivHistory } from './deriv.js';

/**
 * The shapes of the entry engine (docs/features/entry-setups.md).
 *
 * Twelve entry methods, each read two ways: with the timeframe chain (4H/1H
 * context, 30m/15m setup, 5m entry, 3m confirmation, 1m execution) and
 * without it (the chart's own timeframe alone). Each read ends in one of three
 * states, and only TRADE carries an entry, a stop and targets.
 */

export type Tf = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h';
export const TF_SEC: Record<Tf, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1_800, '1h': 3_600, '2h': 7_200, '4h': 14_400,
};
/** The chain, coarsest first, with each timeframe's job and its weight in the alignment figure (TEST.md). */
export const CHAIN: readonly { tf: Tf; role: string; weight: number }[] = [
  { tf: '4h', role: 'macro context', weight: 5 },
  { tf: '1h', role: 'major structure', weight: 10 },
  { tf: '30m', role: 'regime', weight: 10 },
  { tf: '15m', role: 'setup', weight: 15 },
  { tf: '5m', role: 'entry', weight: 30 },
  { tf: '3m', role: 'confirmation', weight: 15 },
  { tf: '1m', role: 'execution', weight: 15 },
];

/** Closed candles per timeframe. A forming bar is never in here. */
export type Frames = Partial<Record<Tf, readonly Candle[]>>;

export type Mode = 'mtf' | 'single';
export type EntryState = 'TRADE' | 'WAIT' | 'NO_TRADE';
export type Group = 'breakout' | 'pullback' | 'reversal' | 'flow';

/** A method's id: the twelve's ('breakout', 'liquidity-sweep', ...) and the rest's (methods.ts). */
export type MethodId = string;

/** A method's order side in the owner's list (5 Oct 2026). A label on the method: no read, signal or order follows it. */
export type MethodOrderSide = 'BUY' | 'SELL';

/** One step of a chain. `ok` null: could not be read (no data), which never counts as confirmed. */
export type Step = { tf: Tf | null; label: string; ok: boolean | null };

/**
 * A hard gate, as the checklist shows it: its rule, what was read, and the
 * verdict. `ok` null: not read (no option board, no spread) or not part of
 * this mode (the HTF gate without the chain) -- it refuses nothing, and never
 * reads as passed.
 */
export type Gate = {
  key: string; label: string; rule: string; value: string | null; ok: boolean | null; why: string | null;
  /** Switched on (entry/gates.ts). Off: still read and shown, but it refuses nothing. */
  enabled: boolean;
};

export type Plan = {
  entryLo: number;
  entryHi: number;
  stop: number;
  tp1: number;
  tp2: number | null;
  tp3: number | null;
  /** Where each target came from: "swing high 84,300", "call wall 85,000", "2R". */
  tpWhy: string[];
  /** Reward to TP1 over risk, from the fill edge of the entry zone, in points (no fee term). */
  rr: number;
  /**
   * Why each level is where it is, in words: the stop's structure and buffer
   * ("sweep extreme 83,488 − 0.25 ATR"), and each target's level. Always set by
   * the engine; absent only on hand-made plans.
   */
  why?: { stop: string; tp1: string; tp2: string | null; tp3: string | null };
};

export type ScorePart = { name: string; max: number; got: number | null };

export type MethodRead = {
  id: MethodId;
  n: number;
  /** The label on the screen: the number, lettered when shared (16a, 16b, 16c). */
  code: string;
  name: string;
  group: Group;
  /** What the method looks for, in one line. */
  summary: string;
  mode: Mode;
  /** The timeframe the entry is read on: 5m with the chain, the chart's own without it. */
  tf: Tf;
  dir: 'long' | 'short' | null;
  state: EntryState;
  /** The method's own chain, then (with the chain) each timeframe's check. */
  steps: Step[];
  gates: Gate[];
  plan: Plan | null;
  /** Setup quality 0-100 -- not a probability, and never shown as one. */
  score: number | null;
  scoreParts: ScorePart[];
  /** With the chain: how much of the TEST.md timeframe weight agrees, 0-100. */
  alignment: number | null;
  /** One line: what it is, what it waits for, or why not. */
  reason: string;
  /** The primary bar the trigger closed on (epoch s): with method, mode and direction, the setup's identity. */
  triggerTime: number | null;
  /** The market the signal formed in (methods.ts regimeOf), on a TRADE or WAIT: kept with it for the record's R&D. */
  regime?: import('./methods.js').Regime | null;
  /** A TRADE's state and clock in the paper log, on the board only (signals.ts setupClocks); absent until it is written. */
  paper?: SetupClock | null;
};

/**
 * A setup's clock in the paper log: seen (ms), may fill until `fillBy`, filled
 * in the 1m bar at `filledAt`, times out at `timeoutAt`, out at `exitAt` (all
 * epoch s), and when its Telegram alert was tried (ms).
 */
export type SetupClock = {
  status: string; firstSeen: number; fillBy: number; filledAt: number | null; fillPrice: number | null;
  timeoutAt: number | null; exitAt: number | null; exitPrice: number | null; alertAt: number | null;
  /** When TGT1 / TGT2 / TGT3 were reached (epoch s), and the runner after TP1 (stop at breakeven). */
  tp1At: number | null; tp2At: number | null; tp3At: number | null;
  runner: 'running' | 'done' | null; runnerEnd: 'be' | 'tp2' | 'tp3' | 'timeout' | null;
  /** Why an expired setup was never filled. */
  expireWhy: 'window' | 'stop' | 'target' | null;
};

/** One minute of the perpetual's tape, by aggressor side. */
export type FlowMinute = { time: number; buy: number; sell: number; largeBuy: number; largeSell: number };

/** What the market around the chart says, read once per board. */
export type EntryContext = {
  now: number;
  frames: Frames;
  /** True when the candles that closed this minute were taken early, checked against the desk's own tape (read.ts). */
  closeVerified?: boolean;
  /** The last few hours of the perpetual's tape, per minute; empty when not recorded. */
  flow: readonly FlowMinute[];
  /** Persistent resting walls in the perpetual's book. */
  walls: readonly { side: 'bid' | 'ask'; price: number; size: number }[];
  /** The perpetual's touch: spread as a percentage of price. Null when unread. */
  spreadPct: number | null;
  /** The option board, when it could be read. */
  options: {
    spot: number;
    atmIv: number | null;
    /** Expected move over the next day, in dollars. */
    emDay: number | null;
    callWall: number | null;
    putWall: number | null;
    maxPain: number | null;
    /** Seconds to the daily settlement (17:30 IST). */
    toSettleSec: number | null;
  } | null;
  /** The desk's big-move reading over the next hour. */
  bigMove: { band: 'normal' | 'watch' | 'high' | 'sudden'; direction: number | null } | null;
  /** Hard gates the owner switched off (entry/gates.ts): read and shown, refusing nothing. Absent: all on. */
  gatesOff?: readonly string[];
  /** The perpetual's last trade, from the tape (epoch ms): the live price for the execution step. Null with the socket down. */
  ltp?: { price: number; at: number } | null;
  /**
   * Delta's mark price and BTC index for the perpetual, from its ticker (epoch ms). The perpetual
   * is the price of entry, SL and TP; the mark is the fair-price check (a last trade far from it is
   * a wick through a thin book, not a level); the index is context -- basis and divergence.
   */
  quote?: { mark: number | null; index: number | null; at: number; funding?: number | null } | null;
  /*
   * What the methods past the twelve read beyond the twelve's inputs (1 Oct 2026). Each optional and best-effort:
   * absent or null, a method that needs it says nothing.
   */
  /** The recorded derivatives history: the perpetual each five minutes, the option board now and an hour ago, ATM IV. */
  deriv?: DerivHistory | null;
  /** The perpetual's book now: the touch, the top five levels' sizes each side, and its imbalance. */
  book?: { at: number; bestBid: number | null; bestAsk: number | null; top5Bid: number; top5Ask: number; imbalance: number | null } | null;
  /** The book's resting size by price, per minute, the last two hours. */
  heat?: readonly HeatMinute[];
  /** The perpetual's trades of the last half hour, oldest first. */
  prints?: readonly { at: number; price: number; size: number; side: 'buy' | 'sell' }[];
  /** ETHUSD 5m candles, closed: the other market. */
  eth?: readonly Candle[];
};
