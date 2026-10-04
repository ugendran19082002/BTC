import { useEffect, useMemo, useState } from 'react';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Search } from 'lucide-react';
import { downloadCsv, toCsv, type CsvColumn } from '@/lib/csv';
import { getSignalTrades } from '@/api/strategy';
import { usePoll } from '@/hooks/usePoll';
import { ALL_TIME_LABEL, DateRangePicker, describeRange, istToday, type DateRangeValue } from '@/components/ui/date-range-picker';
import { Input } from '@/components/ui/input';
import type { SignalTrade, Strategy } from '@/types/strategy';
import { usePersisted } from '@/hooks/usePersisted';
import { signedInr, stamp, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Every trade the signal strategies took, or with live orders off would have
 * taken: the signal, the option, the signal's SL and TGT on the BTC perp, how
 * it ended and what it made.
 *
 * A real order's result is the option's own: its fill, its exit, why the desk
 * closed it and the money. A "would sell" has no option, so its result is the
 * paper log's on the perp -- waiting at the zone, in the trade, out at the SL
 * or TGT1, timed out, or never filled -- the same verdict the signal history
 * shows. The filters are kept in this browser.
 */

type Show = 'all' | 'live' | 'live-open' | 'live-closed' | 'paper' | 'open' | 'won' | 'lost' | 'skipped';

/** A trade -- sold, or written down as one -- rather than a signal not taken. */
export const isTrade = (t: SignalTrade) => t.status === 'placed' || t.status === 'would-place';

/** The tabs, in the order a person asks: everything, which kind, how they went, and what was passed over. */
const TABS: { v: Show; label: string; test: (t: SignalTrade) => boolean }[] = [
  { v: 'all', label: 'All', test: isTrade },
  { v: 'live', label: 'Live orders', test: (t) => t.status === 'placed' },
  // A live order still holding (or its entry still working), and one bought back.
  { v: 'live-open', label: 'Live open', test: (t) => t.status === 'placed' && Boolean(t.option?.open) },
  { v: 'live-closed', label: 'Live closed', test: (t) => t.status === 'placed' && t.option !== null && !t.option.open },
  { v: 'paper', label: 'Would sell', test: (t) => t.status === 'would-place' },
  { v: 'open', label: 'Open', test: (t) => isTrade(t) && outcomeOf(t).tone === 'open' },
  { v: 'won', label: 'Won', test: (t) => isTrade(t) && outcomeOf(t).tone === 'up' },
  { v: 'lost', label: 'Lost', test: (t) => isTrade(t) && outcomeOf(t).tone === 'down' },
  { v: 'skipped', label: 'Skipped', test: (t) => !isTrade(t) },
];
/** Rows a page holds. */
export const PAGE = 10;

/** The columns a person can sort by, and the value each is sorted on. Blank values always last. */
export type SortKey = 'time' | 'signal' | 'option' | 'perpEntry' | 'optionEntry' | 'sl' | 'tgt' | 'perpExit' | 'optionExit' | 'result' | 'pnl';
type Sort = { key: SortKey; asc: boolean };
const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'signal', label: 'Signal' }, { key: 'option', label: 'Option' }, { key: 'perpEntry', label: 'Perp entry' },
  { key: 'optionEntry', label: 'Option entry' }, { key: 'sl', label: 'Perp SL' }, { key: 'tgt', label: 'Perp TGT' },
  { key: 'perpExit', label: 'Perp exit' }, { key: 'optionExit', label: 'Option exit' }, { key: 'result', label: 'Result' },
  { key: 'pnl', label: 'P&L' },
];
export function sortValue(t: SignalTrade, key: SortKey): number | string | null {
  switch (key) {
    case 'time': return t.at;
    case 'signal': return t.detail.split(' | ')[0]!.toLowerCase();
    case 'option': return t.option?.strike ?? null;
    case 'perpEntry': return t.option ? (t.option.perpEntry ?? null) : (t.perp?.fillPrice ?? null);
    case 'optionEntry': return t.option?.entry ?? null;
    case 'sl': return t.option?.perpStop ?? t.levels?.stop ?? null;
    case 'tgt': return t.option?.perpTarget ?? t.levels?.tp1 ?? null;
    case 'perpExit': return t.option ? (t.option.perpExit ?? null) : (t.perp?.exitPrice ?? null);
    case 'optionExit': return t.option?.exit ?? null;
    case 'result': return isTrade(t) ? outcomeOf(t).word : t.status;
    case 'pnl': return t.option && !t.option.open ? t.option.pnlUsd : null;
  }
}
export function sortTrades(rows: readonly SignalTrade[], s: Sort): SignalTrade[] {
  return [...rows].sort((a, b) => {
    const x = sortValue(a, s.key), y = sortValue(b, s.key);
    if (x === null || y === null) return x === y ? b.at - a.at : x === null ? 1 : -1;   // blanks last, either way
    const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return (s.asc ? d : -d) || b.at - a.at;
  });
}
/** ISO-like IST time for the sheet: "2026-10-02 11:10:05", which Excel reads as a date. */
const istTime = (ms: number | null | undefined) => (ms
  ? new Date(ms + 330 * 60_000).toISOString().replace('T', ' ').slice(0, 19)
  : null);

