import { DeltaRefused, RateLimited, RequestTimedOut, signed, signedPage, UnreadableReply, type Creds } from '../../delta/signed.js';
import { stopFillLimit } from '../money.js';
import type {
  ExchangeOrder, ExchangePosition, OrderStatus, PlaceOrderRequest, ProductSpec, Quote,
} from '../types.js';
import { ExchangeUnavailable, OrderGone, OrderRejected, SubmitTimeout, VenueRestricted, type ExchangePort } from './port.js';
import type { ExchangeFill } from './port.js';
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

/*
 * Delta taking no new orders, market-wide (18 Oct 2026, 1:30-1:37 AM IST): "market_disrupted_cancel_only_mode" --
 * cancels go through, nothing new does. The desk re-placed 49 trades' targets at the 1:30 step into it: each edit
 * was refused, so each fell back to cancel-and-replace, the cancel was taken, the new order was not -- the desk took
 * its own resting targets off the book -- and 388 refusals and 49 "POSITION UNPROTECTED" followed, one a second.
 *
 * So the state is the venue's, held for all the desk's accounts: noted at the first refusal that says so, said once
 * in the log, and held RESTRICTED_HOLD_MS past the last such refusal. While it holds, nothing that opens risk is sent
 * (an entry, a leverage change) and the engine leaves resting protection where it is (`restriction`). A close is
 * still sent every time it is due: the moment Delta takes orders again, it is the one that must go.
 */
const RESTRICTED_HOLD_MS = 30_000;
let restricted: { code: string; since: number; until: number } | null = null;
const isRestriction = (e: unknown): e is DeltaRefused => e instanceof DeltaRefused && e.code.startsWith('market_disrupted');
const modeWords = (code: string) => (code === 'market_disrupted_cancel_only_mode' ? 'cancel-only mode (market disrupted)' : code.replace(/_/g, ' '));
function noteRestricted(code: string, now = Date.now()): void {
  const fresh = restricted === null || now >= restricted.until;
  restricted = { code, since: fresh ? now : restricted!.since, until: now + RESTRICTED_HOLD_MS };
  if (fresh) {
    noteError({
      source: 'exchange', level: 'error', where: 'venue', code,
      message: `Delta is in ${modeWords(code)}: no new entry or order change is sent until it clears; resting orders are left as they are, and closes still go.`,
    });
  }
}
function clearRestricted(now = Date.now()): void {
  if (restricted === null) return;
  const was = restricted;
  restricted = null;
  noteError({ source: 'exchange', level: 'warn', where: 'venue', code: was.code, message: `Delta is taking orders again after ${modeWords(was.code)}.`, context: { seconds: Math.round((now - was.since) / 1_000) } });
}
/** Delta's restriction now, if any: the reason in words, and until when the desk holds off. */
export function venueRestriction(now = Date.now()): { reason: string; until: number } | null {
  return restricted !== null && now < restricted.until ? { reason: `Delta is in ${modeWords(restricted.code)}`, until: restricted.until } : null;
}

/*
 * Delta not answering at all (18 Oct 2026, 1:02-1:21 AM IST: HTTP 502 to everything). A read is asked again once,
 * and the next poll asks again within a second -- right for a blip, and 3,400 failed reads in nineteen minutes for an
 * outage, every one a line in the log. After READ_OUTAGE_AFTER reads in a row have failed on Delta's side, reads are
 * held back -- answered at once as the outage they are -- for a while that doubles to READ_HOLD_MAX_MS, said once in
 * the log; the first read after the hold asks Delta again. Writes are never held: a close must still be tried.
 */
