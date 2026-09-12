import type { FastifyInstance } from 'fastify';
import { stopPriceFor, targetPriceFor, tradingService } from '../../trading/service.js';
import { lotsToContracts } from '../../trading/money.js';
import { DEFAULT_LIMITS, precheck } from '../../trading/precheck.js';
import {
  clampLeverage, fundsRequiredPerContract, liquidationPrice, maxLotsAt, premiumUsd, unrealisedPnlUsd,
} from '../../trading/margin.js';
import { crossesSpread, worstCaseLoss, type TradeRecord } from '../../trading/engine.js';
import { fillChargesUsd, tradeCharges } from '../../trading/charges.js';
import type { ExchangeOrder, ExchangePosition, Quote } from '../../trading/types.js';
import { midOf } from '../../trading/money.js';
import {
  ORDER_STATUSES, istDayEnd, istDayStart, istToday, orderOutcomeOf, orderStatusOf,
} from '../../trading/status.js';
import { refuse } from '../refuse.js';

/** 05:30 IST is when the daily contract opens, so that is where the day starts. */
function startOfDayIst(now = Date.now()): number {
  const IST = 5.5 * 3600_000;
  return Math.floor((now + IST) / 86_400_000) * 86_400_000 - IST;
}

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

const view = (
  r: TradeRecord,
  positions: ExchangePosition[] = [],
  contractValue = 0.001,
  /** The book for this symbol, when the position row does not carry a price. */
  quote: Quote | null = null,
  spot: number | null = null,
  /**
   * What is actually resting for this symbol, which the plan may not match.
   *
   * `null` means the book could not be read. That is not the same fact as an
   * empty book, and reporting it as "no stop" would raise an alarm about a
   * dropped request. See `onBook`.
   */
  resting: ExchangeOrder[] | null = null,
) => {
  // The exchange's mark is the authority on the *price*. The money is worked
  // out here, because Delta's own unrealized_pnl came back positive on a
  // position that was down, and a figure nobody can check is worse than one
  // anybody can.
  const live = positions.find((p) => p.symbol === r.state.symbol) ?? null;
  const entry = r.state.entryAvgPrice;
  /**
   * The exchange's mark if the position row carries one, otherwise the book's.
   *
   * Delta's margined-positions rows do not always include a mark, and when they
   * did not every live figure on the card read as a dash -- no price, no
   * profit, no decay -- which looks like the desk is broken rather than like
   * one field being absent. The quote is already fetched and cached for the
   * ticket, so there is a second source to hand.
   */
  const mark = live?.markPrice ?? quote?.mark ?? midOf(quote?.bid ?? null, quote?.ask ?? null);
  const pnl = unrealisedPnlUsd({
    entryPrice: entry,
    markPrice: mark,
    size: live?.size ?? r.state.position,
    contractValue,
  });
  // Delta's charges on every fill so far, and what closing the rest at the mark
  // would add. Same formula as the statement; see trading/charges.ts.
  const charges = tradeCharges(r.state, { spot });
  const toCloseUsd = mark !== null && r.state.position !== 0
    ? fillChargesUsd({ price: mark, contracts: r.state.position, contractValue, spot }).totalUsd
    : 0;
  return {
    ...r.state,
    charges: { entryUsd: charges.entryUsd, exitUsd: charges.exitUsd, paidUsd: charges.totalUsd, toCloseUsd },
    /** Booked P&L after every charge paid so far. For a closed trade, what it really made. */
    netRealisedUsd: r.state.realisedPnl - charges.totalUsd,
    plan: {
      lots: r.plan.lots,
      entry: r.plan.entry,
      takeProfitPrice: r.plan.takeProfitPrice,
      stopPrice: r.plan.stopPrice,
      leverage: r.plan.leverage,
    },
    live: {
      markPrice: mark,
      unrealisedPnl: pnl,
      /**
       * As a share of the credit taken in: 0.35 means a third of it is banked.
       * The same subtraction as the P&L, so the two can never disagree about
       * which way the trade is going -- which is how this bug was spotted.
       */
      decayed: entry !== null && entry > 0 && mark !== null ? (entry - mark) / entry : null,
      /**
       * Delta's close-out price when it gives one, otherwise this desk's own
       * estimate. The estimate is the same model the ticket showed before the
       * trade, so the number does not vanish the moment the position exists.
       */
      liquidationPrice:
        live?.liquidationPrice
        ?? (spot !== null && entry !== null
          ? liquidationPrice({
              spot, premium: entry, leverage: r.plan.leverage, contractValue,
            })
          : null),
      /** What Delta says, kept for comparison. Not what the screen shows. */
      exchangePnl: live?.unrealisedPnl ?? null,
      /** What closing everything now would leave you with, after every charge in and out. */
      netIfClosedUsd: pnl === null ? null : r.state.realisedPnl + pnl - charges.totalUsd - toCloseUsd,
    },
    /**
     * The protective orders that are actually resting, read off the exchange.
     *
     * Not the plan. The plan is what was asked for and the book is what will
     * fill, and a screen that says "on the book now" while reading the plan is
     * simply wrong when the two differ -- which is exactly the case worth
     * showing.
     */
    onBook: resting === null ? null : {
      // The target rests as a limit and carries its level in limitPrice; the
      // stop is a trigger and carries its level in stopPrice.
      target: resting.find((o) => o.reduceOnly && o.type === 'limit')?.limitPrice ?? null,
      // Either shape is the stop: a stop limit is what the desk places since
      // 12 September, a stop market is what it placed before. Matching only the
      // old shape would report "no stop" over a stop that is right there.
      stop: resting.find((o) => o.reduceOnly && (o.type === 'stop_limit' || o.type === 'stop_market'))?.stopPrice ?? null,
    },
  };
};

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
      svc.positionsForDisplay().catch(() => []),
    ]);
    const trades = svc.openTrades();
    // Both cached at the server for under a second, so this costs nothing per poll.
    const symbols = [...new Set(trades.map((t) => t.state.symbol))];
    // Each trade carries its own contract value, so there is no product to look
    // up. There used to be -- the first open trade's, or with nothing open, the
    // product called '' -- which downloaded Delta's entire product list.
    const [quotes, books] = await Promise.all([
      Promise.all(symbols.map(async (s) => [s, await svc.quoteForDisplay(s).catch(() => null)] as const)),
      // null, not [], when the book cannot be read: "Delta says there is no
      // stop" and "Delta did not answer" must not arrive as the same fact.
      Promise.all(symbols.map(async (s) => [s, await svc.openOrdersForDisplay(s).catch(() => null)] as const)),
    ]);
    const bySymbol = new Map(quotes);
    const restingBy = new Map(books);
    const open = trades.map((r) =>
      view(
        r, positions, r.state.contractValue,
        bySymbol.get(r.state.symbol) ?? null, svc.spot,
        restingBy.get(r.state.symbol) ?? null,
      ));
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
      open,
      /** Every open position added up, so the tab can say it in one number. */
      unrealisedPnlUsd: open.reduce((n, t) => n + (t.live.unrealisedPnl ?? 0), 0),
      alarms: svc.alarms,
      /** Booked today, in USD. The daily-loss gate reads this; now so can you. */
      realisedTodayUsd: svc.store.realisedSince(startOfDayIst()),
      /**
       * The day so far, in one place, for the header: booked, still open, and
       * Delta's charges on every fill since 05:30 IST. `netUsd` is the number
       * that matters -- what the day has actually made if it closed right now.
       */
      today: (() => {
        const dayStart = startOfDayIst();
        const realisedUsd = svc.store.realisedSince(dayStart);
        const unrealisedUsd = open.reduce((n, t) => n + (t.live.unrealisedPnl ?? 0), 0);
        const chargesUsd = svc.store.between(dayStart, Date.now() + 1)
          .reduce((n, rec) => n + tradeCharges(rec.state, { spot: svc.spot, since: dayStart }).totalUsd, 0);
        return { realisedUsd, unrealisedUsd, chargesUsd, netUsd: realisedUsd + unrealisedUsd - chargesUsd };
      })(),
      // The limit in force, which is set from the balance rather than fixed.
      limits: {
        ...DEFAULT_LIMITS,
        maxDailyLossUsd: svc.dailyLossLimitUsd,
        maxShortContracts: svc.maxShortContracts,
      },
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
    // Refusing to flip with a position open is the guard doing its job, not a
    // fault: it is answered plainly and stays out of the error log.
    return res.ok ? res : refuse(reply, 409, res);
  });

  app.get('/api/trade/quote', async (req, reply) => {
    const symbol = String((req.query as { symbol?: string }).symbol ?? '');
    if (!symbol) { reply.code(400); return { error: 'symbol is required' }; }
    const [quote, product] = await Promise.all([
      svc.quoteForDisplay(symbol).catch(() => null),
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
        // The limit in force, which is set from the balance rather than fixed.
      limits: {
        ...DEFAULT_LIMITS,
        maxDailyLossUsd: svc.dailyLossLimitUsd,
        maxShortContracts: svc.maxShortContracts,
      },
      });

      return {
        mode: svc.mode,
        ok: gates.ok,
        failures: gates.ok ? [] : gates.failures,
        quote, product,
        size,
        contractValue: product?.contractValue ?? 0.001,
        creditUsd: credit,
        /** Delta's fee + 18% GST to open this, by the statement's own formula. Closing costs about the same again. */
        entryChargesUsd: price !== null
          ? fillChargesUsd({ price, contracts: size, contractValue: product?.contractValue ?? 0.001, spot }).totalUsd
          : null,
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
        /*
         * The largest size that would actually be allowed through -- margin
         * *and* the short cap, not margin alone.
         *
         * The ticket's "max" button and the "N lots at 200x" line both read
         * this. Sized on margin only, it offered 775 lots while 90 was all the
         * cap had room for, so `max` filled the box with a number MAX_POSITION
         * was certain to refuse. A screen that suggests a size the server will
         * turn down is the screen disagreeing with the book again.
         */
        maxLots: margin
          ? Math.max(0, Math.min(
              maxLotsAt(balance, margin, product?.lotSize ?? 1),
              Math.floor((svc.maxShortContracts - totalShort) / (product?.lotSize ?? 1)),
            ))
          : null,
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
        chaseSeconds: p.convertToMarketAfterSec,
      });
      if (!res.ok) {
        // A gate turned the order down. That is the desk working as designed --
        // the screen shows the reason, and the error log never hears about it.
        return refuse(reply, 422, {
          mode: svc.mode,
          ok: false,
          failures: res.precheck.ok ? [] : res.precheck.failures,
          trade: res.state,
        });
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

  /** Move the stop or the target on a position that is already open. */
  app.post('/api/trade/protection', async (req, reply) => {
    const b = (req.body ?? {}) as { tradeId?: string; takeProfitPct?: number; stopLossPct?: number };
    if (!b.tradeId) { reply.code(400); return { error: 'tradeId is required' }; }
    const state = await svc.updateExits(b.tradeId, {
      takeProfitPct: b.takeProfitPct === undefined ? undefined : pct(b.takeProfitPct, 0.99),
      stopLossPct: b.stopLossPct === undefined ? undefined : pct(b.stopLossPct, 20),
    });
    if (!state) { reply.code(404); return { error: 'no such trade' }; }
    return { ok: true, trade: state };
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

  /**
   * The order book, looking backwards.
   *
   * `from` and `to` are IST calendar dates and both default to today, which is
   * the window somebody opening this screen almost always wants. `status`
   * filters to one of the four; absent means all of them.
   */
  app.get('/api/trade/history', async (req) => {
    const q = req.query as { from?: string; to?: string; status?: string; limit?: string };
    const from = istDayStart(q.from ?? istToday()) ?? istDayStart(istToday())!;
    const to = istDayEnd(q.to ?? q.from ?? istToday()) ?? istDayEnd(istToday())!;
    const wanted = ORDER_STATUSES.find((x) => x === q.status) ?? null;
    const limit = Math.min(1_000, Number(q.limit ?? 500));

    const records = svc.store.between(Math.min(from, to), Math.max(from + 86_400_000, to), limit);

    /*
     * Prices for the trades still open, so their row can say what closing now
     * would leave -- the same figure the Positions card shows.
     *
     * Without them an open row had nothing to show but the charges paid to get
     * in, which came out as "booked P&L" of minus the charges: a red −₹16.41 on
     * a position that was in profit. Only the open symbols are asked about, and
     * both reads are the cached ones the status poll already makes, so a month
     * of closed trades costs nothing extra.
     */
    const openSymbols = [...new Set(records.filter((r) => r.state.position !== 0).map((r) => r.state.symbol))];
    const [positions, quotes] = openSymbols.length === 0
      ? [[] as ExchangePosition[], [] as (readonly [string, Quote | null])[]]
      : await Promise.all([
          svc.positionsForDisplay().catch((): ExchangePosition[] => []),
          Promise.all(openSymbols.map(async (s) => [s, await svc.quoteForDisplay(s).catch(() => null)] as const)),
        ]);
    const quoteFor = new Map(quotes);

    const rows = records
      .map((r) => ({
        ...(r.state.position !== 0
          ? view(r, positions, r.state.contractValue, quoteFor.get(r.state.symbol) ?? null, svc.spot)
          : view(r, [], r.state.contractValue, null, svc.spot)),
        status: orderStatusOf(r.state, r.events),
        outcome: orderOutcomeOf(r.state, r.events),
        openedAt: r.events[0]?.at ?? r.state.updatedAt,
      }))
      .filter((r) => !wanted || r.status === wanted);

    return {
      from: q.from ?? istToday(),
      to: q.to ?? q.from ?? istToday(),
      counts: rows.reduce<Record<string, number>>(
        (acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
        {},
      ),
      trades: rows,
    };
  });

  app.get('/api/trade/:tradeId', async (req, reply) => {
    const { tradeId } = req.params as { tradeId: string };
    const rec = svc.store.get(tradeId);
    if (!rec) { reply.code(404); return { error: 'no such trade' }; }
    return { trade: view(rec), events: rec.events };
  });
}
