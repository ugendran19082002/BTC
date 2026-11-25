import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, planFor, quote } from './harness.js';
import { CLOSE_FOLLOW_UP_MS, MAX_CLOSE_TRIES } from '../../src/trading/engine.js';
import { isRateLimited, rateLimitedWaitMs } from '../../src/trading/exchange/port.js';

/**
 * Closes that met Delta's rate limit (25 Nov 2026, 14:02 IST). BTC ran +0.89% in ten minutes; the BTC-move exit sent
 * 440 closes across four accounts in three minutes, on logins already at 60-90% of their quota. 37 were refused: their
 * stops' and targets' cancels were refused too, so the stops stayed on -- yet each was marked "POSITION UNPROTECTED",
 * dropped by the square-off, never looked at again by the urgent watch (every login past its 50%), and its target no
 * longer stepped. Two more -- a cap-swap close at 12:09 and two 58,800 PE on 24 Nov -- tried three times in four
 * seconds, gave up, and held their contracts with no stop at Delta for hours.
 *
 * Each case here: a refused close is an answer (nothing placed), the position is never left without a stop, and the
 * close is tried again once Delta's wait is over.
 */

const CE = ceProduct().symbol;

async function opened() {
  const r = rig();
  const plan = planFor(ceProduct(), { lots: 2 });
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  assert.equal(r.store.peek(plan.tradeId)!.state.phase, 'protected');
  return { r, plan };
}

test('[critical] Delta\'s rate-limit words are read wherever they come from, with the wait it named', () => {
  assert.equal(isRateLimited(new Error('Delta rate limit reached; 5s until it resets.')), true);
  assert.equal(isRateLimited(new Error('order refused: Delta rate limit reached; 3s until it resets.')), true);
  assert.equal(isRateLimited(new Error('Delta refused the request (insufficient_margin).')), false);
  assert.equal(isRateLimited('rate limit reached'), false, 'only an error');
  assert.equal(rateLimitedWaitMs(new Error('Delta rate limit reached; 3s until it resets.')), 3_000);
  assert.equal(rateLimitedWaitMs(new Error('Delta rate limit reached.')), 5_000);
});

test('[critical] a close refused by the rate limit, its stop\'s cancel refused too: the stop is still on, so the position stays protected -- not "unprotected"', async () => {
  const { r, plan } = await opened();
  const stopBefore = r.store.peek(plan.tradeId)!.state.protection.stopLoss;
  r.ex.configure({ rateLimitCancels: 2, nextFault: { kind: 'rate_limited' }, nextFaultOn: 'exit' });
  const s = await r.engine.closeNow(plan.tradeId, 'btc move exit');
  assert.equal(s?.position, -2, 'nothing was bought back');
  assert.equal(s?.phase, 'protected', 'its stop never came off');
  assert.equal(s?.protection.stopLoss, stopBefore);
  assert.equal(s?.closing, null, 'no close is working');
  assert.equal(s?.alarm, null);
  assert.match(s?.note ?? '', /rate limit reached.*the stop is still on/);
  assert.equal(r.alarms.filter((a) => /UNPROTECTED/.test(a.message)).length, 0, 'no unprotected alarm for a covered position');
});

test('[critical] a close refused by the rate limit after its stop came off: unprotected for the wait Delta named, then the stop goes back on', async () => {
  const { r, plan } = await opened();
  r.ex.configure({ nextFault: { kind: 'rate_limited' }, nextFaultOn: 'exit' });
  const s = await r.engine.closeNow(plan.tradeId, 'btc move exit');
  assert.equal(s?.position, -2);
  assert.equal(s?.phase, 'unprotected', 'the stop was taken off for the close');
  assert.equal(s?.closing, null, 'no close is working: nothing was placed');
  // Inside Delta's wait the stop is not sent into the same refusal ...
  await r.engine.poll(plan.tradeId);
  assert.equal(r.store.peek(plan.tradeId)!.state.phase, 'unprotected', 'not inside the 5 s wait');
  // ... and goes back on at the first poll after it.
  r.advance(5_000);
  r.ex.tick(quote(CE, 100.5, 101, { ts: r.now() }));
  const after = await r.engine.poll(plan.tradeId);
  assert.equal(after?.phase, 'protected', 'the stop is back on');
  assert.ok(after?.protection.stopLoss, 'a stop rests again');
});

