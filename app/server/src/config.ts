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

const flag = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true';

export type Config = {
  port: number;
  logLevel: string;
  /** Placing real orders is off unless this is switched on deliberately. */
  liveTrading: boolean;
};

export const config: Config = {
  port: num(process.env.PORT, 8787),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  liveTrading: flag(process.env.DELTA_LIVE_TRADING),
};
