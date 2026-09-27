import { Activity, Compass, Layers, Lightbulb } from 'lucide-react';
import type { Candle } from '@/types/desk';
import type { Ladder } from '@/types/live';
import type { MarketStateResponse } from '@/api/desk';
import { calculateIndicators } from './indicators-calc';

export function DeskBottomGrid({
  bars,
  spot = 84595,
  tf = '15m',
  marketState,
  ladder,
  optionBias,
}: {
  bars: readonly Candle[];
  spot?: number;
  tf?: string;
  marketState?: MarketStateResponse | null;
  ladder?: Ladder | null;
  optionBias?: any;
}) {
  const calc = calculateIndicators(bars, spot);

  // Key Levels
  const levels = marketState?.levels ?? [];
  const r1 = levels.find((l) => l.label === 'R1')?.price ?? (spot + 227);
  const r2 = levels.find((l) => l.label === 'R2')?.price ?? (spot + 260);
  const s1 = levels.find((l) => l.label === 'S1')?.price ?? (spot - 157);
  const s2 = levels.find((l) => l.label === 'S2')?.price ?? (spot - 245);

  const insightText = marketState?.state?.insight
    ?? `If 85,131 breaks and a 15m candle closes above it with volume, next move towards 85,341 – 85,552. If rejected, watch 84,300 for the short.`;

  // Timeframe alignment rows
  const ladderRows = ladder?.rows ?? [
    { tf: '12h', way: 'UP', conviction: 0.75 },
    { tf: '6h', way: 'UP', conviction: 1.0 },
    { tf: '4h', way: 'UP', conviction: 0.75 },
    { tf: '2h', way: 'SIDE', conviction: 0.5 },
    { tf: '1h', way: 'SIDE', conviction: 0.5 },
    { tf: '30m', way: 'UP', conviction: 0.75 },
    { tf: '15m', way: 'DOWN', conviction: 0.33 },
    { tf: '5m', way: 'DOWN', conviction: 0.33 },
  ];

  const patterns = [
    { name: 'Bearish FVG Test (84,551–84,626)', barsAgo: '2b', side: 'Bearish', icon: '⚠️' },
    { name: 'Lower Highs', barsAgo: '', side: 'Bearish', icon: '📉' },
    { name: 'Channel Down', barsAgo: '', side: 'Bearish', icon: '📉' },
    { name: 'Lower Low', barsAgo: '1b', side: 'Bearish', icon: '📉' },
    { name: 'Lower High', barsAgo: '5b', side: 'Bearish', icon: '📉' },
    { name: 'Head & Shoulders', barsAgo: '5b', side: 'Bearish', icon: '📉' },
    { name: 'Bullish Engulfing', barsAgo: '', side: 'Bullish', icon: '📈' },
  ];

  return (
    <div className="desk-bottom-grid" aria-label="Market In-Depth Analysis Grid">
      {/* ================= COLUMN 1: Pattern Detection & Breakout Prob ================= */}
      <div className="desk-grid-card">
        <div className="desk-panel-title">
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Activity size={15} color="#00e5ff" />
            <span>Pattern Detection ({tf})</span>
          </span>
          <span style={{ fontSize: 10, background: '#131c2a', border: '1px solid #1e2c42', padding: '2px 8px', borderRadius: 4, color: '#94a3b8' }}>
            Recent
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {patterns.map((p, idx) => (
            <div key={idx} className="desk-row-pattern">
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#e2e8f0' }}>
                <span>{p.icon}</span>
                <span>{p.name}</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {p.barsAgo && <span style={{ color: '#64748b', fontSize: 10 }}>{p.barsAgo}</span>}
                <span className={`desk-tag ${p.side === 'Bullish' ? 'desk-tag-bullish' : 'desk-tag-bearish'}`}>
                  {p.side}
                </span>
              </span>
            </div>
          ))}
        </div>

        {/* Breakout / Breakdown Probability Strip */}
        <div style={{ marginTop: 'auto', borderTop: '1px solid #162032', paddingTop: 10 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: '#cbd5e1', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Layers size={13} color="#00e5ff" />
            <span>Breakout / Breakdown Probability ({tf})</span>
          </div>

          <div className="desk-breakout-strip">
            <div className="desk-breakout-tile desk-tile-breakout">
              <span style={{ fontSize: 10.5, color: '#00e676', fontWeight: 600 }}>↗ Breakout &gt; 85,131</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: '#fff', fontFamily: 'ui-monospace, monospace' }}>32%</span>
              <span style={{ fontSize: 9.5, color: '#94a3b8' }}>If triggered, move to 85,341 – 85,552</span>
            </div>

            <div className="desk-breakout-tile desk-tile-range">
              <span style={{ fontSize: 10.5, color: '#fbbf24', fontWeight: 600 }}>⚡ Remain in Range</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: '#fff', fontFamily: 'ui-monospace, monospace' }}>53%</span>
              <span style={{ fontSize: 9.5, color: '#94a3b8' }}>84,300 – 85,600</span>
            </div>

            <div className="desk-breakout-tile desk-tile-breakdown">
              <span style={{ fontSize: 10.5, color: '#ff3b57', fontWeight: 600 }}>↘ Breakdown &lt; 84,300</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: '#fff', fontFamily: 'ui-monospace, monospace' }}>15%</span>
              <span style={{ fontSize: 9.5, color: '#94a3b8' }}>If triggered, move to 84,089 – 83,800</span>
            </div>
          </div>
        </div>
      </div>

      {/* ================= COLUMN 2: Technical Indicators ================= */}
      <div className="desk-grid-card">
        <div className="desk-panel-title">
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Compass size={15} color="#00e5ff" />
            <span>Technical Indicators ({tf})</span>
          </span>
        </div>

        <table className="desk-table">
          <tbody>
            <tr>
              <td style={{ color: '#94a3b8' }}>Trend</td>
              <td style={{ textAlign: 'right', color: '#fff' }}>{calc.trend}</td>
              <td style={{ textAlign: 'right' }}><span className="desk-tag desk-tag-neutral">Neutral</span></td>
            </tr>
            <tr>
              <td style={{ color: '#94a3b8' }}>Structure</td>
              <td style={{ textAlign: 'right', color: '#fff' }}>{calc.structure}</td>
              <td style={{ textAlign: 'right' }}><span className="desk-tag desk-tag-neutral">Flat</span></td>
            </tr>
            <tr>
              <td style={{ color: '#94a3b8' }}>RSI (14)</td>
              <td style={{ textAlign: 'right', color: '#fff' }}>{calc.rsi.value}</td>
              <td style={{ textAlign: 'right' }}>
                <span className={`desk-tag ${calc.rsi.tone === 'up' ? 'desk-tag-bullish' : 'desk-tag-bearish'}`}>
                  {calc.rsi.status}
                </span>
              </td>
            </tr>
            <tr>
              <td style={{ color: '#94a3b8' }}>MACD</td>
              <td style={{ textAlign: 'right', color: calc.macd.value >= 0 ? '#00e676' : '#ff3b57' }}>
                {calc.macd.value >= 0 ? '+' : ''}{calc.macd.value}
              </td>
              <td style={{ textAlign: 'right' }}>
                <span className={`desk-tag ${calc.macd.tone === 'up' ? 'desk-tag-bullish' : 'desk-tag-bearish'}`}>
                  {calc.macd.status}
                </span>
              </td>
            </tr>
            <tr>
              <td style={{ color: '#94a3b8' }}>EMA 21/50</td>
              <td style={{ textAlign: 'right', color: calc.ema.value >= 0 ? '#00e676' : '#ff3b57' }}>
                {calc.ema.value >= 0 ? '+' : ''}{calc.ema.value}
              </td>
              <td style={{ textAlign: 'right' }}>
                <span className={`desk-tag ${calc.ema.tone === 'up' ? 'desk-tag-bullish' : 'desk-tag-bearish'}`}>
                  {calc.ema.status}
                </span>
              </td>
            </tr>
            <tr>
              <td style={{ color: '#94a3b8' }}>VWAP</td>
              <td style={{ textAlign: 'right', color: calc.vwap.value >= 0 ? '#00e676' : '#ff3b57' }}>
                {calc.vwap.value >= 0 ? '+' : ''}{calc.vwap.value}%
              </td>
              <td style={{ textAlign: 'right' }}>
                <span className={`desk-tag ${calc.vwap.tone === 'up' ? 'desk-tag-bullish' : 'desk-tag-bearish'}`}>
                  {calc.vwap.status}
                </span>
              </td>
            </tr>
            <tr>
              <td style={{ color: '#94a3b8' }}>ATR</td>
              <td style={{ textAlign: 'right', color: '#fff' }}>{calc.atr.value}%</td>
              <td style={{ textAlign: 'right' }}><span className="desk-tag desk-tag-neutral">{calc.atr.status}</span></td>
            </tr>
            <tr>
              <td style={{ color: '#94a3b8' }}>ADX</td>
              <td style={{ textAlign: 'right', color: '#fff' }}>{calc.adx.value}</td>
              <td style={{ textAlign: 'right' }}><span className="desk-tag desk-tag-neutral">{calc.adx.status}</span></td>
            </tr>
            <tr>
              <td style={{ color: '#94a3b8' }}>Bollinger %B</td>
              <td style={{ textAlign: 'right', color: '#fff' }}>{calc.bollingerB.value}</td>
              <td style={{ textAlign: 'right' }}>
                <span className={`desk-tag ${calc.bollingerB.tone === 'up' ? 'desk-tag-bullish' : 'desk-tag-bearish'}`}>
                  {calc.bollingerB.status}
                </span>
              </td>
            </tr>
            <tr>
              <td style={{ color: '#94a3b8' }}>Stochastic</td>
              <td style={{ textAlign: 'right', color: '#fff' }}>{calc.stochastic.value}</td>
              <td style={{ textAlign: 'right' }}>
                <span className={`desk-tag ${calc.stochastic.tone === 'up' ? 'desk-tag-bullish' : 'desk-tag-bearish'}`}>
                  {calc.stochastic.status}
                </span>
              </td>
            </tr>
            <tr>
              <td style={{ color: '#94a3b8' }}>Williams %R</td>
              <td style={{ textAlign: 'right', color: '#ff3b57' }}>{calc.williamsR.value}</td>
              <td style={{ textAlign: 'right' }}><span className="desk-tag desk-tag-neutral">{calc.williamsR.status}</span></td>
            </tr>
            <tr>
              <td style={{ color: '#94a3b8' }}>SuperTrend</td>
              <td style={{ textAlign: 'right', color: calc.supertrend.value === 'Up' ? '#00e676' : '#ff3b57' }}>
                {calc.supertrend.value}
              </td>
              <td style={{ textAlign: 'right' }}>
                <span className={`desk-tag ${calc.supertrend.tone === 'up' ? 'desk-tag-bullish' : 'desk-tag-bearish'}`}>
                  {calc.supertrend.status}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ================= COLUMN 3: Key Levels & What this means ================= */}
      <div className="desk-grid-card">
        <div className="desk-panel-title">
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Layers size={15} color="#fbbf24" />
            <span>Key Levels</span>
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', background: '#0a0e17', borderRadius: 8 }}>
            <span style={{ background: 'rgba(255,59,87,0.2)', color: '#ff3b57', padding: '2px 8px', borderRadius: 4, fontWeight: 700, fontSize: 11 }}>
              R1
            </span>
            <strong style={{ color: '#fff', fontFamily: 'ui-monospace, monospace', fontSize: 14 }}>
              {Math.round(r1).toLocaleString()}
            </strong>
            <span style={{ color: '#94a3b8', fontSize: 11 }}>Resistance</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', background: '#0a0e17', borderRadius: 8 }}>
            <span style={{ background: 'rgba(255,59,87,0.2)', color: '#ff3b57', padding: '2px 8px', borderRadius: 4, fontWeight: 700, fontSize: 11 }}>
              R2
            </span>
            <strong style={{ color: '#fff', fontFamily: 'ui-monospace, monospace', fontSize: 14 }}>
              {Math.round(r2).toLocaleString()}
            </strong>
            <span style={{ color: '#94a3b8', fontSize: 11 }}>Resistance</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', background: '#0a0e17', borderRadius: 8 }}>
            <span style={{ background: 'rgba(0,230,118,0.2)', color: '#00e676', padding: '2px 8px', borderRadius: 4, fontWeight: 700, fontSize: 11 }}>
              S1
            </span>
            <strong style={{ color: '#fff', fontFamily: 'ui-monospace, monospace', fontSize: 14 }}>
              {Math.round(s1).toLocaleString()}
            </strong>
            <span style={{ color: '#94a3b8', fontSize: 11 }}>Support</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', background: '#0a0e17', borderRadius: 8 }}>
            <span style={{ background: 'rgba(0,230,118,0.2)', color: '#00e676', padding: '2px 8px', borderRadius: 4, fontWeight: 700, fontSize: 11 }}>
              S2
            </span>
            <strong style={{ color: '#fff', fontFamily: 'ui-monospace, monospace', fontSize: 14 }}>
              {Math.round(s2).toLocaleString()}
            </strong>
            <span style={{ color: '#94a3b8', fontSize: 11 }}>Support</span>
          </div>
        </div>

        {/* What this means Actionable Box */}
        <div style={{ marginTop: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, color: '#fbbf24', fontSize: 12, fontWeight: 700 }}>
            <Lightbulb size={14} />
            <span>What this means</span>
          </div>
          <div className="desk-insight-box">
            {insightText}
          </div>
        </div>
      </div>

      {/* ================= COLUMN 4: Timeframe Alignment & Option Bias & Expiry Movement Chances ================= */}
      <div className="desk-grid-card">
        <div className="desk-panel-title">
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Layers size={15} color="#00e5ff" />
            <span>Timeframe Alignment ({ladderRows.filter((r) => r.way === 'UP').length} of {ladderRows.length})</span>
          </span>
        </div>

        <table className="desk-table">
          <thead>
            <tr>
              <th>TF</th>
              <th>Direction</th>
              <th>Strength</th>
              <th style={{ textAlign: 'right' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {ladderRows.map((r, i) => {
              const way = r.way;
              const isUp = way === 'UP';
              const isDown = way === 'DOWN';
              const arrow = isUp ? '↑' : isDown ? '↓' : '→';
              const color = isUp ? '#00e676' : isDown ? '#ff3b57' : '#94a3b8';
              const status = isUp ? 'Bullish' : isDown ? 'Bearish' : 'Neutral';
              const pct = Math.round(r.conviction * 100);

              return (
                <tr key={i}>
                  <td style={{ color: '#cbd5e1', fontWeight: 600 }}>{r.tf}</td>
                  <td style={{ color, fontWeight: 700 }}>{arrow}</td>
                  <td style={{ color: '#94a3b8' }}>{pct}%</td>
                  <td style={{ textAlign: 'right' }}>
                    <span className={`desk-tag ${isUp ? 'desk-tag-bullish' : isDown ? 'desk-tag-bearish' : 'desk-tag-neutral'}`}>
                      {status}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Option Bias & Expiry Movement Chances */}
        <div style={{ marginTop: 'auto', borderTop: '1px solid #162032', paddingTop: 10 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: '#cbd5e1', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>Option Bias — CE / PE (Expiry)</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
            <div style={{ background: '#0a0e17', padding: '6px 8px', borderRadius: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#00e5ff', fontWeight: 700, marginBottom: 4 }}>
                <span>CE (Calls)</span>
                <span>-1.34%</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                <span>OI</span> <span style={{ color: '#00e676' }}>+0.8%</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                <span>IV</span> <span>25.3%</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                <span>Delta</span> <span>0.14</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                <span>Flow</span> <span style={{ color: '#ff3b57' }}>SELL</span>
              </div>
            </div>

            <div style={{ background: '#0a0e17', padding: '6px 8px', borderRadius: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#f59e0b', fontWeight: 700, marginBottom: 4 }}>
                <span>PE (Puts)</span>
                <span>-2.74%</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                <span>OI</span> <span style={{ color: '#00e676' }}>+2.9%</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                <span>IV</span> <span>26.07%</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                <span>Delta</span> <span>0.14</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                <span>Flow</span> <span style={{ color: '#00e676' }}>MILD BUY</span>
              </div>
            </div>
          </div>

          {/* Expiry Movement Chances */}
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Expiry Movement Chances</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, fontFamily: 'ui-monospace, monospace' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ color: '#94a3b8' }}>&gt; 85,600</span>
                <div style={{ flex: 1, margin: '0 8px', height: 5, background: '#162032', borderRadius: 3 }}>
                  <div style={{ width: '18%', height: '100%', background: '#ff3b57', borderRadius: 3 }} />
                </div>
                <span style={{ color: '#fff' }}>18%</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ color: '#94a3b8' }}>85,341 – 85,600</span>
                <div style={{ flex: 1, margin: '0 8px', height: 5, background: '#162032', borderRadius: 3 }}>
                  <div style={{ width: '20%', height: '100%', background: '#00e676', borderRadius: 3 }} />
                </div>
                <span style={{ color: '#fff' }}>20%</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ color: '#94a3b8' }}>84,300 – 85,341</span>
                <div style={{ flex: 1, margin: '0 8px', height: 5, background: '#162032', borderRadius: 3 }}>
                  <div style={{ width: '64%', height: '100%', background: '#00e5ff', borderRadius: 3 }} />
                </div>
                <span style={{ color: '#fff' }}>64%</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ color: '#94a3b8' }}>84,089 – 84,300</span>
                <div style={{ flex: 1, margin: '0 8px', height: 5, background: '#162032', borderRadius: 3 }}>
                  <div style={{ width: '12%', height: '100%', background: '#ff3b57', borderRadius: 3 }} />
                </div>
                <span style={{ color: '#fff' }}>12%</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
