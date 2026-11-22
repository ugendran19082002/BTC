import type { TradeRecord } from './engine.js';

/**
 * The BTC-move exit (owner, 22 Nov 2026: "build panu best practice"): a sale bought back when BTC runs against it, before
 * its option stop -- for the strikes near the market only.
 *
 * On 22 Nov BTC rose 59,726 → 60,372 (+1.1%) in seven minutes at 14:00 IST, three and a half hours before expiry, and
 * the calls a strike or two out went from ~50 to ~250. The desk's "… time" strategies skip the perp's stop, so their
 * option stop (340% after 13:00) was all there was: 469 stops at 300% or more that day, the largest 938%. A 30-day
 * replay with every setting (docs/research/2026-11-22-sl-jump-study.md) found this rule the best of 41 tried:
 *
 *   BTC against the sale by `pct`% within `minutes` (measured from the entry at most), and the strike within `nearPct`%
 *   of BTC now → bought back at once. 0.8% / 10m / 1.5%: +₹17.9k over 30 days, loss days 3 → 1, stop losses ₹37k less,
 *   the 600%+ stops of 22 Nov 88 → 13. It fired on five days of thirty and changed nothing on the others.
 *
 * "Against": a call sold loses as BTC rises, a put sold as it falls. "Near": the far strikes are left -- they seldom
 * blow up and mostly expire cheap; buying them back only spends the spread (whole-side exits: 2,954 over five days;
 * near only: 1,783, and ₹6.6k more). The closes go the session square-off's way (`TradingService.closeAll`): worst
 * first, a few hands, never two on one contract, the quota gate.
 *
 * Default off; set per account. Reads only what the desk holds in memory -- the perp's price as the socket last heard it,
 * sampled here every few seconds -- and never asks Delta anything until it closes.
 */

/** The setting, kept per account (`MOVE_EXIT_KEY`): off, or the move, its window and how near a strike must be. */
export type MoveExit = { on: boolean; pct: number; minutes: number; nearPct: number };
export const MOVE_EXIT_KEY = 'signal_move_exit';
/** What the study chose (0.8% in 10 minutes, strikes within 1.5%), offered when it is switched on. Off until then. */
export const MOVE_EXIT_DEFAULT: MoveExit = { on: false, pct: 0.8, minutes: 10, nearPct: 1.5 };
/** The ranges a setting may take: typo guards. */
export const MOVE_PCT_MIN = 0.2, MOVE_PCT_MAX = 5;
export const MOVE_MINUTES_MIN = 1, MOVE_MINUTES_MAX = 60;
export const MOVE_NEAR_MIN = 0.2, MOVE_NEAR_MAX = 10;
/** How often the watch looks. A look is memory only: open trades, the perp's samples. */
export const MOVE_EXIT_TICK_MS = 5_000;
/** The perp's price is only "now" if the socket heard it this recently; else nothing is judged. */
export const MOVE_PERP_FRESH_MS = 15_000;
/** How long the perp's samples are kept: the longest window and a margin. */
export const MOVE_HISTORY_MS = (MOVE_MINUTES_MAX + 5) * 60_000;

/** What is wrong with a setting, in words; empty when it can be kept. */
export function moveExitProblems(x: unknown): string[] {
  if (!x || typeof x !== 'object') return ['Give the switch, the move, the minutes and how near.'];
  const v = x as Partial<MoveExit>;
  const bad: string[] = [];
  const num = (n: unknown, lo: number, hi: number) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
  if (typeof v.on !== 'boolean') bad.push('The switch is on or off.');
  if (!num(v.pct, MOVE_PCT_MIN, MOVE_PCT_MAX)) bad.push(`The BTC move is ${MOVE_PCT_MIN}% to ${MOVE_PCT_MAX}%.`);
  if (!num(v.minutes, MOVE_MINUTES_MIN, MOVE_MINUTES_MAX) || !Number.isInteger(v.minutes)) bad.push(`The window is ${MOVE_MINUTES_MIN} to ${MOVE_MINUTES_MAX} whole minutes.`);
  if (!num(v.nearPct, MOVE_NEAR_MIN, MOVE_NEAR_MAX)) bad.push(`How near a strike must be is ${MOVE_NEAR_MIN}% to ${MOVE_NEAR_MAX}% of BTC.`);
  return bad;
}

