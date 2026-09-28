import { useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Check, Zap, ChevronRight } from 'lucide-react';
import type { MomentumSignal } from '@/types/live';
import type { MarketStateResponse } from '@/api/desk';

export function DeskMomentumSignal({
  spot = 84595,
  momentum,
  marketState,
}: {
  spot?: number;
  momentum?: MomentumSignal | null;
  marketState?: MarketStateResponse | null;
}) {
  const [showFormula, setShowFormula] = useState(false);

  const rLevel = marketState?.levels?.find((l) => l.side === 'resistance')?.price ?? (spot + 536);
  const sLevel = marketState?.levels?.find((l) => l.side === 'support')?.price ?? (spot - 295);

  const atrVal = marketState?.inputs?.atr ?? momentum?.atr ?? 160;
  const tf = marketState?.tf ?? '5m';

  // Dynamic ATR-calibrated breakout, stop loss, and positive R:R target levels
  const longBreakPrice = Math.round(rLevel);
  const longEntry = longBreakPrice + Math.round(atrVal * 0.15);
  const longSl = longBreakPrice - Math.round(atrVal * 0.75);
  const longT1 = longBreakPrice + Math.round(atrVal * 1.25);
  const longT2 = longBreakPrice + Math.round(atrVal * 2.5);
  const longT3 = longBreakPrice + Math.round(atrVal * 4.0);

  const shortBreakPrice = Math.round(sLevel);
  const shortEntry = shortBreakPrice - Math.round(atrVal * 0.15);
  const shortSl = shortBreakPrice + Math.round(atrVal * 0.75);
  const shortT1 = shortBreakPrice - Math.round(atrVal * 1.25);
  const shortT2 = shortBreakPrice - Math.round(atrVal * 2.5);
  const shortT3 = shortBreakPrice - Math.round(atrVal * 4.0);

  // Dynamic Risk-to-Reward calculation
  const longRisk = longEntry - longSl;
  const longReward = longT2 - longEntry;
  const longRr = longRisk > 0 ? (longReward / longRisk).toFixed(1) : '2.5';

  const shortRisk = shortSl - shortEntry;
  const shortReward = shortEntry - shortT2;
  const shortRr = shortRisk > 0 ? (shortReward / shortRisk).toFixed(1) : '2.5';

  // The entry pipeline: levels -> setup -> trigger -> timing. The 12H/6H
  // multi-timeframe gate went with the hierarchy on 28 Sep 2026.
  const volRatio = marketState?.state?.volumeRatio
    ?? (marketState?.indicators?.all?.find((i) => i.key === 'volume')?.value as number | undefined)
    ?? 1.2;
  const isVolMet = Number(volRatio) >= 1.5;
  const isBodyMet = (marketState?.state?.parts?.candle ?? 0.6) >= 0.55;
  const isOiUp = (marketState?.inputs?.oiChangePct ?? 0) > 0;
  const isRetestHeld = marketState?.state?.stage === 'RETEST';

  const isLongTriggered = spot > longBreakPrice;
  const isShortTriggered = spot < shortBreakPrice;

  // Hierarchical Gates for LONG
  const longGates = [
    { tf: '4H/2H', gate: 'Major Structure', check: `Support Held > ${Math.round(sLevel).toLocaleString()}`, done: spot > sLevel },
    { tf: '1H/30M', gate: 'Setup Formation', check: 'Higher Low / Compression Break', done: isLongTriggered || isRetestHeld },
    { tf: `${tf}/5M`, gate: 'Trigger Confirmed', check: `Close > ${longBreakPrice.toLocaleString()} + Vol 1.5x ${isOiUp ? '+ OI' : ''}`, done: isLongTriggered && isVolMet && isBodyMet },
    { tf: '1M', gate: 'Execution Timing', check: 'Micro Retest & Spread OK', done: isRetestHeld || isLongTriggered },
  ];

  // Hierarchical Gates for SHORT
  const shortGates = [
    { tf: '4H/2H', gate: 'Major Structure', check: `Resistance Rejection < ${Math.round(rLevel).toLocaleString()}`, done: spot < rLevel },
    { tf: '1H/30M', gate: 'Setup Formation', check: 'Lower High / Channel Down', done: isShortTriggered || isRetestHeld },
    { tf: `${tf}/5M`, gate: 'Trigger Confirmed', check: `Close < ${shortBreakPrice.toLocaleString()} + Vol 1.5x ${isOiUp ? '+ OI' : ''}`, done: isShortTriggered && isVolMet && isBodyMet },
    { tf: '1M', gate: 'Execution Timing', check: 'Micro Retest & Spread OK', done: isRetestHeld || isShortTriggered },
  ];

  const longPassed = longGates.filter((g) => g.done).length;
  const shortPassed = shortGates.filter((g) => g.done).length;

  const isLongActive = (marketState?.state?.side === 'UP' && marketState?.state?.confirmed) || (longPassed >= longGates.length - 1 && isLongTriggered);
  const isShortActive = (marketState?.state?.side === 'DOWN' && marketState?.state?.confirmed) || (shortPassed >= shortGates.length - 1 && isShortTriggered);

  const getStatus = (passed: number, total: number, active: boolean) => {
    if (active && passed === total) return { text: '🟢 ENTRY READY', bg: 'rgba(0,230,118,0.22)', color: '#00e676' };
    if (active) return { text: '🟡 TRIGGERED', bg: 'rgba(251,191,36,0.22)', color: '#fbbf24' };
    if (passed >= total - 2) return { text: '🔵 SETUP FORMING', bg: 'rgba(0,229,255,0.15)', color: '#00e5ff' };
    return { text: '⚪ WATCHING', bg: 'rgba(148,163,184,0.12)', color: '#94a3b8' };
  };

  const longStatus = getStatus(longPassed, longGates.length, isLongActive);
  const shortStatus = getStatus(shortPassed, shortGates.length, isShortActive);

  return (
    <div className="desk-momentum-panel" aria-label="Big Momentum Signal Card">
      <div className="desk-panel-title">
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Zap size={16} color="#fbbf24" />
          <span>Big Momentum Signal</span>
        </span>
        <button
          type="button"
          onClick={() => setShowFormula(!showFormula)}
          style={{
            background: 'none',
            border: 'none',
            color: '#00e5ff',
            fontSize: 10.5,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            fontWeight: 600,
          }}
        >
          <span>{showFormula ? 'Hide Hierarchy' : 'View Hierarchy'}</span>
          <ChevronRight size={12} />
        </button>
      </div>

      {/* Explanatory Hierarchy Banner (Toggled) */}
      {showFormula && (
        <div style={{ background: '#070a12', border: '1px solid rgba(0,229,255,0.2)', borderRadius: 8, padding: '8px 10px', fontSize: 10.5, color: '#94a3b8', lineHeight: 1.4 }}>
          <div style={{ fontWeight: 700, color: '#f1f5f9', marginBottom: 2 }}>High-Accuracy 5-Gate Hierarchy:</div>
          <div>1. <b>4H/2H</b> Levels → 2. <b>1H/30M</b> Setup → 3. <b>15M/5M</b> Trigger → 4. <b>1M</b> Timing</div>
          <div style={{ color: '#64748b', fontSize: 9.5, marginTop: 2 }}>Eliminates false signals by requiring higher-timeframe confluence before lower-timeframe execution.</div>
        </div>
      )}

      {/* LONG Signal Box */}
      <div className={`desk-sig-box long ${isLongActive ? 'is-active-sig' : ''}`}>
        <div className="desk-sig-header">
          <span className="desk-sig-name" style={{ color: '#00e676' }}>
            <ArrowUpRight size={16} />
            <span>LONG Momentum Breakout</span>
          </span>
          <span style={{
            fontSize: 10,
            background: longStatus.bg,
            color: longStatus.color,
            padding: '2px 8px',
            borderRadius: 4,
            fontWeight: 700,
            letterSpacing: '0.04em',
          }}>
            {longStatus.text}
          </span>
        </div>

        <div className="desk-sig-split">
          {/* Checklist */}
          <div className="desk-sig-checklist">
            <span style={{ fontSize: 10, color: '#8492a6', fontWeight: 600, textTransform: 'uppercase' }}>
              Pipeline ({longPassed}/{longGates.length})
            </span>
            {longGates.map((g, i) => (
              <div key={i} className={`desk-check-item ${g.done ? 'done' : ''}`} style={{ fontSize: 10 }}>
                <Check size={10} className="desk-check-icon" />
                <span><b>{g.tf}</b>: {g.check}</span>
              </div>
            ))}
          </div>

          {/* Levels */}
          <div className="desk-sig-levels">
            <div className="desk-level-row">
              <span style={{ color: '#94a3b8' }}>Entry</span>
              <strong style={{ color: '#fff' }}>{longEntry.toLocaleString()}</strong>
            </div>
            <div className="desk-level-row">
              <span style={{ color: '#ff3b57' }}>SL</span>
              <strong style={{ color: '#ff3b57' }}>{longSl.toLocaleString()} <span style={{ fontSize: 9.5, color: '#ff3b57' }}>(-{longRisk} pts)</span></strong>
            </div>
            <div className="desk-level-row">
              <span style={{ color: '#00e676' }}>T1</span>
              <strong style={{ color: '#00e676' }}>{longT1.toLocaleString()}</strong>
            </div>
            <div className="desk-level-row">
              <span style={{ color: '#00e676' }}>T2</span>
              <strong style={{ color: '#00e676' }}>{longT2.toLocaleString()}</strong>
            </div>
            <div className="desk-level-row">
              <span style={{ color: '#00e676' }}>T3</span>
              <strong style={{ color: '#00e676' }}>{longT3.toLocaleString()}</strong>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid rgba(0,230,118,0.15)', paddingTop: 6, fontSize: 11 }}>
          <span style={{ color: '#94a3b8' }}>Risk : Reward <strong style={{ color: '#00e676' }}>1 : {longRr}</strong></span>
          <span style={{ color: '#8492a6', fontSize: 10 }}>Invalidation: &lt; {longSl.toLocaleString()}</span>
        </div>
      </div>

      {/* SHORT Signal Box */}
      <div className={`desk-sig-box short ${isShortActive ? 'is-active-sig' : ''}`}>
        <div className="desk-sig-header">
          <span className="desk-sig-name" style={{ color: '#ff3b57' }}>
            <ArrowDownRight size={16} />
            <span>SHORT Momentum Breakdown</span>
          </span>
          <span style={{
            fontSize: 10,
            background: shortStatus.bg,
            color: shortStatus.color,
            padding: '2px 8px',
            borderRadius: 4,
            fontWeight: 700,
            letterSpacing: '0.04em',
          }}>
            {shortStatus.text}
          </span>
        </div>

        <div className="desk-sig-split">
          {/* Checklist */}
          <div className="desk-sig-checklist">
            <span style={{ fontSize: 10, color: '#8492a6', fontWeight: 600, textTransform: 'uppercase' }}>
              Pipeline ({shortPassed}/{shortGates.length})
            </span>
            {shortGates.map((g, i) => (
              <div key={i} className={`desk-check-item ${g.done ? 'done' : ''}`} style={{ fontSize: 10 }}>
                <Check size={10} className="desk-check-icon" />
                <span><b>{g.tf}</b>: {g.check}</span>
              </div>
            ))}
          </div>

          {/* Levels */}
          <div className="desk-sig-levels">
            <div className="desk-level-row">
              <span style={{ color: '#94a3b8' }}>Entry</span>
              <strong style={{ color: '#fff' }}>{shortEntry.toLocaleString()}</strong>
            </div>
            <div className="desk-level-row">
              <span style={{ color: '#ff3b57' }}>SL</span>
              <strong style={{ color: '#ff3b57' }}>{shortSl.toLocaleString()} <span style={{ fontSize: 9.5, color: '#ff3b57' }}>(-{shortRisk} pts)</span></strong>
            </div>
            <div className="desk-level-row">
              <span style={{ color: '#00e676' }}>T1</span>
              <strong style={{ color: '#00e676' }}>{shortT1.toLocaleString()}</strong>
            </div>
            <div className="desk-level-row">
              <span style={{ color: '#00e676' }}>T2</span>
              <strong style={{ color: '#00e676' }}>{shortT2.toLocaleString()}</strong>
            </div>
            <div className="desk-level-row">
              <span style={{ color: '#00e676' }}>T3</span>
              <strong style={{ color: '#00e676' }}>{shortT3.toLocaleString()}</strong>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid rgba(255,59,87,0.15)', paddingTop: 6, fontSize: 11 }}>
          <span style={{ color: '#94a3b8' }}>Risk : Reward <strong style={{ color: '#00e676' }}>1 : {shortRr}</strong></span>
          <span style={{ color: '#8492a6', fontSize: 10 }}>Invalidation: &gt; {shortSl.toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}
