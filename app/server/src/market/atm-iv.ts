import { one } from '../db/pool.js';

/**
 * At-the-money IV at a moment, for the IV spike guard (owner, 21 Nov 2026; `marketGuardWhy`): the mark IV of the call
 * nearest 0.5 delta in the desk's own one-minute board (`option_snapshots_1m`), in the newest minute at or before the
 * moment and no more than ten minutes before it -- the series, and the ten minutes, the 30-day guard study read
 * (docs/research/2026-11-21-entry-guard-study.md), so the guard live meets what was tested. A fraction (0.42 is 42%);
 * null when no such minute was kept.
 *
 * Nothing is asked of Delta: the board is the desk's own record. Each minute is read once and kept a while -- every
 * account's signals in that minute share the answer.
 */
export const ATM_IV_LOOKBACK_MS = 10 * 60_000;
const KEEP = 240;
/** The minute still being written is read again after this long; a minute gone by is kept. */
const FRESH_MS = 15_000;
const memo = new Map<number, { read: Promise<number | null>; until: number }>();

export function atmIvAt(at: number, nowMs = Date.now()): Promise<number | null> {
  const minute = Math.floor(at / 60_000) * 60_000;
  const hit = memo.get(minute);
  if (hit && hit.until > nowMs) return hit.read;
  const read = one<{ iv: number | string | null }>(
    `SELECT mark_iv AS iv FROM option_snapshots_1m
      WHERE at <= $1 AND at > $2 AND cp = 'C' AND mark_iv > 0 AND delta BETWEEN 0.35 AND 0.65
      ORDER BY at DESC, abs(delta - 0.5) LIMIT 1`,
    [minute + 59_999, minute + 59_999 - ATM_IV_LOOKBACK_MS],
  ).then((r) => {
    const v = r?.iv === null || r?.iv === undefined ? null : Number(r.iv);
    // An empty answer for the minute now may fill as the minute is written: not kept, asked again next time.
    if (v === null) memo.delete(minute);
    return v !== null && Number.isFinite(v) && v > 0 ? v : null;
  }, () => { memo.delete(minute); return null; });
  memo.set(minute, { read, until: minute + 60_000 > nowMs - 5_000 ? nowMs + FRESH_MS : Number.POSITIVE_INFINITY });
  while (memo.size > KEEP) memo.delete(memo.keys().next().value!);
  return read;
}

/** ATM IV now and an hour before `at`; either null when not kept. */
export async function atmIvNow(at = Date.now()): Promise<{ now: number | null; hourAgo: number | null }> {
  const [now, hourAgo] = await Promise.all([atmIvAt(at), atmIvAt(at - 3_600_000)]);
  return { now, hourAgo };
}

/** For tests: forget every minute read. */
export function forgetAtmIv(): void { memo.clear(); }
