import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { LOT_BTC, USDINR } from './score.js';

/**
 * Backtest over the harvested chain snapshots in chain.db.
 *
 * Every position is opened at 05:30 IST and held to the 12:00 UTC settlement,
 * so the exit is the option's intrinsic value at settlement -- exact, and free
 * of the exit-quote noise that plagued the earlier reproduction.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.CHAIN_DB ?? join(HERE, '..', '..', '..', 'chain.db');

export type RawLeg = {
  cp: 'C' | 'P';
  k: number;
  off: number;
  ltp: number | null;
  mark: number | null;
  age_min: number | null;
  vol_8h: number;
  settle_value: number;
};
export type Day = {
  date: string;
  ok: boolean;
  spot: number;
  settle: number;
  atm: number;
  step: number;
  legs: RawLeg[];
};

let cache: Day[] | null = null;

type DayRow = { date: string; spot: number; settle: number; atm: number; step: number };
type LegRow = RawLeg & { date: string };

export function loadDays(): Day[] {
  if (cache) return cache;
  if (!existsSync(DB_PATH)) return (cache = []);

  // read-only: the harvester owns the file, and WAL lets us read mid-write
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const dayRows = db
      .prepare('SELECT date, spot, settle, atm, step FROM days ORDER BY date')
      .all() as unknown as DayRow[];
    const legRows = db
      .prepare(
        'SELECT date, cp, k, off, ltp, mark, age_min, vol_8h, settle_value' +
          ' FROM legs ORDER BY date, k',
      )
      .all() as unknown as LegRow[];

    const byDate = new Map<string, Day>();
    for (const d of dayRows) {
      byDate.set(d.date, { ...d, ok: true, legs: [] });
    }
    for (const l of legRows) {
      byDate.get(l.date)?.legs.push(l);
    }
    cache = [...byDate.values()].filter((d) => d.legs.length > 0);
    return cache;
  } finally {
    db.close();
  }
}

export function reloadDays(): number {
  cache = null;
  return loadDays().length;
}

export type Band = { min: number; max: number };
export type Params = {
  ce: Band | null;
  pe: Band | null;
  /** 'ltp' is what actually traded; 'mark' is continuous and never stale */
  priceSource: 'ltp' | 'mark';
  /** reject a traded price older than this many minutes; ignored for mark */
  maxAgeMin: number;
  /** AlgoTest's Premium Range picks the richest strike inside the band */
  pick: 'highest' | 'lowest';
  lots: number;
  /** fraction shaved off the entry credit, e.g. 0.05 for 5% */
  slippage: number;
  /** 0=Sun .. 6=Sat, days to stand aside */
  skipWeekdays: number[];
  /** strikes beyond the short to buy as protection; 0 = naked */
  hedgeGap: number;
  from?: string;
  to?: string;
};

export const DEFAULTS: Params = {
  ce: { min: 0, max: 15 },
  pe: { min: 0, max: 15 },
  priceSource: 'mark',
  maxAgeMin: 30,
  pick: 'highest',
  lots: 10,
  slippage: 0.05,
  skipWeekdays: [],
  hedgeGap: 0,
  from: undefined,
  to: undefined,
};

export type TradeLeg = {
  side: 'CE' | 'PE';
  strike: number;
  entry: number;
  exit: number;
  hedgeStrike: number | null;
  hedgeEntry: number | null;
  hedgeExit: number | null;
  pnlUsd: number;
};
export type TradeDay = {
  date: string;
  weekday: number;
  spot: number;
  settle: number;
  legs: TradeLeg[];
  pnlUsd: number;
  pnlInr: number;
  cum: number;
};

const priceOf = (l: RawLeg, p: Params): number | null => {
  if (p.priceSource === 'mark') return l.mark ?? null;
  if (l.ltp === null) return null;
  if (l.age_min === null || l.age_min > p.maxAgeMin) return null;
  return l.ltp;
};

