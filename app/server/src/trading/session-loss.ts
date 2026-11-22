import { USDINR } from '../domain/score.js';
import { istDate, startOfDayIst } from '../strategy/schedule.js';

/**
 * A loss limit by the session, per account (owner, 4 Nov 2026: "a daily loss limit of another kind on the desk's open
 * positions -- by the session, an hour at a time: 7:00 to 8:00 AM, say, ₹1,000 on an account; if that account loses it
 * in that time, square the whole account off. Set for each hour; default off, on every account").
 *
 * A session is a stretch of the IST day, `from` to `to` (the end not included), with a limit in rupees. What it has lost
 * is the account's day -- booked, open as if closed now (bought back at the ask, 5 Nov 2026), less charges paid and to
 * close, as the header's "Net today" (`todayFigures`) -- now,
 * against the same figure when the session began (the day's line, `mtm_samples`, at or before its start). A position
 * entered before the session that goes bad inside it is the session's loss; a profit booked before it is not spent by it.
 *
 * At the limit, held for `HOLD_MS` so a cheap option's ask flicking for a second is not a square-off, the account is
 * squared off (`closeAll`: working entries pulled, every position bought back, one at a time) and takes **no new entry
 * for the rest of the IST day** (owner, same day: "once a session's limit is hit, that day's trading stops in full; the
 * next day it runs as usual"). Nothing else changes -- the other accounts, the next day, the day's own loss budget.
 */

/**
 * A session and its limit: rupees (`inr`), or a per cent (`pct`) of the money the account's "At most open" needs -- that
 * setting (the cap over all its strategies, `signal_max_open`) times the margin one position takes, read when the
 * session begins and fixed for it (owner, 4 Nov 2026: "not the wallet -- it may hold extra money; At most open 200 is
 * about ₹8,000: the % of that").
 */
export type SessionRule = { from: string; to: string; limit: number; unit: 'inr' | 'pct' };
/**
 * `pauseAt` (owner, 22 Nov 2026, "1 2 3 4 build panu"): new entries held once the session's loss reaches this per cent of
 * its limit -- the positions held are left as they are -- and let go again once it is back `PAUSE_RESUME_GAP_PCT` under
 * it. Absent or null: off, the default.
 */
export type SessionLoss = { on: boolean; sessions: SessionRule[]; pauseAt?: number | null };

/** Where an account's sessions are kept (`accountKey`): no row, or one that will not read, is off with none. */
export const SESSION_LOSS_KEY = 'session_loss_limit';
/** Where a session's limit in rupees is kept once worked out (`accountKey`): a restart in the session reads it back. */
export const SESSION_FIXED_KEY = 'session_loss_fixed';
export const SESSION_LOSS_OFF: SessionLoss = { on: false, sessions: [] };
/** At most this many sessions: an hour each is 24. */
export const MAX_SESSIONS = 24;
/** The most a session's limit may be, in rupees or per cent: typo guards. */
export const MAX_SESSION_LIMIT_INR = 10_000_000;
export const MAX_SESSION_LIMIT_PCT = 100;
/** The near-limit pause's range, per cent of the limit (`SessionLoss.pauseAt`). */
export const PAUSE_AT_MIN = 50;
export const PAUSE_AT_MAX = 99;
/**
 * Paused at `pauseAt`, entries come back only once the loss is this many points of the limit under it -- 90% pauses,
 * 85% lets go -- so a loss sitting on the line does not pause and free entries every five seconds.
 */
export const PAUSE_RESUME_GAP_PCT = 5;
/**
 * Said once a session, on the phone, when its loss first reaches this share of its limit (owner, 22 Nov 2026): time to
 * look before the square-off, not after it.
 */
export const WARN_AT_PCT = 80;
/**
 * The short hold far over the line only on a fresh board (22 Nov 2026): every open position's quote no older than this.
 * A quote gone stale can read the loss far over the line when it is not; then the whole hold stands.
 */
export const FAST_QUOTE_MAX_AGE_MS = 10_000;
/** How long the loss must stay at or over the limit before the account is squared off. */
export const HOLD_MS = 15_000;
/**
 * Far over the line, the hold is short (owner, 22 Nov 2026: "A + B + C build panu"). On 21 Nov Medium was ₹254 over
 * its ₹3,898 line (6.5%) by the time its 15 s were up, and Low ₹172 over (4.4%): a fast fall spends the hold. A loss at
 * or over the line by `FAST_OVER_PCT` of it, seen so on two reads in a row (the guard looks every 5 s,
 * `SESSION_LOSS_TICK_MS`), is squared off then. Just over the line, the whole hold still applies -- the flick of a cheap
 * option's ask that the hold is for.
 */
