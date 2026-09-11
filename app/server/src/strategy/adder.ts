import type { AddRequest, TradeRecord } from '../trading/engine.js';
import type { Alert, AddOutcome } from '../notify/messages.js';
import { ADD_WINDOW_MS, decideAdds, targetBoughtBack, type AddQuote } from './add.js';
import { istDate, istMinutes } from './schedule.js';
import type { StrategyStore } from './store.js';
import type { Strategy } from './types.js';

/**
 * The part of adding to the other leg that touches the world.
 *
 * `add.ts` decides. This reads the prices it needs, writes each decision down
 * before acting on it, appends the contracts to the other leg's own trade
 * through the engine -- so every gate, the spread rule and the entry walk
 * apply, and that leg's target and stop are resized to cover them -- and tells
 * the phone when an add did not happen.
 *
 * Everything outside is passed in, so the whole path runs in a test against the
 * paper exchange, and against live prices without a live order.
 */

export type AddOrder = AddRequest & { tradeId: string };

export type PlaceResult = { ok: true } | { ok: false; reason: string };

export type AdderDeps = {
  store: Pick<StrategyStore, 'addedFor' | 'recordAdd' | 'finishAdd'>;
  /** One strategy's trades for the current IST day. */
  tradesToday: (strategyId: string) => TradeRecord[];
  quote: (symbol: string) => Promise<AddQuote | null>;
  /** Append to the trade: `TradeEngine.addToPosition`. */
  place: (order: AddOrder) => Promise<PlaceResult>;
  alert: (make: (ctx: { mode: 'live' | 'paper' }) => Alert | null) => void;
  addAlert: (r: AddOutcome, ctx: { mode: 'live' | 'paper' }) => Alert;
  now: () => number;
};

export class StrategyAdder {
  constructor(private readonly d: AdderDeps) {}

  /** Decide about, and act on, everything this strategy's targets have bought back. */
  async consider(s: Strategy): Promise<void> {
    const rule = s.config.addToOpposite;
    if (!rule || !s.enabled) return;

    const trades = this.d.tradesToday(s.id);
    // Only read prices when some target has bought back something undecided:
    // most ticks nothing has, and reading the board for nothing is not free.
    const undecided = trades.some((t) => targetBoughtBack(t).contracts > this.d.store.addedFor(t.state.tradeId));
    if (!undecided) return;

    const quotes = new Map<string, AddQuote>();
    for (const t of trades) {
      if (t.state.position === 0 || quotes.has(t.plan.symbol)) continue;
      const q = await this.d.quote(t.plan.symbol).catch(() => null);
      if (q) quotes.set(t.plan.symbol, q);
    }

    const now = this.d.now();
    const decisions = decideAdds({
      config: s.config,
      trades,
      decided: (id) => this.d.store.addedFor(id),
      quotes,
      now,
      nowIstMinutes: istMinutes(now),
    });

    for (const d of decisions) {
      if (d.act === 'wait') continue;
      // Written first. If this returns null, the contracts were decided about
      // since the decision was made -- by a restart or a second caller -- and
      // acting again is exactly the double add the journal exists to stop.
      const row = this.d.store.recordAdd({
        strategyId: s.id,
        runDate: istDate(now),
        sourceTradeId: d.source.state.tradeId,
        sourceSide: d.source.plan.optionSide,
        symbol: d.opposite?.plan.symbol ?? null,
        boughtBack: d.boughtBack,
        status: d.act === 'add' ? 'placing' : 'skipped',
        detail: d.detail,
        at: now,
      });
      if (!row) continue;

      const tell = (status: AddOutcome['status'], detail: string) => this.d.alert((ctx) => this.d.addAlert({
        strategy: s.name, sourceTradeId: d.source.state.tradeId, status, detail, at: now,
      }, ctx));

      if (d.act === 'skip') {
        tell('skipped', d.detail);
        continue;
      }

      const c = s.config;
      /*
       * The entry logic the strategy already uses, with the minimum as a floor.
       *
       *   now    at the bid straight away, but never under the minimum: "now"
       *          was a promise about speed, not about taking any price at all.
       *   offer  rest at the ask and walk toward the bid over the same seconds,
       *   set    spread rule on, never under the minimum. A set price belongs to
       *          the morning's entry; for an add made at 7 it would mean nothing,
       *          so a set strategy adds the way an offer strategy does.
       */
      const crossNow = c.entryPrice === 'now';
      const order: AddOrder = {
        tradeId: d.opposite.state.tradeId,
        size: row.contracts,
        limitPrice: crossNow
          ? Math.max(d.quote.bid ?? rule.minPriceUsd, rule.minPriceUsd)
          : Math.max(d.quote.ask ?? d.quote.bid ?? rule.minPriceUsd, rule.minPriceUsd),
        // Zero rests at the offer, as it does at entry; the window still ends it.
        chaseSeconds: crossNow ? 0 : c.crossAfterSec,
        maxCrossSpreadPct: crossNow ? null : (c.maxCrossSpreadPct ?? 0.15),
        floorPrice: rule.minPriceUsd,
        timeoutMs: ADD_WINDOW_MS,
        source: { tradeId: d.source.state.tradeId, optionSide: d.source.plan.optionSide, boughtBack: row.contracts },
      };

      try {
        const res = await this.d.place(order);
        if (res.ok) {
          this.d.store.finishAdd(row.id, 'placed', d.detail, d.opposite.state.tradeId);
        } else {
          const detail = `${d.detail} — refused: ${res.reason}`;
          this.d.store.finishAdd(row.id, 'refused', detail, d.opposite.state.tradeId);
          tell('refused', detail);
        }
      } catch (e) {
        const detail = `${d.detail} — failed: ${(e as Error).message}`;
        this.d.store.finishAdd(row.id, 'failed', detail, d.opposite.state.tradeId);
        tell('failed', detail);
      }
    }
  }
}
