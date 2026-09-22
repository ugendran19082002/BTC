import { liveChain, WHOLE_BOARD } from '../market/chain.js';
import { scoreLegs } from '../domain/score.js';
import { wallWithinEm } from '../http/routes/desk.routes.js';
import { tradingService } from '../trading/service.js';
import { noteError } from '../observability/errors.js';
import { StrategyStore } from './store.js';
import { entryDue, entrySlotDate, entryWindowEnd, exitDue, graceOf, istMinutes } from './schedule.js';
import { describeSelection, selectLegs, type Candidate } from './select.js';
import { exitAsk, exitRules, exitValueAt, time12, type Strategy } from './types.js';
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

export class StrategyRunner {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** Strategy and day pairs already told about a missed entry, so it is said once. */
  private readonly missedAlerted = new Set<string>();
  private readonly exitStepper: StrategyExitStepper;

  constructor(
    private readonly store: StrategyStore,
    private readonly now: () => number = Date.now,
  ) {
    /*
     * Time-based exits: at each step's time, the target or stop of every open
     * trade this strategy placed moves to the step's value -- through the same
     * call the Edit exits sheet makes, so the book is reconciled the same way.
     */
    this.exitStepper = new StrategyExitStepper({
      openTrades: async (id) => (await tradingService().openTrades()).filter((t) => t.plan.strategyId === id),
      move: (tradeId, ask) => tradingService().updateExits(tradeId, ask),
      tell: (text) => this.alert(() => ({ key: 'exit-step', text })),
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

  /** Close anything this strategy opened once its exit time has passed. */
  private async considerExit(s: Strategy): Promise<void> {
    const svc = tradingService();
    const open = (await svc.openTrades()).filter((t) => t.plan.strategyId === s.id && t.state.position !== 0);
    if (!exitDue(s, this.now(), open.length > 0).due) return;
    for (const t of open) {
      await svc.close(t.state.tradeId);
    }
    if (open.length) {
      /*
       * Add to the day's record rather than replace it.
       *
       * `finish` overwrites, and the row already holds what was sold this
       * morning. Writing "closed 2 legs" over it would leave a journal that
       * cannot answer the first question anybody asks about a day -- what did
       * it put on -- while claiming to be the audit trail.
       */
      // The day the entry belongs to, not today's date: an overnight strategy
      // exits on the following morning, and writing that morning's row would
      // both lose this record and spend a day that has not run.
      const day = entrySlotDate(s, this.now());
      const prior = (await this.store.runFor(s.id, day))?.detail ?? '';
      const closed = `closed ${open.length} leg${open.length === 1 ? '' : 's'} at ${time12(s.config.exitTime)}`;
      await this.store.finish(s.id, day, 'placed', prior ? `${prior} | ${closed}` : closed);
    }
  }

  private async considerEntry(s: Strategy): Promise<void> {
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
    // The open-interest rule looks for its wall inside the desk's level band.
    const sel = selectLegs(s, candidates, { wallWithinEm: wallWithinEm() });
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
    origin: 'strategy' as const,
    limitPrice,
    chaseSeconds: c.entryPrice === 'offer' ? c.crossAfterSec : 0,
    // Wait for a tight spread before selling into the bid, and give up at the
    // close of the entry window rather than resting into the day.
    maxCrossSpreadPct: c.entryPrice === 'offer' ? (c.maxCrossSpreadPct ?? 0.15) : null,
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
