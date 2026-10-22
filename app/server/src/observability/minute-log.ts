import { monitorEventLoopDelay } from 'node:perf_hooks';
import { deskMetrics, signalRunsSince } from './desk-metrics.js';

/**
 * The thread, a minute at a time, in the server log (22 Oct 2026, owner: "every minute the event loop's delay and the
 * signal calc's time in the log file").
 *
 * On 22 Oct the health check, 12 ms as a rule, took 449 ms at 07:08:02 and 934 and 1,183 ms at 07:37 -- the minutes the
 * stop watch stood down -- and nine of its nineteen slow answers fell in the first five seconds of a minute, when the
 * signals are worked. That was read off request times after the fact. This says it as it happens, once a minute, in
 * the day's file (`log-files.ts`), which a rebuild no longer takes:
 *   - how late the thread's timers fired over the minute (`monitorEventLoopDelay`): p50, p99 and the worst;
 *   - each hold of `STALL_MS` or more, with when it began -- a timer every `TICK_MS` that notes how late it is;
 *   - the minute's signal run: reading the market, working the methods, where they were worked (their own thread, or
 *     this one) and what of it this thread spent;
 *   - each login's share of Delta's quota.
 * Its own histogram and timers: the screen's (`deskMetrics().loop`) is sampled only while someone looks.
 */

export const TICK_MS = 100;
export const STALL_MS = 250;
const IST_MS = 330 * 60_000;
const clock = (at: number) => new Date(at + IST_MS).toISOString().slice(11, 22);

export type MinuteLine = {
  from: number;
  loop: { p50Ms: number; p99Ms: number; maxMs: number };
  stalls: { at: number; ms: number }[];
  signal: { readMs: number; calcMs: number; mainMs: number; where: 'thread' | 'here'; afterCloseMs: number | null } | null;
  quotaPct: { login: string; usedPct: number }[];
};

const ms1 = (ns: number) => Math.round(ns / 1e5) / 10;

export function startMinuteLog(o: {
  log: (msg: string, fields: Record<string, unknown>) => void;
  now?: () => number;
  /** For a test: the line is asked for, not waited for. */
  every?: number | null;
}): { line: () => MinuteLine; stop: () => void } {
  const now = o.now ?? Date.now;
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  let from = now();
  let stalls: { at: number; ms: number }[] = [];
  let last = performance.now();
  const tick = setInterval(() => {
    const t = performance.now();
    const late = t - last - TICK_MS;
    last = t;
    if (late >= STALL_MS) stalls.push({ at: now() - Math.round(late), ms: Math.round(late) });
  }, TICK_MS);
  tick.unref();

  const line = (): MinuteLine => {
    const runs = signalRunsSince(from);
    const run = runs.at(-1) ?? null;
    const out: MinuteLine = {
      from,
      loop: h.count > 0
        // The histogram counts from its own resolution: what is over that is the hold.
        ? { p50Ms: Math.max(0, ms1(h.percentile(50)) - 10), p99Ms: Math.max(0, ms1(h.percentile(99)) - 10), maxMs: Math.max(0, ms1(h.max) - 10) }
        : { p50Ms: 0, p99Ms: 0, maxMs: 0 },
      stalls,
      signal: run ? { readMs: Math.round(run.readMs), calcMs: Math.round(run.calcMs), mainMs: Math.round(run.mainMs), where: run.where, afterCloseMs: run.afterCloseMs } : null,
      quotaPct: (() => { try { return deskMetrics(now()).delta.logins.map((l) => ({ login: l.quota, usedPct: l.usedPct })); } catch { return []; } })(),
    };
    h.reset();
    stalls = [];
    from = now();
    return out;
  };

  const say = () => {
    try {
      const l = line();
      const held = l.stalls.length
        ? `; ${l.stalls.length} hold${l.stalls.length === 1 ? '' : 's'} of ${STALL_MS} ms or more (${l.stalls.map((x) => `${clock(x.at)} ${x.ms} ms`).join(', ')})`
        : '';
      const sig = l.signal
        ? `; signals read ${l.signal.readMs} ms, worked ${l.signal.calcMs} ms ${l.signal.where === 'thread' ? `in their own thread (${l.signal.mainMs} ms on this one)` : 'on this thread'}`
        : '';
      o.log(`minute ${clock(l.from).slice(0, 5)}: loop p99 ${l.loop.p99Ms} ms, worst ${l.loop.maxMs} ms${held}${sig}`, { minute: l });
    } catch { /* a log line is never worth a failure */ }
  };

  let timer: NodeJS.Timeout | null = null;
  let first: NodeJS.Timeout | null = null;
  if (o.every !== null) {
    const every = o.every ?? 60_000;
    // On the half minute: the signals, worked in a minute's first seconds, are inside the minute they are said with.
    first = setTimeout(() => { say(); timer = setInterval(say, every); timer.unref(); }, every - ((now() + 30_000) % every));
    first.unref();
  }
  return {
    line,
    stop: () => { clearInterval(tick); if (first) clearTimeout(first); if (timer) clearInterval(timer); h.disable(); },
  };
}
