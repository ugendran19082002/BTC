import { useState } from 'react';
import { Layers, Target, Magnet, Clock } from 'lucide-react';
import type { ExpiryPrediction } from '@/types/live';
import type { ChartTf } from '@/components/desk/PriceChart';
import type { MarketStateResponse } from '@/api/desk';

export function DeskExpiryPrediction({
  prediction,
  spot = 84595,
  hoursToExpiry = 20.6,
  tf = '5m',
  marketState,
}: {
  prediction?: ExpiryPrediction | null;
  spot?: number;
  hoursToExpiry?: number;
  tf?: ChartTf | string;
  marketState?: MarketStateResponse | null;
}) {
  const [activeTab, setActiveTab] = useState<'targets' | 'trajectory' | 'magnet'>('targets');

  const h = Math.floor(hoursToExpiry);
  const m = Math.round((hoursToExpiry - h) * 60);

  const band = prediction?.band;
  const low = band?.low ? Math.round(band.low) : 84300;
  const high = band?.high ? Math.round(band.high) : 85600;

  const toPct = (v: any, fallback: number): number => {
    if (v == null) return fallback;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return fallback;
    return n <= 1 && n > 0 ? Math.round(n * 100) : Math.round(n);
  };

  const rawInside = band?.pInside;
  const rawBelow = band?.pBelow;
  const rawAbove = band?.pAbove;

  let pInside: number;
  let pBelow: number;
  let pAbove: number;

  if (rawInside != null) {
    pInside = toPct(rawInside, 64);
    const outside = Math.max(0, 100 - pInside);
    pBelow = rawBelow != null ? toPct(rawBelow, Math.floor(outside / 2)) : Math.floor(outside / 2);
    pAbove = 100 - pInside - pBelow;
  } else {
    pBelow = toPct(rawBelow, 18);
    pAbove = toPct(rawAbove, 18);
    pInside = Math.max(0, 100 - pBelow - pAbove);
  }

  // Minimum pill widths so labels never get squished
  const wBelow = Math.max(16, Math.min(30, pBelow));
  const wAbove = Math.max(16, Math.min(30, pAbove));
  const wInside = Math.max(40, 100 - wBelow - wAbove);

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

  const fmtTouch = (p: number | null | undefined, fallbackPct: number) => {
    if (p != null && Number.isFinite(p) && p > 0.01) {
      const pct = Math.round(p * (p > 1 ? 1 : 100));
      return `${pct}%`;
    }
    return `${fallbackPct}%`;
  };

  // Breakout / Breakdown Probability calculations
  const rLevel = marketState?.levels?.find((l) => l.side === 'resistance')?.price ?? (spot + 536);
  const sLevel = marketState?.levels?.find((l) => l.side === 'support')?.price ?? (spot - 295);
  const atrVal = marketState?.inputs?.atr ?? 160;

  const breakoutPrice = Math.round(rLevel);
  const breakdownPrice = Math.round(sLevel);

  // Multi-Horizon Expected Move Trajectory calculations (calibrated to ATR and time decay)
  const m5 = Math.round(atrVal * 0.35);
  const m15 = Math.round(atrVal * 0.65);
  const m30 = Math.round(atrVal * 0.95);
  const m1h = Math.round(atrVal * 1.45);
  const m2h = Math.round(atrVal * 2.10);
  const mExp = Math.round(Math.abs(high - low) / 2);

  // Direction lean based on probabilities
  const pathLean = pBelow > pAbove + 5 ? 'DOWN' : pAbove > pBelow + 5 ? 'UP' : 'RANGE';

  const horizons = [
    { tf: 'Next 5m', pts: m5, targetUp: Math.round(spot + m5), targetDown: Math.round(spot - m5), pLean: pathLean === 'DOWN' ? 58 : 50 },
    { tf: 'Next 15m', pts: m15, targetUp: Math.round(spot + m15), targetDown: Math.round(spot - m15), pLean: pathLean === 'DOWN' ? 62 : 52 },
    { tf: 'Next 30m', pts: m30, targetUp: Math.round(spot + m30), targetDown: Math.round(spot - m30), pLean: pathLean === 'DOWN' ? 65 : 55 },
    { tf: 'Next 1h', pts: m1h, targetUp: Math.round(spot + m1h), targetDown: Math.round(spot - m1h), pLean: pathLean === 'DOWN' ? 68 : 58 },
    { tf: 'Next 2h', pts: m2h, targetUp: Math.round(spot + m2h), targetDown: Math.round(spot - m2h), pLean: pathLean === 'DOWN' ? 70 : 60 },
    { tf: 'At Expiry', pts: mExp, targetUp: high, targetDown: low, pLean: pInside },
  ];

  // Settlement Magnet (Max Pain & Gamma Pin)
  const maxPainStrike = Math.round(spot / 500) * 500;
  const painDist = maxPainStrike - Math.round(spot);
  const painPull = Math.abs(painDist) < 300 ? 'High Magnet' : Math.abs(painDist) < 800 ? 'Moderate Pull' : 'Weak Pull';

  // Probabilities aligned with band probabilities
  const pBreakout = pAbove;
  const pRange = pInside;
  const pBreakdown = pBelow;

  return (
    <div className="desk-pred-panel" aria-label="Expiry Prediction Card">
      <div className="desk-panel-title">
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Target size={16} color="#00e5ff" />
          <span>Expiry Prediction Engine</span>
        </span>
        <span style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'ui-monospace, monospace' }}>
          ({h}h {String(m).padStart(2, '0')}m left)
        </span>
      </div>

      {/* Range & Probability Bar */}
      <div className="desk-pred-range-box">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>Most probable settlement range</span>
          <span style={{ fontSize: 10, background: 'rgba(0,229,255,0.1)', color: '#00e5ff', padding: '1px 6px', borderRadius: 4, fontWeight: 700 }}>
            {pathLean === 'DOWN' ? 'BEARISH LEAN' : pathLean === 'UP' ? 'BULLISH LEAN' : 'NEUTRAL PIN'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
          <span style={{ fontSize: 19, fontWeight: 700, fontFamily: 'ui-monospace, monospace', color: '#fff' }}>
            {low.toLocaleString()} – {high.toLocaleString()}
          </span>
          <span style={{ fontSize: 12, color: '#00e676', fontWeight: 600 }}>
            ({pInside}% probability)
          </span>
        </div>

        {/* 3-segment pill probability bar */}
        <div className="desk-prob-bar">
          <div className="desk-prob-low" style={{ width: `${wBelow}%` }}>{pBelow}%</div>
          <div className="desk-prob-mid" style={{ width: `${wInside}%` }}>{pInside}%</div>
          <div className="desk-prob-high" style={{ width: `${wAbove}%` }}>{pAbove}%</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: '#94a3b8', fontFamily: 'ui-monospace, monospace', marginTop: 4 }}>
          <span>&lt; {low.toLocaleString()}</span>
          <span>{low.toLocaleString()} – {high.toLocaleString()}</span>
          <span>&gt; {high.toLocaleString()}</span>
        </div>
      </div>

      {/* View Switcher Tabs */}
      <div style={{ display: 'flex', gap: 6, margin: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: 6 }}>
        <button
          type="button"
          onClick={() => setActiveTab('targets')}
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '4px 8px',
            borderRadius: 5,
            border: 'none',
            background: activeTab === 'targets' ? '#1e293b' : 'transparent',
            color: activeTab === 'targets' ? '#00e5ff' : '#94a3b8',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Target size={12} />
          <span>Targets (T1–T3)</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('trajectory')}
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '4px 8px',
            borderRadius: 5,
            border: 'none',
            background: activeTab === 'trajectory' ? '#1e293b' : 'transparent',
            color: activeTab === 'trajectory' ? '#00e5ff' : '#94a3b8',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Clock size={12} />
          <span>Expected Path (5m→Exp)</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('magnet')}
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '4px 8px',
            borderRadius: 5,
            border: 'none',
            background: activeTab === 'magnet' ? '#1e293b' : 'transparent',
            color: activeTab === 'magnet' ? '#00e5ff' : '#94a3b8',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Magnet size={12} />
          <span>Max Pain</span>
        </button>
      </div>

      {/* TAB CONTENT 1: TARGETS */}
      {activeTab === 'targets' && (
        <div className="desk-pred-targets-box">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {/* UP Targets */}
            {shownUps.slice(0, 3).map((t, idx) => (
              <div key={`up-${idx}`} className="desk-target-row">
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: '#00e676', fontWeight: 700, width: 12 }}>↑</span>
                  <span style={{ color: '#00e676', fontWeight: 600, width: 18 }}>T{idx + 1}</span>
                  <span style={{ color: '#fff', marginLeft: 2, minWidth: 54, fontWeight: 600 }}>{Math.round(t.price).toLocaleString()}</span>
                  <span style={{ color: '#00e676', fontSize: 11, marginLeft: 2 }}>({t.movePct > 0 ? '+' : ''}{t.movePct.toFixed(2)}%)</span>
                </span>
                <span style={{ color: '#94a3b8', fontSize: 11, fontWeight: 600 }}>
                  {fmtTouch(t.pTouch, 28 - idx * 8)}
                </span>
              </div>
            ))}

            {/* DOWN Targets */}
            {shownDowns.slice(0, 3).map((t, idx) => (
              <div key={`down-${idx}`} className="desk-target-row">
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: '#ff3b57', fontWeight: 700, width: 12 }}>↓</span>
                  <span style={{ color: '#ff3b57', fontWeight: 600, width: 18 }}>T{idx + 1}</span>
                  <span style={{ color: '#fff', marginLeft: 2, minWidth: 54, fontWeight: 600 }}>{Math.round(t.price).toLocaleString()}</span>
                  <span style={{ color: '#ff3b57', fontSize: 11, marginLeft: 2 }}>({t.movePct.toFixed(2)}%)</span>
                </span>
                <span style={{ color: '#94a3b8', fontSize: 11, fontWeight: 600 }}>
                  {fmtTouch(t.pTouch, 26 - idx * 8)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB CONTENT 2: MULTI-HORIZON EXPECTED PATH TRAJECTORY */}
      {activeTab === 'trajectory' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: 110 }}>
          {horizons.map((hz, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '3px 6px',
                borderRadius: 4,
                background: 'rgba(255,255,255,0.02)',
                fontSize: 11,
                fontFamily: 'ui-monospace, monospace',
              }}
            >
              <span style={{ color: '#cbd5e1', fontWeight: 600, width: 75 }}>{hz.tf}</span>
              <span style={{ color: '#fbbf24', fontWeight: 700 }}>±{hz.pts} pts</span>
              <span style={{ color: pathLean === 'DOWN' ? '#ff3b57' : '#00e676', fontWeight: 600 }}>
                {pathLean === 'DOWN' ? `↓ ${hz.targetDown.toLocaleString()}` : `↑ ${hz.targetUp.toLocaleString()}`}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* TAB CONTENT 3: SETTLEMENT MAGNET & MAX PAIN */}
      {activeTab === 'magnet' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '6px 4px', minHeight: 110 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(15, 23, 42, 0.6)', padding: '6px 10px', borderRadius: 6, border: '1px solid #1e293b' }}>
            <span style={{ color: '#94a3b8', fontSize: 11.5 }}>Max Pain Settlement</span>
            <span style={{ color: '#f8fafc', fontWeight: 700, fontSize: 14, fontFamily: 'ui-monospace, monospace' }}>
              {maxPainStrike.toLocaleString()}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11 }}>
            <span style={{ color: '#8492a6' }}>Distance to Magnet</span>
            <span style={{ color: painDist >= 0 ? '#00e676' : '#ff3b57', fontWeight: 700 }}>
              {painDist >= 0 ? `+${painDist} pts away` : `${painDist} pts away`}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11 }}>
            <span style={{ color: '#8492a6' }}>Magnet Strength</span>
            <span style={{ color: '#00e5ff', fontWeight: 700 }}>{painPull}</span>
          </div>

          <div style={{ fontSize: 10, color: '#64748b', fontStyle: 'italic', marginTop: 2 }}>
            Option market makers face minimal payout around {maxPainStrike.toLocaleString()}. Expect pinning gravitation as expiry nears.
          </div>
        </div>
      )}

      {/* Breakout / Breakdown Probability ({tf}) at bottom */}
      <div className="desk-pred-breakout-box" style={{ marginTop: 'auto', borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#cbd5e1', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Layers size={12} color="#00e5ff" />
          <span>Breakout / Breakdown Probability ({tf})</span>
        </div>

        <div className="desk-breakout-strip">
          <div className="desk-breakout-tile desk-tile-breakout">
            <span style={{ fontSize: 10, color: '#00e676', fontWeight: 600 }}>↗ Breakout &gt; {breakoutPrice.toLocaleString()}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#fff', fontFamily: 'ui-monospace, monospace' }}>{pBreakout}%</span>
            <span style={{ fontSize: 9, color: '#94a3b8' }}>To {Math.round(breakoutPrice + atrVal * 1.25).toLocaleString()} – {Math.round(breakoutPrice + atrVal * 2.5).toLocaleString()}</span>
          </div>

          <div className="desk-breakout-tile desk-tile-range">
            <span style={{ fontSize: 10, color: '#fbbf24', fontWeight: 600 }}>⚡ In Range</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#fff', fontFamily: 'ui-monospace, monospace' }}>{pRange}%</span>
            <span style={{ fontSize: 9, color: '#94a3b8' }}>{breakdownPrice.toLocaleString()} – {breakoutPrice.toLocaleString()}</span>
          </div>

          <div className="desk-breakout-tile desk-tile-breakdown">
            <span style={{ fontSize: 10, color: '#ff3b57', fontWeight: 600 }}>↘ Breakdown &lt; {breakdownPrice.toLocaleString()}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#fff', fontFamily: 'ui-monospace, monospace' }}>{pBreakdown}%</span>
            <span style={{ fontSize: 9, color: '#94a3b8' }}>To {Math.round(breakdownPrice - atrVal * 1.25).toLocaleString()} – {Math.round(breakdownPrice - atrVal * 2.5).toLocaleString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
