import { readMarket, resampleTf, venueSeriesSince, type Timeframe } from '../market/moves.js';
import type { Candle } from '../market/delta.js';
import { flowMinutes, liveBook, liveLtp, perpQuote, recentPerpPrints } from '../market/flow.js';
import { candles } from '../market/delta.js';
import { derivHistory } from './deriv.js';
import { HEAT_STEP, heatMinutes, persistentWalls } from '../market/book-heat.js';
import { liveChain } from '../market/chain.js';
import { optionStructure } from '../domain/structure.js';
import { expectedMoveOver } from '../domain/shock.js';
import { shockFrom } from '../market/shock-now.js';
import { wallWithinEm } from '../http/routes/desk.routes.js';
import { TF_SEC, type EntryContext, type Frames, type Tf } from './types.js';
import { gatesOff } from './gates.js';

/**
 * The entry engine's view of the market, read once per board.
 *
 * Every part is best-effort: a tape that is not recorded, a book that does not
 * answer, an option board that cannot be read -- each comes back empty or null,
 * and the engine says "not read" for the step that needed it rather than
 * inventing it. Only closed candles go in; 3m is folded from 1m, since Delta
 * does not serve it.
 */

/** Only candles whose period has ended. */
export const closedOnly = (bars: readonly Candle[], tfSec: number, nowSec: number) =>
  bars.filter((b) => b.time + tfSec <= nowSec);

/** Seconds a closed candle is given to settle at the venue before it counts as whole. */
export const CLOSE_SETTLE_SEC = 2;

/**
 * The moment up to which the series' candles are whole (epoch s): when it was
 * asked for, less the settle time -- never later than now. A candle closing
 * after that is not closed *in this data*, whatever the clock says now.
 */
export const wholeUntil = (askedAtMs: number, nowSec: number) => Math.min(nowSec, Math.floor(askedAtMs / 1000) - CLOSE_SETTLE_SEC);

const VENUE: [Tf, Timeframe][] = [['1m', '1m'], ['5m', '5m'], ['15m', '15m'], ['30m', '30m'], ['1h', '1h'], ['4h', '4h']];

/** The closed minute as the desk's own tape saw it (market/flow.ts `perpMinuteFromTape`). */
export type TapeMinute = { close: number; high: number; low: number; volume: number };

/**
 * Whether the candles that closed at `boundarySec` are final in this data, without waiting for them to settle.
 *
 * The run used to wait three seconds after every close, so that the venue's candle was surely whole. The
 * desk holds every trade of the perp itself, so it can check instead: the venue's 1m candle for the minute
 * that just ended must end where the tape's last trade ended, with the tape's high, low and volume; and every
 * longer candle that closed on the same boundary must end at that same trade. If they do, the candles are
 * what they will be in two seconds' time, and the methods can run now. If anything differs -- the venue is
 * late, the tape has a gap -- this says no, and the run waits for the settled read exactly as before.
 *
 * It only decides *when* the venue's candles are read as closed. The methods read the venue's candles either way.
 */
export function closeVerified(series: ReadonlyMap<Timeframe, readonly Candle[]>, boundarySec: number, tape: TapeMinute | null): boolean {
  if (!tape) return false;
  const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const m1 = (series.get('1m') ?? []).find((b) => b.time === boundarySec - 60);
  if (!m1) return false;
  if (!same(m1.close, tape.close) || !same(m1.high, tape.high) || !same(m1.low, tape.low)) return false;
  // Volume to a tenth of a percent, or one contract: the venue sums the same trades the tape holds.
  if (Math.abs(m1.volume - tape.volume) > Math.max(1, tape.volume * 0.001)) return false;
  for (const [tf, venue] of VENUE) {
    if (tf === '1m' || boundarySec % TF_SEC[tf] !== 0) continue;
    const bar = (series.get(venue) ?? []).find((b) => b.time === boundarySec - TF_SEC[tf]);
    if (!bar || !same(bar.close, tape.close)) return false;
  }
  return true;
}

/**
 * `early`: the look taken a second or two after a close. The candles are asked for afresh (`minAskedAt`) and
 * the minute that just ended counts as closed only if `closeVerified` says so against `tape`; the context
 * says which (`closeVerified`), and a caller that gets false waits for the settled read.
 */
