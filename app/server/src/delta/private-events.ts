/**
 * What Delta's private socket says about an account, read and checked (8 Nov 2026) -- pure, no I/O.
 *
 * The socket is a second witness to the account's orders and fills beside the REST path that trades
 * (`delta/private-shadow.ts`). A witness that miscounts is worse than none, so everything it says passes through
 * here first:
 *
 *  - **Fills** (`v2/user_trades`, Delta's faster fill channel): one per `fill_id`, however often it arrives.
 *  - **Order updates** (`orders`): an order's filled size only ever grows. An update older than one already read
 *    (Delta numbers them, `seq_no`, per symbol) is counted and dropped, never applied backwards.
 *  - **Partial fills** are partial: an order is filled when Delta says nothing is left of it (`unfilled_size` 0),
 *    never because a fill arrived.
 *  - **Sequence**: each channel numbers its messages per symbol. A number already seen is a duplicate; one that
 *    skips is a gap (messages missed); a 1 after a higher number is Delta restarting its count (its docs: "will
 *    reset to 1 after our systems restart").
 *
 * The shapes are Delta's own, from its API docs (docs/delta/document.md, "Private Channels"), and the auth and
 * subscription replies were checked against the live endpoint on 8 Nov 2026.
 */

export type WsFill = {
  fillId: string;
  orderId: string;
  clientOrderId: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  /** Contracts. */
  size: number;
  price: number;
  /** The account's position on the contract after this fill, in contracts (Delta's `po`). */
  positionAfter: number | null;
  /** `normal`, `adl` or `liquidation`. */
  reason: string | null;
  role: string | null;
  /** When Delta made the fill, epoch ms. */
  exchAt: number;
  seq: number | null;
};

/**
 * What the socket heard that the desk may want to look at at once (11 Nov 2026, `DELTA_PRIVATE_WS=wake`): a fill, or an
 * order Delta has cancelled. Only what names the order -- whose it is, and what follows, is for the listener to decide.
 */
export type SocketOrderEvent = {
  kind: 'fill' | 'cancelled';
  symbol: string;
  /** Delta's own id for the order. */
  orderId: string;
  /** The id the desk gave the order -- what says which trade it is. Null for an order placed outside the desk. */
  clientOrderId: string | null;
  /** When this process heard it, epoch ms. */
  heardAt: number;
};

export type WsOrderState = 'open' | 'pending' | 'closed' | 'cancelled';

export type WsOrder = {
  orderId: string;
  clientOrderId: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  action: 'create' | 'update' | 'delete';
  /** Why it changed: `fill`, `stop_trigger`, `stop_update`, `stop_cancel`, `liquidation`, `self_trade`, or null. */
  reason: string | null;
  size: number;
  unfilled: number;
  /** `size - unfilled`: contracts done so far. */
  filled: number;
  averageFillPrice: number | null;
  state: WsOrderState;
  stopOrderType: string | null;
  cancellationReason: string | null;
  exchAt: number;
  seq: number | null;
};

const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const side = (v: unknown): 'buy' | 'sell' | null => (v === 'buy' || v === 'sell' ? v : null);
/** Delta's timestamps are microseconds. */
const msOfMicros = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? Math.floor(n / 1_000) : null;
};

/** One `v2/user_trades` message, or null when it is not one, or lacks what a fill needs. */
export function fillOf(m: Record<string, unknown>): WsFill | null {
  if (m.type !== 'v2/user_trades') return null;
  const fillId = str(m.f), orderId = str(m.o), symbol = str(m.sy), s = side(m.S);
  const size = num(m.s), price = num(m.p), exchAt = msOfMicros(m.t);
  if (!fillId || !orderId || !symbol || !s || size === null || size <= 0 || price === null || exchAt === null) return null;
  return {
    fillId, orderId, clientOrderId: str(m.c), symbol, side: s, size, price,
    positionAfter: num(m.po), reason: str(m.R), role: str(m.r), exchAt, seq: num(m.se),
  };
}

const ORDER_STATES: readonly string[] = ['open', 'pending', 'closed', 'cancelled'];
const ORDER_ACTIONS: readonly string[] = ['create', 'update', 'delete'];

