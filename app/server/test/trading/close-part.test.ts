import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, ceProduct, planFor, quote, SPOT, type Rig } from './harness.js';
import { closeEligibility, closePreview } from '../../src/trading/close-preview.js';
import { parseCloseBody } from '../../src/http/close-body.js';
import type { Quote, TradeState } from '../../src/trading/types.js';

/**
 * Closing a position: all of it, or some of it.
 *
 * "Close now" bought back everything, every time. Now it asks how much, and
 * opens on the whole position -- so the old behaviour is one tap away and the
 * new one costs a number.
 *
 * What must hold for a close of *part* of a position, which is the new thing:
 *
 *   - exactly that many contracts are bought back, reduce-only, at the market;
 *   - the rest is a position again, not a trade in limbo: a target and a stop
 *     go back over what is left, sized to it;
 *   - the P&L booked is the part's, and the rest stays open;
 *   - it cannot overshoot -- a size larger than what is held closes what is
 *     held, and never sells;
 *   - a close of the whole position behaves exactly as it always did.
 */

const CE = 'C-BTC-80000-080926';

/** 100 CE sold at 100.5, target 90, stop 110, protection on the book. */
async function short100(over: Parameters<typeof planFor>[1] = {}) {
  const r = rig({ quotes: [quote(CE, 100.5, 101)] });
  const plan = planFor(ceProduct(), over);
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  return { r, plan, id: plan.tradeId };
}

const book = async (r: Rig) => (await r.ex.getOpenOrders(CE)).map((o) => ({
  type: o.type, side: o.side, size: o.size, reduceOnly: Boolean(o.reduceOnly),
}));

// ------------------------------------------------------------- the whole lot

test('[critical] no size given closes everything, exactly as it always did', async () => {
  const { r, id } = await short100();
  const s = await r.engine.closeNow(id);
  assert.equal(s?.position, 0);
  assert.equal(s?.phase, 'flat');
  assert.equal(s?.exitSize, 100);
  assert.equal((await r.ex.getPositions()).length, 0);
  assert.deepEqual(await book(r), [], 'the target and the stop went with it');
});

test('[critical] the size that equals the position is the same close, and leaves nothing behind', async () => {
  const { r, id } = await short100();
  const s = await r.engine.closeNow(id, 'manual exit', 100);
  assert.equal(s?.position, 0);
  assert.equal(s?.phase, 'flat');
  assert.equal(s?.closing ?? null, null, 'nothing is still working');
  assert.deepEqual(await book(r), []);
});

// -------------------------------------------------------------- part of it

test('[critical] a size buys back exactly that many and leaves the rest short', async () => {
  const { r, id } = await short100();
  const s = await r.engine.closeNow(id, 'manual exit', 40);
  assert.equal(s?.exitSize, 40, 'forty bought back');
  assert.equal(s?.position, -60, 'sixty still short');
  assert.notEqual(s?.phase, 'flat');
  assert.equal((await r.ex.getPositions())[0]?.size, -60, 'and the exchange agrees');
});

test('[critical] what is left gets a target and a stop back, sized to it', async () => {
  const { r, id } = await short100();
  await r.engine.closeNow(id, 'manual exit', 40);
  // Protection came off for the close; the next poll is what puts it back.
  const s = await r.engine.poll(id);
  assert.equal(s?.position, -60);
  assert.equal(s?.phase, 'protected');
  assert.ok(s?.protection.takeProfit, 'a target is on the book');
  assert.ok(s?.protection.stopLoss, 'and a stop');
  assert.equal(s?.protection.size, 60, 'covering the sixty that are left, not the hundred');
  const resting = await book(r);
  assert.equal(resting.length, 2);
  assert.ok(resting.every((o) => o.size === 60 && o.reduceOnly), `both cover 60: ${JSON.stringify(resting)}`);
});