export const FAST_OVER_PCT = 3;
/** At least this long over the line, far over it, before the square-off: more than one read, less than two ticks. */
export const FAST_HOLD_MS = 4_000;
/** How often an account's session is checked. */
export const SESSION_LOSS_TICK_MS = 5_000;
/**
 * How far over the loss so far a lowered line must stay, in a running session (owner, 21 Nov 2026: "18% to 17%: if the
 * loss is under 17%'s line, allow; else after the session" -- with this room, so the next burst of stops does not square
 * the account off seconds after the save: High's loss rose ₹268 in eight minutes that morning).
 */
export const LOWER_CUSHION_INR = 250;
/**
 * A square-off that left positions open is tried again this often, only on the trades it could not close, until the
 * account is flat or the day is over (7 Nov 2026). Not every tick: a close refused for Delta's rate limit wants the window
 * to empty, and asking again at once keeps it full.
 */
export const SQUARE_OFF_RETRY_MS = 15_000;
/**
 * Read this soon after its start, a session's starting figure is the live one -- the same sum the loss is then read by,
 * so the two never differ by how each values the open trades. Later (a restart mid-session), the day's line at the start.
 */
export const BASELINE_LIVE_MS = 30_000;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const IST_MS = 5.5 * 3_600_000;
/** The IST minute of the day a moment falls in, 0 to 1,439. */
export const istMinuteOf = (ms: number) => Math.floor(((ms + IST_MS) % 86_400_000) / 60_000);

/** What is wrong with a session-loss setting, in words; empty when it can be kept. */
export function sessionLossProblems(x: unknown): string[] {
  const bad: string[] = [];
  if (!x || typeof x !== 'object') return ['Give the switch and the sessions.'];
  const v = x as { on?: unknown; sessions?: unknown };
  if (typeof v.on !== 'boolean') bad.push('The switch is on or off.');
  if (!Array.isArray(v.sessions)) return [...bad, 'The sessions are a list.'];
  if (v.sessions.length > MAX_SESSIONS) bad.push(`At most ${MAX_SESSIONS} sessions.`);
  const pauseAt = (x as { pauseAt?: unknown }).pauseAt;
  if (pauseAt !== undefined && pauseAt !== null
    && (typeof pauseAt !== 'number' || !Number.isFinite(pauseAt) || pauseAt < PAUSE_AT_MIN || pauseAt > PAUSE_AT_MAX)) {
    bad.push(`Pause new entries at ${PAUSE_AT_MIN}% to ${PAUSE_AT_MAX}% of the limit, or off.`);
  }
  const ok: { from: number; to: number; n: number }[] = [];
  v.sessions.forEach((s, i) => {
    const n = i + 1;
    const r = s as Partial<SessionRule> | null;
    if (!r || typeof r.from !== 'string' || typeof r.to !== 'string' || !HHMM.test(r.from) || !HHMM.test(r.to)) {
      bad.push(`Session ${n}: give both times, as HH:MM (IST).`);
      return;
    }
    if (minutesOf(r.from) >= minutesOf(r.to)) bad.push(`Session ${n}: it must end after it starts, the same day (${r.from} – ${r.to}).`);
    if (r.unit !== 'inr' && r.unit !== 'pct') bad.push(`Session ${n}: the limit is in ₹ or %.`);
    else if (typeof r.limit !== 'number' || !Number.isFinite(r.limit) || r.limit <= 0) bad.push(`Session ${n}: the limit must be above 0.`);
    else if (r.unit === 'inr' && r.limit > MAX_SESSION_LIMIT_INR) bad.push(`Session ${n}: at most ₹${MAX_SESSION_LIMIT_INR.toLocaleString('en-IN')}.`);
    else if (r.unit === 'pct' && r.limit > MAX_SESSION_LIMIT_PCT) bad.push(`Session ${n}: at most ${MAX_SESSION_LIMIT_PCT}% of the "At most open" margin.`);
    ok.push({ from: minutesOf(r.from), to: minutesOf(r.to), n });
  });
  // Two sessions over the same minute could not say whose loss it was.
  const sorted = [...ok].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.from < sorted[i - 1]!.to) bad.push(`Sessions ${sorted[i - 1]!.n} and ${sorted[i]!.n} overlap.`);
  }
  return bad;
}

