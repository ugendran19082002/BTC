/**
 * "NO STOP-LOSS" for several trades at once, said once (21 Nov 2026). At 09:01:30 IST Delta pulled the stops of 17
 * trades on two puts in the same second (`immediate_liquidation`); each trade's alert went out on its own key, and the
 * phone got 17 messages in 23 seconds -- the alert that matters most, made into noise. The desk closed every one of them
 * at the market two to four seconds later; the alerts said nothing of that, seventeen times.
 *
 * Now each trade's alert is held `NO_STOP_BATCH_MS`: one alone goes out as it was; two or more go out as one message
 * (`noStopBatchAlert`). A trade said in the last `PROBLEM_REPEAT_MS` is not said again -- the guard each trade's own key
 * gave it -- so a retry whose words change does not raise it a second time.
 */
import { PROBLEM_REPEAT_MS, type Alert } from './messages.js';

export const NO_STOP_BATCH_MS = 3_000;

export type NoStopItem<P> = { tradeId: string; alert: Alert; plan: P; held: number; short: boolean; alarm: string };

export class NoStopBatch<P> {
  private items: NoStopItem<P>[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly said = new Map<string, number>();
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;

  constructor(private readonly o: {
    /** Send one alert. */
    notify: (a: Alert) => void;
    /** The one message for several, with the moment it is said. */
    many: (items: readonly NoStopItem<P>[], at: number) => Alert;
    now?: () => number;
    schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  }) {
    this.now = o.now ?? Date.now;
    this.schedule = o.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  }

  add(item: NoStopItem<P>): void {
    const now = this.now();
    const last = this.said.get(item.tradeId);
    if (last !== undefined && now - last < PROBLEM_REPEAT_MS) return;
    if (this.items.some((x) => x.tradeId === item.tradeId)) return;
    this.items.push(item);
    this.timer ??= this.schedule(() => this.flush(), NO_STOP_BATCH_MS);
  }

  /** Say what is held. Never throws: an alert is never worth a trade. */
  flush(): void {
    const items = this.items;
    this.items = [];
    this.timer = null;
    if (!items.length) return;
    const now = this.now();
    for (const x of items) this.said.set(x.tradeId, now);
    for (const [id, at] of this.said) if (now - at >= PROBLEM_REPEAT_MS) this.said.delete(id);
    try { this.o.notify(items.length === 1 ? items[0]!.alert : this.o.many(items, now)); } catch { /* as above */ }
  }
}
