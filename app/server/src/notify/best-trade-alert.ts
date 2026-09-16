import type { BestTrade } from '../domain/best-trade.js';

/**
 * "The best pick changed": the message, in the words the card uses.
 *
 * Only ever sent when the strike named is different from the last one sent,
 * so it can carry the whole card -- the reader has not seen these numbers.
 */
export function bestTradeText(best: BestTrade, expiry: string, mode: 'live' | 'paper', now: number): string {
  const p = best.pick!;
  const pct = (v: number | null, places = 0) => (v === null ? '—' : `${(v * 100).toFixed(places)}%`);
  const when = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  return [
    `🎯 <b>BEST PICK CHANGED</b>${mode === 'paper' ? ' · PAPER' : ''} · ${when} IST`,
    `<b>SELL ${p.side} ${p.strike.toLocaleString('en-IN')}</b> · ${expiry}`,
    '',
    `You'd be paid <b>${p.premiumUsd.toFixed(2)}</b> · rank ${p.rank}/100`,
    `Chance you keep it all: ${pct(p.expiryOtm, 1)} · price gets there first: ${pct(p.touch)}`,
    `${p.emBuffer === null ? '' : `${p.emBuffer.toFixed(2)}× the usual move away · `}how easy to trade: ${p.liquidity}/100`,
    p.maxLossUsd === null
      ? 'Most you can lose: no limit — no safety leg'
      : `Most you can lose: $${p.maxLossUsd.toFixed(2)} with the safety leg · paid ÷ risk ${p.creditRisk?.toFixed(2) ?? '—'}`,
    best.agreesWithEngine ? 'The tested rule picks this too.' : 'The tested rule picks differently — follow the tested rule.',
    '',
    `Only strikes paying $${best.minPremiumUsd}+ were considered. Nothing has been placed.`,
  ].join('\n');
}