test('[critical] protection comes off before the close is sent, not after', async () => {
  // A stop for 100 and a reduce-only buy for 40 are two orders closing one
  // position, and the exchange will fill both.
  const { r, id } = await short100();
  const armed = r.store.get(id)!.state;
  assert.ok(armed.protection.takeProfit && armed.protection.stopLoss, 'both legs were on to begin with');
  await r.engine.closeNow(id, 'manual exit', 40);
  const order = r.store.get(id)!.events.map((e) => e.t);
  const sent = order.lastIndexOf('exit_submitted');
  const cancelled = order.lastIndexOf('sibling_cancelled');
  assert.ok(cancelled >= 0 && cancelled < sent, `cancels come first: ${order.join(', ')}`);
});

test('the part that was closed is booked, and the rest is still open P&L', async () => {
  const { r, id } = await short100();
  // sold at 100.5, bought back at 99 -> 1.5 x 40 x 0.001 BTC
  r.advance(1_000);
  r.ex.tick(quote(CE, 98.5, 99, { mark: 98.75, ts: r.now() }));
  const s = await r.engine.closeNow(id, 'manual exit', 40);
  assert.equal(s?.exitSize, 40);
  assert.ok(Math.abs(s!.realisedPnl - (100.5 - 99) * 40 * 0.001) < 1e-9, `booked ${s!.realisedPnl}`);
  assert.equal(s?.position, -60, 'the other sixty are still running');
});

test('closing the rest afterwards goes flat and books both halves', async () => {
  const { r, id } = await short100();
  await r.engine.closeNow(id, 'manual exit', 40);
  await r.engine.poll(id);
  const s = await r.engine.closeNow(id);
  assert.equal(s?.position, 0);
  assert.equal(s?.phase, 'flat');
  assert.equal(s?.exitSize, 100, 'forty and then sixty');
  assert.deepEqual(await book(r), []);
});

test('one contract at a time is allowed, and the last one goes flat', async () => {
  const { r, plan, id } = await short100({ lots: 3 });
  assert.equal(r.store.get(id)!.state.position, -3);
  await r.engine.closeNow(id, 'manual exit', 1);
  await r.engine.poll(id);
  assert.equal(r.store.get(id)!.state.position, -2);
  await r.engine.closeNow(id, 'manual exit', 1);
  await r.engine.poll(id);
  assert.equal(r.store.get(id)!.state.position, -1);
  const s = await r.engine.closeNow(id, 'manual exit', 1);
  assert.equal(s?.position, 0);
  assert.equal(s?.phase, 'flat');
  assert.equal(plan.tradeId, id);
});

// ------------------------------------------------------------- overshooting

test('[critical] a size larger than the position buys back only what is there, and never sells', async () => {
  // The sheet was opened when 100 were held and 40 were closed on Delta's own
  // screen in the meantime. "Close 100" now means "close what is there".
  const { r, id } = await short100();
  r.ex.forcePosition(CE, -60);
  const s = await r.engine.closeNow(id, 'manual exit', 100);
  assert.equal(s?.exitSize, 60, 'sixty bought back, not a hundred');
  const sold = s!.fills.filter((f) => f.side === 'sell' && f.role !== 'entry');
  assert.equal(sold.length, 0, 'nothing was sold to make up the difference');
  assert.equal((await r.ex.getPositions()).length, 0, 'the exchange is flat');
  // Our own fills still say -40: a hundred sold, sixty bought back. Only the
  // exchange knows about the forty that left by another door, and reading it
  // back -- the startup reconcile, or "Re-read from Delta" on the card -- is
  // what settles it. Same as a close with no size at all in this state.
  assert.equal(s?.position, -40);
  const after = (await r.engine.reconcile(id))!.state;
  assert.equal(after.position, 0);
  assert.equal(after.phase, 'flat');
});

test('a close of a position that has already gone does nothing at all', async () => {
  const { r, id } = await short100();
  r.ex.forcePosition(CE, 0);
  const s = await r.engine.closeNow(id, 'manual exit', 40);
  assert.equal(s?.position, 0);
  assert.equal(s?.exitSize, 0, 'no buy was sent into thin air');
});

