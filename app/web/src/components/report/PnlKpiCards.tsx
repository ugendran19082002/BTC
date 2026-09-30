import { useMemo } from 'react';
import type { DayRow } from '@/types/report';
import type { TradeStatus, OrderRecord } from '@/types/trade';
import { inr, signedInr, usdToInr } from '@/lib/format';
import { daysAgoIst, todayIst } from '@/lib/report';

export interface PnlKpiCardsProps {
  rows: DayRow[];
  totalsNetUsd: number;
  includeCharges: boolean;
  status?: TradeStatus | null;
  orders?: OrderRecord[];
}

export function PnlKpiCards({ rows, totalsNetUsd, includeCharges, status, orders }: PnlKpiCardsProps) {
  const todayStr = todayIst();

  // 1. Total P&L (Strict dynamic: historical net + open unrealized MTM)
  const liveUnrealizedUsd = status?.unrealisedPnlUsd ?? 0;
  const totalCombinedUsd = totalsNetUsd + liveUnrealizedUsd;
  const totalNetInr = usdToInr(totalCombinedUsd) ?? 0;
  const netInrDisplay = totalNetInr !== 0 ? signedInr(totalNetInr) : '₹0';
  const totalTone = totalNetInr > 0 ? 'up' : totalNetInr < 0 ? 'down' : 'neutral';

  const balanceUsd = status?.balanceUsd ?? 0;
  const returnPct = balanceUsd > 0
    ? `${totalCombinedUsd >= 0 ? '+' : ''}${((totalCombinedUsd / balanceUsd) * 100).toFixed(1)}%`
    : null;

  // 2. Realized P&L (Strict dynamic from closed rows)
  const totalRealizedUsd = rows.reduce((acc, r) => acc + r.realisedUsd, 0);
  const totalRealizedInr = usdToInr(totalRealizedUsd) ?? 0;
  const realizedInrDisplay = totalRealizedInr !== 0 ? signedInr(totalRealizedInr) : '₹0';
  const realizedTone = totalRealizedInr > 0 ? 'up' : totalRealizedInr < 0 ? 'down' : 'neutral';

  const totalTradesCount = orders && orders.length > 0
    ? orders.length
    : rows.reduce((acc, r) => acc + (r.trades || 0), 0);

  const winTradesCount = orders && orders.length > 0
    ? orders.filter((o) => (o.netRealisedUsd ?? o.realisedPnl) > 0).length
    : rows.filter((r) => r.netUsd > 0).length;

  const winRatePct = totalTradesCount > 0
    ? ((winTradesCount / totalTradesCount) * 100).toFixed(1)
    : '0.0';

  // 3. Unrealized P&L (Strict real-time from open position mark-to-market)
  const liveUnrealizedInr = usdToInr(liveUnrealizedUsd) ?? 0;
  const unrealizedInrDisplay = liveUnrealizedInr !== 0 ? signedInr(liveUnrealizedInr) : '₹0';
  const unrealizedTone = liveUnrealizedInr > 0 ? 'up' : liveUnrealizedInr < 0 ? 'down' : 'neutral';
  const openPositionsCount = status?.positions?.length ?? 0;

  // 4. Today's P&L (Strict dynamic: today's live session net, zero if no trade today)
  const todayRow = rows.find((r) => r.day === todayStr) ?? null;
  const todayNetUsd = status?.today?.netUsd !== undefined
    ? status.today.netUsd
    : (todayRow ? todayRow.netUsd : 0);
  const todayNetInr = usdToInr(todayNetUsd) ?? 0;
  const todayInrDisplay = todayNetInr !== 0 ? signedInr(todayNetInr) : '₹0';
  const todayTone = todayNetInr > 0 ? 'up' : todayNetInr < 0 ? 'down' : 'neutral';

  // 5. This Week's P&L (Strict dynamic: past 7 days from today, or last 7 days of range)
  const sevenDaysAgo = daysAgoIst(7);
  const liveWeekRows = rows.filter((r) => r.day >= sevenDaysAgo && r.day <= todayStr);
  const weekRows = liveWeekRows.length > 0 ? liveWeekRows : rows.slice(-7);
  const weekNetUsd = weekRows.reduce((acc, r) => acc + r.netUsd, 0);
  const weekNetInr = usdToInr(weekNetUsd) ?? 0;
  const weekInrDisplay = weekNetInr !== 0 ? signedInr(weekNetInr) : '₹0';
  const weekTone = weekNetInr > 0 ? 'up' : weekNetInr < 0 ? 'down' : 'neutral';

  // 6. This Month's P&L (Strict dynamic: current calendar month, or last 30 days of range)
  const curMonthPrefix = todayStr.slice(0, 7);
  const liveMonthRows = rows.filter((r) => r.day.startsWith(curMonthPrefix));
  const monthRows = liveMonthRows.length > 0 ? liveMonthRows : rows.slice(-30);
  const monthNetUsd = monthRows.reduce((acc, r) => acc + r.netUsd, 0);
  const monthNetInr = usdToInr(monthNetUsd) ?? 0;
  const monthInrDisplay = monthNetInr !== 0 ? signedInr(monthNetInr) : '₹0';
  const monthTone = monthNetInr > 0 ? 'up' : monthNetInr < 0 ? 'down' : 'neutral';

  // 7. Max Drawdown (Dynamic peak-to-trough drop from daily closed returns)
  const { maxDdInr, maxDdPct } = useMemo(() => {
    let peak = 0;
    let maxDd = 0;
    let running = 0;
    for (const r of rows) {
      running += r.netUsd;
      if (running > peak) peak = running;
      const dd = peak - running;
      if (dd > maxDd) maxDd = dd;
    }
    const ddInr = usdToInr(maxDd) ?? 0;
    const ddInrStr = ddInr > 0 ? `−${inr(ddInr)}` : '₹0';
    const ddPctStr = balanceUsd > 0 && maxDd > 0 ? `-${((maxDd / balanceUsd) * 100).toFixed(1)}%` : null;
    return { maxDdInr: ddInrStr, maxDdPct: ddPctStr };
  }, [rows, balanceUsd]);

  // Dynamic Sparkline for Total P&L from actual data
  const totalSparklinePoints = useMemo(() => {
    if (rows.length === 0) return null;
    let run = 0;
    const series = rows.map((r) => {
      run += r.netUsd;
      return run;
    });
    const min = Math.min(...series);
    const max = Math.max(...series);
    const span = max - min || 1;
    const W = 68;
    const H = 24;
    return series.map((val, idx) => {
      const x = (idx / Math.max(1, series.length - 1)) * W;
      const y = H - ((val - min) / span) * (H - 6) - 3;
      return { x, y };
    });
  }, [rows]);

  const totalPathD = useMemo(() => {
    if (!totalSparklinePoints || totalSparklinePoints.length < 2) return '';
    return totalSparklinePoints.reduce((acc, pt, i) => (i === 0 ? `M ${pt.x} ${pt.y}` : `${acc} L ${pt.x} ${pt.y}`), '');
  }, [totalSparklinePoints]);

  return (
    <div className="pnl-kpi-strip" role="region" aria-label="Key Performance Indicators">
      {/* 1. Total P&L Card */}
      <div className={`pnl-kpi-card ${totalTone === 'down' ? 'tone-down' : ''}`}>
        <div className="pnl-kpi-head">
          <span className="pnl-kpi-label">Total P&L</span>
          {returnPct && <span className={`pnl-kpi-badge ${totalTone}`}>{returnPct}</span>}
        </div>
        <div className="pnl-kpi-body">
          <span className={`pnl-kpi-val ${totalTone}`}>{netInrDisplay}</span>
          {totalPathD && (
            <div className="pnl-kpi-spark">
              <svg width="68" height="26" viewBox="0 0 68 26" fill="none">
                <path
                  d={totalPathD}
                  stroke={totalTone === 'down' ? '#f43f5e' : '#10b981'}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          )}
        </div>
        <div className="pnl-kpi-foot">
          <span>{includeCharges ? 'Net after charges' : 'Gross before charges'}</span>
        </div>
      </div>

      {/* 2. Realized P&L */}
      <div className={`pnl-kpi-card ${realizedTone === 'down' ? 'tone-down' : ''}`}>
        <div className="pnl-kpi-head">
          <span className="pnl-kpi-label">Realized P&L</span>
        </div>
        <div className="pnl-kpi-body">
          <span className={`pnl-kpi-val ${realizedTone}`}>{realizedInrDisplay}</span>
        </div>
        <div className="pnl-kpi-foot">
          <span>{totalTradesCount} trades · Win rate {winRatePct}%</span>
        </div>
      </div>

      {/* 3. Unrealized P&L */}
      <div className={`pnl-kpi-card ${unrealizedTone === 'down' ? 'tone-down' : ''}`}>
        <div className="pnl-kpi-head">
          <span className="pnl-kpi-label">Unrealized P&L</span>
        </div>
        <div className="pnl-kpi-body">
          <span className={`pnl-kpi-val ${unrealizedTone}`}>{unrealizedInrDisplay}</span>
        </div>
        <div className="pnl-kpi-foot">
          <span>{openPositionsCount} open position{openPositionsCount === 1 ? '' : 's'}</span>
        </div>
      </div>

      {/* 4. Today's P&L */}
      <div className={`pnl-kpi-card ${todayTone === 'down' ? 'tone-down' : ''}`}>
        <div className="pnl-kpi-head">
          <span className="pnl-kpi-label">Today's P&L</span>
        </div>
        <div className="pnl-kpi-body">
          <span className={`pnl-kpi-val ${todayTone}`}>{todayInrDisplay}</span>
        </div>
        <div className="pnl-kpi-foot">
          <span>Current active session</span>
        </div>
      </div>

      {/* 5. This Week */}
      <div className={`pnl-kpi-card ${weekTone === 'down' ? 'tone-down' : ''}`}>
        <div className="pnl-kpi-head">
          <span className="pnl-kpi-label">This Week</span>
        </div>
        <div className="pnl-kpi-body">
          <span className={`pnl-kpi-val ${weekTone}`}>{weekInrDisplay}</span>
          {weekRows.length > 0 && (
            <div className="pnl-kpi-spark">
              <svg width="48" height="22" viewBox="0 0 48 22">
                {weekRows.map((r, i) => {
                  const h = Math.min(18, Math.max(3, Math.abs(r.netUsd) * 0.1));
                  const isUp = r.netUsd >= 0;
                  return (
                    <rect
                      key={i}
                      x={2 + i * 6.5}
                      y={isUp ? 18 - h : 18}
                      width="5"
                      height={h}
                      rx="1"
                      fill={isUp ? '#10b981' : '#f43f5e'}
                      opacity={0.8}
                    />
                  );
                })}
              </svg>
            </div>
          )}
        </div>
        <div className="pnl-kpi-foot">
          <span>Rolling 7 days ({weekRows.length} active)</span>
        </div>
      </div>

      {/* 6. This Month */}
      <div className={`pnl-kpi-card ${monthTone === 'down' ? 'tone-down' : ''}`}>
        <div className="pnl-kpi-head">
          <span className="pnl-kpi-label">This Month</span>
        </div>
        <div className="pnl-kpi-body">
          <span className={`pnl-kpi-val ${monthTone}`}>{monthInrDisplay}</span>
        </div>
        <div className="pnl-kpi-foot">
          <span>{monthRows.length} active trading day{monthRows.length === 1 ? '' : 's'}</span>
        </div>
      </div>

      {/* 7. Max Drawdown */}
      <div className="pnl-kpi-card tone-down">
        <div className="pnl-kpi-head">
          <span className="pnl-kpi-label">Max Drawdown</span>
          {maxDdPct && <span className="pnl-kpi-badge down">{maxDdPct}</span>}
        </div>
        <div className="pnl-kpi-body">
          <span className="pnl-kpi-val down">{maxDdInr}</span>
        </div>
        <div className="pnl-kpi-foot">
          <span>Peak-to-trough risk</span>
        </div>
      </div>
    </div>
  );
}
