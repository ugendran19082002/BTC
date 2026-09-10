import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chaseFloor, type TradePlan } from '../../src/trading/engine.js';
import { DEFAULT_CONFIG, validateConfig } from '../../src/strategy/types.js';
import { ceProduct, planFor, quote, rig } from './harness.js';

/*
 * Scheduled entries rest at the offer and walk toward the bid -- but sell into
 * the bid only while the spread is tight. On a 37 / 44 book (a 17% spread)
 * selling at 37 gives three and a half points away on the spot; the order waits
 * at the mid instead, and carries on to the bid once the spread narrows.
 */

const CE = ceProduct().symbol;

const chased = (over: { maxCrossSpreadPct?: number | null; timeoutMs?: number } = {}): TradePlan =>
  planFor(ceProduct(), {
    lots: 1, stopPrice: null, takeProfitPrice: null,
    entry: {
      type: 'limit', limitPrice: 44, timeoutMs: over.timeoutMs ?? 0, marketFallback: false,
      chase: {
        steps: 4, everyMs: 1_000,
        maxCrossSpreadPct: over.maxCrossSpreadPct === undefined ? 0.15 : over.maxCrossSpreadPct,
      },
    },
  });

/** Move the clock a second at a time on an unchanged book, polling each time. */
async function hold(r: ReturnType<typeof rig>, plan: TradePlan, seconds: number, bid: number, ask: number) {
  for (let i = 0; i < seconds; i += 1) {
    r.advance(1_000);
    r.ex.tick(quote(CE, bid, ask, { mark: (bid + ask) / 2, ts: r.now() }));
    await r.engine.poll(plan.tradeId);
  }
}

const restingEntry = async (r: ReturnType<typeof rig>) =>
  (await r.ex.getOpenOrders(CE)).find((o) => !o.reduceOnly) ?? null;

test('the floor: the mid while the spread is wide, the bid once it is tight, the bid always without a limit', () => {
  assert.equal(chaseFloor(37, 44, 0.15), 40.5, '17.3% is wider than 15%');
  assert.equal(chaseFloor(39, 42, 0.15), null, '7.4% is within 15%');
  assert.equal(chaseFloor(37, 44, null), null, 'no limit: the bid is allowed, as the ticket always did');
  assert.equal(chaseFloor(37, null, 0.15), Number.POSITIVE_INFINITY, 'no offer to measure: hold where it is');
});

test('[critical] a wide spread stops the walk at the middle, and nothing is sold into the bid', async () => {
  const r = rig({ quotes: [quote(CE, 37, 44, { mark: 40.5 })] });
  const plan = chased();
  const opened = await r.engine.open(plan);
  assert.equal(opened.ok, true, JSON.stringify(opened));

  await hold(r, plan, 6, 37, 44);   // well past the four one-second steps

  assert.equal((await restingEntry(r))?.limitPrice, 40.5, 'resting at the middle of 37 / 44');
  assert.equal(r.store.get(plan.tradeId)!.state.position, 0, 'nothing sold at 37');
});

test('[critical] when the spread narrows, the walk carries on to the bid and fills there', async () => {
  const r = rig({ quotes: [quote(CE, 37, 44, { mark: 40.5 })] });
  const plan = chased();
  await r.engine.open(plan);
  await hold(r, plan, 6, 37, 44);

  // the book tightens to 39 / 42 -- a 7.4% spread
  await hold(r, plan, 1, 39, 42);

  const st = r.store.get(plan.tradeId)!.state;
  assert.equal(st.position, -1, 'sold');
  assert.equal(st.fills[0]!.price, 39, 'at the bid, now that the spread is tight');
});

test('without a limit -- the order ticket -- the walk still goes to the bid, as before', async () => {
  const r = rig({ quotes: [quote(CE, 37, 44, { mark: 40.5 })] });
  const plan = chased({ maxCrossSpreadPct: null });
  await r.engine.open(plan);
  await hold(r, plan, 6, 37, 44);

  const st = r.store.get(plan.tradeId)!.state;
  assert.equal(st.position, -1);
  assert.equal(st.fills[0]!.price, 37, 'the ticket crosses whatever the spread, exactly as it did');
});

test('[critical] if the spread never narrows, the order is cancelled when the window closes', async () => {
  const r = rig({ quotes: [quote(CE, 37, 44, { mark: 40.5 })] });
  const plan = chased({ timeoutMs: 10_000 });
  await r.engine.open(plan);
  await hold(r, plan, 12, 37, 44);

  const st = r.store.get(plan.tradeId)!.state;
  assert.equal(st.position, 0, 'nothing sold');
  assert.equal(st.phase, 'aborted', 'the entry ended');
  assert.equal(await restingEntry(r), null, 'and nothing is left resting on the book');
});

test('the strategy setting defaults to 15%, refuses nonsense, and accepts an older config without it', () => {
  assert.equal(DEFAULT_CONFIG.maxCrossSpreadPct, 0.15);
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, maxCrossSpreadPct: 0 }).some((m) => /spread limit/.test(m)));
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, maxCrossSpreadPct: 1.5 }).some((m) => /spread limit/.test(m)));
  const { maxCrossSpreadPct: _dropped, ...older } = DEFAULT_CONFIG;
  assert.deepEqual(validateConfig(older), [], 'a strategy saved before this setting existed still validates');
});
