import type { Pick, Verdict } from '../types';

/**
 * The answer to the only question the desk is really asked: enter now, or not?
 *
 * Everything else on the page is evidence for this box. It leads with a verdict
 * rather than a table because a table asks the reader to do the reasoning, and
 * the reasoning is the part that was measured.
 */
export function VerdictPanel({
  verdict,
  picks,
  lots,
  usdinr,
}: {
  verdict: Verdict;
  picks: Pick[];
  lots: number;
  usdinr: number;
}) {
  const tone =
    verdict.action === 'ENTER' ? 'enter' : verdict.action === 'WAIT' ? 'wait' : 'aside';

  const totalCredit = picks.reduce((a, p) => a + p.netCreditUsd, 0) * lots;
  const anyNaked = picks.some((p) => p.naked);
  const totalMaxLoss = anyNaked
    ? null
    : picks.reduce((a, p) => a + (p.maxLossUsd ?? 0), 0) * lots;

  return (
    <div className={`verdict ${tone}`}>
      <div className="verdict-head">
        <span className="verdict-word">{verdict.headline}</span>
        {verdict.nextWindow && <span className="verdict-next">{verdict.nextWindow}</span>}
      </div>
      <p className="verdict-detail">{verdict.detail}</p>

      <ul className="checks">
        {verdict.checks.map((c, i) => (
          <li key={i} className={c.ok ? 'ok' : c.severity}>
            <span className="mark">{c.ok ? '✓' : c.severity === 'block' ? '✕' : '!'}</span>
            <span>{c.text}</span>
          </li>
        ))}
      </ul>

      {verdict.orders.length > 0 && (
        <div className="orders">
          <div className="orders-title">Orders to place</div>
          {verdict.orders.map((o, i) => (
            <div className="order" key={i}>{o}</div>
          ))}
          <div className="orders-foot">
            credit <b className="up">${totalCredit.toFixed(4)}</b>
            {' '}(₹{(totalCredit * usdinr).toFixed(2)})
            {'  ·  '}worst case{' '}
            <b className="down">
              {totalMaxLoss === null
                ? 'unbounded'
                : `$${totalMaxLoss.toFixed(4)} (₹${(totalMaxLoss * usdinr).toFixed(2)})`}
            </b>
          </div>
        </div>
      )}
    </div>
  );
}
