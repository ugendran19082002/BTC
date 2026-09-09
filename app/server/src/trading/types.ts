/**
 * The vocabulary of a live trade.
 *
 * Everything here is data. No function in this file talks to an exchange, so a
 * test can build any situation -- a partial fill, a gap through the stop, a
 * restart with an open position -- without a network.
 */

export type OptionSide = 'CE' | 'PE';
export type OrderSide = 'buy' | 'sell';
/**
 * `stop_market` and `take_profit_market` are both triggered orders: they sit
 * dormant until the mark reaches a level, then buy at the market.
 *
 * A target used to be a plain resting `limit` buy, and that is a different
 * thing entirely. A limit buy at 1.10 fills only when somebody *offers* at or
 * below 1.10 -- so on a book of 0.50 bid / 1.50 offered it sits there while the
 * mark falls straight through 1.10 and keeps going. Which is exactly what
 * happened: a position marked at 1.00 against a target of 1.10, still open.
 */
export type OrderType = 'limit' | 'market' | 'stop_market' | 'take_profit_market';
/*
 * Nothing places a `take_profit_market` any more -- Delta fired them the moment
 * they landed, which cost real money, so the target rests as a plain limit and
 * the level is watched by the engine instead. The type stays because orders
 * placed before that are still readable: a leg this desk cannot recognise on
 * the way back is a leg the reconciler cannot cancel.
 */

/** What the exchange says about one order. Local belief never overrides this. */
export type OrderStatus =
  | 'pending'      // we have sent it and have not heard back
  | 'open'         // resting on the book
  | 'partial'      // some size done, some resting
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'unknown';     // the request timed out; we do not know if it exists

export type OrderRole = 'entry' | 'take_profit' | 'stop_loss' | 'exit';

export type PlaceOrderRequest = {
  /** Ours, not the exchange's. The same id is never sent twice with a different
   * intent, which is what makes a retry safe after a network timeout. */
  clientOrderId: string;
  symbol: string;
  productId: number;
  side: OrderSide;
  type: OrderType;
  /** Contracts, not lots. Whole numbers only. */
  size: number;
  /** Required for `limit`; ignored otherwise. Already rounded to the tick. */
  limitPrice?: number;
  /** Required for `stop_market`. */
  stopPrice?: number;
  /** An exit must never be able to open a position on the other side. */
  reduceOnly?: boolean;
  role: OrderRole;
};

export type ExchangeOrder = {
  orderId: string;
  clientOrderId: string | null;
  symbol: string;
  /** Needed to cancel it: Delta wants the product alongside the order id. */
  productId: number;
  side: OrderSide;
  type: OrderType;
  size: number;
  /** Contracts done so far. */
  filledSize: number;
  /** Size-weighted average of the actual fills, not the price we asked for. */
  averageFillPrice: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  status: OrderStatus;
  reduceOnly: boolean;
  createdAt: number;
  updatedAt: number;
  /** Present when the exchange refused it. */
  reason?: string;
};

export type ExchangePosition = {
  symbol: string;
  productId: number;
  /** Negative is short. Zero means flat; the row may not exist at all. */
  size: number;
  entryPrice: number | null;
  /** The exchange's own mark-to-market. Its number, not a second opinion. */
  unrealisedPnl: number | null;
  /** What the option is worth right now, by the exchange's mark. */
  markPrice: number | null;
  /** Where the exchange would close the position out. */
  liquidationPrice: number | null;
};

export type ProductSpec = {
  symbol: string;
  productId: number;
  underlying: string;      // 'BTC'
  optionSide: OptionSide;
  strike: number;
  /** Epoch seconds. */
  expiryTs: number;
  /** Smallest price increment the exchange will accept. */
  tickSize: number;
  /** Contracts per lot. */
  lotSize: number;
  /** BTC per contract, for margin and P&L. */
  contractValue: number;
  state: 'live' | 'expired' | 'halted' | 'unknown';
};

export type Quote = {
  symbol: string;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  mark: number | null;
  /** When this quote was produced, epoch ms. Staleness is measured from here. */
  ts: number;
};

/** A single fill, kept individually so an average is computed and never assumed. */
export type Fill = {
  orderId: string;
  role: OrderRole;
  side: OrderSide;
  size: number;
  price: number;
  ts: number;
};

/**
 * Where a trade is in its life.
 *
 * `unprotected` is not a normal step. It means contracts are at risk with no
 * stop behind them, and it is the one phase that should wake somebody up.
 */
export type TradePhase =
  | 'precheck'
  | 'entry_pending'
  | 'entry_unknown'     // submit timed out; reconcile before doing anything else
  | 'position_open'     // filled, protection not on yet
  | 'unprotected'       // filled, protection FAILED -- alarm
  | 'protected'
  | 'exit_pending'
  | 'flat'
  | 'aborted';          // never held a position

export type ProtectionOrders = {
  takeProfit: string | null;   // clientOrderId
  stopLoss: string | null;
};

export type TradeState = {
  tradeId: string;
  symbol: string;
  productId: number;
  optionSide: OptionSide;
  /**
   * BTC per contract, carried on the trade.
   *
   * The machine needs it to turn a price difference into money, and it has to
   * be the value from the day the trade was opened rather than whatever the
   * product says now -- a journal that reprices history is not a journal.
   */
  contractValue: number;
  phase: TradePhase;
  /** Signed contracts we believe we hold. Short is negative. */
  position: number;
  /** What we asked for at entry, in contracts. */
  requestedSize: number;
  entrySize: number;
  entryAvgPrice: number | null;
  exitSize: number;
  exitAvgPrice: number | null;
  entryOrderId: string | null;
  protection: ProtectionOrders;
  /**
   * Whether this trade asked for a **stop**.
   *
   * Specifically a stop, not protection in general. A target that fails to go
   * on is a nuisance; a stop that fails to go on is contracts at risk with
   * nothing behind them, and only the second is an alarm. Conflating them
   * reported "POSITION UNPROTECTED" for a trade that had deliberately chosen to
   * run without a stop, which is how a real alarm gets ignored.
   */
  wantsProtection: boolean;
  /** Set once an exit is winning, so the loser can be cancelled exactly once. */
  exitWinner: OrderRole | 'manual' | null;
  realisedPnl: number;
  fills: Fill[];
  /** Why we stopped, or what is wrong. Shown to a human. */
  note: string | null;
  /** Raised when a position is live with no protection behind it. */
  alarm: string | null;
  updatedAt: number;
};

export type TradeEvent =
  | { t: 'precheck_failed'; reason: string; at: number }
  | { t: 'entry_submitted'; clientOrderId: string; size: number; at: number }
  | { t: 'entry_submit_unknown'; at: number }
  | { t: 'entry_rejected'; reason: string; at: number }
  | { t: 'fill'; role: OrderRole; side: OrderSide; size: number; price: number; orderId: string; at: number }
  | { t: 'entry_timeout'; at: number }
  | { t: 'entry_cancelled'; remaining: number; at: number }
  | { t: 'protection_placed'; takeProfit: string | null; stopLoss: string | null; at: number }
  | { t: 'protection_failed'; reason: string; at: number }
  | { t: 'exit_submitted'; role: OrderRole | 'manual'; clientOrderId: string; at: number }
  | { t: 'sibling_cancelled'; role: OrderRole; at: number }
  /** The exchange's own answer. It always wins over what we thought. */
  | { t: 'reconciled'; position: number; at: number; note?: string }
  | { t: 'aborted'; reason: string; at: number };
