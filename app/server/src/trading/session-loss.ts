import { USDINR } from '../domain/score.js';
import { istDate, startOfDayIst } from '../strategy/schedule.js';

/**
 * A loss limit by the session, per account (owner, 4 Nov 2026: "a daily loss limit of another kind on the desk's open
 * positions -- by the session, an hour at a time: 7:00 to 8:00 AM, say, ₹1,000 on an account; if that account loses it
 * in that time, square the whole account off. Set for each hour; default off, on every account").
 *
 * A session is a stretch of the IST day, `from` to `to` (the end not included), with a limit in rupees. What it has lost
 * is the account's day -- booked, open at the mark, less charges, as the header's "Net today" (`todayFigures`) -- now,
 * against the same figure when the session began (the day's line, `mtm_samples`, at or before its start). A position
 * entered before the session that goes bad inside it is the session's loss; a profit booked before it is not spent by it.
 *
 * At the limit, held for `HOLD_MS` so a cheap option's ask flicking for a second is not a square-off, the account is
 * squared off (`closeAll`: working entries pulled, every position bought back, one at a time) and takes **no new entry
 * for the rest of the IST day** (owner, same day: "once a session's limit is hit, that day's trading stops in full; the
 * next day it runs as usual"). Nothing else changes -- the other accounts, the next day, the day's own loss budget.
 */

/**
 * A session and its limit: rupees (`inr`), or a per cent of the account (`pct`) -- the wallet, read when the session
 * begins, so the line does not move as the session loses (owner, same day: "amount or %, either -- I choose").
 */
export type SessionRule = { from: string; to: string; limit: number; unit: 'inr' | 'pct' };
export type SessionLoss = { on: boolean; sessions: SessionRule[] };

/** Where an account's sessions are kept (`accountKey`): no row, or one that will not read, is off with none. */
export const SESSION_LOSS_KEY = 'session_loss_limit';
export const SESSION_LOSS_OFF: SessionLoss = { on: false, sessions: [] };
/** At most this many sessions: an hour each is 24. */
export const MAX_SESSIONS = 24;
/** The most a session's limit may be, in rupees or per cent: typo guards. */
export const MAX_SESSION_LIMIT_INR = 10_000_000;
export const MAX_SESSION_LIMIT_PCT = 100;
/** How long the loss must stay at or over the limit before the account is squared off. */
export const HOLD_MS = 15_000;
/** How often an account's session is checked. */
export const SESSION_LOSS_TICK_MS = 5_000;

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
    else if (r.unit === 'pct' && r.limit > MAX_SESSION_LIMIT_PCT) bad.push(`Session ${n}: at most ${MAX_SESSION_LIMIT_PCT}% of the account.`);
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
    return { on: v.on, sessions: [...v.sessions].sort((a, b) => minutesOf(a.from) - minutesOf(b.from)).map((s) => ({ from: s.from, to: s.to, limit: s.limit, unit: s.unit })) };
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
  /** The limit in rupees: the amount, or the per cent of the account at the session's start; null until it is read. */
  limitInr: number | null;
  /** Lost since the session began, in rupees; null until it has been read. Negative is a gain. */
  lossInr: number | null;
  /** Squared off this session: no new entry today. */
  hit: boolean;
  /** The loss at or over the limit since this moment, waiting `HOLD_MS` before the square-off. */
  breachSince: number | null;
} | null;

/** What a new entry is told, the day a session's limit stopped the account. */
const whyOf = (h: Pick<SessionHit, 'from' | 'to' | 'lossInr' | 'limitInr'>) =>
  `The ${h.from}–${h.to} session lost ₹${Math.round(h.lossInr).toLocaleString('en-IN')}, at its ₹${Math.round(h.limitInr).toLocaleString('en-IN')} limit: the account was squared off and takes no new entry today.`;

