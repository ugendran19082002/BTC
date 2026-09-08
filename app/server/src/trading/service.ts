import { config } from '../config.js';
import { credsFromEnv } from '../delta/signed.js';
import { TradeEngine, type TradePlan, type TradeRecord } from './engine.js';
import { SqliteTradeStore } from './store.js';
import { DeltaExchange } from './exchange/delta.js';
import { PaperExchange } from './exchange/paper.js';
import { DEFAULT_LIMITS, type RiskLimits } from './precheck.js';
import { isDone } from './machine.js';
import type { ExchangePort } from './exchange/port.js';
import type { TradeState } from './types.js';

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
/** A sold option with no stop is an unbounded loss, so one is always derived. */
const STOP_MULTIPLE = 2.5;
const TARGET_FRACTION = 0.05;

export type DeskMode = 'live' | 'paper';

export class TradingService {
  readonly mode: DeskMode;
  readonly store: SqliteTradeStore;
  private readonly exchange: ExchangePort;
  private readonly engine: TradeEngine;
  private timer: NodeJS.Timeout | null = null;
  private feedOk = true;
  private stepping = false;
  readonly alarms: { tradeId: string; message: string; at: number }[] = [];

  constructor(limits: Partial<RiskLimits> = {}) {
    const creds = credsFromEnv();
    this.mode = config.liveTrading && creds ? 'live' : 'paper';
    this.exchange = this.mode === 'live' ? new DeltaExchange(creds) : new PaperExchange({ balanceUsd: 1_000 });
    this.store = new SqliteTradeStore();
    this.engine = new TradeEngine({
      exchange: this.exchange,
      store: this.store,
      now: () => Date.now(),
      limits: { ...DEFAULT_LIMITS, ...limits },
      tradingEnabled: true,
      feedHealthy: () => this.feedOk,
      dayPnlUsd: () => this.store.realisedSince(startOfDayIst()),
      onAlarm: (t, message) => {
        this.alarms.unshift({ tradeId: t.tradeId, message, at: Date.now() });
        this.alarms.length = Math.min(this.alarms.length, 50);
      },
    });
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
    /** Absent means take what the book offers. */
    limitPrice?: number;
    takeProfitPrice?: number | null;
    stopPrice?: number | null;
    timeoutMs?: number;
    marketFallback?: boolean;
  }) {
    const price = input.limitPrice;
    const plan: TradePlan = {
      tradeId: `${input.symbol}-${Date.now()}`,
      symbol: input.symbol,
      optionSide: input.optionSide,
      lots: input.lots,
      entry: price === undefined
        ? { type: 'market', timeoutMs: input.timeoutMs ?? 5_000, marketFallback: false }
        : {
            type: 'limit', limitPrice: price,
            timeoutMs: input.timeoutMs ?? 5_000,
            marketFallback: input.marketFallback ?? false,
          },
      // If the caller does not set a stop, one is derived rather than left off.
      takeProfitPrice: input.takeProfitPrice ?? (price !== undefined ? round1(price * TARGET_FRACTION) : null),
      stopPrice: input.stopPrice ?? (price !== undefined ? round1(price * STOP_MULTIPLE) : null),
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
  reconcile(tradeId: string) { return this.engine.reconcile(tradeId); }
  quote(symbol: string) { return this.exchange.getQuote(symbol); }
  product(symbol: string) { return this.exchange.getProduct(symbol); }
  positions() { return this.exchange.getPositions(); }
  balance() { return this.exchange.getBalanceUsd(); }

  list(limit = 50): TradeRecord[] { return this.store.recent(limit); }
  openTrades(): TradeRecord[] { return this.store.open().filter((r) => !isDone(r.state)); }

  /** Paper mode only: lets the desk seed the simulated book from live quotes. */
  paper(): PaperExchange | null {
    return this.exchange instanceof PaperExchange ? this.exchange : null;
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
