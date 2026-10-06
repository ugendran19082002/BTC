/**
 * Every environment variable this process reads, in one place.
 *
 * Read once at startup so that a later log line, error handler or stack trace
 * cannot pick a secret out of `process.env` after the fact.
 */

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const isOff = (v: string | undefined) => v === '0' || v?.toLowerCase() === 'false';

export type Config = {
  port: number;
  logLevel: string;
  /**
   * Whether the desk starts on the real exchange.
   *
   * Live is the default once credentials exist, because a desk that silently
   * paper-trades while you think it is working is its own kind of accident.
   * `DELTA_LIVE_TRADING=0` forces paper and cannot be overridden from the
   * browser; with no credentials at all it is paper regardless.
   *
   * Whichever this says, the mode is on screen at all times and the switch is
   * one tap away.
   */
  liveTradingDefault: boolean;
  /** True when the environment explicitly forbids live trading. */
  paperLocked: boolean;
  /**
   * Where fill alerts go. Null unless both halves are set, and then nothing is
   * sent and nothing complains: an alert is a convenience, never a gate.
   *
   * The token is a password for the bot -- whoever holds it can post as it. It
   * is read here once and handed only to the notifier, which never logs it or
   * the URL it travels in.
   */
  telegram: { token: string; chatId: string } | null;
  /**
   * The desk's database: trades, strategies, settings, sign-in, the error log
   * and open-interest history, one PostgreSQL database with a schema each.
   *
   * A connection URL, so the password travels inside it and is never logged
   * on its own. Null when unset; the pool refuses to open and says why, because
   * a desk with nowhere to write its journal must not start.
   */
  databaseUrl: string | null;
  /**
   * Which build this process is: the image tag the deploy script built
   * (`<commit>` or `<commit>-dirty-<time>`), handed in by compose. Shown on the
   * screen so "is the fix live yet" is read, not guessed. Null when run by
   * hand, outside an image.
   */
  buildTag: string | null;
  /**
   * Where the desk is reached from outside, e.g. `https://delta.thannigo.in` (6 Oct 2026): a fill alert then links
   * to the trade on the phone (`/m?trade=<id>`). Null when unset or not an http(s) address -- the alerts are
   * sent as before, without the link, rather than with one that goes nowhere.
   */
  deskUrl: string | null;
};

/** An http(s) origin with no trailing slash, or null. */
export function deskUrlOf(v: string | undefined): string | null {
  const raw = v?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

const telegramFromEnv = (): Config['telegram'] => {
  const token = process.env.TG_TOKEN?.trim();
  const chatId = process.env.TG_CHAT_ID?.trim();
  return token && chatId ? { token, chatId } : null;
};

export const config: Config = {
  port: num(process.env.PORT, 8787),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  liveTradingDefault: !isOff(process.env.DELTA_LIVE_TRADING),
  paperLocked: isOff(process.env.DELTA_LIVE_TRADING),
  telegram: telegramFromEnv(),
  databaseUrl: process.env.DATABASE_URL?.trim() || null,
  buildTag: process.env.BUILD_TAG?.trim() || null,
  deskUrl: deskUrlOf(process.env.DESK_URL),
};

/** When this process started, for the build line on the screen. */
export const STARTED_AT = Date.now();

