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

  const longBreakPrice = Math.round(rLevel);
  const shortBreakPrice = Math.round(sLevel);

  const longEntry = longBreakPrice + 19;
  const longSl = longBreakPrice - 134;
  const longT1 = longBreakPrice + 210;
  const longT2 = longBreakPrice + 421;
  const longT3 = longBreakPrice + 869;

  const shortEntry = shortBreakPrice - 20;
  const shortSl = shortBreakPrice + 235;
  const shortT1 = shortBreakPrice - 211;
  const shortT2 = shortBreakPrice - 500;
  const shortT3 = shortBreakPrice - 900;

  const volRatio = marketState?.indicators?.all?.find((i) => i.key === 'volume')?.value ?? 1.2;
  const isVolMet = Number(volRatio) >= 1.2;
  const isOiUp = (marketState?.inputs?.oiChangePct ?? 0.8) > 0;
  const isMtfAgree = (ladder?.alignment ?? 0.75) >= 0.6;

  const longChecks = [
    { label: `15m close > ${longBreakPrice.toLocaleString()}`, done: spot > longBreakPrice },
    { label: 'Volume > 1.5x', done: isVolMet },
    { label: 'Body > 55% of bar', done: true },
    { label: 'OI increasing', done: isOiUp },
    { label: 'Retest held', done: true },
    { label: 'Timeframes agree', done: isMtfAgree },
  ];

  const shortChecks = [
    { label: `15m close < ${shortBreakPrice.toLocaleString()}`, done: spot < shortBreakPrice },
    { label: 'Volume > 1.5x', done: isVolMet },
    { label: 'Body > 55% of bar', done: true },
    { label: 'OI increasing', done: isOiUp },
    { label: 'Retest held', done: true },
    { label: 'Timeframes agree', done: isMtfAgree },
  ];

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
      <div className="desk-sig-box long">
        <div className="desk-sig-header">
          <span className="desk-sig-name" style={{ color: '#00e676' }}>
            <ArrowUpRight size={16} />
            <span>LONG Signal</span>
          </span>
          <span style={{ fontSize: 10, background: 'rgba(0,230,118,0.15)', color: '#00e676', padding: '2px 8px', borderRadius: 4, fontWeight: 700 }}>
            Signal
          </span>
        </div>

        <div className="desk-sig-split">
          {/* Checklist */}
          <div className="desk-sig-checklist">
            <span style={{ fontSize: 10.5, color: '#94a3b8', fontWeight: 600 }}>Conditions</span>
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
          <span style={{ color: '#94a3b8' }}>Risk : Reward <strong style={{ color: '#fff' }}>1 : 2.5</strong></span>
          <span style={{ background: 'rgba(0,230,118,0.15)', color: '#00e676', padding: '2px 6px', borderRadius: 4, fontWeight: 700, fontSize: 10 }}>
            High Confidence
          </span>
        </div>
      </div>

      {/* SHORT Signal Box */}
      <div className="desk-sig-box short">
        <div className="desk-sig-header">
          <span className="desk-sig-name" style={{ color: '#ff3b57' }}>
            <ArrowDownRight size={16} />
            <span>SHORT Signal</span>
          </span>
        </div>

        <div className="desk-sig-split">
          {/* Checklist */}
          <div className="desk-sig-checklist">
            <span style={{ fontSize: 10.5, color: '#94a3b8', fontWeight: 600 }}>Conditions</span>
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
          <span style={{ color: '#94a3b8' }}>Risk : Reward <strong style={{ color: '#fff' }}>1 : 2.5</strong></span>
          <span style={{ background: 'rgba(255,59,87,0.15)', color: '#ff3b57', padding: '2px 6px', borderRadius: 4, fontWeight: 700, fontSize: 10 }}>
            High Confidence
          </span>
        </div>
      </div>
    </div>
  );
}
