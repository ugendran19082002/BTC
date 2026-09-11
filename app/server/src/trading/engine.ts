import type {
  ExchangeOrder, OptionSide, OrderRole, PlaceOrderRequest, ProductSpec, TradeEvent, TradeState,
} from './types.js';
import { applyEvent, initialTrade, isDone, protectionSize } from './machine.js';
import { priceFor, lotsToContracts, stopPriceFor } from './money.js';
import { DEFAULT_LIMITS, precheck, type PrecheckResult, type RiskLimits } from './precheck.js';
import { clampLeverage, liquidationRoom, premiumUsd } from './margin.js';
import { ExchangeUnavailable, OrderRejected, SubmitTimeout, type ExchangePort } from './exchange/port.js';

/**
 * The thing that actually trades.
 *
 * It owns no clock and starts no timers. Time arrives as `now()` and work
 * happens when `poll` is called, which means a test can put a trade through a
 * partial fill, a timeout, a gap through the stop and a restart without waiting
 * for a single millisecond -- and production gets exactly the same code path.
 *
 * Three habits run through every method:
 *   - a client order id is derived from the trade, so a retry after a timeout
 *     can never create a second order;
 *   - after anything unexpected, the exchange is read before anything is sent;
 *   - an exit is always `reduceOnly`, always the opposite side, and always
 *     sized from the position we actually hold.
 */

export type EntryPlan = {
  type: 'limit' | 'market';
  /** For a limit: the price to work. Rounded to the tick before it is sent. */
  limitPrice?: number;
  /**
   * How long a working entry gets before it is cancelled. **Zero means it
   * rests until it fills or somebody cancels it.**
   *
   * Zero is the right default for the way this desk sells. An order resting at
   * the offer is meant to sit there and be taken; cancelling it after five
   * seconds guarantees it never fills, which is exactly what happened -- the
   * order appeared, showed "short 0", and vanished on the next poll.
   *
   * A timeout belongs with `marketFallback`: wait this long for the offer to be
   * taken, then cross and pay the spread.
   */
  timeoutMs: number;
  /** Cross the spread after the timeout, once the gates are re-checked. */
  marketFallback: boolean;
  /**
   * Walk the price toward the bid until it fills.
   *
   * The standard answer for an illiquid options book, and this one is: offering
   * at the ask and waiting is all-or-nothing, and on a 12% spread the offer
   * often just sits there. Stepping concedes a little at a time -- so a market
   * maker who will meet you halfway does, and you keep half the spread instead
   * of none of it.
   *
   * The last step is the bid, which is marketable, so a chase always ends in a
   * fill. It replaces the cruder "wait, then cross" rather than sitting beside
   * it, and it moves the order with an edit rather than a cancel and replace,
   * so the order never leaves the book.
   */
  chase: {
    steps: number;
    everyMs: number;
    /**
     * Sell into the bid only while the spread is at most this, as a fraction of
     * the mid (0.15 = 15%). While it is wider the walk stops at the mid and
     * waits. Null or absent walks all the way to the bid, as the order ticket's
     * "sell at bid after N sec" always has.
     */
    maxCrossSpreadPct?: number | null;
  } | null;
};

/**
 * Where a chased order should be priced right now.
 *
 * Straight-line from where it started to the current bid, one step per
 * interval, and never below the bid -- offering under the best bid gives away
 * money that was already on the table. Derived from the clock rather than from
 * a counter, so a restart resumes the walk instead of starting it again.
 */
export function chasePrice(i: {
  startedAt: number;
  now: number;
  from: number;
  bid: number;
  steps: number;
  everyMs: number;
}): number {
  if (!(i.steps > 0) || !(i.everyMs > 0) || i.bid >= i.from) return i.bid;
  const step = Math.min(i.steps, Math.floor((i.now - i.startedAt) / i.everyMs));
  if (step <= 0) return i.from;
  return i.from - ((i.from - i.bid) * step) / i.steps;
}

/**
 * The lowest price a chase may walk to right now, or null when the bid itself
 * is allowed.
 *
 * With no limit set, the bid is always allowed. With one, a book wider than the
 * limit holds the walk at the middle of the spread: it still concedes half the
 * spread to a buyer who will meet it there, but never sells into a bid that far
 * under the offer -- 37 bid / 44 offered is a 17% spread, and selling at 37 gives
 * three and a half points away on the spot. A book with no offer cannot be
 * measured, so the walk holds where it is. The moment the spread narrows, the
 * walk carries on to the bid.
 */
export function chaseFloor(bid: number, ask: number | null, maxSpreadPct: number | null): number | null {
  if (maxSpreadPct === null) return null;
  if (ask === null) return Number.POSITIVE_INFINITY;
  if (!(ask > bid)) return null;
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return null;
  return (ask - bid) / mid <= maxSpreadPct ? null : mid;
}

export type TradePlan = {
  tradeId: string;
  symbol: string;
  /**
   * The saved strategy that opened this trade, when one did.
   *
   * Absent for anything placed by hand from the ticket. The scheduler needs it
   * to find its own positions at the exit time without closing a trade somebody
   * opened themselves.
   */
  strategyId?: string;
  optionSide: OptionSide;
  lots: number;
  entry: EntryPlan;
  /**
   * 1 to 200. Sets the margin behind each lot, and with it how far the option
   * can move before the exchange closes the position out.
   */
  leverage: number;
  /** Buy-back price that books the win. `null` means no target. */
  takeProfitPrice: number | null;
  /** Buy-back trigger that caps the loss. `null` means no stop -- and the
   * engine will say so, loudly, rather than pretending the trade is protected. */
  stopPrice: number | null;
  expect: { underlying: string; optionSide: OptionSide; strike: number; expiryTs: number };
};

export type TradeRecord = { state: TradeState; plan: TradePlan; events: TradeEvent[] };

export interface TradeStore {
  save(rec: TradeRecord): void;
  get(tradeId: string): TradeRecord | null;
  all(): TradeRecord[];
  open(): TradeRecord[];
}

export class MemoryTradeStore implements TradeStore {
  private rows = new Map<string, TradeRecord>();
  save(rec: TradeRecord) { this.rows.set(rec.state.tradeId, rec); }
  get(id: string) { return this.rows.get(id) ?? null; }
  all() { return [...this.rows.values()]; }
  open() { return this.all().filter((r) => !isDone(r.state)); }
}

