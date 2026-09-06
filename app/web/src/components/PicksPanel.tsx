import type { Pick } from '../types';

const usd = (v: number) => `$${v.toFixed(4)}`;

export function PicksPanel({
  picks,
  lots,
  usdinr,
  minPremium,
}: {
  picks: Pick[];
  lots: number;
  usdinr: number;
  minPremium: number;
}) {
  if (!picks.length) {
    return (
      <div className="card">
        <h2>Sell candidates</h2>
        <div className="muted">
          No out-of-the-money strike is quoted at ${minPremium} or more right now.
        </div>
        <div className="note">
          That is information, not a failure. When the whole chain is priced below
          your premium floor, the market is paying too little for the risk and the
          correct action is to stand aside.
        </div>
      </div>
    );
  }

  const totalCredit = picks.reduce((a, p) => a + p.netCreditUsd, 0) * lots;
  const anyNaked = picks.some((p) => p.naked);
  const totalMaxLoss = anyNaked
    ? null
    : picks.reduce((a, p) => a + (p.maxLossUsd ?? 0), 0) * lots;

  return (
    <div className="card">
      <h2>Sell candidates — premium ≥ ${minPremium}</h2>
      {picks.map((p) => (
        <div key={p.side} style={{ marginBottom: 14 }}>
          <div className="kv">
            <span className={p.side === 'CE' ? 'ce' : 'pe'}>
              <b>{p.side}</b> sell {p.leg.strike}
              {p.naked ? (
                <span className="tag danger">naked</span>
              ) : (
                <span className="tag ok">hedged {p.hedgeGapUsed}×200</span>
              )}
            </span>
            <span>@ {p.leg.sellPrice?.toFixed(2)}</span>
          </div>
          <div className="kv">
            <span className="dim">finishes worthless</span>
            <span>{p.leg.pOtm != null ? `${(p.leg.pOtm * 100).toFixed(1)}%` : '·'}</span>
          </div>
          <div className="kv">
            <span className="dim">buy protection at</span>
            <span>{p.hedge ? `${p.hedge.strike} @ ${(p.hedge.ask ?? p.hedge.mark ?? 0).toFixed(2)}` : '—'}</span>
          </div>
          <div className="kv">
            <span className="dim">breakeven</span>
            <span>{p.breakeven.toFixed(0)}</span>
          </div>
          <div className="kv">
            <span className="dim">credit · {lots} lots</span>
            <span className="up">{usd(p.netCreditUsd * lots)}</span>
          </div>
          <div className="kv">
            <span className="dim">worst case · {lots} lots</span>
            <span className="down">
              {p.maxLossUsd === null ? 'unbounded' : usd(p.maxLossUsd * lots)}
            </span>
          </div>
          {p.leg.reasons.length > 0 && (
            <div className="note" style={{ marginTop: 4 }}>{p.leg.reasons.join(' · ')}</div>
          )}
        </div>
      ))}

      <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
        <div className="kv">
          <span>total credit</span>
          <span className="up">
            {usd(totalCredit)} <span className="dim">= ₹{(totalCredit * usdinr).toFixed(2)}</span>
          </span>
        </div>
        <div className="kv">
          <span>total worst case</span>
          <span className="down">
            {totalMaxLoss === null
              ? 'unbounded'
              : `${usd(totalMaxLoss)} = ₹${(totalMaxLoss * usdinr).toFixed(2)}`}
          </span>
        </div>
      </div>

      {anyNaked && (
        <div className="note">
          At least one leg has no protective long, so its loss is bounded only by
          how far BTC can travel before settlement. Set a hedge gap above zero to
          cap it — the hedge costs part of the credit and buys a known worst case
          in return.
        </div>
      )}
    </div>
  );
}
