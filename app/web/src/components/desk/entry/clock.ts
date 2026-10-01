import { useEffect, useState } from 'react';
import type { SetupClock } from '@/types/entry';

/**
 * The entry section's clocks: a signal's times, to the second, in IST, and the
 * counter that runs once a TRADE is out -- the fill window, then the time in
 * the trade and to its time-out. The windows are the server's (paper.ts
 * fillByOf, timeoutAtOf); the screen only counts down to them.
 */

/** 14:33:05, IST. */
export const SECS = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
/** 14:33, IST. */
export const MINS = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

/** Now, re-read every second while `on`: for counters only, so a page without one never ticks. */
export function useNow(on: boolean, everyMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [on, everyMs]);
  return now;
}

/** A span as a counter: "0:42", "12:03", "1:04:09"; under 0 is "0:00". */
export function span(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** How long after the bar closed a signal was seen, or an alert went: "+3 s", "+1 min 4 s". */
export function lag(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `+${s} s` : `+${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
}

/**
 * Where a TRADE stands on its clock, in words, at `now` (ms): waiting with the
 * fill window counting down, in the trade with its time and the time-out
 * counting down, or out. Null for a state with no clock.
 */
export function clockText(
  c: Pick<SetupClock, 'status' | 'fillBy' | 'filledAt' | 'timeoutAt' | 'exitAt'> & Partial<Pick<SetupClock, 'runner' | 'tp2At'>>, now: number,
): { label: string; value: string; tone: 'wait' | 'live' | 'done' } | null {
  // After TGT1: the runner, its stop at breakeven, out for TGT2 then TGT3.
  if (c.status === 'tp1' && c.runner === 'running') {
    const out = c.timeoutAt === null ? '' : ` · time-out in ${span(c.timeoutAt * 1000 - now)}`;
    return { label: 'Runner, stop at breakeven', value: `${c.tp2At != null ? 'TGT2 ✓ · TGT3 next' : 'TGT2 next'}${out}`, tone: 'live' };
  }
  if (c.status === 'open') return { label: 'Fill window closes in', value: span(c.fillBy * 1000 - now), tone: 'wait' };
  if (c.status === 'filled' && c.filledAt !== null) {
    const out = c.timeoutAt === null ? '' : ` · time-out in ${span(c.timeoutAt * 1000 - now)}`;
    return { label: 'In the trade', value: `${span(now - c.filledAt * 1000)}${out}`, tone: 'live' };
  }
  if (c.status === 'expired') return { label: 'Expired', value: 'never filled in its window', tone: 'done' };
  if (c.status === 'missed') return { label: 'Missed', value: 'price ran to TGT1 without filling', tone: 'done' };
  if (c.exitAt !== null && c.filledAt !== null) return { label: 'Held', value: span((c.exitAt - c.filledAt) * 1000), tone: 'done' };
  return null;
}

/** Seconds in a bar of each timeframe (the server's TF_SEC). */
export const TF_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1_800, '1h': 3_600, '4h': 14_400 } as const;
