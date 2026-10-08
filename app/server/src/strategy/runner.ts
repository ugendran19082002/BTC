import { liveChain, WHOLE_BOARD } from '../market/chain.js';
import { scoreLegs } from '../domain/score.js';
import { wallWithinEm } from '../http/routes/desk.routes.js';
import { runAsDesk, tradingService, tradingServiceFor } from '../trading/service.js';
import { noteError } from '../observability/errors.js';
import { StrategyStore } from './store.js';
import { entryDue, entrySlotDate, entryWindowEnd, exitMomentFor, graceOf, istMinutes, istWeekday, openedAtOf } from './schedule.js';
import { describeSelection, elseWords, ruleWords, selectLegs, type Candidate } from './select.js';
import { accountSetting } from '../db/settings.js';
import { GLOBAL_MAX_OPEN_KEY, actionOf, entersOn, exitAsk, exitRules, exitValueAt, globalMaxOpenOf, legOfSignal, maxSlPtsFor, maxTgtPtsFor, minSlPtsFor, minTgtPtsFor, minutesForward, minutesOf, signalMatches, strikePickAt, time12, type Strategy } from './types.js';
import type { MethodRead } from '../entry/types.js';
import type { SetupFill } from '../entry/paper.js';
import { METHODS } from '../entry/methods.js';
import { liveLtp } from '../market/flow.js';
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
/**
 * A fill the graders report this long after it printed is not entered: the candle grader can report one a
 * minute or more late, when the tape was down, and a late option entry is a different trade.
 */
export const ZONE_FILL_FRESH_MS = 90_000;
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
      moneyness: l.moneyness, ask: l.ask, oi: l.oi, emBuffer: l.emBuffer, delta: l.delta,
    })),
  };
}

/** Whether `now` is inside a signal strategy's window: one of its days, from its entry time to its exit time (IST). */
export function inSignalWindow(s: Strategy, nowMs: number): boolean {
  if (!s.config.weekdays.includes(istWeekday(nowMs))) return false;
  const from = minutesOf(s.config.entryTime);
  return minutesForward(from, istMinutes(nowMs)) < minutesForward(from, minutesOf(s.config.exitTime));
}

/** Hours from `nowMs` to a contract's settlement (`expiryTs`, epoch seconds): what a distance rule that shrinks with time reads. */
const hoursLeft = (expiryTs: number, nowMs: number): number => (expiryTs * 1_000 - nowMs) / 3_600_000;

