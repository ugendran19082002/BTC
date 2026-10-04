import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

/**
 * What the desk costs and how long it takes, counted -- so the next change to
 * its speed is decided on numbers.
 *
 * Until 4 Oct 2026 nothing here was measured: not how many calls the desk made
 * to Delta, not how much of Delta's quota they used, not how long a pass over
 * the open trades took, not how long the signal run held the thread the SL and
 * TGT watch runs on. The plan to poll contracts side by side could not be
 * judged without them. This counts; it changes nothing the desk does.
 *
 * Everything is held in memory for the last five minutes (Delta's own window)
 * and lost on a restart, which is all a gauge needs. Nothing here may throw:
 * it is called from inside the order path.
 */

/** Delta's quota for one user's signed calls, per five minutes (docs/reference/delta-api.md). */
export const DELTA_QUOTA_UNITS = 20_000;
export const DELTA_WINDOW_MS = 5 * 60_000;
/** A pass over the open trades is asked for this often; one that takes longer makes the next one late. */
export const PASS_EVERY_MS = 1_000;

export type DeltaOutcome = 'ok' | 'refused' | 'rate-limited' | 'failed';
export type DeltaKind = 'place, edit or cancel' | 'order lookup' | 'order history and fills' | 'positions, balances, products' | 'other';

/** What a signed call is, and what Delta charges for it -- its documented weights, so an estimate of the bill, not the bill. */
export function costOf(method: string, path: string): { kind: DeltaKind; units: number } {
  const p = path.split('?')[0]!;
  if (/\/history|^\/v2\/fills|\/wallet\/transactions/.test(p)) return { kind: 'order history and fills', units: 10 };
  if (p.startsWith('/v2/orders')) {
    if (method === 'GET') return { kind: 'order lookup', units: 3 };
    return { kind: 'place, edit or cancel', units: p.includes('/batch') ? 25 : 5 };
  }
  if (/^\/v2\/(positions|wallet|products|tickers|l2orderbook)/.test(p)) return { kind: 'positions, balances, products', units: 3 };
  return { kind: 'other', units: 1 };
}

type Call = { at: number; ms: number; units: number; kind: DeltaKind; outcome: DeltaOutcome };
type Pass = { at: number; ms: number; trades: number };
type Run = { at: number; readMs: number; calcMs: number; early: boolean; afterCloseMs: number | null };

let calls: Call[] = [];
let passes: Pass[] = [];
let runs: Run[] = [];
let rateLimited = { total: 0, lastAt: null as number | null };
const startedAt = Date.now();

const keep = <T extends { at: number }>(xs: T[], now: number, ms = DELTA_WINDOW_MS): T[] => {
  let i = 0;
  while (i < xs.length && now - xs[i]!.at > ms) i++;
  return i ? xs.slice(i) : xs;
};

/** One signed call to Delta, as it ended. */
export function noteDeltaCall(c: { method: string; path: string; ms: number; outcome: DeltaOutcome }, now = Date.now()): void {
  try {
    const { kind, units } = costOf(c.method, c.path);
    calls.push({ at: now, ms: c.ms, units, kind, outcome: c.outcome });
    if (c.outcome === 'rate-limited') rateLimited = { total: rateLimited.total + 1, lastAt: now };
    if (calls.length > 512 && now - calls[0]!.at > DELTA_WINDOW_MS) calls = keep(calls, now);
  } catch { /* a gauge never stops a call */ }
}

/** One pass over the open trades: how long it took and how many it polled. */
export function notePass(ms: number, trades: number, now = Date.now()): void {
  try { passes.push({ at: now, ms, trades }); if (passes.length > 1_024) passes = keep(passes, now); } catch { /* as above */ }
}

/** One signal run: reading the market, then every method on it. The second holds the thread. */
export function noteSignalRun(readMs: number, calcMs: number, o: { early?: boolean; afterCloseMs?: number } = {}, now = Date.now()): void {
  try { runs.push({ at: now, readMs, calcMs, early: o.early === true, afterCloseMs: o.afterCloseMs ?? null }); if (runs.length > 240) runs = runs.slice(-120); } catch { /* as above */ }
}