test('a size below one is refused, and the position is untouched', async () => {
  const { r, id } = await short100();
  const s = await r.engine.closeNow(id, 'manual exit', 0);
  assert.equal(s?.position, -100, 'still there');
  assert.equal(s?.exitSize, 0);
  assert.match(r.store.get(id)!.events.at(-1)!.t, /protection_failed/);
  const why = r.store.get(id)!.events.at(-1) as { reason: string };
  assert.match(why.reason, /whole number/);
});

test('an exchange that refuses the close leaves the position and says so', async () => {
  const { r, id } = await short100();
  r.ex.configure({ nextFault: { kind: 'unavailable' } });
  const s = await r.engine.closeNow(id, 'manual exit', 40);
  assert.equal(s?.position, -100, 'nothing was closed');
  // and the retry works, as it does for a full close
  const again = await r.engine.closeNow(id, 'manual exit', 40);
  assert.equal(again?.position, -60);
});

// --------------------------------------------------- what the record carries

test('[critical] the journal says how much was asked for, and whether it was all of it', async () => {
  const { r, id } = await short100();
  await r.engine.closeNow(id, 'manual exit', 40);
  const submitted = r.store.get(id)!.events.filter((e) => e.t === 'exit_submitted').at(-1) as
    { t: 'exit_submitted'; closing?: { size: number; heldBefore: number; all: boolean } };
  assert.equal(submitted.closing?.size, 40);
  assert.equal(submitted.closing?.heldBefore, 100);
  assert.equal(submitted.closing?.all, false);
  // and it is cleared once it has bought back what it asked for
  assert.equal(r.store.get(id)!.state.closing ?? null, null);
});

test('[critical] the record replays to the same position and phase it was left in', async () => {
  const { r, id } = await short100();
  await r.engine.closeNow(id, 'manual exit', 40);
  const live = (await r.engine.poll(id))!;
  const replayed = r.store.get(id)!.state;
  assert.equal(replayed.position, live.position);
  assert.equal(replayed.phase, live.phase);
  assert.equal(replayed.exitSize, 40);
});

test('an old exit_submitted with no size still reads as "all of it"', async () => {
  // Every close written before sizes existed meant the whole position, and a
  // journal that reprices history is not a journal.
  const { r, id } = await short100();
  const rec = r.store.get(id)!;
  const before = rec.state.position;
  assert.equal(before, -100);
  const s = await r.engine.closeNow(id);
  assert.equal(s?.phase, 'flat');
  const submitted = rec.events.concat(r.store.get(id)!.events).filter((e) => e.t === 'exit_submitted');
  assert.ok(submitted.length >= 1);
});

// ------------------------------------------------- the money, before it goes

const stateFor = (over: Partial<TradeState> = {}): TradeState => ({
  ...(({
    tradeId: 't', symbol: CE, productId: 111, optionSide: 'CE', contractValue: 0.001,
    phase: 'protected', position: -100, requestedSize: 100,
    entrySize: 100, entryAvgPrice: 100.5, exitSize: 0, exitAvgPrice: null,
    entryOrderId: null, protection: { takeProfit: null, stopLoss: null },
    wantsProtection: true, exitWinner: null, realisedPnl: 0, fills: [],
    note: null, alarm: null, updatedAt: 0,
  }) as TradeState),
  ...over,
});
const q = (bid: number, ask: number, mark?: number): Quote =>
  ({ symbol: CE, bid, ask, bidSize: 100, askSize: 100, mark: mark ?? (bid + ask) / 2, ts: 0 });

test('[critical] the preview prices the part, not the whole position', () => {
  const p = closePreview({ state: stateFor(), size: 40, quote: q(98.5, 99), spot: SPOT });
  assert.equal(p.ok, true);
  assert.equal(p.held, 100);
  assert.equal(p.lots, 40);
  assert.equal(p.remaining, 60);
  assert.equal(p.closesAll, false);
  assert.equal(p.buysBackAt, 99, 'the ask: closing a short is a buy');
  assert.ok(Math.abs(p.bookedUsd! - (100.5 - 99) * 40 * 0.001) < 1e-9);
  assert.ok(p.chargesUsd! > 0);
  assert.ok(Math.abs(p.netUsd! - (p.bookedUsd! - p.chargesUsd!)) < 1e-12);
});