/** A kept setting, read: anything that will not read is off, with the study's numbers. */
export function parseMoveExit(raw: string | null | undefined): MoveExit {
  if (!raw) return MOVE_EXIT_DEFAULT;
  try {
    const v = JSON.parse(raw) as MoveExit;
    return moveExitProblems(v).length ? MOVE_EXIT_DEFAULT : { on: v.on, pct: v.pct, minutes: v.minutes, nearPct: v.nearPct };
  } catch {
    return MOVE_EXIT_DEFAULT;
  }
}

/** One sale the rule buys back, and why in numbers. */
export type MovePick = { tradeId: string; side: 'CE' | 'PE'; strike: number; movePct: number; fromPx: number; nowPx: number; nearPct: number };

/**
 * The sales to buy back now (pure): each open short on a strategy, not already closing, whose side BTC has run against by
 * `pct`% since `max(now − minutes, its entry)`, with its strike within `nearPct`% of BTC now. `pxAt` is the perp's price
 * at or before a moment, null where it is not known -- and nothing is judged on a price not known.
 */
export function movePicks(
  trades: readonly Pick<TradeRecord, 'state' | 'plan'>[],
  s: MoveExit,
  now: number,
  nowPx: number,
  pxAt: (ms: number) => number | null,
): MovePick[] {
  if (!s.on || !(nowPx > 0)) return [];
  const out: MovePick[] = [];
  for (const t of trades) {
    const { state, plan } = t;
    if (state.position >= 0 || state.closing || plan.action === 'buy' || plan.origin !== 'strategy') continue;
    const side = plan.expect?.optionSide ?? plan.optionSide;
    const strike = plan.expect?.strike;
    if ((side !== 'CE' && side !== 'PE') || !(typeof strike === 'number' && strike > 0)) continue;
    const near = (Math.abs(strike - nowPx) / nowPx) * 100;
    if (near > s.nearPct) continue;
    const enteredAt = firstEntryAt(state) ?? now;
    const fromPx = pxAt(Math.max(now - s.minutes * 60_000, enteredAt));
    if (fromPx === null || !(fromPx > 0)) continue;
    const movePct = ((nowPx - fromPx) / fromPx) * 100;
    const against = side === 'CE' ? movePct >= s.pct : movePct <= -s.pct;
    if (against) out.push({ tradeId: state.tradeId, side, strike, movePct, fromPx, nowPx, nearPct: near });
  }
  return out;
}

/** When the trade's position was first sold: its first entry fill, else null. */
function firstEntryAt(state: TradeRecord['state']): number | null {
  const ts = (state.fills ?? []).filter((f) => f.role === 'entry' && f.side === 'sell').map((f) => f.ts).filter((x) => x > 0);
  return ts.length ? Math.min(...ts) : null;
}

/** The close reason the trade keeps, in the desk's words: "btc move exit: BTC +0.84% in 10 min, the 60400 CE 0.3% away". */
export const moveExitWhy = (p: MovePick, minutes: number): string =>
  `btc move exit: BTC ${p.movePct >= 0 ? '+' : ''}${p.movePct.toFixed(2)}% in ${minutes} min against the ${p.strike} ${p.side}, ${p.nearPct.toFixed(1)}% away`;

export type MoveExitDeps = {
  setting: () => MoveExit;
  openTrades: () => Promise<Pick<TradeRecord, 'state' | 'plan'>[]>;
  /** The perp's last trade as the socket heard it, and when; null with none. */
  perpNow: () => { price: number; at: number } | null;
  /** The perp's price in a past minute from the record (`perpAtMinutes`), for a window older than the samples kept. */
  perpAtMinute?: (minute: number) => Promise<number | null>;
  /** Buy these back, the session square-off's way, each with its reason. */
  close: (picks: readonly MovePick[], why: (p: MovePick) => string) => Promise<{ closed: string[]; failed: { tradeId: string; reason: string }[] }>;
  /** Said once a look closes anything: the phone, the log. */
  said?: (r: { picks: MovePick[]; closed: number; failed: number; s: MoveExit; at: number }) => void;
  now?: () => number;
};

