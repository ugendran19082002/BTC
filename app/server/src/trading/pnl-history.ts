import { istDate } from '../strategy/schedule.js';
import { fillChargesUsd } from './charges.js';
import { isExit, recompute } from './machine.js';
import type { TradeRecord } from './engine.js';

/**
 * The record as a calendar, and a day as a line.
 *
 * Pure: trades and samples go in, rows come out, and nothing here reads a
 * clock or a database -- so every figure on the P&L screen can be checked by
 * hand against a handful of fills.
 *
 * ## Which day a dollar belongs to
 *
 * Realised P&L is booked on the IST day of the **exit fill** that booked it:
 * `(entry average − exit price) × size × contract value`, one term per
 * buy-back. That is the same arithmetic `recompute` uses for a trade's total,
 * split by when each piece was bought back, so the days add up to the trades.
 * A short sold on Friday night and bought back on Monday morning is Monday's
 * money -- it was not anybody's until it closed.
 *
 * Charges land on the day of the fill they were charged on, entry and exit
 * alike, from the same formula as the statement.
 */

export type DayRow = {
  /** IST calendar day, `YYYY-MM-DD`. */
  day: string;
  realisedUsd: number;
  chargesUsd: number;
  /** `realised − charges`. The number a day is judged on. */
  netUsd: number;
  /** Trades that booked something or were charged something that day. */
  trades: number;
  /** Running `netUsd` from the first day in the range. */
  cumulativeUsd: number;
};

export type DaysReport = {
  from: string;
  to: string;
  days: DayRow[];
  totals: {
    realisedUsd: number;
    chargesUsd: number;
    netUsd: number;
    /** Days with any activity. */
    tradingDays: number;
    winDays: number;
    lossDays: number;
    best: { day: string; netUsd: number } | null;
    worst: { day: string; netUsd: number } | null;
  };
};

export function daysReport(
  records: readonly TradeRecord[],
  o: { from: string; to: string; spot: number | null },
): DaysReport {
  const byDay = new Map<string, { realised: number; charges: number; trades: Set<string> }>();
  const bucket = (day: string) => {
    let b = byDay.get(day);
    if (!b) byDay.set(day, (b = { realised: 0, charges: 0, trades: new Set() }));
    return b;
  };

  for (const rec of records) {
    const s = recompute(rec.state);
    const cv = s.contractValue ?? 0.001;
    const entryAvg = s.entryAvgPrice;
    for (const f of s.fills) {
      const day = istDate(f.ts);
      if (day < o.from || day > o.to) continue;
      const b = bucket(day);
      b.trades.add(s.tradeId);
      b.charges += fillChargesUsd({ price: f.price, contracts: f.size, contractValue: cv, spot: o.spot }).totalUsd;
      if (isExit(f.role) && entryAvg !== null) b.realised += (entryAvg - f.price) * f.size * cv;
    }
  }

  let running = 0;
  const days: DayRow[] = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, b]) => {
      const netUsd = b.realised - b.charges;
      running += netUsd;
      return {
        day, realisedUsd: b.realised, chargesUsd: b.charges, netUsd,
        trades: b.trades.size, cumulativeUsd: running,
      };
    });

  const wins = days.filter((d) => d.netUsd > 0);
  const losses = days.filter((d) => d.netUsd < 0);
  const best = days.reduce<DayRow | null>((a, d) => (a === null || d.netUsd > a.netUsd ? d : a), null);
  const worst = days.reduce<DayRow | null>((a, d) => (a === null || d.netUsd < a.netUsd ? d : a), null);
  return {
    from: o.from,
    to: o.to,
    days,
    totals: {
      realisedUsd: days.reduce((n, d) => n + d.realisedUsd, 0),
      chargesUsd: days.reduce((n, d) => n + d.chargesUsd, 0),
      netUsd: running,
      tradingDays: days.length,
      winDays: wins.length,
      lossDays: losses.length,
      best: best && { day: best.day, netUsd: best.netUsd },
      worst: worst && { day: worst.day, netUsd: worst.netUsd },
    },
  };
}

/** One reading of the day so far. Written once a minute while the desk is up. */
export type MtmSample = {
  at: number;
  day: string;
  realisedUsd: number;
  unrealisedUsd: number;
  chargesUsd: number;
  /** `realised + unrealised − charges`: what the day is worth right now. */
  netUsd: number;
};

export type MtmStats = {
  /** The last reading. */
  nowUsd: number | null;
  min: { at: number; netUsd: number } | null;
  max: { at: number; netUsd: number } | null;
  /**
   * The deepest fall from any high to a later low, and where it bottomed.
   * Not "the minimum": a day that opened at −800 and climbed to +400 drew down
   * nothing on the way up, and one that touched +600 and closed +400 drew down
   * 200 at the end.
   */
  maxDrawdown: { usd: number; at: number } | null;
};

/** The whole day's line, distilled. Same numbers whether one sample or a thousand. */
export function mtmStats(samples: readonly MtmSample[]): MtmStats {
  if (!samples.length) return { nowUsd: null, min: null, max: null, maxDrawdown: null };
  let min = samples[0]!;
  let max = samples[0]!;
  let peak = samples[0]!.netUsd;
  let dd = { usd: 0, at: samples[0]!.at };
  for (const s of samples) {
    if (s.netUsd < min.netUsd) min = s;
    if (s.netUsd > max.netUsd) max = s;
    if (s.netUsd > peak) peak = s.netUsd;
    const fall = peak - s.netUsd;
    if (fall > dd.usd) dd = { usd: fall, at: s.at };
  }
  return {
    nowUsd: samples[samples.length - 1]!.netUsd,
    min: { at: min.at, netUsd: min.netUsd },
    max: { at: max.at, netUsd: max.netUsd },
    maxDrawdown: dd.usd > 0 ? dd : { usd: 0, at: samples[0]!.at },
  };
}

/** The days as a spreadsheet, USD to the cent, one row per trading day. */
export function daysCsv(r: DaysReport): string {
  const money = (x: number) => x.toFixed(2);
  return [
    'day,trades,realised_usd,charges_usd,net_usd,cumulative_usd',
    ...r.days.map((d) =>
      [d.day, String(d.trades), money(d.realisedUsd), money(d.chargesUsd), money(d.netUsd), money(d.cumulativeUsd)].join(',')),
  ].join('\n') + '\n';
}
