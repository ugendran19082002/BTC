import { useMemo, useRef } from 'react';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { ArrowDown, ArrowUp, Download, RefreshCw } from 'lucide-react';
import { getMethodReport } from '@/api/entry';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { Switch } from '@/components/ui/switch';
import { DateRangePicker, describeRange, istToday, type DateRangeValue } from '@/components/ui/date-range-picker';
import { TimePicker } from '@/components/ui/time-picker';
import { time12 } from '@/lib/time';
import { downloadCsv, toCsv } from '@/lib/csv';
import { cn } from '@/lib/utils';
import type { EntryMode, EntryTf, MethodReportResponse, MethodReportRow, MethodReportSection } from '@/types/entry';

/**
 * The Methods report (owner, 1 Oct 2026: "a tab of its own; two sections,
 * 81 + 81: win rate, trades, win, loss, profit, loss, net").
 *
 * Every method's paper record, with the timeframe chain and without it, one
 * line each -- a method that has not traded yet still has its line, so each
 * way reads 81. The two ways are tabs (owner, 2 Oct 2026: "two tabs; a profit /
 * loss filter; no net R"), and without the chain each timeframe is a tab of its
 * own, with All comparing them. Everything is in points -- the money the
 * screen is about; R stays in the CSV for the R&D. A from-to date range (owner:
 * "a date filter, default today") picks the IST days the signals appeared on;
 * it is not remembered, so the tab opens on today, never on a stale day. The server adds it all up in
 * one request (GET /api/entry/report); a tab or a filter change fetches nothing.
 *
 * A trade is a TRADE signal that filled and closed (TGT1, stop or time-out);
 * a win closed above its fill. Points run from the fill to the exit. No fees,
 * no orders: the paper log.
 */

export const TFS: readonly EntryTf[] = ['3m', '5m', '15m', '30m', '1h', '4h'];
type TfTab = EntryTf | 'all';
type SortKey = 'n' | 'trades' | 'winPct' | 'netPts';
type Sort = { key: SortKey; asc: boolean };
const SORT_KEYS: readonly SortKey[] = ['n', 'trades', 'winPct', 'netPts'];
/** Which methods the table lists, by their net points: every one, those up, those down, those not yet traded. */
export type Show = 'all' | 'profit' | 'loss' | 'none';
const SHOWS: readonly { id: Show; name: string }[] = [
  { id: 'all', name: 'All' }, { id: 'profit', name: 'Profit' }, { id: 'loss', name: 'Loss' }, { id: 'none', name: 'No trades' },
];

