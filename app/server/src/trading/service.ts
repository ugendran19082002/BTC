import { config } from '../config.js';
import { credsFromEnv } from '../delta/signed.js';
import { TradeEngine, type AddRequest, type TradePlan, type TradeRecord } from './engine.js';
import { PgTradeStore } from './store.js';
import { settings as deskSettings, type Settings } from '../db/settings.js';
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
import { istDate } from '../strategy/schedule.js';
import type { MtmSample } from './pnl-history.js';
import { candles } from '../market/delta.js';
import { noteError } from '../observability/errors.js';
import { alertFor, bookWentFlat, daySummaryFor } from '../notify/messages.js';
import { TelegramNotifier } from '../notify/telegram.js';
import { BEST_TRADE_REPEAT_DEFAULT, BEST_TRADE_REPEAT_MAX, bestTradeText } from '../notify/best-trade-alert.js';
import {
  AUTO_TRADE_DEFAULTS, cleanAutoTradeLimits, cleanAutoTradeSettings, decideAutoTrade,
  type AutoTradeLedger, type AutoTradeLimits, type AutoTradeSettings,
} from './auto-trade.js';
import { bestTradeNow } from '../domain/best-trade-now.js';
import { BEST_TRADE_MIN_PREMIUM_USD } from '../domain/best-trade.js';
import { hoursSinceDeskOpen, liveChain, WHOLE_BOARD, type Snapshot } from '../market/chain.js';
import { readMarket, type MarketRead } from '../market/moves.js';
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
/** How often the day's P&L is written down. A minute draws a day in 720 points. */
const MTM_SAMPLE_MS = 60_000;
const BEST_TRADE_WATCH_MS = 60_000;
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
};

export class TradingService {
  readonly store: PgTradeStore;
  /** The desk's remembered choices: the mode, the cap, the alert switches. */
  readonly settings: Settings;
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

