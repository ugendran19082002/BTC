import type { FastifyInstance } from 'fastify';
import { startOfDayIst } from '../../strategy/schedule.js';
import { ExitAskError, stopFor, targetFor, tradingService, journal, setDeskMode, startTradingServices } from '../../trading/service.js';
import { lotsToContracts } from '../../trading/money.js';
import { DEFAULT_LIMITS, precheck } from '../../trading/precheck.js';
import {
  clampLeverage, fundsRequiredPerContract, liquidationPrice, maxLotsAt, premiumUsd, unrealisedPnlUsd,
} from '../../trading/margin.js';
import { crossesSpread, worstCaseLoss, type TradeRecord } from '../../trading/engine.js';
import { fillChargesUsd, tradeCharges } from '../../trading/charges.js';
import { netIfClosedAt } from '../../trading/close-preview.js';
import type { ExchangeOrder, ExchangePosition, Quote, TradeEvent } from '../../trading/types.js';
import { midOf } from '../../trading/money.js';
import {
  ORDER_STATUSES, istDayEnd, istDayStart, istToday, orderOutcomeOf, orderStatusOf,
} from '../../trading/status.js';
import { refuse } from '../refuse.js';
import { accountOf } from '../account-query.js';
import { parseAddBody, toAddRequest, type AddBody } from '../add-body.js';
import { parseCloseBody, type CloseBody } from '../close-body.js';
import { strategyStore } from './strategy.routes.js';
import { exitByOf } from '../../strategy/store.js';
import { perpAtMinutes } from '../../market/perp-minute.js';
import { telegramLog } from '../../notify/telegram-log.js';

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
  /** The target as points under the entry. Above zero, it replaces the percentage. */
  takeProfitPoints?: number;
  /** The stop as points over the entry. Above zero, it replaces the percentage. */
  stopLossPoints?: number;
};

const pct = (v: unknown, max: number) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.min(max, n) : 0;
};

/** The most a fixed exit may sit from the entry, in the option's own price: a typo guard, not a rule. */
export const MAX_EXIT_POINTS = 10_000;
/** Points from the entry. Zero, blank or nonsense is "not by points". */
const points = (v: unknown) => pct(v, MAX_EXIT_POINTS);

/** The exits a body gave as prices, in the engine's words; absent when it gave none. */
const atOf = (p: { takeProfitPrice: number | null; stopPrice: number | null }) => ({
  ...(p.takeProfitPrice !== null && p.takeProfitPrice > 0 ? { takeProfitAt: p.takeProfitPrice } : {}),
  ...(p.stopPrice !== null && p.stopPrice > 0 ? { stopAt: p.stopPrice } : {}),
});

/**
 * Every strategy's name as it is now, by id.
 *
 * A trade keeps the id of the strategy that placed it, and the id is made from
 * the name the strategy was first saved with -- so a strategy renamed from
 * "Sig BO" to "Breakout PE" went on showing "sig-bo" on its positions and its
 * orders while the list said "Breakout PE". The name is looked up here, as it
 * stands, each time a trade is shown. Empty when the strategy tables are not
 * open (a test that never started them); the screen then shows the id.
 */
export async function strategyNames(): Promise<Map<string, string>> {
  try {
    return new Map((await strategyStore().all()).map((x) => [x.id, x.name]));
  } catch {
    return new Map();
  }
}

/** A trade with its strategy's current name on the plan; a deleted strategy keeps the name it placed the trade under. */
export const withStrategyName = (r: TradeRecord, names: ReadonlyMap<string, string>): TradeRecord => {
  const now = r.plan.strategyId ? names.get(r.plan.strategyId) : undefined;
  return now === undefined || now === r.plan.strategyName ? r : { ...r, plan: { ...r.plan, strategyName: now } };
};

/**
 * A signal trade's perp entry, where it was not kept: the perp's average traded
 * price over the minute its option filled (the tape, `trade_flow_1m`), else the
 * perp's mark that minute (`index_1m`) -- marked approximate. Trades placed
 * before 2 Oct 2026 carried the perp SL and TGT but not where the perp was when
 * they went in, and the label read "perp SL · TGT" with no entry. Read-only:
 * the journal is not rewritten. Unchanged when the minute was not recorded.
 */