function chooseShort(day: Day, cp: 'C' | 'P', band: Band, p: Params): RawLeg | null {
  const otm = day.legs.filter((l) => l.cp === cp && (cp === 'C' ? l.k > day.atm : l.k < day.atm));
  const inBand = otm.filter((l) => {
    const px = priceOf(l, p);
    return px !== null && px >= band.min && px <= band.max;
  });
  if (!inBand.length) return null;
  return inBand.reduce((a, b) => {
    const pa = priceOf(a, p)!;
    const pb = priceOf(b, p)!;
    return p.pick === 'highest' ? (pb > pa ? b : a) : pb < pa ? b : a;
  });
}

export function run(params: Partial<Params> = {}): {
  params: Params;
  trades: TradeDay[];
  summary: Summary;
} {
  const p: Params = { ...DEFAULTS, ...params };
  const trades: TradeDay[] = [];
  let cum = 0;

  for (const day of loadDays()) {
    if (p.from && day.date < p.from) continue;
    if (p.to && day.date > p.to) continue;
    const weekday = new Date(day.date + 'T00:00:00Z').getUTCDay();
    if (p.skipWeekdays.includes(weekday)) continue;

    const legs: TradeLeg[] = [];
    for (const [side, cp, band] of [
      ['CE', 'C', p.ce],
      ['PE', 'P', p.pe],
    ] as const) {
      if (!band) continue;
      const short = chooseShort(day, cp, band, p);
      if (!short) continue;
      const entry = priceOf(short, p)! * (1 - p.slippage);
      const exit = short.settle_value;

      let hedgeStrike: number | null = null;
      let hedgeEntry: number | null = null;
      let hedgeExit: number | null = null;
      if (p.hedgeGap > 0) {
        const hk = cp === 'C' ? short.k + p.hedgeGap * day.step : short.k - p.hedgeGap * day.step;
        const h = day.legs.find((l) => l.cp === cp && l.k === hk);
        const hpx = h ? priceOf(h, p) : null;
        if (h && hpx !== null) {
          hedgeStrike = hk;
          hedgeEntry = hpx * (1 + p.slippage);
          hedgeExit = h.settle_value;
        }
      }

      // short collects entry and pays out the settlement value; the long is the mirror
      const per = entry - exit + (hedgeEntry !== null ? hedgeExit! - hedgeEntry : 0);
      legs.push({
        side,
        strike: short.k,
        entry,
        exit,
        hedgeStrike,
        hedgeEntry,
        hedgeExit,
        pnlUsd: per * p.lots * LOT_BTC,
      });
    }

    if (!legs.length) continue;
    const pnlUsd = legs.reduce((a, l) => a + l.pnlUsd, 0);
    cum += pnlUsd;
    trades.push({
      date: day.date,
      weekday,
      spot: day.spot,
      settle: day.settle,
      legs,
      pnlUsd,
      pnlInr: pnlUsd * USDINR,
      cum,
    });
  }

  return { params: p, trades, summary: summarize(trades) };
}

export type Summary = {
  days: number;
  wins: number;
  losses: number;
  winPct: number;
  totalUsd: number;
  totalInr: number;
  avgUsd: number;
  grossWin: number;
  grossLoss: number;
  profitFactor: number;
  worstDayUsd: number;
  worstDate: string | null;
  bestDayUsd: number;
  maxDrawdownUsd: number;
  returnOverMdd: number;
};