/** A kept setting, read: anything that will not read is off. Sessions in the order of the day. */
export function parseSessionLoss(raw: string | null | undefined): SessionLoss {
  if (!raw) return SESSION_LOSS_OFF;
  try {
    const v = JSON.parse(raw) as SessionLoss;
    if (sessionLossProblems(v).length) return SESSION_LOSS_OFF;
    return {
      on: v.on,
      sessions: [...v.sessions].sort((a, b) => minutesOf(a.from) - minutesOf(b.from)).map((s) => ({ from: s.from, to: s.to, limit: s.limit, unit: s.unit })),
      ...(typeof v.pauseAt === 'number' ? { pauseAt: v.pauseAt } : {}),
    };
  } catch {
    return SESSION_LOSS_OFF;
  }
}

/** The session a moment falls in, with when it began and ends that day; null outside every session. */
export function sessionAt(rules: readonly SessionRule[], ms: number): { rule: SessionRule; startMs: number; endMs: number } | null {
  const m = istMinuteOf(ms);
  const rule = rules.find((r) => m >= minutesOf(r.from) && m < minutesOf(r.to));
  if (!rule) return null;
  const day = startOfDayIst(ms);
  return { rule, startMs: day + minutesOf(rule.from) * 60_000, endMs: day + minutesOf(rule.to) * 60_000 };
}

export type SessionHit = {
  day: string; from: string; to: string; limitInr: number; lossInr: number; at: number;
  closed: number; cancelled: number; failed: number; detail: string;
};

/** What the screen is told: the setting, and the session now -- its loss against its limit, and whether it was hit. */
export type SessionLossNow = {
  from: string; to: string; limit: number; unit: 'inr' | 'pct';
  /** The limit in rupees: the amount, or the per cent of the "At most open" margin at the session's start; null until it is read. */
  limitInr: number | null;
  /** Lost since the session began, in rupees; null until it has been read. Negative is a gain. */
  lossInr: number | null;
  /** Squared off this session: no new entry today. */
  hit: boolean;
  /** The loss at or over the limit since this moment, waiting `HOLD_MS` before the square-off. */
  breachSince: number | null;
  /** New entries held near the limit (`SessionLoss.pauseAt`); absent: not held. */
  entriesPaused?: boolean;
} | null;

/** Said once a session at `WARN_AT_PCT` of its limit, and when new entries are held near it (`pauseAt`). */
export type SessionNear = { from: string; to: string; limitInr: number; lossInr: number; pct: number; at: number };

/**
 * Working the session's limit out again, by hand (owner, 20 Nov 2026: Low's lots went from 1 to 2 at 07:05, five minutes
 * into the 07:00 session, and its limit stayed the 1-lot figure -- ₹1,430 against Medium's ₹2,860 -- until the rule was
 * changed 18% → 19% → 18% to make the guard work it out again; "a recompute button, so I update it myself"). What it would
 * become, or why it will not: `ok` with the limit before and after and the loss so far, else the reason in words.
 */
export type RecomputeAnswer =
  /** `lowers`: the new line is under the one in force -- never made in the session (`recompute`); said, for the screen. */
  | { ok: true; from: string; to: string; limit: number; beforeInr: number | null; afterInr: number; lossInr: number; lowers: boolean }
  | { ok: false; reason: string };

/** What a new entry is told, the day a session's limit stopped the account. */
const whyOf = (h: Pick<SessionHit, 'from' | 'to' | 'lossInr' | 'limitInr'>) =>
  `The ${h.from}–${h.to} session lost ₹${Math.round(h.lossInr).toLocaleString('en-IN')}, at its ₹${Math.round(h.limitInr).toLocaleString('en-IN')} limit: the account was squared off and takes no new entry today.`;

