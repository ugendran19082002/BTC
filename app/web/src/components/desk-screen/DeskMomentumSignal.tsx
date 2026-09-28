import { ArrowDownRight, ArrowUpRight, Check, Zap } from 'lucide-react';
import type { MomentumSignal, Ladder } from '@/types/live';
import type { MarketStateResponse } from '@/api/desk';

export function DeskMomentumSignal({
  spot = 84595,
  momentum,
  marketState,
  ladder,
}: {
  spot?: number;
  momentum?: MomentumSignal | null;
  marketState?: MarketStateResponse | null;
  ladder?: Ladder | null;
}) {
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

  // Real signal condition validations
  const volRatio = marketState?.state?.volumeRatio
    ?? (marketState?.indicators?.all?.find((i) => i.key === 'volume')?.value as number | undefined)
    ?? 1.2;
  const isVolMet = Number(volRatio) >= 1.5;
  const isBodyMet = (marketState?.state?.parts?.candle ?? 0.6) >= 0.55;
  const isOiUp = (marketState?.inputs?.oiChangePct ?? 0) > 0;
  const isRetestHeld = marketState?.state?.stage === 'RETEST';
  const isMtfAgree = ladder?.alignment !== undefined
    ? ladder.alignment >= 0.6
    : (marketState?.state?.parts?.mtf ?? 0.5) >= 0.5;

  const isLongTriggered = spot > longBreakPrice;
  const isShortTriggered = spot < shortBreakPrice;

  const longChecks = [
    { label: `${tf} close > ${longBreakPrice.toLocaleString()}`, done: isLongTriggered },
    { label: 'Volume > 1.5x', done: isVolMet },
    { label: 'Body > 55% of bar', done: isBodyMet },
    { label: 'OI increasing', done: isOiUp },
    { label: 'Retest held', done: isRetestHeld },
    { label: 'Timeframes agree', done: isMtfAgree },
  ];

  const shortChecks = [
    { label: `${tf} close < ${shortBreakPrice.toLocaleString()}`, done: isShortTriggered },
    { label: 'Volume > 1.5x', done: isVolMet },
    { label: 'Body > 55% of bar', done: isBodyMet },
    { label: 'OI increasing', done: isOiUp },
    { label: 'Retest held', done: isRetestHeld },
    { label: 'Timeframes agree', done: isMtfAgree },
  ];

  const longDoneCount = longChecks.filter((c) => c.done).length;
  const shortDoneCount = shortChecks.filter((c) => c.done).length;

  const longConfidence = longDoneCount >= 5 ? 'High Confidence' : longDoneCount >= 3 ? 'Moderate Confidence' : 'Setup Forming';
  const shortConfidence = shortDoneCount >= 5 ? 'High Confidence' : shortDoneCount >= 3 ? 'Moderate Confidence' : 'Setup Forming';

  const isLongActive = marketState?.state?.side === 'UP' && (marketState?.state?.confirmed || isLongTriggered);
  const isShortActive = marketState?.state?.side === 'DOWN' && (marketState?.state?.confirmed || isShortTriggered);

  return (
    <div className="desk-momentum-panel" aria-label="Big Momentum Signal Card">
      <div className="desk-panel-title">
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Zap size={16} color="#fbbf24" />
          <span>Big Momentum Signal</span>
        </span>
        <span className="desk-live-badge" style={{ padding: '2px 8px', fontSize: 10 }}>
          <span className="desk-live-dot" />
          <span>LIVE</span>
        </span>
      </div>

      {/* LONG Signal Box */}
      <div className={`desk-sig-box long ${isLongActive ? 'is-active-sig' : ''}`}>
        <div className="desk-sig-header">
          <span className="desk-sig-name" style={{ color: '#00e676' }}>
            <ArrowUpRight size={16} />
            <span>LONG Signal</span>
          </span>
          <span style={{
            fontSize: 10,
            background: isLongActive ? 'rgba(0,230,118,0.25)' : 'rgba(0,230,118,0.15)',
            color: '#00e676',
            padding: '2px 8px',
            borderRadius: 4,
            fontWeight: 700,
            letterSpacing: '0.04em',
          }}>
            {isLongActive ? 'ACTIVE SIGNAL' : 'WATCHING'}
          </span>
        </div>

        <div className="desk-sig-split">
          {/* Checklist */}
          <div className="desk-sig-checklist">
            <span style={{ fontSize: 10.5, color: '#94a3b8', fontWeight: 600 }}>
              Conditions ({longDoneCount}/6)
            </span>
            {longChecks.map((c, i) => (
              <div key={i} className={`desk-check-item ${c.done ? 'done' : ''}`}>
                <Check size={11} className="desk-check-icon" />
                <span>{c.label}</span>
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
              <strong style={{ color: '#ff3b57' }}>{longSl.toLocaleString()}</strong>
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
          <span style={{ color: '#94a3b8' }}>Risk : Reward <strong style={{ color: '#fff' }}>1 : {longRr}</strong></span>
          <span style={{
            background: longDoneCount >= 5 ? 'rgba(0,230,118,0.15)' : longDoneCount >= 3 ? 'rgba(251,191,36,0.15)' : 'rgba(148,163,184,0.12)',
            color: longDoneCount >= 5 ? '#00e676' : longDoneCount >= 3 ? '#fbbf24' : '#94a3b8',
            padding: '2px 6px',
            borderRadius: 4,
            fontWeight: 700,
            fontSize: 10,
          }}>
            {longConfidence}
          </span>
        </div>
      </div>

      {/* SHORT Signal Box */}
      <div className={`desk-sig-box short ${isShortActive ? 'is-active-sig' : ''}`}>
        <div className="desk-sig-header">
          <span className="desk-sig-name" style={{ color: '#ff3b57' }}>
            <ArrowDownRight size={16} />
            <span>SHORT Signal</span>
          </span>
          <span style={{
            fontSize: 10,
            background: isShortActive ? 'rgba(255,59,87,0.25)' : 'rgba(255,59,87,0.15)',
            color: '#ff3b57',
            padding: '2px 8px',
            borderRadius: 4,
            fontWeight: 700,
            letterSpacing: '0.04em',
          }}>
            {isShortActive ? 'ACTIVE SIGNAL' : 'WATCHING'}
          </span>
        </div>

        <div className="desk-sig-split">
          {/* Checklist */}
          <div className="desk-sig-checklist">
            <span style={{ fontSize: 10.5, color: '#94a3b8', fontWeight: 600 }}>
              Conditions ({shortDoneCount}/6)
            </span>
            {shortChecks.map((c, i) => (
              <div key={i} className={`desk-check-item ${c.done ? 'done' : ''}`}>
                <Check size={11} className="desk-check-icon" />
                <span>{c.label}</span>
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
              <strong style={{ color: '#ff3b57' }}>{shortSl.toLocaleString()}</strong>
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
          <span style={{ color: '#94a3b8' }}>Risk : Reward <strong style={{ color: '#fff' }}>1 : {shortRr}</strong></span>
          <span style={{
            background: shortDoneCount >= 5 ? 'rgba(0,230,118,0.15)' : shortDoneCount >= 3 ? 'rgba(251,191,36,0.15)' : 'rgba(148,163,184,0.12)',
            color: shortDoneCount >= 5 ? '#00e676' : shortDoneCount >= 3 ? '#fbbf24' : '#94a3b8',
            padding: '2px 6px',
            borderRadius: 4,
            fontWeight: 700,
            fontSize: 10,
          }}>
            {shortConfidence}
          </span>
        </div>
      </div>
    </div>
  );
}
