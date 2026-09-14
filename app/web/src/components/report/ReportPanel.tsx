import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { daysCsvUrl, getDays, getMtm } from '@/api/report';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { Card, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { PnlCalendar } from '@/components/report/PnlCalendar';
import { CumulativeChart } from '@/components/report/CumulativeChart';
import { MtmChart } from '@/components/report/MtmChart';
import { daysAgoIst, netOf, todayIst } from '@/lib/report';
import { inr, signedInr, signedUsd, usdToInr } from '@/lib/format';

/**
 * How the trading has actually gone.
 *
 * Three views of the same journal, each answering a different question a
 * person asks of it:
 *
 *   the calendar   -- which days made money, which lost it, how big;
 *   the line       -- whether the range is working, day by day;
 *   today's line   -- what the day has done, minute by minute, and the worst
 *                     fall on the way.
 *
 * Every figure is the server's, computed from the fills on the way out, so
 * nothing here can disagree with the journal or with the header. The one
 * choice made here is whether charges are in the numbers; it defaults to on,
 * because the number without them is a number nobody was paid.
 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function ReportPanel() {
  const [from, setFrom] = usePersisted('report:from', daysAgoIst(90));
  const [to, setTo] = usePersisted('report:to', todayIst());
  const [includeCharges, setIncludeCharges] = usePersisted('report:charges', true);
  const [day, setDay] = useState<string | null>(null);

  const validRange = DAY_RE.test(from) && DAY_RE.test(to) && from <= to;
  const days = usePoll(() => getDays(from, to), 60_000, { enabled: validRange, deps: [from, to] });
  const mtm = usePoll(() => getMtm(day), 60_000, { deps: [day] });

  const rows = days.data?.days ?? [];
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
      <Card>
        <CardTitle
          right={validRange && (
            <a className="chain-chip" href={daysCsvUrl(from, to)} download>
              <Download size={12} aria-hidden /> CSV
            </a>
          )}
        >
          Profit and loss
        </CardTitle>

        <div className="report-controls">
          <label className="field">
            <span>From</span>
            <input type="date" value={from} max={to} aria-label="from date" onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" value={to} min={from} max={todayIst()} aria-label="to date" onChange={(e) => setTo(e.target.value)} />
          </label>
          <div className="report-quick" role="group" aria-label="quick ranges">
            {[['7d', 7], ['30d', 30], ['90d', 90], ['1y', 365]].map(([l, n]) => (
              <button key={l} type="button" className="chain-chip" onClick={() => { setFrom(daysAgoIst(n as number)); setTo(todayIst()); }}>
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

        <div className="report-totals" aria-label="totals">
          <Total label={includeCharges ? 'Net' : 'Gross'} value={signedInr(usdToInr(totals.net))} sub={signedUsd(totals.net)} tone={tone(totals.net)} big />
          <Total label="Charges" value={`−${inr(usdToInr(days.data?.totals.chargesUsd ?? 0))}`} sub={`${signedUsd(-(days.data?.totals.chargesUsd ?? 0))}`} />
          <Total label="Days" value={String(rows.length)} sub={`${totals.wins} up · ${rows.length - totals.wins} down`} />
          <Total label="Best day" value={totals.best ? signedInr(usdToInr(netOf(totals.best, includeCharges))) : '—'} sub={totals.best?.day} tone="up" />
          <Total label="Worst day" value={totals.worst ? signedInr(usdToInr(netOf(totals.worst, includeCharges))) : '—'} sub={totals.worst?.day} tone="down" />
        </div>

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

      <Card>
        <CardTitle
          right={mtm.data && mtm.data.days.length > 0 && (
            <select
              className="report-day"
              aria-label="which day"
              value={day ?? mtm.data.day}
              onChange={(e) => setDay(e.target.value === todayIst() ? null : e.target.value)}
            >
              {[...new Set([todayIst(), ...mtm.data.days])].map((d) => (
                <option key={d} value={d}>{d === todayIst() ? `Today · ${d}` : d}</option>
              ))}
            </select>
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
