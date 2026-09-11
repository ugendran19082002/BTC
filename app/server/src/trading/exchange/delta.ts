import { DeltaRefused, RateLimited, RequestTimedOut, signed, UnreadableReply, type Creds } from '../../delta/signed.js';
import type {
  ExchangeOrder, ExchangePosition, OrderStatus, PlaceOrderRequest, ProductSpec, Quote,
} from '../types.js';
import { ExchangeUnavailable, OrderRejected, SubmitTimeout, type ExchangePort } from './port.js';
import { noteError } from '../../observability/errors.js';

/** A read's timeout, and how many times it is tried. See `call`. */
const READ_TIMEOUT_MS = 8_000;
const READ_ATTEMPTS = 2;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A failure that is Delta's trouble rather than Delta's answer: no reply at
 * all, a reply that could not be read, or Delta's own server failing (HTTP 500
 * and up). A 4xx is Delta saying no on purpose, and asking again gets the same.
 */
const deltaTrouble = (e: unknown): boolean =>
  e instanceof RequestTimedOut || e instanceof UnreadableReply
  || (e instanceof DeltaRefused && e.status >= 500);

/** Delta's trouble on a read is worth one more try. */
const retryableRead = deltaTrouble;

/**
 * The real account.
 *
 * The only file in the project that can move money. It implements exactly the
 * seven methods of ExchangePort, so the engine driving it is the same engine
 * the whole test matrix runs against.
 *
 * The one distinction it works hardest to preserve is between "Delta said no"
 * and "Delta said nothing". A refusal means no order exists and it is safe to
 * move on. Silence means an order may or may not exist, and the only correct
 * response is to read the account back -- never to send it again.
 */

type DeltaOrder = {
  id: number;
  client_order_id?: string | null;
  product_id: number;
  product_symbol: string;
  side: 'buy' | 'sell';
  order_type: string;
  stop_order_type?: string | null;
  size: number;
  unfilled_size?: number;
  average_fill_price?: string | null;
  limit_price?: string | null;
  stop_price?: string | null;
  state: string;
  reduce_only?: boolean;
  created_at?: string;
  updated_at?: string;
  meta_data?: { reason?: string } | null;
};

type DeltaProduct = {
  id: number;
  symbol: string;
  contract_type: string;
  strike_price?: string | null;
  settlement_time?: string | null;
  tick_size?: string | null;
  contract_unit_currency?: string | null;
  contract_value?: string | null;
  initial_margin?: string | null;
  maintenance_margin?: string | null;
  taker_commission_rate?: string | null;
  maker_commission_rate?: string | null;
  underlying_asset?: { symbol?: string } | null;
  state?: string;
  trading_status?: string;
};

type DeltaTicker = {
  symbol: string;
  mark_price?: string | null;
  quotes?: {
    best_bid?: string | null; best_ask?: string | null;
    bid_size?: string | null; ask_size?: string | null;
  } | null;
};

