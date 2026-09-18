import type { BestTrade } from '../domain/best-trade.js';

/** How many times one strike may be announced for one contract, by default. */
export const BEST_TRADE_REPEAT_DEFAULT = 1;
/** And at most, whatever the setting says. */
export const BEST_TRADE_REPEAT_MAX = 10;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "160926" -> "16 Sep". Anything that is not a DDMMYY code comes back as it was. */
export function expiryLabel(code: string): string {
  const m = /^(\d{2})(\d{2})\d{2}$/.exec(code);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${Number(m[1])} ${month}` : code;
}

/**
 * "There is a new best pick": the message, in plain words.
 *
 * It used to read like the card pasted into a chat -- "rank 87/100 · Chance you
 * keep it all: 100.0% · price gets there first: 3% · 3.20x the usual move away ·
 * how easy to trade: 42/100", run together on three lines. Every figure was
 * right and none of it could be read at a glance on a lock screen. Now it is one
 * fact per line, each with a label a person would use, the headline first.
 *
 * `sent` says which announcement of this strike this is, so a reader knows
 * whether to expect another before the contract expires.
 */
export function bestTradeText(
  best: BestTrade,
  expiry: string,
  mode: 'live' | 'paper',
  now: number,
  sent?: { n: number; of: number },
): string {
  const p = best.pick!;
  const pct = (v: number | null, places = 0) => (v === null ? '—' : `${(v * 100).toFixed(places)}%`);
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(now);
  return [
    `🎯 <b>New best pick</b>${mode === 'paper' ? ' · PAPER' : ''} · ${when} IST`,
    `<b>Sell ${p.side} ${p.strike.toLocaleString('en-IN')}</b> · expires ${expiryLabel(expiry)}, 5:30 PM`,
    '',
    `💰 You get: <b>${p.premiumUsd.toFixed(2)}</b>`,
    `✅ Chance it expires worthless: ${pct(p.expiryOtm, 1)}`,
    `📍 Chance the price reaches it first: ${pct(p.touch)}`,
    ...(p.emBuffer === null ? [] : [`📏 Distance: ${p.emBuffer.toFixed(2)}× a normal move`]),
    `💧 Easy to trade: ${p.liquidity}/100`,
    p.maxLossUsd === null
      ? '⚠️ Max loss: no limit (no safety leg)'
      : `🛡 Max loss: $${p.maxLossUsd.toFixed(2)} (with safety leg)`,
    `⭐ Score: ${p.rank}/100`,
    '',
    best.agreesWithEngine
      ? '👍 The tested rule picks this strike too.'
      : '⚠️ The tested rule picks a different strike — go with the tested rule.',
    `Only strikes paying $${best.minPremiumUsd} or more. Nothing was placed.`,
    ...(sent ? [`🔁 Alert ${sent.n} of ${sent.of} for this strike before it expires.`] : []),
  ].join('\n');
}
