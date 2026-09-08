import type {
  ExchangeOrder, ExchangePosition, PlaceOrderRequest, ProductSpec, Quote,
} from '../types.js';

/**
 * Everything the engine is allowed to do to an exchange.
 *
 * Keeping it this narrow is the point: the engine is written once against this
 * interface, and the same code drives the paper simulator in the tests and the
 * real Delta account in production. If a behaviour cannot be reached through
 * these seven methods, it cannot happen to real money either.
 */
export interface ExchangePort {
  /** May reject, may fill immediately, may time out. All three are normal. */
  placeOrder(req: PlaceOrderRequest): Promise<ExchangeOrder>;
  /**
   * Delta wants the product alongside the order id, so the whole order is
   * passed rather than just its id -- looking the product up from a cache was
   * a bug waiting to happen, and was one.
   */
  cancelOrder(order: Pick<ExchangeOrder, 'orderId' | 'productId'>): Promise<void>;
  /** `null` when the exchange has never heard of it -- which, after a timeout,
   * is the answer that says the order never landed. */
  getOrderByClientId(clientOrderId: string): Promise<ExchangeOrder | null>;
  getOpenOrders(symbol?: string): Promise<ExchangeOrder[]>;
  getPositions(): Promise<ExchangePosition[]>;
  getBalanceUsd(): Promise<number>;
  getProduct(symbol: string): Promise<ProductSpec | null>;
  /**
   * Leverage is a property of the product on Delta, not of the order, so it is
   * set before the order is sent and it stays set. Getting this wrong is not a
   * rejection -- it is a fill at a margin you did not choose.
   */
  setLeverage(productId: number, leverage: number): Promise<void>;
  getQuote(symbol: string): Promise<Quote | null>;
}

/** Thrown when a request left but no answer came back. Never means "failed". */
export class SubmitTimeout extends Error {
  constructor(readonly clientOrderId: string) {
    super(`No answer for ${clientOrderId} — the order may or may not exist.`);
    this.name = 'SubmitTimeout';
  }
}

/** Thrown when the exchange answered and said no. Safe to treat as "no order". */
export class OrderRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'OrderRejected';
  }
}

/** Thrown when the venue is unreachable. No new risk may be taken. */
export class ExchangeUnavailable extends Error {
  constructor(message = 'Exchange is unreachable.') {
    super(message);
    this.name = 'ExchangeUnavailable';
  }
}
