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
