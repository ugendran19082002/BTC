import { one, rows } from '../db/pool.js';
import { flowSchema, livePerp } from './flow.js';
import { readMarket, spotMinutesAgo } from './moves.js';

/**
 * The character of a move, by window: price, open interest and volume
 * together, the way a futures desk reads them --
 *
 *   price ↑  OI ↑  long buildup       new longs; continuation is the base case
 *   price ↑  OI ↓  short covering     shorts closing; fast, and it can stop when they are done
 *   price ↓  OI ↑  short buildup      new shorts
 *   price ↓  OI ↓  long unwinding     longs closing
 *
 * Volume is not a direction: it is how much conviction is behind the type
 * (the window's pace against the day's median pace). And the tape's own
 * aggressor read (CVD) either confirms the direction or does not -- price
 * and OI alone cannot say who started the trade, so the flow is read beside
 * them, never folded into them.
 *
 * All from the desk's own records: the perpetual's OI every five minutes,
 * its tape every minute, BTC from the cached candles. Thresholds scale with
 * the square root of the window, the way a random walk's typical move does;
 * they are the desk's starting point, not a backtested truth.
 */

export const MOVEMENT_WINDOWS_MIN = [5, 15, 30, 60, 180, 360, 720] as const;

/** The windows the price-change table shows: the tape's last minute out to half a day. */
export const PRICE_WINDOWS_MIN = [1, 5, 15, 30, 60, 120, 240, 360, 720] as const;

export type PriceChange = {
  /** Minutes back, or a named mark: the entry window, the contract's day start (the previous 17:30 IST settlement). */
  minutes: number | null;
  mark: 'entry' | 'dayStart' | null;
  /** When "then" is, epoch ms. */
  at: number;
  then: number | null;
  pts: number | null;
  pct: number | null;
};

/**
 * BTC now against BTC then, for each window and for the desk's own marks:
 * points and percent, from the cached candles (the minute bars out to eight
 * hours, five-minute bars beyond). Null where the candles do not reach.
 */
export function priceChanges(spotNow: number | null, nowMs: number, marks: { entryMs?: number | null; dayStartMs?: number | null } = {}): PriceChange[] {
  const row = (minutes: number | null, mark: PriceChange['mark'], at: number): PriceChange => {
    const then = at < nowMs - 30_000 ? spotMinutesAgo((nowMs - at) / 60_000, nowMs) : spotNow;
    const ok = spotNow !== null && then !== null && then > 0;
    return { minutes, mark, at, then, pts: ok ? spotNow - then : null, pct: ok ? (spotNow / then - 1) * 100 : null };
  };
  const out = PRICE_WINDOWS_MIN.map((m) => row(m, null, nowMs - m * 60_000));
  if (marks.entryMs != null && marks.entryMs <= nowMs) out.push(row(null, 'entry', marks.entryMs));
  if (marks.dayStartMs != null && marks.dayStartMs <= nowMs) out.push(row(null, 'dayStart', marks.dayStartMs));
  return out;
}

export type MovementType = 'LONG_BUILDUP' | 'SHORT_COVERING' | 'SHORT_BUILDUP' | 'LONG_UNWINDING' | 'MIXED';
export type MovementStrength = 'WEAK' | 'MODERATE' | 'STRONG' | 'EXTREME';

export type MovementRow = {
  minutes: number;
  pricePct: number | null;
  oiPct: number | null;
  /** The window's volume per minute against the median minute of the last day. */
  volumeRatio: number | null;
  /** Buy minus sell volume over the window, contracts, and the buy share. */
  cvd: number | null;
  aggressorBuyPct: number | null;
  type: MovementType | null;
  direction: 'UP' | 'DOWN' | null;
  strength: MovementStrength | null;
  /** Whether the tape's aggressors lean the same way as the type: the confirmation price and OI cannot give. */
  flow: 'CONFIRMS' | 'DIVERGES' | 'FLAT' | null;
  /** The thresholds this window was judged against, so the reader can see how close a call was. */
  thresholds: { pricePct: number; oiPct: number };
};

/** Price and OI thresholds for a window: 0.08% and 0.25% at five minutes, growing with √time. */
export function thresholdsFor(minutes: number): { pricePct: number; oiPct: number } {
  const k = Math.sqrt(minutes / 5);
  return { pricePct: 0.08 * k, oiPct: 0.25 * k };
}

/** Volume against the median pace: under 1× weak, to 1.5× moderate, to 2× strong, past it extreme. */
export function strengthOf(volumeRatio: number | null): MovementStrength | null {
  if (volumeRatio === null) return null;
  return volumeRatio < 1 ? 'WEAK' : volumeRatio < 1.5 ? 'MODERATE' : volumeRatio < 2 ? 'STRONG' : 'EXTREME';
}

