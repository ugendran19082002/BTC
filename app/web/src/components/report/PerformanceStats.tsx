import { useMemo } from 'react';
import { FoldButton, useFold } from '@/components/ui/fold';
import { usePersisted } from '@/hooks/usePersisted';
import type { DayRow } from '@/types/report';
import type { OrderRecord } from '@/types/trade';
import { signedInr, usdToInr } from '@/lib/format';

type StatsFilter = 'All Trades' | 'Strategy Trades' | 'Manual Trades';

export interface PerformanceStatsProps {
  rows: DayRow[];
  orders?: OrderRecord[];
}

export function PerformanceStats({ rows, orders = [] }: PerformanceStatsProps) {
  const [open, setOpen] = useFold('pnl-stats');
  const [filter, setFilter] = usePersisted<StatsFilter>('report:stats-filter', 'All Trades');

  // Filter orders dynamically based on user choice
  const filteredOrders = useMemo(() => {
    if (!orders || orders.length === 0) return [];
    if (filter === 'Strategy Trades') {
      // A strategy's trade by its origin, or -- on a record from before the field -- by the strategy it names.
      // Typed (6 Oct 2026): through `as any` this read `o.strategyId`, which orders do not have.
      return orders.filter((o) => o.plan?.origin === 'strategy' || Boolean(o.plan?.strategyId));
    }
    if (filter === 'Manual Trades') {
      return orders.filter((o) => (o.plan?.origin ?? (o.plan?.strategyId ? 'strategy' : 'manual')) === 'manual');
    }
    return orders;
  }, [orders, filter]);

  const stats = useMemo(() => {
    // If a specific filter is selected (Strategy or Manual Trades)
    if (filter !== 'All Trades') {
      if (filteredOrders.length === 0) {
        return {
          totalTrades: 0,
          winRate: '0%',
          avgR: '—',
          expectancy: '₹0',
          largestWin: '—',
          largestLoss: '—',
          avgHolding: '—',
          maxConsecutiveWins: 0,
          maxConsecutiveLosses: 0,
          sharpe: '—',
          calmar: '—',
          profitFactor: '—',
        };
      }
    }

    // Priority 1: Compute from individual orders if available
    if (filteredOrders.length > 0) {
      const completed = filteredOrders.filter((o) => o.status === 'completed' || o.position === 0);
      const totalTrades = completed.length;

      const wins = completed.filter((o) => (o.netRealisedUsd ?? o.realisedPnl) > 0);
      const losses = completed.filter((o) => (o.netRealisedUsd ?? o.realisedPnl) < 0);

      const winRateVal = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
      const winRate = totalTrades > 0 ? `${winRateVal.toFixed(1)}%` : '0%';

      const grossWinsUsd = wins.reduce((sum, o) => sum + (o.netRealisedUsd ?? o.realisedPnl), 0);
      const grossLossesUsd = Math.abs(losses.reduce((sum, o) => sum + (o.netRealisedUsd ?? o.realisedPnl), 0));
      const pfVal = grossLossesUsd > 0 ? (grossWinsUsd / grossLossesUsd).toFixed(2) : grossWinsUsd > 0 ? '∞' : '—';

      // Largest win & loss
      const bestTrade = completed.reduce((max, o) => {
        const val = o.netRealisedUsd ?? o.realisedPnl;
        return val > max ? val : max;
      }, 0);
      const worstTrade = completed.reduce((min, o) => {
        const val = o.netRealisedUsd ?? o.realisedPnl;
        return val < min ? val : min;
      }, 0);

      const largestWin = bestTrade > 0 ? signedInr(usdToInr(bestTrade)) : '—';
      const largestLoss = worstTrade < 0 ? signedInr(usdToInr(worstTrade)) : '—';

      // Expectancy
      const avgWinUsd = wins.length > 0 ? grossWinsUsd / wins.length : 0;
      const avgLossUsd = losses.length > 0 ? grossLossesUsd / losses.length : 0;
      const winProb = totalTrades > 0 ? wins.length / totalTrades : 0;
      const lossProb = totalTrades > 0 ? losses.length / totalTrades : 0;
      const expUsd = (winProb * avgWinUsd) - (lossProb * avgLossUsd);
      const expectancy = expUsd !== 0 ? signedInr(usdToInr(expUsd)) : '₹0';

      // Average holding duration
      let totalHoldingMs = 0;
      let holdingCount = 0;
      for (const o of completed) {
        if (o.fills && o.fills.length >= 2) {
          const start = Math.min(...o.fills.map((f) => f.ts));
          const end = Math.max(...o.fills.map((f) => f.ts));
          if (end > start) {
            totalHoldingMs += (end - start);
            holdingCount++;
          }
        }
      }
      const avgHolding = holdingCount > 0 ? formatDurationMs(totalHoldingMs / holdingCount) : '—';

      // Consecutive streaks
      let maxWins = 0;
      let curWins = 0;
      let maxLosses = 0;
      let curLosses = 0;
      const sorted = [...completed].sort((a, b) => a.openedAt - b.openedAt);
      for (const o of sorted) {
        const pnl = o.netRealisedUsd ?? o.realisedPnl;
        if (pnl > 0) {
          curWins++;
          curLosses = 0;
          if (curWins > maxWins) maxWins = curWins;
        } else if (pnl < 0) {
          curLosses++;
          curWins = 0;
          if (curLosses > maxLosses) maxLosses = curLosses;
        }
      }

      // Sharpe & Calmar from daily returns
      const dailyReturns = rows.map((r) => r.netUsd);
      const { sharpe, calmar } = computeRatios(dailyReturns);

      return {
        totalTrades,
        winRate,
        avgR: totalTrades > 0 && losses.length > 0 ? (avgWinUsd / Math.max(0.01, avgLossUsd)).toFixed(2) : '—',
        expectancy,
        largestWin,
        largestLoss,
        avgHolding,
        maxConsecutiveWins: maxWins,
        maxConsecutiveLosses: maxLosses,
        sharpe,
        calmar,
        profitFactor: pfVal,
      };
    }

    // Priority 2: Compute strictly from day rows
    if (rows.length === 0) {
      return {
        totalTrades: 0,
        winRate: '0%',
        avgR: '—',
        expectancy: '₹0',
        largestWin: '—',
        largestLoss: '—',
        avgHolding: '—',
        maxConsecutiveWins: 0,
        maxConsecutiveLosses: 0,
        sharpe: '—',
        calmar: '—',
        profitFactor: '—',
      };
    }

    const totalTrades = rows.reduce((acc, r) => acc + (r.trades || 0), 0);
    const winDays = rows.filter((r) => r.netUsd > 0);
    const lossDays = rows.filter((r) => r.netUsd < 0);
    const winRateVal = rows.length > 0 ? (winDays.length / rows.length) * 100 : 0;
    const winRate = rows.length > 0 ? `${winRateVal.toFixed(1)}%` : '0%';

    const grossWinsUsd = winDays.reduce((acc, r) => acc + r.netUsd, 0);
    const grossLossesUsd = Math.abs(lossDays.reduce((acc, r) => acc + r.netUsd, 0));
    const profitFactor = grossLossesUsd > 0 ? (grossWinsUsd / grossLossesUsd).toFixed(2) : grossWinsUsd > 0 ? '∞' : '—';

    const bestDay = rows.reduce((max, r) => (r.netUsd > max ? r.netUsd : max), 0);
    const worstDay = rows.reduce((min, r) => (r.netUsd < min ? r.netUsd : min), 0);
    const largestWin = bestDay > 0 ? signedInr(usdToInr(bestDay)) : '—';
    const largestLoss = worstDay < 0 ? signedInr(usdToInr(worstDay)) : '—';

    // Expectancy
    const avgWinInr = winDays.length > 0 ? (usdToInr(grossWinsUsd) ?? 0) / winDays.length : 0;
    const avgLossInr = lossDays.length > 0 ? (usdToInr(grossLossesUsd) ?? 0) / lossDays.length : 0;
    const winProb = rows.length > 0 ? winDays.length / rows.length : 0;
    const lossProb = rows.length > 0 ? lossDays.length / rows.length : 0;
    const expectancyVal = (winProb * avgWinInr) - (lossProb * avgLossInr);
    const expectancy = expectancyVal !== 0 ? signedInr(expectancyVal) : '₹0';

    // Consecutive streaks from rows
    let maxWins = 0;
    let curWins = 0;
    let maxLosses = 0;
    let curLosses = 0;
    for (const r of rows) {
      if (r.netUsd > 0) {
        curWins++;
        curLosses = 0;
        if (curWins > maxWins) maxWins = curWins;
      } else if (r.netUsd < 0) {
        curLosses++;
        curWins = 0;
        if (curLosses > maxLosses) maxLosses = curLosses;
      }
    }

    const dailyReturns = rows.map((r) => r.netUsd);
    const { sharpe, calmar } = computeRatios(dailyReturns);

    return {
      totalTrades,
      winRate,
      avgR: winDays.length > 0 && lossDays.length > 0 ? (avgWinInr / Math.max(1, avgLossInr)).toFixed(2) : '—',
      expectancy,
      largestWin,
      largestLoss,
      avgHolding: '—',
      maxConsecutiveWins: maxWins,
      maxConsecutiveLosses: maxLosses,
      sharpe,
      calmar,
      profitFactor,
    };
  }, [rows, filteredOrders, filter]);

  return (
    <div className="pnl-panel-card fold-host" data-folded={!open} role="region" aria-label="Performance Stats">
      <div className="pnl-panel-header fold-head">
        <span className="inline-flex items-center gap-1"><FoldButton open={open} onToggle={() => setOpen(!open)} label="Performance Stats" /><h2 className="pnl-panel-title">Performance Stats</h2></span>
        <select
          className="pnl-select"
          aria-label="Filter trades"
          value={filter}
          onChange={(e) => setFilter(e.target.value as StatsFilter)}
        >
          <option value="All Trades">All Trades</option>
          <option value="Strategy Trades">Strategy Trades</option>
          <option value="Manual Trades">Manual Trades</option>
        </select>
      </div>

      <div className="pnl-perf-grid">
        <div className="pnl-perf-tile">
          <div className="pnl-perf-label">Total trades</div>
          <div className="pnl-perf-val">{stats.totalTrades}</div>
        </div>

        <div className="pnl-perf-tile">
          <div className="pnl-perf-label">Win rate</div>
          <div className="pnl-perf-val up">{stats.winRate}</div>
        </div>

        <div className="pnl-perf-tile">
          <div className="pnl-perf-label">Avg R</div>
          <div className="pnl-perf-val">{stats.avgR}</div>
        </div>

        <div className="pnl-perf-tile">
          <div className="pnl-perf-label">Expectancy</div>
          <div className="pnl-perf-val up">{stats.expectancy}</div>
        </div>

        <div className="pnl-perf-tile">
          <div className="pnl-perf-label">Largest win</div>
          <div className="pnl-perf-val up">{stats.largestWin}</div>
        </div>

        <div className="pnl-perf-tile">
          <div className="pnl-perf-label">Largest loss</div>
          <div className="pnl-perf-val down">{stats.largestLoss}</div>
        </div>

        <div className="pnl-perf-tile">
          <div className="pnl-perf-label">Avg holding</div>
          <div className="pnl-perf-val">{stats.avgHolding}</div>
        </div>

        <div className="pnl-perf-tile">
          <div className="pnl-perf-label">Max consecutive wins</div>
          <div className="pnl-perf-val">{stats.maxConsecutiveWins}</div>
        </div>

        <div className="pnl-perf-tile">
          <div className="pnl-perf-label">Max consecutive losses</div>
          <div className="pnl-perf-val">{stats.maxConsecutiveLosses}</div>
        </div>

        <div className="pnl-perf-tile">
          <div className="pnl-perf-label">Sharpe</div>
          <div className="pnl-perf-val">{stats.sharpe}</div>
        </div>

        <div className="pnl-perf-tile">
          <div className="pnl-perf-label">Calmar</div>
          <div className="pnl-perf-val">{stats.calmar}</div>
        </div>

        <div className="pnl-perf-tile">
          <div className="pnl-perf-label">Profit factor</div>
          <div className="pnl-perf-val">{stats.profitFactor}</div>
        </div>
      </div>
    </div>
  );
}

function computeRatios(dailyReturns: number[]): { sharpe: string; calmar: string } {
  if (dailyReturns.length < 2) return { sharpe: '—', calmar: '—' };

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (dailyReturns.length - 1);
  const sd = Math.sqrt(variance);
  const sharpeVal = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;

  // Calmar: annualized return / max drawdown
  let peak = 0;
  let maxDd = 0;
  let run = 0;
  for (const r of dailyReturns) {
    run += r;
    if (run > peak) peak = run;
    if (peak - run > maxDd) maxDd = peak - run;
  }
  const annualized = mean * 252;
  const calmarVal = maxDd > 0 ? annualized / maxDd : 0;

  return {
    sharpe: sharpeVal > 0 ? sharpeVal.toFixed(2) : '—',
    calmar: calmarVal > 0 ? calmarVal.toFixed(2) : '—',
  };
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalMin = Math.round(ms / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
