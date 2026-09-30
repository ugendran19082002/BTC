import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { tradeView } from '../../src/http/routes/trade.routes.js';
import { closePool } from '../../src/db/pool.js';
import { rig, ceProduct, planFor, quote } from '../trading/harness.js';

after(closePool);

/**
 * What the position card is told, for one trade.
 *
 * 30 Sep 2026, two fixes. "If closed now" was priced at the mark, a price no
 * close prints: buying a short back pays the offer, which is what the close
 * sheet has always used. And the P&L was sized from Delta's row for the
 * contract, which with two strategies on one strike (decision 0011) is both
 * trades' contracts, not this one's.
 */

const CE = ceProduct().symbol;

async function shortAt(entry: number) {
  const r = rig({ quotes: [quote(CE, entry, entry + 0.5)] });
  const plan = planFor(ceProduct(), {
    lots: 100, stopPrice: null, takeProfitPrice: null,
    entry: { type: 'limit', limitPrice: entry, timeoutMs: 0, marketFallback: false, chase: null },
  });
  await r.engine.open(plan);
  await r.engine.poll(plan.tradeId);
  return r.store.peek(plan.tradeId)!;
}

test('[critical] "If closed now" buys back at the offer, not the mark', async () => {
  const rec = await shortAt(20);
  const q = quote(CE, 9, 11, { mark: 10 });
  const v = tradeView(rec, [], 0.001, q, 80_000);
  const atAsk = tradeView(rec, [], 0.001, { ...q, mark: 11 }, 80_000);
  assert.equal(v.live.netIfClosedUsd, atAsk.live.netIfClosedUsd, 'the same whatever the mark says: it is the ask');
  assert.ok(v.live.netIfClosedUsd! < v.live.unrealisedPnl!, 'paying the offer is worse than the mark says');
});

test('with no offer on the book it falls back to the mark, rather than a blank', async () => {
  const rec = await shortAt(20);
  const v = tradeView(rec, [], 0.001, quote(CE, 9, 0, { mark: 10, ask: null as unknown as number }), 80_000);
  assert.notEqual(v.live.netIfClosedUsd, null);
});

test('[critical] the P&L is this trade\'s own contracts, not Delta\'s row for the whole contract', async () => {
  const rec = await shortAt(20);
  const alone = tradeView(rec, [{ symbol: CE, size: -100, entryPrice: 20 } as never], 0.001, quote(CE, 9, 11, { mark: 10 }), 80_000);
  const shared = tradeView(rec, [{ symbol: CE, size: -200, entryPrice: 20 } as never], 0.001, quote(CE, 9, 11, { mark: 10 }), 80_000);
  assert.equal(shared.live.unrealisedPnl, alone.live.unrealisedPnl, 'another strategy\'s 100 on the same strike is not this card\'s');
  assert.equal(alone.live.unrealisedPnl, (20 - 10) * 100 * 0.001);
});