/**
 * The sheet: one row per trade (or signal not taken), every figure the table
 * shows and the ones it keeps on hover -- unformatted numbers, so Excel can add
 * them up. Times are IST.
 */
export function tradesCsv(rows: readonly SignalTrade[], nameOf: (id: string) => string): string {
  const entryAt = (t: SignalTrade) => (t.option ? t.option.entryAt ?? null : t.perp?.filledAt ?? null);
  const exitAt = (t: SignalTrade) => (t.option ? t.option.exitAt ?? null : t.perp?.exitAt ?? null);
  const cols: CsvColumn<SignalTrade>[] = [
    { header: 'Signal time (IST)', value: (t) => istTime(t.at) },
    { header: 'Strategy', value: (t) => nameOf(t.strategyId) },
    { header: 'Kind', value: (t) => (t.status === 'placed' ? 'live order' : t.status === 'would-place' ? 'would sell' : t.status) },
    { header: 'Signal', value: (t) => t.detail.split(' | ')[0] },
    { header: 'Method', value: (t) => t.method },
    { header: 'Timeframe', value: (t) => (t.mode === 'mtf' ? '5m + TF chain' : t.tf) },
    { header: 'Direction', value: (t) => (t.dir === 1 ? 'BUY' : 'SELL') },
    { header: 'Option', value: (t) => t.option?.side ?? (isTrade(t) ? (t.dir === 1 ? 'PE' : 'CE') : null) },
    { header: 'Strike', value: (t) => t.option?.strike ?? null },
    { header: 'Lots', value: (t) => t.option?.size ?? null },
    { header: 'Entry zone low', value: (t) => t.levels?.entryLo ?? null },
    { header: 'Entry zone high', value: (t) => t.levels?.entryHi ?? null },
    { header: 'Perp entry', value: (t) => sortValue(t, 'perpEntry') },
    { header: 'Perp entry approx', value: (t) => (t.option?.perpEntryApprox ? 'yes' : null) },
    { header: 'Entry time (IST)', value: (t) => istTime(entryAt(t)) },
    { header: 'Option entry ($)', value: (t) => t.option?.entry ?? null },
    { header: 'Perp SL', value: (t) => sortValue(t, 'sl') },
    { header: 'Perp TGT', value: (t) => sortValue(t, 'tgt') },
    { header: 'TGT2', value: (t) => t.levels?.tp2 ?? null },
    { header: 'TGT3', value: (t) => t.levels?.tp3 ?? null },
    { header: 'Hit', value: (t) => (hitOf(t) === 'sl' ? 'SL' : hitOf(t) === 'tgt' ? 'TGT' : null) },
    { header: 'Perp exit', value: (t) => sortValue(t, 'perpExit') },
    { header: 'Perp exit approx', value: (t) => (t.option?.perpExitApprox ? 'yes' : null) },
    { header: 'Exit time (IST)', value: (t) => istTime(exitAt(t)) },
    { header: 'Option exit ($)', value: (t) => t.option?.exit ?? null },
    { header: 'Result', value: (t) => (isTrade(t) ? outcomeOf(t).word : t.status) },
    { header: 'P&L ($)', value: (t) => (t.option && !t.option.open ? Number(t.option.pnlUsd.toFixed(4)) : null) },
    { header: 'P&L (₹)', value: (t) => (t.option && !t.option.open ? Number((usdToInr(t.option.pnlUsd) ?? 0).toFixed(2)) : null) },
    { header: 'Why closed / not taken', value: (t) => t.option?.exitReason ?? (isTrade(t) ? null : t.detail.split(' | ').slice(1).join(' | ')) },
    { header: 'Strike rule', value: (t) => [strikeNotes(t.detail).rule, strikeNotes(t.detail).block].filter(Boolean).join(' · ') || null },
    { header: 'Trade id', value: (t) => t.tradeId },
  ];
  return toCsv(rows, cols);
}