export type SessionGuardDeps = {
  now: () => number;
  rule: () => SessionLoss;
  /** What a limit in per cent is of, USD: "At most open" × the margin one position takes; null with none set. */
  pctBaseUsd: () => Promise<number | null>;
  /** The account's day so far, USD: booked + open at the mark − charges ("Net today"). */
  netUsd: () => Promise<number>;
  /** The same figure as the day's line had it at or before `atMs`; null with no reading then (none taken yet: 0). */
  netUsdAt: (atMs: number) => Promise<number | null>;
  /** Every open trade on the account bought back and every working entry pulled; with `only`, just those trades. */
  squareOff: (only?: readonly string[]) => Promise<{ closed: string[]; cancelled: string[]; failed: { tradeId: string; reason: string }[]; report?: string }>;
  /** Where the session's limit in rupees is kept once worked out, by session and rule; none kept: null. */
  fixedLimit?: { get: (key: string) => Promise<number | null>; set: (key: string, limitInr: number) => Promise<void> };
  /** Said after each retry of a square-off: how many trades are still open, and how many tries so far. */
  retried?: (left: number, tries: number) => void;
  record: (hit: SessionHit) => Promise<void>;
  /** The square-offs written down for a day (`record`): what a restart reads to stay stopped. */
  hitsOn: (day: string) => Promise<SessionHit[]>;
  /** Said once a hit: the phone, the log. */
  said: (hit: SessionHit) => void;
  /**
   * What a per cent is of, worked out as at a session's start: "At most open" × the desk's model of a position's margin
   * × the lots the account's strategies trade now -- never Delta's measured margin of the positions held, so a limit
   * worked out again in the session is the one the next session's start would give (`recompute`). Null: none set.
   */
  pctModelUsd?: () => Promise<number | null>;
  /** Said once a limit is worked out again by hand: the phone, the log. */
  recomputed?: (r: Extract<RecomputeAnswer, { ok: true }>) => void;
  /**
   * The oldest quote among the account's open positions, in ms (22 Nov 2026): the short hold far over the line is had only
   * while it is at most `FAST_QUOTE_MAX_AGE_MS`. Null: a position with no quote at all. Absent (a test): taken as fresh.
   */
  quoteAgeMs?: () => Promise<number | null>;
  /** Said once a session, when its loss first reaches `WARN_AT_PCT` of its limit: the phone, the log. */
  warned?: (w: SessionNear) => void;
  /**
   * New entries held near the limit (`pauseAt`, `on`) or let go (`on: false`); `first`: the first hold this session --
   * the one said on the phone. Every change goes to the log.
   */
  entriesPaused?: (p: SessionNear & { on: boolean; first: boolean }) => void;
};

/** Why a lower line may not be had now, in words; null when it may (`LOWER_CUSHION_INR`). A loss not read: not allowed. */
function lowerProblem(from: string, to: string, beforeInr: number, afterInr: number, lossInr: number): string | null {
  const rs = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
  if (!Number.isFinite(lossInr)) return `The session's loss is not read yet, so the limit cannot be lowered now (it is ${rs(beforeInr)}). Try again in a few seconds, or lower it after ${to}.`;
  if (lossInr + LOWER_CUSHION_INR <= afterInr) return null;
  const least = Math.max(0, lossInr) + LOWER_CUSHION_INR;
  return `Not lowered: the ${from}–${to} session has lost ${rs(Math.max(0, lossInr))}, and ${rs(afterInr)} would leave less than ${rs(LOWER_CUSHION_INR)} of room. In this session the limit can go down to ${rs(least)} at the lowest (it is ${rs(beforeInr)}); lower it further after ${to}.`;
}

/**
 * One account's session guard. `tick` reads the session now and squares the account off at its limit; `entryBlock`
 * says why a new entry must wait, while a hit session lasts.
 */
export class SessionLossGuard {
  private baseline: { key: string; usd: number; limitInr: number | null; limitFor: string } | null = null;
  /** A square-off that left trades open: those trades, tried again from `nextAt` (`SQUARE_OFF_RETRY_MS`). Null ids: all. */
  private owed: { ids: string[] | null; nextAt: number; tries: number } | null = null;
  private breachSince: number | null = null;
  /** The sessions hit, by day and start: each squared off once. */
  private readonly hits = new Set<string>();
  private lockedUntil = 0;
  private lockedWhy = '';
  private last: SessionLossNow = null;
  private lastKey = '';
  /** The sessions warned at `WARN_AT_PCT`, by day and start: each once. */
  private readonly warnedKeys = new Set<string>();
  /** New entries held near the limit in this session (`pauseAt`): the session's key and the words said for it. */
  private nearPause: { key: string; why: string } | null = null;
  /** The sessions whose pause was said on the phone: each once, however often it pauses and lets go. */
  private readonly pauseSaid = new Set<string>();
  private ticking = false;

