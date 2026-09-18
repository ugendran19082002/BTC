import type { AddRequest, TradeRecord } from '../trading/engine.js';
import type { OptionSide } from '../trading/types.js';
import { ADD_WINDOW_MS } from './add.js';
import { decideRebalance, type RebalanceQuote } from './rebalance.js';
import { istDate, istMinutes } from './schedule.js';
import { minutesOf } from './types.js';
import type { StrategyStore } from './store.js';
import type { Strategy } from './types.js';

/**
 * The part of the rebalance that touches the world.
 *
 * `rebalance.ts` decides; this reads the two books, counts the confirmations,
 * writes the stage down **before** anything is sent, and then acts in the one
 * order that is safe:
 *
 *   1. **Buy back** the lots on the side that fell.
 *   2. Only if that filled, **sell** the same number on the side that rose.
 *
 * Never the other way round. If the buy fails the desk ends up flatter than it
 * started, which is a smaller position than the one it already had; if the sell
 * fails after the buy, the same is true. Selling first and failing to buy is
 * the one outcome that leaves more risk on than anybody asked for, so it is the
 * one order this never uses.
 *
 * The confirmations are counted in memory, on purpose: a restart should start
 * counting again rather than act on a reading taken before it was running.
 */

export type RebalanceOrder = AddRequest & { tradeId: string };

export type PlaceResult = { ok: true } | { ok: false; reason: string };

export type RebalancerDeps = {
  store: Pick<StrategyStore, 'rebalanceState' | 'recordRebalance' | 'finishRebalance'>;
  /** One strategy's trades for the current IST day. */
  tradesToday: (strategyId: string) => TradeRecord[];
  quote: (symbol: string) => Promise<RebalanceQuote | null>;
  /** Buy back part of a position at the market: `TradingService.close(tradeId, lots)`. */
  buyBack: (tradeId: string, lots: number) => Promise<PlaceResult>;
  /** Sell more of the other leg, under its own trade: `TradeEngine.addToPosition`. */
  sell: (order: RebalanceOrder) => Promise<PlaceResult>;
  /** Say something happened, in the desk's own words. */
  tell?: (text: string) => void;
  now: () => number;
};

const legOn = (trades: TradeRecord[], side: OptionSide): TradeRecord | null =>
  trades
    .filter((t) => t.plan.optionSide === side && t.state.entrySize > 0)
    .sort((a, b) => Math.abs(b.state.position) - Math.abs(a.state.position))[0] ?? null;

export class StrategyRebalancer {
  /** Consecutive readings that asked for the same stage on the same side. */
  private confirmations = new Map<string, { key: string; n: number }>();

  constructor(private readonly d: RebalancerDeps) {}

