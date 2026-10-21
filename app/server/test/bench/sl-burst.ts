import { OptionStopWatch, stopWatchedOf } from '../../src/trading/stop-watch.js';
import { ceProduct, planFor, quote, rig } from '../trading/harness.js';
import { withLatency, type Latency, type VenueCall } from '../trading/venue-latency.js';

/**
 * Many stops at once, timed (21 Oct 2026, the architecture plan's step 1: "a 50-trade simultaneous-SL load test; Go
 * only after a benchmark").
 *
 * The real engine and the real stop watch, the paper exchange behind them made as slow as Delta is from the desk's
 * host. N short trades, each with its target and its backstop resting, on one contract (how 2:20 PM on 20 Oct hit) or
 * spread over five; then the offer and the mark go through every stop together -- the case the desk closes at the
 * first look (`STOP_CONFIRM_FAST_MS` 0). Measured from that look: when the first and the last buy-back were sent, when
 * every trade was flat, how many calls it took, the most in flight at once, and what it cost of Delta's quota.
 *
 * An offer alone through the stop waits `STOP_CONFIRM_MS` (3 s) first; that wait is a rule, not a speed, and is not
 * timed here. Delta's own quota line is not modelled: the cost column is what to hold it against.
 *
 *   npm run bench:sl            (about a minute)
 */

type Row = { n: number; contracts: number; lat: Latency; firstMs: number; lastMs: number; flatMs: number; calls: number; most: number; units: number; exits: number; flat: number; byKind: string };

async function burst(n: number, contracts: number, lat: Latency): Promise<Row> {
  const products = Array.from({ length: contracts }, (_, i) => ceProduct({ symbol: `C-BTC-${80_000 + i * 200}-080926`, productId: 111 + i, strike: 80_000 + i * 200 }));
  const r = rig({
    products, quotes: products.map((p) => quote(p.symbol, 100.5, 101)),
    limits: { allowPyramiding: true, maxShortContracts: 100_000 }, balanceUsd: 10_000_000,
  });
  for (let i = 0; i < n; i++) {
    const p = products[i % contracts]!;
    const opened = await r.engine.open(planFor(p, { tradeId: `t${i}`, stopPrice: 110, lots: 1 }));
    if (!opened.ok) throw new Error(`t${i} not opened: ${JSON.stringify(opened)}`);
    await r.engine.poll(`t${i}`);
  }
  const board = { at: r.now(), asks: new Map<string, number>() };
  const w = new OptionStopWatch({ asks: () => board, quotaUsedPct: () => 0, now: () => r.now(), check: (s, ids) => r.engine.checkStops(s, ids) });
  w.note(stopWatchedOf(await r.store.open()));
  if (w.size !== n) throw new Error(`${w.size} of ${n} watched`);

  // Through every stop, offer and mark together.
  for (const p of products) { r.ex.tick(quote(p.symbol, 111, 112, { ts: r.now(), mark: 111.5 })); board.asks.set(p.symbol, 112); }
  board.at = r.now();
  const venue = withLatency(r.ex, lat);
  const t0 = performance.now();
  w.tick();
  await w.settle();
  const flatMs = performance.now() - t0;
  venue.restore();

  const exits = venue.calls.filter((c) => c.method === 'placeOrder' && c.role === 'exit');
  let flat = 0;
  for (let i = 0; i < n; i++) if ((await r.store.get(`t${i}`))!.state.position === 0) flat++;
  const kinds = new Map<string, number>();
  for (const c of venue.calls) kinds.set(c.method, (kinds.get(c.method) ?? 0) + 1);
  return {
    n, contracts, lat,
    firstMs: Math.min(...exits.map((c) => c.sentMs)) - t0, lastMs: Math.max(...exits.map((c) => c.sentMs)) - t0, flatMs,
    calls: venue.calls.length, most: venue.mostInFlight(), units: venue.calls.reduce((s, c: VenueCall) => s + c.units, 0),
    exits: exits.length, flat,
    byKind: [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '),
  };
}

const LATENCIES: Latency[] = [
  { readMs: 120, writeMs: 200, jitter: 0.25 }, // the desk's host today
  { readMs: 300, writeMs: 600, jitter: 0.25 }, // Delta slow, a busy minute
];
const rows: Row[] = [];
for (const lat of LATENCIES) {
  for (const contracts of [1, 5]) {
    for (const n of [1, 10, 25, 50]) {
      if (n < contracts) continue;
      rows.push(await burst(n, contracts, lat));
    }
  }
}

const s = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
console.log('\nStops at once, offer and mark through every stop: timed from the first look\n');
console.log('| Trades | Contracts | Delta read / order | First buy-back sent | Last sent | All flat | Calls | Most in flight | Quota units | Buy-backs | Flat |');
console.log('|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const x of rows) {
  console.log(`| ${x.n} | ${x.contracts} | ${x.lat.readMs} / ${x.lat.writeMs} ms | ${s(x.firstMs)} | ${s(x.lastMs)} | ${s(x.flatMs)} | ${x.calls} | ${x.most} | ${x.units} | ${x.exits} | ${x.flat}/${x.n} |`);
}
console.log('\nCalls, the 50 on one contract at today\'s latency:', rows.find((x) => x.n === 50 && x.contracts === 1)?.byKind);
const bad = rows.filter((x) => x.flat !== x.n || x.exits !== x.n);
if (bad.length) { console.error('\nNOT ALL CLOSED ONCE:', bad.map((x) => `${x.n}x${x.contracts}`).join(', ')); process.exit(1); }