  constructor(private readonly d: SessionGuardDeps) {}

  /** After a restart: a day already stopped stays stopped (the hits written down today). */
  async restore(now = this.d.now()): Promise<void> {
    const day = istDate(now);
    const today = await this.d.hitsOn(day).catch(() => [] as SessionHit[]);
    if (!today.length) return;
    for (const h of today) this.hits.add(`${day}|${h.from}`);
    const first = [...today].sort((a, b) => a.at - b.at)[0]!;
    this.lockedUntil = startOfDayIst(now) + 86_400_000;
    this.lockedWhy = whyOf(first);
    // A square-off that left trades open before the restart: tried again, on every trade the desk still holds (no new
    // entry has been taken since the hit, so those are the ones it was closing).
    if (today.some((h) => h.failed > 0)) this.owed = { ids: null, nextAt: now, tries: 0 };
  }

  /** Why a new entry must wait, or null: a session was squared off today, and today is not over. */
  entryBlock(now = this.d.now()): string | null {
    if (now < this.lockedUntil) return this.lockedWhy;
    // Held near the limit, in the session it was held in (`pauseAt`): read off the guard's last look, every 5 s.
    const cfg = this.d.rule();
    const s = cfg.on ? sessionAt(cfg.sessions, now) : null;
    if (this.nearPause && s && this.nearPause.key === `${istDate(now)}|${s.rule.from}` && typeof cfg.pauseAt === 'number') return this.nearPause.why;
    return null;
  }

  /** The session now, for the screen. */
  status(now = this.d.now()): SessionLossNow {
    const cfg = this.d.rule();
    if (!cfg.on) return null;
    const s = sessionAt(cfg.sessions, now);
    if (!s) return null;
    const key = `${istDate(now)}|${s.rule.from}`;
    const read = this.last && this.lastKey === key ? this.last : null;
    return {
      from: s.rule.from, to: s.rule.to, limit: s.rule.limit, unit: s.rule.unit,
      limitInr: read?.limitInr ?? (s.rule.unit === 'inr' ? s.rule.limit : null),
      lossInr: read?.lossInr ?? null, hit: this.hits.has(key), breachSince: read ? this.breachSince : null,
      ...(this.nearPause?.key === key && typeof cfg.pauseAt === 'number' ? { entriesPaused: true } : {}),
    };
  }

  /** What `recompute` would make the session's limit now -- nothing changed. */
  recomputePreview(now = this.d.now()): Promise<RecomputeAnswer> {
    return this.alone(() => this.recomputeNow(now, false));
  }

  /**
   * Work the session's limit out again now, from the lots the strategies trade now (`pctModelUsd`), and keep it for the
   * rest of the session -- across a restart too (`fixedLimit`). Refused, with the reason: outside a session; on a day
   * already squared off (a recompute never opens an account the limit stopped); for a limit in rupees (lots do not
   * change it); with nothing to work it out from; before the session's first reading; and when the loss so far is
   * already at or over the new limit -- that would square the account off the moment it was pressed.
   */
  recompute(now = this.d.now()): Promise<RecomputeAnswer> {
    return this.alone(() => this.recomputeNow(now, true));
  }

  /**
   * Whether a setting about to be saved would lower the running session's line, and why in words; null when it would
   * not (owner, 21 Nov 2026: "lowering % allow pannatha, highering % mattum allow"). In a session the line only goes up:
   * a lower one could square the account off fifteen seconds after a save. Not in a session, the session already squared
   * off, or the line not read yet: nothing to lower. Off, or no session at this hour in the new setting, lowers nothing.
   */
  async wouldLower(next: SessionLoss, now = this.d.now()): Promise<string | null> {
    const cur = this.status(now);
    if (!cur || cur.hit || cur.limitInr === null || now < this.lockedUntil) return null;
    const key = `${istDate(now)}|${cur.from}`;
    const s = next.on ? sessionAt(next.sessions, now) : null;
    if (!s) return null;
    let afterInr: number | null;
    if (s.rule.unit === 'inr') afterInr = s.rule.limit;
    else {
      const base = await (this.d.pctModelUsd ?? this.d.pctBaseUsd)().catch(() => null);
      afterInr = base !== null && base > 0 ? (s.rule.limit / 100) * base * USDINR : null;
    }
    if (afterInr === null || afterInr >= cur.limitInr - 1) return null;
    // Lower: allowed while the loss so far stays `LOWER_CUSHION_INR` under the new line -- read now, not off the last look.
    const lossInr = this.baseline?.key === key ? (this.baseline.usd - await this.d.netUsd().catch(() => NaN)) * USDINR : NaN;
    return lowerProblem(cur.from, cur.to, cur.limitInr, afterInr, lossInr);
  }

