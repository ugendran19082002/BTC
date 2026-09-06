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
  usdinr,
}: {
  rec: Recommendation;
  market: MarketRead | null;
  minPremium: number;
  usdinr: number;
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

          {s.hedgeOrder && <div className="rec-order rec-hedge">{s.hedgeOrder}</div>}

          <div className="rec-chance">
            <span className={`chance ${chanceClass(s.zeroChance)}`}>
              {pct(s.zeroChance, 2)}
            </span>
            <span className="chance-label">
              expired at zero, historically
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

          <table className="probs">
            <tbody>
              <tr>
                <td className="left">lands out of the money at settlement</td>
                <td className={chanceClass(s.pExpireWorthless)}>{pct(s.pExpireWorthless, 2)}</td>
              </tr>
              <tr>
                <td className="left">touches the strike at some point</td>
                <td className={s.pTouch !== null && s.pTouch > 0.2 ? 'warn' : 'muted'}>
                  {pct(s.pTouch, 1)}
                </td>
              </tr>
              <tr>
                <td className="left">premium collapses to near nothing first</td>
                <td className="muted">{pct(s.pNearZero, 1)}</td>
              </tr>
              <tr>
                <td className="left dim">strike distance</td>
                <td className="dim">
                  {s.leg.distancePct >= 0 ? '+' : ''}{s.leg.distancePct.toFixed(2)}%
                </td>
              </tr>
            </tbody>
          </table>

          <div className="kv" style={{ marginTop: 6 }}>
            <span className="dim">break-even</span>
            <span>{s.breakeven.toFixed(0)}</span>
          </div>
          <div className="kv">
            <span className="dim">worst case, this leg</span>
            <span className={s.maxLoss === null ? 'down' : 'warn'}>
              {s.maxLoss === null ? 'unbounded — no hedge' : `$${s.maxLoss.toFixed(4)}`}
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
          <span>worst case, both legs</span>
          <span className="down">
            {rec.totalMaxLossUsd === null
              ? 'unbounded'
              : `$${rec.totalMaxLossUsd.toFixed(4)} · ₹${(rec.totalMaxLossUsd * usdinr).toFixed(2)}`}
          </span>
        </div>
        <div className="kv">
          <span>reward ÷ risk</span>
          <span className={rec.rewardToRisk !== null && rec.rewardToRisk < 0.05 ? 'warn' : ''}>
            {rec.rewardToRisk === null ? '·' : rec.rewardToRisk.toFixed(3)}
          </span>
        </div>
        <div className="kv">
          <span>margin</span>
          <span>${rec.marginUsd.toFixed(2)}</span>
        </div>
      </div>

      {rec.sides.some((s) => s.hedge) && rec.rewardToRisk !== null && rec.rewardToRisk < 0.05 && (
        <div className="note warn">
          The hedge costs nearly as much as the premium it protects. At the distance
          this strategy sells, the strike you would buy is priced almost identically
          to the one you sold, so the spread collects very little for the risk it
          still carries. That is why the measured version of this strategy is naked
          and controls risk by size instead.
        </div>
      )}
      {rec.hedgeMissing && (
        <div className="note warn">
          No strike is listed to buy at the gap you asked for, so at least one leg is
          naked. Across 733 days protection was available on roughly one day in four.
        </div>
      )}

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
