import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ceProduct, planFor, quote, rig } from './harness.js';
import { SQUARE_OFF_RETRY_MS, SessionLossGuard, type SessionHit } from '../../src/trading/session-loss.js';
import { USDINR } from '../../src/domain/score.js';

/**
 * A strategy moved from 1 lot to 2 (owner, 7 Nov 2026: "strategy lot update pana correct work aagumaa?"; "ellam testcase
 * paniru"). What a lot changes, end to end: the entry's size, the target's and stop's, the close, and the short limit,
 * which counts contracts. And the session loss limit's three gaps found the same night, fixed: its base priced by the
 * strategies' own lots (test/http/session-loss-route.test.ts), its line kept through a restart, and a square-off that
 * left trades open tried again on those trades.
 */

const SYMBOL = ceProduct().symbol;
const short2 = (tradeId: string) => ({
  ...planFor(ceProduct(), { lots: 2, stopPrice: 70, takeProfitPrice: 2, entry: { type: 'limit', limitPrice: 20, timeoutMs: 0, marketFallback: false, chase: null } }),
  tradeId,
});

test('[critical] a 2-lot strategy sells 2 contracts, and its target and stop rest at 2 each, reduce-only', async () => {
  const r = rig({ quotes: [quote(SYMBOL, 20, 20.5)] });
  const plan = short2('two-a');
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  await r.engine.poll(plan.tradeId);
  const rec = r.store.peek(plan.tradeId)!;
  assert.equal(rec.state.entrySize, 2);
  assert.equal(rec.state.position, -2);
  const book = await r.ex.getOpenOrders(SYMBOL);
  const tp = book.find((o) => o.clientOrderId === rec.state.protection.takeProfit)!;
  const sl = book.find((o) => o.clientOrderId === rec.state.protection.stopLoss)!;
  assert.equal(tp.size, 2);
  assert.equal(sl.size, 2);
  assert.ok(tp.reduceOnly && sl.reduceOnly);
});

test('[critical] the stop reached on a 2-lot trade closes both contracts, not one', async () => {
  const r = rig({ quotes: [quote(SYMBOL, 20, 20.5)] });
  const plan = short2('two-b');
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  await r.engine.poll(plan.tradeId);
  r.ex.setQuote(quote(SYMBOL, 90, 91));
  for (let i = 0; i < 4; i++) { await r.engine.poll(plan.tradeId); r.advance(2_000); }
  const after = r.store.peek(plan.tradeId)!;
  assert.equal(after.state.position, 0, `phase ${after.state.phase}`);
  assert.equal(after.state.exitSize, 2);
});

test('[critical] the short limit counts contracts: at 3, a second 2-lot trade is refused and nothing is sold', async () => {
  const r = rig({ quotes: [quote(SYMBOL, 20, 20.5)], limits: { maxShortContracts: 3 } });
  const a = short2('two-c'), b = short2('two-d');
  await r.engine.open(a);
  await r.engine.poll(a.tradeId);
  assert.equal(r.store.peek(a.tradeId)!.state.position, -2);
  await r.engine.open(b);
  await r.engine.poll(b.tradeId);
  const rb = r.store.peek(b.tradeId)!;
  assert.equal(rb.state.position, 0);
  assert.equal(rb.state.entrySize, 0);
  assert.ok(rb.events.some((e) => /MAX_POSITION|total short/.test(JSON.stringify(e))), JSON.stringify(rb.events.map((e) => e.t)));
});

// ---- The session loss limit ----

const at = (hhmm: string) => Date.parse(`2026-11-08T${hhmm}:00+05:30`);
const PCT = { on: true, sessions: [{ from: '07:00', to: '17:29', limit: 15, unit: 'pct' as const }] };
type Done = { closed: string[]; cancelled: string[]; failed: { tradeId: string; reason: string }[] };
/** One account's guard; `kept` and `hits` stand for the database, so a second guard over them is the desk after a restart. */
function guard(o: { now: () => number; base: () => number; net: () => number; baselineUsd?: number; kept?: Map<string, number>; hits?: SessionHit[]; squareOff?: (only?: readonly string[]) => Promise<Done> }) {
  const hits = o.hits ?? [];
  const kept = o.kept ?? new Map<string, number>();
  const asked: (readonly string[] | undefined)[] = [];
  const retries: number[] = [];
  const g = new SessionLossGuard({
    now: o.now, rule: () => PCT,
    pctBaseUsd: async () => o.base(),
    netUsd: async () => o.net(),
    netUsdAt: async () => o.baselineUsd ?? 0,
    squareOff: async (only) => { asked.push(only); return o.squareOff ? o.squareOff(only) : { closed: ['x'], cancelled: [], failed: [] }; },
    record: async (h) => { hits.push(h); },
    hitsOn: async () => hits,
    said: () => {},
    fixedLimit: { get: async (k) => kept.get(k) ?? null, set: async (k, v) => { kept.set(k, v); } },
    retried: (left) => { retries.push(left); },
  });
  return { g, hits, kept, asked, retries, squares: () => asked.length };
}

