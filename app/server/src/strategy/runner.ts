import { liveChain, WHOLE_BOARD } from '../market/chain.js';
import { scoreLegs } from '../domain/score.js';
import { wallWithinEm } from '../http/routes/desk.routes.js';
import { tradingService } from '../trading/service.js';
import { noteError } from '../observability/errors.js';
import { StrategyStore } from './store.js';
import { entryDue, entrySlotDate, entryWindowEnd, exitMomentFor, graceOf, istMinutes, istWeekday, openedAtOf } from './schedule.js';
import { describeSelection, selectLegs, type Candidate } from './select.js';
import { exitAsk, exitRules, exitValueAt, legOfSignal, minutesForward, minutesOf, signalMatches, time12, type Strategy } from './types.js';
import type { MethodRead } from '../entry/types.js';
import { missedEntryAlert, runAlertFor, type Alert, type AlertContext } from '../notify/messages.js';
import { StrategyExitStepper } from './exit-steps.js';

/**
 * The loop that turns a due strategy into orders.
 *
 * Everything it decides is decided elsewhere, on purpose. `schedule.ts` says
 * whether today is a day, `select.ts` says which legs and how many lots, and
 * both are pure and tested by hand. This file is the part that cannot be pure:
 * it reads a clock, reads the board, and sends orders. So it is kept as thin as
 * a thing can be, and every judgement in it is delegated.
 *
 * THE FOUR DECISIONS, and what each one does:
 *
 *   Which board.       The live chain for the nearest expiry. If the feed is
 *                      down or the snapshot is not the daily contract, the day
 *                      is skipped and said so -- entering off a stale board is
 *                      how a strike gets chosen against a price that has moved.
 *
 *   Partial fill.      Keep it. If one leg is placed and the other is refused,
 *                      the filled leg stands and the run is logged one-sided.
 *                      Closing it immediately would pay the spread twice to
 *                      undo a position the gates were happy with.
 *
 *   The exit.          Market, reduce-only, through the same closeNow the
 *                      button uses. A limit that does not fill leaves a
 *                      position running into settlement, which is the one
 *                      outcome the exit exists to prevent.
 *
 *   A refusal.         The day is spent on the first answer. If the rules turn
 *                      the board down, or no leg can be placed, the run is
 *                      recorded and Telegram is told why. Only a board that
 *                      cannot be read at all is retried, every tick, until the
 *                      grace window closes -- and if it closes with nothing
 *                      tried, that is an alert too.
 *
 * The day is claimed BEFORE any order is sent. A claim that is never followed
 * by a fill loses a day; an order sent before the claim can be sent twice.
 */

/** Often enough that the grace window has many chances; rarely enough to be dull. */
const TICK_MS = 20_000;
/** A signal strategy's entry rests at most this long; whatever is still unfilled then is cancelled. */
export const SIGNAL_ENTRY_MS = 5 * 60_000;

/** One signal's identity: the same as the paper log's -- method, way, timeframe, direction, the trigger bar. */
export const signalKeyOf = (r: Pick<MethodRead, 'id' | 'mode' | 'tf' | 'dir' | 'triggerTime'>) =>
  `${r.id}|${r.mode}|${r.tf}|${r.dir === 'long' ? 1 : -1}|${r.triggerTime ?? 0}`;

/** The option board a signal is traded on: the daily contract's strikes, priced, and where BTC is. */
export type SignalBoard = { live: boolean; isDaily: boolean; expiry: string; expiryTs: number; spot: number | null; candidates: Candidate[] };

/** The live board, read the way the clock's entries read it. */
async function liveSignalBoard(): Promise<SignalBoard | null> {
  const snap = await liveChain(WHOLE_BOARD).catch(() => null);
  if (!snap) return null;
  return {
    live: snap.live, isDaily: snap.isDaily, expiry: snap.expiry, expiryTs: snap.expiryTs, spot: snap.spot,
    candidates: scoreLegs(snap).map((l) => ({
      cp: l.cp, strike: l.strike, sellPrice: l.sellPrice, pOtm: l.pOtm,
      moneyness: l.moneyness, ask: l.ask, oi: l.oi, emBuffer: l.emBuffer,
    })),
  };
}

