import { useEffect, useMemo, useRef, useState } from 'react';
import { usePersisted } from '@/hooks/usePersisted';
import type { DayRow } from '@/types/report';
import { byDay, heat, monthsOf, netOf } from '@/lib/report';
import { inr, signedInr, signedUsd, usdToInr } from '@/lib/format';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon } from 'lucide-react';

/**
 * Professional Institutional P&L Calendar.
 *
 * Provides:
 *   - Detailed Grid View (with net P&L numbers, trade indicators, and day numbers)
 *   - Compact Heatmap View (GitHub/Bloomberg style intensity blocks)
 *   - Monthly summaries with Net P&L badges and Win/Loss metrics
 *   - Interactive Day Detail Inspector Card for the selected trading session
 *   - Seamless mobile swipe and desktop responsiveness
 */
const DOW = ['S', 'M', 'T', 'W', 'Th', 'F', 'S'];

export interface PnlCalendarProps {
  rows: DayRow[];
  from: string;
  to: string;
  includeCharges: boolean;
  selected: string | null;
  onSelect: (day: string) => void;
}

export function PnlCalendar({
  rows,
  from,
  to,
  includeCharges,
  selected,
  onSelect,
}: PnlCalendarProps) {
  const [viewMode, setViewMode] = usePersisted<'detailed' | 'compact'>('report:calendar-view', 'detailed');
  const [hoveredDay, setHoveredDay] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const map = useMemo(() => byDay(rows), [rows]);
  const maxAbs = useMemo(
    () => rows.reduce((m, r) => Math.max(m, Math.abs(netOf(r, includeCharges))), 0),
    [rows, includeCharges]
  );
  const months = useMemo(() => monthsOf(from, to), [from, to]);
  // Open on the latest month: on a phone only one fits, and the oldest of a 90-day range is three taps away from today.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [months.length]);

  // Overall statistics for range
  const { totalWinDays, totalLossDays, winRatePct } = useMemo(() => {
    const wins = rows.filter((r) => netOf(r, includeCharges) > 0).length;
    const losses = rows.filter((r) => netOf(r, includeCharges) < 0).length;
    const rate = rows.length > 0 ? ((wins / rows.length) * 100).toFixed(0) : '0';
    return { totalWinDays: wins, totalLossDays: losses, winRatePct: rate };
  }, [rows, includeCharges]);

  // Month-by-month stats
  const monthStats = useMemo(() => {
    const stats = new Map<string, { netUsd: number; wins: number; losses: number; trades: number }>();
    for (const m of months) {
      let netUsd = 0;
      let wins = 0;
      let losses = 0;
      let trades = 0;
      for (const week of m.weeks) {
        for (const day of week) {
          if (!day) continue;
          const r = map.get(day);
          if (r) {
            const net = netOf(r, includeCharges);
            netUsd += net;
            if (net > 0) wins++;
            else if (net < 0) losses++;
            trades += (r.trades || 0);
          }
        }
      }
      stats.set(m.key, { netUsd, wins, losses, trades });
    }
    return stats;
  }, [months, map, includeCharges]);

  // Active inspected day (selected > hovered > latest row)
  const activeDayKey = selected ?? hoveredDay ?? (rows.length > 0 ? rows[rows.length - 1]?.day ?? null : null);
  const activeRow = activeDayKey ? map.get(activeDayKey) : null;
  const activeNetUsd = activeRow ? netOf(activeRow, includeCharges) : null;
  const activeNetInr = activeNetUsd !== null ? (usdToInr(activeNetUsd) ?? 0) : null;

  const scrollMonths = (direction: 'left' | 'right') => {
    if (!scrollRef.current) return;
    const delta = direction === 'left' ? -280 : 280;
    scrollRef.current.scrollBy({ left: delta, behavior: 'smooth' });
  };

  return (
    <div className="pnl-cal-container">
      {/* Calendar Header Toolbar */}
      <div className="pnl-cal-toolbar">
        <div className="flex items-center gap-2">
          <CalendarIcon size={14} className="text-sky-400" aria-hidden />
          <span className="font-semibold text-slate-200 text-xs tracking-wide">P&L CALENDAR</span>
          {rows.length > 0 && (
            <span className="pnl-cal-summary-pill">
              {totalWinDays}W · {totalLossDays}L ({winRatePct}% Win)
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="pnl-pill-toggle" role="group" aria-label="Calendar view mode">
            <button
              type="button"
              className={`pnl-pill-btn ${viewMode === 'detailed' ? 'active' : ''}`}
              onClick={() => setViewMode('detailed')}
            >
              Detailed
            </button>
            <button
              type="button"
              className={`pnl-pill-btn ${viewMode === 'compact' ? 'active' : ''}`}
              onClick={() => setViewMode('compact')}
            >
              Heatmap
            </button>
          </div>

          {months.length > 1 && (
            <div className="flex items-center gap-1 ml-1">
              <button
                type="button"
                className="pnl-cal-nav-btn"
                onClick={() => scrollMonths('left')}
                title="Scroll months left"
                aria-label="Previous month"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                className="pnl-cal-nav-btn"
                onClick={() => scrollMonths('right')}
                title="Scroll months right"
                aria-label="Next month"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* The Calendar Grid Container */}
      <div
        ref={scrollRef}
        className={`pnl-cal ${viewMode === 'detailed' ? 'mode-detailed' : 'mode-compact'}`}
        role="grid"
        aria-label="daily profit and loss"
      >
        {months.map((m) => {
          const mStat = monthStats.get(m.key);
          const mNetInr = mStat && mStat.netUsd !== 0 ? (usdToInr(mStat.netUsd) ?? 0) : 0;
          const mTone = mNetInr > 0 ? 'up' : mNetInr < 0 ? 'down' : 'flat';

          return (
            <div key={m.key} className="pnl-month">
              {/* Monthly Header with Net P&L Badge */}
              <div className="pnl-month-header">
                <span className="pnl-month-label">{m.label}</span>
                {mStat && (mStat.wins > 0 || mStat.losses > 0) && (
                  <span className={`pnl-month-net-badge ${mTone}`}>
                    {signedInr(mNetInr)}
                  </span>
                )}
              </div>

              {/* Day of Week Header */}
              <div className="pnl-dow" aria-hidden>
                {DOW.map((d, i) => (
                  <span key={i}>{d}</span>
                ))}
                {viewMode === 'detailed' && <span className="pnl-dow-wk">Wk</span>}
              </div>

              {/* Weeks & Days */}
              {m.weeks.map((week, wi) => {
                // Calculate week total P&L for detailed view
                let weekNetUsd = 0;
                let hasWeekTrades = false;
                for (const d of week) {
                  if (d && map.has(d)) {
                    hasWeekTrades = true;
                    weekNetUsd += netOf(map.get(d)!, includeCharges);
                  }
                }
                const weekNetInr = hasWeekTrades ? (usdToInr(weekNetUsd) ?? 0) : null;

                return (
                  <div key={wi} className="pnl-week" role="row">
                    {week.map((day, di) => {
                      if (day === null) {
                        return <span key={di} className="pnl-day empty" aria-hidden />;
                      }
                      const row = map.get(day);
                      const net = row ? netOf(row, includeCharges) : null;
                      const tone = net === null ? 'none' : net > 0 ? 'up' : net < 0 ? 'down' : 'flat';
                      const level = net === null ? 0 : heat(net, maxAbs);
                      const netInrVal = net !== null ? (usdToInr(net) ?? 0) : null;
                      const label = row
                        ? `${day}: ${signedInr(netInrVal ?? 0)}, ${row.trades} trade${row.trades === 1 ? '' : 's'}`
                        : `${day}: no trades`;

                      return (
                        <button
                          key={day}
                          type="button"
                          role="gridcell"
                          className={`pnl-day ${tone} l${level}${selected === day ? ' selected' : ''}${
                            hoveredDay === day ? ' hovered' : ''
                          }`}
                          title={label}
                          aria-label={label}
                          aria-selected={selected === day}
                          onMouseEnter={() => setHoveredDay(day)}
                          onMouseLeave={() => setHoveredDay(null)}
                          onClick={() => onSelect(day)}
                        >
                          <span className="pnl-day-n">{Number(day.slice(8))}</span>
                          {viewMode === 'detailed' && netInrVal !== null && (
                            <span className="pnl-day-val">{formatCompactPnl(netInrVal)}</span>
                          )}
                          {viewMode === 'detailed' && row && row.trades > 0 && (
                            <span className="pnl-day-dot" aria-hidden />
                          )}
                        </button>
                      );
                    })}

                    {/* Weekly Column Indicator in Detailed Mode */}
                    {viewMode === 'detailed' && (
                      <div className="pnl-week-total">
                        {weekNetInr !== null ? (
                          <span className={`pnl-week-val ${weekNetInr > 0 ? 'up' : weekNetInr < 0 ? 'down' : ''}`}>
                            {formatCompactPnl(weekNetInr)}
                          </span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Selected / Hovered Day Inspector Card */}
      {activeDayKey && (
        <div className="pnl-day-inspector" role="region" aria-label="Day detail">
          <div className="pnl-inspector-head">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-200">{formatInspectorDate(activeDayKey)}</span>
              {activeRow ? (
                <span className={`pnl-inspector-badge ${activeNetInr && activeNetInr > 0 ? 'up' : activeNetInr && activeNetInr < 0 ? 'down' : 'flat'}`}>
                  {activeNetInr && activeNetInr > 0 ? 'Profit Session' : activeNetInr && activeNetInr < 0 ? 'Loss Session' : 'Flat'}
                </span>
              ) : (
                <span className="pnl-inspector-badge neutral">No Trades Recorded</span>
              )}
            </div>
            <span className="text-[11px] text-slate-400">
              {selected === activeDayKey ? '● Selected for intraday line' : 'Tap to inspect intraday line'}
            </span>
          </div>

          {activeRow && activeNetInr !== null && (
            <div className="pnl-inspector-grid">
              <div className="pnl-inspector-item">
                <span className="pnl-inspector-label">Net P&L</span>
                <span className={`pnl-inspector-val ${activeNetInr > 0 ? 'up' : activeNetInr < 0 ? 'down' : ''}`}>
                  {signedInr(activeNetInr)}
                  <small className="text-slate-400 font-normal ml-1">({signedUsd(activeNetUsd ?? 0)})</small>
                </span>
              </div>

              <div className="pnl-inspector-item">
                <span className="pnl-inspector-label">Gross Realized</span>
                <span className="pnl-inspector-val">
                  {signedInr(usdToInr(activeRow.realisedUsd))}
                </span>
              </div>

              <div className="pnl-inspector-item">
                <span className="pnl-inspector-label">Charges & Fees</span>
                <span className="pnl-inspector-val text-slate-300">
                  −{inr(usdToInr(activeRow.chargesUsd))}
                </span>
              </div>

              <div className="pnl-inspector-item">
                <span className="pnl-inspector-label">Executed Trades</span>
                <span className="pnl-inspector-val text-slate-200">
                  {activeRow.trades} trade{activeRow.trades === 1 ? '' : 's'}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatCompactPnl(val: number): string {
  if (Math.abs(val) < 1) return '₹0';
  const isNeg = val < 0;
  const abs = Math.abs(val);
  if (abs >= 100000) {
    return `${isNeg ? '−' : '+'}${(abs / 100000).toFixed(1)}L`;
  }
  if (abs >= 1000) {
    return `${isNeg ? '−' : '+'}${(abs / 1000).toFixed(1)}k`;
  }
  return `${isNeg ? '−' : '+'}${Math.round(abs)}`;
}

function formatInspectorDate(dayStr: string): string {
  try {
    const parts = dayStr.split('-');
    if (parts.length < 3) return dayStr;
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${daysOfWeek[d.getDay()]}, ${Number(parts[2])} ${months[d.getMonth()]} ${parts[0]}`;
  } catch {
    return dayStr;
  }
}
