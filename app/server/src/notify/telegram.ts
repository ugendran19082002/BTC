import type { Alert } from './messages.js';

/**
 * Telegram, as somewhere to put alerts -- and nothing more.
 *
 * Three promises, each there because an alert channel that breaks it is worse
 * than having none:
 *
 *   - **It never throws and never blocks.** It is called from inside the
 *     engine's commit. A phone notification must not be able to delay, fail or
 *     reorder a trade, so `notify` returns before anything touches the network
 *     and every failure ends as a logged row, never an exception.
 *   - **It never leaks the token.** The token travels in the request URL, so
 *     neither the URL nor any error text that might quote it is handed back.
 *   - **It does not spam.** A large order fills in pieces. Alerts for the same
 *     trade and leg are held for a moment and only the newest one is sent --
 *     and beyond that hold, a message that says exactly what the last one for
 *     that key said is not sent again for a quarter of an hour. Some alerts
 *     ask for more than that: a problem that the desk retries every few
 *     seconds names its own quiet period (`repeatAfterMs`), so "NO STOP-LOSS"
 *     arrives once and is repeated as a reminder, not once per retry.
 */

const API = 'https://api.telegram.org';
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
/** Telegram names a wait on a 429. Beyond this the alert is stale anyway. */
const MAX_RETRY_AFTER_S = 30;
const HOUR_MS = 3_600_000;

export type TelegramOptions = {
  token: string;
  chatId: string;
  /** Injected by tests. */
  fetch?: typeof fetch;
  /** Injected by tests, so a retry does not have to actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Quiet period after the latest fill before the message goes out. */
  coalesceMs?: number;
  /** Longest a message is held while fills keep arriving. */
  maxWaitMs?: number;
  /**
   * How long the same words for the same key are not said again. The default
   * is 15 minutes. An alert may ask for longer with `repeatAfterMs`.
   */
  repeatMs?: number;
  /** Told when a message was held back as a repeat, for the health line. */
  onRepeat?: (key: string, sinceMs: number) => void;
  /** Injected by tests. */
  now?: () => number;
  /** Where a message that could not be delivered is written down. */
  onError?: (message: string, context: Record<string, unknown>) => void;
};

type Reply = { ok: boolean; status: number; description: string; retryAfter?: number };

export class TelegramNotifier {
  private readonly pending = new Map<
    string,
    { text: string; timer: ReturnType<typeof setTimeout>; firstAt: number; repeatAfterMs: number }
  >();
  /** One message at a time, in order: an exit must never arrive before its entry. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** The last thing said under each key, and when: what a repeat is judged against. */
  private readonly said = new Map<string, { text: string; at: number }>();
  private readonly coalesceMs: number;
  private readonly maxWaitMs: number;
  private readonly repeatMs: number;
  private readonly now: () => number;
  /** How many messages the repeat guard has held back, for the health line. */
  private held = 0;

  constructor(private readonly o: TelegramOptions) {
    this.fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.coalesceMs = o.coalesceMs ?? 4_000;
    this.maxWaitMs = o.maxWaitMs ?? 15_000;
    this.repeatMs = o.repeatMs ?? 15 * 60_000;
    this.now = o.now ?? Date.now;
  }

  /** How many repeats have been held back since the desk started. */
  get repeatsHeld(): number { return this.held; }

  /** Queue an alert. A later alert with the same key replaces it until it is sent. */
  notify(alert: Alert): void {
    const now = this.now();
    const held = this.pending.get(alert.key);
    if (held) clearTimeout(held.timer);
    const firstAt = held?.firstAt ?? now;
    // A trailing wait, capped: a chase that keeps filling still gets reported.
    const wait = Math.max(0, Math.min(this.coalesceMs, firstAt + this.maxWaitMs - now));
    const timer = setTimeout(() => this.flush(alert.key), wait);
    timer.unref?.();
    this.pending.set(alert.key, {
      text: alert.text, timer, firstAt, repeatAfterMs: alert.repeatAfterMs ?? 0,
    });
  }

