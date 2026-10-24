import { minutesForward, minutesOf, time12 } from '@/lib/time';
import type { SessionAsk } from '@/types/signal-backtest';

/**
 * The SL, delta and win % by session of the day, as typed (owner, 23 Oct 2026: "session based -- delta, SL %, win %
 * -- make them editable; I will check it by session"). Each session is an IST From and To, read forward from the daily
 * contract's 5:30 PM as the session table is; in it each figure is typed or left blank, and a blank one is the settings
 * as set. Held to the server's own rules (`sessionRuleOf`) before it is asked. The SL and TGT range by session too
 * (owner, 24 Oct 2026: "add per session"): BTC points from the perp entry, a blank the run's own, 0 off.
 */
export type SessionDraft = { from: string; to: string; delta: string; sl: string; win: string; slMin: string; slMax: string; tgtMin: string; tgtMax: string };
export const RANGE_KEYS = ['slMin', 'slMax', 'tgtMin', 'tgtMax'] as const;
/** A session's figures, every one blank: as set. */
export const BLANK_FIGURES = { delta: '', sl: '', win: '', slMin: '', slMax: '', tgtMin: '', tgtMax: '' };
export type SessionDrafts = { sessions: SessionDraft[]; win: { base: string; minTrades: string; days: string } };

export const SESSIONS_MAX = 24;
const DAY_START = '17:30';
/** The afternoon, the SL tighter -- the study of 22 Oct 2026's question -- to begin from. */
export const SESSION_DRAFTS: SessionDrafts = {
  sessions: [{ from: '12:00', to: '17:30', ...BLANK_FIGURES, sl: '150' }],
  win: { base: '', minTrades: '3', days: '14' },
};

const start = minutesOf(DAY_START);
/** A session as minutes from 5:30 PM: [from, to), a To of 5:30 PM the day's end. */
export const spanOf = (s: Pick<SessionDraft, 'from' | 'to'>): [number, number] => [minutesForward(start, minutesOf(s.from)), minutesForward(start, minutesOf(s.to)) || 1_440];
/** "12:00 PM – 5:30 PM" */
export const sessionSpanWords = (s: Pick<SessionDraft, 'from' | 'to'>) => `${time12(s.from)} – ${time12(s.to)}`;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const num = (s: string) => (s.trim() === '' ? null : Number(s));

/** What is wrong with the sessions as typed, in words, or null: as the server holds them. */
export function sessionDraftProblem(d: SessionDrafts): string | null {
  if (d.sessions.length === 0) return 'Add a session to set its delta, SL or win %.';
  if (d.sessions.length > SESSIONS_MAX) return `At most ${SESSIONS_MAX} sessions.`;
  for (const [i, s] of d.sessions.entries()) {
    const n = i + 1;
    if (!HHMM.test(s.from) || !HHMM.test(s.to)) return `Session ${n} needs a From and a To time.`;
    if (s.from === s.to) return `Session ${n}'s From and To times must differ.`;
    const [f, t] = spanOf(s);
    if (t <= f) return `Session ${n} runs past 5:30 PM, the daily contract's end: end it by then, or start another after it.`;
    for (const [j, o] of d.sessions.entries()) {
      const [g, u] = spanOf(o);
      if (j < i && f < u && g < t) return `Sessions ${j + 1} and ${n} overlap: a signal must be of one session.`;
    }
    const delta = num(s.delta), sl = num(s.sl), win = num(s.win);
    if (delta !== null && !(delta >= 0.02 && delta <= 0.5)) return `Session ${n}'s delta is from 0.02 to 0.50.`;
    if (sl !== null && !(sl >= 10 && sl <= 1_000)) return `Session ${n}'s SL is from 10% to 1,000% of the premium.`;
    if (win !== null && !(win >= 1 && win <= 100)) return `Session ${n}'s win % is from 1% to 100%.`;
    const slMin = num(s.slMin), slMax = num(s.slMax), tgtMin = num(s.tgtMin), tgtMax = num(s.tgtMax);
    if ([slMin, slMax, tgtMin, tgtMax].some((v) => v !== null && !(v >= 0 && v <= 20_000))) return `Session ${n}'s SL or TGT distance is from 0 (off) to 20,000 points.`;
    for (const [lo, hi, name] of [[slMin, slMax, 'SL'], [tgtMin, tgtMax, 'TGT']] as const) if (lo && hi && hi < lo) return `Session ${n}'s ${name} maximum must not be under its minimum.`;
  }
  const base = num(d.win.base), trades = num(d.win.minTrades), days = num(d.win.days);
  if (base !== null && !(base >= 1 && base <= 100)) return 'The win % as set is from 1% to 100%, or blank for none.';
  if (!(trades !== null && Number.isInteger(trades) && trades >= 1 && trades <= 100)) return 'The least trades are a whole number from 1 to 100.';
  if (!(days !== null && Number.isInteger(days) && days >= 1 && days <= 30)) return 'The days read are a whole number from 1 to 30.';
  if (!d.sessions.some((s) => (['delta', 'sl', 'win', ...RANGE_KEYS] as const).some((k) => num(s[k]) !== null))) return 'Type a delta, an SL, a win % or an SL / TGT range in a session: blank everywhere is the settings as set.';
  return null;
}