/** The perp's last trade, when fresh: what a signal entered at, for the labels. */
function perpNow(): number | null {
  const l = liveLtp();
  return l && Date.now() - l.at <= 15_000 ? l.price : null;
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
        // Each strategy on its own account's desk (5 Oct 2026: every active account trades at once). One whose
        // account is switched off has no desk: nothing is entered for it, and it holds nothing to exit.
        const desk = tradingServiceFor(s.accountId);
        if (!desk) continue;
        await runAsDesk(desk, async () => {
          await this.considerExit(s).catch((e) => this.note(s, 'exit', e));
          await this.considerEntry(s).catch((e) => this.note(s, 'entry', e));
          await this.exitStepper.consider(s).catch((e) => this.note(s, 'exit step', e));
        });
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
      // Said on the close, so the exit alert and the screens say why: not "manual exit".
      await svc.close(t.state.tradeId, undefined, `the strategy's exit time, ${time12(s.config.exitTime)}`);
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
      moneyness: l.moneyness, ask: l.ask, oi: l.oi, emBuffer: l.emBuffer, delta: l.delta,
    }));
    // The open-interest rule looks for its wall inside the desk's level band;
    // spot lets the strike nearest the money count when it has no intrinsic value.
    const sel = selectLegs(s, candidates, { wallWithinEm: wallWithinEm(), spot: snap.spot, hoursToExpiry: hoursLeft(snap.expiryTs, now) });
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
      // On its own account's desk; none, when that account is switched off.
      const desk = tradingServiceFor(s.accountId);
      if (!desk) continue;
      if (!signalMatches(s.config.signal, r)) continue;
      // The ones that enter at the signal; the rest wait for the perp to reach the zone (`onSetupFilled`) --
      // and are made ready for it meanwhile.
      if (entersOn(s.config.signal) !== 'signal') {
        void runAsDesk(desk, () => this.warmFor(s, r)).catch(() => {});
        continue;
      }
      await runAsDesk(desk, () => this.takeSignal(s, r, null)).catch((e) => this.note(s, 'signal', e));
    }
  }

  /**
   * A signal "in the trade": the perp traded into its entry zone, as the paper
   * log graded it (entry/paper.ts `onSetupFilled`). Every switched-on signal
   * strategy that enters at the zone -- the default -- and takes this signal
   * sells its leg now. In turn with the signals, through the same queue.
   */
  onSetupFilled(f: SetupFill): Promise<void> {
    const mine = this.signalQueue.then(() => this.onSetupFilledNow(f));
    this.signalQueue = mine.catch(() => {});
    return mine;
  }

  private async onSetupFilledNow(f: SetupFill): Promise<void> {
    if (!this.armed()) return;
    const m = METHODS.find((x) => x.id === f.method);
    // The signal as it was written: the same identity (and so the same claim) as the signal itself.
    const r = {
      id: f.method, n: m?.n ?? 0, name: m?.name ?? f.method, mode: f.mode, tf: f.tf,
      dir: f.dir === 1 ? 'long' : 'short', state: 'TRADE', triggerTime: f.triggerAt,
      plan: { entryLo: f.entryLo, entryHi: f.entryHi, stop: f.stop, tp1: f.tp1, tp2: f.tp2, tp3: f.tp3 },
    } as unknown as MethodRead;
    for (const s of await this.store.all()) {
      if (!s.enabled || s.config.trigger !== 'signal' || !s.config.signal) continue;
      const desk = tradingServiceFor(s.accountId);
      if (!desk) continue;
      if (entersOn(s.config.signal) !== 'zone') continue;
      if (!signalMatches(s.config.signal, r)) continue;
      await runAsDesk(desk, () => this.takeSignal(s, r, f)).catch((e) => this.note(s, 'signal', e));
    }
  }

  /**
   * A signal this strategy will take at the zone, seen before the zone is reached: the contract it would
   * sell right now is made ready -- product looked up, leverage set -- so that when the perp gets there the
   * order is all that is left to send. Nothing is claimed, decided or placed here: the strike is chosen
   * again, on the board as it then stands, when the zone fills; if that is another contract, this was a
   * wasted lookup and nothing more. Only for a strategy with live orders on, and in its window.
   */
  private async warmFor(s: Strategy, r: MethodRead): Promise<void> {
    if (!s.config.liveOrders || !inSignalWindow(s, this.now())) return;
    const snap = await this.signalBoard().catch(() => null);
    if (!snap || !snap.live || !snap.isDaily) return;
    const leg = legOfSignal(r.dir === 'long' ? 1 : -1, actionOf(s.config.signal));
    const at = strikePickAt(s.config, istMinutes(this.now()));
    const sel = selectLegs({ ...s, config: { ...s.config, ...at.pick, legs: leg } }, snap.candidates, { wallWithinEm: wallWithinEm(), spot: snap.spot, hoursToExpiry: hoursLeft(snap.expiryTs, this.now()) });
    const chosen = sel.legs[0];
    if (chosen) await tradingService().warmEntry(`${chosen.cp}-BTC-${chosen.strike}-${snap.expiry}`);
  }

  private async takeSignal(s: Strategy, r: MethodRead, fill: SetupFill | null): Promise<void> {
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

    if (fill) {
      // In the trade -- but not one that is already over, nor a fill reported too late to follow.
      if (fill.status !== 'filled') {
        await finish('skipped', `the perp filled at ${Math.round(fill.fillPrice)} and was out (${fill.status === 'tp1' ? 'TGT1' : fill.status === 'stop' ? 'SL' : fill.status}) in the same moment`);
        return;
      }
      const ago = now - fill.filledAt * 1_000;
      if (ago > ZONE_FILL_FRESH_MS) {
        await finish('skipped', `the perp filled at ${Math.round(fill.fillPrice)} ${Math.round(ago / 1_000)}s ago -- too late to enter`);
        return;
      }
    }

    /*
     * The distance filters (4 Oct 2026): a signal whose SL -- or whose target --
     * sits nearer the perp entry than the rule's number for that side is not
     * taken: its timeframe's number without the chain, the chain's own with it
     * (6 Oct 2026). The
     * entry is the one the trade would carry -- the fill, else the perp now,
     * else the middle of the signal's zone -- and the row says both prices, the
     * distance and the number it had to reach, so a skipped signal explains
     * itself in the history.
     */
    const needSl = minSlPtsFor(rule, r.tf);
    const needTgt = minTgtPtsFor(rule, r.tf);
    // And the most each may be (5 Oct 2026): a stop or a target further than its timeframe's maximum is skipped the same way.
    const mostSl = maxSlPtsFor(rule, r.tf);
    const mostTgt = maxTgtPtsFor(rule, r.tf);
    if (needSl > 0 || needTgt > 0 || mostSl > 0 || mostTgt > 0) {
      const from = fill?.fillPrice ?? perpNow() ?? (plan.entryLo + plan.entryHi) / 2;
      // The target the trade would exit at: the rule's, TGT1 where the signal has no TGT2 / TGT3.
      const tgt = (rule.target === 'tp3' ? plan.tp3 : rule.target === 'tp2' ? plan.tp2 : null) ?? plan.tp1;
      // Which signals the number is for, in the row's words: "15m", or "timeframe-chain".
      const kind = rule.mode === 'single' ? r.tf : 'timeframe-chain';
      const near = (name: string, level: number, need: number) => {
        const pts = Math.abs(from - level);
        return need > 0 && pts < need
          ? `${name} too near: the perp entry ${Math.round(from)} to the ${name} ${Math.round(level)} is ${Math.round(pts)} pts — this strategy takes ${kind} signals only at ${need} pts or more`
          : null;
      };
      const far = (name: string, level: number, most: number) => {
        const pts = Math.abs(from - level);
        return most > 0 && pts > most
          ? `${name} too far: the perp entry ${Math.round(from)} to the ${name} ${Math.round(level)} is ${Math.round(pts)} pts — this strategy takes ${kind} signals only at ${most} pts or less`
          : null;
      };
      const why = [near('SL', plan.stop, needSl), far('SL', plan.stop, mostSl), near('TGT', tgt, needTgt), far('TGT', tgt, mostTgt)].filter(Boolean);
      if (why.length) { await finish('skipped', why.join('; ')); return; }
    }

    const svc = tradingService();
    // Every trade of its own not yet finished -- a working entry included: one resting at the offer, not yet
    // filled, is still a trade, and counting only positions let a second signal place a second order.
    // And, with live orders off, every "would sell" whose signal is still in play in the paper log.
    /*
     * And, with live orders OFF, every "would sell" still in play in the paper log. Only then: with live orders
     * on, the would-sells written down while they were off are not trades -- counting them blocked real
     * orders ("already 15 open" with a handful of positions, 2 Oct 2026).
     */
    const openNow = await svc.openTrades();
    const live = openNow.filter((t) => t.plan.strategyId === s.id).length;
    const paper = s.config.liveOrders ? 0 : await this.store.wouldBeOpen(s.id);
    const open = live + paper;
    if (open >= rule.maxOpen) {
      const parts = [live ? `${live} live` : null, paper ? `${paper} would-sell` : null].filter(Boolean).join(' + ');
      await finish('skipped', `already ${open} of its trade${open === 1 ? '' : 's'} open${parts ? ` (${parts})` : ''} -- at most ${rule.maxOpen}`);
      return;
    }

    /*
     * The desk-wide cap, after the strategy's own: every open trade the desk
     * holds -- positions and working orders, of every strategy and the ticket --
     * against one number. Margin is one pool; the strategies' own limits add up
     * past it, and the order that does not fit is refused at Delta.
     */
    // The trading account's own cap (kept per account; an account with none of its own takes the desk-wide one).
    const cap = globalMaxOpenOf(accountSetting(svc.settings, GLOBAL_MAX_OPEN_KEY, svc.accountId));
    if (cap > 0 && openNow.length >= cap) {
      await finish('skipped', `the desk already has ${openNow.length} open (positions and working orders, all strategies) -- at most ${cap} at once across all`);
      return;
    }

    const snap = await this.signalBoard().catch(() => null);
    if (!snap || !snap.live) { await finish('skipped', 'no live option board'); return; }
    if (!snap.isDaily) { await finish('skipped', 'the nearest expiry is not the daily contract'); return; }

    // The signal's leg: one, whatever `legs` says. Sold, it is the put on a BUY; bought, the call.
    const action = actionOf(rule);
    const leg = legOfSignal(dir, action);
    // The strike rule in force at this minute: the strategy's own, or the block the clock has reached.
    const at = strikePickAt(s.config, istMinutes(now));
    const block = at.block > 0 ? ` · block ${at.block + 1}, from ${time12(at.from)}` : '';
    const sel = selectLegs({ ...s, config: { ...s.config, ...at.pick, legs: leg } }, snap.candidates, { wallWithinEm: wallWithinEm(), spot: snap.spot, hoursToExpiry: hoursLeft(snap.expiryTs, now) });
    const chosen = sel.legs[0];
    if (!chosen) { await finish('refused', `${describeSelection(sel)}${block}`); return; }

    const target = (rule.target === 'tp3' ? plan.tp3 : rule.target === 'tp2' ? plan.tp2 : null) ?? plan.tp1;
    const args = {
      ...placeArgs(s, {
        symbol: `${chosen.cp}-BTC-${chosen.strike}-${snap.expiry}`,
        optionSide: leg, strike: chosen.strike, expiryTs: snap.expiryTs,
        lots: chosen.lots, ask: chosen.ask, cancelAfterMs: SIGNAL_ENTRY_MS,
      }),
      // The signal's own levels, on the perp: the trade's real exits. The premium stop stays at Delta as the backstop.
      underlying: { dir, stop: plan.stop, target, source: 'BTC perp', entry: fill?.fillPrice ?? perpNow() },
      signal: { method: r.id, n: r.n, name: r.name, mode: r.mode, tf: r.tf, dir, triggerTime: r.triggerTime! },
    };
    const perpIn = args.underlying.entry;
    const what = `sell ${leg} ${chosen.strike} x${chosen.lots} @ ${chosen.price}`
      + elseWords(chosen)
      + ruleWords(chosen)
      + `${perpIn ? ` · perp ${fill ? 'filled' : 'at'} ${Math.round(perpIn)}` : ''} · perp SL ${Math.round(plan.stop)} · TGT ${Math.round(target)}${block}`;

    /*
     * A BUY-side strategy (5 Oct 2026). A buyer pays the offer: the order is a limit at the offer -- it crosses,
     * and it cannot pay more than the price it was judged at -- cancelled if still unfilled after
     * SIGNAL_ENTRY_MS. It goes through the buyer's gate (engine.ts `precheckBuy`), carries the perp's SL and TGT
     * as every signal trade does, and its own option target and stop as levels the desk judges on the bid.
     * With live orders off it is written down as the order it would be, as before.
     */
    if (action === 'buy') {
      // The option's own exits, where set, on the buyer's side of the offer paid: the target a sale over it, the stop a sale under it.
      const own = exitRules(s.config);
      const paid = Number(chosen.ask);
      const levelOf = (r: { mode: string; value: number }, up: boolean): number | null => (!(r.value > 0) || !(paid > 0) ? null
        : Math.max(0, Math.round((r.mode === 'pct' ? paid * (1 + (up ? r.value : -r.value)) : r.mode === 'points' ? paid + (up ? r.value : -r.value) : r.value) * 100) / 100));
      const ownTgt = levelOf(own.target, true), ownStop = levelOf(own.stop, false);
      const bought = `buy ${leg} ${chosen.strike} x${chosen.lots} @ ${chosen.ask ?? '—'}`
        + `${ownTgt !== null ? ` · option TGT ${ownTgt}` : ''}${ownStop !== null ? ` · option SL ${ownStop}` : ''}`
        + `${perpIn ? ` · perp ${fill ? 'filled' : 'at'} ${Math.round(perpIn)}` : ''} · perp SL ${Math.round(plan.stop)} · TGT ${Math.round(target)}${block}`;
      if (!(Number(chosen.ask) > 0)) { await finish('refused', `refused: ${leg} ${chosen.strike} has no offer to buy at${block}`); return; }
      if (!s.config.liveOrders) { await finish('would-place', `live orders off: would ${bought}`); return; }
      const { target: tgtRule, stop: stopRule } = exitRules(s.config);
      const buyArgs = {
        symbol: args.symbol, optionSide: leg, strike: chosen.strike, expiryTs: snap.expiryTs, lots: chosen.lots,
        strategyId: s.id, strategyName: s.name, origin: 'strategy' as const,
        action: 'buy' as const, limitPrice: paid, timeoutMs: SIGNAL_ENTRY_MS,
        longExits: {
          target: tgtRule.value > 0 ? { mode: tgtRule.mode, value: tgtRule.value } : null,
          stop: stopRule.value > 0 ? { mode: stopRule.mode, value: stopRule.value } : null,
        },
        underlying: args.underlying, signal: args.signal,
      };
      const res = await svc.place(buyArgs);
      if (!res.ok) {
        await finish('refused', `${bought} -- refused: ${res.precheck ? failureText(res.precheck) : 'refused'}`);
        this.alert((ctx) => runAlertFor({ strategy: s.name, status: 'failed', detail: `${said}: refused`, failedLegs: [bought], at: now }, ctx));
        return;
      }
      await finish('placed', bought, res.state.tradeId);
      this.alert((ctx) => runAlertFor({ strategy: s.name, status: 'placed', detail: `${said}: ${bought}`, failedLegs: [], at: now }, ctx));
      return;
    }

    if (!s.config.liveOrders) {
      const p = await svc.wouldPlace(args);
      // A gate's refusal names the strike it turned down and, where the rule failed, that it was the else strike:
      // the history's Skipped tab then says the whole of why, not only the gate's half.
      const turnedDown = `${leg} ${chosen.strike} @ ${chosen.price}${elseWords(chosen)}${ruleWords(chosen)}`;
      await finish(p.ok ? 'would-place' : 'refused', p.ok ? `live orders off: would ${what}` : `refused: ${turnedDown} — ${failureText(p)}${block}`);
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
