import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config.js';
import type { Creds } from '../delta/signed.js';
import { brokerAccounts, initBrokerAccounts } from '../delta/accounts.js';
import { TradeEngine, type AddRequest, type TradeRecord } from './engine.js';
import { PgTradeStore } from './store.js';
import { accountKey, accountSetting, settings as deskSettings, type Settings } from '../db/settings.js';
import { DeltaExchange } from './exchange/delta.js';
import { PaperExchange } from './exchange/paper.js';
import {
  DEFAULT_LIMITS, dailyLossLimitFor, maxShortContractsFor, type RiskLimits,
} from './precheck.js';
import { fundsRequiredPerContract } from './margin.js';
import { DEFAULT_LEVERAGE, exitPriceProblem, orderPlan, protectionFor, type ExitAsk, type PlaceInput } from './order-plan.js';

export { stopFor, stopPriceFor, targetFor, targetPriceFor } from './order-plan.js';
import { isDone } from './machine.js';
import { tradeCharges } from './charges.js';
import { unrealisedPnlUsd } from './margin.js';
import { midOf } from './money.js';
import { istDate, startOfDayIst } from '../strategy/schedule.js';
import type { MtmSample } from './pnl-history.js';
import { candles } from '../market/delta.js';
import { liveLtp, onPerpPrint } from '../market/flow.js';
import { logTelegram } from '../notify/telegram-log.js';
import { noteError } from '../observability/errors.js';
import { alertFor, bookWentFlat, daySummaryFor, slippageAlert } from '../notify/messages.js';
import { TelegramNotifier } from '../notify/telegram.js';
import { BEST_TRADE_MIN_PREMIUM_USD } from '../domain/best-trade.js';
import type { ExchangePort } from './exchange/port.js';
import { UNDERLYING_WATCH_MS, UnderlyingWatch, watchedOf } from './underlying-watch.js';
import { deskMetrics, notePass } from '../observability/desk-metrics.js';
import { ENTRY_WATCH_MS, EntryWatch } from './entry-watch.js';
import type { ExchangeOrder, ExchangePosition, TradeState } from './types.js';

/**
 * The one live trading service.
 *
 * Which exchange it drives is decided here: DELTA_LIVE_TRADING must be on *and*
 * a default broker account must be present (delta/accounts.ts). Anything else
 * is paper, and the desk says which one it is on every screen.
 *
 * The poll loop is deliberately dumb: every second, ask the engine to step each
 * open trade. All the judgement lives in the engine, where it is tested.
 */

const POLL_MS = 1_000;
/** How often the day's P&L is written down. A minute draws a day in 720 points. */
const MTM_SAMPLE_MS = 60_000;
/** Long enough that a one-second poll is one call; short enough to feel live. */
/*
 * The display caches, sized for a status that is refreshed in the background
 * once a second: everything a single refresh reads is reused within it, and
 * nothing is older than two seconds when the screen reads it.
 */
const POSITIONS_TTL_MS = 1_500;
const QUOTE_TTL_MS = 1_500;
const BALANCE_TTL_MS = 2_500;
/** How long one status answer serves every poll that arrives after it. */
export const STATUS_TTL_MS = 900;
/** How often the status is refreshed in the background, whether or not anyone asks. */
const STATUS_REFRESH_MS = 1_000;
/** A background answer older than this is not served; the request waits for a fresh one. */
const STATUS_STALE_MS = 4_000;
/** Where the chosen short cap is kept, so it outlives a restart. */
export const SHORT_CAP_KEY = 'max_short_contracts';
export type DeskMode = 'live' | 'paper';

export type ModeSwitch =
  | { ok: true; mode: DeskMode }
  | { ok: false; mode: DeskMode; reason: string };

export type TradingServiceDeps = {
  store: PgTradeStore;
  /** Loaded before this is built: every getter below reads it synchronously. */
  settings: Settings;
  limits?: Partial<RiskLimits>;
  /** The default broker account's key, or null: with none, the desk is paper only. */
  creds?: Creds | null;
  /** That account's id, stamped on every trade placed and every P&L reading taken while the desk is on it. */
  accountId?: number | null;
  /** The phone, shared by every account's desk: one sender, one repeat guard. Absent, this desk makes its own. */
  notifier?: TelegramNotifier | null;
};

export class TradingService {
  readonly store: PgTradeStore;
  /** The desk's remembered choices: the mode, the cap, the alert switches. */
  readonly settings: Settings;
  /** Live unless the environment forbids it or there are no credentials. */
  private currentMode: DeskMode;
  /** The real exchange, signed with this desk's own broker account's key; null on a desk with no account. */
  private readonly live: ExchangePort | null;
  /** The default broker account's id, or null with none: what a new trade and a P&L reading are stamped with. */
  private currentAccountId: number | null;
  get accountId(): number | null { return this.currentAccountId; }
  private readonly paperExchange: PaperExchange;
  private readonly engine: TradeEngine;
  private timer: NodeJS.Timeout | null = null;
  private feedOk = true;
  private stepping = false;
  /** Last BTC spot seen, for the margin and liquidation model. */
  private lastSpot: number | null = null;
  /** Last balance seen, so the daily-loss limit can be set from it. */
  private lastBalance: number | null = null;
  /**
   * Contracts short across the book at the last look.
   *
   * Only ever used to work out how many *more* the margin could carry. The
   * gates count the real position from `getPositions()`; this is a display-side
   * figure and must never be mistaken for one.
   */
  private lastShortContracts = 0;
  readonly alarms: { tradeId: string; message: string; at: number }[] = [];
  /** Phone alerts when an entry or an exit fills. Null unless TG_TOKEN and TG_CHAT_ID are both set. */
  readonly notifier: TelegramNotifier | null;