const READ_OUTAGE_AFTER = 3;
const READ_HOLD_MS = 2_000;
const READ_HOLD_MAX_MS = 30_000;
let readOutage = { failed: 0, until: 0, since: 0 };
function readFailed(now = Date.now()): void {
  readOutage.failed++;
  if (readOutage.failed === READ_OUTAGE_AFTER) {
    readOutage.since = now;
    noteError({ source: 'exchange', level: 'warn', where: 'venue', code: 'reads_held', message: 'Delta is not answering: its reads are held back a few seconds at a time until it does.' });
  }
  if (readOutage.failed >= READ_OUTAGE_AFTER) readOutage.until = now + Math.min(READ_HOLD_MAX_MS, READ_HOLD_MS * 2 ** (readOutage.failed - READ_OUTAGE_AFTER));
}
function readAnswered(now = Date.now()): void {
  if (readOutage.failed >= READ_OUTAGE_AFTER) {
    noteError({ source: 'exchange', level: 'warn', where: 'venue', code: 'reads_held', message: 'Delta is answering again.', context: { seconds: Math.round((now - readOutage.since) / 1_000) } });
  }
  readOutage = { failed: 0, until: 0, since: 0 };
}
/** For a test: the venue's states forgotten. */
export function resetVenueState(): void { restricted = null; readOutage = { failed: 0, until: 0, since: 0 }; }

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
  /** Why Delta cancelled it, when it did: "Null unless state is cancelled" (its API reference). */
  cancellation_reason?: string | null;
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
      : o.stop_order_type ? (o.order_type === 'limit_order' ? 'stop_limit' : 'stop_market')
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
    // Delta's own reason for a cancel it made, where it gives one -- read before its older place in the meta data.
    reason: o.cancellation_reason ?? o.meta_data?.reason,
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
/*
 * A refused read is not an empty one.
 *
 * This used to turn any 4xx on a lookup into `[]`, and `[]` into "no such
 * order". On 14 Sep 2026 at 08:15 IST an add of 100 contracts was acknowledged
 * by Delta, the next lookup was refused, the desk wrote "the order never
 * reached the exchange" and stopped tracking it -- while it filled. The person
 * added again; Delta held 200 more than the desk did, 100 of them with no
 * target behind them. A lookup that fails is unknown, and unknown means look
 * again, never "gone". So it throws, and the engine's callers -- which already
 * treat a throw as "could not ask" -- ask again next poll.
 */
const refusedRead = (e: unknown): never => {
  if (e instanceof DeltaRefused) throw new ExchangeUnavailable(`lookup refused: ${e.message}`);
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
  if ((req.type === 'stop_market' || req.type === 'stop_limit') && req.stopPrice !== undefined) {
    body.stop_order_type = 'stop_loss_order';
    body.stop_price = String(req.stopPrice);
    // Options are thin, so the last trade can be minutes old and the spot is a
    // different instrument's price. The mark is what Delta itself values the
    // position at, so it is what the stop should watch.
    body.stop_trigger_method = 'mark_price';
    if (req.type === 'stop_limit' && req.limitPrice !== undefined) {
      // A limit, priced through the trigger. Delta validates a market order for
      // price impact when it is placed and refuses it as `unsupported` when the
      // option has no orderbook -- which is when a stop is needed most.
      body.order_type = 'limit_order';
      body.limit_price = String(req.limitPrice);
    } else {
      body.order_type = 'market_order';
    }
  }
  return body;
}

const OPTION_SIDE = (contractType: string) =>
  contractType.startsWith('call') ? ('CE' as const) : ('PE' as const);

/** The edit refusals that mean the order left the book, from Delta's own table. */
const GONE_CODES = new Set(['open_order_not_found', 'order_already_filled']);

/** How long a client id that the contract's history did not hold is left before that search is made again. */
const DEEP_RETRY_MS = 30_000;

/** Open orders are read a hundred to a page, and this many pages at most: past that the book is not known whole. */
export const OPEN_ORDER_PAGE = 100;
export const OPEN_ORDER_PAGES = 10;

/**
 * A refusal that is an expected query or cancellation result rather than a fault.
 *
 * Looking up an order that does not exist returns `order_not_found` or 404:
 * that is a lookup miss, not an outage or bug. Cancelling an order that is
 * already filled or cancelled returns `open_order_not_found` or `order_already_filled`:
 * that is the desired state achieved. Neither belongs in the error log.
 * See docs/decisions/0005-error-log-only-what-needs-fixing.md.
 */
function isExpectedRefusal(
  req: { method: string; path: string },
  e: DeltaRefused,
  custom?: (e: DeltaRefused) => boolean,
): boolean {
  if (custom?.(e)) return true;
  if (
    req.method === 'GET'
    && req.path.startsWith('/v2/orders')
    && (e.code === 'order_not_found' || e.code === 'not_found' || e.status === 404)
  ) {
    return true;
  }
  if (
    req.method === 'DELETE'
    && req.path === '/v2/orders'
    && (GONE_CODES.has(e.code) || e.code === 'order_not_found' || e.status === 404)
  ) {
    return true;
  }
  return false;
}

export class DeltaExchange implements ExchangePort {
  private products = new Map<string, ProductSpec>();

