import { useMemo, useRef } from 'react';
import { ArrowDown, ArrowUp, Download, RefreshCw } from 'lucide-react';
import { getMethodReport } from '@/api/entry';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { Card, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { downloadCsv, toCsv } from '@/lib/csv';
import { cn } from '@/lib/utils';
import type { EntryTf, MethodReportResponse, MethodReportRow, MethodReportSection } from '@/types/entry';

/**
 * The Methods report (owner, 1 Oct 2026: "a tab of its own; two sections,
 * 81 + 81: win rate, trades, win, loss, profit, loss, net").
 *
 * Every method's paper record, with the timeframe chain and without it, one
 * line each -- a method that has not traded yet still has its line, so the
 * table always reads 81 and 81. Without the chain the methods read on six
 * timeframes, so that section has a tab each and All ("timeframe-based, a tab
 * each, All"), with All comparing the timeframes side by side. The server adds
 * it all up in one request (GET /api/entry/report); this screen sorts, filters
 * and draws it, and a tab change asks the server for nothing.
 *
 * A trade is a TRADE signal that filled and closed (TGT1, stop or time-out);
 * a win closed above its fill. Points run from the fill to the exit; R is
 * points over the risk to the stop. No fees, no orders: the paper log.
 */

export const TFS: readonly EntryTf[] = ['3m', '5m', '15m', '30m', '1h', '4h'];
type TfTab = EntryTf | 'all';
type SortKey = 'n' | 'trades' | 'winPct' | 'netPts' | 'netR';
type Sort = { key: SortKey; asc: boolean };

const num = (v: number, places = 0) => v.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
const signed = (v: number, places = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v), places)}`;
const toneOf = (v: number) => (v > 0 ? 'text-[var(--up)]' : v < 0 ? 'text-[var(--down)]' : 'text-muted-foreground');
const winText = (w: number | null) => (w === null ? '—' : `${w.toFixed(1)}%`);
const tabName = (t: TfTab) => (t === 'all' ? 'All' : t);

/** Sorted by the chosen column; methods without a trade always last, so a sort by win rate is not led by blanks. */
export function sortRows(rows: readonly MethodReportRow[], key: SortKey, asc: boolean): MethodReportRow[] {
  const val = (r: MethodReportRow) => (key === 'winPct' ? r.winPct : r[key]);
  return [...rows].sort((a, b) => {
    if (key !== 'n' && (a.trades === 0) !== (b.trades === 0)) return a.trades === 0 ? 1 : -1;
    const x = val(a) ?? -Infinity, y = val(b) ?? -Infinity;
    return (asc ? x - y : y - x) || (a.n ?? 0) - (b.n ?? 0);
  });
}

/** Every line of the report as a spreadsheet: each section, and each timeframe without the chain. */
export function reportCsv(data: MethodReportResponse): string {
  const [mtf, all] = data.sections;
  const parts: { section: string; tf: string; s: MethodReportSection | undefined }[] = [
    { section: mtf?.label ?? 'With the timeframe chain', tf: '5m', s: mtf },
    { section: all?.label ?? 'Without the timeframe chain', tf: 'all', s: all },
    ...TFS.map((tf) => ({ section: all?.label ?? 'Without the timeframe chain', tf, s: data.singleByTf?.[tf] })),
  ];
  const rows = parts.flatMap((p) => (p.s ? [...p.s.rows, p.s.total] : []).map((r) => ({ section: p.section, tf: p.tf, ...r })));
  return toCsv(rows, [
    { header: 'section', value: (r) => r.section },
    { header: 'timeframe', value: (r) => r.tf },
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
}

export function MethodReport() {
  const [tfTab, setTfTab] = usePersisted<TfTab>('methodReport.tfTab', 'all');
  const [hideEmpty, setHideEmpty] = usePersisted<boolean>('methodReport.hideEmpty', false);
  const [everyGate, setEveryGate] = usePersisted<boolean>('methodReport.everyGate', false);
  const [sort, setSort] = usePersisted<Sort>('methodReport.sort', { key: 'n', asc: true });
  // Every timeframe in one answer: a tab change draws, it does not fetch.
  const { data, error, loading, refresh } = usePoll(() => getMethodReport(null, everyGate), 30_000, { deps: [everyGate] });

  const onSort = (key: SortKey) => setSort(sort.key === key ? { key, asc: !sort.asc } : { key, asc: key === 'n' });
  const tab: TfTab = tfTab === 'all' || TFS.includes(tfTab) ? tfTab : 'all';
  const [mtf, singleAll] = data?.sections ?? [];
  const single = tab === 'all' ? singleAll : data?.singleByTf?.[tab] ?? singleAll;

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardTitle right={
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void refresh()} aria-label="Refresh"
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] text-muted-foreground hover:bg-muted">
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden /> Refresh
            </button>
            <button type="button" onClick={() => data && downloadCsv('methods-report.csv', reportCsv(data))} disabled={!data}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] text-muted-foreground hover:bg-muted disabled:opacity-50">
              <Download className="h-3.5 w-3.5" aria-hidden /> CSV
            </button>
          </div>
        }>Methods report</CardTitle>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Switch label="Hide methods with no trades" checked={hideEmpty} onCheckedChange={setHideEmpty} />
          <Switch label="Only signals with every gate on" checked={everyGate} onCheckedChange={setEveryGate}
                  description={everyGate ? 'The rules as designed: gate-off signals left out.' : 'Every signal, as in the signal history.'} />
        </div>
        <p className="m-0 mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
          The paper log: every TRADE signal, filled and closed at TGT1, the stop or the time-out. A win closed above its fill.
          Points from the fill to the exit; R is points over the risk to the stop. Before fees. Every signal counts, as in the
          signal history, unless "Only signals with every gate on" is set. With the chain the entry is always 5m; without it,
          each timeframe has its own tab.
        </p>
        {error && <p role="alert" className="m-0 mt-2 text-[12px] text-[var(--down)]">Could not read the report: {error.message}</p>}
      </Card>

      {!data && !error && <p className="m-0 text-[12px] text-muted-foreground">Loading the report…</p>}
      {data && data.sections.every((s) => s.total.signals === 0) && (
        <p role="status" className="m-0 rounded-md border border-border px-3 py-2 text-[12px] text-muted-foreground">
          No TRADE signals recorded {everyGate ? 'with every gate on ' : ''}yet -- nothing to add up.
          {everyGate ? ' Turn off "Only signals with every gate on" to count the rest.' : ''}
        </p>
      )}
      {mtf && <ReportSection number={1} section={mtf} sort={sort} onSort={onSort} hideEmpty={hideEmpty} />}
      {single && singleAll && (
        <ReportSection
          number={2} section={single} sort={sort} onSort={onSort} hideEmpty={hideEmpty}
          tabs={<TimeframeTabs value={tab} onChange={setTfTab} counts={data!.singleByTf} all={singleAll} />}
          panelOf={tab}
          above={tab === 'all' ? <ByTimeframe byTf={data!.singleByTf} all={singleAll} onOpen={setTfTab} /> : null}
        />
      )}
    </div>
  );
}

/**
 * The timeframe tabs of the section without the chain: All, then each timeframe,
 * each with its trade count. A WAI-ARIA tab list -- arrows, Home and End move
 * between tabs, and only the chosen tab is in the Tab order.
 */
function TimeframeTabs({ value, onChange, counts, all }: {
  value: TfTab;
  onChange: (t: TfTab) => void;
  counts: Partial<Record<EntryTf, MethodReportSection>>;
  all: MethodReportSection;
}) {
  const tabs: readonly TfTab[] = ['all', ...TFS];
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const go = (i: number) => {
    const t = tabs[(i + tabs.length) % tabs.length]!;
    onChange(t);
    refs.current[tabs.indexOf(t)]?.focus();
  };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    go(to);
  };
  return (
    <div role="tablist" aria-label="Timeframe" className="mb-3 flex flex-wrap gap-1 border-b border-border">
      {tabs.map((t, i) => {
        const on = t === value;
        const trades = (t === 'all' ? all : counts[t])?.total.trades ?? 0;
        return (
          <button key={t} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" id={`mr-tab-${t}`}
                  aria-selected={on} aria-controls={`mr-panel-${t}`} tabIndex={on ? 0 : -1}
                  onClick={() => onChange(t)} onKeyDown={(e) => onKey(e, i)}
                  className={cn('-mb-px inline-flex items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-[12px] font-semibold',
                    on ? 'border-border bg-[var(--panel)] text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {tabName(t)}
            <span aria-label={`${trades} trades`}
                  className={cn('rounded-full px-1.5 text-[10.5px] tabular-nums', on ? 'bg-[#2563eb] text-white' : 'bg-muted text-muted-foreground')}>
              {num(trades)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** All, side by side: each timeframe's totals, so which one works is one look -- a row opens its tab. */
function ByTimeframe({ byTf, all, onOpen }: {
  byTf: Partial<Record<EntryTf, MethodReportSection>>;
  all: MethodReportSection;
  onOpen: (t: EntryTf) => void;
}) {
  const lines = TFS.map((tf) => ({ tf, t: byTf[tf]?.total })).filter((x): x is { tf: EntryTf; t: MethodReportRow } => !!x.t);
  const best = lines.filter((x) => x.t.trades > 0).sort((a, b) => b.t.netR - a.t.netR)[0]?.tf ?? null;
  const cell = 'px-2 py-1 text-right tabular-nums';
  return (
    <div className="mb-3 overflow-x-auto rounded-md border border-border">
      <table aria-label="By timeframe" className="w-full min-w-[620px] border-collapse text-[12px]">
        <thead>
          <tr className="text-muted-foreground">
            {['Timeframe', 'Signals', 'Trades', 'Wins', 'Losses', 'Win %', 'Net pts', 'Net R'].map((h, i) => (
              <th key={h} scope="col" className={cn('whitespace-nowrap px-2 py-1.5 font-semibold', i === 0 ? 'text-left' : 'text-right')}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map(({ tf, t }) => (
            <tr key={tf} className={cn('border-t border-border', t.trades === 0 && 'text-muted-foreground')}>
              <td className="px-2 py-1 text-left">
                <button type="button" onClick={() => onOpen(tf)} className="font-semibold underline-offset-2 hover:underline">
                  {tf}
                </button>
                {tf === best && <span className="ml-1.5 rounded bg-[var(--up)]/15 px-1 text-[10px] font-semibold text-[var(--up)]">best net R</span>}
              </td>
              <td className={cell}>{num(t.signals)}</td>
              <td className={cell}>{num(t.trades)}</td>
              <td className={cn(cell, 'text-[var(--up)]')}>{num(t.wins)}</td>
              <td className={cn(cell, 'text-[var(--down)]')}>{num(t.losses)}</td>
              <td className={cell}>{winText(t.winPct)}</td>
              <td className={cn(cell, toneOf(t.netPts))}>{signed(t.netPts)}</td>
              <td className={cn(cell, toneOf(t.netR))}>{signed(t.netR, 2)}R</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border font-semibold">
            <td className="px-2 py-1 text-left">All</td>
            <td className={cell}>{num(all.total.signals)}</td>
            <td className={cell}>{num(all.total.trades)}</td>
            <td className={cn(cell, 'text-[var(--up)]')}>{num(all.total.wins)}</td>
            <td className={cn(cell, 'text-[var(--down)]')}>{num(all.total.losses)}</td>
            <td className={cell}>{winText(all.total.winPct)}</td>
            <td className={cn(cell, toneOf(all.total.netPts))}>{signed(all.total.netPts)}</td>
            <td className={cn(cell, toneOf(all.total.netR))}>{signed(all.total.netR, 2)}R</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ReportSection({ number, section, sort, onSort, hideEmpty, tabs, panelOf, above }: {
  number: number;
  section: MethodReportSection;
  sort: Sort;
  onSort: (k: SortKey) => void;
  hideEmpty: boolean;
  /** The section's tab list, when it has one; `panelOf` names the tab its body belongs to. */
  tabs?: React.ReactNode;
  panelOf?: TfTab;
  /** Drawn above the summary, inside the tab's panel (the timeframe comparison on All). */
  above?: React.ReactNode;
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
  const body = (
    <>
      {above}
      <dl className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Kpi label="Trades" value={num(t.trades)} />
        <Kpi label="Wins / losses" value={<><span className="text-[var(--up)]">{num(t.wins)}</span> / <span className="text-[var(--down)]">{num(t.losses)}</span></>} />
        <Kpi label="Win rate" value={winText(t.winPct)} />
        <Kpi label="Net points" value={<span className={toneOf(t.netPts)}>{signed(t.netPts)}</span>} />
        <Kpi label="Net R" value={<span className={toneOf(t.netR)}>{signed(t.netR, 2)}R</span>} />
      </dl>
      <div className="max-h-[70vh] overflow-auto rounded-md border border-border">
        <table aria-label={`${section.label}${panelOf ? `, ${tabName(panelOf)}` : ''}`} className="w-full min-w-[760px] border-collapse text-[12px]">
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
    </>
  );

  return (
    <section aria-label={section.label}>
      <Card>
        <CardTitle right={
          <span className="text-[11px] text-muted-foreground">
            {section.rows.length} methods{section.gatesOffSignals > 0 ? ` · ${num(section.gatesOffSignals)} signals taken with a gate off` : ''}
          </span>
        }>
          {number}. {section.label}
        </CardTitle>
        {tabs}
        {panelOf ? (
          <div role="tabpanel" id={`mr-panel-${panelOf}`} aria-labelledby={`mr-tab-${panelOf}`}>{body}</div>
        ) : body}
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
