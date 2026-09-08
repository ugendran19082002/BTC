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
};

export type TradePlan = {
  tradeId: string;
  symbol: string;
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
};

export type OpenResult =
  | { ok: true; state: TradeState }
  | { ok: false; state: TradeState; precheck: PrecheckResult };

/** How long to wait before trying protection again after a refusal. */
const PROTECT_RETRY_MS = 2_000;
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

  constructor(private readonly d: EngineDeps) {
    this.limits = d.limits ?? DEFAULT_LIMITS;
  }

  private get exchange() { return this.d.exchange; }
  private now() { return this.d.now(); }
  private feedHealthy() { return this.d.feedHealthy ? this.d.feedHealthy() : true; }
  private dayPnl() { return this.d.dayPnlUsd ? this.d.dayPnlUsd() : 0; }

  private commit(rec: TradeRecord, ...events: TradeEvent[]): TradeRecord {
    let state = rec.state;
    for (const e of events) { state = applyEvent(state, e); rec.events.push(e); }
    const before = rec.state.alarm;
    rec.state = state;
    this.d.store.save(rec);
    if (state.alarm && state.alarm !== before) this.d.onAlarm?.(state, state.alarm);
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
  async poll(tradeId: string): Promise<TradeState | null> {
    const rec0 = this.d.store.get(tradeId);
    if (!rec0 || isDone(rec0.state)) return rec0?.state ?? null;
    let rec = rec0;

    // A submit we never got an answer for is resolved by reading, never writing.
    if (rec.state.phase === 'entry_unknown') return (await this.reconcile(tradeId))?.state ?? null;

    const entryId = clientId(tradeId, 'entry');
    const entry = await this.exchange.getOrderByClientId(entryId).catch(() => null);
    if (entry) rec = this.absorb(rec, entry, 'entry');

    for (const [role, cid] of [
      ['take_profit', rec.state.protection.takeProfit],
      ['stop_loss', rec.state.protection.stopLoss],
    ] as const) {
      if (!cid) continue;
      const o = await this.exchange.getOrderByClientId(cid).catch(() => null);
      if (o) rec = this.absorb(rec, o, role);
    }

    // Entry timed out and is still resting: cancel what is left.
    const deadline = this.entryDeadline.get(tradeId);
    if (entry && (entry.status === 'open' || entry.status === 'partial') && deadline !== undefined && this.now() >= deadline) {
      rec = this.commit(rec, { t: 'entry_timeout', at: this.now() });
      await this.exchange.cancelOrder(entry).catch(() => {});
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
  async protect(recIn: TradeRecord): Promise<TradeRecord> {
    let rec = recIn;
    const size = protectionSize(rec.state);
    if (size === 0) return rec;
    // Nothing to place, and nothing wrong with that.
    if (rec.plan.takeProfitPrice === null && rec.plan.stopPrice === null) return rec;

    // A refusal is not worth repeating every second. Delta answered
    // `no_position_for_reduce_only` because it had not registered the fill yet,
    // and hammering it does not make it register faster -- it just fills the
    // error log and burns the rate limit.
    const notBefore = this.protectAfter.get(rec.state.tradeId);
    if (notBefore !== undefined && this.now() < notBefore) return rec;

    // Reduce-only orders need a position the exchange agrees exists. Our own
    // fill arrives first, so asking before it has settled is what produced that
    // refusal in the first place.
    const held = await this.exchange.getPositions()
      .then((ps) => ps.find((p) => p.symbol === rec.plan.symbol)?.size ?? 0)
      .catch(() => null);
    if (held === null) return rec;
    if (held === 0) {
      // Either the fill has not landed on their side yet, or we are not
      // actually short. Reconcile decides which; do not send anything now.
      this.protectAfter.set(rec.state.tradeId, this.now() + PROTECT_RETRY_MS);
      return rec;
    }
    const product = await this.exchange.getProduct(rec.plan.symbol).catch(() => null);
    const tick = product?.tickSize ?? 0.1;
    // Versioned by every attempt, not just the failures: a resize must not reuse
    // the client id of the order it is replacing, or idempotency hands back the
    // old one at the old size and the position sits behind a stop that is too big.
    const attempt = rec.events.filter((e) => e.t === 'protection_placed' || e.t === 'protection_failed').length;

    let tp: string | null = null;
    let sl: string | null = null;
    try {
      if (rec.plan.takeProfitPrice !== null) {
        const cid = clientId(rec.state.tradeId, 'take_profit', attempt);
        await this.replaceIfResized(rec.state.protection.takeProfit, cid, size);
        await this.exchange.placeOrder({
          clientOrderId: cid, symbol: rec.plan.symbol, productId: product?.productId ?? 0,
          side: 'buy', type: 'limit', size,
          limitPrice: priceFor('buy', rec.plan.takeProfitPrice, tick),
          reduceOnly: true, role: 'take_profit',
        });
        tp = cid;
      }
      if (rec.plan.stopPrice !== null) {
        const cid = clientId(rec.state.tradeId, 'stop_loss', attempt);
        await this.replaceIfResized(rec.state.protection.stopLoss, cid, size);
        await this.exchange.placeOrder({
          clientOrderId: cid, symbol: rec.plan.symbol, productId: product?.productId ?? 0,
          side: 'buy', type: 'stop_market', size,
          stopPrice: stopPriceFor('buy', rec.plan.stopPrice, tick),
          reduceOnly: true, role: 'stop_loss',
        });
        sl = cid;
      }
      this.protectAfter.delete(rec.state.tradeId);
      return this.commit(rec, { t: 'protection_placed', takeProfit: tp, stopLoss: sl, at: this.now() });
    } catch (e) {
      // Back off, doubling, so a venue that keeps saying no is asked less often.
      const tries = rec.events.filter((x) => x.t === 'protection_failed').length;
      this.protectAfter.set(
        rec.state.tradeId,
        this.now() + Math.min(PROTECT_RETRY_MAX_MS, PROTECT_RETRY_MS * 2 ** tries),
      );
      rec = this.commit(rec, { t: 'protection_failed', reason: (e as Error).message, at: this.now() });
      return rec;
    }
  }

  private async replaceIfResized(oldCid: string | null, newCid: string, _size: number) {
    if (!oldCid || oldCid === newCid) return;
    const old = await this.exchange.getOrderByClientId(oldCid).catch(() => null);
    if (old && (old.status === 'open' || old.status === 'partial')) {
      await this.exchange.cancelOrder(old).catch(() => {});
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
        await this.exchange.cancelOrder(o).catch(() => {});
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
  async cancelEntry(tradeId: string): Promise<TradeState | null> {
    let rec = this.d.store.get(tradeId);
    if (!rec) return null;
    if (rec.state.position !== 0) return rec.state;

    const order = await this.exchange.getOrderByClientId(clientId(tradeId, 'entry')).catch(() => null);
    if (order && (order.status === 'open' || order.status === 'partial')) {
      await this.exchange.cancelOrder(order).catch(() => {});
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

  // ------------------------------------------------------------ exits
  /** Close whatever is left, right now, at the market. Always reduce-only. */
  async closeNow(tradeId: string, reason = 'manual exit'): Promise<TradeState | null> {
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
  async reconcile(tradeId: string): Promise<TradeRecord | null> {
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
      // The position moved under us; anything resting is now the wrong size.
      if (held !== 0) rec = await this.protect(rec);
      else rec = await this.cancelSiblings(rec, true);
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
      const synced = await this.reconcile(rec.state.tradeId);
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
export function missingProtection(rec: TradeRecord): boolean {
  const wantsStop = rec.plan.stopPrice !== null;
  const wantsTarget = rec.plan.takeProfitPrice !== null;
  return (
    (wantsStop && !rec.state.protection.stopLoss) ||
    (wantsTarget && !rec.state.protection.takeProfit)
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
