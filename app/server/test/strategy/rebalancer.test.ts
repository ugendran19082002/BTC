import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyStore } from '../../src/strategy/store.js';
import { MemorySettings } from '../../src/db/settings.js';
import { closePool } from '../../src/db/pool.js';
import { StrategyRebalancer, type RebalancerDeps } from '../../src/strategy/rebalancer.js';
import { DEFAULT_REBALANCE } from '../../src/strategy/rebalance.js';
import { DEFAULT_CONFIG, type Strategy } from '../../src/strategy/types.js';
import type { TradeRecord } from '../../src/trading/engine.js';

/**
 * The acting half of the rebalance: confirmations, the write-before-the-order,
 * and the one order of operations that is safe.
 *
 * The rules themselves are in `rebalance.test.ts`. What is pinned here is the
 * behaviour a restart or a bad fill can break: a stage is written down before
 * anything is sent, the same stage can never be written twice, the confirmation
 * count resets when the condition stops holding, and **a failed buy-back never
 * sells**.
 */

// One database for the file. Each test uses its own strategy id, so the
// journal's uniqueness is real and nothing needs wiping between them; the
// settings are one in-memory copy shared the way the desk's cache is.
const settings = new MemorySettings();
const openStore = () => StrategyStore.open(settings);
after(() => closePool());

const BASE = 15;

const rec = (side: 'CE' | 'PE', lots: number): TradeRecord => ({
  plan: {
    tradeId: `${side}-1`, symbol: `${side === 'CE' ? 'C' : 'P'}-BTC-80000-180926`,
    optionSide: side, lots, leverage: 200, takeProfitPrice: null, stopPrice: null,
    entry: { type: 'limit', limitPrice: BASE, timeoutMs: 0, marketFallback: false, chase: null },
    expect: { underlying: 'BTC', optionSide: side, strike: 80_000, expiryTs: 1_789_646_400 },
  },
  state: {
    tradeId: `${side}-1`, symbol: `${side === 'CE' ? 'C' : 'P'}-BTC-80000-180926`,
    optionSide: side, phase: 'open', position: -lots, requestedSize: lots,
    entrySize: lots, entryAvgPrice: BASE, exitSize: 0, exitAvgPrice: null, addedSize: 0,
    fills: [{ role: 'entry', size: lots, price: BASE, ts: 1 }],
    protection: { takeProfit: null, stopLoss: null },
    realisedPnl: 0, note: null, alarm: null, updatedAt: 1, contractValue: 0.001,
  },
  events: [],
} as unknown as TradeRecord);