/**
 * What a trade's own line says about its strike rule: that the rule failed and
 * the else strike was sold ("rule failed: the premium's strike 84400 @ 51 is
 * nearer than OTM 6 — sold the else strike OTM 8"), and the block of the day it
 * was sold under ("block 2, from 9:35 PM"). Either may be absent.
 *
 * A trade row shows figures, not the server's sentence, so these two were on
 * the record and not on the screen: a strike other than the premium's own has
 * to say why where the trade is read.
 */
export function strikeNotes(detail: string): { rule: string | null; block: string | null } {
  return {
    rule: /\((rule failed: [^)]*)\)/.exec(detail)?.[1] ?? null,
    block: /· (block \d+, from \d{1,2}:\d{2} [AP]M)/.exec(detail)?.[1] ?? null,
  };
}

/** Everything a row says, lower-cased, for the search box: the signal, strategy, timeframe, option, result and why. */
function haystack(t: SignalTrade, name: string): string {
  return [t.detail, name, t.method, t.mode === 'mtf' ? 'chain' : t.tf, t.status,
    t.option ? `${t.option.side} ${t.option.strike ?? ''} ${t.option.exitReason ?? ''}` : (t.dir === 1 ? 'pe' : 'ce'),
    isTrade(t) ? outcomeOf(t).word : ''].join(' ').toLowerCase();
}
type Outcome = { word: string; tone: 'up' | 'down' | 'open' | 'quiet'; at: number | null; price: number | null };

const btc = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US'));
/** An option's price, in dollars, as Delta quotes it: "$45", "$4.5". */
const opt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);

/** The perp side, in the paper log's words. */
const PERP: Record<string, { word: string; tone: Outcome['tone'] }> = {
  open: { word: 'waiting at the zone', tone: 'open' },
  filled: { word: 'in the trade', tone: 'open' },
  tp1: { word: 'TGT1 hit', tone: 'up' },
  stop: { word: 'SL hit', tone: 'down' },
  timeout: { word: 'timed out', tone: 'quiet' },
  expired: { word: 'never filled', tone: 'quiet' },
  missed: { word: 'missed', tone: 'quiet' },
};

/** How a trade ended, in a word, with when and at what. */
export function outcomeOf(t: SignalTrade): Outcome {
  const o = t.option;
  if (o) {
    if (o.entry === null) return { word: o.open ? 'entry working' : 'not filled', tone: o.open ? 'open' : 'quiet', at: null, price: null };
    if (o.open) return { word: 'open', tone: 'open', at: null, price: null };
    // The server names the exit (strategy/store.ts `exitByOf`); an older server, guessed from the reason.
    const BY = { 'perp-sl': 'perp SL', 'perp-tgt': 'perp TGT', 'option-tgt': 'option TGT', 'option-sl': 'option SL', 'window-end': 'window end', manual: 'closed by hand' } as const;
    const why = o.exitBy ? BY[o.exitBy] : o.exitReason
      ? /stop/i.test(o.exitReason) ? 'perp SL' : /target/i.test(o.exitReason) ? 'perp TGT' : /window|exit time/i.test(o.exitReason) ? 'window end' : 'closed'
      : o.pnlUsd > 0 ? 'target' : 'stop / closed';
    return { word: why, tone: o.pnlUsd > 0 ? 'up' : o.pnlUsd < 0 ? 'down' : 'quiet', at: null, price: o.exit };
  }
  const p = t.perp;
  if (!p) return { word: 'no paper record', tone: 'quiet', at: null, price: null };
  const w = PERP[p.status] ?? { word: p.status, tone: 'quiet' as const };
  return { ...w, at: p.exitAt, price: p.exitPrice };
}

const TONE: Record<Outcome['tone'], string> = {
  up: 'text-[var(--up)]', down: 'text-[var(--down)]', open: 'text-[var(--warn)]', quiet: 'text-[var(--dim)]',
};

