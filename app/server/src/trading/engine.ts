import type {
  AddWorking, ExchangeOrder, OptionSide, OrderRole, PlaceOrderRequest, ProductSpec, Quote, TradeEvent, TradeState,
} from './types.js';
import { CHASE_STEPS, exitPriceProblem, protectionFor, type ExitAsk } from './order-plan.js';
import type { Candle } from '../market/delta.js';
import { applyEvent, initialTrade, isDone, protectionSize } from './machine.js';
import {
  priceFor, lotsToContracts, slippageOf, stopFillLimit, stopPriceFor, targetTickFor, SLIPPAGE_ALERT_PCT,
} from './money.js';
import { DEFAULT_LIMITS, precheck, type Failure, type PrecheckResult, type RiskLimits } from './precheck.js';
import { clampLeverage, fundsRequiredPerContract, liquidationRoom, premiumUsd } from './margin.js';
import { fillChargesUsd } from './charges.js';
import { closeEligibility, closePreview, type ClosePreview } from './close-preview.js';
import { ExchangeUnavailable, OrderGone, OrderRejected, SubmitTimeout, type ExchangePort } from './exchange/port.js';

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

export type TradeOrigin = 'manual' | 'strategy' | 'best-pick';

export type TradeSignal = {
  method: string; n: number; name: string; mode: 'mtf' | 'single'; tf: string; dir: 1 | -1; triggerTime: number;
};

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
  /**
   * The strategy's name as it was when this order was placed.
   *
   * Stamped rather than looked up, so the label still reads correctly after the
   * strategy is renamed or deleted -- the order record should say what actually
   * happened, not what the settings say today. The id is kept beside it because
   * the id is what everything else joins on; it is not a label. Until 27 Sep
   * 2026 the screen showed the id, so an order placed at 15:55 by a strategy
   * called "3.55" was tagged `5-01-copy`, which reads as 5:01.
   *
   * The screens show the strategy's *current* name, looked up by id
   * (trade.routes.ts `withStrategyName`, 2 Oct 2026: a rename has to reach
   * Positions and Orders); this stamp is what they fall back on once the
   * strategy is deleted.
   */
  strategyName?: string;
  /**
   * Who asked for this trade.
   *
   * Absent on everything opened before the field existed, which is read as
   * "manual" where a strategy did not open it -- the same inference the alert
   * footer has always made, now written down once at the moment it is known
   * rather than guessed at every screen that shows it.
   *
   *   manual     the order ticket
   *   strategy   a saved strategy, at its entry time (`strategyId` says which)
   *   best-pick  the best-pick card's auto-trade, when it is armed
   */
  origin?: TradeOrigin;
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
  /**
   * What the desk's own stop watch judges the level on.
   *
   * `ltp` (the default, and what every trade did before this existed) acts the
   * moment the mark reaches the stop. `close` waits for a bar of the option's
   * own chart to close through it: a wick through a level is not a break, and
   * a thin option's mark can print a price nothing traded at.
   *
   * **The stop resting at Delta still triggers on the mark either way.** It is
   * there so the stop works when this process does not, and taking it off to
   * make `close` absolute would trade a slower exit for no exit at all during
   * an outage. So `close` makes the desk's own watch patient; it does not make
   * the venue's. The strategy form says exactly this.
   */
  monitorOn?: 'ltp' | 'close';
  /**
   * Which stage of its strategy's exit timetable this trade's exits are on
   * ("target:stop", e.g. "2:0"), written when a stage is applied. Kept on the
   * trade so a restart carries on from it: until 30 Sep 2026 it was only in
   * memory, and after a restart the stage in force was applied again -- over
   * any leg moved by hand since.
   */
  exitStage?: string;
  /**
   * The lowest premium this trade may be sold at, when the strategy that
   * placed it set its own (`StrategyConfig.minPremiumUsd`). Absent: the desk's
   * floor. Only a strategy sets it; the ticket's route never passes it through.
   */
  minPremiumUsd?: number;
  /**
   * Why the exits could not be anchored to the fill, when they could not.
   *
   * Set only where a fixed target or stop was overtaken by the entry itself.
   * It is on the plan rather than in a log line because the screen has to be
   * able to say it: an unprotected position that looks protected is the worst
   * thing this engine can show.
   */
  exitProblem?: string;
  /**
   * The exits as they were asked for -- a share or a distance -- rather than as
   * prices. When present, `takeProfitPrice` and `stopPrice` are worked out from
   * the ACTUAL average fill each time protection is reconciled (`anchorExits`),
   * not from the limit the order was sent at.
   *
   * An offer that walks to the bid, a Bid-now entry, a market entry: each fills
   * somewhere other than the price the ticket showed, and a stop 55 points over
   * "the entry" means 55 over the entry that happened. A leg absent here is
   * pinned: its price stands as set (a level typed as a price on an open
   * position, or a plan written before this existed).
   */
  exitAsk?: ExitAsk;
  /**
   * Exits on the underlying -- the BTC perpetual -- rather than on the option's
   * own price (2 Oct 2026, signal strategies: the signal's SL and TGT are perp
   * levels, and the option is sold to ride them).
   *
   * `dir` is the signal's: +1 a BUY, traded as a short put, which wins as BTC
   * rises; -1 a SELL, a short call. The desk buys the option back at the market
   * the moment the perp's last trade reaches `stop` (against the signal) or
   * `target` (with it). Written on the plan, so a restart carries on watching.
   * The premium stop resting at Delta stays as the backstop: this watch lives in
   * this process, and a stop must still work when the process does not.
   */
  underlying?: {
    dir: 1 | -1; stop: number | null; target: number | null; source: string;
    /** The perp's price when the trade was entered: the zone fill, or the last trade at the signal. For the labels. */
    entry?: number | null;
    /**
     * Set by the screens' read (trade.routes.ts `withPerpEntries`), never stored: `entry` is the perp's average
     * traded price over the minute the option filled, for a trade placed before the exact price was kept.
     */
    entryApprox?: boolean;
  };
  /**
   * The signal a signal strategy traded: which method, which way of reading,
   * which timeframe, which direction, and its candle (epoch seconds). For the
   * labels on Positions and Orders and the Telegram alerts.
   */
  signal?: TradeSignal;
  expect: { underlying: string; optionSide: OptionSide; strike: number; expiryTs: number };
};

export type TradeRecord = { state: TradeState; plan: TradePlan; events: TradeEvent[] };

/** Whether an ask carries a stop at all. */
const asksStop = (a: ExitAsk | undefined) => !!a && ((a.stopLossPct ?? 0) > 0 || (a.stopLossPoints ?? 0) > 0);

/**
 * The exits re-read off the actual average fill. Pure: the same record back
 * when nothing moves, so a caller can tell "unchanged" by identity.
 */
export function anchorExits(rec: TradeRecord): TradeRecord {
  const ask = rec.plan.exitAsk;
  const avg = rec.state.entryAvgPrice;
  if (!ask || avg === null || !(avg > 0)) return rec;

  /*
   * A fixed price that the fill has overtaken is not a stop.
   *
   * `stopAt: 70` means seventy whatever the entry -- which is what a strategy
   * wants right up until the entry fills at seventy-five. Then the "stop" sits
   * *under* the position: `stopIfReached` sees the mark already past it and
   * closes at the market within a second of entering, and the day's record
   * shows a trade that opened and shut for a loss with nobody able to say why.
   * The same in reverse for a fixed target the fill has already passed.
   *
   * The engine refuses to anchor to a broken price rather than acting on it.
   * `protect()` then reports `no stop`, loudly, which is the true state: this
   * position is not protected and a person has to decide, because every
   * automatic answer here -- move the stop, close the trade, ignore it --
   * spends the operator's money on a guess about what they meant.
   */
  const broken = exitPriceProblem(avg, ask);
  if (broken !== null) {
    return {
      ...rec,
      plan: {
        ...rec.plan,
        // Keep whichever leg is still valid; drop the one the fill overtook.
        takeProfitPrice: (ask.takeProfitAt ?? 0) > 0 && !(ask.takeProfitAt! < avg)
          ? null : rec.plan.takeProfitPrice,
        stopPrice: (ask.stopAt ?? 0) > 0 && !(ask.stopAt! > avg) ? null : rec.plan.stopPrice,
        exitProblem: broken,
      },
      /*
       * `wantsProtection` stays as it was. The strategy did ask for a stop and
       * there is none on -- that is exactly the state the alarm exists for.
       * Turning it off here would leave an unprotected position looking like
       * a trade that chose to run without one.
       */
      state: rec.state,
    };
  }

  const p = protectionFor(avg, ask);
  const tp = p.takeProfitPrice === undefined ? rec.plan.takeProfitPrice : p.takeProfitPrice;
  const sl = p.stopPrice === undefined ? rec.plan.stopPrice : p.stopPrice;
  if (tp === rec.plan.takeProfitPrice && sl === rec.plan.stopPrice) return rec;
  return {
    ...rec,
    plan: { ...rec.plan, takeProfitPrice: tp, stopPrice: sl },
    state: { ...rec.state, wantsProtection: sl !== null },
  };
}