  constructor({ store, settings, limits = {} }: TradingServiceDeps) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.store = store;
    this.settings = settings;
    this.notifier = config.telegram
      ? new TelegramNotifier({
          ...config.telegram,
          onError: (message, context) => noteError({ source: 'server', level: 'warn', message, where: 'telegram', context }),
        })
      : null;
    const creds = credsFromEnv();
    this.live = creds ? new DeltaExchange(creds) : null;
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
      dayPnlUsd: () => this.store.realisedSince(startOfDayIst()),
      spot: () => this.lastSpot,
      // The option's own candles, for a stop the strategy asked to watch on
      // the close rather than on the touch.
      candles: (symbol, startSec, endSec, resolution) => candles(symbol, startSec, endSec, resolution),
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
      // The mode is read at the moment of the fill, not captured, so a paper
      // fill can never reach the phone dressed as a live one.
      onEvent: async (event, before, after, plan) => {
        if (!this.notifier || !this.alertsOn) return;
        const alert = alertFor(event, before, after, plan, { mode: this.currentMode });
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


  /** One strategy's trades touched since the start of the IST day. */
  async tradesTodayFor(strategyId: string, now = Date.now()): Promise<TradeRecord[]> {
    return (await this.store.between(startOfDayIst(now), now + 1)).filter((r) => r.plan.strategyId === strategyId);
  }

  /** One message for the whole day, sent when nothing is held any more. */
  private async announceDay(workingOrders: number): Promise<void> {
    const now = Date.now();
    const dayStart = startOfDayIst(now);
    const summary = daySummaryFor(await this.store.between(dayStart, now + 1), {
      mode: this.currentMode, dayStart, at: now, spot: this.lastSpot, workingOrders,
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
      return { ok: false, mode: this.currentMode, reason: 'No Delta credentials configured.' };
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
    // The best-pick watcher reads the whole board once a minute, which is the
    // cadence the pick actually changes at; the chain it reads is the cached one.
    this.alertTimer ??= setInterval(() => {
      // The message first, then the order: the same board, the same minute, and
      // the phone hears about a pick whether or not the desk is armed to sell it.
      void this.watchBestTrade().then(() => this.autoTradeBestPick());
    }, BEST_TRADE_WATCH_MS);
    this.alertTimer.unref?.();
    await this.store.pruneMtm(Date.now());
    return recovered;
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.mtmTimer) { clearInterval(this.mtmTimer); this.mtmTimer = null; }
    if (this.alertTimer) { clearInterval(this.alertTimer); this.alertTimer = null; }
    if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
  }

  private mtmTimer: NodeJS.Timeout | null = null;
  private alertTimer: NodeJS.Timeout | null = null;

  /**
   * "Tell me when the best pick changes."
   *
   * A switch on the best-pick card. Once a minute the whole board is read, the
   * pick worked out the same way the card works it out (`bestTradeNow`), and
   * if it names a different strike from the last one announced -- or names
   * one where there was none -- the phone hears. Not every minute, and not
   * when the same strike is still the pick: a message that repeats what the
   * last message said is one that teaches you to ignore the next.
   *
   * Remembered in the journal (`best_trade_alert`, `best_trade_min_premium`,
   * `best_trade_last`) so the switch and the last announcement survive a
   * deploy. Honours the phone-alerts switch like every other message.
   */
  get bestTradeAlertOn(): boolean {
    return this.settings.get('best_trade_alert') === '1';
  }

  async setBestTradeAlertOn(on: boolean): Promise<void> {
    await this.settings.set('best_trade_alert', on ? '1' : '0');
    // A fresh switch-on announces the current pick rather than waiting for a
    // change; forgetting the last one -- and what has been sent this contract --
    // is what makes that happen. Switching on is somebody asking to hear it.
    if (on) {
      await this.settings.set('best_trade_last', '');
      await this.settings.set('best_trade_sent', '');
    }
  }

  get bestTradeMinPremiumUsd(): number {
    const v = Number(this.settings.get('best_trade_min_premium'));
    return Number.isFinite(v) && v > 0 ? v : BEST_TRADE_MIN_PREMIUM_USD;
  }

  setBestTradeMinPremiumUsd(usd: number): Promise<void> {
    return this.settings.set('best_trade_min_premium', String(usd));
  }

  /**
   * How many times one strike may be announced for one contract.
   *
   * A contract is listed at 5:30 PM and expires at 5:30 PM the next day, so this
   * is "per strike, from 5:31 PM to 5:30 PM tomorrow". One by default: a pick
   * that goes CE 78,800 → CE 79,000 → CE 78,800 is one piece of news about
   * 78,800, not two.
   */
  get bestTradeRepeat(): number {
    const v = Number(this.settings.get('best_trade_repeat'));
    return Number.isInteger(v) && v >= 1 && v <= BEST_TRADE_REPEAT_MAX ? v : BEST_TRADE_REPEAT_DEFAULT;
  }

  setBestTradeRepeat(times: number): Promise<void> {
    const v = Math.min(BEST_TRADE_REPEAT_MAX, Math.max(1, Math.round(times)));
    return this.settings.set('best_trade_repeat', String(v));
  }

  async watchBestTrade(
    now = Date.now(),
    /** The board to read, for tests; the live one otherwise. */
    board?: { snap: Snapshot; market: MarketRead | null },
  ): Promise<'off' | 'unchanged' | 'sent' | 'repeat' | 'no board'> {
    if (!this.bestTradeAlertOn) return 'off';
    const snap = board?.snap ?? await liveChain(WHOLE_BOARD).catch(() => null);
    if (!snap || !snap.live) return 'no board';
    const market = board ? board.market : await readMarket(hoursSinceDeskOpen(snap.ts)).catch(() => null);
    const best = bestTradeNow({
      snap, market, lots: 10, hedgeGap: 3, minPremiumUsd: this.bestTradeMinPremiumUsd,
    });
    const key = best.pick && !best.bestOfNone ? `${best.pick.side}-${best.pick.strike}-${snap.expiry}` : '';
    const last = this.settings.get('best_trade_last') ?? '';
    if (key === last) return 'unchanged';
    await this.settings.set('best_trade_last', key);
    if (!key) return 'unchanged';   // it went away; nothing to say until something comes back

    /*
     * The cap: how many times this strike has been announced for this
     * contract. Kept per expiry, so a new contract starts from nothing -- which
     * is the 5:31 PM reset, without a clock in sight.
     *
     * Counted whether or not the phone was listening: turning phone alerts off
     * is a choice to hear nothing, not a request to be told later.
     */
    const sent = this.bestTradeSent(snap.expiry);
    const n = (sent.counts[key] ?? 0) + 1;
    if (n > this.bestTradeRepeat) return 'repeat';
    sent.counts[key] = n;
    await this.settings.set('best_trade_sent', JSON.stringify(sent));

    if (this.notifier && this.alertsOn) {
      this.notifier.notify({
        key: 'best-trade',
        text: bestTradeText(best, snap.expiry, this.currentMode, now, { n, of: this.bestTradeRepeat }),
      });
    }
    return 'sent';
  }

  /*
   * Selling the best pick by itself.
   *
   * Armed from the card, off by default, and every rule about *not* trading
   * lives in `auto-trade.ts` where it can be tested without an exchange. This
   * is the acting half: read the board, ask, write the decision down *before*
   * placing, then place through the same `place()` the ticket uses -- same
   * engine, same prechecks, same protection.
   *
   * Written first, always. A crash between the order and the note is how a
   * desk sells the same strike twice, so the note goes down first and a refusal
   * is kept as well as a fill: a strike the gates turned down is not asked
   * about again this contract.
   */
  get autoTrade(): AutoTradeSettings {
    try {
      const raw = JSON.parse(this.settings.get('auto_trade') || 'null') as Partial<AutoTradeSettings> | null;
      return cleanAutoTradeSettings(raw ?? {}, this.autoTradeLimits);
    } catch {
      return { ...AUTO_TRADE_DEFAULTS };
    }
  }

  async setAutoTrade(patch: Partial<AutoTradeSettings>): Promise<AutoTradeSettings> {
    const next = cleanAutoTradeSettings({ ...this.autoTrade, ...patch }, this.autoTradeLimits);
    await this.settings.set('auto_trade', JSON.stringify(next));
    return next;
  }

  /**
   * The ceilings the settings are held to -- themselves settings.
   *
   * Editable from the same card, because a number in the source standing
   * between somebody and a trade they meant to make is not a safety feature.
   * The hard ceilings behind them are not editable.
   */
  get autoTradeLimits(): AutoTradeLimits {
    try {
      const raw = JSON.parse(this.settings.get('auto_trade_limits') || 'null') as Partial<AutoTradeLimits> | null;
      return cleanAutoTradeLimits(raw);
    } catch {
      return cleanAutoTradeLimits(null);
    }
  }

  async setAutoTradeLimits(patch: Partial<AutoTradeLimits>): Promise<AutoTradeLimits> {
    const next = cleanAutoTradeLimits({ ...this.autoTradeLimits, ...patch });
    await this.settings.set('auto_trade_limits', JSON.stringify(next));
    // A tighter ceiling pulls the settings under it at once, rather than
    // leaving 50 lots armed under a new limit of 10.
    await this.setAutoTrade({});
    return next;
  }

  /**
   * The contract the last board read was about, for the screen's "already sold
   * automatically" list. Absent until a board has been read at all.
   */
  get autoTradeExpiry(): string | null {
    try {
      const v = JSON.parse(this.settings.get('auto_trade_done') || 'null') as { expiry?: unknown } | null;
      return typeof v?.expiry === 'string' ? v.expiry : null;
    } catch {
      return null;
    }
  }

  /** What has been sold automatically for this contract. */
  autoTradeLedger(expiry: string): AutoTradeLedger {
    try {
      const v = JSON.parse(this.settings.get('auto_trade_done') || 'null') as AutoTradeLedger | null;
      if (v && v.expiry === expiry && v.entries && typeof v.entries === 'object') return v;
    } catch { /* unreadable is the same as nothing traded */ }
    return { expiry, entries: {} };
  }

  /**
   * Forget what has been sold automatically on this contract.
   *
   * The one way back from "already sold" and "refused earlier" without waiting
   * for 5:31 PM: somebody who has read the refusal and dealt with it can ask
   * for the strike to be considered again. It clears the note, never a position.
   */
  clearAutoTradeLedger(): Promise<void> {
    return this.settings.set('auto_trade_done', '');
  }

  private writeAutoTrade(ledger: AutoTradeLedger, key: string, entry: AutoTradeLedger['entries'][string]): Promise<void> {
    const next: AutoTradeLedger = { expiry: ledger.expiry, entries: { ...ledger.entries, [key]: entry } };
    return this.settings.set('auto_trade_done', JSON.stringify(next));
  }

  async autoTradeBestPick(
    now = Date.now(),
    board?: { snap: Snapshot; market: MarketRead | null },
  ): Promise<{ act: 'skip'; why: string } | { act: 'placed'; tradeId: string } | { act: 'refused'; why: string }> {
    const settings = this.autoTrade;
    if (!settings.on) return { act: 'skip', why: 'off' };
    const snap = board?.snap ?? await liveChain(WHOLE_BOARD).catch(() => null);
    if (!snap) return { act: 'skip', why: 'no board' };
    const market = board ? board.market : await readMarket(hoursSinceDeskOpen(snap.ts)).catch(() => null);
    const best = bestTradeNow({
      snap, market, lots: settings.lots, hedgeGap: 3, minPremiumUsd: this.bestTradeMinPremiumUsd,
    });
    const ledger = this.autoTradeLedger(snap.expiry);
    const decision = decideAutoTrade({
      settings,
      best,
      snap,
      // Anything the desk is already carrying or working, whoever opened it.
      openSymbols: (await this.store.all()).filter((r) => r.state.position !== 0 || r.state.entrySize > 0)
        .map((r) => r.state.symbol),
      ledger,
      symbolFor: (side, strike) => `${side === 'CE' ? 'C' : 'P'}-BTC-${strike}-${snap.expiry}`,
    });
    if (decision.act === 'skip') return decision;

    // Written before the order goes out: a crash here costs one missed trade,
    // never a second copy of one.
    await this.writeAutoTrade(ledger, decision.key, { at: now, status: 'placed' });
    const res = await this.place({
      origin: 'best-pick',
      symbol: decision.symbol,
      optionSide: decision.side,
      strike: decision.strike,
      expiryTs: snap.expiryTs,
      lots: decision.lots,
      takeProfitPct: decision.takeProfitPct,
      stopLossPct: decision.stopLossPct,
      chaseSeconds: decision.chaseSeconds,
    }).catch((e: Error) => ({ ok: false as const, reason: e.message }));

    if (!res.ok) {
      const why = 'precheck' in res && !res.precheck.ok
        ? res.precheck.failures.map((f) => f.message).join('; ')
        : ('reason' in res && typeof res.reason === 'string' ? res.reason : 'the desk would not place it');
      await this.writeAutoTrade(ledger, decision.key, { at: now, status: 'refused', detail: why });
      if (this.notifier && this.alertsOn) {
        this.notifier.notify({
          // Per decision: two strikes refused in the same minute are two
          // messages, not the second one quietly replacing the first.
          key: `auto-trade:${decision.key}`,
          text: `🤖 Auto-trade did not sell ${decision.side} ${decision.strike.toLocaleString('en-IN')}: ${why}`,
        });
      }
      return { act: 'refused', why };
    }
    const tradeId = 'state' in res ? res.state.tradeId : decision.key;
    await this.writeAutoTrade(ledger, decision.key, { at: now, status: 'placed', tradeId });
    return { act: 'placed', tradeId };
  }

  /** What has been announced for this contract, or a clean slate for a new one. */
  private bestTradeSent(expiry: string): { expiry: string; counts: Record<string, number> } {
    try {
      const v = JSON.parse(this.settings.get('best_trade_sent') || 'null') as { expiry?: unknown; counts?: unknown } | null;
      if (v && v.expiry === expiry && v.counts && typeof v.counts === 'object') {
        return { expiry, counts: v.counts as Record<string, number> };
      }
    } catch { /* unreadable is the same as nothing sent */ }
    return { expiry, counts: {} };
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
  async todayFigures(now = Date.now()): Promise<Omit<MtmSample, 'at' | 'day'>> {
    const dayStart = startOfDayIst(now);
    const realisedUsd = await this.store.realisedSince(dayStart);
    const positions = await this.positionsForDisplay(now);
    let unrealisedUsd = 0;
    for (const rec of await this.openTrades()) {
      const live = positions.find((p) => p.symbol === rec.state.symbol) ?? null;
      const quote = await this.quoteForDisplay(rec.state.symbol, now);
      const mark = live?.markPrice ?? quote?.mark ?? midOf(quote?.bid ?? null, quote?.ask ?? null);
      unrealisedUsd += unrealisedPnlUsd({
        entryPrice: rec.state.entryAvgPrice, markPrice: mark,
        size: live?.size ?? rec.state.position, contractValue: rec.state.contractValue,
      }) ?? 0;
    }
    const chargesUsd = (await this.store.between(dayStart, now + 1))
      .reduce((n, rec) => n + tradeCharges(rec.state, { spot: this.lastSpot, since: dayStart }).totalUsd, 0);
    return { realisedUsd, unrealisedUsd, chargesUsd, netUsd: realisedUsd + unrealisedUsd - chargesUsd };
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
      await this.store.sampleMtm({ at: now, day: istDate(now), ...f });
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
    try {
      for (const rec of await this.store.open()) {
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
  async place(input: PlaceInput) {
    return this.engine.open(orderPlan(input, `${input.symbol}-${Date.now()}`));
  }

  /** Whether that order would be taken, without sending it. */
  async wouldPlace(input: PlaceInput) {
    return this.engine.previewOpen(orderPlan(input, `preview-${input.symbol}-${Date.now()}`));
  }

  /** Buy back at the market: `lots` of it, or all of it when none is given. */
  close(tradeId: string, lots?: number) { return this.engine.closeNow(tradeId, 'manual exit', lots); }
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
  async updateExits(tradeId: string, ask: ExitAsk) {
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
    return this.engine.updateProtection(tradeId, protectionFor(entry, ask), follow);
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
  get spot() { return this.lastSpot; }
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

  /** The route registers how the status is computed; the service keeps it fresh. */
  provideStatus(compute: () => Promise<unknown>): void {
    this.statusCompute = compute;
    this.statusTimer ??= setInterval(() => { void this.refreshStatus(); }, STATUS_REFRESH_MS);
    this.statusTimer.unref?.();
    void this.refreshStatus();
  }

  private async refreshStatus(now = Date.now()): Promise<void> {
    if (!this.statusCompute) return;
    try {
      const value = await this.coalesce('status', STATUS_TTL_MS, this.statusCompute, now);
      this.statusLast = { at: now, value };
    } catch {
      // A refresh that fails leaves the last good answer in place; the route's
      // staleness rule decides whether that is still worth serving.
    }
  }

  async status<T>(now = Date.now()): Promise<T> {
    if (this.statusLast && now - this.statusLast.at < STATUS_STALE_MS) return this.statusLast.value as T;
    if (!this.statusCompute) throw new Error('status not provided');
    const value = await this.coalesce('status', STATUS_TTL_MS, this.statusCompute, now);
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
    if (this.lastSpot === null || this.lastBalance === null) return null;
    // Premium 0: the fee is a fraction of it, and this is a capacity figure
    // rather than the cost of one particular option.
    const per = fundsRequiredPerContract({
      spot: this.lastSpot, premium: 0, leverage: DEFAULT_LEVERAGE,
    });
    if (!(per > 0)) return null;
    return Math.floor(this.lastBalance / per) + this.lastShortContracts;
  }

  /** The cap the desk has been asked to hold itself to, if any. */
  get shortCapSetting(): number | null {
    const raw = this.settings.get(SHORT_CAP_KEY);
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
    await this.settings.set(SHORT_CAP_KEY, String(contracts));
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

/** 05:30 IST is when the daily contract opens, so that is where the day starts. */
function startOfDayIst(now = Date.now()): number {
  const IST = 5.5 * 3600_000;
  const local = now + IST;
  const midnight = Math.floor(local / 86_400_000) * 86_400_000;
  return midnight - IST;
}

let singleton: TradingService | null = null;

/**
 * Build the process's desk: the journal migrated, the settings loaded, the
 * engine wired. Called once from the composition root before anything that
 * might ask for it -- a route, the scheduler, a sign-in alert.
 */
export async function initTradingService(limits: Partial<RiskLimits> = {}): Promise<TradingService> {
  if (singleton) return singleton;
  const settings = await deskSettings().load();
  const store = await PgTradeStore.open();
  singleton = new TradingService({ store, settings, limits });
  return singleton;
}

/** The desk, once `initTradingService()` has run. Asking earlier is a boot-order bug. */
export const tradingService = (): TradingService => {
  if (!singleton) throw new Error('tradingService() before initTradingService(): the desk is built at boot, in index.ts');
  return singleton;
};

/** For tests that build a fresh desk against a fresh database. */
export function resetTradingService(): void {
  singleton?.stop();
  singleton = null;
}