/** Whether `now` is inside a signal strategy's window: one of its days, from its entry time to its exit time (IST). */
export function inSignalWindow(s: Strategy, nowMs: number): boolean {
  if (!s.config.weekdays.includes(istWeekday(nowMs))) return false;
  const from = minutesOf(s.config.entryTime);
  return minutesForward(from, istMinutes(nowMs)) < minutesForward(from, minutesOf(s.config.exitTime));
}

export class StrategyRunner {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** Strategy and day pairs already told about a missed entry, so it is said once. */
  private readonly missedAlerted = new Set<string>();
  private readonly exitStepper: StrategyExitStepper;

  constructor(
    private readonly store: StrategyStore,
    private readonly now: () => number = Date.now,
    /** The board a signal is traded on: the live one, or a test's. */
    private readonly signalBoard: () => Promise<SignalBoard | null> = liveSignalBoard,
  ) {
    /*
     * Time-based exits: at each step's time, the target or stop of every open
     * trade this strategy placed moves to the step's value -- through the same
     * call the Edit exits sheet makes, so the book is reconciled the same way.
     */
    this.exitStepper = new StrategyExitStepper({
      openTrades: async (id) => (await tradingService().openTrades()).filter((t) => t.plan.strategyId === id),
      move: (tradeId, ask, stage) => tradingService().updateExits(tradeId, ask, stage),
      // Keyed by trade: a CE and a PE stepping in the same tick are two pieces
      // of news, and one key would have the second replace the first unsent.
      tell: (text, tradeId) => this.alert(() => ({ key: `exit-step:${tradeId}`, text })),
      now: this.now,
    });
  }