/**
 * The journal, as the engine sees it.
 *
 * Every call is awaited, `save` above all: the engine sends protection only
 * once the fill that needs it is on disk, and a fire-and-forget write would
 * let the two cross. The database is PostgreSQL in the desk and a Map in the
 * matrix; the engine cannot tell, which is the point.
 */
export interface TradeStore {
  save(rec: TradeRecord): Promise<void>;
  get(tradeId: string): Promise<TradeRecord | null>;
  all(): Promise<TradeRecord[]>;
  open(): Promise<TradeRecord[]>;
}

export class MemoryTradeStore implements TradeStore {
  private byId = new Map<string, TradeRecord>();
  async save(rec: TradeRecord) { this.byId.set(rec.state.tradeId, rec); }
  async get(id: string) { return this.peek(id); }
  async all() { return this.rows(); }
  async open() { return this.rows().filter((r) => !isDone(r.state)); }
  /** For tests: the same answers, without the await. */
  peek(id: string): TradeRecord | null { return this.byId.get(id) ?? null; }
  rows(): TradeRecord[] { return [...this.byId.values()]; }
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
  dayPnlUsd?: () => number | Promise<number>;
  /** BTC spot, for the margin and liquidation model. */
  spot?: () => number | null;
  /**
   * Something the desk should be told about out loud.
   *
   * The plan travels with it because the handler has to name the contract, and
   * looking it up again from the store would be a second read of a record the
   * caller is already holding.
   */
  onAlarm?: (trade: TradeState, message: string, plan: TradePlan) => void;
  /**
   * Every journal event as it is written, with the trade either side of it.
   *
   * For telling a person what happened -- a phone alert when something fills.
   * Called only from `commit`, never from replay, so a restart that rebuilds
   * the trades from the journal does not announce yesterday's fills again.
   */
  onEvent?: (event: TradeEvent, before: TradeState, after: TradeState, plan: TradePlan) => void | Promise<void>;
  /** A failure the engine carried on past. Best-effort, but not silent. */
  onSwallowed?: (what: string, order: { orderId: string; symbol?: string }, error: Error) => void;
  /**
   * The option's own candles, for a stop watched on the close.
   *
   * Injected rather than imported so a test can hand the engine a series
   * without a network, and so an engine built without it simply cannot use
   * close-watching -- which is safer than one that silently falls back to the
   * touch and tells nobody.
   */
  candles?: (symbol: string, startSec: number, endSec: number, resolution: string) => Promise<Candle[]>;
  /**
   * The BTC perpetual's last trade, for exits on the underlying (`plan.underlying`).
   * Injected for the same reason as `candles`: an engine without it cannot act on
   * an underlying level, which is safer than one that guesses one.
   */
  underlying?: () => { price: number; at: number } | null;
};

export type OpenResult =
  | { ok: true; state: TradeState }
  | { ok: false; state: TradeState; precheck: PrecheckResult };

/** More of the same contract, sold under an open trade. */
export type AddRequest = {
  /** Contracts. */
  size: number;
  /** Where the sell starts: the offer, usually. Never below `floorPrice`. */
  limitPrice: number;
  /** Walk toward the bid over this many seconds, like an entry. Zero rests. */
  chaseSeconds: number;
  /** Sell into the bid only while the spread is at most this; wider, it waits at the mid. */
  maxCrossSpreadPct: number | null;
  /** Never sold below this. */
  floorPrice: number;
  /** Whatever has not filled after this long is cancelled. */
  timeoutMs: number;
  source: AddWorking['source'];
};

export type AddResult =
  | { ok: true; state: TradeState }
  | { ok: false; reason: string; precheck?: PrecheckResult };

/** What an add would do. `ok: false` with no failures is an ineligible trade, not a gate. */
export type AddPreview = {
  ok: boolean;
  reason: string | null;
  failures: Failure[];
  quote?: Quote | null;
  size?: number;
  newSize?: number;
  newAvgPrice?: number;
  creditUsd?: number;
  entryChargesUsd?: number;
  marginUsd?: number | null;
};

/**
 * Whether this trade can take an add at all, in words, or null when it can.
 *
 * One place, read by the preview and by the add itself, so the sheet can never
 * offer what the engine then refuses on a check the sheet did not know about.
 */
export function addEligibility(s: TradeState, size: number): string | null {
  if (s.adding) return 'an add is already working on this position';
  if (s.position >= 0) return 'nothing short to add to';
  if (s.phase !== 'protected' && s.phase !== 'position_open' && s.phase !== 'unprotected') {
    return `the position is ${s.phase.replace('_', ' ')}`;
  }
  if (!(size > 0) || !Number.isInteger(size)) return 'size must be a whole number above zero';
  return null;
}

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

/**
 * How long the offer has to stay at or through the stop before the desk
 * closes. A short is bought back at the offer, so the offer is the price that
 * says the stop is really reached; fifteen seconds of it is a market that has
 * moved, not one stray quote.
 */
export const STOP_CONFIRM_MS = 15_000;

/**
 * How long a shared contract's position may fail to add up before the desk
 * says so. A sibling trade absorbs its own fill on its own poll, a second or
 * two later; a minute of it is not that.
 */
export const UNEXPLAINED_ALARM_MS = 60_000;

/**
 * How long an exit the venue would not confirm cancelled may go on being
 * retried before the desk says so. A lookup that failed once is a blip; a
 * minute of them is an order that may still be resting with nothing to cover.
 */
export const LEFTOVER_ALARM_MS = 60_000;

/** How long a close at the market has to fill before what is left is sent again. */
export const CLOSE_FOLLOW_UP_MS = 3_000;
/** Closes at the market for one exit, the first included, before the desk stops and says so. */
export const MAX_CLOSE_TRIES = 3;

/**
 * The stop resting at Delta is a backstop, not the stop (29 Sep 2026).
 *
 * Delta can only trigger a resting stop on the mark, the last trade or the
 * spot -- and on thin near-expiry options the mark runs far above anything
 * tradeable: on 26 September C-84400 marked 13.8 against a 4.4 / 5.2 book, its
 * 16.0 stop fired a minute after the entry and bought back at 7.9, and the
 * option then expired at 0.1; on 28 September C-83200's 44.2 stop filled at
 * 24.8. So the stop the trader set is judged by the desk, on the offer
 * (`stopIfReached`), and the order at the exchange sits further out -- the
 * stop plus its distance from the entry, at least a quarter of the stop again
 * -- where only a real run or this process being down will reach it.
 */
export function backstopFor(stop: number, entry: number | null): number {
  const gap = Math.max(entry === null || !(entry > 0) ? 0 : Math.abs(stop - entry), stop * 0.25);
  return stop + gap;
}
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
  `${clientStem(tradeId)}${ROLE_CODE[role]}${n}`;

/** The part of every client id that names the trade. */
export const clientStem = (tradeId: string): string => tradeId.replace(/[^A-Za-z0-9]/g, '').slice(-18);

/** Which of ours an exchange order is, read back off its client id -- or null if it is not ours. */
export function roleOfClientId(clientOrderId: string | null, stem: string): OrderRole | null {
  if (!clientOrderId || !stem || !clientOrderId.startsWith(stem)) return null;
  const code = clientOrderId.charAt(stem.length);
  const role = (Object.keys(ROLE_CODE) as (OrderRole | 'exit')[]).find((r) => ROLE_CODE[r] === code);
  // The rest must be the counter: a stem that happens to prefix another
  // trade's id would carry that trade's stem characters here, not digits.
  return role && /^\d+$/.test(clientOrderId.slice(stem.length + 1)) ? role : null;
}

export class TradeEngine {
  /** When each trade's offer was first seen at or through its stop, for the confirmation. In memory: a restart starts the count again. */
  private readonly stopSince = new Map<string, number>();
  /** Trades whose close has been given up on at the market, so that is said once. */
  private readonly gaveUpClosing = new Set<string>();
  /** When a shared contract's position first stopped adding up, per trade, and whether it has been said. */
  private readonly unexplained = new Map<string, { since: number; said: boolean }>();
  /** Trades with an exit not yet confirmed off the book, since when, and whether it has been said. See `cancelSiblings`. */
  private readonly leftovers = new Map<string, { since: number; said: boolean }>();
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
  private async dayPnl() { return this.d.dayPnlUsd ? await this.d.dayPnlUsd() : 0; }

  private async commit(rec: TradeRecord, ...events: TradeEvent[]): Promise<TradeRecord> {
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
    await this.d.store.save(rec);
    if (state.alarm && state.alarm !== before) this.d.onAlarm?.(state, state.alarm, rec.plan);
    // Only after the save. The journal is the record; nothing that merely
    // reports on it may stand between an event and the disk, and a listener
    // that throws is its own bug -- it does not get to become the trade's.
    if (this.d.onEvent) {
      for (const [e, prev, next] of steps) {
        const failed = (err: unknown) =>
          this.note('event listener', { orderId: rec.state.tradeId, symbol: rec.state.symbol }, err);
        try {
          // Not awaited: a listener that reads the book or the network runs
          // beside the trade, never in front of its next step.
          const r = this.d.onEvent(e, prev, next, rec.plan);
          if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(failed);
        } catch (err) {
          failed(err);
        }
      }
    }
    return rec;
  }