export function SignalTradeHistory({ trades: given, strategies }: {
  /** Handed in (tests); otherwise the history is asked of the server for the days picked. */
  trades?: readonly SignalTrade[];
  strategies: readonly Strategy[];
}) {
  // The days, IST: today until something else is picked, and remembered (null is all time).
  const [range, setRange] = usePersisted<DateRangeValue | null>('signal-trades:range', (() => { const t = istToday(); return { from: t, to: t }; })());
  const rangeKey = range ? `${range.from}|${range.to}` : 'all';
  const fetched = usePoll(() => getSignalTrades(range), 10_000, { enabled: given === undefined, deps: [rangeKey] });
  const trades = useMemo((): readonly SignalTrade[] => {
    if (given === undefined) return fetched.data?.trades ?? [];
    if (!range) return given;
    const ist = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
    return given.filter((t) => ist(t.at) >= range.from && ist(t.at) <= range.to);
  }, [given, fetched.data, range]);
  const [show, setShow] = usePersisted<Show>('signal-trades:show', 'all');
  const [who, setWho] = usePersisted<string>('signal-trades:strategy', 'all');
  const nameOf = (id: string) => strategies.find((s) => s.id === id)?.name ?? id;
  const ids = [...new Set(trades.map((t) => t.strategyId))];

  const [query, setQuery] = usePersisted<string>('signal-trades:search', '');
  const [sort, setSort] = usePersisted<Sort>('signal-trades:sort', { key: 'time', asc: false });
  const q = query.trim().toLowerCase();
  const mine = useMemo(() => trades.filter((t) => (who === 'all' || t.strategyId === who)
    && (!q || q.split(/\s+/).every((w) => haystack(t, nameOf(t.strategyId)).includes(w)))),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [trades, who, q, strategies]);
  const tab = TABS.find((x) => x.v === show) ?? TABS[0]!;
  const rows = useMemo(() => sortTrades(mine.filter(tab.test), sort), [mine, tab, sort]);
  const sortBy = (key: SortKey) => setSort((cur) => (cur.key === key ? { key, asc: !cur.asc } : { key, asc: key === 'signal' || key === 'result' }));
  const count = (x: (typeof TABS)[number]) => mine.filter(x.test).length;
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  // A filter changed, or the list shrank: back to a page that exists.
  useEffect(() => { setPage(0); }, [show, who, q, sort.key, sort.asc, rangeKey]);
  useEffect(() => { if (page > pages - 1) setPage(pages - 1); }, [page, pages]);
  const shown = rows.slice(page * PAGE, (page + 1) * PAGE);
  const totals = useMemo(() => {
    let won = 0; let lost = 0; let open = 0; let pnl = 0;
    for (const t of rows) {
      const o = outcomeOf(t);
      if (o.tone === 'up') won += 1; else if (o.tone === 'down') lost += 1; else if (o.tone === 'open') open += 1;
      if (t.option) pnl += t.option.pnlUsd;
    }
    return { won, lost, open, pnl, decided: won + lost };
  }, [rows]);

  const chip = (on: boolean) => cn('m-0 h-8 appearance-none rounded-md border border-solid px-2.5 font-[inherit] text-[12px]',
    on ? 'border-foreground bg-muted text-foreground' : 'border-border bg-transparent text-muted-foreground');

  return (
    <CollapsibleCard id="signal-trade-history" title="Trade history" ariaLabel="signal trade history" className="mt-3 bg-[var(--panel)]"
      right={
        <div className="flex flex-wrap items-center gap-1.5">
          <DateRangePicker allowAll value={range} onChange={setRange} />
          <button type="button" onClick={() => downloadCsv(`signal-trades-${tab.v}-${range ? (range.from === range.to ? range.from : `${range.from}-to-${range.to}`) : 'all-time'}.csv`, tradesCsv(rows, nameOf))}
                  disabled={!rows.length} aria-label="download as a spreadsheet"
                  title="Every row shown here -- this tab, search, strategy and sort, all pages -- as a CSV that opens in Excel."
                  className="m-0 inline-flex h-8 appearance-none items-center gap-1 rounded-md border border-solid border-border bg-transparent px-2.5 font-[inherit] text-[12px] text-foreground disabled:opacity-40">
            <Download className="h-3.5 w-3.5" aria-hidden /> Excel
          </button>
        </div>
      }
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="search trades"
                   placeholder="Search method, strike, strategy…" className="h-8 w-56 pl-7 text-[12px]" />
          </div>
          <div role="group" aria-label="which trades" className="flex flex-wrap gap-1">
            {TABS.map((x) => (
              <button key={x.v} type="button" aria-pressed={tab.v === x.v} onClick={() => setShow(x.v)} className={chip(tab.v === x.v)}>
                {x.label} <span className="tabular-nums text-[var(--dim)]">{count(x)}</span>
              </button>
            ))}
          </div>
          {ids.length > 1 && (
            <select aria-label="which strategy" value={who} onChange={(e) => setWho(e.target.value)}
                    className="h-8 rounded-md border border-solid border-border bg-background px-2 text-[12px] text-foreground">
              <option value="all">Every strategy</option>
              {ids.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}
            </select>
          )}
      </div>

      {tab.v === 'skipped' ? (
        <p className="m-0 mb-1.5 text-[11.5px] tabular-nums text-muted-foreground" aria-label="history totals">
          <span className="text-foreground">{range ? describeRange(range) : ALL_TIME_LABEL}</span> · {rows.length} signal{rows.length === 1 ? '' : 's'} not taken — the reason on each row.
        </p>
      ) : (
      <p className="m-0 mb-1.5 text-[11.5px] tabular-nums text-muted-foreground" aria-label="history totals">
        <span className="text-foreground">{range ? describeRange(range) : ALL_TIME_LABEL}</span> · {rows.length} trade{rows.length === 1 ? '' : 's'} · <span className="text-[var(--up)]">{totals.won} won</span>
        {' · '}<span className="text-[var(--down)]">{totals.lost} lost</span> · {totals.open} open
        {totals.decided > 0 && ` · win rate ${Math.round((totals.won / totals.decided) * 100)}%`}
        {rows.some((t) => t.option) && (
          <> · live P&amp;L <span className={totals.pnl > 0 ? 'text-[var(--up)]' : totals.pnl < 0 ? 'text-[var(--down)]' : ''}>{signedInr(usdToInr(totals.pnl))}</span></>
        )}
      </p>
      )}

      {rows.length === 0 ? (
        <p className="m-0 rounded-lg border border-dashed border-[var(--line)] px-3 py-3 text-[12px] text-muted-foreground">
          {fetched.error && given === undefined ? `Could not read the history: ${fetched.error.message}` : q ? `Nothing matches “${query.trim()}”${tab.v === 'all' ? '' : ` under ${tab.label}`}.` : `Nothing here yet${tab.v === 'all' ? '' : ` under ${tab.label}`}.`}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-solid border-border">
            <table aria-label="signal trades" className="w-full min-w-[960px] border-collapse text-[11.5px] tabular-nums">
              <thead>
                <tr className="bg-muted text-left text-[10.5px] uppercase tracking-[0.4px] text-muted-foreground">
                  {COLUMNS.map((c) => {
                    const on = sort.key === c.key || (c.key === 'signal' && sort.key === 'time');
                    const dirOf = sort.key === c.key ? (sort.asc ? 'ascending' : 'descending') : 'none';
                    return (
                      <th key={c.key} scope="col" className="px-2 py-1.5 font-medium" aria-sort={dirOf as 'ascending' | 'descending' | 'none'}>
                        <button type="button" onClick={() => sortBy(c.key)} aria-label={`sort by ${c.label}`}
                                className={cn('m-0 inline-flex appearance-none items-center gap-0.5 border-0 bg-transparent p-0 font-[inherit] uppercase tracking-[0.4px]',
                                  on ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                          {c.label}
                          {sort.key === c.key && (sort.asc ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                        </button>
                        {c.key === 'signal' && (
                          <button type="button" onClick={() => sortBy('time')} aria-label="sort by time"
                                  className={cn('m-0 ml-1.5 inline-flex appearance-none items-center gap-0.5 border-0 bg-transparent p-0 font-[inherit] normal-case tracking-normal',
                                    sort.key === 'time' ? 'text-foreground' : 'text-[var(--dim)] hover:text-foreground')}>
                            time{sort.key === 'time' && (sort.asc ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                          </button>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (isTrade(t)
                  ? <Row key={t.id} t={t} name={nameOf(t.strategyId)} />
                  : <SkippedRow key={t.id} t={t} name={nameOf(t.strategyId)} />))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <nav aria-label="trade history pages" className="mt-1.5 flex items-center justify-end gap-2 text-[12px]">
              <button type="button" aria-label="previous page" disabled={page === 0} onClick={() => setPage(page - 1)}
                      className="m-0 inline-flex h-8 items-center gap-1 rounded-md border border-solid border-border bg-transparent px-2 font-[inherit] text-foreground disabled:opacity-35">
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </button>
              <span className="tabular-nums text-muted-foreground" aria-live="polite">
                {page * PAGE + 1}–{Math.min(rows.length, (page + 1) * PAGE)} of {rows.length} · page {page + 1} of {pages}
              </span>
              <button type="button" aria-label="next page" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}
                      className="m-0 inline-flex h-8 items-center gap-1 rounded-md border border-solid border-border bg-transparent px-2 font-[inherit] text-foreground disabled:opacity-35">
                Next <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </nav>
          )}
        </>
      )}
      <p className="m-0 mt-1 text-[10.5px] text-[var(--dim)]">
        A would-sell&apos;s result is the paper log&apos;s on the perp (entry at the zone, out at the SL or TGT1); a live order&apos;s is its option&apos;s own.
      </p>
    </CollapsibleCard>
  );
}

/** Which exit was reached, so its time is shown under it: the SL, the TGT, or neither (window end, time-out, by hand). */
export function hitOf(t: SignalTrade): 'sl' | 'tgt' | null {
  if (t.option) {
    if (t.option.open) return null;
    if (t.option.exitBy !== undefined) return t.option.exitBy === 'perp-sl' ? 'sl' : t.option.exitBy === 'perp-tgt' ? 'tgt' : null;
    if (!t.option.exitReason) return null;
    return /stop/i.test(t.option.exitReason) ? 'sl' : /target/i.test(t.option.exitReason) ? 'tgt' : null;
  }
  return t.perp?.status === 'stop' ? 'sl' : t.perp?.status === 'tp1' ? 'tgt' : null;
}

const When = ({ at }: { at: number | null | undefined }) =>
  (at ? <div className="text-[10.5px] text-[var(--dim)]">{stamp(at)}</div> : null);

function Row({ t, name }: { t: SignalTrade; name: string }) {
  const o = outcomeOf(t);
  const hit = hitOf(t);
  const sl = t.option?.perpStop ?? t.levels?.stop ?? null;
  const tgt = t.option?.perpTarget ?? t.levels?.tp1 ?? null;
  const [said] = t.detail.split(' | ');
  const notes = strikeNotes(t.detail);
  const perpEntry = t.option ? (t.option.perpEntry ?? null) : (t.perp?.fillPrice ?? null);
  const perpExit = t.option ? (t.option.perpExit ?? null) : (t.perp?.exitPrice ?? null);
  const approx = (on: boolean | undefined) => (on ? '≈' : '');
  const APPROX = 'The perp over that minute: this trade was placed before the exact point was kept.';
  const entryAt = t.option ? (t.option.entryAt ?? null) : (t.perp?.filledAt ?? null);
  const exitAt = t.option ? (t.option.exitAt ?? null) : (t.perp?.exitAt ?? null);
  return (
    <tr className="border-0 border-t border-solid border-border align-top">
      <td className="px-2 py-1.5">
        <span className={t.dir === 1 ? 'text-[var(--up)]' : 'text-[var(--down)]'}>{said}</span>
        <div className="text-[10.5px] text-[var(--dim)]">{t.mode === 'mtf' ? '5m + TF chain' : t.tf} · {name}</div>
        <div className="text-[10.5px] text-[var(--dim)]">signal {stamp(t.at)}</div>
      </td>
      <td className="whitespace-nowrap px-2 py-1.5">
        {t.option
          ? <>{t.option.side} {btc(t.option.strike)} ×{t.option.size}</>
          : <span className="text-[var(--dim)]">{t.dir === 1 ? 'PE' : 'CE'} · would sell</span>}
        {/* The strike rule's own account: the rule failed and the else strike was sold, and which block of the day. */}
        {notes.rule && (
          <div aria-label="strike rule" className="max-w-[17rem] whitespace-normal text-[10.5px] leading-snug text-[var(--warn)]">{notes.rule}</div>
        )}
        {notes.block && <div aria-label="strike block" className="text-[10.5px] text-[var(--dim)]">{notes.block}</div>}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5" aria-label="perp entry"
          title={t.option?.perpEntryApprox ? APPROX : t.option ? 'The perp the moment the option filled.' : 'Where the paper log filled it on the perp.'}>
        {perpEntry !== null
          ? <>{approx(t.option?.perpEntryApprox)}{btc(perpEntry)}</>
          : <span className="text-[var(--dim)]">{t.option ? '—' : t.perp?.status === 'open' ? 'waiting' : t.perp?.status === 'expired' ? 'never filled' : '—'}</span>}
        {t.levels && <div className="text-[10.5px] text-[var(--dim)]">zone {btc(t.levels.entryLo)}–{btc(t.levels.entryHi)}</div>}
        {!t.option && <When at={entryAt} />}
        {t.option && perpEntry !== null && <When at={entryAt} />}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5" aria-label="option entry">
        {t.option ? opt(t.option.entry) : <span className="text-[var(--dim)]">—</span>}
        {t.option && <When at={entryAt} />}
        {/* The option's own exits, the backstop at Delta -- or said to be off. */}
        {t.option && (t.option.optionTarget !== undefined || t.option.optionStop !== undefined) && (
          <div className="text-[10.5px] text-[var(--dim)]" aria-label="option exits">
            TP {t.option.optionTarget != null ? opt(t.option.optionTarget) : 'off'} · SL {t.option.optionStop != null ? opt(t.option.optionStop) : <span className="text-[var(--warn)]">off</span>}
          </div>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 text-[var(--down)]" aria-label="perp SL">
        {btc(sl)}
        {hit === 'sl' && <When at={exitAt} />}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 text-[var(--up)]" aria-label="perp TGT">
        {btc(tgt)}
        {hit === 'tgt' && <When at={exitAt} />}
        {t.levels && (t.levels.tp2 !== null || t.levels.tp3 !== null) && (
          <div className="text-[10.5px] text-[var(--dim)]">
            {t.levels.tp2 !== null && `TGT2 ${btc(t.levels.tp2)}`}{t.levels.tp3 !== null && ` · TGT3 ${btc(t.levels.tp3)}`}
          </div>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5" aria-label="perp exit" title={t.option?.perpExitApprox ? APPROX : undefined}>
        {perpExit !== null ? <>{approx(t.option?.perpExitApprox)}{btc(perpExit)}</> : <span className="text-[var(--dim)]">—</span>}
        {perpExit !== null && <When at={exitAt} />}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5" aria-label="option exit">
        {t.option ? opt(t.option.exit) : <span className="text-[var(--dim)]">—</span>}
        {t.option && t.option.exit !== null && hit === null && <When at={exitAt} />}
      </td>
      <td className={cn('px-2 py-1.5', TONE[o.tone])} title={t.option?.exitReason ?? undefined}>{o.word}</td>
      <td className={cn('whitespace-nowrap px-2 py-1.5', t.option ? (t.option.pnlUsd > 0 ? 'text-[var(--up)]' : t.option.pnlUsd < 0 ? 'text-[var(--down)]' : '') : 'text-[var(--dim)]')}>
        {t.option ? (t.option.open ? '—' : signedInr(usdToInr(t.option.pnlUsd))) : 'paper'}
      </td>
    </tr>
  );
}

/** A signal not taken: the signal, and why, across the row. */
function SkippedRow({ t, name }: { t: SignalTrade; name: string }) {
  const [said, ...why] = t.detail.split(' | ');
  return (
    <tr className="border-0 border-t border-solid border-border align-top">
      <td className="px-2 py-1.5">
        <span className={t.dir === 1 ? 'text-[var(--up)]' : 'text-[var(--down)]'}>{said}</span>
        <div className="text-[10.5px] text-[var(--dim)]">{t.mode === 'mtf' ? '5m + TF chain' : t.tf} · {name}</div>
        <div className="text-[10.5px] text-[var(--dim)]">signal {stamp(t.at)}</div>
      </td>
      <td colSpan={9} className="px-2 py-1.5" aria-label="why not taken">
        <span className={cn('mr-1.5 rounded px-1.5 py-px text-[10.5px] font-semibold uppercase',
          t.status === 'failed' ? 'bg-[var(--down)]/12 text-[var(--down)]' : 'bg-muted text-muted-foreground')}>
          {t.status}
        </span>
        <span className="text-muted-foreground">{why.join(' | ') || '—'}</span>
      </td>
    </tr>
  );
}
