import { config } from '../config.js';
import { credsFromEnv } from '../delta/signed.js';
import { TradeEngine, type TradePlan, type TradeRecord } from './engine.js';
import { SqliteTradeStore } from './store.js';
import { DeltaExchange } from './exchange/delta.js';
import { PaperExchange } from './exchange/paper.js';
import { DEFAULT_LIMITS, dailyLossLimitFor, type RiskLimits } from './precheck.js';
import { clampLeverage } from './margin.js';
import { isDone } from './machine.js';
import { noteError } from '../observability/errors.js';
import type { ExchangePort } from './exchange/port.js';
import type { ExchangeOrder, ExchangePosition, TradeState } from './types.js';

/**
 * The one live trading service.
 *
 * Which exchange it drives is decided here, once, from the environment:
 * DELTA_LIVE_TRADING must be on *and* credentials must be present. Anything
 * else is paper, and the desk says which one it is on every screen.
 *
 * The poll loop is deliberately dumb: every second, ask the engine to step each
 * open trade. All the judgement lives in the engine, where it is tested.
 */

const POLL_MS = 1_000;
/** Long enough that a one-second poll is one call; short enough to feel live. */
const POSITIONS_TTL_MS = 800;
const QUOTE_TTL_MS = 800;
/**
 * Two hundred, matching Delta's own app.
 *
 * This is the leverage the account already trades at, so the desk defaults to
 * it rather than quietly disagreeing with the exchange screen beside it. It
 * cuts both ways and the ticket says so:
 *
 *   - the margin behind a lot is half a percent of spot, so a small balance can
 *     open a position, and the close-out sits close above where you sold;
 *   - but because the close-out is close, the loss before it arrives is small.
 *     At 200x a naked short risks the room to the close-out and no more, which
 *     is a fraction of what the same trade risks at 10x.
 *
 * The ticket shows the close-out price on the bar as you drag, so the tightness
 * is visible rather than implied.
 */
const DEFAULT_LEVERAGE = 200;
/**
 * Four concessions rather than one.
 *
 * Enough that a maker willing to meet you part of the way gets the chance, few
 * enough that the whole walk is over inside the window and each step is a
 * visible move rather than a rounding error on a tick.
 */
const CHASE_STEPS = 4;
/**
 * The exits, as percentages of the premium.
 *
 * A short option is sold for a credit and bought back for less, so the two
 * exits are read off the entry price in opposite directions:
 *
 *   target  -- the option has decayed by this much.  price = entry x (1 - pct)
 *   stop    -- the option has run against you by this much. price = entry x (1 + pct)
 *
 * Zero means off. Neither is derived behind your back: a trade that runs
 * without a stop says so on the ticket, in the position row, and in the
 * journal, and it is a decision rather than a malfunction.
 */
export const targetPriceFor = (entry: number, pct: number): number | null =>
  pct > 0 ? round1(entry * (1 - Math.min(0.99, pct))) : null;

export const stopPriceFor = (entry: number, pct: number): number | null =>
  pct > 0 ? round1(entry * (1 + pct)) : null;

export type DeskMode = 'live' | 'paper';

export type ModeSwitch =
  | { ok: true; mode: DeskMode }
  | { ok: false; mode: DeskMode; reason: string };

export class TradingService {
  readonly store: SqliteTradeStore;
  /** Live unless the environment forbids it or there are no credentials. */
  private currentMode: DeskMode;
  private readonly live: ExchangePort | null;
  private readonly paperExchange: PaperExchange;
  private readonly engine: TradeEngine;
  private timer: NodeJS.Timeout | null = null;
  private feedOk = true;
  private stepping = false;
  /** Last BTC spot seen, for the margin and liquidation model. */
  private lastSpot: number | null = null;
  /** Last balance seen, so the daily-loss limit can be set from it. */
  private lastBalance: number | null = null;
  readonly alarms: { tradeId: string; message: string; at: number }[] = [];

  constructor(limits: Partial<RiskLimits> = {}) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const creds = credsFromEnv();
    this.live = creds ? new DeltaExchange(creds) : null;
    this.paperExchange = new PaperExchange({ balanceUsd: 1_000 });
    this.store = new SqliteTradeStore();
    // A mode chosen in the browser outlives a restart; without one, the
    // environment decides.
    const remembered = this.store.getSetting('mode') as DeskMode | null;
    const wanted = remembered ?? (config.liveTradingDefault ? 'live' : 'paper');
    this.currentMode = wanted === 'live' && this.live && !config.paperLocked ? 'live' : 'paper';

