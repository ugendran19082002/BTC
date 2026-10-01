import { useMemo } from 'react';
import { ArrowDown, ArrowUp, Download, RefreshCw } from 'lucide-react';
import { getMethodReport } from '@/api/entry';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { Card, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { downloadCsv, toCsv } from '@/lib/csv';
import { cn } from '@/lib/utils';
import type { EntryTf, MethodReportRow, MethodReportSection } from '@/types/entry';

/**
 * The Methods report (owner, 1 Oct 2026: "a tab of its own; two sections,
 * 81 + 81: win rate, trades, win, loss, profit, loss, net").
 *
 * Every method's paper record, with the timeframe chain and without it, one
 * line each -- a method that has not traded yet still has its line, so the
 * table always reads 81 and 81. The server adds it up (GET /api/entry/report);
 * this screen sorts, filters and draws it.
 *
 * A trade is a TRADE signal that filled and closed (TGT1, stop or time-out);
 * a win closed above its fill. Points run from the fill to the exit; R is
 * points over the risk to the stop. No fees, no orders: the paper log.
 */

const TFS: readonly EntryTf[] = ['3m', '5m', '15m', '30m', '1h', '4h'];
type SortKey = 'n' | 'trades' | 'winPct' | 'netPts' | 'netR';

const num = (v: number, places = 0) => v.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
const signed = (v: number, places = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v), places)}`;
const toneOf = (v: number) => (v > 0 ? 'text-[var(--up)]' : v < 0 ? 'text-[var(--down)]' : 'text-muted-foreground');
const winText = (w: number | null) => (w === null ? '—' : `${w.toFixed(1)}%`);

/** Sorted by the chosen column; methods without a trade always last, so a sort by win rate is not led by blanks. */
export function sortRows(rows: readonly MethodReportRow[], key: SortKey, asc: boolean): MethodReportRow[] {
  const val = (r: MethodReportRow) => (key === 'winPct' ? r.winPct : r[key]);
  return [...rows].sort((a, b) => {
    if (key !== 'n' && (a.trades === 0) !== (b.trades === 0)) return a.trades === 0 ? 1 : -1;
    const x = val(a) ?? -Infinity, y = val(b) ?? -Infinity;
    return (asc ? x - y : y - x) || (a.n ?? 0) - (b.n ?? 0);
  });
}

export function MethodReport() {
  const [tf, setTf] = usePersisted<EntryTf | 'all'>('methodReport.tf', 'all');
  const [hideEmpty, setHideEmpty] = usePersisted<boolean>('methodReport.hideEmpty', false);
  const [everyGate, setEveryGate] = usePersisted<boolean>('methodReport.everyGate', false);
  const [sort, setSort] = usePersisted<{ key: SortKey; asc: boolean }>('methodReport.sort', { key: 'n', asc: true });
  const { data, error, loading, refresh } = usePoll(() => getMethodReport(tf === 'all' ? null : tf, everyGate), 30_000, { deps: [tf, everyGate] });

  const onSort = (key: SortKey) => setSort(sort.key === key ? { key, asc: !sort.asc } : { key, asc: key === 'n' });

  const download = () => {
    if (!data) return;
    const rows = data.sections.flatMap((s) => [...s.rows, s.total].map((r) => ({ section: s.label, ...r })));
    const csv = toCsv(rows, [
      { header: 'section', value: (r) => r.section },
      { header: 'no', value: (r) => r.n },
      { header: 'method', value: (r) => r.name },
      { header: 'signals', value: (r) => r.signals },
      { header: 'trades', value: (r) => r.trades },
      { header: 'wins', value: (r) => r.wins },
      { header: 'losses', value: (r) => r.losses },
      { header: 'win_pct', value: (r) => (r.winPct === null ? null : Math.round(r.winPct * 10) / 10) },
      { header: 'profit_pts', value: (r) => Math.round(r.profitPts * 10) / 10 },
      { header: 'loss_pts', value: (r) => Math.round(r.lossPts * 10) / 10 },
      { header: 'net_pts', value: (r) => Math.round(r.netPts * 10) / 10 },
      { header: 'profit_r', value: (r) => Math.round(r.profitR * 100) / 100 },
      { header: 'loss_r', value: (r) => Math.round(r.lossR * 100) / 100 },
      { header: 'net_r', value: (r) => Math.round(r.netR * 100) / 100 },
    ]);
    downloadCsv(`methods-report${tf === 'all' ? '' : `-${tf}`}.csv`, csv);
  };

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardTitle right={
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void refresh()} aria-label="Refresh"
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] text-muted-foreground hover:bg-muted">
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden /> Refresh
            </button>
            <button type="button" onClick={download} disabled={!data}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] text-muted-foreground hover:bg-muted disabled:opacity-50">
              <Download className="h-3.5 w-3.5" aria-hidden /> CSV
            </button>
          </div>
        }>Methods report</CardTitle>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div role="group" aria-label="timeframe without the chain" className="inline-flex flex-wrap overflow-hidden rounded-md border border-border text-[12px]">
            {(['all', ...TFS] as const).map((t) => (
              <button key={t} type="button" aria-pressed={tf === t} onClick={() => setTf(t)}
                      className={cn('px-2.5 py-1.5 font-semibold', tf === t ? 'bg-[#2563eb] text-white' : 'text-muted-foreground hover:bg-muted')}>
                {t === 'all' ? 'All timeframes' : t}
              </button>
            ))}
          </div>
          <Switch label="Hide methods with no trades" checked={hideEmpty} onCheckedChange={setHideEmpty} />
          <Switch label="Only signals with every gate on" checked={everyGate} onCheckedChange={setEveryGate}
                  description={everyGate ? 'The rules as designed: gate-off signals left out.' : 'Every signal, as in the signal history.'} />
        </div>
        <p className="m-0 mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
          The paper log: every TRADE signal, filled and closed at TGT1, the stop or the time-out. A win closed above its fill.
          Points from the fill to the exit; R is points over the risk to the stop. Before fees. Every signal counts, as in the
          signal history, unless "Only signals with every gate on" is set. The timeframe applies to the section without the
          chain; with it, the entry is always 5m.
        </p>
        {error && <p role="alert" className="m-0 mt-2 text-[12px] text-[var(--down)]">Could not read the report: {error.message}</p>}
      </Card>

      {!data && !error && <p className="m-0 text-[12px] text-muted-foreground">Loading the report…</p>}
      {data && data.sections.every((s) => s.total.signals === 0) && (
        <p role="status" className="m-0 rounded-md border border-border px-3 py-2 text-[12px] text-muted-foreground">
          No TRADE signals recorded {tf === 'all' ? '' : `on ${tf} `}{everyGate ? 'with every gate on ' : ''}yet -- nothing to add up.
          {everyGate ? ' Turn off "Only signals with every gate on" to count the rest.' : ''}
        </p>
      )}
      {data?.sections.map((s) => (
        <ReportSection key={s.mode} section={s} sort={sort} onSort={onSort} hideEmpty={hideEmpty} />
      ))}
    </div>
  );
}

function ReportSection({ section, sort, onSort, hideEmpty }: {
  section: MethodReportSection;
  sort: { key: SortKey; asc: boolean };
  onSort: (k: SortKey) => void;
  hideEmpty: boolean;
}) {
  const rows = useMemo(
    () => sortRows(hideEmpty ? section.rows.filter((r) => r.trades > 0) : section.rows, sort.key, sort.asc),
    [section.rows, sort.key, sort.asc, hideEmpty],
  );
  const t = section.total;
  const head = (label: string, key?: SortKey, left = false) => (
    <th scope="col" aria-sort={key && sort.key === key ? (sort.asc ? 'ascending' : 'descending') : undefined}
        className={cn('sticky top-0 z-[1] whitespace-nowrap bg-[var(--panel)] px-2 py-1.5 font-semibold text-muted-foreground', left ? 'text-left' : 'text-right')}>
      {key ? (
        <button type="button" onClick={() => onSort(key)}
                className="inline-flex items-center gap-0.5 [font:inherit] [letter-spacing:inherit] [text-transform:inherit] hover:text-foreground">
          {label}
          {sort.key === key && (sort.asc ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
        </button>
      ) : label}
    </th>
  );
  const line = (r: MethodReportRow, total = false) => (
    <tr key={total ? 'total' : r.method} className={cn('border-t border-border', total ? 'font-semibold' : r.trades === 0 && 'text-muted-foreground')}>
      <td className="px-2 py-1 text-right tabular-nums">{r.n ?? ''}</td>
      <td className="max-w-[16rem] truncate px-2 py-1 text-left" title={r.name}>{r.name}</td>
      <td className="px-2 py-1 text-right tabular-nums">{num(r.signals)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{num(r.trades)}</td>
      <td className="px-2 py-1 text-right tabular-nums text-[var(--up)]">{num(r.wins)}</td>
      <td className="px-2 py-1 text-right tabular-nums text-[var(--down)]">{num(r.losses)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{winText(r.winPct)}</td>
      <td className="px-2 py-1 text-right tabular-nums text-[var(--up)]">{num(r.profitPts)}</td>
      <td className="px-2 py-1 text-right tabular-nums text-[var(--down)]">{num(r.lossPts)}</td>
      <td className={cn('px-2 py-1 text-right tabular-nums', toneOf(r.netPts))}>{signed(r.netPts)}</td>
      <td className={cn('px-2 py-1 text-right tabular-nums', toneOf(r.netR))}>{signed(r.netR, 2)}R</td>
    </tr>
  );

  return (
    <section aria-label={section.label}>
      <Card>
        <CardTitle right={
          <span className="text-[11px] text-muted-foreground">
            {section.rows.length} methods{section.gatesOffSignals > 0 ? ` · ${num(section.gatesOffSignals)} signals taken with a gate off` : ''}
          </span>
        }>
          {section.mode === 'mtf' ? '1' : '2'}. {section.label}
        </CardTitle>
        <dl className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Kpi label="Trades" value={num(t.trades)} />
          <Kpi label="Wins / losses" value={<><span className="text-[var(--up)]">{num(t.wins)}</span> / <span className="text-[var(--down)]">{num(t.losses)}</span></>} />
          <Kpi label="Win rate" value={winText(t.winPct)} />
          <Kpi label="Net points" value={<span className={toneOf(t.netPts)}>{signed(t.netPts)}</span>} />
          <Kpi label="Net R" value={<span className={toneOf(t.netR)}>{signed(t.netR, 2)}R</span>} />
        </dl>
        <div className="max-h-[70vh] overflow-auto rounded-md border border-border">
          <table className="w-full min-w-[760px] border-collapse text-[12px]">
            <thead>
              <tr>
                {head('#', 'n')}{head('Method', undefined, true)}{head('Signals')}{head('Trades', 'trades')}
                {head('Wins')}{head('Losses')}{head('Win %', 'winPct')}{head('Profit pts')}{head('Loss pts')}
                {head('Net pts', 'netPts')}{head('Net R', 'netR')}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => line(r))}
              {rows.length === 0 && (
                <tr><td colSpan={11} className="px-2 py-3 text-center text-muted-foreground">No closed trades yet.</td></tr>
              )}
            </tbody>
            <tfoot className="bg-[var(--panel)]">{line(t, true)}</tfoot>
          </table>
        </div>
      </Card>
    </section>
  );
}

function Kpi({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border px-2.5 py-1.5">
      <dt className="text-[10.5px] uppercase tracking-[0.6px] text-muted-foreground">{label}</dt>
      <dd className="m-0 text-[15px] font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
