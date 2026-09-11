import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rig, ceProduct, peProduct, planFor, quote, type Rig } from '../trading/harness.js';
import { StrategyStore } from '../../src/strategy/store.js';
import { StrategyAdder, type AdderDeps } from '../../src/strategy/adder.js';
import { addAlertFor, type Alert } from '../../src/notify/messages.js';
import { DEFAULT_CONFIG, type Strategy } from '../../src/strategy/types.js';

/**
 * The whole add, end to end: a CE and a PE sold by a strategy, the CE target
 * buying back, and the adder appending to the PE -- through the real journal,
 * the real engine and its gates, on the paper exchange.
 *
 * What these pin beyond the rules themselves: a decision is written before it
 * is acted on, so two looks at the same fill (the nudge and the 20-second tick)
 * or a restart never add twice; and every add that did not happen says why.
 */

const CE = 'C-BTC-80000-080926';
const PE = 'P-BTC-77000-080926';

const strategy = (over: Partial<Strategy> = {}, cfg: Partial<Strategy['config']> = {}): Strategy => ({
  id: 's', name: 'CE+PE add', enabled: true, createdAt: 0, updatedAt: 0,
  config: { ...DEFAULT_CONFIG, addToOpposite: { minPriceUsd: 3, maxMultiple: 2 }, ...cfg },
  ...over,
});

type Day = { r: Rig; store: StrategyStore; alerts: Alert[]; adder: StrategyAdder; deps: AdderDeps };

/**
 * 425 CE and 425 PE sold at 15. CE target 1.00, PE target 0.70 with a stop at 45.
 * Then the CE offer comes down to 1.00 -- `cePieces` at a time -- while the PE
 * sits at `pe` bid / ask.
 */
async function day(o: { pe?: [number, number]; cePieces?: number; ceOnly?: number; place?: AdderDeps['place'] } = {}): Promise<Day> {
  const r = rig({
    products: [ceProduct(), peProduct()],
    quotes: [quote(CE, 15, 15.5), quote(PE, 15, 15.5)],
    limits: { maxShortContracts: 5_000 },
  });
  const leg = (product: ReturnType<typeof ceProduct>, tradeId: string, lots: number, takeProfitPrice: number, stopPrice: number | null) =>
    r.engine.open(planFor(product, {
      tradeId, strategyId: 's', lots, leverage: 200, takeProfitPrice, stopPrice,
      entry: { type: 'limit', limitPrice: 15, timeoutMs: 0, marketFallback: false, chase: null },
    }));
  await leg(ceProduct(), 'CE-1', o.ceOnly ?? 425, 1, null);
  if (!o.ceOnly) await leg(peProduct(), 'PE-1', 425, 0.7, 45);
  await r.engine.poll('CE-1');
  if (!o.ceOnly) await r.engine.poll('PE-1');

  r.advance(60_000);
  const [bid, ask] = o.pe ?? [7, 7.5];
  r.ex.tick(quote(PE, bid, ask, { mark: (bid + ask) / 2, ts: r.now() }));
  if (o.cePieces) r.ex.configure({ partialFillSize: o.cePieces });
  r.ex.tick(quote(CE, 0.9, 1, { mark: 0.95, ts: r.now() }));
  await r.engine.poll('CE-1');
  r.ex.configure({ partialFillSize: undefined });

  const store = new StrategyStore(join(mkdtempSync(join(tmpdir(), 'adder-')), 'trades.db'));
  const alerts: Alert[] = [];
  const deps: AdderDeps = {
    store,
    tradesToday: (id) => r.store.all().filter((t) => t.plan.strategyId === id),
    quote: (symbol) => r.ex.getQuote(symbol),
    place: o.place ?? (async ({ tradeId, ...req }) => {
      const res = await r.engine.addToPosition(tradeId, req);
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    }),
    alert: (make) => { const a = make({ mode: 'paper' }); if (a) alerts.push(a); },
    addAlert: addAlertFor,
    now: r.now,
  };
  return { r, store, alerts, deps, adder: new StrategyAdder(deps) };
}

/** Poll the PE the way the service does, with its quote kept fresh, until the add has walked. */
async function walkPE(r: Rig, bid = 7, ask = 7.5) {
  for (let t = 0; t < 7_500; t += 1_250) {
    r.advance(1_250);
    r.ex.tick(quote(PE, bid, ask, { mark: (bid + ask) / 2, ts: r.now() }));
    await r.engine.poll('PE-1');
  }
  return r.store.get('PE-1')!.state;
}

test('[critical] the CE target buys back 425 while the PE bid is 7: 425 are appended to the PE, and written down', async () => {
  const { r, store, alerts, adder } = await day();
  assert.equal(r.store.get('CE-1')!.state.position, 0, 'the CE target bought all 425 back');

  await adder.consider(strategy());
  const pe = await walkPE(r);

  assert.equal(pe.position, -850);
  assert.equal(pe.addedSize, 425);
  const [row] = store.adds();
  assert.equal(row?.status, 'placed');
  assert.equal(row?.contracts, 425);
  assert.equal(row?.sourceTradeId, 'CE-1');
  assert.equal(row?.addedToTradeId, 'PE-1');
  assert.deepEqual(alerts, [], 'an add that happened is announced by its own fill, not here');
  const targets = (await r.ex.getOpenOrders(PE)).filter((x) => x.type === 'limit' && x.side === 'buy');
  assert.deepEqual(targets.map((x) => [x.size - x.filledSize, x.limitPrice]), [[850, 0.7]], 'the PE target at 0.70, for all 850');
});

