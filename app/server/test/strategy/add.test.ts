import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, initialTrade } from '../../src/trading/machine.js';
import type { TradePlan, TradeRecord } from '../../src/trading/engine.js';
import type { TradeEvent } from '../../src/trading/types.js';
import {
  ADD_FRESH_MS, decideAdds, type AddDecision, type AddQuote,
} from '../../src/strategy/add.js';
import { DEFAULT_CONFIG, type StrategyConfig } from '../../src/strategy/types.js';

/**
 * When a target buys contracts back, is the other leg added to -- and when not.
 *
 * The rule as it was asked for, on 11 September 2026:
 *
 *   sell CE $15, PE $15; the CE target buys back at $1.
 *   PE at $7  -> sell as many more PE as the CE bought back, at $7.
 *   PE at $2  -> do not.
 *   PE at $30 (doubled from its $15 sale) -> do not.
 *   a one-sided day (only CE, doubled to 850) -> nothing to add to.
 *
 * Every test here is one line of that, or one of the guards around it.
 */

const T = Date.UTC(2026, 8, 11, 3, 38, 0);        // 09:08 IST
const IST_0908 = 9 * 60 + 8;
const EXPIRY = Date.UTC(2026, 8, 11, 12, 0, 0) / 1000;

type LegOpts = {
  side: 'CE' | 'PE';
  sold?: number;
  size?: number;
  /** Target pieces bought back: [contracts, at]. */
  target?: [number, number][];
  stopFill?: number;
  closedBy?: 'exit';
  /** Contracts this leg was itself added to today. */
  added?: number;
  takeProfitPrice?: number | null;
  stopPrice?: number | null;
  expiryTs?: number;
  id?: string;
};

function leg(o: LegOpts): TradeRecord {
  const size = o.size ?? 425;
  const tradeId = o.id ?? `${o.side}-entry`;
  const symbol = `${o.side === 'CE' ? 'C' : 'P'}-BTC-${o.side === 'CE' ? 79600 : 74000}-110926`;
  const plan: TradePlan = {
    tradeId, symbol, strategyId: 's', optionSide: o.side, lots: size, leverage: 200,
    entry: { type: 'limit', limitPrice: o.sold ?? 15, timeoutMs: 0, marketFallback: false, chase: null },
    takeProfitPrice: o.takeProfitPrice === undefined ? 0.7 : o.takeProfitPrice,
    stopPrice: o.stopPrice === undefined ? null : o.stopPrice,
    expect: { underlying: 'BTC', optionSide: o.side, strike: o.side === 'CE' ? 79600 : 74000, expiryTs: o.expiryTs ?? EXPIRY },
  };
  const fill = (role: 'entry' | 'take_profit' | 'stop_loss' | 'exit', n: number, price: number, at: number): TradeEvent => ({
    t: 'fill', role, side: role === 'entry' ? 'sell' : 'buy', size: n, price, orderId: `${tradeId}-${role}`, at,
  });
  const events: TradeEvent[] = [fill('entry', size, o.sold ?? 15, T - 3 * 3600_000)];
  for (const [n, at] of o.target ?? []) events.push(fill('take_profit', n, 0.7, at));
  if (o.stopFill) events.push(fill('stop_loss', o.stopFill, 31, T));
  if (o.closedBy) events.push(fill('exit', size, 5, T));
  let state = initialTrade({ tradeId, symbol, productId: 1, optionSide: o.side, requestedSize: size, at: T - 3 * 3600_000, contractValue: 0.001 });
  for (const e of events) state = applyEvent(state, e);
  if (o.added) state = { ...state, addedSize: o.added };
  return { plan, state, events };
}

const PE_SYMBOL = 'P-BTC-74000-110926';
const CE_SYMBOL = 'C-BTC-79600-110926';

const on = (over: Partial<StrategyConfig['addToOpposite'] & object> = {}): StrategyConfig => ({
  ...DEFAULT_CONFIG, addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil: '16:59', ...over },
});

