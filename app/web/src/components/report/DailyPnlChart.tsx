import { useMemo, useState } from 'react';
import type { DayRow } from '@/types/report';
import { signedInr, usdToInr } from '@/lib/format';

export interface DailyPnlChartProps {
  rows: DayRow[];
}

export function DailyPnlChart({ rows }: DailyPnlChartProps) {
  const [period, setPeriod] = useState<'Daily' | 'Weekly' | 'Monthly'>('Daily');
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Group and map data dynamically strictly from live rows
  const data = useMemo(() => {
    if (!rows || rows.length === 0) return [];

    if (period === 'Daily') {
      return rows.map((r) => {
        const netInr = usdToInr(r.netUsd) ?? 0;
        return {
          key: r.day,
          label: formatDayLabel(r.day),
          fullDate: r.day,
          netInr,
          trades: r.trades || 0,
        };
      });
    }

    if (period === 'Weekly') {
      const weeksMap = new Map<string, { netInr: number; trades: number; lastDay: string }>();
      for (const r of rows) {
        const d = new Date(r.day);
        const weekNum = getWeekNumber(d);
        const weekKey = `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
        const prev = weeksMap.get(weekKey) ?? { netInr: 0, trades: 0, lastDay: r.day };
        weeksMap.set(weekKey, {
          netInr: prev.netInr + (usdToInr(r.netUsd) ?? 0),
          trades: prev.trades + (r.trades || 0),
          lastDay: r.day,
        });
      }
      return [...weeksMap.entries()].map(([k, v]) => ({
        key: k,
        label: `W${k.slice(-2)}`,
        fullDate: `Week of ${v.lastDay}`,
        netInr: v.netInr,
        trades: v.trades,
      }));
    }

    // Monthly
    const monthsMap = new Map<string, { netInr: number; trades: number }>();
    for (const r of rows) {
      const monthKey = r.day.slice(0, 7); // YYYY-MM
      const prev = monthsMap.get(monthKey) ?? { netInr: 0, trades: 0 };
      monthsMap.set(monthKey, {
        netInr: prev.netInr + (usdToInr(r.netUsd) ?? 0),
        trades: prev.trades + (r.trades || 0),
      });
    }
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return [...monthsMap.entries()].map(([k, v]) => {
      const parts = k.split('-');
      const year = parts[0] ?? '';
      const m = parts[1] ?? '01';
      const name = monthNames[Number(m) - 1] ?? m;
      return {
        key: k,
        label: `${name} '${year.slice(-2)}`,
        fullDate: `${name} ${year}`,
        netInr: v.netInr,
        trades: v.trades,
      };
    });
  }, [rows, period]);

  // Total net
  const netTotalInr = data.reduce((sum, d) => sum + d.netInr, 0);

  // SVG Chart Geometry
  const W = 620;
  const H = 210;
  const padLeft = 45;
  const padRight = 15;
  const padTop = 15;
  const padBottom = 30;

  const chartW = W - padLeft - padRight;
  const chartH = H - padTop - padBottom;

  const hasData = data.length > 0;
  const maxVal = hasData ? Math.max(...data.map((d) => d.netInr), 100) : 1000;
  const minVal = hasData ? Math.min(...data.map((d) => d.netInr), -100) : -1000;

  const ceiling = Math.max(100, Math.ceil(maxVal / 50000) * 50000);
  const floor = Math.min(-100, Math.floor(minVal / 50000) * 50000);
  const totalSpan = ceiling - floor || 1;

  const zeroY = padTop + chartH * (ceiling / totalSpan);

  const barGap = 4;
  const totalBars = data.length;
  const barWidth = totalBars > 0 ? Math.max(4, (chartW - (totalBars - 1) * barGap) / totalBars) : 10;

  const yTicks = [
    { val: ceiling, label: formatLakhs(ceiling) },
    { val: ceiling * 0.5, label: formatLakhs(Math.round(ceiling * 0.5)) },
    { val: 0, label: '0' },
    { val: floor * 0.5, label: formatLakhs(Math.round(floor * 0.5)) },
    { val: floor, label: formatLakhs(floor) },
  ];

  return (
    <div className="pnl-panel-card" role="region" aria-label="Daily P&L Chart">
      <div className="pnl-panel-header">
        <div className="flex items-center gap-2">
          <h2 className="pnl-panel-title">Daily P&L</h2>
          <span className={`pnl-daily-badge ${netTotalInr < 0 ? 'text-rose-400 bg-rose-500/10 border-rose-500/20' : ''}`}>
            Net {signedInr(netTotalInr)}
          </span>
        </div>

        <select
          className="pnl-select"
          aria-label="Period selector"
          value={period}
          onChange={(e) => setPeriod(e.target.value as any)}
        >
          <option value="Daily">Daily</option>
          <option value="Weekly">Weekly</option>
          <option value="Monthly">Monthly</option>
        </select>
      </div>

      <div className="relative">
        {!hasData ? (
          <div className="pnl-empty">
            No trading days in selected date range.
          </div>
        ) : (
          <>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="pnl-chart-svg"
              onTouchMove={(e) => {
                const touch = e.touches[0];
                if (!touch) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const relX = (touch.clientX - rect.left) * (W / rect.width);
                const clampedX = Math.max(padLeft, Math.min(W - padRight, relX));
                const idx = Math.min(data.length - 1, Math.max(0, Math.floor((clampedX - padLeft) / (barWidth + barGap))));
                setHoveredIdx(idx);
              }}
              onTouchEnd={() => setHoveredIdx(null)}
            >
              <defs>
                <linearGradient id="pnlGreenBar" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" />
                  <stop offset="100%" stopColor="#059669" />
                </linearGradient>
                <linearGradient id="pnlRedBar" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ef4444" />
                  <stop offset="100%" stopColor="#b91c1c" />
                </linearGradient>
              </defs>

              {/* Grid lines and Y labels */}
              {yTicks.map((t, idx) => {
                const y = padTop + chartH * ((ceiling - t.val) / totalSpan);
                const isZero = t.val === 0;
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

              {/* Bars */}
              {data.map((d, i) => {
                const x = padLeft + i * (barWidth + barGap);
                const isPositive = d.netInr >= 0;
                const barH = Math.max(2, Math.abs(d.netInr / totalSpan) * chartH);
                const y = isPositive ? zeroY - barH : zeroY;
                const isHovered = hoveredIdx === i;

                return (
                  <g
                    key={d.key}
                    className="cursor-pointer transition-opacity"
                    onMouseEnter={() => setHoveredIdx(i)}
                    onMouseLeave={() => setHoveredIdx(null)}
                  >
                    <rect
                      x={x}
                      y={y}
                      width={barWidth}
                      height={barH}
                      rx={2}
                      fill={isPositive ? 'url(#pnlGreenBar)' : 'url(#pnlRedBar)'}
                      opacity={hoveredIdx === null || isHovered ? 1 : 0.45}
                      stroke={isHovered ? '#ffffff' : 'none'}
                      strokeWidth={1}
                    />
                  </g>
                );
              })}

              {/* X-axis labels */}
              {data.map((d, i) => {
                const step = Math.max(1, Math.floor(data.length / 7));
                if (i % step !== 0 && i !== data.length - 1) return null;
                const x = padLeft + i * (barWidth + barGap) + barWidth / 2;
                return (
                  <text
                    key={d.key}
                    x={x}
                    y={H - 8}
                    textAnchor="middle"
                    fill="#94a3b8"
                    fontSize="10"
                    fontFamily="sans-serif"
                  >
                    {d.label}
                  </text>
                );
              })}
            </svg>

            {/* Hover Tooltip Overlay: Clamped percentage-based positioning */}
            {hoveredIdx !== null && data[hoveredIdx] && (() => {
              const item = data[hoveredIdx];
              const pctX = ((padLeft + hoveredIdx * (barWidth + barGap) + barWidth / 2) / W) * 100;
              const clampedPct = Math.min(80, Math.max(20, pctX));
              return (
                <div
                  className="pnl-tooltip-box absolute z-10"
                  style={{
                    left: `${clampedPct}%`,
                    transform: 'translateX(-50%)',
                    top: '8px',
                    maxWidth: 'min(240px, calc(100% - 20px))',
                  }}
                >
                  <div className="font-semibold text-slate-200">{item.fullDate}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-slate-400">Net P&L:</span>
                    <span
                      className={`font-bold tabular-nums ${
                        item.netInr >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {signedInr(item.netInr)}
                    </span>
                  </div>
                  <div className="text-slate-400 text-[10.5px] mt-0.5">
                    Trades: {item.trades}
                  </div>
                </div>
              );
            })()}
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

function formatLakhs(val: number): string {
  if (val === 0) return '0';
  const isNeg = val < 0;
  const abs = Math.abs(val);
  if (abs >= 100000) {
    const l = (abs / 100000).toFixed(0);
    return `${isNeg ? '-' : ''}${l}L`;
  }
  if (abs >= 1000) {
    return `${isNeg ? '-' : ''}${(abs / 1000).toFixed(0)}K`;
  }
  return String(val);
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