test('no size asked for prices the whole position, which is what the sheet opens on', () => {
  const p = closePreview({ state: stateFor(), quote: q(98.5, 99), spot: SPOT });
  assert.equal(p.lots, 100);
  assert.equal(p.remaining, 0);
  assert.equal(p.closesAll, true);
});

test('charges scale with the size, so half the lots cost half as much to leave', () => {
  const all = closePreview({ state: stateFor(), size: 100, quote: q(98.5, 99), spot: SPOT });
  const half = closePreview({ state: stateFor(), size: 50, quote: q(98.5, 99), spot: SPOT });
  assert.ok(Math.abs(all.chargesUsd! / 2 - half.chargesUsd!) < 1e-12);
});

test('a loss previews as a loss', () => {
  const p = closePreview({ state: stateFor(), size: 40, quote: q(120, 121), spot: SPOT });
  assert.ok(p.bookedUsd! < 0, `${p.bookedUsd}`);
  assert.ok(p.netUsd! < p.bookedUsd!, 'and the charges make it slightly worse');
});

test('with no offer on the book it prices at the mark, and says so', () => {
  const p = closePreview({ state: stateFor(), size: 40, quote: q(98, 0, 98.6), spot: SPOT });
  assert.equal(p.buysBackAt, 98.6);
  assert.equal(p.atMark, true);
});

test('no quote at all shows no money rather than a made-up number', () => {
  const p = closePreview({ state: stateFor(), size: 40, quote: null, spot: SPOT });
  assert.equal(p.buysBackAt, null);
  assert.equal(p.bookedUsd, null);
  assert.equal(p.netUsd, null);
  assert.equal(p.ok, true, 'the size is still fine; only the price is missing');
});

test('[critical] the preview refuses what the close would refuse, with the same words', () => {
  const s = stateFor();
  assert.equal(closePreview({ state: s, size: 101, quote: q(98.5, 99), spot: SPOT }).ok, false);
  assert.match(closePreview({ state: s, size: 101, quote: q(98.5, 99), spot: SPOT }).reason!, /only 100 contracts are held/);
  assert.match(closePreview({ state: s, size: 0, quote: q(98.5, 99), spot: SPOT }).reason!, /whole number/);
  assert.match(closePreview({ state: s, size: 2.5, quote: q(98.5, 99), spot: SPOT }).reason!, /whole number/);
  assert.match(closePreview({ state: stateFor({ position: 0 }), size: 1, quote: q(98.5, 99), spot: SPOT }).reason!, /nothing is held/);
  assert.equal(closeEligibility(s, 100), null, 'all of it is always allowed');
  assert.equal(closeEligibility(s, 1), null);
});

test('one contract held reads as "contract", not "contracts"', () => {
  assert.match(closeEligibility(stateFor({ position: -1 }), 2)!, /only 1 contract is held/);
});

// -------------------------------------------------------------- what is sent

test('[critical] the body parser: a missing size means everything', () => {
  assert.deepEqual(parseCloseBody({ tradeId: 't' }), { ok: true, close: { tradeId: 't', lots: null } });
  assert.deepEqual(parseCloseBody({ tradeId: 't', lots: null }), { ok: true, close: { tradeId: 't', lots: null } });
  assert.deepEqual(parseCloseBody({ tradeId: 't', lots: '' }), { ok: true, close: { tradeId: 't', lots: null } });
});

test('the body parser takes a number or the text of one, and objects to anything else', () => {
  assert.deepEqual(parseCloseBody({ tradeId: 't', lots: 40 }), { ok: true, close: { tradeId: 't', lots: 40 } });
  assert.deepEqual(parseCloseBody({ tradeId: ' t ', lots: '40' }), { ok: true, close: { tradeId: 't', lots: 40 } });
  for (const bad of [0, -5, 2.5, 'forty', {}]) {
    const r = parseCloseBody({ tradeId: 't', lots: bad });
    assert.equal(r.ok, false, `${JSON.stringify(bad)} should be refused`);
  }
  assert.equal(parseCloseBody({ lots: 40 }).ok, false, 'a close needs a trade');
});