/**
 * The watch: samples the perp every look, and buys back what `movePicks` names. One close at a time per trade: a trade
 * being closed is not named again until that close is done.
 */
export class MoveExitWatch {
  private samples: { at: number; px: number }[] = [];
  private readonly closing = new Set<string>();
  private readonly minuteCache = new Map<number, number | null>();
  private ticking = false;
  /** The closes sent by the last look that named any, while they run: for a test to wait on. */
  private running: Promise<void> | null = null;

  constructor(private readonly d: MoveExitDeps) {}

  /** The closes still running, if any; resolved at once when none are. */
  closesDone(): Promise<void> { return this.running ?? Promise.resolve(); }

  private now(): number { return this.d.now ? this.d.now() : Date.now(); }

  /** The perp's price at or before `ms`: the newest sample at or before it, if the samples reach back that far. */
  private sampleAt(ms: number): number | null {
    const xs = this.samples;
    if (!xs.length || xs[0]!.at > ms) return null;
    let lo = 0, hi = xs.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (xs[m]!.at <= ms) { k = m; lo = m + 1; } else hi = m - 1; }
    // A sample a minute older than the moment is no price for it.
    return k >= 0 && ms - xs[k]!.at <= 60_000 ? xs[k]!.px : null;
  }

  /** One look. Never throws. Returns the trades it sent to be closed. */
  async tick(): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      const now = this.now();
      const p = this.d.perpNow();
      const fresh = p && p.price > 0 && now - p.at <= MOVE_PERP_FRESH_MS ? p : null;
      if (fresh) {
        this.samples.push({ at: fresh.at, px: fresh.price });
        while (this.samples.length && now - this.samples[0]!.at > MOVE_HISTORY_MS) this.samples.shift();
      }
      const s = this.d.setting();
      if (!s.on || !fresh) return [];
      const trades = (await this.d.openTrades()).filter((t) => !this.closing.has(t.state.tradeId));
      // Older than the samples kept (a restart): the record's minute, read once a minute.
      const needed = new Set<number>();
      const pxAt = (ms: number): number | null => {
        const got = this.sampleAt(ms);
        if (got !== null) return got;
        const minute = Math.floor(ms / 60_000) * 60_000;
        if (this.minuteCache.has(minute)) return this.minuteCache.get(minute)!;
        needed.add(minute);
        return null;
      };
      let picks = movePicks(trades, s, now, fresh.price, pxAt);
      if (needed.size && this.d.perpAtMinute) {
        for (const m of needed) this.minuteCache.set(m, await this.d.perpAtMinute(m).catch(() => null));
        if (this.minuteCache.size > 240) for (const k of [...this.minuteCache.keys()].slice(0, 120)) this.minuteCache.delete(k);
        picks = movePicks(trades, s, now, fresh.price, pxAt);
      }
      if (!picks.length) return [];
      for (const x of picks) this.closing.add(x.tradeId);
      // Not waited on: the closes can take a minute or two, and the perp is sampled on meanwhile.
      const run = (async () => {
        try {
          const done = await this.d.close(picks, (x) => moveExitWhy(x, s.minutes));
          try { this.d.said?.({ picks, closed: done.closed.length, failed: done.failed.length, s, at: now }); } catch { /* a message never stops a close */ }
        } catch { /* the trades stay open, with their own stops; the next look may name them again */ } finally {
          for (const x of picks) this.closing.delete(x.tradeId);
        }
      })();
      const tracked: Promise<void> = run.finally(() => { if (this.running === tracked) this.running = null; });
      this.running = tracked;
      return picks.map((x) => x.tradeId);
    } catch {
      return [];
    } finally {
      this.ticking = false;
    }
  }
}
