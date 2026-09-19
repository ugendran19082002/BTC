import { one } from '../db/pool.js';
import { spotMinutesAgo } from './moves.js';
import { optionSnapshotsSchema } from './option-snapshots.js';
import { marketSchema } from './oi-history.js';

/**
 * What changed over the last 1m … 12h: BTC, one strike's premium / OI / IV /
 * volume, and the board's call and put open interest, volume and PCR -- the
 * "diff" a seller reads before entry (docs/test.md §Premium Engine, §OI).
 *
 * Sources, each at its own resolution and said so: BTC from the cached
 * candles (1-minute for eight hours, 5-minute beyond); the strike and the
 * board from the desk's five-minute records, so the 1-minute window has no
 * reading for them and shows null rather than a guess.
 */

export const CHANGE_WINDOWS_MIN = [1, 5, 15, 30, 60, 120, 180, 360, 720] as const;

export type ChangeRow = {
  minutes: number;
  /** BTC then, and the change since, USD and percent. */
  spotThen: number | null;
  spotChange: number | null;
  spotChangePct: number | null;
  /** The strike, from its five-minute record. */
  markThen: number | null;
  markChange: number | null;
  markChangePct: number | null;
  oiThen: number | null;
  oiChange: number | null;
  ivThen: number | null;
  ivChangePts: number | null;
  volumeThen: number | null;
  volumeChange: number | null;
  /** The board, from its five-minute record. */
  ceOiChange: number | null;
  peOiChange: number | null;
  callVolumeChange: number | null;
  putVolumeChange: number | null;
  pcrThen: number | null;
  pcrChange: number | null;
  atmIvThen: number | null;
  atmIvChangePts: number | null;
};

/**
 * How the premium is moving, from the last three five-minute records: the
 * change over the newest bucket, and how that change itself changed. What a
 * seller reads as "the premium is running away" or "the decay has started".
 */
export type PremiumMomentum = { velocity: number | null; acceleration: number | null };

export type ChangesNow = {
  spot: number | null;
  mark: number | null; oi: number | null; iv: number | null; volume: number | null;
  ceOi: number | null; peOi: number | null; callVolume: number | null; putVolume: number | null; pcr: number | null; atmIv: number | null;
};

type Snap = { spot: number | null; mark: number | null; oi: number | null; mark_iv: number | null; volume: number | null };
type Board = { ce_oi: number | null; pe_oi: number | null; call_volume: number | null; put_volume: number | null; pcr_oi: number | null; atm_iv: number | null };

const d = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
const pct = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : (a / b - 1) * 100);

/** The five-minute record nearest `atMs`, within a bucket and a half of it. */
async function snapAt(symbol: string, atMs: number): Promise<Snap | null> {
  return one<Snap>(
    'SELECT spot, mark, oi, mark_iv, volume FROM option_snapshots WHERE symbol = $1 AND at BETWEEN $2 AND $3 ORDER BY ABS(at - $4) LIMIT 1',
    [symbol, atMs - 7.5 * 60_000, atMs + 7.5 * 60_000, atMs],
  );
}
async function boardAt(expiry: string, atMs: number): Promise<Board | null> {
  return one<Board>(
    'SELECT ce_oi, pe_oi, call_volume, put_volume, pcr_oi, atm_iv FROM chain_features WHERE expiry = $1 AND at BETWEEN $2 AND $3 ORDER BY ABS(at - $4) LIMIT 1',
    [expiry, atMs - 7.5 * 60_000, atMs + 7.5 * 60_000, atMs],
  );
}

export async function changes(symbol: string, expiry: string, nowMs = Date.now(), now?: Partial<ChangesNow>): Promise<{ now: ChangesNow; rows: ChangeRow[]; momentum: PremiumMomentum }> {
  await Promise.all([optionSnapshotsSchema(), marketSchema()]);
  // "Now" is the caller's live figures where it has them, the newest record otherwise.
  const [s0, b0, s10] = await Promise.all([snapAt(symbol, nowMs), boardAt(expiry, nowMs), snapAt(symbol, nowMs - 10 * 60_000)]);
  const cur: ChangesNow = {
    spot: now?.spot ?? spotMinutesAgo(0, nowMs) ?? s0?.spot ?? null,
    mark: now?.mark ?? s0?.mark ?? null, oi: now?.oi ?? s0?.oi ?? null, iv: now?.iv ?? s0?.mark_iv ?? null, volume: now?.volume ?? s0?.volume ?? null,
    ceOi: now?.ceOi ?? b0?.ce_oi ?? null, peOi: now?.peOi ?? b0?.pe_oi ?? null,
    callVolume: now?.callVolume ?? b0?.call_volume ?? null, putVolume: now?.putVolume ?? b0?.put_volume ?? null,
    pcr: now?.pcr ?? b0?.pcr_oi ?? null, atmIv: now?.atmIv ?? b0?.atm_iv ?? null,
  };
  const rows = await Promise.all(CHANGE_WINDOWS_MIN.map(async (minutes): Promise<ChangeRow> => {
    const then = nowMs - minutes * 60_000;
    // The five-minute records cannot answer a one-minute window.
    const [s, b] = minutes < 5 ? [null, null] : await Promise.all([snapAt(symbol, then), boardAt(expiry, then)]);
    const spotThen = spotMinutesAgo(minutes, nowMs);
    return {
      minutes,
      spotThen, spotChange: d(cur.spot, spotThen), spotChangePct: pct(cur.spot, spotThen),
      markThen: s?.mark ?? null, markChange: d(cur.mark, s?.mark ?? null), markChangePct: pct(cur.mark, s?.mark ?? null),
      oiThen: s?.oi ?? null, oiChange: d(cur.oi, s?.oi ?? null),
      ivThen: s?.mark_iv ?? null, ivChangePts: cur.iv !== null && s?.mark_iv != null ? (cur.iv - s.mark_iv) * 100 : null,
      volumeThen: s?.volume ?? null, volumeChange: d(cur.volume, s?.volume ?? null),
      ceOiChange: d(cur.ceOi, b?.ce_oi ?? null), peOiChange: d(cur.peOi, b?.pe_oi ?? null),
      callVolumeChange: d(cur.callVolume, b?.call_volume ?? null), putVolumeChange: d(cur.putVolume, b?.put_volume ?? null),
      pcrThen: b?.pcr_oi ?? null, pcrChange: d(cur.pcr, b?.pcr_oi ?? null),
      atmIvThen: b?.atm_iv ?? null, atmIvChangePts: cur.atmIv !== null && b?.atm_iv != null ? (cur.atmIv - b.atm_iv) * 100 : null,
    };
  }));
  // Momentum from the same records the 5-minute row read, plus the bucket before it.
  const m5 = rows.find((r) => r.minutes === 5)?.markThen ?? null;
  const velocity = d(cur.mark, m5);
  const prior = d(m5, s10?.mark ?? null);
  return { now: cur, rows, momentum: { velocity, acceleration: velocity !== null && prior !== null ? velocity - prior : null } };
}