    this.engine = new TradeEngine({
      // Resolved on every call rather than captured, so flipping the switch
      // moves the whole engine at once instead of leaving half of it behind.
      exchange: new Proxy({} as ExchangePort, {
        get: (_t, key: string) => (this.exchange as unknown as Record<string, unknown>)[key],
      }),
      store: this.store,
      now: () => Date.now(),
      // Re-read on every gate check, so the limit follows the account rather
      // than whatever it was when the process started.
      limits: { ...DEFAULT_LIMITS, ...limits, get maxDailyLossUsd() {
        return limits.maxDailyLossUsd ?? dailyLossLimitFor(self.lastBalance);
      } },
      tradingEnabled: true,
      feedHealthy: () => this.feedOk,
      dayPnlUsd: () => this.store.realisedSince(startOfDayIst()),
      spot: () => this.lastSpot,
      onSwallowed: (what, order, error) => {
        noteError({
          source: 'trading',
          level: 'warn',
          message: `${what} failed: ${error.message}`,
          where: 'engine',
          context: { orderId: order.orderId, symbol: order.symbol ?? null },
        });
      },
      onAlarm: (t, message) => {
        this.alarms.unshift({ tradeId: t.tradeId, message, at: Date.now() });
        this.alarms.length = Math.min(this.alarms.length, 50);
      },
    });
  }

  get mode(): DeskMode { return this.currentMode; }
  /** Whether live is reachable at all: credentials present, env not forbidding. */
  get canGoLive(): boolean { return this.live !== null && !config.paperLocked; }
  private get exchange(): ExchangePort {
    return this.currentMode === 'live' && this.live ? this.live : this.paperExchange;
  }

  /**
   * Move the desk between the real exchange and the simulator.
   *
   * Refused while anything is open, and that is the important part: a position
   * lives on one book or the other, and switching underneath it would leave the
   * engine polling an exchange that has never heard of the order it is holding.
   */
  setMode(next: DeskMode): ModeSwitch {
    if (next === this.currentMode) return { ok: true, mode: this.currentMode };
    if (next === 'live' && !this.live) {
      return { ok: false, mode: this.currentMode, reason: 'No Delta credentials configured.' };
    }
    if (next === 'live' && config.paperLocked) {
      return { ok: false, mode: this.currentMode, reason: 'DELTA_LIVE_TRADING=0 forbids live trading on this server.' };
    }
    const open = this.openTrades();
    if (open.length > 0) {
      return {
        ok: false,
        mode: this.currentMode,
        reason: `Close ${open.length} open ${open.length === 1 ? 'position' : 'positions'} first — a position cannot move between books.`,
      };
    }
    this.currentMode = next;
    this.store.setSetting('mode', next);
    return { ok: true, mode: this.currentMode };
  }

  /** Pick up anything that was live when the process died, then start stepping. */
  async start(): Promise<TradeState[]> {
    const recovered = await this.engine.recover().catch(() => []);
    this.timer ??= setInterval(() => { void this.step(); }, POLL_MS);
    this.timer.unref?.();
    return recovered;
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  private async step() {
    if (this.stepping) return;          // a slow exchange must not stack polls
    this.stepping = true;
    try {
      for (const rec of this.store.open()) {
        await this.engine.poll(rec.state.tradeId).catch(() => {});
      }
      this.feedOk = true;
    } catch {
      this.feedOk = false;
    } finally {
      this.stepping = false;
    }
  }

  // ------------------------------------------------------------------ api
  async place(input: {
    symbol: string;
    optionSide: 'CE' | 'PE';
    strike: number;
    expiryTs: number;
    lots: number;
    /** 1 to 200. Sets the margin, and how close the close-out sits. */
    leverage?: number;
    /**
     * Seconds over which to walk the price from the offer to the bid.
     * Zero leaves the order where it was put, to fill or not.
     */
    chaseSeconds?: number;
    /** Absent means take what the book offers. */
    limitPrice?: number;
    /** 0 to 0.99. Zero means no target. */
    takeProfitPct?: number;
    /** 0 upwards. Zero means no stop. */
    stopLossPct?: number;
    /** Overrides the percentage, when a caller wants an exact price. */
    takeProfitPrice?: number | null;
    stopPrice?: number | null;
    timeoutMs?: number;
    marketFallback?: boolean;
  }) {
    const price = input.limitPrice;
    // A market entry has no price yet, so a percentage cannot be turned into
    // one; the exits are placed from the actual fill on the first poll instead.
    const basis = price ?? null;
    const plan: TradePlan = {
      tradeId: `${input.symbol}-${Date.now()}`,
      symbol: input.symbol,
      optionSide: input.optionSide,
      lots: input.lots,
      leverage: clampLeverage(input.leverage ?? DEFAULT_LEVERAGE),
      entry: price === undefined
        ? { type: 'market', timeoutMs: 0, marketFallback: false, chase: null }
        : {
            type: 'limit', limitPrice: price,
            // A limit rests until it fills. A chase is what ends it: the last
            // step is the bid, which is marketable, so the walk always finishes
            // in a fill and no timer is needed to force one.
            timeoutMs: 0,
            marketFallback: false,
            chase: input.chaseSeconds && input.chaseSeconds > 0
              ? { steps: CHASE_STEPS, everyMs: Math.round((input.chaseSeconds * 1_000) / CHASE_STEPS) }
              : null,
          },
      takeProfitPrice:
        input.takeProfitPrice !== undefined
          ? input.takeProfitPrice
          : basis !== null ? targetPriceFor(basis, input.takeProfitPct ?? 0) : null,
      stopPrice:
        input.stopPrice !== undefined
          ? input.stopPrice
          : basis !== null ? stopPriceFor(basis, input.stopLossPct ?? 0) : null,
      expect: {
        underlying: 'BTC',
        optionSide: input.optionSide,
        strike: input.strike,
        expiryTs: input.expiryTs,
      },
    };
    return this.engine.open(plan);
  }

  close(tradeId: string) { return this.engine.closeNow(tradeId); }
  cancel(tradeId: string) { return this.engine.cancelEntry(tradeId); }

  /**
   * Move the exits on an open position.
   *
   * Percentages in, prices out, measured off the price the position was
   * actually opened at -- not off the mark, which would move the stop every
   * time the option did.
   */
  async updateExits(tradeId: string, pct: { takeProfitPct?: number; stopLossPct?: number }) {
    const rec = this.store.get(tradeId);
    if (!rec) return null;
    const entry = rec.state.entryAvgPrice;
    if (entry === null) return rec.state;
    return this.engine.updateProtection(tradeId, {
      takeProfitPrice: pct.takeProfitPct === undefined ? undefined : targetPriceFor(entry, pct.takeProfitPct),
      stopPrice: pct.stopLossPct === undefined ? undefined : stopPriceFor(entry, pct.stopLossPct),
    });
  }

  /**
   * Square off: buy back every position, pull every working order.
   *
   * One trade at a time, and a failure on one does not stop the rest -- the
   * whole point of reaching for this is that something has gone wrong, and
   * getting three of four positions closed beats getting none. What failed is
   * named in the answer so it can be dealt with by hand.
   *
   * Orders are pulled before positions are bought back, so a target sitting on
   * the book cannot fill halfway through and leave the size wrong.
   */
  async closeAll(): Promise<{
    cancelled: string[];
    closed: string[];
    failed: { tradeId: string; reason: string }[];
  }> {
    const out = { cancelled: [] as string[], closed: [] as string[], failed: [] as { tradeId: string; reason: string }[] };
    const open = this.openTrades();

    for (const rec of open.filter((r) => r.state.position === 0)) {
      try {
        await this.engine.cancelEntry(rec.state.tradeId);
        out.cancelled.push(rec.state.tradeId);
      } catch (e) {
        out.failed.push({ tradeId: rec.state.tradeId, reason: (e as Error).message });
      }
    }

    for (const rec of open.filter((r) => r.state.position !== 0)) {
      try {
        const after = await this.engine.closeNow(rec.state.tradeId, 'square off');
        if (after && after.position !== 0) {
          out.failed.push({ tradeId: rec.state.tradeId, reason: `still holding ${after.position}` });
        } else {
          out.closed.push(rec.state.tradeId);
        }
      } catch (e) {
        out.failed.push({ tradeId: rec.state.tradeId, reason: (e as Error).message });
      }
    }
    return out;
  }
  reconcile(tradeId: string) { return this.engine.reconcile(tradeId); }
  /** Remembered on the way past, so the margin model has a spot to work from. */
  noteSpot(spot: number | null) { if (spot && spot > 0) this.lastSpot = spot; }

  /**
   * Positions for the screen, cached for under a second.
   *
   * The desk polls this once a second so the mark and the P&L tick; without a
   * cache that is one call per second per open tab, and Delta counts them.
   *
   * Deliberately *not* used by the engine. Protection and reconciliation ask
   * `exchange.getPositions()` directly, because those decide whether contracts
   * exist and must never read a figure from a moment ago.
   */
  private positionsCache: { rows: ExchangePosition[]; at: number } | null = null;

  async positionsForDisplay(now = Date.now()): Promise<ExchangePosition[]> {
    if (this.positionsCache && now - this.positionsCache.at < POSITIONS_TTL_MS) {
      return this.positionsCache.rows;
    }
    const rows = await this.exchange.getPositions().catch(() => this.positionsCache?.rows ?? []);
    this.positionsCache = { rows, at: now };
    return rows;
  }

  /**
   * A quote for the screen, cached for under a second.
   *
   * The order ticket polls this while it is open so the book in front of you is
   * the book you are trading against. Same reasoning as the positions cache:
   * one call a second however many tabs are watching.
   */
  private quoteCache = new Map<string, { quote: Awaited<ReturnType<ExchangePort['getQuote']>>; at: number }>();

  async quoteForDisplay(symbol: string, now = Date.now()) {
    const hit = this.quoteCache.get(symbol);
    if (hit && now - hit.at < QUOTE_TTL_MS) return hit.quote;
    const quote = await this.exchange.getQuote(symbol).catch(() => hit?.quote ?? null);
    this.quoteCache.set(symbol, { quote, at: now });
    if (this.quoteCache.size > 50) this.quoteCache.clear();
    return quote;
  }

  /**
   * The orders resting for a symbol, cached like the rest.
   *
   * The screen needs these because the plan and the book can disagree, and
   * when they do the book is the one that will fill.
   */
  private ordersCache = new Map<string, { rows: ExchangeOrder[]; at: number }>();

  async openOrdersForDisplay(symbol: string, now = Date.now()): Promise<ExchangeOrder[]> {
    const hit = this.ordersCache.get(symbol);
    if (hit && now - hit.at < QUOTE_TTL_MS) return hit.rows;
    const rows = await this.exchange.getOpenOrders(symbol).catch(() => hit?.rows ?? []);
    this.ordersCache.set(symbol, { rows, at: now });
    if (this.ordersCache.size > 50) this.ordersCache.clear();
    return rows;
  }

  quote(symbol: string) { return this.exchange.getQuote(symbol); }
  get spot() { return this.lastSpot; }
  product(symbol: string) { return this.exchange.getProduct(symbol); }
  positions() { return this.exchange.getPositions(); }
  async balance() {
    const usd = await this.exchange.getBalanceUsd();
    this.lastBalance = usd;
    return usd;
  }

  /** What the desk will let today lose, given what is in the account. */
  get dailyLossLimitUsd() { return dailyLossLimitFor(this.lastBalance); }

  list(limit = 50): TradeRecord[] { return this.store.recent(limit); }
  openTrades(): TradeRecord[] { return this.store.open().filter((r) => !isDone(r.state)); }

  /** Paper mode only: lets the desk seed the simulated book from live quotes. */
  paper(): PaperExchange | null {
    return this.currentMode === 'paper' ? this.paperExchange : null;
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** 05:30 IST is when the daily contract opens, so that is where the day starts. */
function startOfDayIst(now = Date.now()): number {
  const IST = 5.5 * 3600_000;
  const local = now + IST;
  const midnight = Math.floor(local / 86_400_000) * 86_400_000;
  return midnight - IST;
}

let singleton: TradingService | null = null;
export const tradingService = (): TradingService => (singleton ??= new TradingService());
