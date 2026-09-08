import type { FastifyInstance } from 'fastify';
import { stopPriceFor, targetPriceFor, tradingService } from '../../trading/service.js';
import { lotsToContracts } from '../../trading/money.js';
import { DEFAULT_LIMITS, precheck } from '../../trading/precheck.js';
import { clampLeverage, fundsRequiredPerContract, liquidationPrice, maxLotsAt, premiumUsd } from '../../trading/margin.js';
import { crossesSpread, worstCaseLoss, type TradeRecord } from '../../trading/engine.js';

/**
 * The order desk.
 *
 * `preview` runs exactly the same gates as `place` and sends nothing, so the
 * screen can show a red reason before a finger goes anywhere near the button.
 * `place` is the only route in this project that can create risk, and it says
 * in every response whether it is live or on paper.
 */

type PlaceBody = {
  symbol?: string;
  side?: 'CE' | 'PE';
  strike?: number;
  expiryTs?: number;
  lots?: number;
  /** Absent means take the book. */
  limitPrice?: number | null;
  takeProfitPrice?: number | null;
  stopPrice?: number | null;
  marketFallback?: boolean;
  /** Seconds to wait for a resting order before crossing. 0 means wait forever. */
  convertToMarketAfterSec?: number;
  leverage?: number;
  /** 0 to 0.99. Zero means no target. */
  takeProfitPct?: number;
  /** 0 upwards. Zero means no stop. */
  stopLossPct?: number;
};

const pct = (v: unknown, max: number) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.min(max, n) : 0;
};

const view = (r: TradeRecord) => ({
  ...r.state,
  plan: {
    lots: r.plan.lots,
    entry: r.plan.entry,
    takeProfitPrice: r.plan.takeProfitPrice,
    stopPrice: r.plan.stopPrice,
  },
});

function parse(body: PlaceBody) {
  const symbol = String(body.symbol ?? '').trim();
  if (!symbol) throw new Error('symbol is required');
  const lots = Math.floor(Number(body.lots ?? 0));
  if (!(lots > 0)) throw new Error('lots must be a positive whole number');
  const side: 'CE' | 'PE' = body.side === 'PE' ? 'PE' : 'CE';
  return {
    symbol, lots, side,
    strike: Number(body.strike ?? 0),
    expiryTs: Number(body.expiryTs ?? 0),
    limitPrice: body.limitPrice === null || body.limitPrice === undefined ? undefined : Number(body.limitPrice),
    takeProfitPrice: body.takeProfitPrice ?? null,
    stopPrice: body.stopPrice ?? null,
    // AlgoTest calls this "Convert to Market After", and it is the same idea:
    // rest at the offer, and if nobody takes it within the wait, cross.
    convertToMarketAfterSec: Math.max(0, Math.min(600, Number(body.convertToMarketAfterSec ?? 0) || 0)),
    leverage: clampLeverage(Number(body.leverage ?? 200)),
    takeProfitPct: pct(body.takeProfitPct, 0.99),
    stopLossPct: pct(body.stopLossPct, 20),
  };
}

