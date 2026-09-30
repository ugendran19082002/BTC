import { readMarket, resampleTf, venueSeries, type Timeframe } from '../market/moves.js';
import type { Candle } from '../market/delta.js';
import { flowMinutes, liveBook } from '../market/flow.js';
import { HEAT_STEP, heatMinutes, persistentWalls } from '../market/book-heat.js';
import { liveChain } from '../market/chain.js';
import { optionStructure } from '../domain/structure.js';
import { expectedMoveOver } from '../domain/shock.js';
import { shockFrom } from '../market/shock-now.js';
import { wallWithinEm } from '../http/routes/desk.routes.js';
import { TF_SEC, type EntryContext, type Frames, type Tf } from './types.js';

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

const VENUE: [Tf, Timeframe][] = [['1m', '1m'], ['5m', '5m'], ['15m', '15m'], ['30m', '30m'], ['1h', '1h'], ['4h', '4h']];

export async function readEntryContext(now = Date.now()): Promise<EntryContext> {
  const nowSec = Math.floor(now / 1000);
  const series = await venueSeries().catch(() => new Map<Timeframe, Candle[]>());
  const frames: Frames = {};
  for (const [tf, venue] of VENUE) frames[tf] = closedOnly(series.get(venue) ?? [], TF_SEC[tf], nowSec);
  frames['3m'] = resampleTf(frames['1m'] ?? [], 3);

  const [flow, heat, book, snap, market] = await Promise.all([
    flowMinutes(now - 3 * 3_600_000, now).catch(() => []),
    heatMinutes(now - 2 * 3_600_000).catch(() => []),
    liveBook(now).catch(() => null),
    liveChain().catch(() => null),
    readMarket().catch(() => null),
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
    flow: flow.map((m) => ({
      time: Math.floor(m.at / 1000), buy: m.buyVolume, sell: m.sellVolume,
      largeBuy: m.largeBuyVolume, largeSell: m.largeSellVolume,
    })),
    walls: persistentWalls(heat, HEAT_STEP).map((w) => ({ side: w.side, price: w.price, size: w.size })),
    // The book's spreadPct is a fraction; the engine's gate is in percent.
    spreadPct: book?.spreadPct === null || book?.spreadPct === undefined ? null : book.spreadPct * 100,
    options,
    bigMove,
  };
}