  constructor(private readonly creds: Creds | null) {}

  private call<T>(reqIn: Parameters<typeof signed>[1] & { quietRefusal?: (e: DeltaRefused) => boolean }): Promise<T> {
    return this.attempt(reqIn, (req) => signed<T>(this.creds, req));
  }

  /** One page of a list, and the cursor to the next (null on the last). Asked and retried exactly as `call`. */
  private page<T>(reqIn: Parameters<typeof signed>[1]): Promise<{ result: T[]; after: string | null }> {
    return this.attempt(reqIn, (req) => signedPage<T[]>(this.creds, req));
  }

  private async attempt<R>(
    reqIn: Parameters<typeof signed>[1] & { quietRefusal?: (e: DeltaRefused) => boolean },
    send: (req: Parameters<typeof signed>[1]) => Promise<R>,
  ): Promise<R> {
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
    // Delta not answering: a read is answered as the outage it is, without asking (see `readFailed`).
    if (isRead && Date.now() < readOutage.until) throw new ExchangeUnavailable('Delta is not answering; reads are held back for a few seconds.');
    // Delta taking nothing new: a leverage change, which comes before an entry, is not sent.
    const restriction = req.method === 'POST' && req.path.endsWith('/orders/leverage') ? venueRestriction() : null;
    if (restriction) throw new VenueRestricted(`${restriction.reason}: not sent.`);
    for (let attempt = 1; ; attempt++) {
      try {
        const out = await send(req);
        if (isRead) readAnswered();
        return out;
      } catch (e) {
        if (isRead && attempt < READ_ATTEMPTS && retryableRead(e)) {
          await pause(300);
          continue;
        }
        if (isRead && retryableRead(e)) readFailed();
        if (!(e instanceof DeltaRefused && isExpectedRefusal(req, e, reqIn.quietRefusal))) {
          noteError({
            source: 'exchange',
            // A read that failed on Delta's side twice is still Delta's trouble,
            // and the poll asks again within a second: worth seeing, not an alarm.
            // A restriction is the venue's state, said once on its own line (`noteRestricted`).
            level: (isRead && retryableRead(e)) || isRestriction(e) ? 'warn' : 'error',
            message: (e as Error).message,
            code: e instanceof DeltaRefused ? e.code : (e as Error).name,
            stack: (e as Error).stack ?? null,
            where: `${req.method} ${req.path}`,
            // the body can carry a size and a price, both of which help; the
            // signing headers never reach here, and redact() catches the rest
            context: { body: req.body ?? null, attempts: attempt },
          });
        }
        // Being asked to wait is not an outage, but for anything that takes risk
        // it has to behave like one: hold off rather than push through.
        if (e instanceof RateLimited) throw new ExchangeUnavailable(e.message);
        if (isRestriction(e)) { noteRestricted(e.code); throw new VenueRestricted(e.message); }
        // Delta's trouble is an outage, never an answer. A 5xx left as a refusal
        // read as "no such order" to a lookup and "already gone" to a cancel --
        // both of them wrong, and both of them the dangerous way.
        if (deltaTrouble(e)) throw new ExchangeUnavailable((e as Error).message);
        throw e;
      }
    }
  }

  /**
   * Delta codes that mean "this market order cannot be priced right now".
   *
   * `unsupported` is Delta's own wording for a market order it could not
   * validate for price impact because the orderbook was not available;
   * `no_liquidity_for_market_order` is the same situation with a book that is
   * merely empty. Neither is a fault in the request.
   */
  private static readonly UNPRICEABLE = new Set(['unsupported', 'no_liquidity_for_market_order']);

  async placeOrder(req: PlaceOrderRequest): Promise<ExchangeOrder> {
    try {
      return await this.send(req);
    } catch (e) {
      /*
       * Getting out matters more than the price. A reduce-only market order
       * Delta cannot price is retried once as a limit through the touch: it
       * cannot open a position, the refusal proves the first one does not
       * exist, and the same client order id means a duplicate is impossible.
       */
      const code = e instanceof OrderRejected ? e.reason : '';
      const unpriceable = e instanceof OrderRejected
        && [...DeltaExchange.UNPRICEABLE].some((c) => code.includes(c));
      if (!unpriceable || req.type !== 'market' || req.reduceOnly !== true) throw e;

      const [quote, product] = await Promise.all([
        this.getQuote(req.symbol).catch(() => null),
        this.getProduct(req.symbol).catch(() => null),
      ]);
      const touch = req.side === 'buy' ? quote?.ask ?? quote?.mark : quote?.bid ?? quote?.mark;
      if (touch == null || !(touch > 0)) throw e;
      const tick = product?.tickSize ?? 0.1;
      return await this.send({ ...req, type: 'limit', limitPrice: stopFillLimit(req.side, touch, tick) });
    }
  }

