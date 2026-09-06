import type { Bias, SnapshotMeta } from '../types';

export function BiasPanel({ bias, snap }: { bias: Bias; snap: SnapshotMeta }) {
  const pct = ((bias.score + 1) / 2) * 100;
  const tone = bias.score > 0.15 ? 'up' : bias.score < -0.15 ? 'down' : 'muted';

  return (
    <div className="card">
      <h2>Market tilt</h2>
      <div className={`big ${tone}`}>{bias.label}</div>
      <div className="meter" style={{ marginTop: 8 }}>
        <i
          style={{
            left: `${Math.min(pct, 50)}%`,
            width: `${Math.abs(pct - 50)}%`,
            background: bias.score >= 0 ? 'var(--up)' : 'var(--down)',
          }}
        />
      </div>
      <div className="kv" style={{ marginTop: 10 }}>
        <span>score</span>
        <span className={tone}>{bias.score >= 0 ? '+' : ''}{bias.score.toFixed(3)}</span>
      </div>
      {bias.components.map((c) => (
        <div className="kv" key={c.name}>
          <span>{c.name} <span className="dim">({(c.weight * 100).toFixed(0)}%)</span></span>
          <span className="muted">{c.note}</span>
        </div>
      ))}
      <div className="note">
        Read off the current chain — put/call OI, 25-delta IV skew, volume tilt.
        This describes how the option market is positioned right now. Over a 12-hour
        horizon its predictive edge is small; it is one input, never the trade.
        {snap.expectedMove !== null && (
          <> The market is pricing a move of about ±${snap.expectedMove.toFixed(0)}
          {' '}({((snap.expectedMove / snap.spot) * 100).toFixed(2)}%) by expiry.</>
        )}
      </div>
    </div>
  );
}
