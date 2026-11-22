/**
 * The session square-off's order: the trade losing most, first (owner, 22 Nov 2026: "option 2 build panu").
 *
 * A square-off closes one trade at a time, about a second each: 257 to 308 trades took five to six minutes on each of the
 * four accounts squared off on 21 Nov 2026, and the loss ended ₹60–300 past the limit. In trade order, a contract running
 * against the account could wait minutes for its turn while it went on losing. This takes the trade with the most open
 * loss now -- bought back at the ask, as every open figure is (`closePriceOf`) -- before each close, so the positions doing
 * the damage go in the first seconds and the ranking follows the market as it moves.
 *
 * Only the order changes. Every trade is still closed, the same way, one at a time. The loss is read off the quotes
 * already in memory, never a call to Delta: a trade with no quote there ranks as nothing lost, after the losers and before
 * the winners. Ties keep the order the trades came in.
 */

/** The next trade to close: the most loss, the earliest of equals. -1 for none. */
export function worstIndex<T>(left: readonly T[], lossUsdOf: (r: T) => number | null): number {
  let at = -1;
  let worst = -Infinity;
  for (let i = 0; i < left.length; i++) {
    const raw = lossUsdOf(left[i]!);
    const loss = raw !== null && Number.isFinite(raw) ? raw : 0;
    if (loss > worst) { worst = loss; at = i; }
  }
  return at;
}

/** All of them in that order at once, as the ranking stands now: for a test, and for saying what will happen. */
export function worstFirst<T>(recs: readonly T[], lossUsdOf: (r: T) => number | null): T[] {
  const left = [...recs];
  const out: T[] = [];
  while (left.length) out.push(left.splice(worstIndex(left, lossUsdOf), 1)[0]!);
  return out;
}

/** One close of a session square-off: the ask the board held as it began, and what it filled at (22 Nov 2026). */
export type SquareOffFill = { tradeId: string; symbol: string; askAt: number | null; fillAvg: number | null; size: number; ms: number };

/**
 * What the square-off paid over the ask at each close, and how long it took (owner, 22 Nov 2026: "slippage measure").
 * On 21 Nov the fills read -3% to +5% on average against the minute's snapshot -- up to +20% on one account -- but that
 * snapshot was ~30 s old in a falling market, so whether the closes walked a contract's book up could not be told. This
 * reads each close against the ask the desk held as it began it. A close with no ask or no fill read is left out of the
 * averages and counted. Words for the session's square-off record, numbers for the log.
 */
export function fillReport(rows: readonly SquareOffFill[], ms: number): {
  words: string;
  stats: { closes: number; priced: number; avgOverPct: number | null; p90OverPct: number | null; worst: { symbol: string; overPct: number } | null; ms: number };
} {
  const priced = rows.filter((r) => r.askAt !== null && r.askAt > 0 && r.fillAvg !== null && r.fillAvg > 0)
    .map((r) => ({ symbol: r.symbol, overPct: (r.fillAvg! / r.askAt! - 1) * 100 }));
  const sorted = priced.map((p) => p.overPct).sort((a, b) => a - b);
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const avg = sorted.length ? r1(sorted.reduce((n, x) => n + x, 0) / sorted.length) : null;
  const p90 = sorted.length ? r1(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!) : null;
  const worstRow = priced.reduce<{ symbol: string; overPct: number } | null>((m, p) => (m === null || p.overPct > m.overPct ? p : m), null);
  const worst = worstRow ? { symbol: worstRow.symbol, overPct: r1(worstRow.overPct) } : null;
  const secs = Math.round(ms / 1000);
  const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  const sign = (n: number) => `${n >= 0 ? '+' : ''}${n}%`;
  const words = [
    `Square-off ${took}, ${rows.length} close${rows.length === 1 ? '' : 's'}`,
    avg !== null ? `fills vs the ask at each close: avg ${sign(avg)}, 90% within ${sign(p90!)}, worst ${sign(worst!.overPct)} (${worst!.symbol})` : 'no fill read against an ask',
    rows.length - priced.length > 0 ? `${rows.length - priced.length} not priced` : null,
  ].filter(Boolean).join(' · ');
  return { words, stats: { closes: rows.length, priced: priced.length, avgOverPct: avg, p90OverPct: p90, worst, ms } };
}
