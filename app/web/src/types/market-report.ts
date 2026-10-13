/** The market report as `/api/market-report` gives it (server: `report/market-day.ts`, `report/market-report.ts`). */

export type PatternFamily = 'up' | 'down' | 'range' | 'turn';
export type ExitKey = 'perp-tgt' | 'perp-sl' | 'option-tgt' | 'option-sl' | 'timeout' | 'window-end' | 'manual';

export type DayStats = {
  bars: number;
  open: number; close: number; high: number; low: number; highAt: number; lowAt: number;
  rangePts: number; rangePct: number; netPts: number; netPct: number; upPts: number; downPts: number;
  dirShare: number; efficiency: number;
  atr: number; atrPct: number; atrPercentile: number | null; volExpansion: number | null;
  candleExpansion: number;
  bigCandle: { at: number; pts: number; shareOfRange: number; pctOfPrice: number; up: boolean };
  lateVsEarly: number;
  zigzag: { thresholdPts: number; swings: number; totalPts: number; avgPts: number; maxUpPts: number; maxDownPts: number; pivots: [number, number][] };
  pathRatio: number; counterShare: number;
  thirds: { netPts: number; rangeShare: number }[];
  highPos: number; lowPos: number;
  line: number[];
};

/** Trades and what they made: perp points for the signal history, dollars after charges for real orders. `open` is not in `n`. */
export type Tot = {
  n: number; wins: number; losses: number; open: number;
  net: number; won: number; lost: number; netR: number;
  exits: Partial<Record<ExitKey, { n: number; net: number }>>;
};
export type Row = Tot & { key: string; name: string; tf?: string };

export type MarketDay = {
  day: string; from: number; to: number; live: boolean; bars: number;
  stats: DayStats | null; pattern: string | null; why: string | null; family: PatternFamily | null;
  signal: Tot; real: Tot;
};
export type GroupRow = {
  key: string; name: string; meaning?: string; id?: number; days: string[];
  signal: Tot; real: Tot;
  signalEnds: { best: Row[]; worst: Row[] }; realEnds: { best: Row[]; worst: Row[] };
};
export type Choice = { key: string; name: string };
/** What a method or a strategy made, for the list it is chosen from: closed trades, how many won, the net in the record's unit. */
export type Made = { n: number; wins: number; net: number };
export type MarketReportResponse = {
  from: string; to: string;
  days: MarketDay[];
  total: { signal: Tot; real: Tot };
  ends: { signal: { best: Row[]; worst: Row[] }; real: { best: Row[]; worst: Row[] } };
  patterns: GroupRow[]; families: GroupRow[];
  catalogue: { id: number; key: string; name: string; meaning: string; family: PatternFamily }[];
  choices: { timeframes: Choice[]; methods: (Choice & { signal: Made; real: Made })[]; strategies: (Choice & Made)[] };
};
export type Side = { total: Tot; pairs: Row[]; byTf: Row[]; byMethod: Row[]; byStrategy: Row[] };
export type MarketBreakdownResponse = { days: string[]; signal: Side; real: Side };

/** What a breakdown is of: one expiry day, one kind of day, one family -- or, with none of them, the whole range. */
export type MarketScope = { day?: string; pattern?: string; family?: PatternFamily };
export type MarketQuery = { from: string; to: string; account: number | null; tfs: readonly string[]; methods: readonly string[]; strategies: readonly string[] };
