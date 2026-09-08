import { PaperExchange } from '../../src/trading/exchange/paper.js';
import { MemoryTradeStore, TradeEngine, type TradePlan } from '../../src/trading/engine.js';
import { DEFAULT_LIMITS, type RiskLimits } from '../../src/trading/precheck.js';
import type { ProductSpec, Quote } from '../../src/trading/types.js';

/**
 * One BTC daily option contract and an exchange that will do whatever a test
 * needs it to. Time is a variable, so a five-second timeout costs nothing.
 */

export const EXPIRY_TS = 1_700_040_000; // seconds
export const T0 = 1_700_000_000_000;    // ms, well before the expiry
/** BTC spot the margin model works from. */
export const SPOT = 80_000;

export const ceProduct = (over: Partial<ProductSpec> = {}): ProductSpec => ({
  symbol: 'C-BTC-80000-080926',
  productId: 111,
  underlying: 'BTC',
  optionSide: 'CE',
  strike: 80_000,
  expiryTs: EXPIRY_TS,
  tickSize: 0.1,
  lotSize: 1,
  contractValue: 0.001,
  state: 'live',
  ...over,
});

export const peProduct = (over: Partial<ProductSpec> = {}): ProductSpec => ({
  ...ceProduct(),
  symbol: 'P-BTC-77000-080926',
  productId: 222,
  optionSide: 'PE',
  strike: 77_000,
  ...over,
});

export const quote = (symbol: string, bid: number, ask: number, over: Partial<Quote> = {}): Quote => ({
  symbol, bid, ask, bidSize: 5_000, askSize: 5_000, mark: (bid + ask) / 2, ts: T0, ...over,
});

export function planFor(product: ProductSpec, over: Partial<TradePlan> = {}): TradePlan {
  return {
    tradeId: `t-${product.optionSide}-1`,
    symbol: product.symbol,
    optionSide: product.optionSide,
    lots: 100,
    leverage: 10,
    entry: { type: 'limit', limitPrice: 100.5, timeoutMs: 5_000, marketFallback: false },
    takeProfitPrice: 90,
    stopPrice: 110,
    expect: {
      underlying: product.underlying,
      optionSide: product.optionSide,
      strike: product.strike,
      expiryTs: product.expiryTs,
    },
    ...over,
  };
}

export type Rig = {
  ex: PaperExchange;
  store: MemoryTradeStore;
  engine: TradeEngine;
  /** Move the clock forward, in milliseconds. */
  advance(ms: number): void;
  now(): number;
  setFeed(healthy: boolean): void;
  setDayPnl(usd: number): void;
  setSpot(usd: number | null): void;
  alarms: { tradeId: string; message: string }[];
};

export function rig(opts: {
  products?: ProductSpec[];
  quotes?: Quote[];
  balanceUsd?: number;
  limits?: Partial<RiskLimits>;
  tradingEnabled?: boolean;
  spot?: number | null;
} = {}): Rig {
  const ex = new PaperExchange({ balanceUsd: opts.balanceUsd ?? 100_000 });
  for (const p of opts.products ?? [ceProduct()]) ex.addProduct(p);
  for (const q of opts.quotes ?? [quote('C-BTC-80000-080926', 100.5, 101)]) ex.setQuote(q);

  let clock = T0;
  let feed = true;
  let pnl = 0;
  let spot: number | null = opts.spot === undefined ? SPOT : opts.spot;
  const alarms: Rig['alarms'] = [];
  const store = new MemoryTradeStore();

  const engine = new TradeEngine({
    exchange: ex,
    store,
    now: () => clock,
    limits: { ...DEFAULT_LIMITS, ...opts.limits },
    tradingEnabled: opts.tradingEnabled !== false,
    feedHealthy: () => feed,
    dayPnlUsd: () => pnl,
    spot: () => spot,
    onAlarm: (t, message) => alarms.push({ tradeId: t.tradeId, message }),
  });

  return {
    ex, store, engine, alarms,
    advance: (ms) => { clock += ms; },
    now: () => clock,
    setFeed: (h) => { feed = h; },
    setDayPnl: (usd) => { pnl = usd; },
    setSpot: (usd) => { spot = usd; },
  };
}
