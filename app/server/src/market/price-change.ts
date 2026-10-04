import { livePerp } from './flow.js';
import { readMarket, spotMinutesAgo } from './moves.js';

/**
 * BTC now against then: how far the price has moved over each window back, and
 * since the desk's own marks -- the first entry of the open positions, and the
 * contract's day start (the previous 17:30 IST settlement).
 *
 * The Live screen's "Price change" card. It was built on 21 Sep 2026 inside the
 * movement read, went with it when the Live screen was trimmed, and came back
 * on its own on 4 Oct 2026 at the owner's request -- the price table only, not
 * the buildup read that sat beside it.
 */

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
 * Each window and mark against the price now: where BTC was then, and the move in
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

/** The table as the screen asks for it: the price now, and every window and mark against it. */
export async function priceChangeNow(nowMs = Date.now(), marks: { entryMs?: number | null; dayStartMs?: number | null } = {}): Promise<{ at: number; spot: number | null; rows: PriceChange[] }> {
  // The candles are cached by the chain route; on a cold process, fetch them once so the windows can be read.
  if (spotMinutesAgo(5, nowMs) === null) await readMarket().catch(() => {});
  const perp = await livePerp(nowMs).catch(() => null);
  const spot = perp?.spot ?? perp?.mark ?? spotMinutesAgo(0, nowMs);
  return { at: nowMs, spot, rows: priceChanges(spot, nowMs, marks) };
}