function decide(
  trades: TradeRecord[],
  quotes: Record<string, AddQuote>,
  o: { config?: StrategyConfig; decided?: Record<string, number>; now?: number; istMinutes?: number } = {},
): AddDecision[] {
  return decideAdds({
    config: o.config ?? on(),
    trades,
    decided: (id) => o.decided?.[id] ?? 0,
    quotes: new Map(Object.entries(quotes)),
    now: o.now ?? T + 5_000,
    nowIstMinutes: o.istMinutes ?? IST_0908,
  });
}

const q = (bid: number | null, ask: number | null, mark: number | null): AddQuote => ({ bid, ask, mark });
const only = (ds: AddDecision[]) => { assert.equal(ds.length, 1, JSON.stringify(ds.map((d) => d.detail))); return ds[0]!; };

// ------------------------------------------------------------- it adds

test('[critical] case 1 — CE target buys back 425 while the PE bid is 7: sell 425 more PE', () => {
  const d = only(decide(
    [leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE', stopPrice: 45 })],
    { [PE_SYMBOL]: q(7, 7.5, 7.2) },
  ));
  assert.equal(d.act, 'add');
  if (d.act !== 'add') return;
  assert.equal(d.contracts, 425);
  assert.equal(d.opposite.plan.symbol, PE_SYMBOL);
  // appended to the PE trade itself, so its own 0.70 target and stop cover the add
  assert.equal(d.opposite.state.tradeId, 'PE-entry');
});

test('[critical] case 2 — the mirror: PE target buys back while the CE bid is 7: sell more CE', () => {
  const d = only(decide(
    [leg({ side: 'CE' }), leg({ side: 'PE', target: [[425, T]] })],
    { [CE_SYMBOL]: q(7, 7.5, 7.2) },
  ));
  assert.equal(d.act, 'add');
  if (d.act === 'add') assert.equal(d.opposite.plan.symbol, CE_SYMBOL);
});

test('[critical] "or however many hit": a target that bought back 203 adds 203, not the 425 sold', () => {
  const d = only(decide([leg({ side: 'CE', target: [[200, T], [3, T + 1000]] }), leg({ side: 'PE' })], { [PE_SYMBOL]: q(7, 7.5, 7.2) }));
  assert.equal(d.act, 'add');
  assert.equal(d.contracts, 203);
});

test('[critical] exactly $3 is "equal or above": it adds', () => {
  const d = only(decide([leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE' })], { [PE_SYMBOL]: q(3, 3.3, 3.1) }));
  assert.equal(d.act, 'add');
});

test('[critical] the minimum is the setting, not a constant: $5 refuses a 4.00 bid and $4 takes it', () => {
  const trades = [leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE' })];
  const quotes = { [PE_SYMBOL]: q(4, 4.4, 4.2) };
  assert.equal(only(decide(trades, quotes, { config: on({ minPriceUsd: 5 }) })).act, 'skip');
  assert.equal(only(decide(trades, quotes, { config: on({ minPriceUsd: 4 }) })).act, 'add');
});

// ------------------------------------------------------------- it does not

test('[critical] case 3 — PE bid 2.00 is below $3: nothing is sold, and the reason says so', () => {
  const d = only(decide([leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE' })], { [PE_SYMBOL]: q(2, 2.4, 2.2) }));
  assert.equal(d.act, 'skip');
  assert.match(d.detail, /PE bid 2\.00 is below \$3\.00/);
});

test('[critical] case 4 — a one-sided double day (CE 850, no PE) has nothing to add to', () => {
  const d = only(decide([leg({ side: 'CE', size: 850, target: [[850, T]] })], {}));
  assert.equal(d.act, 'skip');
  assert.match(d.detail, /no PE leg today/);
});

test('[critical] the PE sold at 15 now at 30 has doubled: not adding to a losing leg', () => {
  const d = only(decide([leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE', sold: 15 })], { [PE_SYMBOL]: q(29.5, 30.5, 30) }));
  assert.equal(d.act, 'skip');
  assert.match(d.detail, /2x or more its 15\.00 sale/);
});

test('just under double still adds; the line is the mark, at 2x the sale price', () => {
  const trades = [leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE', sold: 15 })];
  assert.equal(only(decide(trades, { [PE_SYMBOL]: q(29.5, 30.2, 29.9) })).act, 'add');
  assert.equal(only(decide(trades, { [PE_SYMBOL]: q(29.5, 30.2, 30) })).act, 'skip');
});

test('the multiple is a setting too: at 1.5x a PE sold at 15 is not added to at 22.50', () => {
  const trades = [leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE', sold: 15 })];
  assert.equal(only(decide(trades, { [PE_SYMBOL]: q(22, 23, 22.5) }, { config: on({ maxMultiple: 1.5 }) })).act, 'skip');
});

test('[critical] the other leg already closed: an add would re-open a leg the day got out of', () => {
  const d = only(decide([leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE', closedBy: 'exit' })], { [PE_SYMBOL]: q(7, 7.5, 7.2) }));
  assert.equal(d.act, 'skip');
  assert.match(d.detail, /PE leg is already closed/);
});

test('[critical] a stop or a manual close is not a target: nothing is added', () => {
  assert.deepEqual(decide([leg({ side: 'CE', stopFill: 425 }), leg({ side: 'PE' })], { [PE_SYMBOL]: q(7, 7.5, 7.2) }), []);
  assert.deepEqual(decide([leg({ side: 'CE', closedBy: 'exit' }), leg({ side: 'PE' })], { [PE_SYMBOL]: q(7, 7.5, 7.2) }), []);
});

test('[critical] no ping-pong: a leg that was itself added to does not add back when its target fills', () => {
  const d = only(decide(
    [leg({ side: 'CE' }), leg({ side: 'PE', size: 850, added: 425, target: [[850, T]] })],
    { [CE_SYMBOL]: q(7, 7.5, 7.2) },
  ));
  assert.equal(d.act, 'skip');
  assert.match(d.detail, /was itself added to today/);
});

test('an add already working on the other leg: the next piece waits for it, and records nothing yet', () => {
  const pe = leg({ side: 'PE' });
  pe.state = { ...pe.state, adding: { clientOrderId: 'x', size: 200, limitPrice: 7, submittedAt: T, deadline: T + 1, chase: null, floorPrice: 3, unknown: false, entrySizeBefore: 425, source: { tradeId: 'CE-entry', optionSide: 'CE', boughtBack: 200 } } };
  const d = only(decide([leg({ side: 'CE', target: [[200, T], [3, T + 1000]] }), pe], { [PE_SYMBOL]: q(7, 7.5, 7.2) }, { decided: { 'CE-entry': 200 } }));
  assert.equal(d.act, 'wait');
});

test('the other leg closing (exit pending) is not added to', () => {
  const pe = leg({ side: 'PE' });
  pe.state = { ...pe.state, phase: 'exit_pending' };
  const d = only(decide([leg({ side: 'CE', target: [[425, T]] }), pe], { [PE_SYMBOL]: q(7, 7.5, 7.2) }));
  assert.equal(d.act, 'skip');
  assert.match(d.detail, /PE leg is exit pending/);
});

test('[critical] what was already decided is not decided again: 200 done, 3 new', () => {
  const trades = [leg({ side: 'CE', target: [[200, T], [3, T + 1000]] }), leg({ side: 'PE' })];
  const d = only(decide(trades, { [PE_SYMBOL]: q(7, 7.5, 7.2) }, { decided: { 'CE-entry': 200 } }));
  assert.equal(d.contracts, 3);
  assert.deepEqual(decide(trades, { [PE_SYMBOL]: q(7, 7.5, 7.2) }, { decided: { 'CE-entry': 203 } }), []);
});

test('[critical] a target filled more than two minutes ago is not acted on -- after a restart, say', () => {
  const d = only(decide([leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE' })], { [PE_SYMBOL]: q(7, 7.5, 7.2) }, { now: T + ADD_FRESH_MS + 1 }));
  assert.equal(d.act, 'skip');
  assert.match(d.detail, /too long ago/);
});

test('[critical] not after the latest time to add: 4:59 PM still adds, 5:00 PM does not', () => {
  const trades = [leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE' })];
  const quotes = { [PE_SYMBOL]: q(7, 7.5, 7.2) };
  assert.equal(only(decide(trades, quotes, { istMinutes: 16 * 60 + 59 })).act, 'add', 'the whole of the last minute counts');
  const late = only(decide(trades, quotes, { istMinutes: 17 * 60 }));
  assert.equal(late.act, 'skip');
  assert.match(late.detail, /after the 4:59 PM latest time to add/);
});

test('[critical] the latest time to add is the setting: at 12:00 PM, 12:01 PM is too late', () => {
  const trades = [leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE' })];
  const quotes = { [PE_SYMBOL]: q(7, 7.5, 7.2) };
  const cfg = on({ addUntil: '12:00' });
  assert.equal(only(decide(trades, quotes, { config: cfg, istMinutes: 12 * 60 })).act, 'add');
  assert.match(only(decide(trades, quotes, { config: cfg, istMinutes: 12 * 60 + 1 })).detail, /after the 12:00 PM/);
});

test('a strategy saved before the setting existed stops adding half an hour before its exit, as it always did', () => {
  const trades = [leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE' })];
  const old = { ...DEFAULT_CONFIG, exitTime: '15:00', addToOpposite: { minPriceUsd: 3, maxMultiple: 2 } } as unknown as StrategyConfig;
  assert.equal(only(decide(trades, { [PE_SYMBOL]: q(7, 7.5, 7.2) }, { config: old, istMinutes: 14 * 60 + 30 })).act, 'add');
  assert.equal(only(decide(trades, { [PE_SYMBOL]: q(7, 7.5, 7.2) }, { config: old, istMinutes: 14 * 60 + 31 })).act, 'skip');
});

test('no price for the other leg yet: it waits, and records nothing', () => {
  const trades = [leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE' })];
  assert.equal(only(decide(trades, {})).act, 'wait');
  assert.equal(only(decide(trades, { [PE_SYMBOL]: q(null, 7.5, 7.2) })).act, 'wait');
});

test('the other leg with no target has no price to exit an add at', () => {
  const d = only(decide([leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE', takeProfitPrice: null })], { [PE_SYMBOL]: q(7, 7.5, 7.2) }));
  assert.equal(d.act, 'skip');
});

test('a bid already at the target would be bought straight back: not added', () => {
  const d = only(decide(
    [leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE', sold: 60, takeProfitPrice: 4 })],
    { [PE_SYMBOL]: q(3.5, 4.5, 4) },
  ));
  assert.equal(d.act, 'skip');
  assert.match(d.detail, /already at its 4\.00 target/);
});

test('yesterday\'s leg on another expiry is not today\'s other leg', () => {
  const d = only(decide(
    [leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE', expiryTs: EXPIRY - 86_400 })],
    { [PE_SYMBOL]: q(7, 7.5, 7.2) },
  ));
  assert.equal(d.act, 'skip');
  assert.match(d.detail, /no PE leg today/);
});

test('switched off, it decides nothing at all', () => {
  assert.deepEqual(decide([leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE' })], { [PE_SYMBOL]: q(7, 7.5, 7.2) }, { config: DEFAULT_CONFIG }), []);
});

test('both targets filling at once decides each on its own: the CE add needs an open PE, and so on', () => {
  // both bought back fully: each finds the other already flat
  const ds = decide([leg({ side: 'CE', target: [[425, T]] }), leg({ side: 'PE', target: [[425, T]] })], {});
  assert.deepEqual(ds.map((d) => d.act), ['skip', 'skip']);
});

test('"doubled" is against the morning\'s sale, not an average an earlier add pulled down', () => {
  // PE sold 425 at 15, then 200 more added at 7: average 12.44, but doubled still means 30
  const pe = leg({ side: 'PE', sold: 15 });
  const addFill = { orderId: 'PE-add', role: 'entry' as const, side: 'sell' as const, size: 200, price: 7, ts: T };
  pe.state = { ...pe.state, fills: [...pe.state.fills, addFill], entrySize: 625, entryAvgPrice: (15 * 425 + 7 * 200) / 625, position: -625, addedSize: 200 };
  const trades = [leg({ side: 'CE', target: [[200, T], [3, T + 1000]] }), pe];
  const d = only(decide(trades, { [PE_SYMBOL]: q(25, 26, 25.5) }, { decided: { 'CE-entry': 200 } }));
  assert.equal(d.act, 'add', '25.50 is under 2x 15, though it is over 2x the 12.44 average');
});
