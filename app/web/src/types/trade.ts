/** Mirrors app/server/src/trading/types.ts. Kept flat and readable on purpose. */

export type OptionSide = 'CE' | 'PE';
export type OrderSide = 'buy' | 'sell';

export type TradePhase =
  | 'precheck'
  | 'entry_pending'
  | 'entry_unknown'
  | 'position_open'
  | 'unprotected'
  | 'protected'
  | 'exit_pending'
  | 'flat'
  | 'aborted';

export type Fill = {
  orderId: string;
  role: string;
  side: OrderSide;
  size: number;
  price: number;
  ts: number;
};

export type Trade = {
  tradeId: string;
  symbol: string;
  productId: number;
  optionSide: OptionSide;
  phase: TradePhase;
  /** Signed contracts. Short is negative. */
  position: number;
  requestedSize: number;
  entrySize: number;
  entryAvgPrice: number | null;
  exitSize: number;
  exitAvgPrice: number | null;
  protection: { takeProfit: string | null; stopLoss: string | null };
  realisedPnl: number;
  fills: Fill[];
  note: string | null;
  /** Set when contracts are live with no stop behind them. */
  alarm: string | null;
  updatedAt: number;
  plan?: {
    lots: number;
    entry: { type: 'limit' | 'market'; limitPrice?: number; timeoutMs: number; marketFallback: boolean };
    takeProfitPrice: number | null;
    stopPrice: number | null;
    leverage?: number;
  };
  /** The exchange's own figures, not a second opinion computed here. */
  live?: {
    markPrice: number | null;
    unrealisedPnl: number | null;
    /** Share of the credit already decayed away. 0.35 means a third is banked. */
    decayed: number | null;
    liquidationPrice: number | null;
    /** What Delta reports. Kept for comparison; not what the screen shows. */
    exchangePnl?: number | null;
    /** What closing everything now would leave, after every charge in and out. */
    netIfClosedUsd?: number | null;
  };
  /** Delta's fee + 18% GST, per fill, by the statement's own formula. */
  charges?: { entryUsd: number; exitUsd: number; paidUsd: number; toCloseUsd: number };
  /** Booked P&L after the charges paid so far. */
  netRealisedUsd?: number;
  /**
   * The protective orders actually resting on the exchange.
   *
   * Not the plan. The plan is what was asked for; this is what will fill.
   */
  onBook?: { target: number | null; stop: number | null };
};

export type Quote = {
  symbol: string;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  mark: number | null;
  ts: number;
};

export type ProductSpec = {
  symbol: string;
  productId: number;
  underlying: string;
  optionSide: OptionSide;
  strike: number;
  expiryTs: number;
  tickSize: number;
  lotSize: number;
  contractValue: number;
  state: 'live' | 'expired' | 'halted' | 'unknown';
};

export type PrecheckFailure = { code: string; message: string };

export type ExchangePosition = {
  symbol: string;
  productId: number;
  size: number;
  entryPrice: number | null;
  unrealisedPnl: number | null;
  markPrice?: number | null;
  liquidationPrice?: number | null;
};

export type TradeStatus = {
  mode: 'live' | 'paper';
  live: boolean;
  /** Whether the switch can be thrown at all from this server. */
  canGoLive: boolean;
  /** Why it cannot be thrown right now, if it cannot. */
  switchBlockedBy: string | null;
  balanceUsd: number | null;
  /** Every open position added up. */
  unrealisedPnlUsd?: number;
  /** Booked since 05:30 IST, in USD. */
  realisedTodayUsd?: number;
  /** The day so far, since 05:30 IST: booked, still open, Delta's charges, and the net of all three. */
  today?: { realisedUsd: number; unrealisedUsd: number; chargesUsd: number; netUsd: number };
  positions: ExchangePosition[];
  open: Trade[];
  alarms: { tradeId: string; message: string; at: number }[];
  limits: {
    maxLeverage: number;
    maxQuoteAgeMs: number;
    maxSpreadPct: number;
    minBookCoverage: number;
    maxShortContracts: number;
    maxDailyLossUsd: number;
    minPremiumUsd: number;
    allowPyramiding: boolean;
  };
};

export type OrderDraft = {
  symbol: string;
  side: OptionSide;
  strike: number;
  expiryTs: number;
  lots: number;
  /** 1 to 200. Sets the margin, and how close the close-out sits. */
  leverage: number;
  /** null means take the book at market. */
  limitPrice: number | null;
  /** 0 to 0.99. Zero means no target. */
  takeProfitPct?: number;
  /** 0 upwards. Zero means no stop. */
  stopLossPct?: number;
  /**
   * Seconds to wait for a resting order before crossing the spread.
   * Zero means wait for as long as it takes.
   */
  convertToMarketAfterSec?: number;
};

export type Preview = {
  mode: 'live' | 'paper';
  ok: boolean;
  failures: PrecheckFailure[];
  quote: Quote | null;
  product: ProductSpec | null;
  size: number;
  /** BTC per contract. A quoted price times this is the money. */
  contractValue: number;
  creditUsd: number;
  worstCaseLossUsd: number | null;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  /** What you keep if the target fills. */
  targetProfitUsd: number | null;
  leverage: number;
  spot: number | null;
  /** Margin the exchange will hold for the whole position, in USD. */
  marginUsd: number | null;
  /** Where the exchange closes the position out. Above where you sold. */
  liquidationPrice: number | null;
  /** Lots the balance could carry at this leverage. */
  maxLots: number | null;
};

export type PlaceResult =
  | { mode: 'live' | 'paper'; ok: true; trade: Trade }
  | { mode: 'live' | 'paper'; ok: false; failures: PrecheckFailure[]; trade: Trade };

export type OrderStatus = 'completed' | 'pending' | 'rejected' | 'cancelled';

/** A trade as it appears in the order book, looking backwards. */
export type OrderRecord = Trade & {
  status: OrderStatus;
  /** One line saying what happened. */
  outcome: string;
  openedAt: number;
};

export type OrderHistory = {
  from: string;
  to: string;
  counts: Partial<Record<OrderStatus, number>>;
  trades: OrderRecord[];
};