  start(): void {
    this.timer ??= setInterval(() => { void this.tick(); }, TICK_MS);
    // Unref so the loop never holds the process open on its own.
    this.timer?.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** True when the desk is allowed to act without being asked. */
  private armed(): boolean {
    return tradingService().settings.get('scheduler_enabled') === '1';
  }

  async tick(): Promise<void> {
    if (this.ticking) return;            // a slow exchange must not stack ticks
    this.ticking = true;
    try {
      if (!this.armed()) return;
      for (const s of await this.store.all()) {
        await this.considerExit(s).catch((e) => this.note(s, 'exit', e));
        await this.considerEntry(s).catch((e) => this.note(s, 'entry', e));
        await this.exitStepper.consider(s).catch((e) => this.note(s, 'exit step', e));
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Tell the phone, if Telegram is set up and alerts are switched on. Never
   * allowed to stop a run: a message that cannot be sent is not a reason to
   * stop trading, and a message somebody silenced is not a reason either.
   */
  private alert(make: (ctx: AlertContext) => Alert | null): void {
    try {
      const svc = tradingService();
      if (!svc.alertsOn) return;
      const a = make({ mode: svc.mode });
      if (a) svc.notifier?.notify(a);
    } catch (e) {
      noteError({
        source: 'trading',
        level: 'warn',
        message: `telegram alert not sent: ${(e as Error).message}`,
        where: 'strategy/runner',
        context: {},
      });
    }
  }

  /**
   * The entry window closed and nothing was tried. Said once a day per
   * strategy, and only while that day is still running: after the exit time
   * there is nothing left to act on.
   */
  private async warnIfMissed(s: Strategy, because: string, now: number, day: string): Promise<void> {
    // "too late" is only said while the slot's own window is still running --
    // after that the reason is "waiting" -- so there is nothing more to check.
    if (!because.startsWith('too late')) return;
    if (await this.store.lastRunDate(s.id) === day) return;
    const key = `${s.id}:${day}`;
    if (this.missedAlerted.has(key)) return;
    this.missedAlerted.add(key);
    this.alert((ctx) => missedEntryAlert(s.name, time12(s.config.entryTime), graceOf(s), now, ctx));
  }

  private note(s: Strategy, what: string, e: unknown): void {
    noteError({
      source: 'trading',
      level: 'warn',
      message: `strategy ${s.id} ${what} failed: ${(e as Error).message}`,
      where: 'strategy/runner',
      context: { strategyId: s.id },
    });
  }

  /**
   * Close whatever this strategy opened once that position's own exit time has
   * passed -- the first exit time after the position opened, so editing the
   * strategy's entry time never closes a position that is already on.
   */
  private async considerExit(s: Strategy): Promise<void> {
    const svc = tradingService();
    const now = this.now();
    const open = (await svc.openTrades()).filter((t) => t.plan.strategyId === s.id && t.state.position !== 0);
    const due = open.filter((t) => now >= exitMomentFor(s.config.exitTime, openedAtOf(t, now)));
    if (!due.length) return;
    for (const t of due) {
      await svc.close(t.state.tradeId);
    }
    // A signal strategy's trades belong to their signals, not to a day: the close is said on each signal's row.
    if (s.config.trigger === 'signal') {
      for (const t of due) await this.store.noteSignalTrade(t.state.tradeId, `closed at ${time12(s.config.exitTime)}, the end of its window`);
      return;
    }
    /*
     * Add to the day's record rather than replace it: `finish` overwrites, and
     * the row already holds what was sold. The day is the run the position
     * came from -- found by when it opened, not by today's date or the entry
     * time as it reads now, which may have been edited since.
     */
    const byDay = new Map<string, number>();
    for (const t of due) {
      const opened = openedAtOf(t, now);
      const day = (await this.store.runDateAtOrBefore(s.id, opened)) ?? entrySlotDate(s, opened);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    for (const [day, n] of byDay) {
      const prior = (await this.store.runFor(s.id, day))?.detail ?? '';
      const closed = `closed ${n} leg${n === 1 ? '' : 's'} at ${time12(s.config.exitTime)}`;
      await this.store.finish(s.id, day, 'placed', prior ? `${prior} | ${closed}` : closed);
    }
  }

  private async considerEntry(s: Strategy): Promise<void> {
    // A signal strategy enters on its signals (`onSignal`), never on the clock.
    if (s.config.trigger === 'signal') return;
    const now = this.now();
    const day = entrySlotDate(s, now);
    const due = entryDue(s, now, await this.store.lastRunDate(s.id));
    if (!due.due) {
      await this.warnIfMissed(s, due.because, now, day);
      return;
    }

    /*
     * The board first, because a day that cannot be traded should not be spent.
     *
     * The WHOLE board: the default window is a display setting for the chain
     * table, and a rule that picks the heaviest strike cannot be shown two
     * dozen of them. See `WHOLE_BOARD`.
     */
    const snap = await liveChain(WHOLE_BOARD).catch(() => null);
    if (!snap || !snap.live) {
      // No claim: the feed may come back inside the window.
      return;
    }
    if (!snap.isDaily) {
      await this.claimAndFinish(s, day, 'skipped', 'the nearest expiry is not the daily contract');
      return;
    }

    const candidates: Candidate[] = scoreLegs(snap).map((l) => ({
      cp: l.cp, strike: l.strike, sellPrice: l.sellPrice, pOtm: l.pOtm,
      moneyness: l.moneyness, ask: l.ask, oi: l.oi, emBuffer: l.emBuffer,
    }));
    // The open-interest rule looks for its wall inside the desk's level band;
    // spot lets the strike nearest the money count when it has no intrinsic value.
    const sel = selectLegs(s, candidates, { wallWithinEm: wallWithinEm(), spot: snap.spot });
    if (sel.legs.length === 0) {
      await this.claimAndFinish(s, day, 'refused', describeSelection(sel));
      return;
    }

    /* The same shape the chain table hands the ticket. */
    const legOf = (leg: typeof sel.legs[number]) => ({
      symbol: `${leg.cp}-BTC-${leg.strike}-${snap.expiry}`,
      optionSide: (leg.cp === 'C' ? 'CE' : 'PE') as 'CE' | 'PE',
      strike: leg.strike,
      expiryTs: snap.expiryTs,
      lots: leg.lots,
      ask: leg.ask,
      cancelAfterMs: Math.max(1_000, entryWindowEnd(s, now) - now),
    });

    const legs = sel.legs;

    // Claim before a single order goes out. Whoever loses the race does nothing.
    if (!await this.store.claim(s.id, day, now)) return;

    const placed: string[] = [];
    const failed: string[] = [];
    for (const leg of legs) {
      // The same shape the chain table hands the ticket, so a scheduled order
      // and a tapped one address the identical contract.
      try {
        placed.push(await svcPlace(s, legOf(leg)));
      } catch (e) {
        // One leg refused does not undo the other. The gates were happy with
        // what did go on, and unwinding it pays the spread twice.
        failed.push(`${leg.cp === 'C' ? 'CE' : 'PE'} ${leg.strike}: ${(e as Error).message}`);
      }
    }

    const detail = [
      describeSelection({ ...sel, legs }),
      ...(failed.length ? [`failed: ${failed.join('; ')}`] : []),
    ].join(' | ').slice(0, 500);
    const status = placed.length ? 'placed' : 'failed';
    await this.store.finish(s.id, day, status, detail);
    // Failed, or on one side only: somebody should know before the day moves on.
    this.alert((ctx) => runAlertFor({ strategy: s.name, status, detail, failedLegs: failed, at: now }, ctx));
  }

  /**
   * A TRADE signal, the moment the entry section writes it (index.ts, each minute
   * three seconds after the candles close): every switched-on signal strategy
   * that takes it sells its leg -- a BUY the put, a SELL the call -- with the
   * signal's own SL and TGT on the BTC perpetual as the trade's exits.
   *
   * Called for each new TRADE once (the paper log's first write), and claimed per
   * strategy before anything is sent, so a signal is never traded twice. Every
   * outcome is written to `strategy_signal_runs`, in words. With `liveOrders` off
   * -- the default -- nothing is sent: what would have been placed is written down
   * with the gates' answer, which is how a method earns a live switch.
   */
  async onSignal(r: MethodRead): Promise<void> {
    /*
     * One signal at a time. The recorder hands over every new TRADE of a minute
     * at once, and taken side by side each counted the open trades before any
     * of them had placed -- so all of them passed "at most N open". In turn,
     * each one sees the ones before it.
     */
    const mine = this.signalQueue.then(() => this.onSignalNow(r));
    this.signalQueue = mine.catch(() => {});
    return mine;
  }

  private signalQueue: Promise<void> = Promise.resolve();

  private async onSignalNow(r: MethodRead): Promise<void> {
    if (r.state !== 'TRADE' || !r.plan || r.dir === null || r.triggerTime === null) return;
    if (!this.armed()) return;
    for (const s of await this.store.all()) {
      if (!s.enabled || s.config.trigger !== 'signal' || !s.config.signal) continue;
      if (!signalMatches(s.config.signal, r)) continue;
      await this.takeSignal(s, r).catch((e) => this.note(s, 'signal', e));
    }
  }

  private async takeSignal(s: Strategy, r: MethodRead): Promise<void> {
    const now = this.now();
    if (!inSignalWindow(s, now)) return;              // outside its days or hours: not its signal
    const rule = s.config.signal!;
    const plan = r.plan!;
    const dir: 1 | -1 = r.dir === 'long' ? 1 : -1;
    const key = signalKeyOf(r);
    if (!await this.store.claimSignal(s.id, key, { method: r.id, mode: r.mode, tf: r.tf, dir }, now)) return;
    const said = `#${r.n} ${r.name} ${dir === 1 ? 'BUY' : 'SELL'}`;
    const finish = (status: Parameters<StrategyStore['finishSignal']>[2], detail: string, tradeId: string | null = null) =>
      this.store.finishSignal(s.id, key, status, `${said} | ${detail}`, tradeId);

    const svc = tradingService();
    // Every trade of its own not yet finished -- a working entry included: one resting at the offer, not yet
    // filled, is still a trade, and counting only positions let a second signal place a second order.
    // And, with live orders off, every "would sell" whose signal is still in play in the paper log.
    const open = (await svc.openTrades()).filter((t) => t.plan.strategyId === s.id).length
      + await this.store.wouldBeOpen(s.id);
    if (open >= rule.maxOpen) {
      await finish('skipped', `already ${open} of its trade${open === 1 ? '' : 's'} open (at most ${rule.maxOpen})`);
      return;
    }

    const snap = await this.signalBoard().catch(() => null);
    if (!snap || !snap.live) { await finish('skipped', 'no live option board'); return; }
    if (!snap.isDaily) { await finish('skipped', 'the nearest expiry is not the daily contract'); return; }

    // The signal's leg: one, whatever `legs` says.
    const leg = legOfSignal(dir);
    const sel = selectLegs({ ...s, config: { ...s.config, legs: leg } }, snap.candidates, { wallWithinEm: wallWithinEm(), spot: snap.spot });
    const chosen = sel.legs[0];
    if (!chosen) { await finish('refused', describeSelection(sel)); return; }

    const target = (rule.target === 'tp3' ? plan.tp3 : rule.target === 'tp2' ? plan.tp2 : null) ?? plan.tp1;
    const args = {
      ...placeArgs(s, {
        symbol: `${chosen.cp}-BTC-${chosen.strike}-${snap.expiry}`,
        optionSide: leg, strike: chosen.strike, expiryTs: snap.expiryTs,
        lots: chosen.lots, ask: chosen.ask, cancelAfterMs: SIGNAL_ENTRY_MS,
      }),
      // The signal's own levels, on the perp: the trade's real exits. The premium stop stays at Delta as the backstop.
      underlying: { dir, stop: plan.stop, target, source: 'BTC perp' },
      signal: { method: r.id, n: r.n, name: r.name, mode: r.mode, tf: r.tf, dir, triggerTime: r.triggerTime! },
    };
    const what = `sell ${leg} ${chosen.strike} x${chosen.lots} @ ${chosen.price} · perp SL ${Math.round(plan.stop)} · TGT ${Math.round(target)}`;

    if (!s.config.liveOrders) {
      const p = await svc.wouldPlace(args);
      await finish(p.ok ? 'would-place' : 'refused', `${p.ok ? 'live orders off: would' : 'refused:'} ${p.ok ? what : failureText(p)}`);
      return;
    }
    const res = await svc.place(args);
    if (!res.ok) {
      await finish('refused', `${what} -- refused: ${res.precheck ? failureText(res.precheck) : 'refused'}`);
      this.alert((ctx) => runAlertFor({ strategy: s.name, status: 'failed', detail: `${said}: refused`, failedLegs: [what], at: now }, ctx));
      return;
    }
    await finish('placed', what, res.state.tradeId);
    this.alert((ctx) => runAlertFor({ strategy: s.name, status: 'placed', detail: `${said}: ${what}`, failedLegs: [], at: now }, ctx));
  }

  private async claimAndFinish(s: Strategy, day: string, status: 'refused' | 'skipped', detail: string): Promise<void> {
    const at = this.now();
    if (!await this.store.claim(s.id, day, at)) return;
    await this.store.finish(s.id, day, status, detail);
    this.alert((ctx) => runAlertFor({ strategy: s.name, status, detail, failedLegs: [], at }, ctx));
  }
}


/** Place one leg through the same service the order ticket uses. */
async function svcPlace(
  s: Strategy,
  o: {
    symbol: string; optionSide: 'CE' | 'PE'; strike: number; expiryTs: number;
    lots: number; ask: number | null;
    /** How long an order may rest before what is left is cancelled: to the close of the entry window. */
    cancelAfterMs: number;
  },
): Promise<string> {
  const res = await tradingService().place(placeArgs(s, o));
  if (!res.ok) throw new Error(res.precheck ? failureText(res.precheck) : 'refused');
  return `${o.optionSide} ${o.strike} x${o.lots}`;
}

/** The order, exactly as both the dry run and the real thing send it. */
function placeArgs(s: Strategy, o: Parameters<typeof svcPlace>[1]) {
  const c = s.config;
  const { ask, cancelAfterMs, ...order } = o;
  /*
   * The three price modes, mapped onto the ticket's own arguments so a
   * scheduled order behaves exactly like a tapped one.
   *
   *   now    no limit at all -- place() reads that as a market order.
   *   offer  rest at the ask and walk toward the bid over `crossAfterSec`. The
   *          last step is the bid only while the spread is within
   *          `maxCrossSpreadPct`; while it is wider the order waits at the mid,
   *          and whatever is still unfilled when the entry window closes is
   *          cancelled. Zero seconds rests until it fills.
   *   set    the price named in the config, resting.
   */
  const limitPrice = c.entryPrice === 'now'
    ? undefined
    : c.entryPrice === 'set'
      ? (c.entryLimit ?? undefined)
      : (ask ?? undefined);
  if (c.entryPrice === 'offer' && limitPrice === undefined) {
    throw new Error('no offer to rest at');
  }
  return {
    ...order,
    strategyId: s.id,
    strategyName: s.name,
    origin: 'strategy' as const,
    /*
     * What the desk's own stop watch judges the level on. The resting stop at
     * Delta still triggers on the mark either way -- it is there so the stop
     * works when this process does not -- so `close` makes this desk patient,
     * not the venue. The strategy form says exactly that.
     */
    monitorOn: s.config.monitorOn ?? 'ltp',
    limitPrice,
    chaseSeconds: c.entryPrice === 'offer' ? c.crossAfterSec : 0,
    // Wait for a tight spread before selling into the bid, and give up at the
    // close of the entry window rather than resting into the day.
    maxCrossSpreadPct: c.entryPrice === 'offer' ? (c.maxCrossSpreadPct ?? 0.15) : null,
    // The strategy's own premium floor, when it set one; otherwise the desk's.
    ...(c.minPremiumUsd !== null && c.minPremiumUsd !== undefined ? { minPremiumUsd: c.minPremiumUsd } : {}),
    timeoutMs: c.entryPrice === 'offer' && c.crossAfterSec > 0 ? cancelAfterMs : undefined,
    ...exitsNow(s, Date.now()),
  };
}

/**
 * The exits to enter with: the values in force now, in each rule's own mode.
 *
 * Usually the starting values. An entry taken late, inside its grace window,
 * after a step's time, enters with that step's value -- the same value the
 * stepper would move it to twenty seconds later.
 */
export function exitsNow(s: Strategy, nowMs: number) {
  const { target, stop } = exitRules(s.config);
  const minute = istMinutes(nowMs);
  return {
    ...exitAsk(target, exitValueAt(target, s.config.entryTime, minute).value, 'target'),
    ...exitAsk(stop, exitValueAt(stop, s.config.entryTime, minute).value, 'stop'),
  };
}

/** Append to the other leg's trade, through the engine and its gates. */

function failureText(p: { ok: boolean; failures?: { message: string }[] }): string {
  return p.failures?.map((f) => f.message).join('; ') ?? 'refused';
}