const num = (v: number, places = 0) => v.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
const signed = (v: number, places = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v), places)}`;
const toneOf = (v: number) => (v > 0 ? 'text-[var(--up)]' : v < 0 ? 'text-[var(--down)]' : 'text-muted-foreground');
const winText = (w: number | null) => (w === null ? '—' : `${w.toFixed(1)}%`);
const tabName = (t: TfTab) => (t === 'all' ? 'All' : t);

/** Whether a method belongs on the list under a filter: net points up, down, or no trade at all. */
export const shows = (r: MethodReportRow, show: Show): boolean =>
  show === 'all' ? true
    : show === 'none' ? r.trades === 0
      : show === 'profit' ? r.trades > 0 && r.netPts > 0
        : r.trades > 0 && r.netPts < 0;

/** The total of the lines shown: what a filtered table adds up to (owner, 2 Oct 2026: "the total follows the filter"). */
export function totalOf(rows: readonly MethodReportRow[], name: string): MethodReportRow {
  const sum = (k: 'signals' | 'trades' | 'wins' | 'losses' | 'profitPts' | 'lossPts' | 'profitR' | 'lossR') => rows.reduce((a, r) => a + r[k], 0);
  const t = {
    signals: sum('signals'), trades: sum('trades'), wins: sum('wins'), losses: sum('losses'),
    profitPts: sum('profitPts'), lossPts: sum('lossPts'), profitR: sum('profitR'), lossR: sum('lossR'),
  };
  return { n: null, method: 'shown', name, ...t, winPct: t.trades > 0 ? (100 * t.wins) / t.trades : null, netPts: t.profitPts - t.lossPts, netR: t.profitR - t.lossR };
}

/** A day and a time of it as the server reads them: the bare day for the whole of it, else `YYYY-MM-DDTHH:MM` (IST). */
export const momentOf = (day: string, hhmm: string, whole: string) => (hhmm === whole ? day : `${day}T${hhmm}`);
const DAY_START = '00:00';
const DAY_END = '23:59';

/** Sorted by the chosen column; methods without a trade always last, so a sort by win rate is not led by blanks. */
export function sortRows(rows: readonly MethodReportRow[], key: SortKey, asc: boolean): MethodReportRow[] {
  const val = (r: MethodReportRow) => (key === 'winPct' ? r.winPct : r[key]);
  return [...rows].sort((a, b) => {
    if (key !== 'n' && (a.trades === 0) !== (b.trades === 0)) return a.trades === 0 ? 1 : -1;
    const x = val(a) ?? -Infinity, y = val(b) ?? -Infinity;
    return (asc ? x - y : y - x) || (a.n ?? 0) - (b.n ?? 0);
  });
}

/** Every line of the report as a spreadsheet: each way, and each timeframe without the chain. R kept here for the R&D. */
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
    { header: 'order_side', value: (r) => r.orderSide ?? null },
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
  const [way, setWay] = usePersisted<EntryMode>('methodReport.way', 'mtf');
  const [tfTab, setTfTab] = usePersisted<TfTab>('methodReport.tfTab', 'all');
  const [show, setShow] = usePersisted<Show>('methodReport.show', 'all');
  const [everyGate, setEveryGate] = usePersisted<boolean>('methodReport.everyGate', false);
  const [sortStored, setSort] = usePersisted<Sort>('methodReport.sort', { key: 'n', asc: true });
  /*
   * The days and their times, IST -- remembered, like every other filter here (owner, 2 Oct 2026: "set once,
   * a refresh must not change it"). Today, the whole of it, until something else is chosen; null is all time.
   */
  const [range, setRange] = usePersisted<DateRangeValue | null>('methodReport.range', (() => { const t = istToday(); return { from: t, to: t }; })());
  const [fromTime, setFromTime] = usePersisted<string>('methodReport.fromTime', DAY_START);
  const [toTime, setToTime] = usePersisted<string>('methodReport.toTime', DAY_END);
  const oneDay = range !== null && range.from === range.to;
  const onFromTime = (v: string) => { setFromTime(v); if (oneDay && toTime < v) setToTime(DAY_END); };
  const asked = range && { from: momentOf(range.from, fromTime, DAY_START), to: momentOf(range.to, toTime, DAY_END) };
  const timed = range !== null && (fromTime !== DAY_START || toTime !== DAY_END);
  // Every way and timeframe in one answer: a tab or a filter change draws, it does not fetch; a new range does.
  const { data, error, loading, refresh } = usePoll(() => getMethodReport(null, everyGate, asked), 30_000,
    { deps: [everyGate, asked?.from, asked?.to] });
  const period = range ? `${describeRange(range)}${timed ? `, ${time12(fromTime)} – ${time12(toTime)}` : ''}` : 'all time';

  // Anything remembered from an older build (a removed column, a removed tab) falls back rather than blanking.
  const sort: Sort = SORT_KEYS.includes(sortStored?.key) ? sortStored : { key: 'n', asc: true };
  const onSort = (key: SortKey) => setSort(sort.key === key ? { key, asc: !sort.asc } : { key, asc: key === 'n' });
  const tab: TfTab = tfTab === 'all' || TFS.includes(tfTab) ? tfTab : 'all';
  const wayNow: EntryMode = way === 'single' ? 'single' : 'mtf';
  const showNow: Show = SHOWS.some((s) => s.id === show) ? show : 'all';
  const [mtf, singleAll] = data?.sections ?? [];
  const single = tab === 'all' ? singleAll : data?.singleByTf?.[tab] ?? singleAll;
  const section = wayNow === 'mtf' ? mtf : single;

  return (
    <div className="flex flex-col gap-3">
      <CollapsibleCard id="methods-report" title="Methods report" right={
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
        }>
        <TabList
          label="Way" idPrefix="mrw" value={wayNow} onChange={setWay} large
          items={[
            { id: 'mtf', name: 'With timeframe chain', short: 'With chain', count: mtf?.total.trades ?? 0 },
            { id: 'single', name: 'Without timeframe chain', short: 'Without chain', count: singleAll?.total.trades ?? 0 },
          ]}
        />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-[0.6px] text-muted-foreground">Signals from</span>
            <DateRangePicker allowAll value={range} onChange={setRange} />
            {range && (
              <>
                <TimePicker label="From time" value={fromTime} onChange={onFromTime}
                            presets={[{ label: 'start of day', value: DAY_START }, { label: '5:30 AM', value: '05:30' }, { label: '9:00 AM', value: '09:00' }]} />
                <span className="text-[12px] text-muted-foreground">to</span>
                <TimePicker label="To time" value={toTime} onChange={setToTime} min={oneDay ? fromTime : null}
                            presets={[{ label: '5:30 PM', value: '17:30' }, { label: 'end of day', value: DAY_END }]} />
              </>
            )}
          </div>
          <div role="group" aria-label="Show methods" className="inline-flex overflow-hidden rounded-md border border-border text-[12px]">
            {SHOWS.map((s) => {
              const n = section ? section.rows.filter((r) => shows(r, s.id)).length : 0;
              const on = showNow === s.id;
              return (
                <button key={s.id} type="button" aria-pressed={on} onClick={() => setShow(s.id)}
                        className={cn('inline-flex items-center gap-1.5 px-2.5 py-1.5 font-semibold',
                          on ? 'bg-[#2563eb] text-white' : 'text-muted-foreground hover:bg-muted',
                          !on && s.id === 'profit' && 'text-[var(--up)]', !on && s.id === 'loss' && 'text-[var(--down)]')}>
                  {s.name} <span className="tabular-nums opacity-80">{n}</span>
                </button>
              );
            })}
          </div>
          <Switch label="Only signals with every gate on" checked={everyGate} onCheckedChange={setEveryGate}
                  description={everyGate ? 'The rules as designed: gate-off signals left out.' : 'Every signal, as in the signal history.'} />
        </div>
        <p className="m-0 mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
          The paper log: every TRADE signal, filled and closed at TGT1, the stop or the time-out. A win closed above its fill.
          The dates are the IST days the signals appeared on (a trade that closed the next day counts on its signal's day).
          Points from the fill to the exit, before fees. Profit and Loss list the methods whose net points are up or down, and
          the totals -- top and bottom -- add up the methods shown. Every signal counts, as in the signal history, unless "Only signals with every gate
          on" is set. With the chain the entry is always 5m; without it, each timeframe has its own tab.
        </p>
        {error && <p role="alert" className="m-0 mt-2 text-[12px] text-[var(--down)]">Could not read the report: {error.message}</p>}
      </CollapsibleCard>

      {!data && !error && <p className="m-0 text-[12px] text-muted-foreground">Loading the report…</p>}
      {data && data.sections.every((s) => s.total.signals === 0) && (
        <p role="status" className="m-0 rounded-md border border-border px-3 py-2 text-[12px] text-muted-foreground">
          No TRADE signals {range ? `on ${period}` : 'recorded yet'}{everyGate ? ' with every gate on' : ''} -- nothing to add up.
          {range ? ' Pick other days, or "all time".' : ''}
          {everyGate ? ' Turn off "Only signals with every gate on" to count the rest.' : ''}
        </p>
      )}
      {section && (
        <div role="tabpanel" id={`mrw-panel-${wayNow}`} aria-labelledby={`mrw-tab-${wayNow}`}>
          {wayNow === 'mtf' ? (
            <ReportSection section={section} period={period} sort={sort} onSort={onSort} show={showNow} />
          ) : singleAll && (
            <ReportSection
              section={section} period={period} sort={sort} onSort={onSort} show={showNow}
              tabs={(
                <TabList
                  label="Timeframe" idPrefix="mr" value={tab} onChange={setTfTab}
                  items={(['all', ...TFS] as TfTab[]).map((t) => ({
                    id: t, name: tabName(t), count: (t === 'all' ? singleAll : data!.singleByTf?.[t])?.total.trades ?? 0,
                  }))}
                />
              )}
              panelOf={tab}
              above={tab === 'all' ? <ByTimeframe byTf={data!.singleByTf} all={singleAll} onOpen={setTfTab} /> : null}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A row of tabs, each with its trade count: the two ways, and the timeframes
 * without the chain. A WAI-ARIA tab list -- arrows, Home and End move between
 * tabs, only the chosen tab is in the Tab order, and on a phone it is one row
 * that swipes rather than three that wrap.
 */
function TabList<T extends string>({ label, idPrefix, items, value, onChange, large = false }: {
  label: string;
  idPrefix: string;
  /** `short`: the label on a phone, where the full one would be cut off; the full one is always the tab's name. */
  items: readonly { id: T; name: string; short?: string; count: number }[];
  value: T;
  onChange: (t: T) => void;
  large?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const go = (i: number) => {
    const t = items[(i + items.length) % items.length]!.id;
    onChange(t);
    refs.current[items.findIndex((x) => x.id === t)]?.focus();
  };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    go(to);
  };
  return (
    <div role="tablist" aria-label={label}
         className="mb-3 flex flex-nowrap gap-1 overflow-x-auto border-0 border-b border-solid border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {items.map((t, i) => {
        const on = t.id === value;
        return (
          <button key={t.id} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" id={`${idPrefix}-tab-${t.id}`}
                  aria-selected={on} aria-controls={`${idPrefix}-panel-${t.id}`} tabIndex={on ? 0 : -1}
                  aria-label={`${t.name}, ${t.count} trades`}
                  onClick={() => onChange(t.id)} onKeyDown={(e) => onKey(e, i)}
                  className={cn('-mb-px inline-flex flex-none items-center gap-1.5 whitespace-nowrap border-0 border-b-2 border-solid bg-transparent font-semibold',
                    large ? 'px-4 py-2 text-[13px]' : 'px-3 py-1.5 text-[12px]',
                    on ? 'border-[#2563eb] text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground')}>
            {t.short ? (<><span className="sm:hidden">{t.short}</span><span className="hidden sm:inline">{t.name}</span></>) : t.name}
            <span aria-hidden
                  className={cn('rounded-full px-1.5 text-[10.5px] tabular-nums', on ? 'bg-[#2563eb] text-white' : 'bg-muted text-muted-foreground')}>
              {num(t.count)}
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
  // Named only when it made money: the least bad of six losers is not "best".
  const best = lines.filter((x) => x.t.trades > 0 && x.t.netPts > 0).sort((a, b) => b.t.netPts - a.t.netPts)[0]?.tf ?? null;
  const cell = 'px-2 py-1 text-right tabular-nums';
  const line = (label: React.ReactNode, t: MethodReportRow, key: string, bold = false) => (
    <tr key={key} className={cn('border-t border-border', bold && 'font-semibold', !bold && t.trades === 0 && 'text-muted-foreground')}>
      <td className="px-2 py-1 text-left">{label}</td>
      <td className={cell}>{num(t.signals)}</td>
      <td className={cell}>{num(t.trades)}</td>
      <td className={cn(cell, 'text-[var(--up)]')}>{num(t.wins)}</td>
      <td className={cn(cell, 'text-[var(--down)]')}>{num(t.losses)}</td>
      <td className={cell}>{winText(t.winPct)}</td>
      <td className={cn(cell, 'text-[var(--up)]')}>{num(t.profitPts)}</td>
      <td className={cn(cell, 'text-[var(--down)]')}>{num(t.lossPts)}</td>
      <td className={cn(cell, toneOf(t.netPts))}>{signed(t.netPts)}</td>
    </tr>
  );
  return (
    <div className="mb-3 overflow-x-auto rounded-md border border-border">
      <table aria-label="By timeframe" className="w-full min-w-[640px] border-collapse text-[12px]">
        <thead>
          <tr className="text-muted-foreground">
            {['Timeframe', 'Signals', 'Trades', 'Wins', 'Losses', 'Win %', 'Profit pts', 'Loss pts', 'Net pts'].map((h, i) => (
              <th key={h} scope="col" className={cn('whitespace-nowrap px-2 py-1.5 font-semibold', i === 0 ? 'text-left' : 'text-right')}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map(({ tf, t }) => line(
            <>
              <button type="button" onClick={() => onOpen(tf)} className="font-semibold underline-offset-2 hover:underline">{tf}</button>
              {tf === best && <span className="ml-1.5 rounded bg-[var(--up)]/15 px-1 text-[10px] font-semibold text-[var(--up)]">best</span>}
            </>, t, tf))}
        </tbody>
        <tfoot>{line('All', all.total, 'all', true)}</tfoot>
      </table>
    </div>
  );
}

function ReportSection({ section, period, sort, onSort, show, tabs, panelOf, above }: {
  section: MethodReportSection;
  /** The days counted, in words: "today", "2-8 Oct", "all time". */
  period: string;
  sort: Sort;
  onSort: (k: SortKey) => void;
  show: Show;
  /** The section's tab list, when it has one; `panelOf` names the tab its body belongs to. */
  tabs?: React.ReactNode;
  panelOf?: TfTab;
  /** Drawn above the summary, inside the tab's panel (the timeframe comparison on All). */
  above?: React.ReactNode;
}) {
  const rows = useMemo(
    () => sortRows(section.rows.filter((r) => shows(r, show)), sort.key, sort.asc),
    [section.rows, sort.key, sort.asc, show],
  );
  // The totals follow the filter: All is the server's own total; a filter adds up the lines it shows.
  const t = show === 'all' ? section.total : totalOf(rows, `${SHOWS.find((x) => x.id === show)!.name} · ${rows.length} method${rows.length === 1 ? '' : 's'}`);
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
      <td className={cn('whitespace-nowrap px-2 py-1 text-left font-semibold', r.orderSide === 'BUY' && 'text-[var(--up)]', r.orderSide === 'SELL' && 'text-[var(--down)]')}>
        {r.orderSide ?? (total ? '' : '—')}
      </td>
      <td className="px-2 py-1 text-right tabular-nums">{num(r.signals)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{num(r.trades)}</td>
      <td className="px-2 py-1 text-right tabular-nums text-[var(--up)]">{num(r.wins)}</td>
      <td className="px-2 py-1 text-right tabular-nums text-[var(--down)]">{num(r.losses)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{winText(r.winPct)}</td>
      <td className="px-2 py-1 text-right tabular-nums text-[var(--up)]">{num(r.profitPts)}</td>
      <td className="px-2 py-1 text-right tabular-nums text-[var(--down)]">{num(r.lossPts)}</td>
      <td className={cn('px-2 py-1 text-right tabular-nums', toneOf(r.netPts))}>{signed(r.netPts)}</td>
    </tr>
  );
  const empty = show === 'profit' ? 'No method is in profit here.' : show === 'loss' ? 'No method is in loss here.'
    : show === 'none' ? 'Every method here has traded.' : 'No methods.';
  const body = (
    <>
      {above}
      <dl className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi label="Trades" value={num(t.trades)} />
        <Kpi label="Wins / losses" value={<><span className="text-[var(--up)]">{num(t.wins)}</span> / <span className="text-[var(--down)]">{num(t.losses)}</span></>} />
        <Kpi label="Win rate" value={winText(t.winPct)} />
        <Kpi label="Net points" value={<span className={toneOf(t.netPts)}>{signed(t.netPts)}</span>} />
      </dl>
      <div className="max-h-[70vh] overflow-auto rounded-md border border-border">
        <table aria-label={`${section.label}${panelOf ? `, ${tabName(panelOf)}` : ''}`} className="w-full min-w-[780px] border-collapse text-[12px]">
          <thead>
            <tr>
              {head('#', 'n')}{head('Method', undefined, true)}{head('Order side', undefined, true)}{head('Signals')}{head('Trades', 'trades')}
              {head('Wins')}{head('Losses')}{head('Win %', 'winPct')}{head('Profit pts')}{head('Loss pts')}{head('Net pts', 'netPts')}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => line(r))}
            {rows.length === 0 && (
              <tr><td colSpan={11} className="px-2 py-3 text-center text-muted-foreground">{empty}</td></tr>
            )}
          </tbody>
          <tfoot className="bg-[var(--panel)]">{line(t, true)}</tfoot>
        </table>
      </div>
    </>
  );

  return (
    <section aria-label={section.label}>
      <CollapsibleCard id={`methods-report-${section.mode}`} title={section.label} right={
          <span className="text-[11px] text-muted-foreground">
            {period} · {show === 'all' ? `${section.rows.length} methods` : `${rows.length} of ${section.rows.length} methods`}
            {section.gatesOffSignals > 0 ? ` · ${num(section.gatesOffSignals)} signals taken with a gate off` : ''}
          </span>
        }>
        {tabs}
        {panelOf ? (
          <div role="tabpanel" id={`mr-panel-${panelOf}`} aria-labelledby={`mr-tab-${panelOf}`}>{body}</div>
        ) : body}
      </CollapsibleCard>
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