  /** One at a time with the guard's own tick: the tick is skipped while this runs, and this waits out a tick (3 s at most). */
  private async alone<T>(f: () => Promise<T>): Promise<T> {
    for (let i = 0; this.ticking && i < 60; i++) await new Promise((r) => setTimeout(r, 50));
    if (this.ticking) throw new Error('The session guard is busy: try again in a moment.');
    this.ticking = true;
    try { return await f(); } finally { this.ticking = false; }
  }

  private async recomputeNow(now: number, apply: boolean): Promise<RecomputeAnswer> {
    const cfg = this.d.rule();
    const s = cfg.on ? sessionAt(cfg.sessions, now) : null;
    if (!s) return { ok: false, reason: 'No session is running now: the next one works its limit out when it begins.' };
    if (now < this.lockedUntil) return { ok: false, reason: `Stopped for today: ${this.lockedWhy}` };
    if (s.rule.unit !== 'pct') return { ok: false, reason: 'This session\'s limit is an amount in rupees: lots do not change it.' };
    const key = `${istDate(now)}|${s.rule.from}`;
    if (this.hits.has(key)) return { ok: false, reason: 'This session was squared off: the account takes no new entry today.' };
    if (this.baseline?.key !== key) return { ok: false, reason: 'The session is still being read: try again in a few seconds.' };
    const base = await this.d.pctModelUsd?.().catch(() => null) ?? null;
    if (base === null || !(base > 0)) return { ok: false, reason: 'Nothing to work it out from: set "At most open" on this account, or wait for a price.' };
    const afterInr = (s.rule.limit / 100) * base * USDINR;
    const lossInr = (this.baseline.usd - await this.d.netUsd()) * USDINR;
    const beforeInr = this.baseline.limitInr;
    // Nothing to change: said, rather than a press that moves the line by a rupee (21 Nov 2026: pressed four times).
    if (beforeInr !== null && Math.abs(afterInr - beforeInr) < 1) {
      return { ok: false, reason: `Already ₹${Math.round(afterInr).toLocaleString('en-IN')}: with the lots traded now it works out the same.` };
    }
    if (lossInr >= afterInr) {
      return { ok: false, reason: `The session has lost ₹${Math.round(lossInr).toLocaleString('en-IN')} already, at or over the new limit of ₹${Math.round(afterInr).toLocaleString('en-IN')}: working it out again would square the account off at once.` };
    }
    const lowers = beforeInr !== null && afterInr < beforeInr;
    const answer = { ok: true as const, from: s.rule.from, to: s.rule.to, limit: s.rule.limit, beforeInr, afterInr, lossInr, lowers };
    /*
     * Lower only with room (21 Nov 2026: a recompute took High from ₹3,856 to ₹3,158 and the account was squared off at
     * ₹3,212 eight minutes on): the loss so far must stay `LOWER_CUSHION_INR` under the new line, preview and act alike.
     */
    if (lowers) {
      const problem = lowerProblem(s.rule.from, s.rule.to, beforeInr!, afterInr, lossInr);
      if (problem) return { ok: false, reason: problem };
    }
    if (!apply) return answer;
    const limitFor = `${s.rule.unit}:${s.rule.limit}`;
    this.baseline = { ...this.baseline, limitInr: afterInr, limitFor };
    await this.d.fixedLimit?.set(`${key}|${limitFor}`, afterInr).catch(() => {});
    this.breachSince = null;
    if (this.last && this.lastKey === key) this.last = { ...this.last, limitInr: afterInr, lossInr, breachSince: null };
    try { this.d.recomputed?.(answer); } catch { /* a message is never worth the change */ }
    return answer;
  }

