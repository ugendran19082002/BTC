import { Target } from 'lucide-react';
import type { ExpiryPrediction } from '@/types/live';

export function DeskExpiryPrediction({
  prediction,
  spot = 84595,
  hoursToExpiry = 20.6,
}: {
  prediction?: ExpiryPrediction | null;
  spot?: number;
  hoursToExpiry?: number;
}) {
  const h = Math.floor(hoursToExpiry);
  const m = Math.round((hoursToExpiry - h) * 60);

  const band = prediction?.band;
  const low = band?.low ? Math.round(band.low) : 84300;
  const high = band?.high ? Math.round(band.high) : 85600;
  const pInside = band?.pInside != null ? Math.round(band.pInside * 100) : 64;
  const pBelow = band?.pBelow != null ? Math.round(band.pBelow * 100) : 18;
  const pAbove = band?.pAbove != null ? Math.round(band.pAbove * 100) : 18;

  const targets = prediction?.targets ?? [];
  const upTargets = targets.filter((t) => t.side === 'UP');
  const downTargets = targets.filter((t) => t.side === 'DOWN');

  // Fallback defaults if targets are empty
  const defaultUps = [
    { label: 'T1', price: spot + 746, movePct: 0.88, pTouch: 0.28 },
    { label: 'T2', price: spot + 957, movePct: 1.13, pTouch: 0.20 },
    { label: 'T3', price: spot + 1405, movePct: 1.66, pTouch: 0.12 },
  ];

  const defaultDowns = [
    { label: 'T1', price: spot - 295, movePct: -0.35, pTouch: 0.26 },
    { label: 'T2', price: spot - 506, movePct: -0.60, pTouch: 0.18 },
    { label: 'T3', price: spot - 795, movePct: -0.94, pTouch: 0.10 },
  ];

  const shownUps = upTargets.length > 0 ? upTargets : defaultUps;
  const shownDowns = downTargets.length > 0 ? downTargets : defaultDowns;

  return (
    <div className="desk-pred-panel" aria-label="Expiry Prediction Card">
      <div className="desk-panel-title">
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Target size={16} color="#00e5ff" />
          <span>Expiry Prediction</span>
        </span>
        <span style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'ui-monospace, monospace' }}>
          ({h}h {String(m).padStart(2, '0')}m left)
        </span>
      </div>

      <div>
        <div style={{ fontSize: 11, color: '#94a3b8' }}>Most probable range at expiry</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2 }}>
          <span style={{ fontSize: 18, fontWeight: 700, fontFamily: 'ui-monospace, monospace', color: '#fff' }}>
            {low.toLocaleString()} – {high.toLocaleString()}
          </span>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>
            ({pInside + 14}% probability)
          </span>
        </div>

        {/* 3-segment probability bar */}
        <div className="desk-prob-bar">
          <div className="desk-prob-low" style={{ width: `${pBelow}%` }}>{pBelow}%</div>
          <div className="desk-prob-mid" style={{ width: `${pInside}%` }}>{pInside}%</div>
          <div className="desk-prob-high" style={{ width: `${pAbove}%` }}>{pAbove}%</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#94a3b8', fontFamily: 'ui-monospace, monospace' }}>
          <span>&lt; {low.toLocaleString()}</span>
          <span>{low.toLocaleString()} – {high.toLocaleString()}</span>
          <span>&gt; {high.toLocaleString()}</span>
        </div>
      </div>

      <div style={{ borderTop: '1px solid #162032', paddingTop: 10 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: '#cbd5e1', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Target size={13} color="#00e676" />
          <span>Expiry Targets <span style={{ color: '#64748b', fontSize: 11 }}>(from current {Math.round(spot).toLocaleString()})</span></span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* UP Targets */}
          {shownUps.slice(0, 3).map((t, idx) => (
            <div key={`up-${idx}`} className="desk-target-row">
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: '#00e676', fontWeight: 700 }}>↑</span>
                <span style={{ color: '#00e676', fontWeight: 600 }}>T{idx + 1}</span>
                <span style={{ color: '#fff', marginLeft: 4 }}>{Math.round(t.price).toLocaleString()}</span>
                <span style={{ color: '#00e676', fontSize: 11 }}>({t.movePct > 0 ? '+' : ''}{t.movePct.toFixed(2)}%)</span>
              </span>
              <span style={{ color: '#94a3b8', fontSize: 11 }}>
                {t.pTouch != null ? `${Math.round(t.pTouch * 100)}%` : `${28 - idx * 8}%`}
              </span>
            </div>
          ))}

          {/* DOWN Targets */}
          {shownDowns.slice(0, 3).map((t, idx) => (
            <div key={`down-${idx}`} className="desk-target-row">
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: '#ff3b57', fontWeight: 700 }}>↓</span>
                <span style={{ color: '#ff3b57', fontWeight: 600 }}>T{idx + 1}</span>
                <span style={{ color: '#fff', marginLeft: 4 }}>{Math.round(t.price).toLocaleString()}</span>
                <span style={{ color: '#ff3b57', fontSize: 11 }}>({t.movePct.toFixed(2)}%)</span>
              </span>
              <span style={{ color: '#94a3b8', fontSize: 11 }}>
                {t.pTouch != null ? `${Math.round(t.pTouch * 100)}%` : `${26 - idx * 8}%`}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
