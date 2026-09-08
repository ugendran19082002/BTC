import type {
  ExchangeOrder, ExchangePosition, OrderStatus, PlaceOrderRequest, ProductSpec, Quote,
} from '../types.js';
import { ExchangeUnavailable, OrderRejected, SubmitTimeout, type ExchangePort } from './port.js';

/**
 * An exchange you can lie to.
 *
 * This is the simulator the whole test matrix runs against, and it is also the
 * paper-trading mode the desk ships with switched on. It fills against a quote
 * you set, and every awkward thing a real venue does -- a partial fill, a
 * rejection, a request that never comes back, a position that moved while you
 * were not looking -- is something a test can ask for by name.
 */

export type PaperFault =
  /** The request leaves and no answer arrives. The order may still exist. */
  | { kind: 'submit_timeout'; landed: boolean }
  | { kind: 'reject'; reason: string }
  | { kind: 'unavailable' };

export type PaperConfig = {
  /** Contracts that fill on a marketable limit before the rest rests. */
  partialFillSize?: number;
  /** Price levels a market order eats through, in order. */
  slippageLadder?: { price: number; size: number }[];
  /** Applied to the next placeOrder only, then cleared. */
  nextFault?: PaperFault;
};

let seq = 0;
const nextId = () => `paper-${++seq}`;

export class PaperExchange implements ExchangePort {
  private orders = new Map<string, ExchangeOrder>();
  private byClientId = new Map<string, string>();
  private positions = new Map<string, ExchangePosition>();
  private quotes = new Map<string, Quote>();
  private products = new Map<string, ProductSpec>();
  private balance: number;
  /** What leverage each product is set to. Tests read this back. */
  readonly leverage = new Map<number, number>();
  private cfg: PaperConfig = {};
  /** Set false to make every call throw, as an outage does. */
  reachable = true;

  constructor(opts: { balanceUsd?: number } = {}) {
    this.balance = opts.balanceUsd ?? 10_000;
  }

  // ---------------------------------------------------------------- setup
  addProduct(p: ProductSpec) { this.products.set(p.symbol, p); return this; }
  setQuote(q: Quote) { this.quotes.set(q.symbol, q); return this; }
  setBalance(usd: number) { this.balance = usd; return this; }
  configure(cfg: PaperConfig) { this.cfg = { ...this.cfg, ...cfg }; return this; }
  /** Move a position behind the engine's back, as a manual trade would. */
  forcePosition(symbol: string, size: number, entryPrice: number | null = null) {
    const p = this.products.get(symbol);
    if (size === 0) this.positions.delete(symbol);
    else this.positions.set(symbol, { symbol, productId: p?.productId ?? 0, size, entryPrice, unrealisedPnl: null });
    return this;
  }

  private guard() { if (!this.reachable) throw new ExchangeUnavailable(); }

  // ---------------------------------------------------------------- port
  async placeOrder(req: PlaceOrderRequest): Promise<ExchangeOrder> {
    this.guard();
    const fault = this.cfg.nextFault;
    if (fault) {
      this.cfg.nextFault = undefined;
      if (fault.kind === 'unavailable') throw new ExchangeUnavailable();
      if (fault.kind === 'reject') throw new OrderRejected(fault.reason);
      if (fault.kind === 'submit_timeout') {
        // The order either landed or it did not. The caller cannot tell, and
        // that is the whole point of the case.
        if (fault.landed) this.accept(req);
        throw new SubmitTimeout(req.clientOrderId);
      }
    }

    // Idempotency: the same client id never creates a second order.
    const existing = this.byClientId.get(req.clientOrderId);
    if (existing) return this.orders.get(existing)!;

    if (req.reduceOnly) {
      const held = this.positions.get(req.symbol)?.size ?? 0;
      const reduces = (held < 0 && req.side === 'buy') || (held > 0 && req.side === 'sell');
      if (!reduces || Math.abs(req.size) > Math.abs(held)) {
        throw new OrderRejected('reduce_only order would not reduce the position');
      }
    }

    return this.accept(req);
  }