test('[critical] a close that gives up after its tries puts the stop and target back -- never left holding with nothing at Delta', async () => {
  const r = rig();
  const plan = planFor(ceProduct(), { lots: 100 });
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  r.ex.configure({ slippageLadder: [{ price: 101, size: 5 }] });   // a thin book: each try fills only a little
  await r.engine.closeNow(plan.tradeId, 'manual exit');
  for (let i = 0; i < MAX_CLOSE_TRIES + 3; i++) {
    r.advance(CLOSE_FOLLOW_UP_MS);
    await r.engine.poll(plan.tradeId);
  }
  const s = r.store.peek(plan.tradeId)!.state;
  assert.ok(s.position < 0, 'still short');
  assert.equal(r.store.peek(plan.tradeId)!.events.filter((e) => e.t === 'exit_submitted').length, MAX_CLOSE_TRIES, 'no more tries at the market');
  assert.equal(s.phase, 'protected', 'covered again');
  assert.ok(s.protection.stopLoss, 'its stop is back on');
  assert.equal(s.closing, null);
  const said = r.alarms.filter((a) => /after 3 tries at the market/.test(a.message));
  assert.equal(said.length, 1, 'said once');
  assert.match(said[0]!.message, /stop and target are put back on/);
});

const { EntryWatch, ENTRY_WATCH_QUOTA_PCT, CLOSE_WATCH_QUOTA_PCT, BARE_RETRY_MS } = await import('../../src/trading/entry-watch.js');

test('[critical] a position with no stop on is looked at past the others\' share of the quota, as a close is -- once every couple of seconds, none past the stops\' share', async () => {
  const settled = () => new Promise((r) => setTimeout(r, 1));
  const polled: string[] = [];
  let used = ENTRY_WATCH_QUOTA_PCT + 20;
  let now = 1_000_000;
  const w = new EntryWatch({
    poll: async (id) => { polled.push(id); return { phase: id.startsWith('bare') ? 'unprotected' : 'entry_pending', position: -2 }; },
    quotaUsedPct: () => used, now: () => now,
  });
  w.note([
    { state: { tradeId: 'bare-1', phase: 'unprotected', position: -2 } },
    { state: { tradeId: 'entry-1', phase: 'entry_pending', position: 0 } },
  ] as never);
  assert.deepEqual(w.tick(), ['bare-1'], 'the bare position, past the entries\' share; the entry waits');
  await settled();
  now += 250;
  assert.deepEqual(w.tick(), [], 'not again within its wait');
  now += BARE_RETRY_MS;
  assert.deepEqual(w.tick(), ['bare-1'], 'again once it is due');
  await settled();
  used = CLOSE_WATCH_QUOTA_PCT;
  now += BARE_RETRY_MS;
  assert.deepEqual(w.tick(), [], 'past the stops\' share, nothing');
});

async function desk(fail: Record<string, number>) {
  const { TradingService } = await import('../../src/trading/service.js');
  const { MemoryTradeStore } = await import('../../src/trading/engine.js');
  const { SettingsCache } = await import('../../src/db/settings.js');
  const svc = new TradingService({ settings: await new SettingsCache().load(), store: new MemoryTradeStore() as never, notifier: null });
  const trades = [
    { id: 'A', symbol: 'C-BTC-60000-251126' }, { id: 'B', symbol: 'C-BTC-60200-251126' }, { id: 'C', symbol: 'C-BTC-59800-251126' },
  ];
  const recs = trades.map((t) => ({ state: { tradeId: t.id, symbol: t.symbol, position: -2, entryAvgPrice: 40, contractValue: 0.001 } }));
  const inside = svc as unknown as { openTrades: () => Promise<unknown[]>; engine: unknown };
  inside.openTrades = async () => recs;
  const tries = new Map<string, number>();
  inside.engine = {
    closeNow: async (id: string) => {
      tries.set(id, (tries.get(id) ?? 0) + 1);
      // Refused by the rate limit, as the engine leaves it: still held, the words on the trade.
      if ((fail[id] ?? 0) >= tries.get(id)!) {
        return { position: -2, fills: [], phase: 'protected', alarm: null, note: 'btc move exit failed: Delta rate limit reached; 5s until it resets. -- the stop is still on' };
      }
      return { position: 0, fills: [], phase: 'flat', alarm: null, note: null };
    },
    cancelEntry: async () => {},
  };
  svc.squareOffQuote = () => ({ bid: 40, ask: 41, mark: null });
  svc.quotaUsedPct = () => 0;
  return { svc, tries };
}