  private async send(req: PlaceOrderRequest): Promise<ExchangeOrder> {
    const body = orderBody(req);
    // Delta taking nothing new: an order that would open risk is not sent. A reduce-only one -- a close, or protection
    // the engine asked for -- still is: it is the order that must go the moment Delta takes orders again.
    const restriction = req.reduceOnly ? null : venueRestriction();
    if (restriction) throw new VenueRestricted(`${restriction.reason}: the order was not sent.`);

    try {
      const o = await signed<DeltaOrder>(this.creds, { method: 'POST', path: '/v2/orders', body, timeoutMs: 10_000 });
      clearRestricted();
      return toOrder(o);
    } catch (e) {
      noteError({
        source: 'exchange',
        ...(isRestriction(e) ? { level: 'warn' as const } : {}),
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
      // A refusal of the market's, not the order's: nothing was created, and the venue's state is noted.
      if (isRestriction(e)) { noteRestricted(e.code); throw new VenueRestricted(e.message); }
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
      const edited = toOrder(await signed<DeltaOrder>(this.creds, {
        method: 'PUT', path: '/v2/orders', body, timeoutMs: 10_000,
      }));
      clearRestricted();
      return edited;
    } catch (e) {
      if (deltaTrouble(e)) throw new ExchangeUnavailable((e as Error).message);
      // Refused because Delta takes no changes just now: the order rests as it was. Said, and the state noted.
      if (isRestriction(e)) { noteRestricted(e.code); throw new VenueRestricted(e.message); }
      // Filled or cancelled since it was last read: the caller reads it again.
      // Delta's edit-order error table names both -- "couldn't be found among
      // open orders; it may already be filled or cancelled", and "has already
      // been completely filled and can no longer be edited".
      if (e instanceof DeltaRefused && GONE_CODES.has(e.code)) throw new OrderGone(order.orderId);
      if (e instanceof DeltaRefused) throw new OrderRejected(e.message);
      throw e;
    }
  }

  /**
   * By the id Delta itself assigned in the acknowledgement. `GET /v2/orders/{id}`
   * -- documented as "Get Order by id" -- answers for open and closed orders
   * alike, so an acknowledged order can always be found this way whatever the
   * client-id filters do.
   */
  async getOrderById(orderId: string): Promise<ExchangeOrder | null> {
    const row = await this.call<DeltaOrder | null>({
      method: 'GET', path: `/v2/orders/${encodeURIComponent(orderId)}`,
    }).catch((e: unknown) => {
      // Delta answers 404 or order_not_found for an id it has never issued;
      // that is the refusal that does mean "no such order".
      if (e instanceof DeltaRefused && (e.status === 404 || e.code === 'not_found' || e.code === 'order_not_found')) {
        return null;
      }
      return refusedRead(e);
    });
    return row ? toOrder(row) : null;
  }

  /**
   * The account's fills on one contract since a moment (`GET /v2/fills`, its API reference): by product, from
   * `start_time` in microseconds, a page at a time. Five pages at most -- five hundred fills on one contract is
   * further back than a reconcile needs to look.
   */
  async getFills(symbol: string, sinceMs: number): Promise<ExchangeFill[]> {
    const product = await this.getProduct(symbol).catch(() => null);
    if (!product?.productId) return [];
    type DeltaFill = { order_id: number | string; side: 'buy' | 'sell'; size: number; price: string | number; created_at: string; product_symbol?: string };
    const out: ExchangeFill[] = [];
    const start = Math.max(0, Math.floor(sinceMs)) * 1_000;
    // Newest first, a hundred at a time: a full page is followed back by its oldest moment (`end_time`).
    let end: number | null = null;
    for (let page = 0; page < 5; page++) {
      const query = `?product_ids=${product.productId}&start_time=${start}${end !== null ? `&end_time=${end}` : ''}&page_size=100`;
      const rows = await this.call<DeltaFill[]>({ method: 'GET', path: '/v2/fills', query }).catch(() => null);
      if (!rows || rows.length === 0) break;
      for (const f of rows) {
        if (f.product_symbol && f.product_symbol !== symbol) continue;
        out.push({ orderId: String(f.order_id), side: f.side, size: Number(f.size), price: Number(f.price), at: Date.parse(f.created_at) || 0 });
      }
      if (rows.length < 100) break;
      const oldest = Math.min(...rows.map((f) => Date.parse(f.created_at) || 0));
      if (!(oldest > sinceMs)) break;
      end = oldest * 1_000 - 1;
    }
    // Once each, however the pages overlapped at their edges.
    const seen = new Set<string>();
    return out.filter((f) => { const k = `${f.orderId}|${f.at}|${f.size}|${f.price}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  async getOrderHistory(symbol: string, limit = 50): Promise<ExchangeOrder[]> {
    /*
     * One contract's history. Delta documents `product_ids` for this endpoint (not `product_symbols`, which the
     * desk sent alone until 3 Oct 2026 and which may be ignored -- then the "contract's history" was the account's
     * newest orders, filtered here). Both are sent; the id when the product is known. Filtered here as well:
     * this endpoint has ignored one filter already (see getOrderByClientId), and a filter is a request.
     */
    const product = await this.getProduct(symbol).catch(() => null);
    const ids = product?.productId ? `product_ids=${product.productId}&` : '';
    const rows = await this.call<DeltaOrder[]>({
      method: 'GET', path: '/v2/orders/history',
      query: `?${ids}product_symbols=${encodeURIComponent(symbol)}&page_size=${Math.max(1, Math.min(200, limit))}`,
    }).catch(refusedRead);
    return rows.map(toOrder).filter((o) => o.symbol === symbol);
  }

  /** When each client id last missed the deep search, so a missing order cannot spend the quota every second. */
  private readonly deepMiss = new Map<string, number>();

  async getOrderByClientId(clientOrderId: string, symbol?: string): Promise<ExchangeOrder | null> {
    const cid = encodeURIComponent(clientOrderId);
    /*
     * Delta's own lookup by client id (`GET /v2/orders/client_order_id/{id}`, in its docs): one call, open or
     * filled. Its forum reports it answering "not found" for some cancelled orders, so a miss -- or any refusal --
     * falls through to the searches below rather than meaning "no such order".
     */
    const direct = await this.call<DeltaOrder>({ method: 'GET', path: `/v2/orders/client_order_id/${cid}` }).catch(() => null);
    if (direct && !Array.isArray(direct) && direct.client_order_id === clientOrderId) return toOrder(direct);

    /*
     * The open book, searched here: `client_order_id` is not a filter Delta documents for this endpoint, so the
     * answer was the account's first hundred open orders -- and an order past them read as "not open" (14 Oct
     * 2026, 77 trades open). With the contract known, its own book, whole (`getOpenOrders`).
     */
    const live = symbol
      ? await this.getOpenOrders(symbol).catch(refusedRead)
      : (await this.call<DeltaOrder[]>({
        method: 'GET', path: '/v2/orders', query: `?states=open,pending&page_size=${OPEN_ORDER_PAGE}`,
      }).catch(refusedRead)).map(toOrder);
    const hit = live.find((r) => r.clientOrderId === clientOrderId);
    if (hit) return hit;

    /*
     * Delta ignores `client_order_id` here -- asked for one order on 14 Sep
     * 2026 it returned the account's newest five, whichever id was asked for.
     * The filter stays in the query in case that changes; the answer is
     * searched regardless, and only the newest twenty can be found this way.
     * That is one reason `getOrderById` exists: a filled order leaves
     * /v2/orders at once and can take a moment to appear here, and in that
     * moment this method answers "nowhere".
     */
    const past = await this.call<DeltaOrder[]>({
      method: 'GET', path: '/v2/orders/history', query: `?client_order_id=${cid}&page_size=20`,
    }).catch(refusedRead);
    const old = past.find((r) => r.client_order_id === clientOrderId);
    if (old) return toOrder(old);

    /*
     * Not in the account's newest twenty: on a busy account a target that filled minutes ago is already past
     * them, and the desk went on reading the trade as open with its target gone -- three trades on the 88,800 CE
     * held "open" until a restart found the contract flat (2 Oct 2026). The contract's own history is searched
     * deeper, by the contract's product id (the filter Delta documents).
     */
    if (!symbol) return null;
    // Ten units of Delta's 20,000 per five minutes each time: a miss is not asked again for half a minute.
    const missed = this.deepMiss.get(clientOrderId);
    if (missed !== undefined && Date.now() - missed < DEEP_RETRY_MS) return null;
    const theirs = await this.getOrderHistory(symbol, 200).catch(() => [] as ExchangeOrder[]);
    const found = theirs.find((o) => o.clientOrderId === clientOrderId) ?? null;
    if (found) this.deepMiss.delete(clientOrderId);
    else {
      this.deepMiss.set(clientOrderId, Date.now());
      if (this.deepMiss.size > 500) this.deepMiss.clear();
    }
    return found;
  }

  /**
   * The orders resting for one symbol, or for the whole account -- every page of them.
   *
   * Read by `product_ids`, the filter Delta documents for `GET /v2/orders` (its API reference: "comma separated
   * product ids, max 10"), and followed page to page by its `after` cursor. Until 14 Oct 2026 the desk sent
   * `product_symbol`, which that endpoint does not take, and read one page of a hundred: the answer was the whole
   * account's first hundred orders. With 77 trades open (a stop and a target each) the older trades' orders were
   * past it, `protect()` read their stop as missing and placed a second one beside it -- left on the book when the
   * trade closed, triggered three hours later on a contract with no position (Delta's mail, 09:03), and over-filling
   * the contract's reduce-only room so that Delta cancelled targets (`no_position_left_for_reduce_only`).
   *
   * The answer is still filtered by symbol here: a venue's filter is a request, not a guarantee (10 Sep 2026, a PE's
   * target on a CE's row). And a book that could not be read whole is not an answer: past `OPEN_ORDER_PAGES` it
   * throws, as an outage does, and every caller already reads a throw as "could not ask".
   *
   * `PaperExchange` filters correctly, which is exactly why no test caught this. See
   * docs/decisions/0002-simulator-is-not-the-venue.md.
   */
  async getOpenOrders(symbol?: string): Promise<ExchangeOrder[]> {
    const product = symbol ? await this.getProduct(symbol).catch(() => null) : null;
    const scope = product?.productId ? `&product_ids=${product.productId}` : '';
    const rows = new Map<string, DeltaOrder>();
    let after: string | null = null;
    for (let page = 0; ; page++) {
      if (page === OPEN_ORDER_PAGES) {
        throw new ExchangeUnavailable(`more than ${OPEN_ORDER_PAGES * OPEN_ORDER_PAGE} open orders: the book was not read whole`);
      }
      const cursor = after === null ? '' : `&after=${encodeURIComponent(after)}`;
      const res: { result: DeltaOrder[]; after: string | null } = await this.page<DeltaOrder>({
        method: 'GET', path: '/v2/orders', query: `?states=open,pending&page_size=${OPEN_ORDER_PAGE}${scope}${cursor}`,
      });
      for (const r of res.result ?? []) rows.set(String(r.id), r);
      // The last page says so with a null cursor; a cursor that does not move is treated the same, not followed.
      if (res.after === null || res.after === after || (res.result ?? []).length === 0) break;
      after = res.after;
    }
    const orders = [...rows.values()].map(toOrder);
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
  restriction(): { reason: string; until: number } | null { return venueRestriction(); }

  async setLeverage(productId: number, leverage: number): Promise<void> {
    await this.call({
      method: 'POST',
      path: `/v2/products/${productId}/orders/leverage`,
      body: { leverage: String(leverage) },
      timeoutMs: 10_000,
    });
  }

  async getBalanceUsd(): Promise<number> {
    return (await this.getWalletUsd()).available;
  }

  /**
   * The USD wallet: `balance` is what Delta's app shows as the FNO wallet / account value, `available_balance`
   * what is free to trade. The margin in use is the difference -- Delta's own figure. The screen estimated it
   * from the positions until 2 Oct 2026 and said $13.36 where Delta said $8.48.
   */
  async getWalletUsd(): Promise<{ balance: number; available: number }> {
    const rows = await this.call<{ asset_symbol?: string; available_balance?: string; balance?: string }[]>({
      method: 'GET', path: '/v2/wallet/balances',
    });
    const usd = rows.find((b) => b.asset_symbol === 'USD' || b.asset_symbol === 'USDT');
    const available = num(usd?.available_balance ?? null) ?? 0;
    return { balance: num(usd?.balance ?? null) ?? available, available };
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