export type EngineDeps = {
  exchange: ExchangePort;
  store: TradeStore;
  now: () => number;
  limits?: RiskLimits;
  /** Master switch. Off means every open is refused before it is built. */
  tradingEnabled?: boolean;
  /** False while the price feed is down or resyncing. */
  feedHealthy?: () => boolean;
  /** Today's realised P&L, in USD. */
  dayPnlUsd?: () => number;
  /** BTC spot, for the margin and liquidation model. */
  spot?: () => number | null;
  onAlarm?: (trade: TradeState, message: string) => void;
  /**
   * Every journal event as it is written, with the trade either side of it.
   *
   * For telling a person what happened -- a phone alert when something fills.
   * Called only from `commit`, never from replay, so a restart that rebuilds
   * the trades from the journal does not announce yesterday's fills again.
   */
  onEvent?: (event: TradeEvent, before: TradeState, after: TradeState, plan: TradePlan) => void;
  /** A failure the engine carried on past. Best-effort, but not silent. */
  onSwallowed?: (what: string, order: { orderId: string; symbol?: string }, error: Error) => void;
};

export type OpenResult =
  | { ok: true; state: TradeState }
  | { ok: false; state: TradeState; precheck: PrecheckResult };

/** How long to wait before trying protection again after a refusal. */
const PROTECT_RETRY_MS = 2_000;
/**
 * How old a quote may be before the desk refuses to act on it.
 *
 * Everything below closes a position on the strength of one number. A mark from
 * a minute ago is not evidence about now, and acting on it would exit a trade
 * because the feed stalled rather than because the price moved.
 */
const MARK_STALE_MS = 15_000;
const PROTECT_RETRY_MAX_MS = 60_000;

const ROLE_CODE: Record<OrderRole | 'exit', string> = {
  entry: 'E', take_profit: 'T', stop_loss: 'S', exit: 'X',
};

/**
 * The id we give an order, in a shape the exchange will take.
 *
 * Delta rejected `C-BTC-82000-090926-1757349123456:entry` as bad_schema: too
 * long, and punctuation it does not allow. So the id is stripped to letters and
 * digits and cut to the tail, which is where the timestamp lives and therefore
 * where the uniqueness is.
 *
 * It stays a pure function of the trade and the role, and that is the part that
 * matters: the same trade asking for the same order twice produces the same id,
 * which is what makes a retry after a timeout safe.
 */
export const clientId = (tradeId: string, role: OrderRole | 'exit', n = 0): string =>
  `${tradeId.replace(/[^A-Za-z0-9]/g, '').slice(-18)}${ROLE_CODE[role]}${n}`;

export class TradeEngine {
  private readonly limits: RiskLimits;
  /** Set while a trade is being resolved after a timeout. Nothing may be sent. */
  private entryDeadline = new Map<string, number>();
  /** Earliest time protection may be attempted again, per trade. */
  private protectAfter = new Map<string, number>();
  /** One operation at a time per trade. See `withTrade`. */
  private queue = new Map<string, Promise<unknown>>();

  constructor(private readonly d: EngineDeps) {
    this.limits = d.limits ?? DEFAULT_LIMITS;
  }

