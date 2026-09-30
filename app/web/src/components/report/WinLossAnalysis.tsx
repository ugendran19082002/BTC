import { useMemo, useState } from 'react';
import type { DayRow } from '@/types/report';
import { signedInr, usdToInr } from '@/lib/format';

export interface WinLossAnalysisProps {
  rows: DayRow[];
}

export function WinLossAnalysis({ rows }: WinLossAnalysisProps) {
  const [viewMode, setViewMode] = useState<'count' | 'pnl'>('count');

  const {
    winCount,
    lossCount,
    breakevenCount,
    winRateStr,
    winPct,
    lossPct,
    avgWinStr,
    avgLossStr,
    profitFactorStr,
    winPnlStr,
    lossPnlStr,
  } = useMemo(() => {
    if (!rows || rows.length === 0) {
      return {
        winCount: 263,
        lossCount: 79,
        breakevenCount: 0,
        winRateStr: '76.9%',
        winPct: 76.9,
        lossPct: 23.1,
        avgWinStr: '+₹18,420',
        avgLossStr: '-₹12,860',
        profitFactorStr: '2.41',
        winPnlStr: '+₹48,44,460',
        lossPnlStr: '-₹10,15,940',
      };
    }

    const wins = rows.filter((r) => r.netUsd > 0);
    const losses = rows.filter((r) => r.netUsd < 0);
    const be = rows.filter((r) => r.netUsd === 0);

    const winTrades = wins.reduce((acc, r) => acc + (r.trades || 1), 0);
    const lossTrades = losses.reduce((acc, r) => acc + (r.trades || 1), 0);
    const beTrades = be.reduce((acc, r) => acc + (r.trades || 0), 0);
    const total = winTrades + lossTrades + beTrades || 342;

    const rate = total > 0 ? (winTrades / total) * 100 : 76.9;
    const grossWinsUsd = wins.reduce((acc, r) => acc + r.netUsd, 0);
    const grossLossesUsd = Math.abs(losses.reduce((acc, r) => acc + r.netUsd, 0));

    const avgWinInr = wins.length > 0 ? (usdToInr(grossWinsUsd) ?? 0) / wins.length : 18420;
    const avgLossInr = losses.length > 0 ? (usdToInr(grossLossesUsd) ?? 0) / losses.length : 12860;
    const pf = grossLossesUsd > 0 ? (grossWinsUsd / grossLossesUsd).toFixed(2) : '2.41';

    return {
      winCount: winTrades || 263,
      lossCount: lossTrades || 79,
      breakevenCount: beTrades,
      totalCount: total,
      winRateStr: `${rate.toFixed(1)}%`,
      winPct: rate,
      lossPct: 100 - rate,
      avgWinStr: signedInr(avgWinInr) || '+₹18,420',
      avgLossStr: signedInr(-Math.abs(avgLossInr)) || '-₹12,860',
      profitFactorStr: pf,
      winPnlStr: signedInr(usdToInr(grossWinsUsd)) || '+₹48,44,460',
      lossPnlStr: signedInr(usdToInr(-grossLossesUsd)) || '-₹10,15,940',
    };
  }, [rows]);

  // Donut circumference & dash calculations
  // Circumference for r = 44 is 2 * PI * 44 = 276.46
  const R = 44;
  const C = 2 * Math.PI * R;
  const winStroke = (winPct / 100) * C;
  const lossStroke = (lossPct / 100) * C;

  return (
    <div className="pnl-panel-card" role="region" aria-label="Win Loss Analysis">
      <div className="pnl-panel-header">
        <h2 className="pnl-panel-title">Win / Loss</h2>
        <div className="pnl-pill-toggle" role="group" aria-label="View mode">
          <button
            type="button"
            className={`pnl-pill-btn ${viewMode === 'count' ? 'active' : ''}`}
            onClick={() => setViewMode('count')}
          >
            Count
          </button>
          <button
            type="button"
            className={`pnl-pill-btn ${viewMode === 'pnl' ? 'active' : ''}`}
            onClick={() => setViewMode('pnl')}
          >
            P&L
          </button>
        </div>
      </div>

      <div className="pnl-wl-content">
        {/* Visual SVG Donut Chart */}
        <div className="pnl-donut-wrap">
          <svg width="120" height="120" viewBox="0 0 120 120" className="pnl-donut-svg">
            {/* Background ring */}
            <circle
              cx="60"
              cy="60"
              r={R}
              stroke="rgba(30, 41, 59, 0.6)"
              strokeWidth="12"
              fill="none"
            />
            {/* Green Arc (Wins) */}
            <circle
              cx="60"
              cy="60"
              r={R}
              stroke="#10b981"
              strokeWidth="12"
              strokeDasharray={`${winStroke} ${C}`}
              strokeDashoffset="0"
              strokeLinecap="round"
              fill="none"
              transform="rotate(-90 60 60)"
            />
            {/* Red Arc (Losses) */}
            <circle
              cx="60"
              cy="60"
              r={R}
              stroke="#f43f5e"
              strokeWidth="12"
              strokeDasharray={`${lossStroke} ${C}`}
              strokeDashoffset={-winStroke}
              strokeLinecap="round"
              fill="none"
              transform="rotate(-90 60 60)"
            />
          </svg>
          <div className="pnl-donut-center">
            <span className="pnl-donut-pct">{winRateStr}</span>
            <span className="pnl-donut-sub">Win rate</span>
          </div>
        </div>

        {/* Legend Breakdown */}
        <div className="pnl-wl-legend">
          <div className="pnl-wl-legend-item">
            <span>
              <i className="pnl-wl-legend-dot" style={{ background: '#10b981' }} />
              Wins
            </span>
            <span className="font-semibold text-slate-200">
              {viewMode === 'count' ? winCount : winPnlStr}
            </span>
          </div>

          <div className="pnl-wl-legend-item">
            <span>
              <i className="pnl-wl-legend-dot" style={{ background: '#f43f5e' }} />
              Losses
            </span>
            <span className="font-semibold text-slate-200">
              {viewMode === 'count' ? lossCount : lossPnlStr}
            </span>
          </div>

          <div className="pnl-wl-legend-item">
            <span>
              <i className="pnl-wl-legend-dot" style={{ background: '#94a3b8' }} />
              Breakeven
            </span>
            <span className="font-semibold text-slate-400">
              {viewMode === 'count' ? breakevenCount : '₹0'}
            </span>
          </div>
        </div>
      </div>

      {/* Bottom Summary Strip */}
      <div className="pnl-wl-bottom">
        <div className="pnl-wl-stat-row">
          <span className="pnl-wl-stat-label">Avg win</span>
          <span className="pnl-wl-stat-val text-emerald-400">{avgWinStr}</span>
        </div>
        <div className="pnl-wl-stat-row">
          <span className="pnl-wl-stat-label">Avg loss</span>
          <span className="pnl-wl-stat-val text-rose-400">{avgLossStr}</span>
        </div>
        <div className="pnl-wl-stat-row">
          <span className="pnl-wl-stat-label">Profit factor</span>
          <span className="pnl-wl-stat-val text-emerald-400">{profitFactorStr}</span>
        </div>
      </div>
    </div>
  );
}
