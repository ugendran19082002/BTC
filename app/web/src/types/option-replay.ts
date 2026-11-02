/**
 * The option history's answer (GET /api/report/option-replay): the signal options the desk really sold, each one's
 * exit worked again on its own contract's recorded quotes under the rules asked for, beside what it really did.
 * Mirrors app/server/src/report/option-replay.ts. Money in USD, after charges.
 */
export type ReplayRules = { skipPerpSl: boolean; skipPerpTgt: boolean; stopPct: number; targetPct: number };
export type ReplayExit = 'option-sl' | 'option-tgt' | 'perp-sl' | 'perp-tgt' | 'close';
export type ActualExit = 'option-tgt' | 'option-sl' | 'desk' | 'other';
export type ReplayLeg = { exitAt: number | null; exit: number | null; netUsd: number };
export type OptionReplayRow = {
  tradeId: string; day: string; account: number | null;
  strategyId: string | null; strategyName: string | null;
  method: string; methodName: string; tf: string; side: 'CE' | 'PE'; symbol: string;
  enteredAt: number; entry: number; contracts: number;
  perpSl: number | null; perpTgt: number | null;
  actual: ReplayLeg & { why: ActualExit };
  replay: ReplayLeg & { why: ReplayExit };
};
export type ReplaySide = { trades: number; wins: number; losses: number; profitUsd: number; lossUsd: number; netUsd: number };
export type ReplayGroup = { key: string; name: string; trades: number; actual: ReplaySide; replay: ReplaySide };
export type OptionReplay = {
  from: string; to: string; rules: ReplayRules;
  /** Every trade counted as one contract (`?size=one`); false, at the size traded. */
  oneContract: boolean;
  actual: ReplaySide; replay: ReplaySide;
  exits: Record<ReplayExit, number>;
  open: number; noPrices: number;
  days: ReplayGroup[]; timeframes: ReplayGroup[]; methods: ReplayGroup[]; accounts: ReplayGroup[];
  rows: OptionReplayRow[]; rowsCut: boolean;
};
