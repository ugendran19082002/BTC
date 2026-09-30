import { useMemo, useState } from 'react';
import type { DayRow } from '@/types/report';
import type { TradeStatus } from '@/types/trade';
import { usdToInr } from '@/lib/format';

export interface PnlCurveChartProps {
  rows: DayRow[];
  includeCharges?: boolean;
  status?: TradeStatus | null;
}

interface CurvePoint {
  day: string;
  label: string;
  fullDate: string;
  totalPnl: number;
  realized: number;
  unrealized: number;
}

export function PnlCurveChart({ rows, status }: PnlCurveChartProps) {
  const [viewMode, setViewMode] = useState<'Cumulative' | 'Daily' | 'Weekly' | 'Monthly'>('Cumulative');
  const [metricType, setMetricType] = useState<'P&L' | '% Return'>('P&L');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const balanceInr = status?.balanceUsd ? (usdToInr(status.balanceUsd) ?? 0) : 0;

  // Compute curve points strictly from live rows
  const points: CurvePoint[] = useMemo(() => {
    if (!rows || rows.length === 0) return [];

    const liveUnrealizedInr = status?.unrealisedPnlUsd ? (usdToInr(status.unrealisedPnlUsd) ?? 0) : 0;

    if (viewMode === 'Cumulative') {
      let runRealized = 0;
      return rows.map((r, idx) => {
        const netInr = usdToInr(r.netUsd) ?? 0;
        runRealized += netInr;
        const isLast = idx === rows.length - 1;
        const unrealized = isLast ? liveUnrealizedInr : 0;
        const totalPnl = runRealized + unrealized;

        return {
          day: r.day,
          label: formatDayLabel(r.day),
          fullDate: formatFullDate(r.day),
          totalPnl,
          realized: runRealized,
          unrealized,
        };
      });
    }

    if (viewMode === 'Daily') {
      return rows.map((r, idx) => {
        const netInr = usdToInr(r.netUsd) ?? 0;
        const isLast = idx === rows.length - 1;
        const unrealized = isLast ? liveUnrealizedInr : 0;
        return {
          day: r.day,
          label: formatDayLabel(r.day),
          fullDate: formatFullDate(r.day),
          totalPnl: netInr + unrealized,
          realized: netInr,
          unrealized,
        };
      });
    }

    if (viewMode === 'Weekly') {
      const weeksMap = new Map<string, { netInr: number; lastDay: string }>();
      for (const r of rows) {
        const d = new Date(r.day);
        const weekNum = getWeekNumber(d);
        const weekKey = `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
        const prev = weeksMap.get(weekKey) ?? { netInr: 0, lastDay: r.day };
        weeksMap.set(weekKey, {
          netInr: prev.netInr + (usdToInr(r.netUsd) ?? 0),
          lastDay: r.day,
        });
      }
      return [...weeksMap.entries()].map(([k, v]) => ({
        day: k,
        label: `W${k.slice(-2)}`,
        fullDate: `Week of ${v.lastDay}`,
        totalPnl: v.netInr,
        realized: v.netInr,
        unrealized: 0,
      }));
    }

    // Monthly
    const monthsMap = new Map<string, { netInr: number; year: string; month: string }>();
    for (const r of rows) {
      const monthKey = r.day.slice(0, 7);
      const prev = monthsMap.get(monthKey) ?? {
        netInr: 0,
        year: r.day.slice(0, 4),
        month: r.day.slice(5, 7),
      };
      monthsMap.set(monthKey, {
        netInr: prev.netInr + (usdToInr(r.netUsd) ?? 0),
        year: prev.year,
        month: prev.month,
      });
    }
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return [...monthsMap.entries()].map(([k, v]) => {
      const name = monthNames[Number(v.month) - 1] ?? v.month;
      return {
        day: k,
        label: `${name} '${v.year.slice(-2)}`,
        fullDate: `${name} ${v.year}`,
        totalPnl: v.netInr,
        realized: v.netInr,
        unrealized: 0,
      };
    });
  }, [rows, viewMode, status]);

  // Chart Geometry
  const W = 680;
  const H = 240;
  const padLeft = 50;
  const padRight = 15;
  const padTop = 15;
  const padBottom = 30;

  const chartW = W - padLeft - padRight;
  const chartH = H - padTop - padBottom;

  const hasData = points.length > 0;

  // Value transformation based on metricType
  const transformVal = (val: number): number => {
    if (metricType === '% Return' && balanceInr > 0) {
      return (val / balanceInr) * 100;
    }
    return val;
  };

  const allTransformed = hasData
    ? points.flatMap((p) => [transformVal(p.totalPnl), transformVal(p.realized), transformVal(p.unrealized)])
    : [0];

  const minVal = hasData ? Math.min(...allTransformed, 0) : -100;
  const maxVal = hasData ? Math.max(...allTransformed, 0) : 100;

  const spanVal = maxVal - minVal || 1;
  const ceiling = maxVal + spanVal * 0.1;
  const floor = minVal - spanVal * 0.1;
  const span = ceiling - floor || 1;

  const getX = (idx: number) => padLeft + (idx / Math.max(1, points.length - 1)) * chartW;
  const getY = (val: number) => padTop + chartH * ((ceiling - transformVal(val)) / span);

  // SVG Paths
  const totalPathD = useMemo(() => {
    if (!hasData) return '';
    return points.reduce((acc, p, idx) => {
      const x = getX(idx);
      const y = getY(p.totalPnl);
      return idx === 0 ? `M ${x} ${y}` : `${acc} L ${x} ${y}`;
    }, '');
  }, [points, hasData, ceiling, span, metricType, balanceInr]);

  const realizedPathD = useMemo(() => {
    if (!hasData) return '';
    return points.reduce((acc, p, idx) => {
      const x = getX(idx);
      const y = getY(p.realized);
      return idx === 0 ? `M ${x} ${y}` : `${acc} L ${x} ${y}`;
    }, '');
  }, [points, hasData, ceiling, span, metricType, balanceInr]);

  const unrealizedPathD = useMemo(() => {
    if (!hasData) return '';
    return points.reduce((acc, p, idx) => {
      const x = getX(idx);
      const y = getY(p.unrealized);
      return idx === 0 ? `M ${x} ${y}` : `${acc} L ${x} ${y}`;
    }, '');
  }, [points, hasData, ceiling, span, metricType, balanceInr]);

  // Gradient area under Total P&L
  const areaPathD = useMemo(() => {
    if (!hasData || points.length === 0) return '';
    const firstX = getX(0);
    const lastX = getX(points.length - 1);
    const zeroY = getY(0);
    return `${totalPathD} L ${lastX} ${zeroY} L ${firstX} ${zeroY} Z`;
  }, [points, totalPathD, hasData, ceiling, span, metricType, balanceInr]);

  const yTicks = [
    { val: ceiling, label: metricType === '% Return' ? `${ceiling.toFixed(1)}%` : formatLakhs(ceiling) },
    { val: ceiling * 0.5, label: metricType === '% Return' ? `${(ceiling * 0.5).toFixed(1)}%` : formatLakhs(ceiling * 0.5) },
    { val: 0, label: '0' },
    { val: floor * 0.5, label: metricType === '% Return' ? `${(floor * 0.5).toFixed(1)}%` : formatLakhs(floor * 0.5) },
    { val: floor, label: metricType === '% Return' ? `${floor.toFixed(1)}%` : formatLakhs(floor) },
  ];

  const activePoint = hasData
    ? hoverIndex !== null && points[hoverIndex]
      ? points[hoverIndex]
      : points[points.length - 1]
    : null;

  return (
    <div className="pnl-panel-card" role="region" aria-label="P&L Curve Chart">
      <div className="pnl-panel-header">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="pnl-panel-title">P&L Curve</h2>

          <div className="pnl-pill-toggle" role="group" aria-label="Curve timeframe">
            {(['Cumulative', 'Daily', 'Weekly', 'Monthly'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`pnl-pill-btn ${viewMode === m ? 'active' : ''}`}
                onClick={() => setViewMode(m)}
              >
                {m}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3 ml-2">
            <span className="pnl-legend-pill">
              <i className="pnl-legend-dot" style={{ background: '#10b981' }} />
              Total P&L
            </span>
            <span className="pnl-legend-pill">
              <i className="pnl-legend-dot" style={{ background: '#0284c7' }} />
              Realized
            </span>
            <span className="pnl-legend-pill">
              <i className="pnl-legend-dot" style={{ background: '#f59e0b' }} />
              Unrealized
            </span>
          </div>
        </div>

        <select
          className="pnl-select"
          aria-label="Metric Type"
          value={metricType}
          onChange={(e) => setMetricType(e.target.value as any)}
        >
          <option value="P&L">P&L</option>
          <option value="% Return">% Return</option>
        </select>
      </div>

      <div className="relative">
        {!hasData ? (
          <div className="pnl-empty">
            No equity curve data in selected date range.
          </div>
        ) : (
          <>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="pnl-chart-svg"
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const relX = (e.clientX - rect.left) * (W / rect.width);
                const clampedX = Math.max(padLeft, Math.min(W - padRight, relX));
                const idx = Math.round(((clampedX - padLeft) / chartW) * (points.length - 1));
                setHoverIndex(idx);
              }}
              onMouseLeave={() => setHoverIndex(null)}
            >
              <defs>
                <linearGradient id="pnlCurveGlow" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
                </linearGradient>
                <filter id="pnlLineGlow" x="-20%" y="-20%" width="140%" height="140%">
                  <feDropShadow dx="0" dy="0" stdDeviation="2" floodColor="#10b981" floodOpacity="0.6" />
                </filter>
              </defs>

              {/* Grid lines and Y labels */}
              {yTicks.map((t, idx) => {
                const y = padTop + chartH * ((ceiling - t.val) / span);
                const isZero = Math.abs(t.val) < 0.001;
                return (
                  <g key={idx}>
                    <line
                      x1={padLeft}
                      y1={y}
                      x2={W - padRight}
                      y2={y}
                      stroke={isZero ? 'rgba(148, 163, 184, 0.4)' : 'rgba(51, 65, 85, 0.25)'}
                      strokeWidth={isZero ? 1.2 : 0.8}
                      strokeDasharray={isZero ? 'none' : '3 3'}
                    />
                    <text
                      x={padLeft - 6}
                      y={y + 3.5}
                      textAnchor="end"
                      fill="#64748b"
                      fontSize="9.5"
                      fontFamily="sans-serif"
                    >
                      {t.label}
                    </text>
                  </g>
                );
              })}

              {/* Area fill under Total P&L */}
              <path d={areaPathD} fill="url(#pnlCurveGlow)" />

              {/* Unrealized line (Amber) */}
              <path
                d={unrealizedPathD}
                fill="none"
                stroke="#f59e0b"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />

              {/* Realized line (Blue) */}
              <path
                d={realizedPathD}
                fill="none"
                stroke="#0284c7"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />

              {/* Total P&L line (Emerald with Glow) */}
              <path
                d={totalPathD}
                fill="none"
                stroke="#10b981"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                filter="url(#pnlLineGlow)"
              />

              {/* Points on curve */}
              {points.map((p, idx) => {
                const step = Math.max(1, Math.floor(points.length / 10));
                if (idx % step !== 0 && idx !== points.length - 1) return null;
                const x = getX(idx);
                const yTot = getY(p.totalPnl);
                const isLast = idx === points.length - 1;
                return (
                  <circle
                    key={idx}
                    cx={x}
                    cy={yTot}
                    r={isLast ? 3.5 : 2}
                    fill="#10b981"
                    stroke="#0d1422"
                    strokeWidth="1.5"
                  />
                );
              })}

              {/* Hover cursor vertical crosshair line */}
              {hoverIndex !== null && (
                <line
                  x1={getX(hoverIndex)}
                  y1={padTop}
                  x2={getX(hoverIndex)}
                  y2={H - padBottom}
                  stroke="rgba(255, 255, 255, 0.4)"
                  strokeWidth="1"
                  strokeDasharray="2 2"
                />
              )}

              {/* X-axis date labels */}
              {points.map((p, i) => {
                const step = Math.max(1, Math.floor(points.length / 7));
                if (i % step !== 0 && i !== points.length - 1) return null;
                const x = getX(i);
                return (
                  <text
                    key={i}
                    x={x}
                    y={H - 8}
                    textAnchor="middle"
                    fill="#94a3b8"
                    fontSize="10"
                    fontFamily="sans-serif"
                  >
                    {p.label}
                  </text>
                );
              })}
            </svg>

            {/* Floating Tooltip Card */}
            {activePoint && (
              <div
                className="pnl-tooltip-box absolute z-10"
                style={{
                  right: hoverIndex !== null && hoverIndex > points.length / 2 ? undefined : '24px',
                  left: hoverIndex !== null && hoverIndex > points.length / 2 ? '65px' : undefined,
                  top: '16px',
                }}
              >
                <div className="font-semibold text-slate-300 mb-1">{activePoint.fullDate}</div>
                <div className="flex items-center justify-between gap-4 py-0.5">
                  <span className="flex items-center gap-1.5 text-slate-400">
                    <i className="pnl-legend-dot" style={{ background: '#10b981' }} />
                    Total P&L
                  </span>
                  <span className="font-bold text-emerald-400 tabular-nums">
                    {metricType === '% Return'
                      ? `${transformVal(activePoint.totalPnl).toFixed(2)}%`
                      : activePoint.totalPnl.toLocaleString('en-IN')}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-4 py-0.5">
                  <span className="flex items-center gap-1.5 text-slate-400">
                    <i className="pnl-legend-dot" style={{ background: '#0284c7' }} />
                    Realized
                  </span>
                  <span className="font-bold text-sky-400 tabular-nums">
                    {metricType === '% Return'
                      ? `${transformVal(activePoint.realized).toFixed(2)}%`
                      : activePoint.realized.toLocaleString('en-IN')}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-4 py-0.5">
                  <span className="flex items-center gap-1.5 text-slate-400">
                    <i className="pnl-legend-dot" style={{ background: '#f59e0b' }} />
                    Unrealized
                  </span>
                  <span className="font-bold text-amber-400 tabular-nums">
                    {metricType === '% Return'
                      ? `${transformVal(activePoint.unrealized).toFixed(2)}%`
                      : activePoint.unrealized.toLocaleString('en-IN')}
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function formatDayLabel(dayStr: string): string {
  try {
    const parts = dayStr.split('-');
    if (parts.length < 3) return dayStr;
    const day = Number(parts[2]);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[Number(parts[1]) - 1] || '';
    return `${day} ${month}`;
  } catch {
    return dayStr;
  }
}

function formatFullDate(dayStr: string): string {
  try {
    const parts = dayStr.split('-');
    if (parts.length < 3) return dayStr;
    const day = Number(parts[2]);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[Number(parts[1]) - 1] || '';
    const year = parts[0];
    return `${day} ${month} ${year}`;
  } catch {
    return dayStr;
  }
}

function formatLakhs(val: number): string {
  if (Math.abs(val) < 1) return '0';
  const isNeg = val < 0;
  const abs = Math.abs(val);
  if (abs >= 100000) {
    const l = (abs / 100000).toFixed(1).replace(/\.0$/, '');
    return `${isNeg ? '-' : ''}${l}L`;
  }
  if (abs >= 1000) {
    const k = (abs / 1000).toFixed(1).replace(/\.0$/, '');
    return `${isNeg ? '-' : ''}${k}K`;
  }
  return String(Math.round(val));
}

function getWeekNumber(d: Date): number {
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  }
  return 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
}