  /** One look at one strategy. Called on the same tick as everything else. */
  async consider(s: Strategy): Promise<void> {
    const rule = s.config.rebalance;
    if (!rule || !rule.enabled || !s.enabled) return;

    const trades = this.d.tradesToday(s.id);
    const ce = legOn(trades, 'CE');
    const pe = legOn(trades, 'PE');
    if (!ce || !pe) return;

    const now = this.d.now();
    const runDate = istDate(now);
    const { stagesDone, lockedUpSide } = this.d.store.rebalanceState(s.id, runDate);

    const [ceQuote, peQuote] = await Promise.all([
      this.d.quote(ce.state.symbol).catch(() => null),
      this.d.quote(pe.state.symbol).catch(() => null),
    ]);

    const decision = decideRebalance({
      rule,
      legs: { ce, pe },
      quotes: { ce: ceQuote, pe: peQuote },
      stagesDone,
      lockedUpSide,
      nowIstMinutes: istMinutes(now),
      entryIstMinutes: minutesOf(s.config.entryTime),
      endIstMinutes: minutesOf(rule.endTime),
      referencePremium: s.config.premium?.usd ?? null,
    });

    if (decision.act === 'wait') {
      // A condition that stops holding resets the count: "two consecutive
      // readings" means consecutive, not two readings at any distance.
      this.confirmations.delete(s.id);
      return;
    }

    if (decision.act === 'skip') {
      const row = this.d.store.recordRebalance({
        strategyId: s.id, runDate, stage: decision.stage,
        upSide: 'CE', downSide: 'PE', upPct: null, downPct: null,
        lots: 0, status: 'skipped', detail: decision.detail, at: now,
      });
      if (row) this.d.tell?.(`Rebalance stage ${decision.stage} skipped: ${decision.detail}`);
      this.confirmations.delete(s.id);
      return;
    }

    // Confirmed over N readings of the same stage and the same direction.
    const key = `${decision.stage}:${decision.up.side}`;
    const seen = this.confirmations.get(s.id);
    const n = seen && seen.key === key ? seen.n + 1 : 1;
    this.confirmations.set(s.id, { key, n });
    if (n < rule.confirmTicks) return;
    this.confirmations.delete(s.id);

    /*
     * Written before a single order goes out, and refused by the file if this
     * stage already has a row. A crash here costs one missed stage; the other
     * way round costs a second rebalance nobody asked for.
     */
    const row = this.d.store.recordRebalance({
      strategyId: s.id, runDate, stage: decision.stage,
      upSide: decision.up.side, downSide: decision.down.side,
      upPct: decision.up.pct, downPct: decision.down.pct,
      lots: decision.lots, status: 'placing', detail: decision.detail, at: now,
    });
    if (!row) return;

    const bought = await this.d.buyBack(decision.down.rec.state.tradeId, decision.lots)
      .catch((e: Error) => ({ ok: false as const, reason: e.message }));
    if (!bought.ok) {
      this.d.store.finishRebalance(row.id, 'failed', `buy back refused: ${bought.reason}`);
      this.d.tell?.(`Rebalance stage ${decision.stage} failed to buy back ${decision.lots} ${decision.down.side}: ${bought.reason}`);
      return;
    }

    const sold = await this.d.sell({
      tradeId: decision.up.rec.state.tradeId,
      size: decision.lots,
      // Rest at the offer and walk to the bid over the strategy's own seconds,
      // exactly as its entry and its adds do.
      limitPrice: decision.up.quote.ask ?? decision.up.quote.bid ?? decision.up.price ?? 0,
      /*
       * The rule's own seconds when it has them, the strategy's entry seconds
       * otherwise -- which is what every rule saved before the control existed
       * used. A "now" entry crosses at once and has nothing to wait for.
       */
      chaseSeconds: s.config.entryPrice === 'now' ? 0 : (rule.crossAfterSec ?? s.config.crossAfterSec),
      maxCrossSpreadPct: s.config.maxCrossSpreadPct ?? null,
      // Never sold under the bid that was on the screen when the stage fired.
      floorPrice: decision.up.quote.bid ?? decision.up.price ?? 0,
      timeoutMs: ADD_WINDOW_MS,
      source: { tradeId: decision.down.rec.state.tradeId, optionSide: decision.down.side, boughtBack: decision.lots },
    }).catch((e: Error) => ({ ok: false as const, reason: e.message }));

    if (!sold.ok) {
      /*
       * The safe half of the failure: the buy-back filled, so the position is
       * smaller than it was. Recorded as partial rather than failed, because
       * half of this did happen and the journal is what the morning reads.
       */
      this.d.store.finishRebalance(row.id, 'partial',
        `${decision.detail} — bought back ${decision.lots} ${decision.down.side}; the sell was refused: ${sold.reason}`,
        { bought: decision.down.rec.state.tradeId });
      this.d.tell?.(`Rebalance stage ${decision.stage}: bought back ${decision.lots} ${decision.down.side}, `
        + `but selling ${decision.up.side} was refused: ${sold.reason}`);
      return;
    }

    this.d.store.finishRebalance(row.id, 'done', decision.detail, {
      bought: decision.down.rec.state.tradeId,
      sold: decision.up.rec.state.tradeId,
    });
    this.d.tell?.(`Rebalance stage ${decision.stage}: bought back ${decision.lots} ${decision.down.side}, `
      + `sold ${decision.lots} more ${decision.up.side}.`);
  }
}
