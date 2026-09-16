import type { PremiumAlert } from '../trading/store.js';

/**
 * "Tell me when this strike pays 5."
 *
 * A one-shot alert on a contract's bid, set from the best-trade card. The whole
 * of the decision is here, pure, so it can be tested without a ticker feed:
 * given an alert and the bid now, does it fire, and what does the message say.
 *
 * Three rules, each for a reason:
 *
 *   The bid, not the mark.   A seller receives the bid. An alert on the mark
 *                            would fire on a number nobody will pay.
 *   Once.                    It is a doorbell, not a siren. The store marks it
 *                            fired before the message goes, so a restart in
 *                            between cannot send it twice.
 *   Dead at expiry.          A contract that has settled has no bid to reach,
 *                            and an alert on it would sit in the list forever.
 */

export type BidNow = { symbol: string; bid: number | null };

export type Verdict =
  | { fire: true; bid: number }
  | { fire: false; why: 'already fired' | 'expired' | 'no bid' | 'below' };

export function judge(alert: PremiumAlert, now: { bid: number | null; nowTs: number }): Verdict {
  if (alert.firedAt !== null) return { fire: false, why: 'already fired' };
  if (now.nowTs >= alert.expiryTs) return { fire: false, why: 'expired' };
  if (now.bid === null || !(now.bid > 0)) return { fire: false, why: 'no bid' };
  if (now.bid < alert.threshold) return { fire: false, why: 'below' };
  return { fire: true, bid: now.bid };
}

/** The strike and side, from a symbol like C-BTC-80000-160926. */
export function contractWords(symbol: string): string {
  const [cp, , strike, expiry] = symbol.split('-');
  const side = cp === 'C' ? 'CE' : cp === 'P' ? 'PE' : cp ?? '?';
  const k = Number(strike);
  return `${Number.isFinite(k) ? k.toLocaleString('en-IN') : strike} ${side}${expiry ? ` · ${expiry}` : ''}`;
}

/** The Telegram message. HTML, like every other alert the desk sends. */
export function alertText(alert: PremiumAlert, bid: number, mode: 'live' | 'paper'): string {
  return [
    `🔔 <b>PREMIUM ALERT</b>${mode === 'paper' ? ' · PAPER' : ''}`,
    `${contractWords(alert.symbol)}`,
    '',
    `Bid is <b>${bid.toFixed(2)}</b> — you asked to hear at ${alert.threshold.toFixed(2)}.`,
    'This alert has fired and will not repeat. Set another from the desk if you want the next level.',
  ].join('\n');
}
