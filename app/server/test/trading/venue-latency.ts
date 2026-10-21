import type { PaperExchange } from '../../src/trading/exchange/paper.js';

/**
 * Delta's round trip, put on the paper exchange (21 Oct 2026, the architecture plan's step 1: "measure first").
 *
 * Every call the engine makes waits, for real, as long as Delta takes to answer it -- a read about 120 ms from the
 * desk's host (a public ticker read, timed 21 Oct: 107-122 ms), an order more -- and is written down: what it was, when
 * it was sent, when it came back, and the units Delta's quota charges for it (`costOf` in desk-metrics: a lookup 3, a
 * place or cancel 5). So a burst of stops can be timed on the real engine and the real stop watch, with nothing live.
 */

export type Latency = { readMs: number; writeMs: number; /** ± this share of each, drawn from a fixed seed. */ jitter?: number };
export type VenueCall = { method: string; role: string | null; sentMs: number; backMs: number; units: number };

const WRITES = new Set(['placeOrder', 'cancelOrder', 'editOrder', 'setLeverage']);
/** Answered without Delta on the desk: the adapter keeps each contract's spec after its first read (`DeltaExchange.getProduct`). */
const FREE = new Set(['getProduct']);
const UNITS: Record<string, number> = {
  placeOrder: 5, cancelOrder: 5, editOrder: 5, setLeverage: 5,
  getOrderHistory: 10, getFills: 10,
};
const METHODS = [
  'placeOrder', 'cancelOrder', 'editOrder', 'getOrderByClientId', 'getOrderById', 'getOrderHistory', 'getFills',
  'getOpenOrders', 'getPositions', 'getBalanceUsd', 'getWalletUsd', 'getProduct', 'setLeverage', 'getQuote',
] as const;

/** Slow every call on `ex` down to `lat`, from now; returns the record of them and how to put it back. */
export function withLatency(ex: PaperExchange, lat: Latency) {
  const calls: VenueCall[] = [];
  let live = 0, most = 0;
  // A small fixed-seed generator: the same run twice draws the same delays.
  let seed = 21_10_2026;
  const draw = () => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed / 2 ** 31; };
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const target = ex as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const originals = new Map<string, (...a: unknown[]) => Promise<unknown>>();
  for (const m of METHODS) {
    const fn = target[m];
    if (typeof fn !== 'function') continue;
    const real = fn.bind(ex);
    originals.set(m, fn);
    target[m] = async (...a: unknown[]) => {
      if (FREE.has(m)) return real(...a);
      const base = WRITES.has(m) ? lat.writeMs : lat.readMs;
      const ms = base * (1 + (lat.jitter ?? 0) * (draw() * 2 - 1));
      const role = m === 'placeOrder' ? String((a[0] as { role?: string }).role ?? '') || null : null;
      const call: VenueCall = { method: m, role, sentMs: performance.now(), backMs: Number.NaN, units: UNITS[m] ?? 3 };
      calls.push(call);
      live++; most = Math.max(most, live);
      try {
        await sleep(ms);
        return await real(...a);
      } finally {
        live--; call.backMs = performance.now();
      }
    };
  }
  return {
    calls,
    /** The most calls in flight at once. */
    mostInFlight: () => most,
    restore: () => { for (const [m, fn] of originals) target[m] = fn; },
  };
}