/** The four types from price and OI past their thresholds; anything inside them is mixed. Pure. */
export function classify(pricePct: number | null, oiPct: number | null, t: { pricePct: number; oiPct: number }): { type: MovementType | null; direction: 'UP' | 'DOWN' | null } {
  if (pricePct === null) return { type: null, direction: null };
  const up = pricePct >= t.pricePct, down = pricePct <= -t.pricePct;
  if (!up && !down) return { type: 'MIXED', direction: null };
  if (oiPct === null) return { type: 'MIXED', direction: up ? 'UP' : 'DOWN' };
  const build = oiPct >= t.oiPct, unwind = oiPct <= -t.oiPct;
  if (up) return { type: build ? 'LONG_BUILDUP' : unwind ? 'SHORT_COVERING' : 'MIXED', direction: 'UP' };
  return { type: build ? 'SHORT_BUILDUP' : unwind ? 'LONG_UNWINDING' : 'MIXED', direction: 'DOWN' };
}

/** Does the tape agree with the direction? Aggressors past 55 / 45 lean; inside that they say nothing. */
export function flowRead(direction: 'UP' | 'DOWN' | null, aggressorBuyPct: number | null): MovementRow['flow'] {
  if (direction === null || aggressorBuyPct === null) return null;
  const lean = aggressorBuyPct >= 0.55 ? 'UP' : aggressorBuyPct <= 0.45 ? 'DOWN' : null;
  return lean === null ? 'FLAT' : lean === direction ? 'CONFIRMS' : 'DIVERGES';
}

/** One row per window, from the records. */
export async function movementByWindow(nowMs = Date.now(), marks: { entryMs?: number | null; dayStartMs?: number | null } = {}): Promise<{ at: number; rows: MovementRow[]; price: { spot: number | null; rows: PriceChange[] } }> {
  await flowSchema();
  const current = Math.floor(nowMs / 60_000) * 60_000;
  const dayAgo = current - 24 * 3_600_000;
  // The tape, minute by minute, for the day: volume and delta per minute.
  const minutes = await rows<{ at: number; vol: number; delta: number }>(
    'SELECT at, buy_volume + sell_volume AS vol, buy_volume - sell_volume AS delta FROM trade_flow_1m WHERE at >= $1 AND at < $2 ORDER BY at',
    [dayAgo, current],
  );
  const vols = minutes.map((m) => m.vol).sort((a, b) => a - b);
  const medianMinute = vols.length >= 30 ? vols[Math.floor(vols.length / 2)]! : null;
  // The candles are cached by the chain route; on a cold process, fetch them once so the windows can be read.
  if (spotMinutesAgo(5, nowMs) === null) await readMarket().catch(() => {});
  const perp = await livePerp(nowMs).catch(() => null);
  const spotNow = perp?.spot ?? perp?.mark ?? spotMinutesAgo(0, nowMs);
  const oiNow = perp?.oiContracts ?? null;
  const out: MovementRow[] = [];
  for (const m of MOVEMENT_WINDOWS_MIN) {
    const since = current - m * 60_000;
    const spotThen = spotMinutesAgo(m, nowMs);
    const oiThen = await one<{ oi: number | null }>(
      'SELECT oi_contracts AS oi FROM perp_snapshots WHERE at BETWEEN $1 AND $2 ORDER BY ABS(at - $3) LIMIT 1',
      [since - 7.5 * 60_000, since + 7.5 * 60_000, since],
    );
    const win = minutes.filter((x) => x.at >= since);
    const vol = win.reduce((a, x) => a + x.vol, 0);
    const buy = win.reduce((a, x) => a + (x.vol + x.delta) / 2, 0);
    const cvd = win.length ? win.reduce((a, x) => a + x.delta, 0) : null;
    const pricePct = spotNow !== null && spotThen !== null && spotThen > 0 ? (spotNow / spotThen - 1) * 100 : null;
    const oiPct = oiNow !== null && oiThen?.oi != null && oiThen.oi > 0 ? (oiNow / oiThen.oi - 1) * 100 : null;
    const volumeRatio = medianMinute !== null && medianMinute > 0 && win.length ? (vol / win.length) / medianMinute : null;
    const aggressorBuyPct = vol > 0 ? buy / vol : null;
    const t = thresholdsFor(m);
    const c = classify(pricePct, oiPct, t);
    out.push({
      minutes: m, pricePct, oiPct, volumeRatio, cvd, aggressorBuyPct,
      type: c.type, direction: c.direction, strength: c.type === null ? null : strengthOf(volumeRatio),
      flow: flowRead(c.direction, aggressorBuyPct), thresholds: t,
    });
  }
  return { at: nowMs, rows: out, price: { spot: spotNow, rows: priceChanges(spotNow, nowMs, marks) } };
}