  private accept(req: PlaceOrderRequest): ExchangeOrder {
    const now = Date.now();
    const order: ExchangeOrder = {
      orderId: nextId(),
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      productId: req.productId,
      side: req.side,
      type: req.type,
      size: req.size,
      filledSize: 0,
      averageFillPrice: null,
      limitPrice: req.limitPrice ?? null,
      stopPrice: req.stopPrice ?? null,
      status: 'open',
      reduceOnly: req.reduceOnly ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.orders.set(order.orderId, order);
    this.byClientId.set(req.clientOrderId, order.orderId);
    if (req.type === 'market') this.fillMarket(order);
    else this.matchLimit(order);
    return order;
  }

  /**
   * How much of this order the venue will actually let through right now.
   *
   * A reduce-only order is re-checked at *fill* time, not only when it is
   * placed. This is the rule that stops a target and a stop both printing on
   * the same tick and leaving a short position long -- the second one has
   * nothing left to reduce, so it fills nothing and is killed.
   */
  private reduceCap(o: ExchangeOrder, want: number): number {
    if (!o.reduceOnly) return want;
    const held = this.positions.get(o.symbol)?.size ?? 0;
    const opposes = (held < 0 && o.side === 'buy') || (held > 0 && o.side === 'sell');
    return Math.min(want, opposes ? Math.abs(held) : 0);
  }

  /** Eats the slippage ladder when one is set; otherwise takes the touch. */
  private fillMarket(o: ExchangeOrder) {
    const q = this.quotes.get(o.symbol);
    const ladder = this.cfg.slippageLadder;
    if (this.reduceCap(o, o.size - o.filledSize) === 0 && o.reduceOnly) {
      this.settle(o, 'cancelled', 'reduce-only order has nothing left to reduce');
      return;
    }
    if (ladder && ladder.length) {
      let left = this.reduceCap(o, o.size - o.filledSize);
      for (const level of ladder) {
        if (left <= 0) break;
        const take = Math.min(left, level.size);
        this.applyFill(o, take, level.price);
        left -= take;
      }
    } else {
      const px = o.side === 'sell' ? q?.bid : q?.ask;
      if (px == null) { this.settle(o, 'rejected', 'no quote to trade against'); return; }
      this.applyFill(o, this.reduceCap(o, o.size - o.filledSize), px);
    }
    this.settle(o, o.filledSize >= o.size ? 'filled' : 'partial');
  }

  /** A limit fills only if the market is already at or through it. */
  private matchLimit(o: ExchangeOrder) {
    const q = this.quotes.get(o.symbol);
    if (!q || o.limitPrice == null) return;
    const marketable = o.side === 'sell'
      ? q.bid !== null && q.bid >= o.limitPrice
      : q.ask !== null && q.ask <= o.limitPrice;
    if (!marketable) return;

    const want = this.reduceCap(o, o.size - o.filledSize);
    if (want === 0 && o.reduceOnly) {
      this.settle(o, 'cancelled', 'reduce-only order has nothing left to reduce');
      return;
    }
    const cap = this.cfg.partialFillSize;
    const take = cap !== undefined ? Math.min(want, Math.max(0, cap - o.filledSize)) : want;
    if (take <= 0) return;
    this.applyFill(o, take, o.limitPrice);
    this.settle(o, o.filledSize >= o.size ? 'filled' : 'partial');
  }

  private applyFill(o: ExchangeOrder, size: number, price: number) {
    if (size <= 0) return;
    const notional = (o.averageFillPrice ?? 0) * o.filledSize + price * size;
    o.filledSize += size;
    o.averageFillPrice = notional / o.filledSize;
    o.updatedAt = Date.now();

    const held = this.positions.get(o.symbol);
    const delta = o.side === 'sell' ? -size : size;
    const next = (held?.size ?? 0) + delta;
    const p = this.products.get(o.symbol);
    if (next === 0) this.positions.delete(o.symbol);
    else {
      this.positions.set(o.symbol, {
        symbol: o.symbol,
        productId: p?.productId ?? 0,
        size: next,
        entryPrice: held?.entryPrice ?? price,
        unrealisedPnl: null,
      });
    }
  }

  private settle(o: ExchangeOrder, status: OrderStatus, reason?: string) {
    o.status = status;
    if (reason) o.reason = reason;
    o.updatedAt = Date.now();
  }

  /** Re-price the book, then fill anything that has become marketable. */
  tick(q: Quote) {
    this.quotes.set(q.symbol, q);
    for (const o of this.orders.values()) {
      if (o.symbol !== q.symbol) continue;
      if (o.status !== 'open' && o.status !== 'partial') continue;
      if (o.type === 'limit') this.matchLimit(o);
      if (o.type === 'stop_market' && o.stopPrice !== null) {
        const last = q.mark ?? q.ask ?? q.bid;
        const triggered = o.side === 'buy' ? last !== null && last >= o.stopPrice
                                           : last !== null && last <= o.stopPrice;
        if (triggered) this.fillMarket(o);
      }
    }
    return this;
  }

  async cancelOrder({ orderId }: { orderId: string }): Promise<void> {
    this.guard();
    const o = this.orders.get(orderId);
    if (!o) return;
    if (o.status === 'filled' || o.status === 'cancelled') return;
    // Cancelling a partially filled order leaves the filled part alone.
    this.settle(o, 'cancelled');
  }

  async getOrderByClientId(clientOrderId: string): Promise<ExchangeOrder | null> {
    this.guard();
    const id = this.byClientId.get(clientOrderId);
    return id ? { ...this.orders.get(id)! } : null;
  }

  async getOpenOrders(symbol?: string): Promise<ExchangeOrder[]> {
    this.guard();
    return [...this.orders.values()]
      .filter((o) => (o.status === 'open' || o.status === 'partial') && (!symbol || o.symbol === symbol))
      .map((o) => ({ ...o }));
  }

  async getPositions(): Promise<ExchangePosition[]> {
    this.guard();
    return [...this.positions.values()].map((p) => ({ ...p }));
  }

  async setLeverage(productId: number, leverage: number): Promise<void> {
    this.guard();
    this.leverage.set(productId, leverage);
  }

  async getBalanceUsd(): Promise<number> { this.guard(); return this.balance; }
  async getProduct(symbol: string): Promise<ProductSpec | null> {
    this.guard();
    return this.products.get(symbol) ?? null;
  }
  async getQuote(symbol: string): Promise<Quote | null> {
    this.guard();
    return this.quotes.get(symbol) ?? null;
  }
}
