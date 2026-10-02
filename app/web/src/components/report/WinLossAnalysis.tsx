import { useMemo } from 'react';
import { usePersisted } from '@/hooks/usePersisted';
import type { DayRow } from '@/types/report';
import type { OrderRecord } from '@/types/trade';
import { signedInr, usdToInr } from '@/lib/format';

export interface WinLossAnalysisProps {
  rows: DayRow[];
  orders?: OrderRecord[];
}

export function WinLossAnalysis({ rows, orders = [] }: WinLossAnalysisProps) {
  const [viewMode, setViewMode] = usePersisted<'count' | 'pnl'>('report:winloss-view', 'count');

  const {
    winCount,
    lossCount,
    breakevenCount,
    totalCount,
    winRateStr,
    winPct,
    lossPct,
    avgWinStr,
    avgLossStr,
    profitFactorStr,
    winPnlStr,
    lossPnlStr,
  } = useMemo(() => {
    // 1. From real orders if available
    if (orders && orders.length > 0) {
      const completed = orders.filter((o) => o.status === 'completed' || o.position === 0);
      const wins = completed.filter((o) => (o.netRealisedUsd ?? o.realisedPnl) > 0);
      const losses = completed.filter((o) => (o.netRealisedUsd ?? o.realisedPnl) < 0);
      const bes = completed.filter((o) => (o.netRealisedUsd ?? o.realisedPnl) === 0);

      const winTrades = wins.length;
      const lossTrades = losses.length;
      const beTrades = bes.length;
      const total = completed.length;

      const rate = total > 0 ? (winTrades / total) * 100 : 0;
      const grossWinsUsd = wins.reduce((acc, o) => acc + (o.netRealisedUsd ?? o.realisedPnl), 0);
      const grossLossesUsd = Math.abs(losses.reduce((acc, o) => acc + (o.netRealisedUsd ?? o.realisedPnl), 0));

      const avgWinUsd = winTrades > 0 ? grossWinsUsd / winTrades : 0;
      const avgLossUsd = lossTrades > 0 ? grossLossesUsd / lossTrades : 0;
      const pf = grossLossesUsd > 0 ? (grossWinsUsd / grossLossesUsd).toFixed(2) : grossWinsUsd > 0 ? '∞' : '—';

      return {
        winCount: winTrades,
        lossCount: lossTrades,
        breakevenCount: beTrades,
        totalCount: total,
        winRateStr: total > 0 ? `${rate.toFixed(1)}%` : '0%',
        winPct: rate,
        lossPct: total > 0 ? (lossTrades / total) * 100 : 0,
        avgWinStr: avgWinUsd > 0 ? signedInr(usdToInr(avgWinUsd)) : '—',
        avgLossStr: avgLossUsd > 0 ? signedInr(usdToInr(-avgLossUsd)) : '—',
        profitFactorStr: pf,
        winPnlStr: grossWinsUsd > 0 ? signedInr(usdToInr(grossWinsUsd)) : '₹0',
        lossPnlStr: grossLossesUsd > 0 ? signedInr(usdToInr(-grossLossesUsd)) : '₹0',
      };
    }

    // 2. From real day rows
    const wins = rows.filter((r) => r.netUsd > 0);
    const losses = rows.filter((r) => r.netUsd < 0);
    const bes = rows.filter((r) => r.netUsd === 0);

    const winDays = wins.length;
    const lossDays = losses.length;
    const beDays = bes.length;
    const total = rows.length;

    const rate = total > 0 ? (winDays / total) * 100 : 0;
    const grossWinsUsd = wins.reduce((acc, r) => acc + r.netUsd, 0);
    const grossLossesUsd = Math.abs(losses.reduce((acc, r) => acc + r.netUsd, 0));

    const avgWinInr = winDays > 0 ? (usdToInr(grossWinsUsd) ?? 0) / winDays : 0;
    const avgLossInr = lossDays > 0 ? (usdToInr(grossLossesUsd) ?? 0) / lossDays : 0;
    const pf = grossLossesUsd > 0 ? (grossWinsUsd / grossLossesUsd).toFixed(2) : grossWinsUsd > 0 ? '∞' : '—';

    return {
      winCount: winDays,
      lossCount: lossDays,
      breakevenCount: beDays,
      totalCount: total,
      winRateStr: total > 0 ? `${rate.toFixed(1)}%` : '0%',
      winPct: rate,
      lossPct: total > 0 ? (lossDays / total) * 100 : 0,
      avgWinStr: avgWinInr > 0 ? signedInr(avgWinInr) : '—',
      avgLossStr: avgLossInr > 0 ? signedInr(-avgLossInr) : '—',
      profitFactorStr: pf,
      winPnlStr: grossWinsUsd > 0 ? signedInr(usdToInr(grossWinsUsd)) : '₹0',
      lossPnlStr: grossLossesUsd > 0 ? signedInr(usdToInr(-grossLossesUsd)) : '₹0',
    };
  }, [rows, orders]);

  // Donut circumference & dash calculations
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
            <circle
              cx="60"
              cy="60"
              r={R}
              stroke="rgba(30, 41, 59, 0.6)"
              strokeWidth="12"
              fill="none"
            />
            {totalCount > 0 && winStroke > 0 && (
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
            )}
            {totalCount > 0 && lossStroke > 0 && (
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
            )}
          </svg>
          <div className="pnl-donut-center">
            <span className="pnl-donut-pct">{winRateStr}</span>
            <span className="pnl-donut-sub">{totalCount > 0 ? 'Win rate' : 'No trades'}</span>
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