  // ------------------------------------------------------------ prechecks
  async runPrecheck(
    plan: TradePlan,
    product: ProductSpec | null,
    /** An add: holding the contract already is the point, and it has its own premium floor. */
    add?: { addingToOwn: true; minPremiumUsd: number },
  ): Promise<PrecheckResult> {
    const [quote, balance, positions, spot] = await Promise.all([
      this.exchange.getQuote(plan.symbol).catch(() => null),
      this.exchange.getBalanceUsd().catch(() => 0),
      this.exchange.getPositions().catch(() => []),
      this.d.spot ? Promise.resolve(this.d.spot()) : Promise.resolve(null),
    ]);
    const size = product ? lotsToContracts(plan.lots, product.lotSize) : plan.lots;
    const held = positions.find((p) => p.symbol === plan.symbol)?.size ?? 0;
    /*
     * "Already holding" is about who is asking (0011). A strategy is refused
     * only when it already holds this contract itself -- another strategy's
     * trade on the same strike is not its position. A manual ticket keeps the
     * desk-wide rule: anything held on the contract.
     *
     * A signal strategy's trade is one signal's (2 Oct 2026, owner: "different signals, the same strike --
     * allow it"): its own perp SL and TGT, its own option exits, its own P&L. Two signals choosing the same
     * strike are two trades, not a doubled position by mistake; what bounds them is the strategy's "at most
     * N open" (runner.ts), each signal taken once (its claim), and the margin and loss gates below. A clock
     * strategy keeps the rule: it enters once a day, and a second trade on its strike would be a fault.
     */
    const alreadyHeld = plan.signal ? 0 : plan.origin === 'strategy' && plan.strategyId
      ? (await this.d.store.open())
        .filter((t) => t.plan.symbol === plan.symbol && t.plan.strategyId === plan.strategyId && t.state.tradeId !== plan.tradeId)
        .reduce((n, t) => n + t.state.position, 0)
      : held;
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
        leverage: clampLeverage(plan.leverage), stopPrice: plan.stopPrice, takeProfitPrice: plan.takeProfitPrice,
        crossing: crossesSpread('sell', plan.entry.type, plan.entry.limitPrice ?? null, quote),
        stopOnOffer: plan.monitorOn !== 'close',
      },
      spot,
      product,
      quote,
      feedHealthy: this.feedHealthy(),
      tradingEnabled: this.d.tradingEnabled !== false,
      account: { availableUsd: balance },
      existingPosition: add ? 0 : alreadyHeld,
      totalShortContracts: totalShort,
      dayPnlUsd: await this.dayPnl(),
      worstCaseLossUsd: worstCase,
      limits: add
        ? { ...this.limits, minPremiumUsd: add.minPremiumUsd }
        : plan.minPremiumUsd !== undefined ? { ...this.limits, minPremiumUsd: plan.minPremiumUsd } : this.limits,
    });
  }

  // ----------------------------------------------------------------- open
  /**
   * Would this order go? The same gate `open` runs, and nothing is sent.
   *
   * For the caller that has two legs and a rule about the second one depending
   * on the first: asking afterwards means the first order is already on the
   * book. Not a promise -- the price can move between the question and the
   * order -- but the answer is the gate's own, not a second copy of it.
   */
  async previewOpen(plan: TradePlan): Promise<PrecheckResult> {
    const product = await this.exchange.getProduct(plan.symbol).catch(() => null);
    return this.runPrecheck(plan, product);
  }

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
        // A stop asked for off the fill has no price until the fill, and is still wanted.
        wantsProtection: plan.stopPrice !== null || asksStop(plan.exitAsk),
        contractValue: product?.contractValue,
      }),
    };

    // A trade id is used once. Re-running the same signal is not a second trade.
    const prior = await this.d.store.get(plan.tradeId);
    if (prior) return { ok: true, state: prior.state };
    await this.d.store.save(rec);

    const gate = await this.runPrecheck(plan, product);
    if (!gate.ok) {
      const why = gate.failures.map((x) => x.message).join(' ');
      rec = await this.commit(rec, { t: 'precheck_failed', reason: why, at: this.now() });
      return { ok: false, state: rec.state, precheck: gate };
    }

    // Leverage is a product setting on Delta, so it has to be right before the
    // order lands rather than travelling with it. If it cannot be set the trade
    // does not go: the alternative is filling at whatever was left from last time.
    if (product) {
      try {
        await this.exchange.setLeverage(product.productId, clampLeverage(plan.leverage));
      } catch (e) {
        rec = await this.commit(rec, {
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
      rec = await this.commit(rec, { t: 'entry_submitted', clientOrderId: req.clientOrderId, size, at: this.now() });
      // No deadline at all when the order is meant to rest.
      if (plan.entry.timeoutMs > 0) {
        this.entryDeadline.set(plan.tradeId, this.now() + plan.entry.timeoutMs);
      }
      rec = await this.absorb(rec, ack, 'entry');
      return { ok: true, state: rec.state };
    } catch (e) {
      if (e instanceof SubmitTimeout) {
        // We do not know whether it landed. Do not send another one.
        rec = await this.commit(rec, { t: 'entry_submit_unknown', at: this.now() });
        return { ok: true, state: rec.state };
      }
      if (e instanceof OrderRejected) {
        rec = await this.commit(rec, { t: 'entry_rejected', reason: e.reason, at: this.now() });
        return { ok: false, state: rec.state, precheck: { ok: false, failures: [{ code: 'NOT_TRADABLE', message: e.reason }] } };
      }
      if (e instanceof ExchangeUnavailable) {
        rec = await this.commit(rec, { t: 'entry_submit_unknown', at: this.now() });
        return { ok: true, state: rec.state };
      }
      throw e;
    }
  }

  /** Turn an exchange order snapshot into whatever fills we have not seen yet. */
  private async absorb(rec: TradeRecord, order: ExchangeOrder, role: OrderRole): Promise<TradeRecord> {
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
      rec = await this.commit(rec, {
        t: 'fill', role, side: order.side, size: fresh, price,
        orderId: order.orderId, at: this.now(),
        // A trade with exits on the perp: where the perp was as the option filled, to the point.
        ...(rec.plan.underlying ? { perp: this.perpNow() } : {}),
      });
      /*
       * What the exit cost against the price that was asked for.
       *
       * On 24 September 2026 a stop at 70 filled at 79 and nothing on the desk
       * said so: the trade closed, the P&L absorbed it, and the nine points
       * were only found by reading the day's fills by hand. A fill that misses
       * its own trigger by more than a few percent is now said out loud, once,
       * where the alerts go.
       */
      if (role === 'stop_loss' || role === 'take_profit') {
        const wanted = role === 'stop_loss' ? rec.plan.stopPrice : rec.plan.takeProfitPrice;
        const slip = slippageOf(role, wanted ?? null, price);
        if (slip && slip.pct >= SLIPPAGE_ALERT_PCT) {
          this.d.onAlarm?.(
            rec.state,
            `${role === 'stop_loss' ? 'Stop' : 'Target'} asked ${wanted}, filled ${price.toFixed(1)}`
            + ` — ${slip.points > 0 ? '+' : ''}${slip.points} points against it (${slip.pct}%).`,
            rec.plan,
          );
        }
      }
    }
    if (order.status === 'rejected') {
      rec = await this.commit(rec, { t: 'entry_rejected', reason: order.reason ?? 'rejected', at: this.now() });
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

  /**
   * Take a working add off the book by hand, before its window closes.
   *
   * The same path the window's own expiry takes -- cancel, count what it
   * filled, close the add out -- so a person stopping an add and the clock
   * stopping one leave the same record. Whatever has already filled stays: it
   * is part of the position, and an add half-filled is not an add undone.
   */
  cancelAdd(tradeId: string, reason = 'stopped by hand'): Promise<TradeState | null> {
    return this.withTrade(tradeId, async () => {
      const rec = await this.d.store.get(tradeId);
      if (!rec) return null;
      if (!rec.state.adding) return rec.state;
      return (await this.endAdd(rec, reason)).state;
    });
  }

  /** Move the stop or the target on a position that is already on. */
  updateProtection(
    tradeId: string,
    next: { takeProfitPrice?: number | null; stopPrice?: number | null },
    /**
     * The legs to keep following the fill, as asked. A leg given a price here
     * and not in `follow` is pinned to that price from now on.
     */
    follow?: ExitAsk,
    /** The exit-timetable stage this move applies, when a strategy's stepper makes it. */
    exitStage?: string,
  ): Promise<TradeState | null> {
    return this.withTrade(tradeId, () => this.updateProtectionInner(tradeId, next, follow, exitStage));
  }

  /**
   * Buy back at the market, right now: all of it, or the `size` asked for.
   *
   * A size closes part of the position and leaves the rest a position --
   * protection comes off for the close and the next poll puts it back over
   * what is left. Without one, the whole thing goes, which is what every
   * caller inside the desk means (a stop reached, squaring off the book).
   */
  closeNow(tradeId: string, reason = 'manual exit', size?: number): Promise<TradeState | null> {
    return this.withTrade(tradeId, () => this.closeNowInner(tradeId, reason, size));
  }

  /**
   * What closing this many contracts would book, and whether it is allowed.
   *
   * Nothing is sent. The money is worked out where the charge formula lives,
   * so the sheet that offers "close 500 of 1,500" shows the same arithmetic
   * the statement will.
   */
  async previewClose(tradeId: string, size?: number): Promise<ClosePreview | null> {
    const rec = await this.d.store.get(tradeId);
    if (!rec) return null;
    const quote = await this.exchange.getQuote(rec.plan.symbol).catch(() => null);
    return closePreview({
      state: rec.state,
      size,
      quote,
      spot: this.d.spot ? this.d.spot() : null,
    });
  }

  /** Read the exchange and believe it. */
  reconcile(tradeId: string): Promise<TradeRecord | null> {
    return this.withTrade(tradeId, () => this.reconcileInner(tradeId));
  }

  /**
   * What an add would do, and whether the gates would let it -- nothing sent.
   *
   * The same eligibility and the same precheck `addInner` runs, so the sheet
   * that offers "add 100 lots" can only ever show a size the desk will take.
   * Sized in money as well as contracts: the new average, the credit, the
   * charges to open, and the margin the exchange will hold, because a size
   * that reads fine in lots is the one that ties up the account.
   */
  async previewAdd(tradeId: string, req: Pick<AddRequest, 'size' | 'limitPrice' | 'floorPrice'>): Promise<AddPreview> {
    const rec = await this.d.store.get(tradeId);
    if (!rec) return { ok: false, reason: 'no such trade', failures: [] };
    const s = rec.state;
    const why = addEligibility(s, req.size);
    if (why) return { ok: false, reason: why, failures: [] };

    const [product, quote] = await Promise.all([
      this.exchange.getProduct(rec.plan.symbol).catch(() => null),
      this.exchange.getQuote(rec.plan.symbol).catch(() => null),
    ]);
    const gate = await this.runPrecheck(
      { ...rec.plan, lots: req.size, entry: { type: 'limit', limitPrice: req.limitPrice, timeoutMs: 0, marketFallback: false, chase: null } },
      product,
      { addingToOwn: true, minPremiumUsd: Math.min(this.limits.minPremiumUsd, req.floorPrice) },
    );

    const contractValue = product?.contractValue ?? s.contractValue ?? 0.001;
    const held = Math.abs(s.position);
    const avg = s.entryAvgPrice ?? req.limitPrice;
    const newSize = held + req.size;
    const spot = this.d.spot ? this.d.spot() : null;
    const credit = premiumUsd(req.limitPrice, req.size, contractValue);
    const margin = spot !== null
      ? fundsRequiredPerContract({ spot, premium: req.limitPrice, leverage: clampLeverage(rec.plan.leverage), contractValue }) * req.size
      : null;
    return {
      ok: gate.ok,
      reason: gate.ok ? null : gate.failures.map((f) => f.message).join(' '),
      failures: gate.ok ? [] : gate.failures,
      quote,
      size: req.size,
      newSize,
      /** Weighted by contracts, as Delta nets a contract into one position. */
      newAvgPrice: (avg * held + req.limitPrice * req.size) / newSize,
      creditUsd: credit,
      entryChargesUsd: fillChargesUsd({ price: req.limitPrice, contracts: req.size, contractValue, spot }).totalUsd,
      marginUsd: margin,
    };
  }

  /** Sell more of the contract this trade already holds. See `addInner`. */
  addToPosition(tradeId: string, req: AddRequest): Promise<AddResult> {
    return this.withTrade(tradeId, () => this.addInner(tradeId, req));
  }

  private async pollInner(tradeId: string): Promise<TradeState | null> {
    const rec0 = await this.d.store.get(tradeId);
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
      if (o) rec = await this.absorb(rec, o, role);
      /*
       * A protective leg the exchange says is no longer resting.
       *
       * The id stays in the record until something takes it out, and
       * `missingProtection` reads the record -- so a stop Delta accepted and
       * later cancelled (it does not promise to keep a reduce-only order it
       * considers over-committed) left the trade reading "protected" for ever,
       * with nothing behind the position. On 12 September that was 850
       * contracts short with a green shield on the screen.
       *
       * Clearing the id is all this does. The next few lines call `protect()`,
       * which reads the book and puts back whatever is actually missing.
       *
       * Only on a definite answer, and only if nothing filled: the lookup
       * catches to null, which cannot tell "no such order" from "could not
       * ask", and a partly filled order is the reconciler's business.
       */
      if (o && (role === 'take_profit' || role === 'stop_loss')
          && o.status !== 'open' && o.status !== 'partial' && o.filledSize === 0) {
        rec = await this.commit(rec, { t: 'sibling_cancelled', role, at: this.now() });
      }
    }
    const entry = found[0];

    // More of the same contract, working to add to the position.
    if (rec.state.adding) rec = await this.stepAdd(rec);

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
            .catch((e) => (e instanceof OrderGone ? e : (this.note('chase', entry, e), null)));
          if (moved instanceof OrderGone) {
            // Filled or cancelled since the read a moment ago. That is the
            // order doing what it was sent to do, not a fault: read it again
            // now, so the fill is on the record this poll rather than next.
            const gone = await this.exchange.getOrderByClientId(entryId).catch(() => null);
            if (gone) rec = await this.absorb(rec, gone, 'entry');
          } else if (moved) {
            rec = await this.absorb(rec, moved, 'entry');
          }
        }
      }
    }

    // Entry timed out and is still resting: cancel what is left.
    const deadline = this.entryDeadline.get(tradeId);
    if (entry && (entry.status === 'open' || entry.status === 'partial') && deadline !== undefined && this.now() >= deadline) {
      rec = await this.commit(rec, { t: 'entry_timeout', at: this.now() });
      await this.exchange.cancelOrder(entry).catch((e) => this.note('cancel entry', entry, e));
      this.entryDeadline.delete(tradeId);
      const after = await this.exchange.getOrderByClientId(entryId).catch(() => null);
      if (after) rec = await this.absorb(rec, after, 'entry');
      rec = await this.commit(rec, { t: 'entry_cancelled', remaining: entry.size - (after?.filledSize ?? entry.filledSize), at: this.now() });

      if (rec.state.position === 0 && rec.plan.entry.marketFallback) {
        return (await this.marketFallback(tradeId)).state;
      }
    }

    // An exit printed: the other side has to go before it can re-open us.
    if (rec.state.exitWinner) rec = await this.cancelSiblings(rec);

    // A close at the market that bought back only part: follow up the rest.
    if (rec.state.phase === 'exit_pending' && rec.state.position !== 0 && rec.state.closing) {
      rec = await this.followUpClose(rec);
    }

    // Exits asked for off the fill follow the fill: a partial fill at a new
    // price moves the average, and the levels move with it.
    const anchored = anchorExits(rec);
    const moved = anchored !== rec;
    rec = anchored;
    if (rec.state.position !== 0 && rec.state.phase !== 'exit_pending' && (moved || missingProtection(rec))) {
      rec = await this.protect(rec);
      if (moved) await this.d.store.save(rec);
    }

    /*
     * The exits the desk judges itself, in order (owner, 2 Oct 2026: "the perp first, else the option"):
     *
     *   1. the underlying's levels -- a signal trade's SL and TGT on the BTC perp, its real exits;
     *   2. the option's own stop, judged here as well as at the exchange (after protection, so a stop
     *      reached on the very first poll still exits). The option's target is not judged here at all --
     *      it rests at Delta; see `stopIfReached`.
     *
     * Both in one poll only matters when both are reached in the same second; then the perp's reason is
     * the one written, and the option stop finds the position already closing.
     */
    if (rec.state.position !== 0 && rec.state.phase !== 'exit_pending') {
      rec = await this.underlyingExit(rec);
    }
    if (rec.state.position !== 0 && rec.state.phase !== 'exit_pending') {
      rec = await this.stopIfReached(rec);
    }

    if (rec.state.position === 0 && rec.state.entrySize > 0 && rec.state.phase !== 'flat') {
      rec = await this.cancelSiblings(rec, true);
      rec = await this.commit(rec, { t: 'reconciled', position: 0, at: this.now(), note: 'closed' });
      this.stopSince.delete(rec.state.tradeId);
    }

    return rec.state;
  }

  /** Cross the spread, but only after the gates say the market is still sane. */
  private async marketFallback(tradeId: string): Promise<TradeRecord> {
    let rec = (await this.d.store.get(tradeId))!;
    const product = await this.exchange.getProduct(rec.plan.symbol).catch(() => null);
    const gate = await this.runPrecheck(rec.plan, product);
    if (!gate.ok) {
      return await this.commit(rec, {
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
      rec = await this.absorb(rec, ack, 'entry');
      if (rec.state.position !== 0) rec = await this.protect(rec);
    } catch (e) {
      if (e instanceof SubmitTimeout || e instanceof ExchangeUnavailable) {
        rec = await this.commit(rec, { t: 'entry_submit_unknown', at: this.now() });
      } else if (e instanceof OrderRejected) {
        rec = await this.commit(rec, { t: 'entry_rejected', reason: e.message, at: this.now() });
      } else throw e;
    }
    return rec;
  }

  /**
   * The other open trades on this contract.
   *
   * Two strategies may hold the same contract (decision 0011, 30 Sep 2026).
   * Each trade's orders and fills are its own -- its client ids say so -- and
   * Delta's position for the symbol is their sum. Anything that reads the
   * exchange by symbol has to leave a sibling's orders and contracts alone.
   */
  private async siblingsOn(rec: TradeRecord): Promise<TradeRecord[]> {
    return (await this.d.store.open())
      .filter((t) => t.plan.symbol === rec.plan.symbol && t.state.tradeId !== rec.state.tradeId);
  }

  /** An order some other open trade on this contract placed. Never this trade's to move or cancel. */
  private static ownedByAnother(o: ExchangeOrder, siblings: readonly TradeRecord[]): boolean {
    return siblings.some((t) => ownsClientId(t.state.tradeId, o.clientOrderId));
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
    let rec = anchorExits(recIn);
    const size = protectionSize(rec.state);
    if (size === 0) return rec;
    if (rec.plan.takeProfitPrice === null && rec.plan.stopPrice === null) {
      /*
       * A price the fill overtook is not "nothing wanted": it is a stop that
       * cannot be placed. Say so once, loudly, before clearing the book --
       * `wantsProtection` is still true, so the machine raises the alarm and
       * the phone call goes out.
       */
      if (rec.plan.exitProblem && rec.state.wantsProtection
        && !rec.events.some((e) => e.t === 'protection_failed' && e.reason === rec.plan.exitProblem)) {
        rec = await this.commit(rec, {
          t: 'protection_failed', reason: rec.plan.exitProblem, at: this.now(),
        });
      }
      // Nothing placeable. Anything still resting is left over and has to go.
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
    // A sibling trade's exits on the same contract are not this trade's to reconcile (0011).
    // An order nobody owns -- placed by hand, or before client ids -- is still treated as this trade's.
    const siblings = await this.siblingsOn(rec);
    const resting = book.filter((o) => o.reduceOnly && (o.status === 'open' || o.status === 'partial')
      && !TradeEngine.ownedByAnother(o, siblings));

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
      // Both are buy-backs of a short: the stop up through its level, the target
      // up to the tick but never to the entry (`targetTickFor`).
      const target = wanted === null ? null
        : role === 'stop_loss' ? stopPriceFor('buy', wanted, tick) : targetTickFor(wanted, tick, rec.state.entryAvgPrice);

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
          await this.exchange.editOrder(only, {
            [field]: target,
            size,
            // A stop limit's price travels with its trigger; left behind, the
            // two describe different stops.
            ...(field === 'stopPrice' && only.type === 'stop_limit'
              ? { limitPrice: stopFillLimit('buy', target, tick) }
              : {}),
          });
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
     * it works when this process does not -- but at the backstop, not at the
     * stop itself: Delta triggers it on the mark, and the mark spikes on thin
     * options. The stop the trader set is judged here, on the offer, by
     * `stopIfReached`. See `backstopFor`.
     */
    const sl = await settle(
      'stop_loss',
      rec.plan.stopPrice === null ? null : backstopFor(rec.plan.stopPrice, rec.state.entryAvgPrice),
      // Either shape counts as the stop leg: a stop market placed before
      // 12 September is still a stop, and must be recognised to be replaced.
      (o) => o.type === 'stop_market' || o.type === 'stop_limit',
      (o) => o.stopPrice,
      'stopPrice',
      (cid, price) => this.exchange.placeOrder({
        clientOrderId: cid, symbol: rec.plan.symbol, productId: product?.productId ?? 0,
        side: 'buy', type: 'stop_limit', size, stopPrice: price,
        limitPrice: stopFillLimit('buy', price, tick), reduceOnly: true, role: 'stop_loss',
      }).then(() => {}),
    );

    // Size is part of the identity of a protective order, not a detail of it:
    // the same ids covering a different number of contracts is a change.
    if (tp !== rec.state.protection.takeProfit
        || sl !== rec.state.protection.stopLoss
        || rec.state.protection.size !== size) {
      rec = await this.commit(rec, {
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
    return await this.commit(rec, { t: 'protection_failed', reason: failure, at: this.now() });
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
    let after: ExchangeOrder | null;
    try {
      after = await this.exchange.getOrderByClientId(order.clientOrderId);
    } catch {
      // Could not ask is not gone. Until 1 Oct 2026 a failed read counted as a
      // confirmed cancel, which is the one answer this method exists to rule out.
      return false;
    }
    if (after === null) return true;                       // gone from the book
    return after.status !== 'open' && after.status !== 'partial';
  }

  /** Take every protective order off the book, verifying each one. */
  private async clearProtection(recIn: TradeRecord): Promise<TradeRecord> {
    let rec = recIn;
    const book = await this.exchange.getOpenOrders(rec.plan.symbol).catch(() => []);
    const siblings = await this.siblingsOn(rec);
    for (const o of book.filter((x) => x.reduceOnly && !TradeEngine.ownedByAnother(x, siblings))) {
      await this.cancelAndVerify(o);
    }
    if (rec.state.protection.takeProfit || rec.state.protection.stopLoss) {
      rec = await this.commit(rec, {
        t: 'protection_placed', takeProfit: null, stopLoss: null, size: 0, at: this.now(),
      });
    }
    return rec;
  }

  /**
   * One exit won. Take the other one off the book.
   *
   * A leg comes off the record only once the venue confirms it is off the book.
   * Until 1 Oct 2026 it came off whatever happened: a lookup that failed, or a
   * cancel Delta did not honour, still wrote `sibling_cancelled`, and the desk
   * forgot an order that could still be resting -- a reduce-only buy which, with
   * two trades on one contract (0011), buys back the other trade's contracts.
   * A leg that cannot be confirmed stays on the record and is tried again: by
   * the trade's own poll while it is open, by `sweepLeftovers` once it is done,
   * and said out loud after `LEFTOVER_ALARM_MS`.
   */
  private async cancelSiblings(recIn: TradeRecord, all = false): Promise<TradeRecord> {
    let rec = recIn;
    const winner = rec.state.exitWinner;
    const unconfirmed: string[] = [];
    for (const [role, cid] of [
      ['take_profit', rec.state.protection.takeProfit],
      ['stop_loss', rec.state.protection.stopLoss],
    ] as const) {
      if (!cid) continue;
      if (!all && role === winner) continue;
      let o: ExchangeOrder | null;
      try {
        o = await this.exchange.getOrderByClientId(cid);
      } catch (e) {
        this.note('cancel sibling', { orderId: cid, symbol: rec.plan.symbol }, e);
        unconfirmed.push(role === 'take_profit' ? 'target' : 'stop');
        continue;
      }
      if (o && (o.status === 'open' || o.status === 'partial') && !(await this.cancelAndVerify(o))) {
        unconfirmed.push(role === 'take_profit' ? 'target' : 'stop');
        continue;
      }
      rec = await this.commit(rec, { t: 'sibling_cancelled', role, at: this.now() });
    }
    this.noteLeftover(rec, unconfirmed);
    return rec;
  }

  /** Keep count of a trade whose exits could not be confirmed off the book, and say so once it has gone on a minute. */
  private noteLeftover(rec: TradeRecord, unconfirmed: readonly string[]): void {
    const id = rec.state.tradeId;
    if (unconfirmed.length === 0) { this.leftovers.delete(id); return; }
    const seen = this.leftovers.get(id) ?? { since: this.now(), said: false };
    this.leftovers.set(id, seen);
    if (seen.said || this.now() - seen.since < LEFTOVER_ALARM_MS) return;
    seen.said = true;
    this.d.onAlarm?.(rec.state, `Could not confirm the ${unconfirmed.join(' and ')} cancelled at Delta for `
      + `${Math.round((this.now() - seen.since) / 1000)} s. It may still be resting reduce-only on ${rec.plan.symbol}: `
      + 'check the open orders and cancel it by hand.', rec.plan);
  }

  /**
   * Try again to take off the book the exits of finished trades that could not
   * be confirmed cancelled.
   *
   * A trade that is flat is never polled again, so its own poll cannot retry;
   * the service calls this on every step. Open trades are left to their own
   * poll, which retries the same way. In memory: a restart forgets the list.
   *
   * Returns the trades still waiting on a confirmation.
   */
  async sweepLeftovers(): Promise<string[]> {
    for (const id of [...this.leftovers.keys()]) {
      await this.withTrade(id, async () => {
        const rec = await this.d.store.get(id);
        if (!rec) { this.leftovers.delete(id); return; }
        if (!isDone(rec.state)) return;
        await this.cancelSiblings(rec, true);
      });
    }
    return [...this.leftovers.keys()];
  }

  /**
   * Take a working entry off the book and end the trade.
   *
   * Only ever the entry, and only while nothing has filled: once there are
   * contracts, the way out is `closeNow`, which buys them back.
   */
  private async cancelEntryInner(tradeId: string): Promise<TradeState | null> {
    let rec = await this.d.store.get(tradeId);
    if (!rec) return null;
    if (rec.state.position !== 0) return rec.state;

    const order = await this.exchange.getOrderByClientId(clientId(tradeId, 'entry')).catch(() => null);
    if (order && (order.status === 'open' || order.status === 'partial')) {
      await this.exchange.cancelOrder(order).catch((e) => this.note('cancel entry', order, e));
      const after = await this.exchange.getOrderByClientId(clientId(tradeId, 'entry')).catch(() => null);
      if (after) rec = await this.absorb(rec, after, 'entry');
    }
    this.entryDeadline.delete(tradeId);
    rec = await this.commit(rec, {
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
    follow?: ExitAsk,
    exitStage?: string,
  ): Promise<TradeState | null> {
    let rec = await this.d.store.get(tradeId);
    if (!rec) return null;
    if (rec.state.position === 0) return rec.state;

    // A leg that is set here stops following its old ask; it follows the new
    // one if `follow` carries one, and is pinned to its price if not.
    const ask: ExitAsk = { ...rec.plan.exitAsk };
    if (next.takeProfitPrice !== undefined) { delete ask.takeProfitPct; delete ask.takeProfitPoints; delete ask.takeProfitAt; }
    if (next.stopPrice !== undefined) { delete ask.stopLossPct; delete ask.stopLossPoints; delete ask.stopAt; }
    Object.assign(ask, follow ?? {});
    rec.plan = {
      ...rec.plan,
      takeProfitPrice: next.takeProfitPrice !== undefined ? next.takeProfitPrice : rec.plan.takeProfitPrice,
      stopPrice: next.stopPrice !== undefined ? next.stopPrice : rec.plan.stopPrice,
      exitAsk: Object.keys(ask).length ? ask : undefined,
      ...(exitStage !== undefined ? { exitStage } : {}),
    };
    rec.state = { ...rec.state, wantsProtection: rec.plan.stopPrice !== null };

    // An explicit change is not a retry, so the backoff does not apply to it.
    this.protectAfter.delete(tradeId);
    // protect() reconciles the book against the plan, so changing the plan and
    // asking it to run is the whole operation: it cancels what no longer
    // belongs, verifies that the cancel took, and places what is missing.
    rec = await this.protect(rec);
    await this.d.store.save(rec);
    return rec.state;
  }

  /**
   * The desk's own eye on the stop.
   *
   * Judged on the **offer**, held for `STOP_CONFIRM_MS`, and closed at the
   * market. Every position this desk holds is short, so it is bought back at
   * the offer: the stop is reached when the offer has been at or above it for
   * fifteen seconds running. Until 29 September it was judged on the mark, and
   * the mark on a thin near-expiry option prints prices nothing trades at --
   * two winning shorts were stopped out on it (see `backstopFor`). An offer
   * back under the stop starts the count again; a missing or stale quote
   * neither fires nor resets it. The backstop at the exchange stays on the book
   * as well, since it is the only protection that survives this process dying.
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

    /*
     * On the close, where the strategy asked for it.
     *
     * A wick through a level is not a break, and an option's mark can print a
     * price nothing traded at -- so a stop watched on the touch exits on noise
     * a close would have ridden out. The bar has to be a *closed* one: judging
     * the bar being formed is watching the touch with extra steps.
     */
    if (rec.plan.monitorOn === 'close') {
      const bar = await this.lastClosedBar(rec.plan.symbol);
      if (bar === null || bar.close < stop) return rec;
      await this.closeNowInner(rec.state.tradeId, `stop: a bar closed at ${bar.close} through ${stop}`);
      return await this.d.store.get(rec.state.tradeId) ?? rec;
    }

    const id = rec.state.tradeId;
    const quote = await this.exchange.getQuote(rec.plan.symbol).catch(() => null);
    const ask = quote?.ask ?? null;
    // A missing, stale, or nonsensical offer is not a reason to do anything -- nor to forget the count.
    if (quote === null || this.now() - quote.ts > MARK_STALE_MS) return rec;
    if (ask === null || !Number.isFinite(ask) || ask <= 0) return rec;
    if (ask < stop) { this.stopSince.delete(id); return rec; }
    const since = this.stopSince.get(id) ?? this.now();
    this.stopSince.set(id, since);
    if (this.now() - since < STOP_CONFIRM_MS) return rec;
    this.stopSince.delete(id);

    // Closing at the market gives up the spread, and for a stop that is the
    // trade being made: an exit that happens beats a better price that might not.
    await this.closeNowInner(id, `stop reached: the offer held at ${ask} (stop ${stop}) for ${Math.round((this.now() - since) / 1000)} s`);
    return await this.d.store.get(id) ?? rec;
  }

  /**
   * The underlying's own exit (`plan.underlying`): the perp's last trade at the
   * signal's stop or target, and the option is bought back at the market.
   *
   * On the touch, not held: the perpetual is the most liquid price there is, the
   * signal's stop already sits a quarter-ATR past its structure, and the paper
   * log that measured these signals exits on the first trade through. A missing
   * or stale price (over MARK_STALE_MS) does nothing -- the premium backstop at
   * Delta is still there underneath.
   */
  /** The perp's last trade, when fresh (as `underlyingExit` reads it); null when stale or absent. */
  private perpNow(): number | null {
    const px = this.d.underlying?.() ?? null;
    return px !== null && px.price > 0 && this.now() - px.at <= MARK_STALE_MS ? px.price : null;
  }

  private async underlyingExit(rec: TradeRecord): Promise<TradeRecord> {
    const u = rec.plan.underlying;
    if (!u || (u.stop === null && u.target === null)) return rec;
    const px = this.d.underlying?.() ?? null;
    if (px === null || !(px.price > 0) || this.now() - px.at > MARK_STALE_MS) return rec;
    const hitStop = u.stop !== null && (px.price - u.stop) * u.dir <= 0;
    const hitTarget = !hitStop && u.target !== null && (px.price - u.target) * u.dir >= 0;
    if (!hitStop && !hitTarget) return rec;
    // Two decimals, grouped: the reason is read in the alert and on the screens, not parsed for maths.
    const p2 = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const why = hitStop
      ? `${u.source} at ${p2(px.price)} reached the signal's stop ${p2(u.stop!)}`
      : `${u.source} at ${p2(px.price)} reached the signal's target ${p2(u.target!)}`;
    await this.closeNowInner(rec.state.tradeId, why);
    return await this.d.store.get(rec.state.tradeId) ?? rec;
  }

  /**
   * The last *finished* minute of this option's own chart.
   *
   * Null when the feed has nothing, which is read as "no reason to act": a
   * stop that fires because a candle request failed is a stop that fires at
   * random. The desk falls back to nothing, not to the mark -- the operator
   * asked for the close, and the resting stop at the exchange is still there
   * on the mark underneath.
   */
  private async lastClosedBar(symbol: string): Promise<Candle | null> {
    const now = Math.floor(this.now() / 1000);
    const bars = await this.d.candles?.(symbol, now - 15 * 60, now, '1m').catch(() => []) ?? [];
    /*
     * Finished by its time, not by its place in the list: a bar is finished once
     * its minute is over, and the one that started this minute is still forming.
     * Until 1 Oct 2026 this took the second-to-last bar, on the assumption that
     * the last is always the forming one -- but a thin option with no trade yet
     * this minute may have no forming bar, and then the bar that had just
     * finished was skipped and the one before it judged instead.
     */
    const minute = now - (now % 60);
    let closed: Candle | null = null;
    for (const b of bars) if (b.time < minute && (closed === null || b.time > closed.time)) closed = b;
    return closed;
  }

  // ------------------------------------------------------------ exits
  /**
   * Close at the market, reduce-only. All of it, or `want` contracts of it.
   *
   * Both legs of protection come off first either way. For a close of part of
   * the position that looks wasteful -- the stop could have been left and
   * resized -- but a resting stop for 1,500 plus a reduce-only buy for 500 is
   * two orders racing to close one position, and the exchange will happily
   * fill both. Off, close, and the next poll puts a target and a stop back
   * over what is left; that path is the one the desk already trusts after
   * every add.
   */
  private async closeNowInner(tradeId: string, reason = 'manual exit', want?: number): Promise<TradeState | null> {
    let rec = await this.d.store.get(tradeId);
    if (!rec) return null;
    // Size from the exchange, not from memory: someone may have closed part of
    // it by hand while we were not looking.
    // An add still working would sell again after the close and re-open the
    // position. It comes off first, and what it filled is counted before the
    // size of the close is read.
    if (rec.state.adding) rec = await this.endAdd(rec, 'closing the position');
    rec = await this.syncPosition(rec);
    const held = protectionSize(rec.state);
    if (held === 0) return rec.state;

    // A size is checked against what is held *now*, not against what was held
    // when the sheet was opened. More than that closes everything rather than
    // being refused: asking to close 1,500 of a position that is now 1,400
    // means "all of it" by any reading.
    const size = want === undefined ? held : Math.min(Math.trunc(want), held);
    if (size < 1) {
      return (await this.commit(rec, {
        t: 'protection_failed',
        reason: `${reason} refused: ${closeEligibility(rec.state, Math.trunc(want ?? 0), held) ?? 'nothing to close'}`,
        at: this.now(),
      })).state;
    }
    const all = size >= held;

    await this.cancelSiblings(rec, true);
    const n = rec.events.filter((e) => e.t === 'exit_submitted').length + 1;
    const cid = clientId(tradeId, 'exit', n);
    const product = await this.exchange.getProduct(rec.plan.symbol).catch(() => null);
    rec = await this.commit(rec, {
      t: 'exit_submitted',
      role: 'manual',
      clientOrderId: cid,
      closing: { clientOrderId: cid, size, heldBefore: held, all, submittedAt: this.now() },
      reason,
      at: this.now(),
    });
    try {
      const ack = await this.exchange.placeOrder({
        clientOrderId: cid, symbol: rec.plan.symbol, productId: product?.productId ?? 0,
        side: 'buy', type: 'market', size, reduceOnly: true, role: 'exit',
      });
      rec = await this.absorb(rec, ack, 'exit');
    } catch (e) {
      rec = await this.commit(rec, { t: 'protection_failed', reason: `${reason} failed: ${(e as Error).message}`, at: this.now() });
    }
    return rec.state;
  }

  /**
   * The rest of a close that filled in part.
   *
   * A market buy on a thin book can take what is offered and no more. Until
   * 30 Sep 2026 what was left then sat in `exit_pending` -- where the desk
   * neither re-protects nor watches the stop -- short, with nothing behind it,
   * until somebody noticed. Now, once the close has had `CLOSE_FOLLOW_UP_MS`,
   * whatever of it is still resting is cancelled (verified), and the rest is
   * sent again at the market: all of what is held for a close of everything,
   * the rest of the size asked for otherwise. Whether Delta cancels the unfilled
   * part of a market order or leaves it resting is the venue's business
   * (decision 0002), so both are handled. After `MAX_CLOSE_TRIES` it stops
   * trying and says so, rather than buying into an empty book every second.
   */
  private async followUpClose(recIn: TradeRecord): Promise<TradeRecord> {
    let rec = recIn;
    const closing = rec.state.closing!;
    if (this.now() - closing.submittedAt < CLOSE_FOLLOW_UP_MS) return rec;
    let order: ExchangeOrder | null;
    try {
      order = await this.exchange.getOrderByClientId(closing.clientOrderId);
    } catch {
      return rec;                                        // unknown is not gone: ask again next poll
    }
    if (order) rec = await this.absorb(rec, order, 'exit');
    if (rec.state.position === 0 || rec.state.phase !== 'exit_pending') return rec;
    if (order && (order.status === 'open' || order.status === 'partial')) {
      if (!(await this.cancelAndVerify(order))) return rec;
      const after = await this.exchange.getOrderByClientId(closing.clientOrderId).catch(() => null);
      if (after) rec = await this.absorb(rec, after, 'exit');
      if (rec.state.position === 0 || rec.state.phase !== 'exit_pending') return rec;
    }
    const tries = rec.events.filter((e) => e.t === 'exit_submitted').length;
    const held = Math.abs(rec.state.position);
    if (tries >= MAX_CLOSE_TRIES) {
      if (!this.gaveUpClosing.has(rec.state.tradeId)) {
        this.gaveUpClosing.add(rec.state.tradeId);
        this.d.onAlarm?.(rec.state, `Close left ${held} contracts short after ${tries} tries at the market. `
          + 'Nothing more is sent -- close the rest by hand.', rec.plan);
      }
      return rec;
    }
    const owed = closing.all ? undefined : closing.size - (closing.heldBefore - held);
    if (owed !== undefined && owed < 1) return rec;
    await this.closeNowInner(rec.state.tradeId, 'the rest of a close that filled in part', owed);
    return (await this.d.store.get(rec.state.tradeId)) ?? rec;
  }

  // ------------------------------------------------------------- adds
  /**
   * Sell more of the contract this trade already holds.
   *
   * Under the same trade, not as a second one: an add is more of the same
   * decision, so it keeps one position, one average price, one target and one
   * stop, and `protect()` resizes the last two to the new size. (Two *different*
   * strategies on one contract are two trades -- decision 0011.)
   *
   * Refused while the trade is not simply open: still entering, closing, flat,
   * or already adding. It passes the same gates as any entry -- quote, spread
   * when it crosses, depth, margin, short limit, daily loss, feed -- except
   * that holding this contract already is the point, and the desk's premium
   * floor gives way to the add's own minimum, which the strategy set.
   */
  private async addInner(tradeId: string, req: AddRequest): Promise<AddResult> {
    let rec = await this.d.store.get(tradeId);
    if (!rec) return { ok: false, reason: 'no such trade' };
    const s = rec.state;
    const why = addEligibility(s, req.size);
    if (why) return { ok: false, reason: why };

    // The entry must be finished: two sells working on one trade cannot be
    // told apart by their fills.
    const entry = await this.exchange.getOrderByClientId(clientId(tradeId, 'entry')).catch(() => undefined);
    if (entry === undefined) return { ok: false, reason: 'could not read the entry order back' };
    if (entry && (entry.status === 'open' || entry.status === 'partial')) {
      return { ok: false, reason: 'the entry is still working' };
    }

    const product = await this.exchange.getProduct(rec.plan.symbol).catch(() => null);
    const gate = await this.runPrecheck(
      { ...rec.plan, lots: req.size, entry: { type: 'limit', limitPrice: req.limitPrice, timeoutMs: 0, marketFallback: false, chase: null } },
      product,
      { addingToOwn: true, minPremiumUsd: Math.min(this.limits.minPremiumUsd, req.floorPrice) },
    );
    if (!gate.ok) {
      const why = gate.failures.map((x) => x.message).join(' ');
      await this.commit(rec, { t: 'add_done', filled: 0, reason: `refused: ${why}`, at: this.now() });
      return { ok: false, reason: why, precheck: gate };
    }

    const n = rec.events.filter((e) => e.t === 'add_submitted').length;
    const tick = product?.tickSize ?? 0.1;
    const add: AddWorking = {
      clientOrderId: clientId(tradeId, 'entry', 100 + n),
      size: req.size,
      limitPrice: priceFor('sell', Math.max(req.limitPrice, req.floorPrice), tick),
      submittedAt: this.now(),
      deadline: this.now() + req.timeoutMs,
      chase: req.chaseSeconds > 0
        ? { steps: CHASE_STEPS, everyMs: Math.round((req.chaseSeconds * 1_000) / CHASE_STEPS), maxCrossSpreadPct: req.maxCrossSpreadPct }
        : null,
      floorPrice: req.floorPrice,
      unknown: false,
      entrySizeBefore: s.entrySize,
      source: req.source,
    };

    try {
      const ack = await this.exchange.placeOrder({
        clientOrderId: add.clientOrderId, symbol: rec.plan.symbol, productId: product?.productId ?? rec.state.productId,
        side: 'sell', type: 'limit', size: add.size, limitPrice: add.limitPrice, role: 'entry',
      });
      // The id the venue gave it goes into the record with the add itself, so
      // a lookup by our id that comes back empty is not the last word.
      rec = await this.commit(rec, { t: 'add_submitted', add: { ...add, orderId: ack.orderId }, at: this.now() });
      rec = await this.absorbAdd(rec, ack);
      if (ack.status === 'filled' || ack.status === 'cancelled' || ack.status === 'rejected') {
        rec = await this.commit(rec, { t: 'add_done', filled: this.addFilled(rec, add), reason: ack.status, at: this.now() });
      }
    } catch (e) {
      if (e instanceof SubmitTimeout || e instanceof ExchangeUnavailable) {
        // Not known whether it landed. It is looked for on every poll and never
        // sent again; the window ends the wait.
        rec = await this.commit(rec, { t: 'add_submitted', add: { ...add, unknown: true }, at: this.now() });
        return { ok: true, state: rec.state };
      }
      if (e instanceof OrderRejected) {
        rec = await this.commit(rec, { t: 'add_done', filled: 0, reason: `rejected: ${e.reason}`, at: this.now() });
        return { ok: false, reason: e.reason };
      }
      throw e;
    }
    // Contracts that filled on the spot need their target and stop resized now,
    // not on the next poll.
    if (rec.state.position !== 0 && missingProtection(rec)) rec = await this.protect(rec);
    return { ok: true, state: rec.state };
  }

  /** One poll's worth of an add: count its fills, walk its price, end it when it is over. */
  private async stepAdd(recIn: TradeRecord): Promise<TradeRecord> {
    let rec = recIn;
    const add = rec.state.adding!;
    const order = await this.findAdd(add);
    // Could not ask: try again next poll rather than conclude anything.
    if (order === undefined) return rec;

    if (order === null) {
      // Not found. Given the window before anything is concluded: after a
      // submit with no answer it may not be visible yet, and after one *with*
      // an answer a filtered lookup can simply be wrong for a while.
      if (this.now() < add.deadline) return rec;
      if (add.unknown) {
        return await this.commit(rec, { t: 'add_done', filled: this.addFilled(rec, add), reason: 'the order never reached the exchange', at: this.now() });
      }
      /*
       * Acknowledged, and still not found by the end of its window. That is not
       * an order that never landed -- the venue numbered it -- it is an order
       * the desk has lost sight of, and the position is the only truth left:
       * read it back from the exchange, let protect() cover whatever is there,
       * and say so. Writing "never reached the exchange" here is what left 100
       * filled contracts untracked and uncovered on 14 Sep 2026.
       */
      rec = await this.syncPosition(rec);
      return await this.commit(rec, {
        t: 'add_done', filled: this.addFilled(rec, add),
        reason: 'acknowledged but never found again; the position was read back from the exchange',
        at: this.now(),
      });
    }

    rec = await this.absorbAdd(rec, order);
    if (order.status !== 'open' && order.status !== 'partial') {
      return await this.commit(rec, { t: 'add_done', filled: this.addFilled(rec, add), reason: order.status, at: this.now() });
    }
    if (this.now() >= add.deadline) return this.endAdd(rec, 'its window closed');

    if (add.chase && order.limitPrice !== null) {
      const quote = await this.exchange.getQuote(rec.plan.symbol).catch(() => null);
      const product = await this.exchange.getProduct(rec.plan.symbol).catch(() => null);
      if (quote?.bid != null) {
        const tick = product?.tickSize ?? 0.1;
        let want = priceFor('sell', chasePrice({
          startedAt: add.submittedAt, now: this.now(), from: add.limitPrice, bid: quote.bid,
          steps: add.chase.steps, everyMs: add.chase.everyMs,
        }), tick);
        const spread = chaseFloor(quote.bid, quote.ask, add.chase.maxCrossSpreadPct);
        if (spread !== null) want = Math.max(want, Number.isFinite(spread) ? priceFor('sell', spread, tick) : order.limitPrice);
        // The add's own minimum: never sold under it, whatever the bid does.
        want = Math.max(want, priceFor('sell', add.floorPrice, tick));
        if (want < order.limitPrice) {
          const moved = await this.exchange.editOrder(order, { limitPrice: want })
            .catch((e) => (e instanceof OrderGone ? e : (this.note('add chase', order, e), null)));
          if (moved instanceof OrderGone) {
            // The add filled between the read and the edit -- the 650 of 14 Sep
            // took five seconds. Read it again now: the fill goes on the record
            // this poll, the add is closed out, and protection is resized here
            // rather than twenty seconds from now.
            const gone = await this.findAdd(add);
            if (gone) {
              rec = await this.absorbAdd(rec, gone);
              if (gone.status !== 'open' && gone.status !== 'partial') {
                return await this.commit(rec, { t: 'add_done', filled: this.addFilled(rec, add), reason: gone.status, at: this.now() });
              }
            }
          } else if (moved) {
            rec = await this.absorbAdd(rec, moved);
          }
        }
      }
    }
    return rec;
  }

  /**
   * The add's order: by our id first, then by the exchange's.
   *
   * `undefined` when neither could be asked; `null` only when both answered
   * and neither had it. The second lookup is what makes "not found" mean
   * something: a client-id filter can miss, a numbered order cannot.
   */
  private async findAdd(add: AddWorking): Promise<ExchangeOrder | null | undefined> {
    const byOurs = await this.exchange.getOrderByClientId(add.clientOrderId).catch(() => undefined);
    if (byOurs) return byOurs;
    if (!add.orderId) return byOurs;
    const byTheirs = await this.exchange.getOrderById(add.orderId).catch(() => undefined);
    if (byTheirs) return byTheirs;
    // Both asked and both empty is null; either unasked is undefined.
    return byOurs === null && byTheirs === null ? null : undefined;
  }

  /** Take a working add off the book, count what it filled, and close it out. */
  private async endAdd(recIn: TradeRecord, reason: string): Promise<TradeRecord> {
    let rec = recIn;
    const add = rec.state.adding;
    if (!add) return rec;
    const order = await this.findAdd(add);
    if (order) {
      if (order.status === 'open' || order.status === 'partial') {
        await this.exchange.cancelOrder(order).catch((e) => this.note('cancel add', order, e));
      }
      const after = await this.findAdd(add);
      rec = await this.absorbAdd(rec, after ?? order);
      if (after && (after.status === 'open' || after.status === 'partial')) {
        // Still on the book. Keep it tracked -- the next poll tries again --
        // rather than forget an order that can still sell.
        return rec;
      }
    } else if (order === undefined) {
      return rec;
    }
    return await this.commit(rec, { t: 'add_done', filled: this.addFilled(rec, add), reason, at: this.now() });
  }

  /** Fills of an add are entry fills; a rejected add is not a rejected trade. */
  private async absorbAdd(rec: TradeRecord, order: ExchangeOrder): Promise<TradeRecord> {
    return await this.absorb(rec, { ...order, status: order.status === 'rejected' ? 'cancelled' : order.status }, 'entry');
  }

  private addFilled(rec: TradeRecord, add: AddWorking): number {
    return Math.max(0, rec.state.entrySize - add.entrySizeBefore);
  }

  // ------------------------------------------------------- reconciliation
  /** Read the exchange and believe it. */
  private async reconcileInner(tradeId: string): Promise<TradeRecord | null> {
    let rec = await this.d.store.get(tradeId);
    if (!rec) return null;

    const entryId = clientId(tradeId, 'entry');
    const entry = await this.exchange.getOrderByClientId(entryId).catch(() => null);
    if (entry) {
      rec = await this.absorb(rec, entry, 'entry');
      if (rec.state.phase === 'entry_unknown') {
        rec = await this.commit(rec, { t: 'entry_submitted', clientOrderId: entryId, size: entry.size, at: this.now() });
        rec = await this.absorb(rec, entry, 'entry');
      }
    }
    /*
     * Every reconcile reads the fills, not only one that finds the position
     * off. The first build of this compared the exchange's position with ours
     * and looked no further when they agreed -- and on 14 Sep 2026 they did
     * agree, because an earlier reconcile had already set ours to -1,500 by
     * number, leaving a record whose fills explained 1,400 of it. The fills
     * are the record; the position is a summary of them, and a summary that
     * matches is not evidence the record is whole. Reconcile is a startup or
     * a button, never the poll, so one history read here costs nothing.
     */
    rec = await this.recoverFills(rec);
    rec = await this.syncPosition(rec);
    if (!entry && rec.state.entrySize === 0 && rec.state.phase === 'entry_unknown') {
      // It never landed. Nothing is at risk and nothing was double-sent.
      rec = await this.commit(rec, { t: 'aborted', reason: 'entry never reached the exchange', at: this.now() });
    }
    return rec;
  }

  /**
   * The fills this trade's orders had that the record does not.
   *
   * Every order the desk sends carries the trade's own stem in its client id,
   * so the contract's order history can be read back and any filled order
   * with our stem absorbed -- `absorb` only adds what it has not seen for that
   * order, so the ones already on the record add nothing. This is how a lost
   * add (14 Sep 2026: 100 @ 23, acknowledged, filled, and written off) comes
   * back as the fill it was, with its price, rather than as a bare position
   * the record cannot explain: the card then reads "Sold 1,500 @ 11.82",
   * which is what Delta says, instead of "Sold 1,400" over a position of 1,500.
   */
  private async recoverFills(recIn: TradeRecord): Promise<TradeRecord> {
    let rec = recIn;
    const stem = clientStem(rec.state.tradeId);
    const history = await this.exchange.getOrderHistory(rec.plan.symbol, 50).catch(() => null);
    if (!history) return rec;
    for (const o of history) {
      const role = roleOfClientId(o.clientOrderId, stem);
      if (role === null || o.filledSize <= 0) continue;
      rec = await this.absorb(rec, o, role);
    }
    return rec;
  }

  private async syncPosition(recIn: TradeRecord): Promise<TradeRecord> {
    let rec = recIn;
    const positions = await this.exchange.getPositions().catch(() => null);
    if (positions === null) return rec;
    const net = positions.find((p) => p.symbol === rec.plan.symbol)?.size ?? 0;
    /*
     * Delta's position is per contract; a trade's is its own share of it. With
     * other open trades on the contract (0011), this trade's share is what the
     * net leaves after theirs -- and a gap is only this trade's to write down
     * when it cannot be anyone else's: no siblings, or nothing held at all.
     */
    const siblings = await this.siblingsOn(rec);
    const theirs = siblings.reduce((n, t) => n + t.state.position, 0);
    const held = net - theirs;
    if (held !== rec.state.position) {
      // The fills first: a position that can be explained by orders the desk
      // sent is a record with a gap, and the gap is filled with the fills.
      // (Reconcile has already done this; the lost-add path arrives here
      // without it.)
      rec = await this.recoverFills(rec);
    }
    if (held !== rec.state.position && siblings.length > 0 && net !== 0) {
      // Shared and not flat: which trade the difference belongs to is not
      // knowable from here, and a guess would rewrite a book that may be right --
      // a sibling that has not yet absorbed its own fill looks exactly like
      // this. Wait for the siblings to catch up; say so if it lasts.
      const u = this.unexplained.get(rec.state.tradeId) ?? { since: this.now(), said: false };
      if (!u.said && this.now() - u.since >= UNEXPLAINED_ALARM_MS) {
        u.said = true;
        this.d.onAlarm?.(rec.state, `${rec.plan.symbol}: Delta holds ${net} across ${siblings.length + 1} trades that add up to `
          + `${theirs + rec.state.position}. Not rewritten -- check the positions by hand.`, rec.plan);
      }
      this.unexplained.set(rec.state.tradeId, u);
      return rec;
    }
    this.unexplained.delete(rec.state.tradeId);
    if (held !== rec.state.position) {
      const position = siblings.length > 0 ? 0 : held;   // shared: only reached when the contract is flat
      rec = await this.commit(rec, {
        t: 'reconciled', position, at: this.now(),
        note: `exchange says ${net}${siblings.length ? ` across ${siblings.length + 1} trades` : ''}, we had ${rec.state.position}`,
      });
      // The position moved under us, so anything resting is the wrong size.
      // protect() compares size as well as price, so it replaces them itself.
      if (position !== 0) rec = await this.protect(rec);
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
    for (const rec of await this.d.store.open()) {
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
