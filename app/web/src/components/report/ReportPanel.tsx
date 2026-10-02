import { useMemo, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { daysCsvUrl, getDays, getMtm } from '@/api/report';
import { getOrderHistory, getTradeStatus } from '@/api/trade';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { Card, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { DayPicker } from '@/components/ui/day-picker';
import { PnlCalendar } from '@/components/report/PnlCalendar';
import { CumulativeChart } from '@/components/report/CumulativeChart';
import { MtmChart } from '@/components/report/MtmChart';
import { PnlKpiCards } from '@/components/report/PnlKpiCards';
import { PerformanceStats } from '@/components/report/PerformanceStats';
import { WinLossAnalysis } from '@/components/report/WinLossAnalysis';
import { DailyPnlChart } from '@/components/report/DailyPnlChart';
import { PnlCurveChart } from '@/components/report/PnlCurveChart';
import { daysAgoIst, netOf, todayIst } from '@/lib/report';
import { inr, signedInr, signedUsd, usdToInr } from '@/lib/format';
import './pnl-dashboard.css';

/**
 * How the trading has actually gone.
 *
 * Professional Institutional P&L Dashboard:
 *   - Top KPI Strip: Total P&L, Realized, Unrealized, Today's, Week, Month, Max Drawdown
 *   - Performance Stats: 12 key trading metrics & expectancy
 *   - Win / Loss: Donut analysis with Count vs P&L views
 *   - Daily P&L: Interactive gradient bars with net badge & period picker
 *   - P&L Curve: Multi-series equity curves with crosshair & tooltip
 *   - Calendar & MTM: Detailed daily calendar and minute-by-minute intraday line
 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function ReportPanel() {
  const [from, setFrom] = usePersisted('report:from', daysAgoIst(90));
  const [to, setTo] = usePersisted('report:to', todayIst());
  const [includeCharges, setIncludeCharges] = usePersisted('report:charges', true);
  const [day, setDay] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const validRange = DAY_RE.test(from) && DAY_RE.test(to) && from <= to;
  const days = usePoll(() => getDays(from, to), 60_000, { enabled: validRange, deps: [from, to] });
  const mtm = usePoll(() => getMtm(day), 60_000, { deps: [day] });
  const tradeStatus = usePoll(() => getTradeStatus().catch(() => null), 15_000);
  const history = usePoll(() => getOrderHistory({ from, to }).catch(() => null), 60_000, { enabled: validRange, deps: [from, to] });

  const rows = days.data?.days ?? [];
  const orders = history.data?.trades ?? [];

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await Promise.allSettled([
        days.refresh(),
        tradeStatus.refresh(),
        history.refresh(),
        mtm.refresh(),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  };

  const totals = useMemo(() => {
    const net = rows.reduce((n, r) => n + netOf(r, includeCharges), 0);
    const wins = rows.filter((r) => netOf(r, includeCharges) > 0).length;
    const best = rows.reduce<typeof rows[number] | null>((a, r) => (a === null || netOf(r, includeCharges) > netOf(a, includeCharges) ? r : a), null);
    const worst = rows.reduce<typeof rows[number] | null>((a, r) => (a === null || netOf(r, includeCharges) < netOf(a, includeCharges) ? r : a), null);
    return { net, wins, best, worst };
  }, [rows, includeCharges]);

  const tone = (n: number | null | undefined) => n == null || n === 0 ? undefined : n > 0 ? 'up' : 'down';

  return (
    <div className="flex flex-col gap-3">
      {/* 1. Primary Controls & Top KPI Cards */}
      <Card>
        <CardTitle
          right={
            <div className="flex items-center gap-2">
              <span className="pnl-live-badge" title="Dynamic live stream from Delta Exchange">
                <span className="pnl-live-dot" /> Live
              </span>
              <button
                type="button"
                className="chain-chip"
                onClick={handleRefresh}
                title="Refresh live metrics"
                disabled={isRefreshing}
              >
                <RefreshCw size={12} className={isRefreshing ? 'animate-spin' : ''} aria-hidden /> Refresh
              </button>
              {validRange && (
                <a className="chain-chip" href={daysCsvUrl(from, to)} download>
                  <Download size={12} aria-hidden /> CSV
                </a>
              )}
            </div>
          }
        >
          Profit and loss
        </CardTitle>

        <div className="report-controls">
          <DateRangePicker
            value={{ from, to }}
            onChange={(r) => { setFrom(r.from); setTo(r.to); }}
          />
          <div className="report-quick" role="group" aria-label="quick ranges">
            {[['7d', 7], ['30d', 30], ['90d', 90], ['1y', 365]].map(([l, n]) => (
              <button
                key={l}
                type="button"
                className={`chain-chip${from === daysAgoIst(n as number) && to === todayIst() ? ' on' : ''}`}
                aria-pressed={from === daysAgoIst(n as number) && to === todayIst()}
                onClick={() => { setFrom(daysAgoIst(n as number)); setTo(todayIst()); }}
              >
                {l}
              </button>
            ))}
          </div>
          <Switch
            className="report-charges"
            label="Include charges"
            description={includeCharges ? "Delta's fees and GST are taken off every day." : 'Before charges — the gross figure.'}
            checked={includeCharges}
            onCheckedChange={setIncludeCharges}
          />
        </div>

        {!validRange && <p className="m-0 mt-2 text-[12px] text-[var(--down)]">The start date must not be after the end date.</p>}
        {days.error && <p className="m-0 mt-2 text-[12px] text-[var(--down)]">{days.error.message}</p>}

        {days.data && rows.length === 0 && (
          <div className="pnl-info-banner mt-2">
            No trade history recorded for this date range. All cards and charts will update dynamically in real time when trades are placed.
          </div>
        )}

        {/* Top 7 KPI Cards Strip */}
        <div className="mt-3">
          <PnlKpiCards
            rows={rows}
            totalsNetUsd={totals.net}
            includeCharges={includeCharges}
            status={tradeStatus.data}
            orders={orders}
          />
        </div>

        {/* Summary Totals Bar (Preserved for accessibility & unit test contracts) */}
        <div className="report-totals" aria-label="totals">
          <Total label={includeCharges ? 'Net' : 'Gross'} value={signedInr(usdToInr(totals.net))} sub={signedUsd(totals.net)} tone={tone(totals.net)} big />
          <Total label="Charges" value={`−${inr(usdToInr(days.data?.totals.chargesUsd ?? 0))}`} sub={`${signedUsd(-(days.data?.totals.chargesUsd ?? 0))}`} />
          <Total label="Days" value={String(rows.length)} sub={`${totals.wins} up · ${rows.length - totals.wins} down`} />
          <Total label="Best day" value={totals.best ? signedInr(usdToInr(netOf(totals.best, includeCharges))) : '—'} sub={totals.best?.day} tone="up" />
          <Total label="Worst day" value={totals.worst ? signedInr(usdToInr(netOf(totals.worst, includeCharges))) : '—'} sub={totals.worst?.day} tone="down" />
        </div>
      </Card>

      {/* 2. Performance Stats & Win/Loss Analysis Row */}
      <div className="pnl-analytics-row">
        <PerformanceStats rows={rows} orders={orders} />
        <WinLossAnalysis rows={rows} orders={orders} />
      </div>

      {/* 3. Daily P&L & P&L Curve Charts Row */}
      <div className="pnl-charts-row">
        <DailyPnlChart rows={rows} />
        <PnlCurveChart rows={rows} status={tradeStatus.data} />
      </div>

      {/* 4. Calendar & Cumulative Progress Card */}
      <Card>
        <CardTitle>Trading Calendar & Running Progress</CardTitle>
        <div className="report-grid">
          <div className="report-cal-wrap">
            <PnlCalendar rows={rows} from={from} to={to} includeCharges={includeCharges} selected={day} onSelect={setDay} />
            <div className="pnl-key">
              <span><i className="pnl-day down l2" /> loss</span>
              <span><i className="pnl-day flat" /> flat</span>
              <span><i className="pnl-day up l2" /> profit</span>
              <span className="dim">tap a day to see its line below · IST days</span>
            </div>
          </div>
          <div className="report-line-wrap">
            <div className="report-sub">Running total</div>
            <CumulativeChart rows={rows} includeCharges={includeCharges} />
          </div>
        </div>
      </Card>

      {/* 5. Intraday Minute-by-Minute MTM Card */}
      <Card>
        <CardTitle
          right={mtm.data && (
            // A calendar of the days that have a line (owner, 2 Oct 2026: "a date picker"), arrows to step
            // through them. Today is held as null, so the line follows the day over midnight.
            <DayPicker
              value={day ?? mtm.data.day}
              available={mtm.data.days}
              onChange={(d) => setDay(d === todayIst() ? null : d)}
            />
          )}
        >
          The day, minute by minute
        </CardTitle>
        {mtm.error && <p className="m-0 text-[12px] text-[var(--down)]">{mtm.error.message}</p>}
        {mtm.data ? <MtmChart report={mtm.data} /> : <div className="pnl-empty">Loading…</div>}
        <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted-foreground">
          Booked, plus what is open at the mark, less Delta's charges — the same number as the header,
          written down once a minute while something is on. Kept for ninety days.
        </p>
      </Card>
    </div>
  );
}

function Total({ label, value, sub, tone, big }: {
  label: string; value: string; sub?: string; tone?: 'up' | 'down'; big?: boolean;
}) {
  return (
    <div className="report-total">
      <span className="report-total-label">{label}</span>
      <b className={`report-total-value${big ? ' big' : ''}${tone ? ` ${tone}` : ''}`}>{value}</b>
      {sub && <small className="report-total-sub">{sub}</small>}
    </div>
  );
}