  /**
   * Whether fill alerts actually go out.
   *
   * Separate from whether Telegram is *configured*, and deliberately so: a bot
   * token in `.env` says messages can be sent, and this says somebody wants
   * them right now. Turning them off on a quiet afternoon should not mean
   * editing a file and restarting the desk -- and an alert you have silenced
   * for a reason is not an alert you want back at the next deploy, so the
   * choice is remembered in the journal rather than in memory.
   *
   * It silences the desk's own messages only. The trading engine is untouched:
   * positions still open, protect and close exactly as before.
   */
  get alertsOn(): boolean {
    return this.settings.get('alerts_enabled') !== '0';
  }

  setAlertsOn(on: boolean): Promise<void> {
    return this.settings.set('alerts_enabled', on ? '1' : '0');
  }

  constructor({ store, settings, limits = {}, creds = null, accountId = null, notifier }: TradingServiceDeps) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.store = store;
    this.settings = settings;
    this.notifier = notifier !== undefined ? notifier : config.telegram
      ? new TelegramNotifier({
          ...config.telegram,
          onError: (message, context) => noteError({ source: 'server', level: 'warn', message, where: 'telegram', context }),
          // Every message, as it went: the Telegram log (notify/telegram-log.ts).
          onResult: (r) => { void logTelegram(r); },
        })
      : null;
    this.live = creds ? new DeltaExchange(creds) : null;
    this.currentAccountId = accountId;
    this.paperExchange = new PaperExchange({ balanceUsd: 1_000 });
    // A mode chosen in the browser outlives a restart; without one, the
    // environment decides.
    const remembered = this.settings.get('mode') as DeskMode | null;
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
      }, get maxShortContracts() {
        // Same reasoning as the loss limit: read at the moment the gate runs,
        // so changing the setting takes effect on the next order rather than
        // on the next restart.
        return limits.maxShortContracts ?? self.maxShortContracts;
      } },
      tradingEnabled: true,
      feedHealthy: () => this.feedOk,
      // Today's booked P&L on the account being traded: the daily-loss gate is that account's, not the day's across accounts.
      dayPnlUsd: () => this.store.realisedSince(startOfDayIst(), this.currentAccountId),
      spot: () => this.currentSpot(),
      // The option's own candles, for a stop the strategy asked to watch on
      // the close rather than on the touch.
      candles: (symbol, startSec, endSec, resolution) => candles(symbol, startSec, endSec, resolution),
      // The perpetual's last trade off the tape, for a signal strategy's exits on the underlying.
      underlying: () => { const l = liveLtp(); return l ? { price: l.price, at: l.at } : null; },
      onSwallowed: (what, order, error) => {
        noteError({
          source: 'trading',
          level: 'warn',
          message: `${what} failed: ${error.message}`,
          where: 'engine',
          context: { orderId: order.orderId, symbol: order.symbol ?? null },
        });
      },
      /*
       * An alarm goes three places, because until 27 Sep 2026 it went to one and
       * that one was invisible.
       *
       * It was pushed onto `this.alarms` -- fifty entries in memory, returned by
       * `/api/trade/status`, drawn by no component, gone on restart. So the
       * safeguard docs/decisions/0006-target-is-a-price-stop-is-an-exit.md describes as raising "an alarm, once, where
       * the alerts already go" did not go where the alerts go. A stop asked at
       * 56.5 filled at 65 that day and was found by reading fills by hand.
       *
       * Now: the array as before (cheap, and the status route already serves
       * it), the error log so it survives a restart and can be read after the
       * fact, and the phone, which is what "where the alerts already go" meant.
       */
      onAlarm: (t, message, plan) => {
        this.alarms.unshift({ tradeId: t.tradeId, message, at: Date.now() });
        this.alarms.length = Math.min(this.alarms.length, 50);

        noteError({
          source: 'trading',
          level: 'warn',
          where: 'trade-alarm',
          message,
          context: { tradeId: t.tradeId, symbol: t.symbol ?? null },
        });

        // Never let a failed alert touch the trade: the same rule the fill
        // notifications follow.
        try {
          if (!this.notifier || !this.alertsOn) return;
          this.notifier.notify(slippageAlert(this.alertContext(), t, plan, message, Date.now()));
        } catch { /* an alert is never worth a trade */ }
      },
      // The mode is read at the moment of the fill, not captured, so a paper
      // fill can never reach the phone dressed as a live one.
      onEvent: async (event, before, after, plan) => {
        if (!this.notifier || !this.alertsOn) return;
        const alert = alertFor(event, before, after, plan, this.alertContext());
        if (alert) this.notifier.notify(alert);
        // Only a closing event can end the day, so only then is the book read.
        // The journal is already written, so the store sees this trade closed.
        if (before.position !== 0 && after.position === 0) {
          const open = await this.openTrades();
          if (bookWentFlat(before, after, open.map((r) => r.state))) await this.announceDay(open.length);
        }
      },
    });
  }

  /**
   * What every alert is told about the desk as it is: paper or live, and -- with more than one broker account
   * saved -- the name of the one it is trading on, so a fill on the phone says whose it is.
   */
  private alertContext(): { mode: DeskMode; account?: string | null } {
    let account: string | null = null;
    try {
      const all = brokerAccounts().list();
      if (all.length > 1 && this.currentAccountId !== null) account = all.find((a) => a.id === this.currentAccountId)?.name ?? null;
    } catch { /* the accounts are not loaded (a test's desk): no name to say */ }
    return { mode: this.currentMode, account };
  }

  /** One strategy's trades touched since the start of the IST day. */
  async tradesTodayFor(strategyId: string, now = Date.now()): Promise<TradeRecord[]> {
    return (await this.store.between(startOfDayIst(now), now + 1)).filter((r) => r.plan.strategyId === strategyId);
  }

  /** One message for the whole day, sent when nothing is held any more. */
  private async announceDay(workingOrders: number): Promise<void> {
    const now = Date.now();
    const dayStart = startOfDayIst(now);
    const summary = daySummaryFor(await this.store.between(dayStart, now + 1, 500, this.currentAccountId), {
      mode: this.currentMode, dayStart, at: now, spot: this.currentSpot(), workingOrders,
    });
    if (summary && this.alertsOn) this.notifier?.notify(summary);
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
  async setMode(next: DeskMode): Promise<ModeSwitch> {
    if (next === this.currentMode) return { ok: true, mode: this.currentMode };
    if (next === 'live' && !this.live) {
      return { ok: false, mode: this.currentMode, reason: 'No broker account in use. Add one under Logs → Accounts.' };
    }
    if (next === 'live' && config.paperLocked) {
      return { ok: false, mode: this.currentMode, reason: 'DELTA_LIVE_TRADING=0 forbids live trading on this server.' };
    }
    const open = await this.openTrades();
    if (open.length > 0) {
      return {
        ok: false,
        mode: this.currentMode,
        reason: `Close ${open.length} open ${open.length === 1 ? 'position' : 'positions'} first — a position cannot move between books.`,
      };
    }
    // Written first: a mode the screen was told is set, is set.
    await this.settings.set('mode', next);
    this.currentMode = next;
    return { ok: true, mode: this.currentMode };
  }

  /** Pick up anything that was live when the process died, then start stepping. */
  async start(): Promise<TradeState[]> {
    const recovered = await this.engine.recover().catch(() => []);
    this.timer ??= setInterval(() => { void this.step(); }, POLL_MS);
    this.timer.unref?.();
    this.mtmTimer ??= setInterval(() => { void this.sampleMtm(); }, MTM_SAMPLE_MS);
    this.mtmTimer.unref?.();
    // A signal trade's SL and TGT on the perp, looked at far more often than the loop can poll.
    this.watchTimer ??= setInterval(() => { this.underlyingWatch.tick(); }, UNDERLYING_WATCH_MS);
    this.watchTimer.unref?.();
    // And on the trade itself: every print of the perp is a look, so a level is acted on as it trades, not a tick later.
    this.stopPerpWatch ??= onPerpPrint(() => { this.underlyingWatch.tick(); });
    // The trades that cannot wait for the loop: a working entry, a position without its target yet.
    this.entryTimer ??= setInterval(() => { this.entryWatch.tick(); }, ENTRY_WATCH_MS);
    this.entryTimer.unref?.();
    await this.store.pruneMtm(Date.now());
    return recovered;
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.mtmTimer) { clearInterval(this.mtmTimer); this.mtmTimer = null; }
    if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = null; }
    if (this.entryTimer) { clearInterval(this.entryTimer); this.entryTimer = null; }
    if (this.stopPerpWatch) { this.stopPerpWatch(); this.stopPerpWatch = null; }
    if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
  }

  private mtmTimer: NodeJS.Timeout | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private entryTimer: NodeJS.Timeout | null = null;
  private stopPerpWatch: (() => void) | null = null;

  /**
   * The urgent trades (`entry-watch.ts`): a working entry and a position
   * without its target yet, polled four times a second on their own instead of
   * waiting their turn in the loop. When one settles, the SL and TGT watch
   * reads the open trades again, so its levels are armed at once.
   */
  readonly entryWatch = new EntryWatch({
    poll: (tradeId) => this.engine.poll(tradeId),
    quotaUsedPct: () => deskMetrics().delta.usedPct,
    onSettled: () => this.underlyingWatch.stale(),
  });

  /**
   * The fast watch on the signal trades' perp levels (`underlying-watch.ts`):
   * the perp's last trade off the tape against every open trade's SL and TGT,
   * ten times a second, and the engine's own exit for whichever is through.
   * The loop below still judges the same levels on every pass.
   */
  readonly underlyingWatch = new UnderlyingWatch({
    open: async () => watchedOf(await this.store.open()),
    price: () => { const l = liveLtp(); return l ? { price: l.price, at: l.at } : null; },
    exit: (tradeId) => this.engine.exitOnUnderlying(tradeId),
  });

  /**
   * The premium floor the best-pick card cuts its pool at. Remembered in the
   * journal (`best_trade_min_premium`), so it survives a deploy.
   *
   * The card is all that is left of the best pick: its phone alert and its
   * automatic trade were removed on 4 Oct 2026 -- both had been off since the
   * signal strategies took over, and a watcher that read the whole board every
   * minute to decide to do nothing was load for no purpose.
   */
  get bestTradeMinPremiumUsd(): number {
    const v = Number(this.settings.get('best_trade_min_premium'));
    return Number.isFinite(v) && v > 0 ? v : BEST_TRADE_MIN_PREMIUM_USD;
  }

  /**
   * The day so far, in one place: booked, still open, and Delta's charges on
   * every fill since the day began. `netUsd` is what the day has actually made
   * if it closed right now.
   *
   * One computation, read by the status route for the header and written down
   * by the sampler for the line -- so the number on the header and the last
   * point on the graph can never be two different numbers.
   */
  async todayFigures(now = Date.now()): Promise<Omit<MtmSample, 'at' | 'day'> & { lossUsd: number; profitUsd: number }> {
    const dayStart = startOfDayIst(now);
    // The account the desk is on: "today" on the screen and in the day's line is that account's day.
    const breakdown = await this.store.realisedBreakdownSince(dayStart, this.currentAccountId);
    const realisedUsd = breakdown.realisedUsd;
    const lossUsd = breakdown.lossUsd;
    const profitUsd = breakdown.profitUsd;
    const positions = await this.positionsForDisplay(now);
    let unrealisedUsd = 0;
    for (const rec of await this.openTrades()) {
      const live = positions.find((p) => p.symbol === rec.state.symbol) ?? null;
      const quote = await this.quoteForDisplay(rec.state.symbol, now);
      const mark = live?.markPrice ?? quote?.mark ?? midOf(quote?.bid ?? null, quote?.ask ?? null);
      unrealisedUsd += unrealisedPnlUsd({
        // This trade's own contracts, never Delta's row for the symbol: two trades may hold one contract
        // (decision 0011), and each counted both -- "Net today" disagreed with the Open P&L above it (2 Oct 2026).
        entryPrice: rec.state.entryAvgPrice, markPrice: mark,
        size: rec.state.position, contractValue: rec.state.contractValue, long: rec.state.position > 0,
      }) ?? 0;
    }
    const chargesUsd = (await this.store.between(dayStart, now + 1, 500, this.currentAccountId))
      .reduce((n, rec) => n + tradeCharges(rec.state, { spot: this.currentSpot(), since: dayStart }).totalUsd, 0);
    return { realisedUsd, lossUsd, profitUsd, unrealisedUsd, chargesUsd, netUsd: realisedUsd + unrealisedUsd - chargesUsd };
  }

  /**
   * Write the day down, once a minute.
   *
   * Only while there is something to say: a position open, or a day that has
   * booked or paid something. A flat desk on a quiet Sunday writes nothing,
   * and its line has no points rather than a thousand zeros.
   */
  async sampleMtm(now = Date.now()): Promise<void> {
    try {
      const f = await this.todayFigures(now);
      if ((await this.openTrades()).length === 0 && f.realisedUsd === 0 && f.chargesUsd === 0) return;
      await this.store.sampleMtm({ at: now, day: istDate(now), ...f }, this.currentAccountId);
    } catch (e) {
      noteError({
        source: 'trading', level: 'warn', where: 'service/sampleMtm',
        message: `mtm sample not written: ${(e as Error).message}`, context: {},
      });
    }
  }

  private async step() {
    if (this.stepping) return;          // a slow exchange must not stack polls
    this.stepping = true;
    const began = performance.now();
    let polled = 0;
    try {
      const open = await this.store.open();
      polled = open.length;
      // What was just read is what the fast watch looks at until the next pass.
      this.underlyingWatch.note(watchedOf(open));
      this.entryWatch.note(open);
      for (const rec of open) {
        await this.engine.poll(rec.state.tradeId).catch(() => {});
      }
      // A finished trade whose other exit could not be confirmed off the book is
      // not polled any more; this is what keeps trying it.
      await this.engine.sweepLeftovers().catch(() => {});
      this.feedOk = true;
    } catch {
      this.feedOk = false;
    } finally {
      this.stepping = false;
      // How long the pass took, for the gauge: a pass over a second makes the next one late.
      notePass(performance.now() - began, polled);
    }
  }

  // ------------------------------------------------------------------ api
  async place(input: PlaceInput) {
    const plan = orderPlan(input, `${input.symbol}-${nextTradeMs()}`);
    // Which account this is placed as, written down where it is known: the journal's `broker_account_id`.
    if (this.currentAccountId !== null) plan.accountId = this.currentAccountId;
    // And what was done with the option: sold, unless the caller asked to buy it (a BUY-side strategy).
    plan.action = input.action === 'buy' ? 'buy' : 'sell';
    const res = await this.engine.open(plan);
    // Working from this moment: watched closely for its fill, without waiting for the loop to read it.
    if (res.ok) this.entryWatch.add(res.state.tradeId);
    return res;
  }

  /**
   * Make a contract ready to be sold before its order is due (the engine's `warm`): product looked up,
   * leverage set. Sends no order. A signal strategy calls it when a signal appears and it will enter at the zone.
   */
  warmEntry(symbol: string): Promise<boolean> {
    return this.engine.warm(symbol, DEFAULT_LEVERAGE);
  }

  /** Whether that order would be taken, without sending it. */
  async wouldPlace(input: PlaceInput) {
    return this.engine.previewOpen(orderPlan(input, `preview-${input.symbol}-${Date.now()}`));
  }

  /** Buy back at the market: `lots` of it, or all of it when none is given. */
  /** Close one trade, or `lots` of it. `reason` is written on the close and said in the exit alert. */
  close(tradeId: string, lots?: number, reason = 'manual exit') { return this.engine.closeNow(tradeId, reason, lots); }
  /** What closing that many would book. Sends nothing. */
  previewClose(tradeId: string, lots?: number) { return this.engine.previewClose(tradeId, lots); }
  /** Sell more of what an open trade holds, under the same trade. */
  addToPosition(tradeId: string, req: AddRequest) { return this.engine.addToPosition(tradeId, req); }
  /** What that add would do and whether the gates would take it. Sends nothing. */
  previewAdd(tradeId: string, req: Pick<AddRequest, 'size' | 'limitPrice' | 'floorPrice'>) {
    return this.engine.previewAdd(tradeId, req);
  }
  cancel(tradeId: string) { return this.engine.cancelEntry(tradeId); }
  /** Stop a working add now, keeping whatever it has already sold. */
  cancelAdd(tradeId: string) { return this.engine.cancelAdd(tradeId); }

  /**
   * Move the exits on an open position.
   *
   * Percentages or points in, prices out, measured off the price the position
   * was actually opened at -- not off the mark, which would move the stop every
   * time the option did. A leg asked about neither way is left where it is.
   */
  async updateExits(tradeId: string, ask: ExitAsk, exitStage?: string) {
    const rec = await this.store.get(tradeId);
    if (!rec) return null;
    const entry = rec.state.entryAvgPrice;
    if (entry === null) return rec.state;
    // Asked for as prices, the levels must sit the right side of the entry.
    const wrong = exitPriceProblem(entry, ask);
    if (wrong) throw new ExitAskError(wrong);
    // A share or a distance keeps following the fill (a later add moves the
    // average); a level typed as a price on an open position is pinned there.
    const follow: ExitAsk = {};
    if (!((ask.takeProfitAt ?? 0) > 0) && (ask.takeProfitPct !== undefined || ask.takeProfitPoints !== undefined)) {
      follow.takeProfitPct = ask.takeProfitPct ?? 0;
      follow.takeProfitPoints = ask.takeProfitPoints ?? 0;
    }
    if (!((ask.stopAt ?? 0) > 0) && (ask.stopLossPct !== undefined || ask.stopLossPoints !== undefined)) {
      follow.stopLossPct = ask.stopLossPct ?? 0;
      follow.stopLossPoints = ask.stopLossPoints ?? 0;
    }
    return this.engine.updateProtection(tradeId, protectionFor(entry, ask), follow, exitStage);
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
    const open = await this.openTrades();

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
   * BTC's price for the desk's own arithmetic -- a trade's worst case with no stop, charges, the margin a short
   * needs: the perp's last trade off the live socket when fresh, else the last price a screen noted.
   *
   * It was only ever the last price a screen noted (the Live screen's board), so after a restart, until someone
   * opened that screen, there was none: a signal trade with no option stop was refused -- "the worst case cannot
   * be priced yet" -- eight minutes after a deploy, with the desk's own feed live the whole time (2 Oct 2026).
   */
  private currentSpot(): number | null {
    const l = liveLtp();
    if (l && l.price > 0 && Date.now() - l.at <= 15_000) {
      this.lastSpot = l.price;
      return l.price;
    }
    return this.lastSpot;
  }

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
    this.lastShortContracts = rows.reduce((n, x) => n + (x.size < 0 ? -x.size : 0), 0);
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
  get spot() { return this.currentSpot(); }
  product(symbol: string) { return this.exchange.getProduct(symbol); }
  positions() { return this.exchange.getPositions(); }
  async balance() {
    const usd = await this.exchange.getBalanceUsd();
    this.lastBalance = usd;
    return usd;
  }

  /**
   * The balance for the screen, cached like the positions.
   *
   * `balance()` above is what the gates read and stays a real read. This one
   * feeds the account card, which is polled once a second -- and on 16
   * September that poll was taking a second to answer, because every request
   * asked Delta for the balance again. Two seconds of staleness on a number
   * that moves with fills is nothing; a screen that lags its own poll is not.
   */
  private balanceCache: { usd: number; at: number } | null = null;

  /** Delta's wallet balance and what is free, cached as the balance is; null where the exchange cannot say. */
  private walletCache: { v: { balance: number; available: number } | null; at: number } | null = null;
  async walletForDisplay(now = Date.now()): Promise<{ balance: number; available: number } | null> {
    if (this.walletCache && now - this.walletCache.at < BALANCE_TTL_MS) return this.walletCache.v;
    const v = this.exchange.getWalletUsd ? await this.exchange.getWalletUsd().catch(() => this.walletCache?.v ?? null) : null;
    this.walletCache = { v, at: now };
    return v;
  }

  async balanceForDisplay(now = Date.now()): Promise<number> {
    if (this.balanceCache && now - this.balanceCache.at < BALANCE_TTL_MS) return this.balanceCache.usd;
    const usd = await this.balance();
    this.balanceCache = { usd, at: now };
    return usd;
  }

  /**
   * One computation of something expensive at a time, shared by everyone who
   * asks while it runs, and kept for `ttlMs` after.
   *
   * The status route fans out to Delta -- balance, positions, a quote and the
   * book per open symbol -- and is polled once a second by every open tab. The
   * per-read caches under it were 800ms, so a request that took a second to
   * answer missed every one of them, and two tabs meant two fan-outs. Measured
   * before this: 355 status calls in fifteen minutes averaging 994ms, which is
   * a poll saturating its own server. With this, the second caller inside a
   * second gets the first caller's answer, and the fan-out happens at most once
   * a second however many are watching.
   */
  private coalesced = new Map<string, { at: number; value: unknown; inflight: Promise<unknown> | null }>();

  /**
   * The status, refreshed in the background and read instantly.
   *
   * `coalesce` stopped two tabs doing two fan-outs. It did not stop the
   * fan-out being on the request path: with reads cached under a second and a
   * poll every second, every poll still waited ~850ms for Delta, and the
   * screen was always a request behind. Measured on the deployed build:
   * 139 calls in ten minutes, averaging 853ms, worst 3.6s.
   *
   * So the server now refreshes the status itself, once a second, whether or
   * not anyone is looking -- the same stale-while-revalidate the ticker cache
   * has used since the start -- and a request returns the last answer at
   * once. It waits only when there is no answer yet, or the last one is over
   * four seconds old, which is a Delta outage rather than a poll.
   */
  private statusLast: { at: number; value: unknown } | null = null;
  private statusCompute: (() => Promise<unknown>) | null = null;
  private statusTimer: NodeJS.Timeout | null = null;

  /**
   * The route registers how the status is computed; the service keeps it fresh.
   *
   * Registered once, and it is every account's: the computation asks `tradingService()` for the desk, so run
   * as this desk (`statusHere`) it is this account's status. Each desk keeps its own answer fresh.
   */
  provideStatus(compute: () => Promise<unknown>): void {
    this.statusCompute = compute;
    statusForEveryDesk = compute;
    this.beginStatus();
    for (const d of tradingServices()) d.beginStatus();
  }

  /** Start keeping this desk's status fresh, once there is a way to compute it. */
  beginStatus(): void {
    if (!this.statusHere()) return;
    this.statusTimer ??= setInterval(() => { void this.refreshStatus(); }, STATUS_REFRESH_MS);
    this.statusTimer.unref?.();
    void this.refreshStatus();
  }

  /** The status computation, run as this desk: its own, or the one registered for every desk. */
  private statusHere(): (() => Promise<unknown>) | null {
    // The shared one is for the desks the process runs, not for a desk somebody built on its own (a test's).
    const compute = this.statusCompute ?? (singleton === this || [...desks.values()].includes(this) ? statusForEveryDesk : null);
    return compute ? () => deskContext.run(this, compute) : null;
  }

  private async refreshStatus(now = Date.now()): Promise<void> {
    const compute = this.statusHere();
    if (!compute) return;
    try {
      const value = await this.coalesce('status', STATUS_TTL_MS, compute, now);
      this.statusLast = { at: now, value };
    } catch {
      // A refresh that fails leaves the last good answer in place; the route's
      // staleness rule decides whether that is still worth serving.
    }
  }

  async status<T>(now = Date.now()): Promise<T> {
    if (this.statusLast && now - this.statusLast.at < STATUS_STALE_MS) return this.statusLast.value as T;
    const compute = this.statusHere();
    if (!compute) throw new Error('status not provided');
    const value = await this.coalesce('status', STATUS_TTL_MS, compute, now);
    this.statusLast = { at: now, value };
    return value as T;
  }

  async coalesce<T>(key: string, ttlMs: number, compute: () => Promise<T>, now = Date.now()): Promise<T> {
    const hit = this.coalesced.get(key);
    if (hit?.inflight) return hit.inflight as Promise<T>;
    if (hit && now - hit.at < ttlMs) return hit.value as T;
    // Aged from when the read *started*, not when it returned: a slow answer is
    // already old by the time it arrives, and dating it later would let a
    // second-old figure serve a further second.
    const inflight = compute().then(
      (value) => { this.coalesced.set(key, { at: now, value, inflight: null }); return value; },
      (e) => { this.coalesced.set(key, { at: hit?.at ?? 0, value: hit?.value, inflight: null }); throw e; },
    );
    this.coalesced.set(key, { at: hit?.at ?? 0, value: hit?.value, inflight });
    return inflight;
  }

  /** What the desk will let today lose, given what is in the account. */
  get dailyLossLimitUsd() { return dailyLossLimitFor(this.lastBalance); }

  /** The last balance seen, for screens that price a size before it is sent. */
  get lastBalanceUsd(): number | null { return this.lastBalance; }

  /**
   * Contracts this account's margin could carry short, all in.
   *
   * What is already short counts towards it: the margin behind those contracts
   * is committed, not spent, so the ceiling is what is free plus what is
   * standing. Priced at the desk's own default leverage, which is the most it
   * will ever send without being told otherwise.
   *
   * `null` until a spot and a balance have both been seen -- a ceiling guessed
   * from nothing is exactly the decoration this is meant to avoid.
   */
  get shortCeilingContracts(): number | null {
    const spot = this.currentSpot();
    if (spot === null || this.lastBalance === null) return null;
    // Premium 0: the fee is a fraction of it, and this is a capacity figure
    // rather than the cost of one particular option.
    const per = fundsRequiredPerContract({
      spot, premium: 0, leverage: DEFAULT_LEVERAGE,
    });
    if (!(per > 0)) return null;
    return Math.floor(this.lastBalance / per) + this.lastShortContracts;
  }

  /** The cap the desk has been asked to hold itself to on the account it is trading on, if any. */
  get shortCapSetting(): number | null {
    const raw = accountSetting(this.settings, SHORT_CAP_KEY, this.currentAccountId);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }

  /** The cap actually in force: the setting, never above what margin allows. */
  get maxShortContracts(): number {
    return maxShortContractsFor(this.shortCeilingContracts, this.shortCapSetting);
  }

  /**
   * Change the cap. The server decides, the browser only asks.
   *
   * Returns the reason when it will not, so the screen can say why rather than
   * showing a number that quietly did not take.
   */
  async setShortCap(contracts: number): Promise<{ ok: true; cap: number } | { ok: false; reason: string }> {
    if (!Number.isFinite(contracts) || contracts < 1 || Math.floor(contracts) !== contracts) {
      return { ok: false, reason: 'The cap must be a whole number of contracts, at least 1.' };
    }
    const ceiling = this.shortCeilingContracts;
    if (ceiling !== null && contracts > ceiling) {
      return {
        ok: false,
        reason: `Margin covers ${ceiling} contracts at ${DEFAULT_LEVERAGE}x. A cap above that could never stop anything.`,
      };
    }
    // Kept for the account it was set on: its ceiling is that account's margin.
    await this.settings.set(accountKey(SHORT_CAP_KEY, this.currentAccountId), String(contracts));
    return { ok: true, cap: this.maxShortContracts };
  }

  list(limit = 50): Promise<TradeRecord[]> { return this.store.recent(limit); }
  async openTrades(): Promise<TradeRecord[]> { return (await this.store.open()).filter((r) => !isDone(r.state)); }

  /** One trade as the journal has it, or null. */
  trade(tradeId: string): Promise<TradeRecord | null> { return this.store.get(tradeId); }

  /** Paper mode only: lets the desk seed the simulated book from live quotes. */
  paper(): PaperExchange | null {
    return this.currentMode === 'paper' ? this.paperExchange : null;
  }
}

/** An exit asked for in a way that cannot stand -- a person's mistake, answered 400, not logged as a fault. */
export class ExitAskError extends Error {}

/*
 * ------------------------------------------------------------------ a desk per broker account
 *
 * Every active broker account trades at once (owner, 5 Oct 2026: "default is only which tab opens; once an
 * account is activated it trades"). A `TradingService` is one account's desk -- its own exchange, signed with
 * its own key, its own engine and poll loop, its own balance, limits and caches -- and there is one per active
 * account, each handed the journal through a store that sees only its own trades (`PgTradeStore.scoped`).
 * With no account at all there is the one desk there always was, on paper, seeing every trade.
 *
 * `tradingService()` is "the desk this piece of work is for": inside a request for an account, a trade or a
 * strategy it is that account's desk (`runAsDesk`); anywhere else it is the default account's. So the routes,
 * the scheduler and the alerts ask for the desk exactly as before and each reaches the right one.
 */
let singleton: TradingService | null = null;
/** One desk per active account, by account id. Empty on a desk with no account: `singleton` is then the only desk. */
const desks = new Map<number, TradingService>();
const deskContext = new AsyncLocalStorage<TradingService>();
/** How a desk's status is computed, registered once by the routes and run as each desk in turn. */
let statusForEveryDesk: (() => Promise<unknown>) | null = null;
/** The whole journal, for the screens that read every account's trades together ("All accounts"). Read-only use. */
let wholeJournal: PgTradeStore | null = null;
let deskLimits: Partial<RiskLimits> = {};

/** Do this piece of work as one account's desk: `tradingService()` inside it is that desk. */
export const runAsDesk = <T>(desk: TradingService, fn: () => T): T => deskContext.run(desk, fn);

/**
 * The desk of one broker account, or null when that account is not trading (switched off, removed, its key
 * unreadable). No account named (a strategy or a trade from a desk that had none): the default account's.
 */
export function tradingServiceFor(accountId: number | null | undefined): TradingService | null {
  if (!singleton) throw new Error('tradingServiceFor() before initTradingService(): the desk is built at boot, in index.ts');
  if (accountId === null || accountId === undefined || desks.size === 0) return singleton;
  return desks.get(accountId) ?? null;
}

/** Whether this account has a desk of its own running: it is switched on, its key opens, and it trades. */
export const deskOpen = (accountId: number): boolean => desks.has(accountId);

/** Every desk there is: one per active account, or the single one of a desk with no account. */
export const tradingServices = (): TradingService[] => (desks.size ? [...desks.values()] : singleton ? [singleton] : []);

/** The journal across every account, for reading. */
export const journal = (): PgTradeStore => {
  if (!wholeJournal) throw new Error('journal() before initTradingService()');
  return wholeJournal;
};

function deskFor(a: { id: number }, creds: Creds, settings: Settings, notifier: TelegramNotifier | null): TradingService {
  return new TradingService({ store: journal().scoped(a.id), settings, limits: deskLimits, creds, accountId: a.id, notifier });
}

/**
 * An account was switched on (or added): give it a desk and start it. Nothing if it already has one. The first
 * account of a desk that had none takes over from the paper-only desk there was.
 */
export async function openDesk(accountId: number): Promise<TradingService | null> {
  if (!singleton) return null;
  const existing = desks.get(accountId);
  if (existing) return existing;
  const creds = brokerAccounts().credsOf(accountId);
  const a = brokerAccounts().get(accountId);
  if (!creds || !a || !a.active) return null;
  const first = desks.size === 0;
  const before: TradingService = singleton;
  const desk = deskFor(a, creds, before.settings, before.notifier);
  desks.set(accountId, desk);
  if (first) { before.stop(); singleton = desk; }
  desk.beginStatus();
  if (started) await desk.start();
  return desk;
}

/** An account was switched off: its desk stops. Ask `openTrades()` of it first -- a desk holding a position is not closed. */
export function closeDesk(accountId: number): void {
  const desk = desks.get(accountId);
  if (!desk) return;
  desk.stop();
  desks.delete(accountId);
  if (singleton === desk) {
    const next: TradingService | undefined = desks.values().next().value;
    // None left trading: the paper-only desk of a desk with no account, over the whole journal.
    singleton = next ?? new TradingService({ store: journal(), settings: desk.settings, limits: deskLimits, notifier: desk.notifier });
  }
  if (started && desks.size === 0) void currentDesk().start();
}

/** Which desk answers when no account is named: the default account's, when it is trading. */
export function setPrimaryDesk(accountId: number): void {
  const desk = desks.get(accountId);
  if (desk) singleton = desk;
}

let started = false;
/** Start every desk: each picks up what was open on its own account and begins stepping. */
export async function startTradingServices(): Promise<void> {
  started = true;
  await Promise.all(tradingServices().map((d) => d.start()));
}

/**
 * Paper or live, for the whole desk: every account moves together, and none moves while any holds a position
 * (the rule `setMode` holds for one account, held across all of them).
 */
export async function setDeskMode(next: DeskMode): Promise<ModeSwitch> {
  const all = tradingServices();
  const now = all[0]?.mode ?? 'paper';
  for (const d of all) {
    if (d.mode === next) continue;
    const open = await d.openTrades();
    if (open.length > 0) {
      return { ok: false, mode: now, reason: `Close ${open.length} open ${open.length === 1 ? 'position' : 'positions'} first — a position cannot move between books.` };
    }
  }
  let last: ModeSwitch = { ok: true, mode: next };
  for (const d of all) {
    last = await d.setMode(next);
    if (!last.ok) return last;
  }
  return last;
}

/**
 * Build the process's desk: the journal migrated, the settings loaded, the
 * engine wired. Called once from the composition root before anything that
 * might ask for it -- a route, the scheduler, a sign-in alert.
 */
/**
 * The millisecond a trade id is stamped with, never the same one twice.
 *
 * A trade id is used once, and a second order under an id already taken is
 * read as the first one re-sent -- so two strategies placing the same contract
 * in the same millisecond would have had the second silently dropped. Now two
 * strategies may hold one contract (decision 0011), so the id moves on by a
 * millisecond rather than repeat.
 */
let lastTradeMs = 0;
export function nextTradeMs(now = Date.now()): number {
  lastTradeMs = Math.max(now, lastTradeMs + 1);
  return lastTradeMs;
}

export async function initTradingService(limits: Partial<RiskLimits> = {}): Promise<TradingService> {
  if (singleton) return tradingService();
  const settings = await deskSettings().load();
  // The broker accounts before the desks: which exchange each drives is decided as it is built.
  const accounts = await initBrokerAccounts(settings);
  wholeJournal = await PgTradeStore.open();
  deskLimits = limits;
  const trading = accounts.list().filter((a) => a.active && accounts.credsOf(a.id) !== null);
  if (trading.length === 0) {
    // No account trading: the one desk there always was, on paper, seeing the whole journal.
    singleton = new TradingService({ store: wholeJournal, settings, limits });
    return tradingService();
  }
  // The default account's desk first: it makes the phone's sender, and the rest share it.
  const order = [...trading].sort((x, y) => Number(y.isDefault) - Number(x.isDefault) || x.id - y.id);
  for (const a of order) {
    const shared: TradingService | null = singleton;
    const desk: TradingService = new TradingService({
      store: wholeJournal.scoped(a.id), settings, limits, creds: accounts.credsOf(a.id), accountId: a.id,
      ...(shared ? { notifier: shared.notifier } : {}),
    });
    desks.set(a.id, desk);
    singleton ??= desk;
  }
  return tradingService();
}

/** The desk in force right now -- the real object, for the places that must hold one. */
const currentDesk = (): TradingService => {
  const desk = deskContext.getStore() ?? singleton;
  if (!desk) throw new Error('tradingService() before initTradingService(): the desk is built at boot, in index.ts');
  return desk;
};

/*
 * What `tradingService()` hands out: not one desk, but whichever is in force when it is used. A route file
 * takes it once, when the routes are registered, and every request through it then reaches the desk of the
 * account that request is about.
 */
const deskHandle = new Proxy({} as TradingService, {
  get: (_t, key) => {
    const desk = currentDesk();
    const v = Reflect.get(desk, key, desk);
    return typeof v === 'function' ? v.bind(desk) : v;
  },
  set: (_t, key, value) => Reflect.set(currentDesk(), key, value),
  has: (_t, key) => Reflect.has(currentDesk(), key),
});

/** The desk, once `initTradingService()` has run. Asking earlier is a boot-order bug. */
export const tradingService = (): TradingService => {
  if (!singleton) throw new Error('tradingService() before initTradingService(): the desk is built at boot, in index.ts');
  return deskHandle;
};
