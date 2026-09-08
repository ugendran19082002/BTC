import type { Fill, OrderRole, TradeEvent, TradePhase, TradeState, OptionSide } from './types.js';

/**
 * The trade lifecycle as a pure reducer.
 *
 * Two rules run through all of it:
 *
 *  1. The position is *counted from fills*, never assumed from what we asked
 *     for. A request for 100 that fills 40 is a position of 40. Everything
 *     downstream -- the stop size, the target size, the P&L -- reads the count.
 *
 *  2. `reconciled` is the exchange speaking, and it always wins. If it says the
 *     position is zero, the position is zero, whatever we thought a moment ago.
 *
 * Nothing here does I/O, so every case in the test matrix can be built by hand.
 */

export function initialTrade(args: {
  tradeId: string;
  symbol: string;
  productId: number;
  optionSide: OptionSide;
  requestedSize: number;
  at: number;
  /** False when the trade deliberately runs without a stop. */
  wantsProtection?: boolean;
  /** BTC per contract. Delta's daily options are 0.001. */
  contractValue?: number;
}): TradeState {
  return {
    tradeId: args.tradeId,
    symbol: args.symbol,
    productId: args.productId,
    optionSide: args.optionSide,
    contractValue: args.contractValue ?? 0.001,
    phase: 'precheck',
    position: 0,
    requestedSize: args.requestedSize,
    entrySize: 0,
    entryAvgPrice: null,
    exitSize: 0,
    exitAvgPrice: null,
    entryOrderId: null,
    protection: { takeProfit: null, stopLoss: null },
    wantsProtection: args.wantsProtection ?? true,
    exitWinner: null,
    realisedPnl: 0,
    fills: [],
    note: null,
    alarm: null,
    updatedAt: args.at,
  };
}

const isExit = (role: OrderRole) => role !== 'entry';

/** Size-weighted, over the fills that actually happened. */
function averageOf(fills: Fill[], want: (f: Fill) => boolean): { size: number; avg: number | null } {
  let size = 0;
  let notional = 0;
  for (const f of fills) {
    if (!want(f)) continue;
    size += f.size;
    notional += f.size * f.price;
  }
  return { size, avg: size > 0 ? notional / size : null };
}

/**
 * Short options only: we sell to open and buy to close, so profit is
 * (what we took in) - (what we paid to get out), over the size actually closed.
 */
function realised(
  entryAvg: number | null,
  exitAvg: number | null,
  closed: number,
  contractValue: number,
): number {
  if (entryAvg === null || exitAvg === null || closed <= 0) return 0;
  return (entryAvg - exitAvg) * closed * contractValue;
}