test('[critical] the session limit in rupees is 15% of the base it is given, fixed at the start', async () => {
  let now = at('07:00');
  const { g } = guard({ now: () => now, base: () => 100, net: () => 0 });
  await g.tick();
  assert.equal(g.status(now)!.limitInr, 0.15 * 100 * USDINR);
});

test('[critical] the session limit stays what it was at the start after a restart mid-session', async () => {
  let now = at('07:00');
  let base = 100;
  const one = guard({ now: () => now, base: () => base, net: () => 0 });
  await one.g.tick();
  const before = one.g.status(now)!.limitInr;
  // Mid-session: a deploy, and by now the base reads differently (Delta's own margin with positions open).
  now = at('11:00');
  base = 160;
  const two = guard({ now: () => now, base: () => base, net: () => 0, baselineUsd: 0, kept: one.kept });
  await two.g.tick();
  assert.equal(two.g.status(now)!.limitInr, before);
  // The next day's session is its own: worked out again.
  now = Date.parse('2026-11-09T07:00:00+05:30');
  const three = guard({ now: () => now, base: () => base, net: () => 0, kept: one.kept });
  await three.g.tick();
  assert.equal(three.g.status(now)!.limitInr, 0.15 * 160 * USDINR);
});

test('a limit changed during the session is worked out again; the same limit keeps its line', async () => {
  let now = at('07:00');
  let base = 100;
  const one = guard({ now: () => now, base: () => base, net: () => 0 });
  await one.g.tick();
  base = 200;
  now = at('08:00');
  await one.g.tick();
  assert.equal(one.g.status(now)!.limitInr, 0.15 * 100 * USDINR, 'same rule, same line');
  PCT.sessions[0]!.limit = 10;
  try {
    now = at('08:01');
    await one.g.tick();
    assert.equal(one.g.status(now)!.limitInr, 0.10 * 200 * USDINR, 'a new rule, a new line');
  } finally { PCT.sessions[0]!.limit = 15; }
});

test('[critical] a square-off that leaves trades open is tried again, on those trades only, until the account is flat', async () => {
  let now = at('09:00');
  let net = 0;
  let left = 2;
  const { g, asked, retries, squares } = guard({
    now: () => now, base: () => 10, net: () => net,
    squareOff: async (only) => (only === undefined
      ? { closed: ['a', 'b'], cancelled: [], failed: [{ tradeId: 't', reason: 'Delta rate limit reached.' }] }
      : left-- > 0 ? { closed: [], cancelled: [], failed: [{ tradeId: 't', reason: 'Delta rate limit reached.' }] } : { closed: ['t'], cancelled: [], failed: [] }),
  });
  await g.tick();
  net = -(0.15 * 10) * 2;
  await g.tick();
  now += 16_000;
  await g.tick();
  assert.equal(squares(), 1, 'the hit');
  // Not every tick: the next try waits its turn.
  now += 5_000; await g.tick();
  assert.equal(squares(), 1);
  for (let i = 0; i < 4; i++) { now += SQUARE_OFF_RETRY_MS; await g.tick(); }
  assert.deepEqual(asked, [undefined, ['t'], ['t'], ['t']], 'only the trade left open, and no more once flat');
  assert.deepEqual(retries, [1, 1, 0]);
  assert.match(g.entryBlock(now)!, /session lost/);
});

test('[critical] a restart after a square-off that left trades open tries again; one that closed everything does not', async () => {
  const now = at('10:00');
  const hit = (failed: number): SessionHit => ({ day: '2026-11-08', from: '07:00', to: '17:29', limitInr: 100, lossInr: 120, at: at('09:30'), closed: 5, cancelled: 0, failed, detail: '' });
  const owed = guard({ now: () => now, base: () => 10, net: () => 0, hits: [hit(2)] });
  await owed.g.restore(now);
  await owed.g.tick();
  assert.deepEqual(owed.asked, [undefined]);
  const clean = guard({ now: () => now, base: () => 10, net: () => 0, hits: [hit(0)] });
  await clean.g.restore(now);
  await clean.g.tick();
  assert.deepEqual(clean.asked, []);
});

test('the day over, nothing more is tried: tomorrow trades as usual', async () => {
  let now = at('17:00');
  let net = 0;
  const { g, squares } = guard({ now: () => now, base: () => 10, net: () => net, squareOff: async () => ({ closed: [], cancelled: [], failed: [{ tradeId: 't', reason: 'x' }] }) });
  await g.tick();
  net = -10;
  await g.tick();
  now += 16_000;
  await g.tick();
  const after = squares();
  now = Date.parse('2026-11-09T00:01:00+05:30');
  await g.tick();
  assert.equal(squares(), after);
  assert.equal(g.entryBlock(now), null);
});