export async function withPerpEntries(recs: TradeRecord[]): Promise<TradeRecord[]> {
  const minuteOf = (r: TradeRecord) => {
    const ts = r.state.fills.filter((f) => f.role === 'entry').map((f) => f.ts).filter((t) => t > 0);
    return ts.length ? Math.floor(Math.min(...ts) / 60_000) * 60_000 : null;
  };
  // The perp as the option filled, where it was recorded (2 Oct 2026 on): exact, nothing to look up.
  recs = recs.map((r) => (r.plan.underlying && r.state.perpEntry != null
    ? { ...r, plan: { ...r.plan, underlying: { ...r.plan.underlying, entry: r.state.perpEntry, entryApprox: false } } }
    : r));
  const need = recs.filter((r) => r.plan.underlying && r.plan.underlying.entry == null && minuteOf(r) !== null);
  if (!need.length) return recs;
  let price: Map<number, number>;
  try {
    price = await perpAtMinutes(need.map((r) => minuteOf(r)!));
  } catch {
    return recs;                          // the minute tables missing: the label goes without, as before
  }
  return recs.map((r) => {
    if (!need.includes(r)) return r;
    const p = price.get(minuteOf(r)!);
    return p === undefined ? r : { ...r, plan: { ...r.plan, underlying: { ...r.plan.underlying!, entry: p, entryApprox: true } } };
  });
}

/** Everything the screens add to a trade on the way out: the strategy's current name, the perp entry where it was not kept. */
export async function forScreens(recs: TradeRecord[]): Promise<TradeRecord[]> {
  const names = await strategyNames();
  return withPerpEntries(recs.map((r) => withStrategyName(r, names)));
}

/**
 * This trade's own target and stop on the book: the orders whose client ids it recorded when it placed them.
 *
 * It took the first reduce-only limit and the first stop on the contract, whoever's they were. With one
 * trade a contract that was the same thing; with several on one strike (signal strategies, 2 Oct 2026) every
 * card showed the same order, and a trade placed with no stop showed another trade's at 183.40. An order with
 * no client id -- placed by hand, or before ids -- is still read as this trade's, as the engine reads it.
 */
export function ownExits(r: TradeRecord, resting: readonly ExchangeOrder[]): { target: ExchangeOrder | null; stop: ExchangeOrder | null } {
  const isStop = (o: ExchangeOrder) => o.type === 'stop_limit' || o.type === 'stop_market';
  const pick = (id: string | null, isType: (o: ExchangeOrder) => boolean) =>
    resting.find((o) => o.reduceOnly && isType(o) && id !== null && o.clientOrderId === id)
    ?? resting.find((o) => o.reduceOnly && isType(o) && !o.clientOrderId)
    ?? null;
  return { target: pick(r.state.protection.takeProfit, (o) => o.type === 'limit'), stop: pick(r.state.protection.stopLoss, isStop) };
}