export function applyEvent(prev: TradeState, e: TradeEvent): TradeState {
  const s: TradeState = { ...prev, fills: [...prev.fills], protection: { ...prev.protection }, updatedAt: e.at };

  switch (e.t) {
    case 'precheck_failed':
      return { ...s, phase: 'aborted', note: e.reason };

    case 'entry_submitted':
      return { ...s, phase: 'entry_pending', entryOrderId: e.clientOrderId, requestedSize: e.size };

    case 'entry_submit_unknown':
      // We do not know whether the exchange has this order. Sending another one
      // is how you end up short twice. The engine must reconcile from here.
      return {
        ...s,
        phase: 'entry_unknown',
        note: 'submit timed out — position and orders must be read back before anything else',
      };

    case 'entry_rejected':
      return { ...s, phase: 'aborted', note: e.reason };

    case 'fill': {
      s.fills.push({ orderId: e.orderId, role: e.role, side: e.side, size: e.size, price: e.price, ts: e.at });
      const entry = averageOf(s.fills, (f) => f.role === 'entry');
      const exit = averageOf(s.fills, (f) => isExit(f.role));
      s.entrySize = entry.size;
      s.entryAvgPrice = entry.avg;
      s.exitSize = exit.size;
      s.exitAvgPrice = exit.avg;
      // short position: everything sold, less everything bought back.
      // Written this way round so a fully closed trade is 0 and never -0.
      s.position = exit.size - entry.size;
      s.realisedPnl = realised(s.entryAvgPrice, s.exitAvgPrice, exit.size, s.contractValue);

      if (isExit(e.role)) {
        // The first exit to actually print is the winner; the other one is now
        // a live order that could re-open the position, so it has to go.
        if (s.exitWinner === null) s.exitWinner = e.role === 'exit' ? 'manual' : e.role;
        s.phase = s.position === 0 ? 'flat' : 'exit_pending';
        if (s.position === 0) s.alarm = null;
        return s;
      }

      // an entry fill
      if (s.phase === 'entry_pending' || s.phase === 'entry_unknown' || s.phase === 'precheck') {
        s.phase = 'position_open';
      }
      return s;
    }

    case 'entry_timeout':
      // Not a state of its own: the engine cancels, and the cancel result is
      // what moves us on. Recorded so the reason survives a restart.
      return { ...s, note: 'entry not filled in time — cancelling the rest' };

    case 'entry_cancelled':
      if (s.entrySize === 0) return { ...s, phase: 'aborted', note: 'entry cancelled unfilled — no position taken' };
      return {
        ...s,
        phase: s.phase === 'entry_pending' || s.phase === 'entry_unknown' ? 'position_open' : s.phase,
        note: `filled ${s.entrySize} of ${s.requestedSize}, cancelled the remaining ${e.remaining}`,
      };

    case 'protection_placed':
      return {
        ...s,
        phase: s.position === 0 ? 'flat' : 'protected',
        protection: { takeProfit: e.takeProfit, stopLoss: e.stopLoss },
        alarm: null,
      };

    case 'protection_failed':
      // Only an alarm when a stop was asked for. A trade that chose to run
      // without one is not malfunctioning, and a target that failed to go on
      // leaves nothing extra at risk -- the note records it either way.
      if (s.position === 0) return { ...s, phase: 'flat', alarm: null };
      if (!s.wantsProtection) return { ...s, note: `could not place the target: ${e.reason}` };
      return { ...s, phase: 'unprotected', alarm: `POSITION UNPROTECTED: ${e.reason}` };

    case 'exit_submitted':
      return { ...s, phase: s.position === 0 ? s.phase : 'exit_pending' };

    case 'sibling_cancelled': {
      const protection = { ...s.protection };
      if (e.role === 'take_profit') protection.takeProfit = null;
      if (e.role === 'stop_loss') protection.stopLoss = null;
      return { ...s, protection };
    }

    case 'reconciled': {
      // The exchange's number, not ours.
      const position = e.position;
      const covered = Boolean(s.protection.takeProfit || s.protection.stopLoss);
      const phase: TradePhase =
        position === 0
          ? s.entrySize > 0 ? 'flat' : 'aborted'
          : covered || !s.wantsProtection ? 'protected' : 'unprotected';
      return {
        ...s,
        position,
        phase,
        alarm: phase === 'unprotected' ? 'POSITION UNPROTECTED: no live stop after reconcile' : null,
        note: e.note ?? s.note,
      };
    }

    case 'aborted':
      return { ...s, phase: 'aborted', note: e.reason };
  }
}

export const replay = (init: TradeState, events: TradeEvent[]): TradeState =>
  events.reduce(applyEvent, init);

/**
 * Rebuild the derived figures from the fills.
 *
 * The fills are the record; the position, the averages and the realised P&L are
 * a cache of them. When the arithmetic behind that cache is corrected -- as it
 * was when the contract size was found missing from realised P&L -- rows
 * written under the old rule keep the old answer forever unless something
 * recomputes them. This does, on the way out of the store, so history is right
 * the moment the code is.
 */
export function recompute(s: TradeState): TradeState {
  const entry = averageOf(s.fills, (f) => f.role === 'entry');
  const exit = averageOf(s.fills, (f) => isExit(f.role));
  return {
    ...s,
    entrySize: entry.size,
    entryAvgPrice: entry.avg,
    exitSize: exit.size,
    exitAvgPrice: exit.avg,
    realisedPnl: realised(entry.avg, exit.avg, exit.size, s.contractValue ?? 0.001),
  };
}

/** How many contracts a stop or a target must cover right now. Never the request. */
export const protectionSize = (s: TradeState): number => Math.abs(s.position);

/** A trade asked for a stop, holds contracts, and has no stop. */
export const needsProtection = (s: TradeState): boolean =>
  s.wantsProtection && s.position !== 0 && !s.protection.stopLoss;

/** True while the engine must not send anything until it has read the exchange. */
export const mustReconcile = (s: TradeState): boolean => s.phase === 'entry_unknown';

export const isDone = (s: TradeState): boolean => s.phase === 'flat' || s.phase === 'aborted';