test('[critical] the nudge and the tick looking at the same fill together still add once', async () => {
  const { r, store, adder } = await day();
  await Promise.all([adder.consider(strategy()), adder.consider(strategy())]);
  const pe = await walkPE(r);
  assert.equal(pe.position, -850, 'not 1,275');
  assert.equal(store.adds().length, 1);
});

test('[critical] a restart does not add the same contracts again', async () => {
  const { r, store, adder, deps } = await day();
  await adder.consider(strategy());
  await walkPE(r);
  await new StrategyAdder(deps).consider(strategy());
  const pe = await walkPE(r);
  assert.equal(pe.position, -850);
  assert.equal(store.adds().length, 1);
});

test('[critical] a target in pieces adds each piece once: 200, then the other 225', async () => {
  const { r, store, adder } = await day({ cePieces: 200 });
  assert.equal(r.store.get('CE-1')!.state.position, -225, 'the first piece: 200');
  await adder.consider(strategy());
  await walkPE(r);

  r.ex.tick(quote(CE, 0.9, 1, { mark: 0.95, ts: r.now() }));
  await r.engine.poll('CE-1');
  await adder.consider(strategy());
  const pe = await walkPE(r);

  assert.equal(pe.position, -850);
  assert.deepEqual(store.adds().map((a) => [a.contracts, a.status]).reverse(), [[200, 'placed'], [225, 'placed']]);
});

test('[critical] PE bid 2.00: nothing is sold, the skip is written down, and the phone is told why', async () => {
  const { r, store, alerts, adder } = await day({ pe: [2, 2.4] });
  await adder.consider(strategy());
  const pe = await walkPE(r, 2, 2.4);
  assert.equal(pe.position, -425);
  assert.equal(store.adds()[0]?.status, 'skipped');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!.text, /NOT ADDED/);
  assert.match(alerts[0]!.text, /PE bid 2\.00 is below \$3\.00/);
  assert.deepEqual((await r.ex.getOpenOrders(PE)).filter((x) => x.side === 'sell'), []);
});

test('[critical] PE at 30, double its 15 sale: not added to', async () => {
  const { r, store, adder } = await day({ pe: [29.8, 30.4] });
  await adder.consider(strategy());
  assert.equal(r.store.get('PE-1')!.state.position, -425);
  assert.match(store.adds()[0]!.detail, /2x or more its 15\.00 sale/);
});

test('[critical] a one-sided double day (CE 850, no PE): nothing to add to', async () => {
  const { store, alerts, adder } = await day({ ceOnly: 850 });
  await adder.consider(strategy());
  assert.equal(store.adds()[0]?.status, 'skipped');
  assert.match(alerts[0]!.text, /no PE leg today/);
});

test('the gates refusing the add is written down as refused, and said', async () => {
  const { r, store, alerts, adder } = await day();
  r.setFeed(false);
  await adder.consider(strategy());
  assert.equal(store.adds()[0]?.status, 'refused');
  assert.match(alerts[0]!.text, /ADD REFUSED/);
  assert.equal(r.store.get('PE-1')!.state.position, -425);
});

test('an add that throws is written down as failed, and said -- and not tried again', async () => {
  let calls = 0;
  const { store, alerts, adder } = await day({ place: async () => { calls += 1; throw new Error('socket hang up'); } });
  await adder.consider(strategy());
  await adder.consider(strategy());
  assert.equal(calls, 1);
  assert.equal(store.adds()[0]?.status, 'failed');
  assert.match(alerts[0]!.text, /ADD FAILED/);
});

test('switched off, or the strategy disarmed: nothing is decided and nothing is written', async () => {
  const off = await day();
  await off.adder.consider(strategy({}, { addToOpposite: null }));
  await off.adder.consider(strategy({ enabled: false }));
  assert.deepEqual(off.store.adds(), []);
  assert.equal(off.r.store.get('PE-1')!.state.position, -425);
});

test('[critical] the PE that was added to does not add back to the CE when its own target fills', async () => {
  const { r, store, adder } = await day();
  await adder.consider(strategy());
  await walkPE(r);
  r.ex.tick(quote(PE, 0.6, 0.7, { mark: 0.65, ts: r.now() }));
  await r.engine.poll('PE-1');
  assert.equal(r.store.get('PE-1')!.state.position, 0, 'all 850 bought back at 0.70');

  await adder.consider(strategy());
  const rows = store.adds();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.status, 'skipped');
  assert.match(rows[0]!.detail, /PE was itself added to today/);
  assert.equal(r.store.get('CE-1')!.state.position, 0, 'the CE stays closed');
});