export const tradeView = (
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
    // This trade's own contracts, never Delta's row for the symbol: two
    // strategies may hold one contract (decision 0011), and each card would
    // otherwise show the P&L of both.
    size: r.state.position,
    long: r.state.position > 0,
    contractValue,
  });
  // Delta's charges on every fill so far, and what closing the rest at the mark
  // would add. Same formula as the statement; see trading/charges.ts.
  const charges = tradeCharges(r.state, { spot });
  const toCloseUsd = mark !== null && r.state.position !== 0
    ? fillChargesUsd({ price: mark, contracts: r.state.position, contractValue, spot }).totalUsd
    : 0;
  /*
   * Why it was closed, in the desk's words -- from the trade's state, or for a trade closed before the state
   * kept it, from the journal's last close -- and which exit that was. A close the desk sends is a market
   * order whatever the reason, so the filling order alone said "closed manually" over a perp SL hit (2 Oct 2026).
   */
  const lastReason = r.state.exitReason
    ?? ([...(r.events ?? [])].reverse()
      .find((e): e is Extract<TradeEvent, { t: 'exit_submitted' }> => e.t === 'exit_submitted' && Boolean((e as { reason?: string }).reason))
      ?.reason)
    ?? null;
  const closed = r.state.position === 0 && r.state.exitSize > 0;
  /*
   * The last time the exchange would not take this trade's target or stop, and why -- when nothing has been
   * placed since. A trade that asked for a target and has none resting showed only "Target none"; the reason
   * (Delta's refusal) sat in the journal where no screen read it (2 Oct 2026).
   */
  let protectionProblem: string | null = null;
  for (const e of r.events ?? []) {
    if (e.t === 'protection_failed') protectionProblem = e.reason;
    else if (e.t === 'protection_placed') protectionProblem = null;
  }
  return {
    ...r.state,
    protectionProblem,
    exitReason: lastReason,
    exitBy: closed ? exitByOf(lastReason, r.state.exitWinner ?? null) : null,
    charges: { entryUsd: charges.entryUsd, exitUsd: charges.exitUsd, paidUsd: charges.totalUsd, toCloseUsd },
    /** Booked P&L after every charge paid so far. For a closed trade, what it really made. */
    netRealisedUsd: r.state.realisedPnl - charges.totalUsd,
    plan: {
      lots: r.plan.lots,
      /*
       * Who asked for this trade: the ticket, a saved strategy, or the
       * best-pick card's auto-trade. Read from the plan where it was written;
       * anything opened before the field existed and without a strategy is what
       * it always was, a trade somebody placed by hand.
       */
      origin: r.plan.origin ?? (r.plan.strategyId ? 'strategy' : 'manual'),
      // Sold or bought to open, for the label on Positions and Orders; a trade from before the label was sold.
      action: r.plan.action ?? 'sell',
      strategyId: r.plan.strategyId ?? null,
      /** The strategy's name -- its current one when the route looked it up (`withStrategyName`). */
      strategyName: r.plan.strategyName ?? null,
      /** A signal strategy's trade: the signal, and its SL and TGT on the BTC perp. */
      signal: r.plan.signal ?? null,
      underlying: r.plan.underlying ?? null,
      entry: r.plan.entry,
      takeProfitPrice: r.plan.takeProfitPrice,
      stopPrice: r.plan.stopPrice,
      /*
       * Why there is no stop, where a fixed one was overtaken by the fill
       * itself. The screen has to be able to say this: an unprotected position
       * that looks protected is the worst thing the desk can show.
       */
      exitProblem: r.plan.exitProblem ?? null,
      /*
       * How each exit was asked for, so a screen that edits it opens in the
       * same terms: a leg here follows the fill as a % or points; a leg absent
       * is a fixed price. Without it the Edit exits sheet showed a strategy's
       * "stop at 70" as "+250%", and saving it unchanged would have turned a
       * fixed level into one that moves with the fill (22 Sep 2026).
       */
      exitAsk: r.plan.exitAsk ?? null,
      leverage: r.plan.leverage,
    },
    live: {
      markPrice: mark,
      /*
       * The book, both sides.
       *
       * The card showed the mark and called it "price now", which is the one
       * price nobody transacts at. Closing a short is a *buy*, so the ask is
       * what it costs -- the same reason the board shows a seller the bid.
       * Both are here because the gap between them is the cost of leaving,
       * and on a thin far strike that gap is most of the decision.
       */
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
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
      /**
       * What closing everything now would leave you with, after every charge in
       * and out -- bought back at the **ask**, since closing a short is a buy.
       * Priced at the mark until 30 Sep 2026, which read better than any close
       * could print; the close sheet has always used the ask. The mark only when
       * there is no offer.
       */
      netIfClosedUsd: netIfClosedAt({
        state: r.state,
        price: quote?.ask !== null && quote?.ask !== undefined && quote.ask > 0 ? quote.ask : mark,
        spot,
        paidUsd: charges.totalUsd,
      }),
    },
    /**
     * The protective orders that are actually resting, read off the exchange.
     *
     * Not the plan. The plan is what was asked for and the book is what will
     * fill, and a screen that says "on the book now" while reading the plan is
     * simply wrong when the two differ -- which is exactly the case worth
     * showing.
     */
    /**
     * What the resting exits would leave, in money.
     *
     * The card said "Target 0.80" and left the arithmetic to the reader --
     * 0.80 against an average of 13.00 over 1,400 contracts, less what Delta
     * takes. The ticket has always shown this while the bar is being dragged
     * ("buys back at 0.80 · you keep ₹1,452"); once the order is resting the
     * same number stopped being shown, which is the moment it is worth most.
     *
     * Priced the same way as "If closed now", with the target or the stop in
     * place of the mark, so the three numbers on the card are one arithmetic
     * under three prices and cannot disagree.
     */
    ifExits: resting === null ? null : {
      target: netIfClosedAt({
        state: r.state,
        price: ownExits(r, resting).target?.limitPrice ?? null,
        spot,
        paidUsd: charges.totalUsd,
      }),
      stop: netIfClosedAt({
        state: r.state,
        price: ownExits(r, resting).stop?.stopPrice ?? null,
        spot,
        paidUsd: charges.totalUsd,
      }),
    },
    onBook: resting === null ? null : {
      // The target rests as a limit and carries its level in limitPrice; the
      // stop is a trigger and carries its level in stopPrice.
      target: ownExits(r, resting).target?.limitPrice ?? null,
      // Either shape is the stop: a stop limit is what the desk places since
      // 12 September, a stop market is what it placed before. Matching only the
      // old shape would report "no stop" over a stop that is right there.
      stop: ownExits(r, resting).stop?.stopPrice ?? null,
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
    // Prices from a person: a number above zero, or none.
    takeProfitPrice: body.takeProfitPrice == null ? null : (Number(body.takeProfitPrice) > 0 ? Number(body.takeProfitPrice) : null),
    stopPrice: body.stopPrice == null ? null : (Number(body.stopPrice) > 0 ? Number(body.stopPrice) : null),
    // AlgoTest calls this "Convert to Market After", and it is the same idea:
    // rest at the offer, and if nobody takes it within the wait, cross.
    convertToMarketAfterSec: Math.max(0, Math.min(600, Number(body.convertToMarketAfterSec ?? 0) || 0)),
    leverage: clampLeverage(Number(body.leverage ?? 200)),
    takeProfitPct: pct(body.takeProfitPct, 0.99),
    stopLossPct: pct(body.stopLossPct, 20),
    takeProfitPoints: points(body.takeProfitPoints),
    stopLossPoints: points(body.stopLossPoints),
  };
}