// The thread itself: how late a timer fires is how long something held it. Sampled in windows of a minute.
let loop: IntervalHistogram | null = null;
let loopSince = 0;
let loopLast: { p50Ms: number; p99Ms: number; maxMs: number } | null = null;
const ms1 = (ns: number) => Math.round(ns / 1e5) / 10;
function loopNow(now: number): { p50Ms: number; p99Ms: number; maxMs: number } | null {
  try {
    if (!loop) { loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable(); loopSince = now; return null; }
    if (now - loopSince >= 60_000 && loop.count > 0) {
      // The histogram counts from the timer's own 20 ms: what is over that is the hold.
      loopLast = { p50Ms: Math.max(0, ms1(loop.percentile(50)) - 20), p99Ms: Math.max(0, ms1(loop.percentile(99)) - 20), maxMs: Math.max(0, ms1(loop.max) - 20) };
      loop.reset();
      loopSince = now;
    }
    return loopLast;
  } catch { return null; }
}

const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]! * 10) / 10;
};
const spread = (xs: number[]) => ({ p50Ms: pct(xs, 0.5), p95Ms: pct(xs, 0.95), maxMs: xs.length ? Math.round(Math.max(...xs) * 10) / 10 : null });

export type DeskMetrics = ReturnType<typeof deskMetrics>;

/** The last five minutes, as the screen shows them. */
export function deskMetrics(now = Date.now()) {
  calls = keep(calls, now);
  passes = keep(passes, now);
  const units = calls.reduce((n, c) => n + c.units, 0);
  const kinds = new Map<DeltaKind, { calls: number; units: number }>();
  for (const c of calls) {
    const k = kinds.get(c.kind) ?? { calls: 0, units: 0 };
    kinds.set(c.kind, { calls: k.calls + 1, units: k.units + c.units });
  }
  const recentRuns = runs.filter((r) => now - r.at <= 30 * 60_000);
  return {
    at: now,
    /** How long this has been counting: under five minutes after a restart, the window is not full yet. */
    countingForMs: now - startedAt,
    delta: {
      windowMs: DELTA_WINDOW_MS,
      quotaUnits: DELTA_QUOTA_UNITS,
      calls: calls.length,
      units,
      usedPct: Math.round((units / DELTA_QUOTA_UNITS) * 1000) / 10,
      byKind: [...kinds.entries()].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.units - a.units),
      response: spread(calls.filter((c) => c.outcome !== 'failed').map((c) => c.ms)),
      failed: calls.filter((c) => c.outcome === 'failed').length,
      refused: calls.filter((c) => c.outcome === 'refused').length,
      rateLimited: { inWindow: calls.filter((c) => c.outcome === 'rate-limited').length, sinceStart: rateLimited.total, lastAt: rateLimited.lastAt },
    },
    passes: {
      count: passes.length,
      everyMs: PASS_EVERY_MS,
      ...spread(passes.map((p) => p.ms)),
      late: passes.filter((p) => p.ms > PASS_EVERY_MS).length,
      tradesNow: passes.length ? passes[passes.length - 1]!.trades : 0,
    },
    signalRun: {
      count: recentRuns.length,
      read: spread(recentRuns.map((r) => r.readMs)),
      /** The calculation runs on the thread the SL and TGT watch runs on: this long, the watch waits. */
      calc: spread(recentRuns.map((r) => r.calcMs)),
      /** How long after the candle closed the signals were ready, and how many runs went early on a verified candle. */
      afterClose: spread(recentRuns.filter((r) => r.afterCloseMs !== null).map((r) => r.afterCloseMs!)),
      early: recentRuns.filter((r) => r.early).length,
    },
    thread: loopNow(now),
  };
}

/** For tests. */
export function resetDeskMetrics(): void {
  calls = []; passes = []; runs = []; rateLimited = { total: 0, lastAt: null }; loopLast = null;
}
