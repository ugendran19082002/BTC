import type { Trade, TradeStatus } from '@/types/trade';
import { isLongTrade, longLevels } from '@/lib/long-exits';

/**
 * One open position's risk, for the phone (6 Oct 2026): how far its stop and target are, what each would leave
 * in money, how far liquidation is, how long until it settles, and anything wrong with it that must be seen.
 *
 * Pure, so the arithmetic is tested once. Every distance is measured from the price the desk itself watches
 * (decision 0006): a short is closed by buying, so from the offer; a long by selling, so from the bid. The mark
 * only when the book has no such side.
 */

/** Daily BTC options settle at 12:00 UTC, 17:30 IST. */
const SETTLE_UTC_HOUR = 12;

/** When a dated option settles, from its symbol: `C-BTC-79600-090926` is 9 Sep 2026, 17:30 IST. Null otherwise. */
export function settlementOf(symbol: string): number | null {
  const m = /^[CP]-BTC-\d+-(\d{2})(\d{2})(\d{2})$/.exec(symbol);
  if (!m) return null;
  return Date.UTC(2000 + Number(m[3]), Number(m[2]) - 1, Number(m[1]), SETTLE_UTC_HOUR, 0, 0);
}

/**
 * An exit's level and the room left before it fills. `points` is positive while the exit is still ahead and
 * zero or below once the price is through it; `moneyUsd` is what the position would leave if it filled there,
 * after every charge (the server's `ifExits`), when known.
 */
export type ExitRoom = { level: number; points: number; pct: number | null; moneyUsd: number | null };

export type PositionRisk = {
  long: boolean;
  /** The price leaving costs right now. */
  exitPx: number | null;
  stop: ExitRoom | null;
  target: ExitRoom | null;
  /** A short's liquidation: the level, the points of room, and how many times today's price that level is. */
  liquidation: { level: number; points: number; multiple: number | null } | null;
  settlesAt: number | null;
  /** A signal trade's real exits, on the BTC perp: the levels, and the room left to each from the perp's mark. */
  perp: {
    dir: 1 | -1; stop: number | null; target: number | null; toStop: number | null; toTarget: number | null;
    /** The perp's price as the option filled in, when the trade kept it: where the line between SL and TGT starts. */
    entry: number | null;
  } | null;
  /** What is wrong and must be seen, in the desk's words: an alarm, no stop at all, an exit the exchange refused. */
  problems: string[];
};

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

function room(level: number | null | undefined, px: number | null, ahead: (level: number, px: number) => number, moneyUsd: number | null | undefined): ExitRoom | null {
  if (!finite(level) || !(level > 0)) return null;
  if (!finite(px)) return { level, points: NaN, pct: null, moneyUsd: moneyUsd ?? null };
  const points = ahead(level, px);
  return { level, points, pct: px > 0 ? points / px : null, moneyUsd: moneyUsd ?? null };
}

export function positionRisk(t: Trade, opts: { alarms?: TradeStatus['alarms']; perpMark?: number | null } = {}): PositionRisk {
  const long = isLongTrade(t);
  const live = t.live;
  const mark = live?.markPrice ?? null;
  const exitPx = (long ? live?.bid : live?.ask) ?? mark;

  // A short's exits: what rests at Delta now, else the plan. A long's: its own levels off the price paid,
  // its target resting at Delta when it does.
  const own = long ? longLevels(t.plan, t.entryAvgPrice) : null;
  const stopLevel = long ? own!.stop : (t.onBook?.stop ?? t.plan?.stopPrice ?? null);
  const targetLevel = long ? (t.onBook?.target ?? own!.target) : (t.onBook?.target ?? t.plan?.takeProfitPrice ?? null);

  // A short loses as the price rises: the stop is above, the target below. A long the other way round.
  const stop = room(stopLevel, exitPx, long ? (l, p) => p - l : (l, p) => l - p, t.ifExits?.stop);
  const target = room(targetLevel, exitPx, long ? (l, p) => l - p : (l, p) => p - l, t.ifExits?.target);

  const liq = live?.liquidationPrice ?? null;
  const liquidation = !long && finite(liq) && liq > 0 && finite(mark)
    ? { level: liq, points: liq - mark, multiple: mark > 0 ? liq / mark : null }
    : null;

  const u = t.plan?.underlying ?? null;
  const pm = opts.perpMark ?? null;
  const perp = u
    ? {
        dir: u.dir,
        stop: u.stop,
        target: u.target,
        entry: finite(u.entry) ? u.entry : finite(t.perpEntry) ? t.perpEntry : null,
        // dir 1 is a view that BTC rises: its stop is under the perp and its target over it.
        toStop: finite(pm) && finite(u.stop) ? (u.dir === 1 ? pm - u.stop : u.stop - pm) : null,
        toTarget: finite(pm) && finite(u.target) ? (u.dir === 1 ? u.target - pm : pm - u.target) : null,
      }
    : null;

  const problems: string[] = [];
  for (const a of opts.alarms ?? []) if (a.tradeId === t.tradeId) problems.push(a.message);
  if (t.alarm && !problems.includes(t.alarm)) problems.push(t.alarm);
  if (t.protectionProblem) problems.push(`The exchange would not take an exit: ${t.protectionProblem}`);
  if (t.plan?.exitProblem) problems.push(t.plan.exitProblem);
  // A short with nothing to stop it -- no option stop and no perp stop -- is the one thing the desk must never hide.
  if (!long && t.position !== 0 && stop === null && !(perp && finite(perp.stop))) problems.push('No stop behind this position.');

  return { long, exitPx, stop, target, liquidation, settlesAt: settlementOf(t.symbol), perp, problems };
}

/**
 * How much of the day's loss limit is left, from the status the phone holds: each account's own limit less its
 * own losses, added up on "All accounts" (lib/merge-status.ts); one account's otherwise. Booked losses are what
 * the gate counts (precheck: limit + min(0, realised today)).
 */
const usedOf = (limit: number, left: number) => Math.min(1, Math.max(0, (limit - left) / limit));

export function lossBudget(s: TradeStatus): { limitUsd: number; leftUsd: number; usedPct: number } | null {
  if (s.combined) {
    const { lossLimitUsd, lossLeftUsd } = s.combined;
    return lossLimitUsd > 0 ? { limitUsd: lossLimitUsd, leftUsd: lossLeftUsd, usedPct: usedOf(lossLimitUsd, lossLeftUsd) } : null;
  }
  const limitUsd = s.limits?.maxDailyLossUsd ?? 0;
  if (!(limitUsd > 0)) return null;
  const leftUsd = Math.max(0, limitUsd + Math.min(0, s.realisedTodayUsd ?? 0));
  return { limitUsd, leftUsd, usedPct: usedOf(limitUsd, leftUsd) };
}
