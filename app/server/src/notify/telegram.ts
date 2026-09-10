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
 *     trade and leg are held for a moment and only the newest one is sent.
 */

const API = 'https://api.telegram.org';
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
/** Telegram names a wait on a 429. Beyond this the alert is stale anyway. */
const MAX_RETRY_AFTER_S = 30;

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
  /** Where a message that could not be delivered is written down. */
  onError?: (message: string, context: Record<string, unknown>) => void;
};

type Reply = { ok: boolean; status: number; description: string; retryAfter?: number };

export class TelegramNotifier {
  private readonly pending = new Map<string, { text: string; timer: ReturnType<typeof setTimeout>; firstAt: number }>();
  /** One message at a time, in order: an exit must never arrive before its entry. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly coalesceMs: number;
  private readonly maxWaitMs: number;

  constructor(private readonly o: TelegramOptions) {
    this.fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.coalesceMs = o.coalesceMs ?? 4_000;
    this.maxWaitMs = o.maxWaitMs ?? 15_000;
  }

  /** Queue an alert. A later alert with the same key replaces it until it is sent. */
  notify(alert: Alert): void {
    const now = Date.now();
    const held = this.pending.get(alert.key);
    if (held) clearTimeout(held.timer);
    const firstAt = held?.firstAt ?? now;
    // A trailing wait, capped: a chase that keeps filling still gets reported.
    const wait = Math.max(0, Math.min(this.coalesceMs, firstAt + this.maxWaitMs - now));
    const timer = setTimeout(() => this.flush(alert.key), wait);
    timer.unref?.();
    this.pending.set(alert.key, { text: alert.text, timer, firstAt });
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
    void this.send(held.text);
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
