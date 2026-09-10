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
};

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
};

