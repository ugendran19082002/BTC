import { istDate } from '../strategy/schedule.js';
import { fillChargesUsd } from './charges.js';
import { isExit, isLong, recompute } from './machine.js';
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
  /**
   * The day's booked gains and its booked losses, each a positive number: `realised = profit − loss`. Counted
   * a fill at a time, as the status's own "today" is (machine.ts `realisedBreakdownSinceOf`), so a day with one
   * winner and one loser shows both rather than only their difference.
   */
  profitUsd: number;
  lossUsd: number;
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
  const byDay = new Map<string, { realised: number; profit: number; loss: number; charges: number; trades: Set<string> }>();
  const bucket = (day: string) => {
    let b = byDay.get(day);
    if (!b) byDay.set(day, (b = { realised: 0, profit: 0, loss: 0, charges: 0, trades: new Set() }));
    return b;
  };

  for (const rec of records) {
    const s = recompute(rec.state);
    const cv = s.contractValue ?? 0.001;
    const entryAvg = s.entryAvgPrice;
    /*
     * Sold to open, a fill books what was taken in less what it cost to buy back; bought to open, what it sold
     * for less what was paid. Until 6 Oct 2026 every exit was booked the short's way, so a bought trade's loss
     * came out here as a profit of the same size -- the BUY account's days read +₹39 where its journal said −₹39.
     */
    const long = isLong(s);
    for (const f of s.fills) {
      const day = istDate(f.ts);
      if (day < o.from || day > o.to) continue;
      const b = bucket(day);
      b.trades.add(s.tradeId);
      b.charges += fillChargesUsd({ price: f.price, contracts: f.size, contractValue: cv, spot: o.spot }).totalUsd;
      if (isExit(f.role) && entryAvg !== null) {
        const pnl = (long ? f.price - entryAvg : entryAvg - f.price) * f.size * cv;
        b.realised += pnl;
        if (pnl > 0) b.profit += pnl; else b.loss -= pnl;
      }
    }
  }

  let running = 0;
  const days: DayRow[] = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, b]) => {
      const netUsd = b.realised - b.charges;
      running += netUsd;
      return {
        day, realisedUsd: b.realised, profitUsd: b.profit, lossUsd: b.loss, chargesUsd: b.charges, netUsd,
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
/**
 * How the closed trades did (6 Oct 2026, the phone's statistics): win rate, profit factor, average win and loss,
 * the best and the worst -- for the whole range, by strategy, by broker account, and by entry method and timeframe.
 *
 * A trade is counted on the IST day it closed (its last exit fill), with what it made in the end: booked P&L,
 * fill by fill the same way `daysReport` books it, less every charge on every one of its fills. Judged after
 * charges, because that is what a strategy is kept or dropped on. A trade that made exactly nothing is neither a
 * win nor a loss; one still open is not counted at all.
 */
export type TradeStatsGroup = {
  /** The strategy id (`manual` for a trade nobody scheduled), the account id as text, or `all`. */
  key: string;
  trades: number;
  wins: number;
  losses: number;
  /** wins / trades; null with no trades. */
  winRate: number | null;
  /** Every winner's net added up, and every loser's (a positive number). */
  grossProfitUsd: number;
  grossLossUsd: number;
  /** grossProfit / grossLoss; null with no losing trade, where it has no finite value. */
  profitFactor: number | null;
  avgWinUsd: number | null;
  /** A positive number: the average size of a loss. */
  avgLossUsd: number | null;
  netUsd: number;
  bestUsd: number | null;
  worstUsd: number | null;
};

export type TradeStats = {
  from: string;
  to: string;
  overall: TradeStatsGroup;
  byStrategy: TradeStatsGroup[];
  byAccount: TradeStatsGroup[];
  /** `CE` / `PE`. */
  byOption: TradeStatsGroup[];
  /** `sell` / `buy`: sold or bought to open. */
  byAction: TradeStatsGroup[];
  /** A signal trade's entry method id; trades with no signal are left out of this one. */
  byMethod: TradeStatsGroup[];
  /**
   * The method and the timeframe it was read on, as one (`pairKey`): which method works on which timeframe is
   * what the owner reads to keep or drop a pairing (6 Oct 2026). Trades with no signal are left out, as above.
   */
  byPair: TradeStatsGroup[];
};

/** `breakout|single|15m`; `breakout|mtf|5m` for the read with the timeframe chain, which is its own pairing. */
export const pairKey = (s: { method: string; mode: 'mtf' | 'single'; tf: string }) => `${s.method}|${s.mode}|${s.tf}`;

/** One closed trade's day and money, or null for a trade still open (or never filled). */
export function closedNet(rec: TradeRecord, spot: number | null): { day: string; netUsd: number } | null {
  const s = recompute(rec.state);
  const exits = s.fills.filter((f) => isExit(f.role));
  if (s.position !== 0 || exits.length === 0 || s.entryAvgPrice === null) return null;
  const cv = s.contractValue ?? 0.001;
  const long = isLong(s);
  const entryAvg = s.entryAvgPrice;
  let net = 0;
  for (const f of s.fills) {
    net -= fillChargesUsd({ price: f.price, contracts: f.size, contractValue: cv, spot }).totalUsd;
    if (isExit(f.role)) net += (long ? f.price - entryAvg : entryAvg - f.price) * f.size * cv;
  }
  const closedAt = Math.max(...exits.map((f) => f.ts));
  return { day: istDate(closedAt), netUsd: net };
}

function groupOf(key: string, nets: readonly number[]): TradeStatsGroup {
  const wins = nets.filter((n) => n > 0);
  const losses = nets.filter((n) => n < 0);
  const grossProfitUsd = wins.reduce((a, n) => a + n, 0);
  const grossLossUsd = -losses.reduce((a, n) => a + n, 0);
  return {
    key,
    trades: nets.length,
    wins: wins.length,
    losses: losses.length,
    winRate: nets.length ? wins.length / nets.length : null,
    grossProfitUsd,
    grossLossUsd,
    profitFactor: grossLossUsd > 0 ? grossProfitUsd / grossLossUsd : null,
    avgWinUsd: wins.length ? grossProfitUsd / wins.length : null,
    avgLossUsd: losses.length ? grossLossUsd / losses.length : null,
    netUsd: grossProfitUsd - grossLossUsd,
    bestUsd: nets.length ? Math.max(...nets) : null,
    worstUsd: nets.length ? Math.min(...nets) : null,
  };
}

/** The strategy a trade is counted under: its strategy's id, or `manual` for one nobody scheduled. */
const strategyKeyOf = (rec: TradeRecord): string => rec.plan.strategyId ?? 'manual';

/** Only the trades of the strategies named (8 Oct 2026, the phone's strategy filter); null or none named is every trade. */
export function ofStrategies<T extends TradeRecord>(records: readonly T[], keys: readonly string[] | null): readonly T[] {
  if (!keys || keys.length === 0) return records;
  const wanted = new Set(keys);
  return records.filter((rec) => wanted.has(strategyKeyOf(rec)));
}

/** Only the signal trades of the entry methods named (8 Oct 2026, the phone's method filter); null or none named is every trade, signal or not. */
export function ofMethods<T extends TradeRecord>(records: readonly T[], methods: readonly string[] | null): readonly T[] {
  if (!methods || methods.length === 0) return records;
  const wanted = new Set(methods);
  return records.filter((rec) => rec.plan.signal?.method !== undefined && wanted.has(rec.plan.signal.method));
}

export function tradeStats(
  records: readonly TradeRecord[],
  o: { from: string; to: string; spot: number | null },
): TradeStats {
  const all: number[] = [];
  const byStrategy = new Map<string, number[]>();
  const byAccount = new Map<string, number[]>();
  const byOption = new Map<string, number[]>();
  const byAction = new Map<string, number[]>();
  const byMethod = new Map<string, number[]>();
  const byPair = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, n: number) => { const a = m.get(k); if (a) a.push(n); else m.set(k, [n]); };
  for (const rec of records) {
    const c = closedNet(rec, o.spot);
    if (!c || c.day < o.from || c.day > o.to) continue;
    all.push(c.netUsd);
    push(byStrategy, strategyKeyOf(rec), c.netUsd);
    push(byAccount, rec.plan.accountId == null ? 'none' : String(rec.plan.accountId), c.netUsd);
    push(byOption, rec.state.optionSide, c.netUsd);
    push(byAction, isLong(rec.state) ? 'buy' : 'sell', c.netUsd);
    if (rec.plan.signal?.method) {
      push(byMethod, rec.plan.signal.method, c.netUsd);
      push(byPair, pairKey(rec.plan.signal), c.netUsd);
    }
  }
  const groups = (m: Map<string, number[]>) => [...m.entries()].map(([k, v]) => groupOf(k, v)).sort((a, b) => b.netUsd - a.netUsd);
  return {
    from: o.from, to: o.to, overall: groupOf('all', all),
    byStrategy: groups(byStrategy), byAccount: groups(byAccount),
    byOption: groups(byOption), byAction: groups(byAction), byMethod: groups(byMethod),
    byPair: groups(byPair),
  };
}

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
