import type { MarketRead, Recommendation } from '../types';

const pct = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined ? '·' : (v * 100).toFixed(d) + '%';

/** Green above 97%, amber 90-97, red below: the bands the data actually splits on. */
function chanceClass(p: number | null): string {
  if (p === null) return 'muted';
  if (p >= 0.97) return 'up';
  if (p >= 0.9) return 'warn';
  return 'down';
}

/**
 * What to sell, how much of it, and how often strikes like it have expired
 * worthless. The historical figure leads and the model figure follows it,
 * because the historical one is what a seller was actually exposed to.
 */
export function RecommendPanel({
  rec,
  market,
  minPremium,
}: {
  rec: Recommendation;
  market: MarketRead | null;
  minPremium: number;
}) {
  if (!rec.ok) {
    return (
      <div className="card recommend">
        <h2>What to sell</h2>
        <div className="muted" style={{ fontSize: 14 }}>{rec.why}</div>
        <div className="note">
          Standing aside is a position. On the 733 days measured, the days with no
          cheap strike listed were disproportionately the days that moved.
        </div>
      </div>
    );
  }

  return (
    <div className="card recommend">
      <h2>What to sell · premium ≥ ${minPremium}</h2>

      {rec.sides.map((s) => (
        <div className="rec-side" key={s.side}>
          <div className="rec-order">
            <span className={s.side === 'CE' ? 'ce' : 'pe'}>{s.side}</span>
            <b>{s.leg.strike}</b>
            <span className="dim">×{s.lots} lots</span>
            <span className="ml-auto">@ {s.price.toFixed(2)}</span>
          </div>

          <div className="rec-chance">
            <span className={`chance ${chanceClass(s.zeroChance)}`}>
              {pct(s.zeroChance, 2)}
            </span>
            <span className="chance-label">
              chance it expires at zero
              <br />
              <span className="dim">
                {s.sample
                  ? `${s.sample.toLocaleString()} strikes like it, over 733 settlements`
                  : 'no comparable history'}
                {s.modelChance !== null && ` · the model says ${pct(s.modelChance)}`}
                {s.leg.zero && !s.leg.zero.comparableHorizon && (
                  <>
                    <br />
                    <span className="warn">
                      measured on ~12 hour trades; this contract has a different
                      horizon, so read it as a guide rather than a rate
                    </span>
                  </>
                )}
              </span>
            </span>
          </div>
        </div>
      ))}

      <div className="rec-foot">
        <div className="kv">
          <span>split</span>
          <span>CE {(rec.split.ce * 100).toFixed(0)}% / PE {(rec.split.pe * 100).toFixed(0)}%</span>
        </div>
        <div className="kv">
          <span>credit if both expire at zero</span>
          <span className="up">${rec.totalCreditUsd.toFixed(4)} · ₹{rec.totalCreditInr.toFixed(2)}</span>
        </div>
        <div className="kv">
          <span>both expire at zero</span>
          <span className={chanceClass(rec.bothZeroChance)}>{pct(rec.bothZeroChance, 1)}</span>
        </div>
        <div className="kv">
          <span>margin</span>
          <span>${rec.marginUsd.toFixed(2)}</span>
        </div>
      </div>

      <div className="note">{rec.splitReason}</div>

      {market && (
        <div className="note">
          Market read: {market.regime}
          {market.return24h !== null && `, ${market.return24h >= 0 ? '+' : ''}${market.return24h.toFixed(2)}% in 24h`}
          {market.realisedVol !== null && `, realised vol ${market.realisedVol.toFixed(0)}%`}.
          {' '}{market.timeframes.map((t) => `${t.tf} ${t.label}`).join(' · ')}.
        </div>
      )}

      <div className="note dim">
        No arrangement of indicators makes this certain. The best-behaved strikes in
        two years of settlements expired worthless 99.58% of the time — not 100% — and
        the days that missed are the ones that cost the most. Size for the miss.
      </div>
    </div>
  );
}