  /** Send straight away, skipping the hold. True when Telegram accepted it. */
  send(text: string): Promise<boolean> {
    const run = this.chain.then(() => this.deliver(text));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Send everything being held and wait until all of it has been tried. */
  async drain(): Promise<void> {
    for (const [key, held] of [...this.pending]) {
      clearTimeout(held.timer);
      this.flush(key);
    }
    await this.chain;
  }

  private flush(key: string): void {
    const held = this.pending.get(key);
    if (!held) return;
    this.pending.delete(key);

    /*
     * The repeat guard, and the reason it exists.
     *
     * The desk retries a protective order that Delta refused every few seconds,
     * and each attempt that fails is a fresh `protection_failed` with the
     * exchange's own words in it. When those words change -- or when a partial
     * success clears the alarm and the next failure raises it again -- the
     * engine sees "a new alarm" and the phone gets "NO STOP-LOSS" again, once
     * per retry, for as long as the trouble lasts. The alert is right and the
     * frequency makes it useless.
     *
     * So: the same words under the same key are not repeated for `repeatMs`,
     * and an alert may ask for a longer quiet period of its own, in which case
     * nothing under that key is said again inside it, whatever the words. Both
     * let the reminder through once the period is up -- a position with no stop
     * should be said again, in a quarter of an hour, not in two seconds.
     */
    const now = this.now();
    const said = this.said.get(key);
    if (said) {
      const since = now - said.at;
      const quiet = Math.max(held.repeatAfterMs, said.text === held.text ? this.repeatMs : 0);
      if (since < quiet) {
        this.held += 1;
        try { this.o.onRepeat?.(key, since); } catch { /* a reporter that throws is not the trade's problem */ }
        return;
      }
    }
    this.said.set(key, { text: held.text, at: now });
    this.forget(now);
    void this.send(held.text).then((ok) => {
      // Nothing was said, so nothing is being repeated: let the next one go.
      if (!ok && this.said.get(key)?.at === now) this.said.delete(key);
    });
  }

  /** Drop what is too old to suppress anything, so the map cannot grow for ever. */
  private forget(now: number): void {
    if (this.said.size < 64) return;
    for (const [k, v] of this.said) if (now - v.at > Math.max(this.repeatMs, HOUR_MS)) this.said.delete(k);
  }

  private async deliver(text: string): Promise<boolean> {
    let html = true;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const reply = await this.post(html ? text : plain(text), html);
      if (reply.ok) return true;

      if (html && reply.status === 400 && /can't parse entities/i.test(reply.description)) {
        // A markup mistake is our bug, and it must not cost the alert. Send the
        // same words without formatting; this does not count as an attempt.
        html = false;
        attempt--;
        continue;
      }

      // Network, timeout, rate limit or Telegram's own trouble: worth another
      // go. Anything else -- a wrong token, a blocked bot, a bad chat id -- will
      // fail the same way every time, so it is reported once instead.
      const retryable = reply.status === 0 || reply.status === 429 || reply.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) {
        this.report(`telegram alert not delivered: ${reply.description}`, { status: reply.status, attempts: attempt });
        return false;
      }
      await this.sleep(reply.status === 429
        ? Math.min(MAX_RETRY_AFTER_S, reply.retryAfter ?? 1) * 1_000
        : 1_000 * 2 ** (attempt - 1));
    }
    return false;
  }

  private async post(text: string, html: boolean): Promise<Reply> {
    try {
      const res = await this.fetch(`${API}/bot${this.o.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.o.chatId,
          text,
          ...(html ? { parse_mode: 'HTML' } : {}),
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await res.json().catch(() => ({})) as {
        ok?: boolean; description?: string; parameters?: { retry_after?: number };
      };
      return {
        ok: res.ok && body.ok !== false,
        status: res.status,
        description: this.scrub(body.description ?? `HTTP ${res.status}`),
        retryAfter: body.parameters?.retry_after,
      };
    } catch (e) {
      return { ok: false, status: 0, description: this.scrub((e as Error)?.message ?? String(e)) };
    }
  }

  private report(message: string, context: Record<string, unknown>): void {
    try { this.o.onError?.(message, context); } catch { /* a reporter that throws must not reach the engine */ }
  }

  /** Error text can quote the URL, and the URL holds the token. */
  private scrub(s: string): string {
    return s.split(this.o.token).join('<token>');
  }
}

/** The same words without markup, for when Telegram refuses the markup. */
const plain = (html: string) => html
  .replace(/<[^>]*>/g, '')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&');