export function summarize(trades: TradeDay[]): Summary {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlUsd > 0).length;
  const grossWin = trades.filter((t) => t.pnlUsd > 0).reduce((a, t) => a + t.pnlUsd, 0);
  // `+ 0` normalises the -0 that negating an empty sum produces; it serialises
  // the same either way, but Object.is(-0, 0) is false and that surprises people
  const grossLoss = -trades.filter((t) => t.pnlUsd < 0).reduce((a, t) => a + t.pnlUsd, 0) + 0;
  const total = trades.reduce((a, t) => a + t.pnlUsd, 0);
  let peak = 0;
  let mdd = 0;
  for (const t of trades) {
    peak = Math.max(peak, t.cum);
    mdd = Math.max(mdd, peak - t.cum);
  }
  const worst = trades.reduce<TradeDay | null>((a, t) => (a === null || t.pnlUsd < a.pnlUsd ? t : a), null);
  const best = trades.reduce<TradeDay | null>((a, t) => (a === null || t.pnlUsd > a.pnlUsd ? t : a), null);
  return {
    days: n,
    wins,
    losses: n - wins,
    winPct: n ? (wins / n) * 100 : 0,
    totalUsd: total,
    totalInr: total * USDINR,
    avgUsd: n ? total / n : 0,
    grossWin,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    worstDayUsd: worst?.pnlUsd ?? 0,
    worstDate: worst?.date ?? null,
    bestDayUsd: best?.pnlUsd ?? 0,
    maxDrawdownUsd: mdd,
    returnOverMdd: mdd > 0 ? total / mdd : Infinity,
  };
}

/**
 * Premium-floor sweep: for each floor, sell the FURTHEST out-of-the-money
 * strike that still pays at least that much.
 *
 * This is what "I want at least $N of premium" actually means for a seller --
 * buy as much distance as the market will give you at that price -- and it is a
 * different question from the band selection above, which takes the richest
 * strike inside a range.
 */
export type FloorRow = { floor: number; summary: Summary; medianOtmPct: number | null };

export function floorSweep(
  floors: number[],
  params: Partial<Params> = {},
): FloorRow[] {
  const p: Params = { ...DEFAULTS, ...params };
  const days = loadDays();

  return floors.map((floor) => {
    const trades: TradeDay[] = [];
    const distances: number[] = [];
    let cum = 0;

    for (const day of days) {
      if (p.from && day.date < p.from) continue;
      if (p.to && day.date > p.to) continue;
      const weekday = new Date(day.date + 'T00:00:00Z').getUTCDay();
      if (p.skipWeekdays.includes(weekday)) continue;

      const legs: TradeLeg[] = [];
      for (const [side, cp] of [
        ['CE', 'C'],
        ['PE', 'P'],
      ] as const) {
        if ((cp === 'C' && !p.ce) || (cp === 'P' && !p.pe)) continue;
        const otm = day.legs.filter(
          (l) => l.cp === cp && (cp === 'C' ? l.k > day.atm : l.k < day.atm),
        );
        const eligible = otm.filter((l) => {
          const px = priceOf(l, p);
          return px !== null && px >= floor;
        });
        if (!eligible.length) continue;
        // cheapest of the eligible == furthest from the money
        const short = eligible.reduce((a, b) => (priceOf(b, p)! < priceOf(a, p)! ? b : a));
        const entry = priceOf(short, p)! * (1 - p.slippage);
        legs.push({
          side,
          strike: short.k,
          entry,
          exit: short.settle_value,
          hedgeStrike: null,
          hedgeEntry: null,
          hedgeExit: null,
          pnlUsd: (entry - short.settle_value) * p.lots * LOT_BTC,
        });
        distances.push((Math.abs(short.k - day.spot) / day.spot) * 100);
      }

      if (!legs.length) continue;
      const pnlUsd = legs.reduce((a, l) => a + l.pnlUsd, 0);
      cum += pnlUsd;
      trades.push({
        date: day.date,
        weekday,
        spot: day.spot,
        settle: day.settle,
        legs,
        pnlUsd,
        pnlInr: pnlUsd * USDINR,
        cum,
      });
    }

    distances.sort((a, b) => a - b);
    return {
      floor,
      summary: summarize(trades),
      medianOtmPct: distances.length ? distances[Math.floor(distances.length / 2)]! : null,
    };
  });
}