export function registerTradeRoutes(app: FastifyInstance) {
  const svc = tradingService();
  // Recovery runs once, at startup, before anything can be placed.
  void svc.start();

  app.get('/api/trade/status', async () => {
    const [balance, positions] = await Promise.all([
      svc.balance().catch(() => null),
      svc.positions().catch(() => []),
    ]);
    return {
      mode: svc.mode,
      /** True only when a real order would reach the real exchange. */
      live: svc.mode === 'live',
      /** Whether the switch can be thrown at all from here. */
      canGoLive: svc.canGoLive,
      /** Why it cannot be thrown right now, if it cannot. */
      switchBlockedBy: svc.openTrades().length > 0
        ? `Close ${svc.openTrades().length} open position${svc.openTrades().length === 1 ? '' : 's'} first.`
        : svc.canGoLive ? null : 'No Delta credentials configured on the server.',
      balanceUsd: balance,
      positions,
      open: svc.openTrades().map(view),
      alarms: svc.alarms,
      limits: DEFAULT_LIMITS,
    };
  });

  /**
   * Throw the switch between the real exchange and the simulator.
   *
   * Server-side, and refused while anything is open: the browser asks, the
   * server decides. A page that could put itself into live mode by setting a
   * flag in its own state is a page that can do it by accident.
   */
  app.post('/api/trade/mode', async (req, reply) => {
    const { mode } = (req.body ?? {}) as { mode?: string };
    if (mode !== 'live' && mode !== 'paper') {
      reply.code(400);
      return { error: "mode must be 'live' or 'paper'" };
    }
    const res = svc.setMode(mode);
    if (!res.ok) reply.code(409);
    return res;
  });

  app.get('/api/trade/quote', async (req, reply) => {
    const symbol = String((req.query as { symbol?: string }).symbol ?? '');
    if (!symbol) { reply.code(400); return { error: 'symbol is required' }; }
    const [quote, product] = await Promise.all([
      svc.quote(symbol).catch(() => null),
      svc.product(symbol).catch(() => null),
    ]);
    return { quote, product };
  });

  /** Every gate, no order. This is what the button is allowed to be sure of. */
  app.post('/api/trade/preview', async (req, reply) => {
    try {
      const p = parse((req.body ?? {}) as PlaceBody);
      const [product, quote, positions, balance] = await Promise.all([
        svc.product(p.symbol).catch(() => null),
        svc.quote(p.symbol).catch(() => null),
        svc.positions().catch(() => []),
        svc.balance().catch(() => 0),
      ]);
      const size = product ? lotsToContracts(p.lots, product.lotSize) : p.lots;
      const price = p.limitPrice ?? quote?.bid ?? null;
      const held = positions.find((x) => x.symbol === p.symbol)?.size ?? 0;
      const totalShort = positions.reduce((n, x) => n + (x.size < 0 ? -x.size : 0), 0);
      const stop = p.stopPrice ?? (price !== null ? stopPriceFor(price, p.stopLossPct) : null);
      const target = p.takeProfitPrice ?? (price !== null ? targetPriceFor(price, p.takeProfitPct) : null);
      const credit = premiumUsd(price ?? 0, size, product?.contractValue);
      const worstCase = worstCaseLoss({
        stopPrice: stop, price, size, credit, spot: svc.spot,
        leverage: p.leverage, contractValue: product?.contractValue,
      });

      const spot = svc.spot;
      const margin = spot !== null && price !== null
        ? { spot, premium: price, leverage: p.leverage, contractValue: product?.contractValue }
        : null;

      const gates = precheck({
        now: Date.now(),
        intent: {
          side: 'sell', size, price, reduceOnly: false,
          leverage: p.leverage, stopPrice: stop,
          crossing: crossesSpread('sell', p.limitPrice === undefined ? 'market' : 'limit', p.limitPrice ?? null, quote),
          expect: { underlying: 'BTC', optionSide: p.side, strike: p.strike, expiryTs: p.expiryTs },
        },
        spot,
        product, quote,
        feedHealthy: true,
        tradingEnabled: true,
        account: { availableUsd: balance },
        existingPosition: held,
        totalShortContracts: totalShort,
        dayPnlUsd: svc.store.realisedSince(Date.now() - 86_400_000),
        worstCaseLossUsd: worstCase,
        limits: DEFAULT_LIMITS,
      });

      return {
        mode: svc.mode,
        ok: gates.ok,
        failures: gates.ok ? [] : gates.failures,
        quote, product,
        size,
        contractValue: product?.contractValue ?? 0.001,
        creditUsd: credit,
        worstCaseLossUsd: Number.isFinite(worstCase) ? worstCase : null,
        stopPrice: stop,
        takeProfitPrice: target,
        /** What you keep if the target fills. */
        targetProfitUsd:
          target !== null && price !== null
            ? premiumUsd(price - target, size, product?.contractValue)
            : null,
        leverage: p.leverage,
        spot,
        marginUsd: margin ? fundsRequiredPerContract(margin) * size : null,
        // The price this option has to reach before the exchange closes the
        // position out. At 200x it is close; that is the whole point of showing it.
        liquidationPrice: margin ? liquidationPrice(margin) : null,
        maxLots: margin ? maxLotsAt(balance, margin, product?.lotSize ?? 1) : null,
      };
    } catch (e) {
      reply.code(400);
      return { error: (e as Error).message };
    }
  });

  app.post('/api/trade/place', async (req, reply) => {
    try {
      const p = parse((req.body ?? {}) as PlaceBody);
      const res = await svc.place({
        symbol: p.symbol,
        optionSide: p.side,
        strike: p.strike,
        expiryTs: p.expiryTs,
        lots: p.lots,
        limitPrice: p.limitPrice,
        takeProfitPct: p.takeProfitPct,
        stopLossPct: p.stopLossPct,
        marketFallback: p.convertToMarketAfterSec > 0,
        timeoutMs: p.convertToMarketAfterSec * 1_000,
      });
      if (!res.ok) {
        reply.code(422);
        return {
          mode: svc.mode,
          ok: false,
          failures: res.precheck.ok ? [] : res.precheck.failures,
          trade: res.state,
        };
      }
      return { mode: svc.mode, ok: true, trade: res.state };
    } catch (e) {
      reply.code(400);
      return { error: (e as Error).message };
    }
  });

  app.post('/api/trade/close', async (req, reply) => {
    const { tradeId } = (req.body ?? {}) as { tradeId?: string };
    if (!tradeId) { reply.code(400); return { error: 'tradeId is required' }; }
    const state = await svc.close(tradeId);
    if (!state) { reply.code(404); return { error: 'no such trade' }; }
    return { ok: true, trade: state };
  });

  /**
   * Square off everything.
   *
   * Deliberately not a DELETE on a collection: it is one irreversible action
   * with a report, not a tidy REST verb, and the report is the point.
   */
  app.post('/api/trade/close-all', async () => {
    const result = await svc.closeAll();
    return { ok: result.failed.length === 0, ...result };
  });

  /** Take a working entry off the book. Refuses once anything has filled. */
  app.post('/api/trade/cancel', async (req, reply) => {
    const { tradeId } = (req.body ?? {}) as { tradeId?: string };
    if (!tradeId) { reply.code(400); return { error: 'tradeId is required' }; }
    const state = await svc.cancel(tradeId);
    if (!state) { reply.code(404); return { error: 'no such trade' }; }
    return { ok: true, trade: state };
  });

  /** Ask the exchange and believe it, on demand. */
  app.post('/api/trade/reconcile', async (req, reply) => {
    const { tradeId } = (req.body ?? {}) as { tradeId?: string };
    if (!tradeId) { reply.code(400); return { error: 'tradeId is required' }; }
    const rec = await svc.reconcile(tradeId);
    if (!rec) { reply.code(404); return { error: 'no such trade' }; }
    return { ok: true, trade: rec.state };
  });

  app.get('/api/trade/history', async (req) => {
    const limit = Math.min(200, Number((req.query as { limit?: string }).limit ?? 50));
    return { trades: svc.list(limit).map(view) };
  });

  app.get('/api/trade/:tradeId', async (req, reply) => {
    const { tradeId } = req.params as { tradeId: string };
    const rec = svc.store.get(tradeId);
    if (!rec) { reply.code(404); return { error: 'no such trade' }; }
    return { trade: view(rec), events: rec.events };
  });
}