test('[critical] the square-off tries a rate-limited close again after the wait, and counts it closed -- not failed', async () => {
  const { svc, tries } = await desk({ B: 2 });
  const out = await svc.closeAll(undefined, 'btc move exit', 'worst-first');
  assert.deepEqual([...out.closed].sort(), ['A', 'B', 'C']);
  assert.deepEqual(out.failed, []);
  assert.equal(tries.get('B'), 3, 'twice refused, the third went');
});

test('[critical] ... and gives one up only after its tries, saying so', async () => {
  const { CLOSE_RATE_RETRIES } = await import('../../src/trading/service.js');
  const { svc, tries } = await desk({ C: 99 });
  const out = await svc.closeAll(undefined, 'btc move exit', 'worst-first');
  assert.deepEqual([...out.closed].sort(), ['A', 'B']);
  assert.deepEqual(out.failed.map((f) => f.tradeId), ['C']);
  assert.equal(tries.get('C'), CLOSE_RATE_RETRIES + 1);
});

test('[critical] closing all by hand, one at a time, also waits a refusal out and tries again', async () => {
  const { svc, tries } = await desk({ A: 1 });
  const out = await svc.closeAll();
  assert.deepEqual([...out.closed].sort(), ['A', 'B', 'C']);
  assert.equal(tries.get('A'), 2);
});

test('[critical] a position already marked unprotected whose stop rests at Delta reads protected at its next poll -- the 29 left over from 25 Nov 14:02', async () => {
  const { r, plan } = await opened();
  // As those were left before the fix: the close refused, the cancels refused, marked unprotected with its stop still on.
  const rec = r.store.peek(plan.tradeId)!;
  await r.store.save({ ...rec, state: { ...rec.state, phase: 'unprotected', alarm: 'POSITION UNPROTECTED: btc move exit failed: Delta rate limit reached; 5s until it resets.' } } as never);
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.phase, 'protected', 'its stop is resting: covered');
  assert.equal(s?.alarm, null);
  assert.equal(s?.protection.stopLoss, rec.state.protection.stopLoss, 'the same stop, nothing placed again');
});

test('[critical] ... and one whose stop is really gone gets a new one at that poll', async () => {
  const { r, plan } = await opened();
  const rec = r.store.peek(plan.tradeId)!;
  const stopId = rec.state.protection.stopLoss!;
  const order = await r.ex.getOrderByClientId(stopId, CE);
  await r.ex.cancelOrder({ orderId: order!.orderId });
  await r.store.save({ ...rec, state: { ...rec.state, phase: 'unprotected', alarm: 'POSITION UNPROTECTED: test' } } as never);
  const s = await r.engine.poll(plan.tradeId);
  assert.equal(s?.phase, 'protected');
  assert.ok(s?.protection.stopLoss, 'a stop rests again');
});

test('[critical] a close sent after an earlier one gave up has its own tries -- not given up at its first look (25 Nov 2026, P-58200)', async () => {
  const r = rig();
  const plan = planFor(ceProduct(), { lots: 100 });
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  r.ex.configure({ slippageLadder: [{ price: 101, size: 5 }] });   // a thin book: each try fills only a little
  await r.engine.closeNow(plan.tradeId, 'manual exit');
  for (let i = 0; i < MAX_CLOSE_TRIES + 2; i++) { r.advance(CLOSE_FOLLOW_UP_MS); await r.engine.poll(plan.tradeId); }
  assert.equal(r.store.peek(plan.tradeId)!.state.phase, 'protected', 'the first close gave up and its stop went back');
  const sentBefore = r.store.peek(plan.tradeId)!.events.filter((e) => e.t === 'exit_submitted').length;
  // A new close (a swap, say): it is followed up at the market, as any close is, before it can give up.
  await r.engine.closeNow(plan.tradeId, 'bought back for a new signal');
  r.advance(CLOSE_FOLLOW_UP_MS);
  await r.engine.poll(plan.tradeId);
  const after = r.store.peek(plan.tradeId)!;
  assert.equal(after.events.filter((e) => e.t === 'exit_submitted').length, sentBefore + 2, 'sent, then followed up once');
  assert.equal(after.events.filter((e) => e.t === 'protection_failed' && (e as { close?: boolean }).close).length, 1, 'not given up again at its first look');
});
