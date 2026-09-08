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
  };
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
};

export type TradeStatus = {
  mode: 'live' | 'paper';
  live: boolean;
  balanceUsd: number | null;
  positions: ExchangePosition[];
  open: Trade[];
  alarms: { tradeId: string; message: string; at: number }[];
  limits: {
    maxQuoteAgeMs: number;
    maxSpreadPct: number;
    minBookCoverage: number;
    maxShortContracts: number;
    maxDailyLossUsd: number;
    minPremiumUsd: number;
    allowPyramiding: boolean;
    marginPerLotUsd: number;
  };
};

export type OrderDraft = {
  symbol: string;
  side: OptionSide;
  strike: number;
  expiryTs: number;
  lots: number;
  /** null means take the book at market. */
  limitPrice: number | null;
  takeProfitPrice?: number | null;
  stopPrice?: number | null;
  marketFallback?: boolean;
};

export type Preview = {
  mode: 'live' | 'paper';
  ok: boolean;
  failures: PrecheckFailure[];
  quote: Quote | null;
  product: ProductSpec | null;
  size: number;
  creditUsd: number;
  worstCaseLossUsd: number | null;
  stopPrice: number | null;
};

export type PlaceResult =
  | { mode: 'live' | 'paper'; ok: true; trade: Trade }
  | { mode: 'live' | 'paper'; ok: false; failures: PrecheckFailure[]; trade: Trade };