export type SessionGuardDeps = {
  now: () => number;
  rule: () => SessionLoss;
  /** The account's wallet in USD, for a limit in per cent; null when it cannot be read. */
  accountUsd: () => Promise<number | null>;
  /** The account's day so far, USD: booked + open at the mark − charges ("Net today"). */
  netUsd: () => Promise<number>;
  /** The same figure as the day's line had it at or before `atMs`; null with no reading then (none taken yet: 0). */
  netUsdAt: (atMs: number) => Promise<number | null>;
  squareOff: () => Promise<{ closed: string[]; cancelled: string[]; failed: { tradeId: string; reason: string }[] }>;
  record: (hit: SessionHit) => Promise<void>;
  /** The square-offs written down for a day (`record`): what a restart reads to stay stopped. */
  hitsOn: (day: string) => Promise<SessionHit[]>;
  /** Said once a hit: the phone, the log. */
  said: (hit: SessionHit) => void;
};

/**
 * One account's session guard. `tick` reads the session now and squares the account off at its limit; `entryBlock`
 * says why a new entry must wait, while a hit session lasts.
 */
export class SessionLossGuard {
  private baseline: { key: string; usd: number; limitInr: number | null } | null = null;
  private breachSince: number | null = null;
  /** The sessions hit, by day and start: each squared off once. */
  private readonly hits = new Set<string>();
  private lockedUntil = 0;
  private lockedWhy = '';
  private last: SessionLossNow = null;
  private lastKey = '';
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
  }

  /** Why a new entry must wait, or null: a session was squared off today, and today is not over. */
  entryBlock(now = this.d.now()): string | null {
    return now < this.lockedUntil ? this.lockedWhy : null;
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
    };
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
    if (!s) { this.breachSince = null; this.last = null; return null; }
    // Stopped for the day already: nothing more to read until tomorrow.
    if (now < this.lockedUntil) return null;
    const day = istDate(now);
    const key = `${day}|${s.rule.from}`;
    if (this.hits.has(key)) return null;
    // The day's figure when the session began, read once a session; a restart reads it again off the day's line.
    if (this.baseline?.key !== key) {
      this.baseline = { key, usd: (await this.d.netUsdAt(s.startMs)) ?? 0, limitInr: null };
      this.breachSince = null;
    }
    // The line in rupees, fixed for the session: the amount, or the per cent of the account as it stood when first read.
    if (this.baseline.limitInr === null) {
      const acct = s.rule.unit === 'pct' ? await this.d.accountUsd().catch(() => null) : null;
      this.baseline.limitInr = s.rule.unit === 'inr' ? s.rule.limit : acct !== null && acct > 0 ? (s.rule.limit / 100) * acct * USDINR : null;
    }
    const limitInr = this.baseline.limitInr;
    const lossInr = (this.baseline.usd - await this.d.netUsd()) * USDINR;
    this.last = { from: s.rule.from, to: s.rule.to, limit: s.rule.limit, unit: s.rule.unit, limitInr, lossInr, hit: false, breachSince: null };
    this.lastKey = key;
    // A per cent of an account not yet read is no line yet: nothing squared off on a guess.
    if (limitInr === null || lossInr < limitInr) { this.breachSince = null; return null; }
    this.breachSince ??= now;
    this.last.breachSince = this.breachSince;
    if (now - this.breachSince < HOLD_MS) return null;

    // Hit: no new entry for the rest of the day, then everything on the account bought back.
    this.hits.add(key);
    this.lockedUntil = startOfDayIst(now) + 86_400_000;
    this.lockedWhy = whyOf({ from: s.rule.from, to: s.rule.to, lossInr, limitInr });
    this.breachSince = null;
    const done = await this.d.squareOff().catch((e: Error) => ({ closed: [], cancelled: [], failed: [{ tradeId: '*', reason: e.message }] }));
    const hit: SessionHit = {
      day, from: s.rule.from, to: s.rule.to, limitInr: Math.round(limitInr * 100) / 100, lossInr: Math.round(lossInr * 100) / 100, at: now,
      closed: done.closed.length, cancelled: done.cancelled.length, failed: done.failed.length,
      detail: done.failed.length ? done.failed.slice(0, 10).map((f) => `${f.tradeId}: ${f.reason}`).join('; ') : '',
    };
    await this.d.record(hit).catch(() => {});
    this.d.said(hit);
    return hit;
  }
}
