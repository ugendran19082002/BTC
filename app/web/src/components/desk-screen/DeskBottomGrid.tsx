import { Activity, Compass, Layers, Lightbulb } from 'lucide-react';
import type { Candle } from '@/types/desk';
import type { Ladder, ExpiryPrediction } from '@/types/live';
import type { MarketStateResponse } from '@/api/desk';
import { calculateIndicators } from './indicators-calc';
import { DeskMarketScore } from './DeskMarketScore';

export function DeskBottomGrid({
  bars,
  spot = 84595,
  tf = '15m',
  marketState,
  ladder,
  optionBias,
  prediction,
}: {
  bars: readonly Candle[];
  spot?: number;
  tf?: string;
  marketState?: MarketStateResponse | null;
  ladder?: Ladder | null;
  optionBias?: any;
  prediction?: ExpiryPrediction | null;
}) {
  const calc = calculateIndicators(bars, spot);

  // Settlement band from live prediction
  const band = prediction?.band;
  const predLow = band?.low ? Math.round(band.low) : 84300;
  const predHigh = band?.high ? Math.round(band.high) : 85600;

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

  const midUpper = Math.round(pInside * 0.35);
  const midLower = pInside - midUpper;
  const midStrike = Math.round((predLow + predHigh) / 2);

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
    { name: 'Order Block Rejection (84,800)', barsAgo: '3b', side: 'Bearish', icon: '🧱' },
    { name: 'Lower Highs Sequence', barsAgo: '', side: 'Bearish', icon: '📉' },
    { name: 'Channel Down Breakdown', barsAgo: '1b', side: 'Bearish', icon: '📉' },
    { name: 'Liquidity Sweep High (85,150)', barsAgo: '5b', side: 'Bearish', icon: '⚡' },
    { name: 'CHOCH / BOS Confirmed', barsAgo: '4b', side: 'Bearish', icon: '🔄' },
    { name: 'Bullish Engulfing Retest', barsAgo: '', side: 'Bullish', icon: '📈' },
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

      {/* ================= COLUMN 4: Hierarchical Timeframe Alignment & Option Bias ================= */}
      <div className="desk-grid-card">
        <div className="desk-panel-title">
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Layers size={15} color="#00e5ff" />
            <span>Multi-Timeframe Hierarchy ({ladderRows.filter((r) => r.way === 'UP').length} of {ladderRows.length} Up)</span>
          </span>
          <span style={{ fontSize: 10, background: 'rgba(0,229,255,0.12)', color: '#00e5ff', padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
            WEIGHTED
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '8px 0' }}>
          {/* Group 1: 12H / 6H Macro Direction */}
          <div style={{ background: '#0a0e17', borderRadius: 6, padding: '5px 8px', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#8492a6', fontWeight: 600, marginBottom: 3, textTransform: 'uppercase' }}>
              <span>Direction (12H / 6H)</span>
              <span style={{ color: '#00e5ff' }}>Weight: High</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {ladderRows.filter(r => r.tf === '12h' || r.tf === '6h').map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                  <b style={{ color: '#cbd5e1' }}>{r.tf.toUpperCase()}:</b>
                  <span style={{ color: r.way === 'UP' ? '#00e676' : r.way === 'DOWN' ? '#ff3b57' : '#94a3b8', fontWeight: 700 }}>
                    {r.way === 'UP' ? '↑ UP' : r.way === 'DOWN' ? '↓ DOWN' : '→ SIDE'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Group 2: 4H / 2H Structure & Key Levels */}
          <div style={{ background: '#0a0e17', borderRadius: 6, padding: '5px 8px', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#8492a6', fontWeight: 600, marginBottom: 3, textTransform: 'uppercase' }}>
              <span>Structure (4H / 2H)</span>
              <span style={{ color: '#a855f7' }}>Weight: High</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {ladderRows.filter(r => r.tf === '4h' || r.tf === '2h').map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                  <b style={{ color: '#cbd5e1' }}>{r.tf.toUpperCase()}:</b>
                  <span style={{ color: r.way === 'UP' ? '#00e676' : r.way === 'DOWN' ? '#ff3b57' : '#94a3b8', fontWeight: 700 }}>
                    {r.way === 'UP' ? '↑ UP' : r.way === 'DOWN' ? '↓ DOWN' : '→ SIDE'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Group 3: 1H / 30M Setup & Liquidity */}
          <div style={{ background: '#0a0e17', borderRadius: 6, padding: '5px 8px', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#8492a6', fontWeight: 600, marginBottom: 3, textTransform: 'uppercase' }}>
              <span>Setup (1H / 30M)</span>
              <span style={{ color: '#fbbf24' }}>Weight: Med</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {ladderRows.filter(r => r.tf === '1h' || r.tf === '30m').map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                  <b style={{ color: '#cbd5e1' }}>{r.tf.toUpperCase()}:</b>
                  <span style={{ color: r.way === 'UP' ? '#00e676' : r.way === 'DOWN' ? '#ff3b57' : '#94a3b8', fontWeight: 700 }}>
                    {r.way === 'UP' ? '↑ UP' : r.way === 'DOWN' ? '↓ DOWN' : '→ SIDE'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Group 4: 15M / 5M / 1M Trigger & Execution */}
          <div style={{ background: '#0a0e17', borderRadius: 6, padding: '5px 8px', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#8492a6', fontWeight: 600, marginBottom: 3, textTransform: 'uppercase' }}>
              <span>Trigger &amp; Timing (15M / 5M)</span>
              <span style={{ color: '#00e676' }}>Weight: High</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {ladderRows.filter(r => r.tf === '15m' || r.tf === '5m').map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                  <b style={{ color: '#cbd5e1' }}>{r.tf.toUpperCase()}:</b>
                  <span style={{ color: r.way === 'UP' ? '#00e676' : r.way === 'DOWN' ? '#ff3b57' : '#94a3b8', fontWeight: 700 }}>
                    {r.way === 'UP' ? '↑ UP' : r.way === 'DOWN' ? '↓ DOWN' : '→ SIDE'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Option Bias — CE / PE */}
        <div style={{ marginTop: 'auto', borderTop: '1px solid #162032', paddingTop: 10 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: '#cbd5e1', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>Option Bias — CE / PE (Expiry)</span>
          </div>

          <div className="desk-opt-bias-grid">
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
        </div>
      </div>

      {/* ================= COLUMN 5: Market Analysis Score & Expiry Movement Chances ================= */}
      <div className="desk-grid-card">
        <DeskMarketScore ladder={ladder} marketState={marketState} />

        <div style={{ marginTop: 'auto', borderTop: '1px solid #162032', paddingTop: 10 }}>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6, fontWeight: 600 }}>Expiry Movement Chances</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 10.5, fontFamily: 'ui-monospace, monospace' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ color: '#94a3b8', minWidth: 70 }}>&gt; {predHigh.toLocaleString()}</span>
              <div style={{ flex: 1, margin: '0 8px', height: 6, background: '#162032', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(8, pAbove)}%`, height: '100%', background: '#ff3b57', borderRadius: 3 }} />
              </div>
              <span style={{ color: '#fff', fontWeight: 600 }}>{pAbove}%</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ color: '#94a3b8', minWidth: 70 }}>{midStrike.toLocaleString()} – {predHigh.toLocaleString()}</span>
              <div style={{ flex: 1, margin: '0 8px', height: 6, background: '#162032', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(8, midUpper)}%`, height: '100%', background: '#00e676', borderRadius: 3 }} />
              </div>
              <span style={{ color: '#fff', fontWeight: 600 }}>{midUpper}%</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ color: '#94a3b8', minWidth: 70 }}>{predLow.toLocaleString()} – {midStrike.toLocaleString()}</span>
              <div style={{ flex: 1, margin: '0 8px', height: 6, background: '#162032', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(8, midLower)}%`, height: '100%', background: '#00e5ff', borderRadius: 3 }} />
              </div>
              <span style={{ color: '#fff', fontWeight: 600 }}>{midLower}%</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ color: '#94a3b8', minWidth: 70 }}>&lt; {predLow.toLocaleString()}</span>
              <div style={{ flex: 1, margin: '0 8px', height: 6, background: '#162032', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(8, pBelow)}%`, height: '100%', background: '#ff3b57', borderRadius: 3 }} />
              </div>
              <span style={{ color: '#fff', fontWeight: 600 }}>{pBelow}%</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