export async function readEntryContext(now = Date.now(), early?: { minAskedAt: number; tape: TapeMinute | null }): Promise<EntryContext> {
  const nowSec = Math.floor(now / 1000);
  const minuteStart = Math.floor(now / 60_000) * 60_000;
  // Asked for after this minute began, so the minute that just closed is in it whole.
  const { askedAt, data: series } = await venueSeriesSince(early?.minAskedAt ?? minuteStart)
    .catch(() => ({ askedAt: 0, data: new Map<Timeframe, Candle[]>() }));
  const verified = early !== undefined && closeVerified(series, minuteStart / 1000, early.tape);
  // Checked against the tape, the minute that just ended is closed now; otherwise it is closed once it has settled.
  const asOf = verified ? Math.max(wholeUntil(askedAt, nowSec), Math.min(nowSec, minuteStart / 1000)) : wholeUntil(askedAt, nowSec);
  const frames: Frames = {};
  for (const [tf, venue] of VENUE) frames[tf] = closedOnly(series.get(venue) ?? [], TF_SEC[tf], asOf);
  frames['3m'] = resampleTf(frames['1m'] ?? [], 3);

  const [flow, heat, book, snap, market, off, deriv, eth] = await Promise.all([
    flowMinutes(now - 3 * 3_600_000, now).catch(() => []),
    heatMinutes(now - 2 * 3_600_000).catch(() => []),
    liveBook(now).catch(() => null),
    liveChain().catch(() => null),
    readMarket().catch(() => null),
    // Unreadable switches fall back to every gate on: the safe direction.
    gatesOff().catch(() => []),
    derivHistory(now).catch(() => null),
    ethSeries(now).catch(() => []),
  ]);

  let options: EntryContext['options'] = null;
  let bigMove: EntryContext['bigMove'] = null;
  // Best-effort like every other part: a board that cannot be read is no options context, not no board.
  if (snap && snap.live) try {
    const structure = optionStructure(snap, market?.realisedVol ?? null, wallWithinEm());
    options = {
      spot: snap.spot,
      atmIv: snap.atmIv,
      emDay: expectedMoveOver(snap.spot, snap.atmIv, 24),
      callWall: structure.ceOiWallNear?.strike ?? null,
      putWall: structure.peOiWallNear?.strike ?? null,
      maxPain: structure.maxPain?.strike ?? null,
      toSettleSec: snap.expiryTs - nowSec,
    };
    const shock = shockFrom({ snap, market, structure, oiChanges: new Map(), iv: null, window: 60 });
    bigMove = { band: shock.band, direction: shock.direction };
  } catch {
    options = null;
    bigMove = null;
  }

  return {
    now,
    frames,
    closeVerified: verified,
    gatesOff: off,
    // The tape's last trade, read now: the live price, milliseconds old while the socket is up.
    ltp: (() => { try { const l = liveLtp(now); return l ? { price: l.price, at: l.at } : null; } catch { return null; } })(),
    quote: (() => { try { return perpQuote(); } catch { return null; } })(),
    flow: flow.map((m) => ({
      time: Math.floor(m.at / 1000), buy: m.buyVolume, sell: m.sellVolume,
      largeBuy: m.largeBuyVolume, largeSell: m.largeSellVolume,
    })),
    walls: persistentWalls(heat, HEAT_STEP).map((w) => ({ side: w.side, price: w.price, size: w.size })),
    // The book's spreadPct is a fraction; the engine's gate is in percent.
    spreadPct: book?.spreadPct === null || book?.spreadPct === undefined ? null : book.spreadPct * 100,
    // The research methods' inputs (types.ts EntryContext).
    deriv,
    book: book ? { at: book.at, bestBid: book.bestBid, bestAsk: book.bestAsk, top5Bid: book.top5Bid, top5Ask: book.top5Ask, imbalance: book.imbalance } : null,
    heat,
    prints: (() => { try { return recentPerpPrints(now - 30 * 60_000).map((p) => ({ at: p.at, price: p.price, size: p.size, side: p.side })); } catch { return []; } })(),
    eth: closedOnly(eth, 300, asOf),
    options,
    bigMove,
  };
}

/** ETHUSD 5m candles, about 17 hours of them, fetched at most once a minute: the other market for the research methods. */
let ethHeld: { at: number; value: Promise<Candle[]> } | null = null;
function ethSeries(now: number): Promise<Candle[]> {
  if (ethHeld && now - ethHeld.at < 60_000) return ethHeld.value;
  const end = Math.floor(now / 1000);
  ethHeld = { at: now, value: candles('ETHUSD', end - 200 * 300, end, '5m').catch(() => []) };
  return ethHeld.value;
}

