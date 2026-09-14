/** Mirrors app/server/src/trading/pnl-history.ts. */

export type DayRow = {
  /** IST calendar day, YYYY-MM-DD. */
  day: string;
  realisedUsd: number;
  chargesUsd: number;
  /** realised − charges. */
  netUsd: number;
  trades: number;
  /** Running net from the first day in the range. */
  cumulativeUsd: number;
};

export type DaysReport = {
  mode: 'live' | 'paper';
  from: string;
  to: string;
  days: DayRow[];
  totals: {
    realisedUsd: number;
    chargesUsd: number;
    netUsd: number;
    tradingDays: number;
    winDays: number;
    lossDays: number;
    best: { day: string; netUsd: number } | null;
    worst: { day: string; netUsd: number } | null;
  };
};

export type MtmSample = {
  at: number;
  day: string;
  realisedUsd: number;
  unrealisedUsd: number;
  chargesUsd: number;
  netUsd: number;
};

export type MtmReport = {
  mode: 'live' | 'paper';
  day: string;
  samples: MtmSample[];
  stats: {
    nowUsd: number | null;
    min: { at: number; netUsd: number } | null;
    max: { at: number; netUsd: number } | null;
    maxDrawdown: { usd: number; at: number } | null;
  };
  /** Days that have a line, newest first. */
  days: string[];
};