const strategy = (over: Partial<Strategy['config']> = {}): Strategy => ({
  id: `s-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Double one-sided', enabled: true, createdAt: 0, updatedAt: 0,
  config: {
    ...DEFAULT_CONFIG,
    entryTime: '17:30', exitTime: '17:29', legs: 'both', lots: 100,
    premium: { mode: 'atLeast', usd: BASE },
    rebalance: { ...DEFAULT_REBALANCE, enabled: true, confirmTicks: 2 },
    ...over,
  },
});

/** 11:00 IST on 18 September 2026, inside the 13:30 cutoff. */
const NOW = Date.UTC(2026, 8, 18, 5, 30);

type Sent = { buys: [string, number][]; sells: { tradeId: string; size: number; floorPrice: number }[] };

async function rig(o: { ce?: number; pe?: number; buyOk?: boolean; sellOk?: boolean } = {}) {
  const store = await openStore();
  const sent: Sent = { buys: [], sells: [] };
  const said: string[] = [];
  const trades = [rec('CE', 100), rec('PE', 100)];
  const marks: Record<string, number> = {
    'C-BTC-80000-180926': o.ce ?? 15,
    'P-BTC-80000-180926': o.pe ?? 15,
  };
  const deps: RebalancerDeps = {
    store,
    tradesToday: () => trades,
    quote: async (symbol) => ({ bid: marks[symbol]! - 0.2, ask: marks[symbol]! + 0.2, mark: marks[symbol]! }),
    buyBack: async (tradeId, lots) => {
      sent.buys.push([tradeId, lots]);
      return o.buyOk === false ? { ok: false, reason: 'not enough margin' } : { ok: true };
    },
    sell: async (order) => {
      sent.sells.push({ tradeId: order.tradeId, size: order.size, floorPrice: order.floorPrice ?? 0 });
      return o.sellOk === false ? { ok: false, reason: 'spread too wide' } : { ok: true };
    },
    tell: (t) => said.push(t),
    now: () => NOW,
  };
  return { store, deps, sent, said, marks, rebalancer: new StrategyRebalancer(deps) };
}

// ---------------------------------------------------------------------------

test('[critical] 5-6. it acts only after the condition holds for two readings', async () => {
  const { rebalancer, sent, store } = await rig({ pe: 19.5, ce: 12 });
  const s = strategy();
  await rebalancer.consider(s);
  assert.deepEqual(sent.buys, [], 'one reading is a quote, not a move');
  await rebalancer.consider(s);
  assert.deepEqual(sent.buys, [['CE-1', 30]]);
  assert.deepEqual(sent.sells.map((x) => [x.tradeId, x.size]), [['PE-1', 30]]);
  const [row] = (await store.rebalances()).filter((r) => r.strategyId === s.id);
  assert.equal(row?.status, 'done');
  assert.equal(row?.stage, 1);
  assert.equal(row?.upSide, 'PE');
  assert.equal(row?.downSide, 'CE');
  assert.equal(row?.lots, 30);
});

test('[critical] 5. a reading that stops holding resets the count', async () => {
  const r = await rig({ pe: 19.5, ce: 12 });
  const s = strategy();
  await r.rebalancer.consider(s);          // 1 of 2
  r.marks['P-BTC-80000-180926'] = 17;      // condition gone
  await r.rebalancer.consider(s);
  r.marks['P-BTC-80000-180926'] = 19.5;    // back again: counts from one
  await r.rebalancer.consider(s);
  assert.deepEqual(r.sent.buys, [], 'the two readings have to be consecutive');
  await r.rebalancer.consider(s);
  assert.equal(r.sent.buys.length, 1);
});

test('[critical] 16. a stage is written down before the order, and can never be written twice', async () => {
  const { rebalancer, store, sent } = await rig({ pe: 19.5, ce: 12 });
  const s = strategy();
  await rebalancer.consider(s);
  await rebalancer.consider(s);
  assert.equal(sent.buys.length, 1);
  // a second rebalancer -- a restart, or a second tick -- meets the same row
  const again = new StrategyRebalancer({ ...(await rig({ pe: 19.5, ce: 12 })).deps, store });
  await again.consider(s);
  await again.consider(s);
  assert.equal((await store.rebalances()).filter((r) => r.strategyId === s.id).length, 1);
});

test('[critical] 15. a buy-back that is refused never sells: the desk ends up flatter, never larger', async () => {
  const { rebalancer, sent, store, said } = await rig({ pe: 19.5, ce: 12, buyOk: false });
  const s = strategy();
  await rebalancer.consider(s);
  await rebalancer.consider(s);
  assert.equal(sent.buys.length, 1);
  assert.deepEqual(sent.sells, [], 'nothing is sold when the buy-back did not happen');
  const [row] = (await store.rebalances()).filter((r) => r.strategyId === s.id);
  assert.equal(row?.status, 'failed');
  assert.match(row!.detail, /buy back refused: not enough margin/);
  assert.match(said.join(' '), /failed to buy back 30 CE/);
});

test('a sell refused after the buy is recorded as partial, and said so', async () => {
  const { rebalancer, store, said } = await rig({ pe: 19.5, ce: 12, sellOk: false });
  const s = strategy();
  await rebalancer.consider(s);
  await rebalancer.consider(s);
  const [row] = (await store.rebalances()).filter((r) => r.strategyId === s.id);
  assert.equal(row?.status, 'partial');
  assert.match(row!.detail, /bought back 30 CE; the sell was refused/);
  assert.match(said.join(' '), /but selling PE was refused/);
});

test('the sell is floored at the bid that was on the screen when the stage fired', async () => {
  const { rebalancer, sent } = await rig({ pe: 19.5, ce: 12 });
  const s = strategy();
  await rebalancer.consider(s);
  await rebalancer.consider(s);
  assert.equal(sent.sells[0]!.floorPrice, 19.3);   // 19.50 mark, 0.40 wide
});

test('[critical] switched off, or on a one-sided day, it does nothing at all', async () => {
  const off = await rig({ pe: 19.5, ce: 12 });
  await off.rebalancer.consider(strategy({ rebalance: { ...DEFAULT_REBALANCE, enabled: false } }));
  await off.rebalancer.consider(strategy({ rebalance: null }));
  assert.deepEqual(off.sent.buys, []);

  const oneSided = await rig({ pe: 19.5, ce: 12 });
  oneSided.deps.tradesToday = () => [rec('PE', 100)];
  const solo = new StrategyRebalancer(oneSided.deps);
  await solo.consider(strategy());
  await solo.consider(strategy());
  assert.deepEqual(oneSided.sent.buys, []);
});

test('[critical] a refusal is written once, and does not ask again every tick', async () => {
  // nothing left to buy back on the fallen side
  const r = await rig({ pe: 19.5, ce: 12 });
  r.deps.tradesToday = () => [rec('PE', 100), { ...rec('CE', 0), state: { ...rec('CE', 0).state, entrySize: 100, position: 0 } } as TradeRecord];
  const only = new StrategyRebalancer(r.deps);
  const s = strategy();
  await only.consider(s);
  await only.consider(s);
  const rows = (await r.store.rebalances()).filter((x) => x.strategyId === s.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'skipped');
  assert.match(rows[0]!.detail, /nothing left on the CE to buy back/);
  assert.deepEqual(r.sent.buys, []);
});

test('the stages run 1, 2, 3 and then stop', async () => {
  const r = await rig({ pe: 19.5, ce: 12 });
  const s = strategy();
  const twice = async () => { await r.rebalancer.consider(s); await r.rebalancer.consider(s); };
  await twice();                                         // stage 1
  r.marks['P-BTC-80000-180926'] = 21; r.marks['C-BTC-80000-180926'] = 10.5;
  await twice();                                         // stage 2
  r.marks['P-BTC-80000-180926'] = 22.5; r.marks['C-BTC-80000-180926'] = 9;
  await twice();                                         // stage 3
  await twice();                                         // nothing left to do
  const rows = (await r.store.rebalances()).filter((x) => x.strategyId === s.id).sort((a, b) => a.stage - b.stage);
  assert.deepEqual(rows.map((x) => [x.stage, x.status]), [[1, 'done'], [2, 'done'], [3, 'done']]);
  assert.equal(r.sent.buys.length, 3);
});

test('the defaults and the limits are settings, not numbers in the source', async () => {
  const store = await openStore();
  assert.equal(store.rebalanceDefaults().steps, 3);
  await store.setRebalanceDefaults({ steps: 5, upStartPct: 40, downStartPct: 25, incrementPct: 5 });
  assert.deepEqual(
    [store.rebalanceDefaults().steps, store.rebalanceDefaults().upStartPct],
    [5, 40],
    'a new rule starts where the desk says it starts',
  );
  // a limit is a setting too, and the ceiling behind it is not
  assert.equal((await store.setRebalanceLimits({ maxSteps: 40 })).maxSteps, 40);
  assert.equal((await store.setRebalanceLimits({ maxSteps: 9_999 })).maxSteps, 100, 'the hard ceiling holds');
  await store.setRebalanceDefaults({ steps: 3, upStartPct: 30, downStartPct: 20, incrementPct: 10 });
  await store.setRebalanceLimits({ maxSteps: 20 });
});

/*
 * "If not filled, sell at bid after N seconds", on the rebalance sell.
 *
 * The buy-back has already happened when the sell goes out, so a sell that
 * rests at the offer all afternoon leaves the stage half done. The rule carries
 * its own seconds, and falls back to the strategy's entry seconds where it has
 * none -- which is what every rule saved before the control existed used.
 */
test('[critical] the rebalance sell walks for the rule\'s own seconds', async () => {
  const r = await rig({ pe: 19.5, ce: 12 });
  const seen: number[] = [];
  r.deps.sell = async (o) => { seen.push(o.chaseSeconds); return { ok: true }; };
  const only = new StrategyRebalancer(r.deps);
  const s = strategy({
    crossAfterSec: 7,
    rebalance: { ...DEFAULT_REBALANCE, enabled: true, confirmTicks: 2, crossAfterSec: 45 },
  });
  await only.consider(s);
  await only.consider(s);
  assert.deepEqual(seen, [45]);
});

test('a rule with no seconds of its own uses the strategy\'s entry seconds', async () => {
  const r = await rig({ pe: 19.5, ce: 12 });
  const seen: number[] = [];
  r.deps.sell = async (o) => { seen.push(o.chaseSeconds); return { ok: true }; };
  const only = new StrategyRebalancer(r.deps);
  const s = strategy({ crossAfterSec: 7 });   // rebalance.crossAfterSec is null
  await only.consider(s);
  await only.consider(s);
  assert.deepEqual(seen, [7]);
});

test('zero rests at the offer; the add window is what ends it', async () => {
  const r = await rig({ pe: 19.5, ce: 12 });
  const seen: { chase: number; timeout: number }[] = [];
  r.deps.sell = async (o) => { seen.push({ chase: o.chaseSeconds, timeout: o.timeoutMs }); return { ok: true }; };
  const only = new StrategyRebalancer(r.deps);
  const s = strategy({ rebalance: { ...DEFAULT_REBALANCE, enabled: true, confirmTicks: 2, crossAfterSec: 0 } });
  await only.consider(s);
  await only.consider(s);
  assert.deepEqual(seen, [{ chase: 0, timeout: 5 * 60_000 }]);
});