  async tick(): Promise<SessionHit | null> {
    if (this.ticking) return null;
    this.ticking = true;
    try {
      return await this.tickNow();
    } finally {
      this.ticking = false;
    }
  }

  private async tickNow(): Promise<SessionHit | null> {
    const now = this.d.now();
    const cfg = this.d.rule();
    const s = cfg.on ? sessionAt(cfg.sessions, now) : null;
    if (!s) { this.breachSince = null; this.last = null; this.nearPause = null; return null; }
    // Stopped for the day: what a square-off could not close is tried again, then nothing more to read until tomorrow.
    if (now >= this.lockedUntil) this.owed = null;
    if (this.owed && now >= this.owed.nextAt) await this.retrySquareOff(now);
    if (now < this.lockedUntil) return null;
    const day = istDate(now);
    const key = `${day}|${s.rule.from}`;
    if (this.hits.has(key)) return null;
    // The day's figure when the session began, read once a session; a restart reads it again off the day's line.
    // The rule the line is for: a limit changed in the session is worked out again; the same rule keeps its line.
    const limitFor = `${s.rule.unit}:${s.rule.limit}`;
    if (this.baseline?.key !== key) {
      const usd = now - s.startMs <= BASELINE_LIVE_MS ? await this.d.netUsd() : (await this.d.netUsdAt(s.startMs)) ?? 0;
      this.baseline = { key, usd, limitInr: null, limitFor };
      this.breachSince = null;
    }
    if (this.baseline.limitFor !== limitFor) this.baseline = { ...this.baseline, limitInr: null, limitFor };
    // The line in rupees, fixed for the session: the amount, or the per cent of the "At most open" margin as first read --
    // kept (`fixedLimit`), so a restart in the session reads the same line back rather than the base as it is by then.
    if (this.baseline.limitInr === null) {
      const kept = `${key}|${limitFor}`;
      const before = s.rule.unit === 'pct' ? await this.d.fixedLimit?.get(kept).catch(() => null) ?? null : null;
      if (before !== null) this.baseline.limitInr = before;
      else {
        // One way, wherever the line is worked out -- the session's start, a rule changed in it, a recompute (21 Nov 2026):
        // the model of a position's margin × the lots set (`pctModelUsd`). Delta's measured margin made a rule changed at
        // 09:46 read ₹3,856 and the recompute right after ₹3,158 -- the same rule, two lines -- and High was squared off at
        // the lower one. Where the model is not given (a test), the base as before.
        const base = s.rule.unit === 'pct' ? await (this.d.pctModelUsd ?? this.d.pctBaseUsd)().catch(() => null) : null;
        this.baseline.limitInr = s.rule.unit === 'inr' ? s.rule.limit : base !== null && base > 0 ? (s.rule.limit / 100) * base * USDINR : null;
        if (s.rule.unit === 'pct' && this.baseline.limitInr !== null) await this.d.fixedLimit?.set(kept, this.baseline.limitInr).catch(() => {});
      }
    }
    const limitInr = this.baseline.limitInr;
    const lossInr = (this.baseline.usd - await this.d.netUsd()) * USDINR;
    this.last = { from: s.rule.from, to: s.rule.to, limit: s.rule.limit, unit: s.rule.unit, limitInr, lossInr, hit: false, breachSince: null };
    this.lastKey = key;
    if (limitInr !== null && limitInr > 0) this.near(cfg, s.rule, key, limitInr, lossInr, now);
    // A per cent of nothing yet (no "At most open" set, no price for the margin) is no line: nothing squared off on a guess.
    if (limitInr === null || lossInr < limitInr) { this.breachSince = null; return null; }
    this.breachSince ??= now;
    this.last.breachSince = this.breachSince;
    const heldMs = now - this.breachSince;
    const farOver = lossInr >= limitInr * (1 + FAST_OVER_PCT / 100);
    if (heldMs < HOLD_MS && !(farOver && heldMs >= FAST_HOLD_MS && await this.boardFresh())) return null;

    // Hit: no new entry for the rest of the day, then everything on the account bought back.
    this.hits.add(key);
    this.lockedUntil = startOfDayIst(now) + 86_400_000;
    this.lockedWhy = whyOf({ from: s.rule.from, to: s.rule.to, lossInr, limitInr });
    this.breachSince = null;
    const done = await this.d.squareOff().catch((e: Error) => ({ closed: [], cancelled: [], failed: [{ tradeId: '*', reason: e.message }] }));
    const hit: SessionHit = {
      day, from: s.rule.from, to: s.rule.to, limitInr: Math.round(limitInr * 100) / 100, lossInr: Math.round(lossInr * 100) / 100, at: now,
      closed: done.closed.length, cancelled: done.cancelled.length, failed: done.failed.length,
      // What could not be closed first; then how the square-off went -- its time and its fills against the ask (22 Nov 2026).
      detail: [
        done.failed.length ? done.failed.slice(0, 10).map((f) => `${f.tradeId}: ${f.reason}`).join('; ') : null,
        'report' in done && done.report ? done.report : null,
      ].filter(Boolean).join(' · '),
    };
    await this.d.record(hit).catch(() => {});
    this.d.said(hit);
    // A close that did not go through is tried again (`SQUARE_OFF_RETRY_MS`): only those trades -- a trade opened by hand
    // after the hit is not this square-off's -- and all of them when the square-off itself could not run.
    if (done.failed.length) this.owed = { ids: done.failed.some((f) => f.tradeId === '*') ? null : done.failed.map((f) => f.tradeId), nextAt: now + SQUARE_OFF_RETRY_MS, tries: 0 };
    return hit;
  }