/** The sessions as the server is asked: each blank a null. */
export function sessionAskOf(d: SessionDrafts): SessionAsk {
  return {
    sessions: d.sessions.map((s) => ({ from: s.from, to: s.to, delta: num(s.delta), sl: num(s.sl), win: num(s.win), slMin: num(s.slMin), slMax: num(s.slMax), tgtMin: num(s.tgtMin), tgtMax: num(s.tgtMax) })),
    win: { base: num(d.win.base), minTrades: Number(d.win.minTrades), days: Number(d.win.days) },
  };
}

/**
 * The next session to add: the first time of the day from 5:30 PM no session holds, for two hours or up to the next
 * session, whichever is sooner. Null when the sessions hold the whole day.
 */
export function nextSession(d: SessionDrafts): SessionDraft | null {
  const spans = d.sessions.filter((s) => HHMM.test(s.from) && HHMM.test(s.to) && s.from !== s.to).map(spanOf).filter(([f, t]) => t > f).sort((a, b) => a[0] - b[0]);
  let from = 0;
  for (const [f, t] of spans) if (f <= from && t > from) from = t;
  if (from >= 1_440) return null;
  const to = Math.min(1_440, from + 120, ...spans.filter(([f]) => f > from).map(([f]) => f));
  const hhmm = (m: number) => { const x = (start + m) % 1_440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
  return { from: hhmm(from), to: hhmm(to), ...BLANK_FIGURES };
}

/** The whole day in sessions of `hours`, from 5:30 PM, each blank: a grid to type into. */
export function splitDay(hours: number): SessionDraft[] {
  const out: SessionDraft[] = [];
  for (let m = 0; m < 1_440; m += hours * 60) {
    const hhmm = (x: number) => { const y = (start + x) % 1_440; return `${String(Math.floor(y / 60)).padStart(2, '0')}:${String(y % 60).padStart(2, '0')}`; };
    out.push({ from: hhmm(m), to: hhmm(Math.min(1_440, m + hours * 60)), ...BLANK_FIGURES });
  }
  return out;
}

/**
 * What a session sets, in a few words: "Δ 0.08 · SL +150% · won ≥ 70% · SL ≥ 150 pts · TGT ≤ off", or "as set". `sl` a
 * share (1.5) as the result has it; the range in points as the run's own range says it.
 */
export function ruleWords(s: { delta: number | null; sl: number | null; win: number | null } & Partial<Record<(typeof RANGE_KEYS)[number], number | null>>): string {
  const pts = (name: string, op: string, v: number | null | undefined) => (v == null ? null : `${name} ${op} ${v === 0 ? 'off' : `${v.toLocaleString('en-IN')} pts`}`);
  const w = [
    s.delta === null ? null : `Δ ${s.delta.toFixed(2)}`, s.sl === null ? null : `SL +${Math.round(s.sl * 100)}%`, s.win === null ? null : `won ≥ ${s.win}%`,
    pts('SL', '≥', s.slMin), pts('SL', '≤', s.slMax), pts('TGT', '≥', s.tgtMin), pts('TGT', '≤', s.tgtMax),
  ].filter(Boolean);
  return w.length ? w.join(' · ') : 'as set';
}