/** One incremental `orders` message, or null -- a snapshot (`action: snapshot`) is not an update. */
export function orderOf(m: Record<string, unknown>): WsOrder | null {
  if (m.type !== 'orders' || typeof m.action !== 'string' || !ORDER_ACTIONS.includes(m.action)) return null;
  const orderId = str(m.order_id), symbol = str(m.symbol), s = side(m.side);
  const size = num(m.size), unfilled = num(m.unfilled_size), exchAt = msOfMicros(m.timestamp);
  const state = typeof m.state === 'string' && ORDER_STATES.includes(m.state) ? (m.state as WsOrderState) : null;
  if (!orderId || !symbol || !s || size === null || unfilled === null || unfilled < 0 || unfilled > size || !state || exchAt === null) return null;
  return {
    orderId, clientOrderId: str(m.client_order_id), symbol, side: s,
    action: m.action as WsOrder['action'], reason: str(m.reason),
    size, unfilled, filled: size - unfilled, averageFillPrice: num(m.average_fill_price),
    state, stopOrderType: str(m.stop_order_type), cancellationReason: str(m.cancellation_reason),
    exchAt, seq: num(m.seq_no),
  };
}

export type SeqVerdict =
  | { kind: 'first' }
  | { kind: 'next' }
  | { kind: 'duplicate' }
  | { kind: 'gap'; missing: number }
  | { kind: 'reset' }
  | { kind: 'none' };

/** Sequence numbers per channel and symbol: what each new one means. */
export class SeqTracker {
  private readonly last = new Map<string, number>();

  check(key: string, seq: number | null): SeqVerdict {
    if (seq === null) return { kind: 'none' };
    const before = this.last.get(key);
    if (before === undefined) { this.last.set(key, seq); return { kind: 'first' }; }
    if (seq === before + 1) { this.last.set(key, seq); return { kind: 'next' }; }
    // Delta's count starts again at 1 after its own restart: a new count, not a duplicate.
    if (seq === 1 && before > 1) { this.last.set(key, seq); return { kind: 'reset' }; }
    if (seq <= before) return { kind: 'duplicate' };
    this.last.set(key, seq);
    return { kind: 'gap', missing: seq - before - 1 };
  }

  get size(): number { return this.last.size; }
}

/** The ids already taken, the newest `max` of them: a duplicate is recognised however late it comes, within reason. */
export class SeenIds {
  private readonly ids = new Set<string>();
  constructor(private readonly max = 20_000) {}

  /** True the first time an id is offered; false every time after. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.max) {
      const oldest = this.ids.values().next().value as string;
      this.ids.delete(oldest);
    }
    return true;
  }

  get size(): number { return this.ids.size; }
}

export type OrderStatus = 'open' | 'partial' | 'filled' | 'cancelled' | 'partial-cancelled';

export type OrderProgress = {
  orderId: string;
  symbol: string;
  size: number;
  filled: number;
  status: OrderStatus;
  lastExchAt: number;
};

/** What an order update did to what was known of the order. */
export type ProgressVerdict = 'new' | 'progress' | 'unchanged' | 'stale';

const statusOf = (o: WsOrder): OrderStatus => {
  if (o.state === 'cancelled') return o.filled > 0 ? 'partial-cancelled' : 'cancelled';
  // Filled only when Delta says nothing is left: a fill on a part of it is a partial fill.
  if (o.unfilled === 0 && o.filled > 0) return 'filled';
  return o.filled > 0 ? 'partial' : 'open';
};
const FINAL: readonly OrderStatus[] = ['filled', 'cancelled', 'partial-cancelled'];

/**
 * Each order as the socket has told it, moving forward only: an update that would un-fill contracts, or reopen an
 * order already finished, is stale -- it arrived late -- and is dropped.
 */
export class OrderProgressBook {
  private readonly orders = new Map<string, OrderProgress>();
  constructor(private readonly max = 5_000) {}

  apply(o: WsOrder): ProgressVerdict {
    const was = this.orders.get(o.orderId);
    const next: OrderProgress = { orderId: o.orderId, symbol: o.symbol, size: o.size, filled: o.filled, status: statusOf(o), lastExchAt: o.exchAt };
    if (!was) {
      this.orders.set(o.orderId, next);
      if (this.orders.size > this.max) this.orders.delete(this.orders.keys().next().value as string);
      return 'new';
    }
    if (o.filled < was.filled) return 'stale';
    if (FINAL.includes(was.status) && !FINAL.includes(next.status)) return 'stale';
    // An edit may change the size (a chase, a resize); the filled size never goes back.
    if (o.filled === was.filled && next.status === was.status && o.size === was.size) {
      was.lastExchAt = Math.max(was.lastExchAt, o.exchAt);
      return 'unchanged';
    }
    this.orders.set(o.orderId, next);
    return 'progress';
  }

  get(orderId: string): OrderProgress | null { return this.orders.get(orderId) ?? null; }
  get size(): number { return this.orders.size; }
}