  /** Every open position's quote fresh enough for the short hold (`FAST_QUOTE_MAX_AGE_MS`); no reader given: fresh. */
  private async boardFresh(): Promise<boolean> {
    if (!this.d.quoteAgeMs) return true;
    const age = await this.d.quoteAgeMs().catch(() => null);
    return age !== null && age <= FAST_QUOTE_MAX_AGE_MS;
  }

  /**
   * Near the line (22 Nov 2026): said once a session at `WARN_AT_PCT`; and, with `pauseAt` set, new entries held at it and
   * let go `PAUSE_RESUME_GAP_PCT` under it. Nothing here closes anything.
   */
  private near(cfg: SessionLoss, rule: SessionRule, key: string, limitInr: number, lossInr: number, now: number): void {
    const pct = (lossInr / limitInr) * 100;
    const at = { from: rule.from, to: rule.to, limitInr, lossInr, pct, at: now };
    if (pct >= WARN_AT_PCT && !this.warnedKeys.has(key)) {
      this.warnedKeys.add(key);
      try { this.d.warned?.(at); } catch { /* a message is never worth the guard */ }
    }
    const pauseAt = typeof cfg.pauseAt === 'number' ? cfg.pauseAt : null;
    if (this.nearPause && (pauseAt === null || this.nearPause.key !== key)) this.nearPause = null;
    if (pauseAt === null) return;
    if (!this.nearPause && pct >= pauseAt) {
      const rs = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
      this.nearPause = {
        key,
        why: `Near the ${rule.from}–${rule.to} session's loss limit: lost ${rs(lossInr)} of ${rs(limitInr)} (${pauseAt}% or more) -- no new entry until the loss is back under ${pauseAt - PAUSE_RESUME_GAP_PCT}%.`,
      };
      const first = !this.pauseSaid.has(key);
      this.pauseSaid.add(key);
      try { this.d.entriesPaused?.({ ...at, on: true, first }); } catch { /* as above */ }
    } else if (this.nearPause && pct < pauseAt - PAUSE_RESUME_GAP_PCT) {
      this.nearPause = null;
      try { this.d.entriesPaused?.({ ...at, on: false, first: false }); } catch { /* as above */ }
    }
  }

  private async retrySquareOff(now: number): Promise<void> {
    const owed = this.owed!;
    const done = await this.d.squareOff(owed.ids ?? undefined).catch((e: Error) => ({ closed: [], cancelled: [], failed: [{ tradeId: '*', reason: e.message }] }));
    const tries = owed.tries + 1;
    this.owed = done.failed.length
      ? { ids: done.failed.some((f) => f.tradeId === '*') ? owed.ids : done.failed.map((f) => f.tradeId), nextAt: now + SQUARE_OFF_RETRY_MS, tries }
      : null;
    try { this.d.retried?.(done.failed.length, tries); } catch { /* said or not, the retry stands */ }
  }
}