  /**
   * Serialise everything that touches one trade.
   *
   * The poll loop steps every open trade once a second while the screen can ask
   * for a stop to be moved, a position closed or an order pulled -- and all of
   * those read the trade, decide, and write. Two of them overlapping is not a
   * theoretical race: it put two placements on the same client order id and
   * Delta answered `duplicate_client_order_id`, which reached the user as "the
   * update did not work".
   *
   * A promise chain per trade, rather than a lock, because the work is already
   * asynchronous and ordering is the only thing that has to be guaranteed. A
   * failure does not poison the chain: the next caller runs regardless.
   *
   * Only public entry points take it. The internals -- protect, absorb,
   * cancelSiblings -- assume they are already inside one, so a nested call
   * cannot deadlock against itself.
   */
  private withTrade<T>(tradeId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queue.get(tradeId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // Swallowed only for the chain's own bookkeeping; the caller still sees it.
    this.queue.set(tradeId, next.then(() => {}, () => {}));
    return next;
  }

  /**
   * A failure we carry on past, written down.
   *
   * Best-effort is the right behaviour for a cancel -- the trade must not stop
   * because one clean-up call failed -- but best-effort and *silent* are not
   * the same thing, and the difference is a week of not knowing why the book
   * disagreed with the screen. The engine keeps going; the log keeps the reason.
   */
  private note(what: string, order: { orderId: string; symbol?: string }, e: unknown): void {
    this.d.onSwallowed?.(what, order, e as Error);
  }

  private get exchange() { return this.d.exchange; }
  private now() { return this.d.now(); }
  private feedHealthy() { return this.d.feedHealthy ? this.d.feedHealthy() : true; }
  private dayPnl() { return this.d.dayPnlUsd ? this.d.dayPnlUsd() : 0; }

  private commit(rec: TradeRecord, ...events: TradeEvent[]): TradeRecord {
    let state = rec.state;
    const steps: [TradeEvent, TradeState, TradeState][] = [];
    for (const e of events) {
      const prev = state;
      state = applyEvent(state, e);
      rec.events.push(e);
      steps.push([e, prev, state]);
    }
    const before = rec.state.alarm;
    rec.state = state;
    this.d.store.save(rec);
    if (state.alarm && state.alarm !== before) this.d.onAlarm?.(state, state.alarm);
    // Only after the save. The journal is the record; nothing that merely
    // reports on it may stand between an event and the disk, and a listener
    // that throws is its own bug -- it does not get to become the trade's.
    if (this.d.onEvent) {
      for (const [e, prev, next] of steps) {
        try {
          this.d.onEvent(e, prev, next, rec.plan);
        } catch (err) {
          this.note('event listener', { orderId: rec.state.tradeId, symbol: rec.state.symbol }, err);
        }
      }
    }
    return rec;
  }

  // ------------------------------------------------------------ prechecks
  async runPrecheck(plan: TradePlan, product: ProductSpec | null): Promise<PrecheckResult> {
    const [quote, balance, positions, spot] = await Promise.all([
      this.exchange.getQuote(plan.symbol).catch(() => null),
      this.exchange.getBalanceUsd().catch(() => 0),
      this.exchange.getPositions().catch(() => []),
      this.d.spot ? Promise.resolve(this.d.spot()) : Promise.resolve(null),
    ]);
    const size = product ? lotsToContracts(plan.lots, product.lotSize) : plan.lots;
    const held = positions.find((p) => p.symbol === plan.symbol)?.size ?? 0;
    const totalShort = positions.reduce((n, p) => n + (p.size < 0 ? -p.size : 0), 0);
    const price = plan.entry.type === 'limit' ? plan.entry.limitPrice ?? null : quote?.bid ?? null;

    // Worst case is the buy-back at the stop, less the credit taken in.
    //
    // With no stop it is not unbounded: the exchange closes the position out at
    // its own price, and that is the real cap. Which means the loss a naked
    // trade risks is set by leverage -- more leverage, tighter close-out, less
    // to lose. That is the one thing high leverage is good for, and the gate
    // should reflect it rather than refusing every trade without a stop.
    const credit = premiumUsd(price ?? 0, size, product?.contractValue);
    const worstCase = worstCaseLoss({
      stopPrice: plan.stopPrice, price, size, credit, spot,
      leverage: clampLeverage(plan.leverage), contractValue: product?.contractValue,
    });

    return precheck({
      now: this.now(),
      intent: {
        side: 'sell', size, expect: plan.expect, price, reduceOnly: false,
        leverage: clampLeverage(plan.leverage), stopPrice: plan.stopPrice,
        crossing: crossesSpread('sell', plan.entry.type, plan.entry.limitPrice ?? null, quote),
      },
      spot,
      product,
      quote,
      feedHealthy: this.feedHealthy(),
      tradingEnabled: this.d.tradingEnabled !== false,
      account: { availableUsd: balance },
      existingPosition: held,
      totalShortContracts: totalShort,
      dayPnlUsd: this.dayPnl(),
      worstCaseLossUsd: worstCase,
      limits: this.limits,
    });
  }

  // ----------------------------------------------------------------- open
  async open(plan: TradePlan): Promise<OpenResult> {
    const at = this.now();
    const product = await this.exchange.getProduct(plan.symbol).catch(() => null);
    const size = product ? lotsToContracts(plan.lots, product.lotSize) : plan.lots;

    let rec: TradeRecord = {
      plan,
      events: [],
      state: initialTrade({
        tradeId: plan.tradeId, symbol: plan.symbol, productId: product?.productId ?? 0,
        optionSide: plan.optionSide, requestedSize: size, at,
        wantsProtection: plan.stopPrice !== null,
        contractValue: product?.contractValue,
      }),
    };

    // A trade id is used once. Re-running the same signal is not a second trade.
    const prior = this.d.store.get(plan.tradeId);
    if (prior) return { ok: true, state: prior.state };
    this.d.store.save(rec);

    const gate = await this.runPrecheck(plan, product);
    if (!gate.ok) {
      const why = gate.failures.map((x) => x.message).join(' ');
      rec = this.commit(rec, { t: 'precheck_failed', reason: why, at: this.now() });
      return { ok: false, state: rec.state, precheck: gate };
    }

    // Leverage is a product setting on Delta, so it has to be right before the
    // order lands rather than travelling with it. If it cannot be set the trade
    // does not go: the alternative is filling at whatever was left from last time.
    if (product) {
      try {
        await this.exchange.setLeverage(product.productId, clampLeverage(plan.leverage));
      } catch (e) {
        rec = this.commit(rec, {
          t: 'precheck_failed',
          reason: `could not set ${clampLeverage(plan.leverage)}x leverage: ${(e as Error).message}`,
          at: this.now(),
        });
        return {
          ok: false, state: rec.state,
          precheck: { ok: false, failures: [{ code: 'LEVERAGE_TOO_HIGH', message: rec.state.note ?? 'leverage refused' }] },
        };
      }
    }

    const tick = product?.tickSize ?? 0.1;
    const req: PlaceOrderRequest = {
      clientOrderId: clientId(plan.tradeId, 'entry'),
      symbol: plan.symbol,
      productId: product?.productId ?? 0,
      side: 'sell',
      type: plan.entry.type,
      size,
      limitPrice: plan.entry.type === 'limit' && plan.entry.limitPrice !== undefined
        ? priceFor('sell', plan.entry.limitPrice, tick)
        : undefined,
      role: 'entry',
    };

    try {
      const ack = await this.exchange.placeOrder(req);
      rec = this.commit(rec, { t: 'entry_submitted', clientOrderId: req.clientOrderId, size, at: this.now() });
      // No deadline at all when the order is meant to rest.
      if (plan.entry.timeoutMs > 0) {
        this.entryDeadline.set(plan.tradeId, this.now() + plan.entry.timeoutMs);
      }
      rec = this.absorb(rec, ack, 'entry');
      return { ok: true, state: rec.state };
    } catch (e) {
      if (e instanceof SubmitTimeout) {
        // We do not know whether it landed. Do not send another one.
        rec = this.commit(rec, { t: 'entry_submit_unknown', at: this.now() });
        return { ok: true, state: rec.state };
      }
      if (e instanceof OrderRejected) {
        rec = this.commit(rec, { t: 'entry_rejected', reason: e.reason, at: this.now() });
        return { ok: false, state: rec.state, precheck: { ok: false, failures: [{ code: 'NOT_TRADABLE', message: e.reason }] } };
      }
      if (e instanceof ExchangeUnavailable) {
        rec = this.commit(rec, { t: 'entry_submit_unknown', at: this.now() });
        return { ok: true, state: rec.state };
      }
      throw e;
    }
  }

  /** Turn an exchange order snapshot into whatever fills we have not seen yet. */
  private absorb(rec: TradeRecord, order: ExchangeOrder, role: OrderRole): TradeRecord {
    const seen = rec.state.fills
      .filter((f) => f.orderId === order.orderId)
      .reduce((n, f) => n + f.size, 0);
    const fresh = order.filledSize - seen;
    if (fresh > 0 && order.averageFillPrice !== null) {
      // The exchange reports an average; the increment is priced so that the
      // running average lands on it exactly, which is what a weighted average
      // over several levels has to do.
      const price = seen > 0
        ? (order.averageFillPrice * order.filledSize - avgSeenNotional(rec.state, order.orderId)) / fresh
        : order.averageFillPrice;
      rec = this.commit(rec, {
        t: 'fill', role, side: order.side, size: fresh, price,
        orderId: order.orderId, at: this.now(),
      });
    }
    if (order.status === 'rejected') {
      rec = this.commit(rec, { t: 'entry_rejected', reason: order.reason ?? 'rejected', at: this.now() });
    }
    return rec;
  }

  // ----------------------------------------------------------------- poll
  /**
   * One step of the loop. Reads the exchange, applies what changed, and does
   * the next thing the trade needs: cancel a stale entry, put protection on,
   * cancel the losing side of an OCO.
   */
  /** One step of the loop. Queued, so it cannot overlap a screen action. */
  poll(tradeId: string): Promise<TradeState | null> {
    return this.withTrade(tradeId, () => this.pollInner(tradeId));
  }

  /** Take a working entry off the book and end the trade. */
  cancelEntry(tradeId: string): Promise<TradeState | null> {
    return this.withTrade(tradeId, () => this.cancelEntryInner(tradeId));
  }

  /** Move the stop or the target on a position that is already on. */
  updateProtection(
    tradeId: string,
    next: { takeProfitPrice?: number | null; stopPrice?: number | null },
  ): Promise<TradeState | null> {
    return this.withTrade(tradeId, () => this.updateProtectionInner(tradeId, next));
  }

  /** Close whatever is left, right now, at the market. */
  closeNow(tradeId: string, reason = 'manual exit'): Promise<TradeState | null> {
    return this.withTrade(tradeId, () => this.closeNowInner(tradeId, reason));
  }

  /** Read the exchange and believe it. */
  reconcile(tradeId: string): Promise<TradeRecord | null> {
    return this.withTrade(tradeId, () => this.reconcileInner(tradeId));
  }

  private async pollInner(tradeId: string): Promise<TradeState | null> {
    const rec0 = this.d.store.get(tradeId);
    if (!rec0 || isDone(rec0.state)) return rec0?.state ?? null;
    let rec = rec0;

    // A submit we never got an answer for is resolved by reading, never writing.
    if (rec.state.phase === 'entry_unknown') return (await this.reconcileInner(tradeId))?.state ?? null;

    // The entry and both exit legs are three independent lookups. Read one
    // after another they added a round trip each to every poll; the results are
    // still absorbed in a fixed order, so the state they produce is unchanged.
    const entryId = clientId(tradeId, 'entry');
    const legs = [
      ['entry', entryId],
      ['take_profit', rec.state.protection.takeProfit],
      ['stop_loss', rec.state.protection.stopLoss],
    ] as const;
    const found = await Promise.all(
      legs.map(([, cid]) => (cid ? this.exchange.getOrderByClientId(cid).catch(() => null) : null)),
    );
    for (const [i, [role]] of legs.entries()) {
      const o = found[i];
      if (o) rec = this.absorb(rec, o, role);
    }
    const entry = found[0];

    // A resting entry that is being walked toward the bid.
    if (
      entry && (entry.status === 'open' || entry.status === 'partial') &&
      rec.plan.entry.chase && entry.limitPrice !== null
    ) {
      const startedAt = rec.events.find((e) => e.t === 'entry_submitted')?.at ?? this.now();
      const quote = await this.exchange.getQuote(rec.plan.symbol).catch(() => null);
      const product = await this.exchange.getProduct(rec.plan.symbol).catch(() => null);
      if (quote?.bid != null) {
        const from = rec.plan.entry.limitPrice ?? entry.limitPrice;
        const tick = product?.tickSize ?? 0.1;
        let want = priceFor('sell', chasePrice({
          startedAt, now: this.now(), from, bid: quote.bid,
          steps: rec.plan.entry.chase.steps, everyMs: rec.plan.entry.chase.everyMs,
        }), tick);
        // Not into a wide bid when the plan says so: hold at the mid until the
        // spread narrows. See `chaseFloor`.
        const floor = chaseFloor(quote.bid, quote.ask, rec.plan.entry.chase.maxCrossSpreadPct ?? null);
        if (floor !== null) {
          want = Math.max(want, Number.isFinite(floor) ? priceFor('sell', floor, tick) : entry.limitPrice);
        }
        if (want < entry.limitPrice) {
          // Moved, not replaced: the order never leaves the book, so there is
          // no moment where the entry is neither working nor filled.
          const moved = await this.exchange
            .editOrder(entry, { limitPrice: want })
            .catch((e) => { this.note('chase', entry, e); return null; });
          if (moved) rec = this.absorb(rec, moved, 'entry');
        }
      }
    }

    // Entry timed out and is still resting: cancel what is left.
    const deadline = this.entryDeadline.get(tradeId);
    if (entry && (entry.status === 'open' || entry.status === 'partial') && deadline !== undefined && this.now() >= deadline) {
      rec = this.commit(rec, { t: 'entry_timeout', at: this.now() });
      await this.exchange.cancelOrder(entry).catch((e) => this.note('cancel entry', entry, e));
      this.entryDeadline.delete(tradeId);
      const after = await this.exchange.getOrderByClientId(entryId).catch(() => null);
      if (after) rec = this.absorb(rec, after, 'entry');
      rec = this.commit(rec, { t: 'entry_cancelled', remaining: entry.size - (after?.filledSize ?? entry.filledSize), at: this.now() });

      if (rec.state.position === 0 && rec.plan.entry.marketFallback) {
        return (await this.marketFallback(tradeId)).state;
      }
    }

    // An exit printed: the other side has to go before it can re-open us.
    if (rec.state.exitWinner) rec = await this.cancelSiblings(rec);

    if (rec.state.position !== 0 && rec.state.phase !== 'exit_pending' && missingProtection(rec)) {
      rec = await this.protect(rec);
    }

    // The stop is judged here as well as at the exchange. This runs after
    // protection, so a stop reached on the very first poll still exits. The
    // target is not judged here at all -- see `stopIfReached` for why.
    if (rec.state.position !== 0 && rec.state.phase !== 'exit_pending') {
      rec = await this.stopIfReached(rec);
    }

    if (rec.state.position === 0 && rec.state.entrySize > 0 && rec.state.phase !== 'flat') {
      rec = await this.cancelSiblings(rec, true);
      rec = this.commit(rec, { t: 'reconciled', position: 0, at: this.now(), note: 'closed' });
    }

    return rec.state;
  }

  /** Cross the spread, but only after the gates say the market is still sane. */
  private async marketFallback(tradeId: string): Promise<TradeRecord> {
    let rec = this.d.store.get(tradeId)!;
    const product = await this.exchange.getProduct(rec.plan.symbol).catch(() => null);
    const gate = await this.runPrecheck(rec.plan, product);
    if (!gate.ok) {
      return this.commit(rec, {
        t: 'aborted',
        reason: `market fallback refused: ${gate.failures.map((x) => x.message).join(' ')}`,
        at: this.now(),
      });
    }
    const size = product ? lotsToContracts(rec.plan.lots, product.lotSize) : rec.plan.lots;
    try {
      const ack = await this.exchange.placeOrder({
        clientOrderId: clientId(tradeId, 'entry', 2),
        symbol: rec.plan.symbol,
        productId: product?.productId ?? 0,
        side: 'sell', type: 'market', size, role: 'entry',
      });
      rec = this.absorb(rec, ack, 'entry');
      if (rec.state.position !== 0) rec = await this.protect(rec);
    } catch (e) {
      if (e instanceof SubmitTimeout || e instanceof ExchangeUnavailable) {
        rec = this.commit(rec, { t: 'entry_submit_unknown', at: this.now() });
      } else if (e instanceof OrderRejected) {
        rec = this.commit(rec, { t: 'entry_rejected', reason: e.message, at: this.now() });
      } else throw e;
    }
    return rec;
  }

  // ----------------------------------------------------------- protection
  /**
   * Put a target and a stop behind the position, sized from what we actually
   * hold. If either cannot be placed the trade is marked unprotected -- it is
   * never quietly left naked.
   */
  /**
   * Make the book match the plan.
   *
   * Written as a reconciler rather than as "place what I do not remember
   * placing", because the desk's memory and the exchange's book had drifted:
   * a cancel was refused, the refusal was swallowed, a replacement went on
   * beside the order it was meant to replace, and Delta -- which will not hold
   * two reduce-only orders totalling more than the position -- cancelled one of
   * them. The screen said the target was at 1.80 while the book had 26.40.
   *
   * So the book is read first and it is the authority. Each leg is then one of
   * four cases: right already, wrong price, present but unwanted, or missing.
   * A cancel is verified before its replacement is sent, because an unverified
   * cancel is exactly how two live orders happen.
   */
  async protect(recIn: TradeRecord): Promise<TradeRecord> {
    let rec = recIn;
    const size = protectionSize(rec.state);
    if (size === 0) return rec;
    if (rec.plan.takeProfitPrice === null && rec.plan.stopPrice === null) {
      // Nothing wanted. Anything still resting is left over and has to go.
      return this.clearProtection(rec);
    }

    // A refusal is not worth repeating every second. Delta answered
    // `no_position_for_reduce_only` because it had not registered the fill yet,
    // and hammering it does not make it register faster.
    const notBefore = this.protectAfter.get(rec.state.tradeId);
    if (notBefore !== undefined && this.now() < notBefore) return rec;

    /*
     * Three reads, none of which depends on the other two, so they go together.
     *
     * Run one after another they were most of the gap between a fill printing
     * and the exits reaching the book -- measured at 1.81 seconds on a live
     * trade, which is a long time to hold a position with nothing behind it.
     * Each is a round trip to Delta and the latency is almost all of the cost.
     *
     * When the position turns out not to be registered yet the other two reads
     * are wasted, which is the trade being made: two reads at weight 3 against
     * a limit of 20,000 per five minutes, in exchange for a shorter window
     * where the position is naked.
     */
    const [heldRaw, product, book] = await Promise.all([
      this.exchange.getPositions()
        .then((ps) => ps.find((p) => p.symbol === rec.plan.symbol)?.size ?? 0)
        .catch(() => null),
      this.exchange.getProduct(rec.plan.symbol).catch(() => null),
      this.exchange.getOpenOrders(rec.plan.symbol).catch(() => null),
    ]);

    // Reduce-only orders need a position the exchange agrees exists.
    const held = heldRaw;
    if (held === null) return rec;
    if (held === 0) {
      this.protectAfter.set(rec.state.tradeId, this.now() + PROTECT_RETRY_MS);
      return rec;
    }

    const tick = product?.tickSize ?? 0.1;
    const attempt = rec.events.filter(
      (e) => e.t === 'protection_placed' || e.t === 'protection_failed',
    ).length;

    if (book === null) return rec;
    const resting = book.filter((o) => o.reduceOnly && (o.status === 'open' || o.status === 'partial'));

    let failure: string | null = null;
    const settle = async (
      role: 'take_profit' | 'stop_loss',
      wanted: number | null,
      match: (o: ExchangeOrder) => boolean,
      priceOf: (o: ExchangeOrder) => number | null,
      field: 'limitPrice' | 'stopPrice',
      place: (cid: string, price: number) => Promise<void>,
    ): Promise<string | null> => {
      const live = resting.filter(match);
      // Both legs round towards firing rather than towards a better price: a
      // level that misses by a tick is a level that does not exist. One tick of
      // slippage is cheaper than an exit that never happens.
      const target = wanted === null ? null : stopPriceFor(role === 'stop_loss' ? 'buy' : 'sell', wanted, tick);

      // Right already, and the right size: keep it, and remember which it is.
      // The size that counts is what is still resting. A target that has bought
      // back 203 of 425 is covering the 222 left, and that is correct.
      const keep = target === null
        ? undefined
        : live.find((o) => priceOf(o) === target && o.size - o.filledSize === size);

      /*
       * One order is on the book at the wrong level, and one is wanted: move it
       * rather than replacing it.
       *
       * Delta's PUT /v2/orders edits in place, which removes this whole class
       * of failure -- there is no window where the position is unprotected, and
       * no moment where two reduce-only orders exist and the exchange has to
       * decide which of them over-commits the position. That moment is what
       * produced "reduce only orders cancelled" and a book that disagreed with
       * the screen.
       */
      /*
       * Only an order with nothing filled yet. Delta's `size` on an edit is the
       * order's total, filled part included, so asking a half-filled 425 for 222
       * would leave 19 resting -- not 222. Cancelling leaves the filled part
       * alone, so a half-filled order goes the long way below.
       */
      if (!keep && target !== null && live.length === 1 && live[0]!.filledSize === 0) {
        const only = live[0]!;
        try {
          await this.exchange.editOrder(only, { [field]: target, size });
          return only.clientOrderId ?? clientId(rec.state.tradeId, role, attempt);
        } catch (e) {
          // Some venues refuse an edit that a cancel-and-replace would allow.
          // Fall through and do it the long way, verifying as we go.
          failure = null;
          void e;
        }
      }

      for (const o of live) {
        if (o === keep) continue;
        const gone = await this.cancelAndVerify(o);
        // A cancel that did not take means the book still holds it. Sending a
        // replacement now is what over-commits the position.
        if (!gone) { failure ??= `could not cancel the ${role.replace('_', ' ')} already on the book`; }
      }
      if (failure !== null) return keep?.clientOrderId ?? null;
      if (keep) return keep.clientOrderId;
      if (target === null) return null;

      const cid = clientId(rec.state.tradeId, role, attempt);
      try {
        await place(cid, target);
        return cid;
      } catch (e) {
        failure ??= (e as Error).message;
        return null;
      }
    };

    /*
     * The target rests on the book as a plain reduce-only limit buy.
     *
     * It was briefly a `take_profit_order` trigger, on the reasoning that a
     * resting bid only fills when somebody offers at it, so a decayed option
     * could fall straight through the level untouched. That reasoning was
     * right; the implementation was not. Delta fired the trigger the instant it
     * landed -- a short sold at 7.00 with a target at 0.50 bought itself back at
     * 7.00 less than four seconds later, twice, for a real loss. The trigger
     * direction for a *buy* is not what the docs led me to read into it.
     *
     * So the exchange is no longer asked to decide when the target is reached.
     * A resting limit buy has one property that matters here and cannot be got
     * wrong: it fills at its price or better, never worse. It cannot cost money
     * by firing early.
     *
     * The case it misses -- the mark falling through with no offer at the level
     * -- is left missed, on purpose. For a while the desk covered it by watching
     * the mark and buying back at the market, and on 10 September that paid a
     * 2.00 offer against a 1.00 target on two legs. A target is the price you
     * will pay; if nobody sells there, the position stays on.
     */
    const tp = await settle(
      'take_profit',
      rec.plan.takeProfitPrice,
      (o) => o.type === 'limit',
      (o) => o.limitPrice,
      'limitPrice',
      (cid, price) => this.exchange.placeOrder({
        clientOrderId: cid, symbol: rec.plan.symbol, productId: product?.productId ?? 0,
        side: 'buy', type: 'limit', size, limitPrice: price,
        reduceOnly: true, role: 'take_profit',
      }).then(() => {}),
    );

    /*
     * The stop stays a trigger at the exchange, because its whole value is that
     * it works when this process does not. `stopIfReached` watches the level
     * too, so an outage is covered from both ends.
     */
    const sl = await settle(
      'stop_loss',
      rec.plan.stopPrice,
      (o) => o.type === 'stop_market',
      (o) => o.stopPrice,
      'stopPrice',
      (cid, price) => this.exchange.placeOrder({
        clientOrderId: cid, symbol: rec.plan.symbol, productId: product?.productId ?? 0,
        side: 'buy', type: 'stop_market', size, stopPrice: price, reduceOnly: true, role: 'stop_loss',
      }).then(() => {}),
    );

    // Size is part of the identity of a protective order, not a detail of it:
    // the same ids covering a different number of contracts is a change.
    if (tp !== rec.state.protection.takeProfit
        || sl !== rec.state.protection.stopLoss
        || rec.state.protection.size !== size) {
      rec = this.commit(rec, {
        t: 'protection_placed', takeProfit: tp, stopLoss: sl, size, at: this.now(),
      });
    }

    if (failure === null) {
      this.protectAfter.delete(rec.state.tradeId);
      return rec;
    }

    const tries = rec.events.filter((x) => x.t === 'protection_failed').length;
    this.protectAfter.set(
      rec.state.tradeId,
      this.now() + Math.min(PROTECT_RETRY_MAX_MS, PROTECT_RETRY_MS * 2 ** tries),
    );
    return this.commit(rec, { t: 'protection_failed', reason: failure, at: this.now() });
  }

  /**
   * Cancel, then look again.
   *
   * `cancelOrder` reports nothing useful: a venue that refuses the cancel and a
   * venue that honours it both return quietly. The only way to know is to read
   * the order back.
   */
  private async cancelAndVerify(order: ExchangeOrder): Promise<boolean> {
    await this.exchange.cancelOrder(order).catch((e) => this.note('cancel', order, e));
    if (!order.clientOrderId) return true;
    const after = await this.exchange.getOrderByClientId(order.clientOrderId).catch(() => null);
    if (after === null) return true;                       // gone from the book
    return after.status !== 'open' && after.status !== 'partial';
  }

  /** Take every protective order off the book, verifying each one. */
  private async clearProtection(recIn: TradeRecord): Promise<TradeRecord> {
    let rec = recIn;
    const book = await this.exchange.getOpenOrders(rec.plan.symbol).catch(() => []);
    for (const o of book.filter((x) => x.reduceOnly)) await this.cancelAndVerify(o);
    if (rec.state.protection.takeProfit || rec.state.protection.stopLoss) {
      rec = this.commit(rec, {
        t: 'protection_placed', takeProfit: null, stopLoss: null, size: 0, at: this.now(),
      });
    }
    return rec;
  }

  private async replaceIfResized(oldCid: string | null, newCid: string, _size: number) {
    if (!oldCid || oldCid === newCid) return;
    const old = await this.exchange.getOrderByClientId(oldCid).catch(() => null);
    if (old && (old.status === 'open' || old.status === 'partial')) {
      await this.exchange.cancelOrder(old).catch((e) => this.note('cancel superseded', old, e));
    }
  }

  /** One exit won. Take the other one off the book. */
  private async cancelSiblings(recIn: TradeRecord, all = false): Promise<TradeRecord> {
    let rec = recIn;
    const winner = rec.state.exitWinner;
    for (const [role, cid] of [
      ['take_profit', rec.state.protection.takeProfit],
      ['stop_loss', rec.state.protection.stopLoss],
    ] as const) {
      if (!cid) continue;
      if (!all && role === winner) continue;
      const o = await this.exchange.getOrderByClientId(cid).catch(() => null);
      if (o && (o.status === 'open' || o.status === 'partial')) {
        await this.exchange.cancelOrder(o).catch((e) => this.note('cancel sibling', o, e));
      }
      rec = this.commit(rec, { t: 'sibling_cancelled', role, at: this.now() });
    }
    return rec;
  }

  /**
   * Take a working entry off the book and end the trade.
   *
   * Only ever the entry, and only while nothing has filled: once there are
   * contracts, the way out is `closeNow`, which buys them back.
   */
  private async cancelEntryInner(tradeId: string): Promise<TradeState | null> {
    let rec = this.d.store.get(tradeId);
    if (!rec) return null;
    if (rec.state.position !== 0) return rec.state;

    const order = await this.exchange.getOrderByClientId(clientId(tradeId, 'entry')).catch(() => null);
    if (order && (order.status === 'open' || order.status === 'partial')) {
      await this.exchange.cancelOrder(order).catch((e) => this.note('cancel entry', order, e));
      const after = await this.exchange.getOrderByClientId(clientId(tradeId, 'entry')).catch(() => null);
      if (after) rec = this.absorb(rec, after, 'entry');
    }
    this.entryDeadline.delete(tradeId);
    rec = this.commit(rec, {
      t: 'entry_cancelled',
      remaining: order ? order.size - order.filledSize : rec.state.requestedSize,
      at: this.now(),
    });
    return rec.state;
  }

  /**
   * Move the stop or the target on a position that is already on.
   *
   * The exits were only ever chosen at entry, which is the one moment you know
   * least about how the trade is going. This takes whatever is resting off the
   * book and puts the new pair on -- in that order, so there is never a moment
   * with two targets live, and never a fill against a level you have just
   * moved away from.
   *
   * `null` turns one off. That is a decision like any other, and the trade
   * stops asking for a stop it no longer wants rather than raising an alarm
   * about it.
   */
  private async updateProtectionInner(
    tradeId: string,
    next: { takeProfitPrice?: number | null; stopPrice?: number | null },
  ): Promise<TradeState | null> {
    let rec = this.d.store.get(tradeId);
    if (!rec) return null;
    if (rec.state.position === 0) return rec.state;

    rec.plan = {
      ...rec.plan,
      takeProfitPrice: next.takeProfitPrice !== undefined ? next.takeProfitPrice : rec.plan.takeProfitPrice,
      stopPrice: next.stopPrice !== undefined ? next.stopPrice : rec.plan.stopPrice,
    };
    rec.state = { ...rec.state, wantsProtection: rec.plan.stopPrice !== null };

    // An explicit change is not a retry, so the backoff does not apply to it.
    this.protectAfter.delete(tradeId);
    // protect() reconciles the book against the plan, so changing the plan and
    // asking it to run is the whole operation: it cancels what no longer
    // belongs, verifies that the cancel took, and places what is missing.
    rec = await this.protect(rec);
    this.d.store.save(rec);
    return rec.state;
  }

  /**
   * The desk's own eye on the stop.
   *
   * Judged on the mark, and closed at the market, because a stop has to get
   * out: a price running away is exactly when waiting for a better fill costs
   * most. Every position this desk holds is short, so the stop is reached when
   * the mark *rises* to it. The exchange stop stays on the book as well, since
   * it is the only protection that survives this process dying.
   *
   * The target is deliberately not judged here any more. It used to be -- on
   * the mark, closing at the market -- and on 10 September that cancelled a
   * resting buy at 1.00 and bought 425 back at the 2.00 offer, on two legs:
   * the mark had reached 1.00 while nobody was selling there. Earlier the same
   * day it gave a 32 short's whole profit away the same way.
   *
   * A target is the price you are willing to pay, so it is a resting
   * reduce-only limit and nothing else. It fills when the offer comes down to
   * it, at that price or better, and it never crosses the spread. If the offer
   * never comes down, the position stays on until it expires or you close it
   * -- that is what a target is.
   */
  private async stopIfReached(rec: TradeRecord): Promise<TradeRecord> {
    const stop = rec.plan.stopPrice;
    if (stop === null) return rec;

    const quote = await this.exchange.getQuote(rec.plan.symbol).catch(() => null);
    const mark = quote?.mark ?? null;
    // A missing, stale, or nonsensical mark is not a reason to do anything.
    if (mark === null || !Number.isFinite(mark) || mark <= 0) return rec;
    if (quote !== null && this.now() - quote.ts > MARK_STALE_MS) return rec;
    if (mark < stop) return rec;

    // Closing at the market gives up the spread, and for a stop that is the
    // trade being made: an exit that happens beats a better price that might not.
    await this.closeNowInner(rec.state.tradeId, `stop reached at ${mark}`);
    return this.d.store.get(rec.state.tradeId) ?? rec;
  }

  // ------------------------------------------------------------ exits
  /** Close whatever is left, right now, at the market. Always reduce-only. */
  private async closeNowInner(tradeId: string, reason = 'manual exit'): Promise<TradeState | null> {
    let rec = this.d.store.get(tradeId);
    if (!rec) return null;
    // Size from the exchange, not from memory: someone may have closed part of
    // it by hand while we were not looking.
    rec = await this.syncPosition(rec);
    const size = protectionSize(rec.state);
    if (size === 0) return rec.state;

    await this.cancelSiblings(rec, true);
    const n = rec.events.filter((e) => e.t === 'exit_submitted').length + 1;
    const cid = clientId(tradeId, 'exit', n);
    const product = await this.exchange.getProduct(rec.plan.symbol).catch(() => null);
    rec = this.commit(rec, { t: 'exit_submitted', role: 'manual', clientOrderId: cid, at: this.now() });
    try {
      const ack = await this.exchange.placeOrder({
        clientOrderId: cid, symbol: rec.plan.symbol, productId: product?.productId ?? 0,
        side: 'buy', type: 'market', size, reduceOnly: true, role: 'exit',
      });
      rec = this.absorb(rec, ack, 'exit');
    } catch (e) {
      rec = this.commit(rec, { t: 'protection_failed', reason: `${reason} failed: ${(e as Error).message}`, at: this.now() });
    }
    return rec.state;
  }

  // ------------------------------------------------------- reconciliation
  /** Read the exchange and believe it. */
  private async reconcileInner(tradeId: string): Promise<TradeRecord | null> {
    let rec = this.d.store.get(tradeId);
    if (!rec) return null;

    const entryId = clientId(tradeId, 'entry');
    const entry = await this.exchange.getOrderByClientId(entryId).catch(() => null);
    if (entry) {
      rec = this.absorb(rec, entry, 'entry');
      if (rec.state.phase === 'entry_unknown') {
        rec = this.commit(rec, { t: 'entry_submitted', clientOrderId: entryId, size: entry.size, at: this.now() });
        rec = this.absorb(rec, entry, 'entry');
      }
    }
    rec = await this.syncPosition(rec);
    if (!entry && rec.state.entrySize === 0 && rec.state.phase === 'entry_unknown') {
      // It never landed. Nothing is at risk and nothing was double-sent.
      rec = this.commit(rec, { t: 'aborted', reason: 'entry never reached the exchange', at: this.now() });
    }
    return rec;
  }

  private async syncPosition(recIn: TradeRecord): Promise<TradeRecord> {
    let rec = recIn;
    const positions = await this.exchange.getPositions().catch(() => null);
    if (positions === null) return rec;
    const held = positions.find((p) => p.symbol === rec.plan.symbol)?.size ?? 0;
    if (held !== rec.state.position) {
      rec = this.commit(rec, {
        t: 'reconciled', position: held, at: this.now(),
        note: `exchange says ${held}, we had ${rec.state.position}`,
      });
      // The position moved under us, so anything resting is the wrong size.
      // protect() compares size as well as price, so it replaces them itself.
      if (held !== 0) rec = await this.protect(rec);
      else rec = await this.clearProtection(rec);
    }
    return rec;
  }

  /**
   * Startup. Read balance, positions and open orders, then rebuild every trade
   * that was live when the process died. Nothing is re-sent; the point is to
   * pick the existing orders back up, not to trade again.
   */
  async recover(): Promise<TradeState[]> {
    const out: TradeState[] = [];
    for (const rec of this.d.store.open()) {
      const synced = await this.reconcileInner(rec.state.tradeId);
      if (synced) out.push(synced.state);
    }
    return out;
  }
}

/**
 * The most this trade can lose, in USD.
 *
 * With a stop: the buy-back at the stop, less the credit. Without one: the
 * distance to the exchange's close-out, which is where the position ends
 * whether you like it or not. `null` when neither can be worked out.
 */
export function worstCaseLoss(i: {
  stopPrice: number | null;
  price: number | null;
  size: number;
  credit: number;
  spot: number | null;
  leverage: number;
  contractValue?: number;
}): number {
  // Every term is a quoted price, so every term goes through premiumUsd.
  if (i.stopPrice !== null) {
    return Math.max(0, premiumUsd(i.stopPrice, i.size, i.contractValue) - i.credit);
  }
  if (i.spot === null || i.price === null) return Infinity;
  const room = liquidationRoom({
    spot: i.spot, premium: i.price, leverage: i.leverage, contractValue: i.contractValue,
  });
  return room === null ? Infinity : Math.max(0, premiumUsd(room, i.size, i.contractValue));
}

/**
 * Is anything the plan asked for still not on the book?
 *
 * Asking `!protection.stopLoss` instead was a loop: a trade with a target and
 * no stop can never have a stopLoss, so every poll decided protection was
 * missing, placed a fresh target, and cancelled the one from a second earlier.
 * The question is not "is there a stop" but "is there everything that was
 * asked for".
 */
/**
 * Is this client order id one this trade could have issued?
 *
 * Every id this desk sends is `clientId(tradeId, role, n)`, which begins with
 * the trade's own seed, so the question is answerable without asking anybody.
 */
export const ownsClientId = (tradeId: string, clientOrderId: string | null): boolean =>
  clientOrderId !== null && clientOrderId.startsWith(seedOf(tradeId));

const seedOf = (tradeId: string) => tradeId.replace(/[^A-Za-z0-9]/g, '').slice(-18);

/**
 * Does this trade still need protection put on?
 *
 * It is not enough that *an* id is recorded: it has to be one of **this
 * trade's** ids. On 10 September 2026 a CE recorded `009261788977273296T0` as
 * its take-profit, and that seed belongs to the PE trade beside it -- Delta had
 * ignored the symbol filter, `protect()` was handed the PE's resting order and
 * adopted it. The position was live with nothing behind it, and because an id
 * was present this function said the trade was protected, so nothing ever
 * re-ran and it stayed that way.
 *
 * Checking ownership rather than mere presence makes the desk repair itself:
 * a foreign id reads as missing, the next poll calls `protect()`, and the
 * reconciler places what is actually needed.
 */
export function missingProtection(rec: TradeRecord): boolean {
  const wantsStop = rec.plan.stopPrice !== null;
  const wantsTarget = rec.plan.takeProfitPrice !== null;
  const { tradeId, protection } = rec.state;
  const want = protectionSize(rec.state);

  /*
   * An order that covers less than the position is as good as absent for the
   * part it does not cover.
   *
   * On 10 September 2026 a 425-contract entry filled in pieces. Protection went
   * on after the first 26, and because an id was present and belonged to the
   * trade, this function said "protected" every second afterwards -- so protect()
   * was never called again and 399 contracts ran with no exit on the book.
   *
   * `size` is undefined on records written before it was tracked; those are
   * treated as covering whatever the position was then, which is the reading
   * that makes them re-check rather than be trusted.
   *
   * More than the position is wrong too. When a target buys back part of it,
   * the stop placed for all 425 is left covering the 222 still short, and Delta
   * does not promise to keep a reduce-only order bigger than the position.
   */
  const wrongSize = (protection.size ?? 0) !== want;

  return (
    (wantsStop && (!ownsClientId(tradeId, protection.stopLoss ?? null) || wrongSize)) ||
    (wantsTarget && (!ownsClientId(tradeId, protection.takeProfit ?? null) || wrongSize))
  );
}

/**
 * Does this order pay the spread?
 *
 * A market order always does. A limit only does when it is already marketable:
 * a sell at or below the bid gets taken immediately, a sell above it rests.
 */
export function crossesSpread(
  side: 'buy' | 'sell',
  type: 'limit' | 'market',
  limitPrice: number | null,
  quote: { bid: number | null; ask: number | null } | null,
): boolean {
  if (type === 'market') return true;
  if (limitPrice === null || !quote) return true;   // unknown: assume the worse
  return side === 'sell'
    ? quote.bid !== null && limitPrice <= quote.bid
    : quote.ask !== null && limitPrice >= quote.ask;
}

function avgSeenNotional(state: TradeState, orderId: string): number {
  return state.fills
    .filter((f) => f.orderId === orderId)
    .reduce((n, f) => n + f.size * f.price, 0);
}
