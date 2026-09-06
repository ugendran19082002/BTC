import type { MarketRead, SnapshotMeta } from '../types';

const money = (v: number | null) =>
  v === null ? '·' : (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toFixed(0);

/**
 * What BTC has actually done, next to what the option market says it will do.
 *
 * The comparison is the point. Across 733 days the previous 24 hours moved a
 * median of 1.72 times the expected move being sold that morning, so a strike
 * one expected move away is not one day's travel away.
 *
 * It is shown as context and nothing more: skipping days when the ratio ran hot
 * was tested as a filter and failed — it looked excellent in 2026 and collapsed
 * to a profit factor of 1.06 in 2024, which is what an overfit rule looks like.
 */
export function MovePanel({ market, snap }: { market: MarketRead; snap: SnapshotMeta }) {
  const last24 = market.moves.find((m) => m.hours === 24);
  const em = snap.expectedMove;
  const ratio =
    em && em > 0 && last24?.rangeUsd ? last24.rangeUsd / em : null;

  return (
    <div className="card">
      <h2>How far it has actually moved</h2>

      <table className="moves">
        <thead>
          <tr><th className="left">window</th><th>change</th><th>%</th><th>range</th><th>%</th></tr>
        </thead>
        <tbody>
          {market.moves.map((m) => (
            <tr key={m.label}>
              <td className="left muted">{m.label}</td>
              <td className={(m.changeUsd ?? 0) >= 0 ? 'up' : 'down'}>{money(m.changeUsd)}</td>
              <td className={(m.changePct ?? 0) >= 0 ? 'up' : 'down'}>
                {m.changePct === null ? '·' : `${m.changePct >= 0 ? '+' : ''}${m.changePct.toFixed(2)}%`}
              </td>
              <td>{m.rangeUsd === null ? '·' : `$${m.rangeUsd.toFixed(0)}`}</td>
              <td>{m.rangePct === null ? '·' : `${m.rangePct.toFixed(2)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="kv" style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
        <span>biggest day, last 30</span>
        <span>
          {market.max24hRangeUsd === null
            ? '·'
            : `$${market.max24hRangeUsd.toFixed(0)} · ${market.max24hRangePct?.toFixed(2)}%`}
        </span>
      </div>
      <div className="kv">
        <span>market is pricing</span>
        <span>{em === null ? '·' : `±$${em.toFixed(0)}`}</span>
      </div>
      <div className="kv">
        <span>last 24h range ÷ that</span>
        <span className={ratio === null ? 'muted' : ratio > 2 ? 'warn' : 'up'}>
          {ratio === null ? '·' : `${ratio.toFixed(2)}×`}
        </span>
      </div>

      <div className="note">
        Over 733 days the previous 24 hours moved a median of <b>1.72×</b> the
        expected move being sold that morning. A strike one expected move out is
        not a day's travel away — it is well inside what BTC does routinely.
      </div>
      <div className="note dim">
        Context, not a rule. Standing aside when this ratio ran hot was tested and
        rejected: profit factor 11.45 in 2026, 1.06 in 2024. That is an overfit,
        not an edge.
      </div>
    </div>
  );
}