type DeltaPosition = {
  product_id: number;
  product_symbol: string;
  size: number;
  entry_price?: string | null;
  unrealized_pnl?: string | null;
  mark_price?: string | null;
  liquidation_price?: string | null;
};

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Delta's order states, mapped onto the four things the engine cares about. */
function statusOf(o: DeltaOrder): OrderStatus {
  const unfilled = o.unfilled_size ?? o.size;
  switch (o.state) {
    case 'open':
    case 'pending':
      return unfilled < o.size ? 'partial' : 'open';
    case 'closed':
      return unfilled === 0 ? 'filled' : 'cancelled';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

function toOrder(o: DeltaOrder): ExchangeOrder {
  const unfilled = o.unfilled_size ?? 0;
  return {
    orderId: String(o.id),
    clientOrderId: o.client_order_id ?? null,
    symbol: o.product_symbol,
    productId: o.product_id,
    side: o.side,
    type: o.stop_order_type === 'take_profit_order' ? 'take_profit_market'
      : o.stop_order_type ? 'stop_market'
      : o.order_type === 'market_order' ? 'market' : 'limit',
    size: o.size,
    filledSize: o.size - unfilled,
    averageFillPrice: num(o.average_fill_price ?? null),
    limitPrice: num(o.limit_price ?? null),
    stopPrice: num(o.stop_price ?? null),
    status: statusOf(o),
    reduceOnly: o.reduce_only ?? false,
    createdAt: Date.parse(o.created_at ?? '') || Date.now(),
    updatedAt: Date.parse(o.updated_at ?? '') || Date.now(),
    reason: o.meta_data?.reason,
  };
}

/**
 * A refusal to a read is an empty answer; an outage is not, and still throws.
 *
 * Only a deliberate refusal reaches here as DeltaRefused: call() turns Delta's
 * own 5xx into ExchangeUnavailable. Before it did, the internal_server_error on
 * /v2/orders/history at 21:35 on 10 September was swallowed here as "no such
 * order" -- the one wrong answer an order lookup must never give.
 */
const swallowRefusal = (e: unknown): DeltaOrder[] => {
  if (e instanceof DeltaRefused) return [];
  throw e;
};

/**
 * The exact JSON Delta is sent for an order.
 *
 * Pulled out of the request so it can be checked against the documented shape
 * without a network, because the first live order came back `bad_schema` three
 * times and there was nothing to inspect.
 *
 * It follows Delta's own documented example field for field, and deliberately
 * sends `product_id` alone: the docs call `product_symbol` "an alternative to
 * product_id", which reads as a one-of, and sending both is exactly the kind of
 * thing a schema rejects.
 */
export function orderBody(req: PlaceOrderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    product_id: req.productId,
    size: req.size,
    side: req.side,
    order_type: req.type === 'limit' ? 'limit_order' : 'market_order',
    time_in_force: 'gtc',
    // A boolean, not the string "true". The string is what an older reading of
    // the docs suggests, and it is what bad_schema comes back for.
    reduce_only: req.reduceOnly === true,
    client_order_id: req.clientOrderId,
  };

  // Prices go as strings so full precision survives the wire.
  if (req.type === 'limit' && req.limitPrice !== undefined) {
    body.limit_price = String(req.limitPrice);
  }
  if (req.type === 'stop_market' && req.stopPrice !== undefined) {
    body.order_type = 'market_order';
    body.stop_order_type = 'stop_loss_order';
    body.stop_price = String(req.stopPrice);
    // Options are thin, so the last trade can be minutes old and the spot is a
    // different instrument's price. The mark is what Delta itself values the
    // position at, so it is what the stop should watch.
    body.stop_trigger_method = 'mark_price';
  }
  return body;
}

const OPTION_SIDE = (contractType: string) =>
  contractType.startsWith('call') ? ('CE' as const) : ('PE' as const);

export class DeltaExchange implements ExchangePort {
  private products = new Map<string, ProductSpec>();

  constructor(private readonly creds: Creds | null) {}

  private async call<T>(reqIn: Parameters<typeof signed>[1]): Promise<T> {
    /*
     * A read that fails for Delta's reasons is safe to ask again: it changes
     * nothing. So a GET gets a shorter timeout and one quiet retry, for no
     * answer at all and for Delta's own server errors alike. Both kinds reached
     * the live log on 10 September as single, self-healing reads: two timeouts
     * (/v2/orders, /v2/positions/margined) and an internal_server_error on
     * /v2/orders/history that the next poll a second later did not see. Two
     * tries at 8s still answer sooner than one at the old 20s.
     *
     * Writes are never retried here. Silence on a write means "unknown", and
     * the only correct response is to read the account back, never to resend.
     */
    const isRead = reqIn.method === 'GET';
    const req = isRead && reqIn.timeoutMs === undefined ? { ...reqIn, timeoutMs: READ_TIMEOUT_MS } : reqIn;
    for (let attempt = 1; ; attempt++) {
      try {
        return await signed<T>(this.creds, req);
      } catch (e) {
        if (isRead && attempt < READ_ATTEMPTS && retryableRead(e)) {
          await pause(300);
          continue;
        }
        noteError({
          source: 'exchange',
          // A read that failed on Delta's side twice is still Delta's trouble,
          // and the poll asks again within a second: worth seeing, not an alarm.
          level: isRead && retryableRead(e) ? 'warn' : 'error',
          message: (e as Error).message,
          code: e instanceof DeltaRefused ? e.code : (e as Error).name,
          stack: (e as Error).stack ?? null,
          where: `${req.method} ${req.path}`,
          // the body can carry a size and a price, both of which help; the
          // signing headers never reach here, and redact() catches the rest
          context: { body: req.body ?? null, attempts: attempt },
        });
        // Being asked to wait is not an outage, but for anything that takes risk
        // it has to behave like one: hold off rather than push through.
        if (e instanceof RateLimited) throw new ExchangeUnavailable(e.message);
        // Delta's trouble is an outage, never an answer. A 5xx left as a refusal
        // read as "no such order" to a lookup and "already gone" to a cancel --
        // both of them wrong, and both of them the dangerous way.
        if (deltaTrouble(e)) throw new ExchangeUnavailable((e as Error).message);
        throw e;
      }
    }
  }

  async placeOrder(req: PlaceOrderRequest): Promise<ExchangeOrder> {
    const body = orderBody(req);

    try {
      const o = await signed<DeltaOrder>(this.creds, { method: 'POST', path: '/v2/orders', body, timeoutMs: 10_000 });
      return toOrder(o);
    } catch (e) {
      noteError({
        source: 'exchange',
        message: `order refused: ${(e as Error).message}`,
        code: e instanceof DeltaRefused ? e.code : (e as Error).name,
        stack: (e as Error).stack ?? null,
        where: 'POST /v2/orders',
        // The whole body, so a schema refusal can be read against what was sent.
        // It carries no credential: the signing headers never reach here.
        context: { sent: body, detail: e instanceof DeltaRefused ? e.detail : null },
      });
      // The distinction the rest of the engine is built on.
      if (e instanceof RateLimited) throw new ExchangeUnavailable(e.message);
      // No answer, an unreadable one, or Delta's server failing mid-request: the
      // order may exist. Only a deliberate refusal means it certainly does not.
      if (deltaTrouble(e)) throw new SubmitTimeout(req.clientOrderId);
      if (e instanceof DeltaRefused) throw new OrderRejected(e.message);
      throw e;
    }
  }

  async cancelOrder(order: { orderId: string; productId: number }): Promise<void> {
    await this.call({
      method: 'DELETE',
      path: '/v2/orders',
      body: { id: Number(order.orderId), product_id: order.productId },
    }).catch((e) => {
      // An order that is already gone is the state we wanted. Only a deliberate
      // refusal says that: Delta's own failure arrives as ExchangeUnavailable
      // from call(), and is thrown so the caller goes and checks.
      if (e instanceof DeltaRefused) return;
      throw e;
    });
  }

  /**
   * Find one order by the id we gave it.
   *
   * Two endpoints, because Delta splits them: /v2/orders only carries live
   * orders and only accepts states of "open" and "pending", while anything
   * filled or cancelled has already moved to /v2/orders/history. Asking the
   * first for a closed order returns nothing, which would read as "the order
   * never existed" -- the single most dangerous wrong answer this method can
   * give, since it is what the engine consults after a submit times out.
   */
  /**
   * Move an order in place. `PUT /v2/orders`, which Delta documents as taking
   * the order id, the product, the size and whichever price applies.
   */
  async editOrder(
    order: { orderId: string; productId: number },
    changes: { limitPrice?: number; stopPrice?: number; size?: number },
  ): Promise<ExchangeOrder> {
    const body: Record<string, unknown> = {
      id: Number(order.orderId),
      product_id: order.productId,
    };
    if (changes.size !== undefined) body.size = changes.size;
    if (changes.limitPrice !== undefined) body.limit_price = String(changes.limitPrice);
    if (changes.stopPrice !== undefined) body.stop_price = String(changes.stopPrice);
    try {
      return toOrder(await signed<DeltaOrder>(this.creds, {
        method: 'PUT', path: '/v2/orders', body, timeoutMs: 10_000,
      }));
    } catch (e) {
      if (deltaTrouble(e)) throw new ExchangeUnavailable((e as Error).message);
      if (e instanceof DeltaRefused) throw new OrderRejected(e.message);
      throw e;
    }
  }

  async getOrderByClientId(clientOrderId: string): Promise<ExchangeOrder | null> {
    const cid = encodeURIComponent(clientOrderId);
    const live = await this.call<DeltaOrder[]>({
      method: 'GET', path: '/v2/orders', query: `?client_order_id=${cid}&states=open,pending`,
    }).catch(swallowRefusal);
    const hit = live.find((r) => r.client_order_id === clientOrderId);
    if (hit) return toOrder(hit);

    const past = await this.call<DeltaOrder[]>({
      method: 'GET', path: '/v2/orders/history', query: `?client_order_id=${cid}&page_size=20`,
    }).catch(swallowRefusal);
    const old = past.find((r) => r.client_order_id === clientOrderId);
    return old ? toOrder(old) : null;
  }

  /**
   * The orders resting for one symbol.
   *
   * **Delta ignores `product_symbol` on this endpoint when `states` is set.**
   * Asking for one contract's orders returns the whole account's, and on
   * 10 September 2026 that put a 76,800 PE's take-profit on an 80,800 CE row:
   * two positions, one order between them, and both screens reading 25.60.
   *
   * Display was the least of it. `protect()` reconciles against this list, so
   * it saw the PE's order, decided the CE was already protected and never
   * placed anything -- a live short with nothing behind it and a shield icon
   * saying otherwise. `clearProtection()` reads the same list, so closing one
   * position could have cancelled the other's target.
   *
   * The filter is kept in the query anyway -- if Delta ever honours it the
   * payload is smaller -- but the answer is filtered here regardless, because
   * a venue's filter is a request, not a guarantee.
   *
   * `PaperExchange` filters correctly, which is exactly why no test caught
   * this. See rule 2 in ARCHITECTURE.md.
   */
  async getOpenOrders(symbol?: string): Promise<ExchangeOrder[]> {
    const q = symbol ? `?states=open,pending&product_symbol=${encodeURIComponent(symbol)}` : '?states=open,pending';
    const rows = await this.call<DeltaOrder[]>({ method: 'GET', path: '/v2/orders', query: q });
    const orders = rows.map(toOrder);
    return symbol === undefined ? orders : orders.filter((o) => o.symbol === symbol);
  }

  async getPositions(): Promise<ExchangePosition[]> {
    const rows = await this.call<DeltaPosition[]>({ method: 'GET', path: '/v2/positions/margined' });
    return rows
      .filter((p) => p.size !== 0)
      .map((p) => ({
        symbol: p.product_symbol,
        productId: p.product_id,
        size: p.size,
        entryPrice: num(p.entry_price ?? null),
        // Delta's own figures. Recomputing them locally would give a second
        // answer that disagrees with the exchange screen at the worst moment.
        unrealisedPnl: num(p.unrealized_pnl ?? null),
        markPrice: num(p.mark_price ?? null),
        liquidationPrice: num(p.liquidation_price ?? null),
      }));
  }

  /**
   * Delta stores leverage per product, so it is set on the product and then the
   * order inherits it. A refusal here is worth surfacing rather than swallowing:
   * carrying on would place the order at whatever leverage was left over from
   * last time.
   */
  async setLeverage(productId: number, leverage: number): Promise<void> {
    await this.call({
      method: 'POST',
      path: `/v2/products/${productId}/orders/leverage`,
      body: { leverage: String(leverage) },
      timeoutMs: 10_000,
    });
  }

  async getBalanceUsd(): Promise<number> {
    const rows = await this.call<{ asset_symbol?: string; available_balance?: string }[]>({
      method: 'GET', path: '/v2/wallet/balances',
    });
    const usd = rows.find((b) => b.asset_symbol === 'USD' || b.asset_symbol === 'USDT');
    return num(usd?.available_balance ?? null) ?? 0;
  }

  /** Product metadata does not change during a session, so it is fetched once. */
  async getProduct(symbol: string): Promise<ProductSpec | null> {
    // No symbol is not a lookup. `/v2/products/` with nothing after it is Delta's
    // whole product list -- 3.7 MB, 1,136 products -- and the status poll asked
    // for exactly that whenever nothing was open, then cached it as a product
    // with no name. The one time the download came back unreadable, it was the
    // "refused (http_200)" row in the error log.
    if (!symbol) return null;
    const cached = this.products.get(symbol);
    if (cached) return cached;
    const p = await this.call<DeltaProduct>({
      method: 'GET', path: `/v2/products/${encodeURIComponent(symbol)}`,
    }).catch(() => null);
    // anything but one product is not this product, and must not be cached as it
    if (!p || Array.isArray(p) || typeof p.symbol !== 'string') return null;

    const spec: ProductSpec = {
      symbol: p.symbol,
      productId: p.id,
      underlying: p.underlying_asset?.symbol ?? 'BTC',
      optionSide: OPTION_SIDE(p.contract_type),
      strike: num(p.strike_price ?? null) ?? 0,
      expiryTs: Math.floor((Date.parse(p.settlement_time ?? '') || 0) / 1000),
      tickSize: num(p.tick_size ?? null) ?? 0.1,
      lotSize: 1,
      contractValue: num(p.contract_value ?? null) ?? 0.001,
      state:
        p.trading_status === 'operational' && p.state === 'live' ? 'live'
        : p.state === 'expired' ? 'expired'
        : p.state === 'live' ? 'halted'
        : 'unknown',
    };
    this.products.set(symbol, spec);
    return spec;
  }

  /** The ticker is public, but it is fetched here so the port has one home. */
  async getQuote(symbol: string): Promise<Quote | null> {
    const t = await this.call<DeltaTicker>({
      method: 'GET', path: `/v2/tickers/${encodeURIComponent(symbol)}`,
    }).catch(() => null);
    if (!t) return null;
    return {
      symbol,
      bid: num(t.quotes?.best_bid ?? null),
      ask: num(t.quotes?.best_ask ?? null),
      bidSize: num(t.quotes?.bid_size ?? null),
      askSize: num(t.quotes?.ask_size ?? null),
      mark: num(t.mark_price ?? null),
      // The REST ticker has no timestamp of its own, so the moment we received
      // it is the only honest answer. It also means the staleness gate measures
      // our own polling gap, which is the thing that actually goes wrong.
      ts: Date.now(),
    };
  }
}