export function registerTradeRoutes(app: FastifyInstance) {
  const svc = tradingService();
  // Recovery runs once, at startup, before anything can be placed.
  // Every account's desk: each picks up its own open trades and begins stepping.
  void startTradingServices();

  /*
   * Computed at most once per STATUS_TTL_MS however many tabs poll it, and
   * every poll that arrives while it is being computed waits for that answer
   * rather than starting another. See `coalesce` in the service for the
   * numbers that made this necessary.
   */
  svc.provideStatus(statusNow);
  // The desk now: mode, balance, positions, open trades with their live P&L, and alarms.
  app.get('/api/trade/status', async () => svc.status());

  async function statusNow() {
    const [balance, positions, wallet] = await Promise.all([
      svc.balanceForDisplay().catch(() => null),
      svc.positionsForDisplay().catch(() => []),
      svc.walletForDisplay().catch(() => null),
    ]);
    const trades = await forScreens(await svc.openTrades());
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
      tradeView(
        r, positions, r.state.contractValue,
        bySymbol.get(r.state.symbol) ?? null, svc.spot,
        restingBy.get(r.state.symbol) ?? null,
      ));
    const today = await svc.todayFigures();
    return {
      mode: svc.mode,
      /** True only when a real order would reach the real exchange. */
      live: svc.mode === 'live',
      /** Whether the switch can be thrown at all from here. */
      canGoLive: svc.canGoLive,
      /** Why it cannot be thrown right now, if it cannot. */
      switchBlockedBy: trades.length > 0
        ? `Close ${trades.length} open position${trades.length === 1 ? '' : 's'} first.`
        : svc.canGoLive ? null : 'No broker account in use. Add one under Logs → Accounts.',
      balanceUsd: balance,
      /**
       * Delta's own wallet: the balance its app shows (FNO wallet / account value), and the margin in use --
       * the balance less what is free. Null where the exchange does not say (paper); the screen then estimates.
       */
      walletUsd: wallet?.balance ?? null,
      marginUsedUsd: wallet ? Math.max(0, wallet.balance - wallet.available) : null,
      positions,
      open,
      /** Every open position added up, so the tab can say it in one number. */
      unrealisedPnlUsd: open.reduce((n, t) => n + (t.live.unrealisedPnl ?? 0), 0),
      alarms: svc.alarms,
      /**
       * Fill alerts: whether Telegram is set up at all, and whether messages
       * are switched on right now. Two different facts -- the first is a
       * deployment question, the second is a preference, and a screen that
       * conflates them offers a switch that does nothing.
       */
      alerts: { configured: svc.notifier !== null, on: svc.alertsOn },
      /** Booked today, in USD. The daily-loss gate reads this; now so can you. */
      realisedTodayUsd: today.realisedUsd,
      /** Losses booked today, in USD. */
      lossTodayUsd: today.lossUsd,
      /**
       * The day so far, in one place, for the header: booked, still open, and
       * Delta's charges on every fill since 05:30 IST. `netUsd` is the number
       * that matters -- what the day has actually made if it closed right now.
       */
      today,
      // The limit in force, which is set from the balance rather than fixed.
      limits: {
        ...DEFAULT_LIMITS,
        maxDailyLossUsd: svc.dailyLossLimitUsd,
        maxShortContracts: svc.maxShortContracts,
      },
    };
  }

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
    // Paper or live is the whole desk's: every account moves together, none while any holds a position.
    const res = await setDeskMode(mode);
    // Refusing to flip with a position open is the guard doing its job, not a
    // fault: it is answered plainly and stays out of the error log.
    return res.ok ? res : refuse(reply, 409, res);
  });

  // One contract's book and product details, for the ticket.
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
      const stop = p.stopPrice ?? (price !== null ? stopFor(price, p) : null);
      const target = p.takeProfitPrice ?? (price !== null ? targetFor(price, p) : null);
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
          leverage: p.leverage, stopPrice: stop, takeProfitPrice: target,
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
        // The same day as the place gate (service.ts): since 05:30 IST, not the last 24 hours -- the preview
        // and the order must not disagree about the daily loss limit.
        dayPnlUsd: await svc.store.realisedSince(startOfDayIst(), svc.accountId),
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

  // Place an order from the ticket: every gate runs again here, and a refusal comes back as 422 with the reasons.
  app.post('/api/trade/place', async (req, reply) => {
    try {
      const p = parse((req.body ?? {}) as PlaceBody);
      const res = await svc.place({
        // From the ticket, by a person: the one place that is true.
        origin: 'manual',
        symbol: p.symbol,
        optionSide: p.side,
        strike: p.strike,
        expiryTs: p.expiryTs,
        lots: p.lots,
        limitPrice: p.limitPrice,
        takeProfitPct: p.takeProfitPct,
        stopLossPct: p.stopLossPct,
        takeProfitPoints: p.takeProfitPoints,
        stopLossPoints: p.stopLossPoints,
        ...atOf(p),
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

  /*
   * Close a position, all of it or part of it.
   *
   * `lots` left out means everything -- what this route has always meant, and
   * what the sheet opens on. A size buys back that many at the market and
   * leaves the rest a position: protection comes off for the close and the
   * next poll puts a target and a stop back over what is left.
   */
  app.post('/api/trade/close', async (req, reply) => {
    const parsed = parseCloseBody((req.body ?? {}) as CloseBody);
    if (!parsed.ok) { reply.code(400); return { error: parsed.problems.join(' '), problems: parsed.problems }; }
    const state = await svc.close(parsed.close.tradeId, parsed.close.lots ?? undefined);
    if (!state) { reply.code(404); return { error: 'no such trade' }; }
    return { ok: true, trade: state };
  });

  /** What closing that many would book, in money. Nothing is sent. */
  app.post('/api/trade/close/preview', async (req, reply) => {
    const parsed = parseCloseBody((req.body ?? {}) as CloseBody);
    if (!parsed.ok) { reply.code(400); return { error: parsed.problems.join(' '), problems: parsed.problems }; }
    const preview = await svc.previewClose(parsed.close.tradeId, parsed.close.lots ?? undefined);
    if (!preview) { reply.code(404); return { error: 'no such trade' }; }
    return preview;
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

  /*
   * Add to a position by hand.
   *
   * Two steps, like the ticket: a preview that runs every gate and prices the
   * add in money, then the add itself, which runs them again. The start price
   * is the offer unless one was typed, and the floor is whatever was typed --
   * a person's add is never sold under the number they gave it. The same
   * engine path the strategy's adds take, so a hand add and a strategy add
   * leave the same journal and the same position.
   */
  /*
   * Where an add starts, and the lowest it may go.
   *
   * A typed price is both: "sell 200 at 20.00" means never under 20.00, so the
   * walk toward the bid has nowhere to go and the order simply rests. That is
   * the right behaviour and a genuine trap -- on 18 September an add sat at
   * 20.00 with the bid at 19.00 for an hour, with "sell at bid after 5 sec"
   * switched on, because the typed price forbade the crossing the switch asked
   * for. So the book comes back with it: the screen can say there is nothing to
   * walk to before the order is sent, rather than after.
   */
  const startOf = async (p: { limitPrice: number | null }, symbol: string) => {
    const q = await svc.quote(symbol).catch(() => null);
    if (p.limitPrice !== null) {
      return { start: p.limitPrice, floor: p.limitPrice, bid: q?.bid ?? null, ask: q?.ask ?? null };
    }
    if (q?.ask == null || q.bid == null) return null;
    return { start: q.ask, floor: q.bid, bid: q.bid, ask: q.ask };
  };

  // What that add would do and whether the gates would take it. Sends nothing.
  app.post('/api/trade/add/preview', async (req, reply) => {
    const parsed = parseAddBody((req.body ?? {}) as AddBody);
    if (!parsed.ok) return refuse(reply, 422, { error: parsed.problems.join(' '), problems: parsed.problems });
    const rec = await svc.store.get(parsed.add.tradeId);
    if (!rec) { reply.code(404); return { error: 'no such trade' }; }
    const at = await startOf(parsed.add, rec.plan.symbol);
    if (!at) return refuse(reply, 422, { error: 'No quote to start from — the book is empty or the feed is down.' });
    const preview = await svc.previewAdd(parsed.add.tradeId, { size: parsed.add.lots, limitPrice: at.start, floorPrice: at.floor });
    return {
      mode: svc.mode,
      startPrice: at.start,
      floorPrice: at.floor,
      /** The book as it is, so the sheet can say what the walk will actually do. */
      bid: at.bid,
      ask: at.ask,
      /** False when the floor is at or above the start: the order will rest, not cross. */
      canWalk: at.floor < at.start,
      ...preview,
    };
  });

  // Sell more of what an open trade holds, under the same trade and through the same gates.
  app.post('/api/trade/add', async (req, reply) => {
    const parsed = parseAddBody((req.body ?? {}) as AddBody);
    if (!parsed.ok) return refuse(reply, 422, { error: parsed.problems.join(' '), problems: parsed.problems });
    const rec = await svc.store.get(parsed.add.tradeId);
    if (!rec) { reply.code(404); return { error: 'no such trade' }; }
    const at = await startOf(parsed.add, rec.plan.symbol);
    if (!at) return refuse(reply, 422, { error: 'No quote to start from — the book is empty or the feed is down.' });
    const res = await svc.addToPosition(
      parsed.add.tradeId,
      toAddRequest(parsed.add, at.start, rec.plan.entry.chase?.maxCrossSpreadPct ?? DEFAULT_LIMITS.maxSpreadPct),
    );
    if (!res.ok) {
      // A gate said no. The desk working as designed: the sheet shows why.
      return refuse(reply, 422, { mode: svc.mode, ok: false, error: res.reason, failures: res.precheck && !res.precheck.ok ? res.precheck.failures : [] });
    }
    return { mode: svc.mode, ok: true, trade: res.state };
  });

  /**
   * Stop a working add now.
   *
   * Idempotent on purpose: an add that has just filled or just timed out is
   * not an error to have asked about, and the answer is the same either way --
   * the trade as it now stands, with nothing adding to it.
   */
  app.post('/api/trade/add/cancel', async (req, reply) => {
    const { tradeId } = (req.body ?? {}) as { tradeId?: string };
    if (!tradeId) { reply.code(400); return { error: 'tradeId is required' }; }
    const state = await svc.cancelAdd(tradeId);
    if (!state) { reply.code(404); return { error: 'no such trade' }; }
    return { ok: true, trade: state };
  });

  /**
   * Fill alerts on or off.
   *
   * Separate from whether Telegram is configured: a token in `.env` says
   * messages *can* go out, this says somebody wants them now. Remembered in the
   * journal, so a silence chosen on a quiet afternoon survives the next deploy.
   * Nothing about the trading engine changes either way.
   */
  // Switch the Telegram fill alerts on or off.
  app.post('/api/trade/alerts', async (req, reply) => {
    const b = (req.body ?? {}) as { on?: unknown };
    if (typeof b.on !== 'boolean') { reply.code(400); return { error: 'on must be true or false' }; }
    await svc.setAlertsOn(b.on);
    return { ok: true, alerts: { configured: svc.notifier !== null, on: svc.alertsOn } };
  });

  /*
   * The Telegram log: every message the desk tried to send -- sent, failed with Telegram's reason, or held back
   * as a repeat -- newest first. `status` narrows it; whether Telegram is set up and switched on rides along.
   */
  app.get('/api/telegram/log', async (req) => {
    const q = (req.query ?? {}) as { limit?: string; status?: string };
    const status = q.status === 'sent' || q.status === 'failed' || q.status === 'repeat' ? q.status : undefined;
    return {
      configured: svc.notifier !== null, on: svc.alertsOn,
      entries: await telegramLog(Number(q.limit ?? 100) || 100, status),
    };
  });

  /** Move the stop or the target on a position that is already open. */
  app.post('/api/trade/protection', async (req, reply) => {
    const b = (req.body ?? {}) as {
      tradeId?: string; takeProfitPct?: number; stopLossPct?: number; takeProfitPoints?: number; stopLossPoints?: number;
      takeProfitPrice?: number; stopPrice?: number;
    };
    if (!b.tradeId) { reply.code(400); return { error: 'tradeId is required' }; }
    const state = await svc.updateExits(b.tradeId, {
      takeProfitPct: b.takeProfitPct === undefined ? undefined : pct(b.takeProfitPct, 0.99),
      stopLossPct: b.stopLossPct === undefined ? undefined : pct(b.stopLossPct, 20),
      takeProfitPoints: b.takeProfitPoints === undefined ? undefined : points(b.takeProfitPoints),
      stopLossPoints: b.stopLossPoints === undefined ? undefined : points(b.stopLossPoints),
      takeProfitAt: b.takeProfitPrice === undefined ? undefined : points(b.takeProfitPrice),
      stopAt: b.stopPrice === undefined ? undefined : points(b.stopPrice),
    }).catch((e: Error) => {
      if (e instanceof ExitAskError) return e;
      throw e;
    });
    if (state instanceof ExitAskError) return refuse(reply, 400, { error: state.message });
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

    // `?account=<id>`: the orders placed as one broker account; without it, every account's.
    // Read from the whole journal by the account named (none: every account's) -- not through a desk's own
    // view, so an account that is switched off, and has no desk, still shows its own orders and no one else's.
    const records = await forScreens(await journal().between(Math.min(from, to), Math.max(from + 86_400_000, to), limit, accountOf(req.query)));

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
          ? tradeView(r, positions, r.state.contractValue, quoteFor.get(r.state.symbol) ?? null, svc.spot)
          : tradeView(r, [], r.state.contractValue, null, svc.spot)),
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

  // One trade with its whole event journal, for the Orders detail.
  app.get('/api/trade/:tradeId', async (req, reply) => {
    const { tradeId } = req.params as { tradeId: string };
    const rec = await svc.store.get(tradeId);
    if (!rec) { reply.code(404); return { error: 'no such trade' }; }
    return { trade: tradeView((await forScreens([rec]))[0]!), events: rec.events };
  });
}
