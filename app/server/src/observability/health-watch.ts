/**
 * Telling the owner, on Telegram, when the desk stops hearing the market or its own thread stops (19 Nov 2026).
 *
 * Everything here was already measured -- the minute line counts the holds of the thread, each socket keeps the time
 * it last heard anything -- and none of it reached the phone: a feed could be down for an hour and the first sign was
 * a day with no trades. So, from what is already measured and nothing more (no call to Delta, no read of the
 * database), every `HEALTH_LOOK_MS`:
 *
 *   - the trading thread held `FREEZE_ALERT_MS` or more: said once it is free again (a held thread cannot speak), at
 *     most one message in `FREEZE_ALERT_GAP_MS`, every hold since the last one in it;
 *   - the option tickers or the trade flow silent for `FEED_QUIET_MS`;
 *   - an account's private socket not live for `PRIVATE_DOWN_MS` -- it reconnects by itself within seconds, so only
 *     one that stays down is news;
 *
 * and each of those again when it comes back, under the same key. A standby process (it does not hold the desk lock)
 * says nothing: the desk trading says it. The first `HEALTH_GRACE_MS` after a start are let pass -- the sockets are
 * still opening and the boot's own reads hold the thread.
 */
import type { Alert } from '../notify/messages.js';
import { feedAlert, freezeAlert } from '../notify/messages.js';

export const FREEZE_ALERT_MS = 2_000;
export const FREEZE_ALERT_GAP_MS = 10 * 60_000;
export const FEED_QUIET_MS = 120_000;
export const PRIVATE_DOWN_MS = 120_000;
export const HEALTH_GRACE_MS = 180_000;
export const HEALTH_LOOK_MS = 15_000;
/** How often the thread is timed for a hold: a tick that comes this much late, plus the hold, was held. */
const FREEZE_TICK_MS = 250;

export type HealthProbes = {
  /** The option ticker socket: when it last heard anything. */
  ticker: () => { lastMessageAt: number | null };
  /** The trade-flow socket (the perp and the watched options' prints). */
  flow: () => { lastMessageAt: number | null };
  /** Each trading account's private socket. */
  privateSockets: () => readonly { accountId: number; name: string; live: boolean; lastMessageAt: number | null }[];
  /** This process is the desk trading (it holds the desk lock). */
  inCharge: () => boolean;
};

type Down = { since: number; told: boolean };

export class HealthWatch {
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly down = new Map<string, Down>();
  private holds: { at: number; ms: number }[] = [];
  private holdToldAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly o: { probes: HealthProbes; notify: (a: Alert) => void; now?: () => number }) {
    this.now = o.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** A hold of the thread, as the tick measured it (`startHealthWatch`): kept for the next look when long enough. */
  noteHold(ms: number, at: number): void {
    if (ms >= FREEZE_ALERT_MS && this.holds.length < 1_000) this.holds.push({ at, ms: Math.round(ms) });
  }

  /** One look. Never throws: a health check is never worth a failure of its own. */
  look(): void {
    try {
      const now = this.now();
      if (!this.o.probes.inCharge() || now - this.startedAt < HEALTH_GRACE_MS) {
        this.holds = [];
        return;
      }
      if (this.holds.length && now - this.holdToldAt >= FREEZE_ALERT_GAP_MS) {
        this.o.notify(freezeAlert(this.holds, now));
        this.holds = [];
        this.holdToldAt = now;
      }
      const t = this.o.probes.ticker().lastMessageAt;
      this.judge('ticker', 'Option tickers', quietFor(t, now, this.startedAt) >= FEED_QUIET_MS, 0, t, now,
        'Quotes older than five seconds are refused, so no option is sold while it is down. Stops and targets already at Delta stay there.');
      const f = this.o.probes.flow().lastMessageAt;
      this.judge('flow', 'Trade flow', quietFor(f, now, this.startedAt) >= FEED_QUIET_MS, 0, f, now,
        'The perp\'s prints and the option flow are not coming in: signals and the perp watch work from older data.');
      const seen = new Set<string>();
      for (const s of this.o.probes.privateSockets()) {
        const key = `private:${s.accountId}`;
        seen.add(key);
        this.judge(key, `Private socket · ${s.name}`, !s.live, PRIVATE_DOWN_MS, s.lastMessageAt, now,
          'Fills and cancels are not heard at once; the desk\'s own pass still reads every trade from Delta, only later.');
      }
      // An account switched off has no socket any more: not "down", just gone.
      for (const key of this.down.keys()) if (key.startsWith('private:') && !seen.has(key)) this.down.delete(key);
    } catch { /* as above */ }
  }

  private judge(key: string, what: string, bad: boolean, holdMs: number, lastAt: number | null, now: number, effect: string): void {
    const d = this.down.get(key);
    if (bad) {
      const held = d ?? { since: now, told: false };
      if (!d) this.down.set(key, held);
      if (!held.told && now - held.since >= holdMs) {
        held.told = true;
        this.o.notify(feedAlert({ key, what, down: true, since: held.since, lastAt, at: now, effect }));
      }
    } else if (d) {
      this.down.delete(key);
      if (d.told) this.o.notify(feedAlert({ key, what, down: false, since: d.since, lastAt, at: now, effect }));
    }
  }
}

/** How long a feed has said nothing; one that never spoke, since the desk started. */
const quietFor = (lastAt: number | null, now: number, startedAt: number) => now - (lastAt ?? startedAt);

/** The watch, its look every `HEALTH_LOOK_MS` and its timing of the thread. Timers do not keep the process alive. */
export function startHealthWatch(o: ConstructorParameters<typeof HealthWatch>[0]): { watch: HealthWatch; stop: () => void } {
  const watch = new HealthWatch(o);
  let last = performance.now();
  const tick = setInterval(() => {
    const t = performance.now();
    const late = t - last - FREEZE_TICK_MS;
    last = t;
    if (late > 0) watch.noteHold(late, Date.now() - Math.round(late));
  }, FREEZE_TICK_MS);
  const looking = setInterval(() => watch.look(), HEALTH_LOOK_MS);
  tick.unref();
  looking.unref();
  return { watch, stop: () => { clearInterval(tick); clearInterval(looking); } };
}
