import { useEffect } from 'react';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { entrySignalsCsvUrl, getEntrySignals, type SignalFilter, type SignalSort } from '@/api/entry';
import { cn } from '@/lib/utils';
import type { EntryMode, EntrySignal, EntrySignalSummary, EntryTf } from '@/types/entry';
import { SECS, atText, clockText, lag, useNow } from './clock';

/**
 * Every signal the server kept (the journal, entry_signals), as a data table:
 * signal tabs (all, BUY & SELL, BUY, SELL, WAIT), way and timeframe filters,
 * today or all days, columns sortable on the server, pages of 25 / 50 / 100 --
 * and over everything matching, the TRADEs, TP1 hits and the points they made,
 * stops and the points they lost, and the net. Each row: when, the price then
 * (LTP and index), the levels, and for a TRADE the fill, the exit and why it
 * exited, in points and R. Refreshed every 5 s; the choices are remembered.
 */

// Not 1m: chart-only without the chain, so it gives no signal and the server keeps none.
const TFS: readonly EntryTf[] = ['3m', '5m', '15m', '30m', '1h', '4h'];
const PAGE_SIZES = [25, 50, 100] as const;
const TIME = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '–' : Math.round(v).toLocaleString('en-US'));
const signedPts = (v: number) => `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v))}`;

/** The signal tabs, and what each asks the server for. */
export const TABS = {
  all: { label: 'All', q: {}, tone: '#2563eb', title: 'Every signal' },
  // In play now: waiting at the zone or filled, not yet out at TP1, the stop or time.
  trading: { label: 'TRADING', q: { state: 'TRADE', live: true }, tone: '#2563eb', title: 'In play now: waiting at the zone, filled, or a runner after TGT1' },
  trades: { label: 'BUY & SELL', q: { state: 'TRADE' }, tone: '#2563eb', title: 'Every TRADE, either way' },
  buy: { label: 'BUY', q: { state: 'TRADE', dir: 1 }, tone: '#26a17b', title: 'TRADEs to buy' },
  sell: { label: 'SELL', q: { state: 'TRADE', dir: -1 }, tone: '#e2504f', title: 'TRADEs to sell' },
  wait: { label: 'WAIT', q: { state: 'WAIT' }, tone: '#b7791f', title: 'Forming, not yet a TRADE' },
  // How each TRADE ended in the paper log.
  tgt: { label: 'TGT HIT', q: { state: 'TRADE', outcome: 'tp1' }, tone: '#26a17b', title: 'Out at TGT1' },
  sl: { label: 'SL HIT', q: { state: 'TRADE', outcome: 'stop' }, tone: '#e2504f', title: 'Out at the stop' },
  timeout: { label: 'TIMED OUT', q: { state: 'TRADE', outcome: 'timeout' }, tone: '#64748b', title: 'Closed on time, neither level reached' },
  expired: { label: 'EXPIRED', q: { state: 'TRADE', outcome: 'expired' }, tone: '#64748b', title: 'Never filled in its window, or the stop came first' },
  missed: { label: 'MISSED', q: { state: 'TRADE', outcome: 'missed' }, tone: '#b7791f', title: 'Price ran to TGT1 without coming back to fill' },
} as const satisfies Record<string, { label: string; q: Pick<SignalFilter, 'state' | 'dir' | 'live' | 'outcome'>; tone: string; title: string }>;
type Tab = keyof typeof TABS;

/**
 * The table's columns, each sortable both ways on the server (so the order
 * holds across every page). A first click sorts high to low (newest first),
 * a second low to high.
 */
const COLUMNS: { sort: SignalSort; label: string; cls?: string; title?: string }[] = [
  { sort: 'time', label: 'Signal time' },
  { sort: 'method', label: 'Method' },
  { sort: 'way', label: 'Way · TF' },
  { sort: 'signal', label: 'Signal' },
  { sort: 'ltp', label: 'LTP · Index', cls: 'hidden lg:table-cell', title: "The market when the signal appeared: the perpetual's last trade, and Delta's BTC index" },
  { sort: 'entry', label: 'Entry zone' },
  { sort: 'sl', label: 'SL' },
  { sort: 'tp1', label: 'TGT1', title: "TGT1 (TP1): where the record's trade exits" },
  { sort: 'tp2', label: 'TGT2', title: 'TGT2: watched by the runner after TGT1, its stop at breakeven' },
  { sort: 'tp3', label: 'TGT3', title: "TGT3: the runner's last target" },
  { sort: 'fill', label: 'Entry', title: "Where and when it filled (the 1m bar), against the zone's edge" },
  { sort: 'exit', label: 'Exit', title: 'Where and when it went out -- SL, TGT or time -- and how that stood against the level' },
  { sort: 'result', label: 'Result', title: 'Points from the fill to the exit, in the trade’s favour, and R' },
  { sort: 'score', label: 'Quality', cls: 'hidden md:table-cell' },
  { sort: 'stood', label: 'Stood', cls: 'hidden xl:table-cell' },
];

/** How long a signal stood: "just now", "4 min", "1 h 12 min". */
export function stood(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** What became of a signal, in words and a colour. */
export function outcomeOf(s: EntrySignal): { text: string; cls: string } {
  if (s.state === 'WAIT') return { text: 'waited', cls: 'text-muted-foreground' };
  const o = s.outcome;
  if (!o) return { text: 'not logged', cls: 'text-muted-foreground' };
  const r = o.rNet === null ? '' : ` ${o.rNet >= 0 ? '+' : '−'}${Math.abs(o.rNet).toFixed(2)}R`;
  switch (o.status) {
    case 'open': return { text: 'waiting for price', cls: 'text-[var(--warn)]' };
    case 'filled': return { text: `in the trade @ ${fmt(o.fillPrice)}`, cls: 'text-[#3b82f6]' };
    case 'tp1': return { text: `TP1 ✓${r}`, cls: 'text-[var(--up)]' };
    case 'stop': return { text: `stop ✗${r}`, cls: 'text-[var(--down)]' };
    case 'timeout': return { text: `timed out${r}`, cls: 'text-muted-foreground' };
    case 'expired': return { text: 'expired, never filled', cls: 'text-muted-foreground' };
    case 'missed': return { text: 'missed -- ran to TGT1 unfilled', cls: 'text-[var(--warn)]' };
    default: return { text: o.status, cls: 'text-muted-foreground' };
  }
}

/**
 * How the exit stood against its level, in words. TP1 is a limit: exactly the
 * level. The stop is a stop-market: the level, or -- when the minute opened
 * already past it -- that open, as a real stop would have filled.
 */
export function exitNote(s: EntrySignal): { text: string; gap: boolean } | null {
  const o = s.outcome;
  if (!o || o.exitWhy === null) return null;
  if (o.exitWhy === 'time') return { text: 'closed on time (48 bars), at the bar close', gap: false };
  const lvl = o.status === 'stop' ? 'SL' : 'TGT';
  if (o.exitWhy === 'gap') return { text: `${fmt(o.exitPastPts)} pts past ${lvl} ${fmt(o.exitLevel)} -- the first trade through it, or the minute opening past it (slipped)`, gap: true };
  return { text: `exactly at ${lvl} ${fmt(o.exitLevel)}`, gap: false };
}

/** How the fill stood against the zone's near edge, where a resting limit fills. */
export function fillNote(s: EntrySignal): string | null {
  const o = s.outcome;
  if (!o || o.fillPrice === null || o.fillBetterPts === null) return null;
  return o.fillBetterPts > 0
    ? `${fmt(o.fillBetterPts)} pts better than the ${fmt(o.fillEdge)} edge -- opened inside the zone`
    : `at the zone edge ${fmt(o.fillEdge)}`;
}

/**
 * TGT1, TGT2, TGT3: each level, why it is there, and what became of it --
 * reached (and when), still watched (the trade or the runner is out), or not
 * reached. TGT1 is where the record's trade exits; TGT2 and TGT3 are watched
 * by the runner after it, its stop at breakeven.
 */
export type TargetState = { n: 1 | 2 | 3; level: number | null; why: string | null; hit: number | null; state: 'hit' | 'watching' | 'missed' | 'none' };
export function targetsOf(s: EntrySignal): TargetState[] {
  const o = s.outcome;
  const live = o?.status === 'open' || o?.status === 'filled';
  const running = o?.runner === 'running';
  const t = (n: 1 | 2 | 3, level: number | null, why: string | null | undefined, hit: number | null | undefined, watching: boolean): TargetState => ({
    n, level, why: why ?? null, hit: hit ?? null,
    state: level === null || s.state !== 'TRADE' ? 'none' : hit != null ? 'hit' : watching ? 'watching' : 'missed',
  });
  return [
    t(1, s.tp1, s.why?.tp1, o?.tp1At ?? (o?.status === 'tp1' ? o.exitAt : null), live),
    t(2, s.tp2, s.why?.tp2, o?.tp2At, live || running),
    t(3, s.tp3, s.why?.tp3, o?.tp3At, live || running),
  ];
}

function Target({ t }: { t: TargetState }) {
  if (t.level === null) return <span className="text-muted-foreground">–</span>;
  if (t.state === 'none') return <span className="text-muted-foreground">{fmt(t.level)}</span>;
  return (
    <>
      <span className={t.state === 'hit' ? 'font-semibold text-[var(--up)]' : t.state === 'missed' ? 'text-muted-foreground' : 'text-[var(--up)]'}>{fmt(t.level)}</span>
      <div className="text-[10.5px] text-muted-foreground">
        {t.state === 'hit' ? <span className="text-[var(--up)]">✓ {atText(t.hit!)}</span> : t.state === 'watching' ? 'watching…' : '✗ not reached'}
      </div>
    </>
  );
}

/**
 * The stop, and what became of it: guarding a limit not yet filled, watching
 * a trade, hit (and when), moved to breakeven for the runner after TGT1,
 * never hit (out at a target or on time), or no trade at all (expired or
 * missed -- never filled).
 */
export type StopState = { text: string; tone: 'watch' | 'hit' | 'safe' | 'none' };
export function stopOf(s: EntrySignal): StopState | null {
  const o = s.outcome;
  if (s.state !== 'TRADE' || s.stop === null || !o) return null;
  switch (o.status) {
    case 'open': return { text: 'guards the order', tone: 'watch' };
    case 'filled': return { text: 'watching…', tone: 'watch' };
    case 'stop': return { text: `✗ hit${o.exitAt !== null ? ` ${atText(o.exitAt)}` : ''}`, tone: 'hit' };
    case 'tp1':
      if (o.runner === 'running') return { text: `→ breakeven ${fmt(o.fillPrice)}`, tone: 'watch' };
      return { text: o.runnerEnd === 'be' ? '✓ never hit · runner out at BE' : '✓ never hit', tone: 'safe' };
    case 'timeout': return { text: '✓ never hit', tone: 'safe' };
    case 'expired': return { text: 'not filled', tone: 'none' };
    case 'missed': return { text: 'not filled -- missed', tone: 'none' };
    default: return null;
  }
}

function StopCell({ s }: { s: EntrySignal }) {
  const st = stopOf(s);
  return (
    <>
      <span className="text-[var(--down)]">{fmt(s.stop)}</span>
      {st ? (
        <div className={cn('text-[10.5px]', st.tone === 'hit' ? 'font-semibold text-[var(--down)]' : st.tone === 'safe' ? 'text-[var(--up)]' : 'text-muted-foreground')}>
          {st.text}
        </div>
      ) : null}
    </>
  );
}

/** The exit, and why: TGT (TP1), SL, or time. Null until it has exited. */
export function exitOf(s: EntrySignal): { price: string; why: 'TGT' | 'SL' | 'time'; pts: number | null } | null {
  const o = s.outcome;
  if (!o || o.exitPrice === null || !['tp1', 'stop', 'timeout'].includes(o.status)) return null;
  const why = o.status === 'tp1' ? 'TGT' : o.status === 'stop' ? 'SL' : 'time';
  const pts = o.fillPrice === null ? null : (o.exitPrice - o.fillPrice) * s.dir;
  return { price: fmt(o.exitPrice), why, pts };
}

type Filter = { tab: Tab; mode: 'all' | EntryMode; tf: 'all' | EntryTf; today: boolean; size: (typeof PAGE_SIZES)[number]; sort: SignalSort; asc: boolean };
const DEFAULT: Filter = { tab: 'all', mode: 'all', tf: 'all', today: true, size: 25, sort: 'time', asc: false };

/**
 * A filter saved in this browser, made safe: a timeframe, way, tab, size or
 * column that no longer exists (1m before it became chart-only, the R:R
 * column) goes back to its default -- else it would filter or sort by
 * something with no chip to see or undo it, and the list could look empty.
 */
export function cleanFilter(saved: Partial<Filter> | null | undefined): Filter {
  const s = { ...DEFAULT, ...(saved ?? {}) };
  return {
    tab: Object.hasOwn(TABS, s.tab) ? s.tab : DEFAULT.tab,
    mode: s.mode === 'single' || s.mode === 'mtf' ? s.mode : 'all',
    tf: s.tf === 'all' || TFS.includes(s.tf) ? s.tf : 'all',
    today: typeof s.today === 'boolean' ? s.today : DEFAULT.today,
    size: (PAGE_SIZES as readonly number[]).includes(s.size) ? s.size : DEFAULT.size,
    sort: COLUMNS.some((c) => c.sort === s.sort) ? s.sort : DEFAULT.sort,
    asc: s.asc === true,
  };
}

export function SignalHistory() {
  const [saved, setF] = usePersisted<Filter>('entry:history-table', DEFAULT);
  const f = cleanFilter(saved);
  const [page, setPage] = usePersisted<number>('entry:history-page', 0);
  const since = f.today ? startOfIstDay(Date.now()) : undefined;
  const query: SignalFilter = {
    ...TABS[f.tab].q, mode: f.mode === 'all' ? undefined : f.mode, tf: f.tf === 'all' ? undefined : f.tf, since,
    limit: f.size, offset: page * f.size, sort: f.sort, asc: f.asc || undefined,
  };
  const { data, loading, error } = usePoll(() => getEntrySignals(query), 5_000,
    { deps: [f.tab, f.mode, f.tf, f.today, f.size, f.sort, f.asc, page] });
  const rows = data?.signals ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / f.size));
  // A filter that shrinks the list must not leave the page past its end.
  useEffect(() => { if (data && page > 0 && page >= pages) setPage(pages - 1); }, [data, page, pages, setPage]);
  const set = (next: Partial<Filter>) => { setF((cur) => ({ ...DEFAULT, ...cur, ...next })); setPage(0); };
  const sortBy = (col: Filter['sort']) => set(f.sort === col ? { asc: !f.asc } : { sort: col, asc: false });
  const chip = (on: boolean) => cn('px-2.5 py-1', on ? 'bg-[#2563eb] font-semibold text-white' : 'text-muted-foreground hover:bg-muted hover:text-foreground');
  const aria = (col: Filter['sort']) => (f.sort === col ? (f.asc ? 'ascending' : 'descending') : 'none');
  const from = total ? page * f.size + 1 : 0;
  const to = Math.min(total, (page + 1) * f.size);
  // Counters tick only while a row on this page is still in play.
  const now = useNow(rows.some((s) => s.outcome?.status === 'open' || s.outcome?.status === 'filled' || s.outcome?.runner === 'running'));

  return (
    <section aria-label="signal history" className="mt-3 rounded-xl border border-border border-t-4 border-t-[#2563eb] bg-[var(--panel)] p-3 text-[12px] shadow-[0_2px_12px_rgba(0,0,0,0.35)]">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="m-0 text-[13px] font-bold">Signal history</h3>
          <p className="m-0 text-[11px] text-muted-foreground">Every signal the server kept, whichever chart was on screen</p>
        </div>
      </div>
      {/* Signals, then how each TRADE ended; one row that scrolls sideways on a phone rather than wrapping into a block. */}
      <div role="tablist" aria-label="signal tabs" className="mb-2 flex max-w-full gap-1 overflow-x-auto pb-0.5 text-[12px] [scrollbar-width:thin]">
        {(Object.keys(TABS) as Tab[]).map((t, k) => (
          <button key={t} type="button" role="tab" aria-selected={f.tab === t} onClick={() => set({ tab: t })} title={TABS[t].title}
                  style={f.tab === t ? { background: TABS[t].tone, borderColor: TABS[t].tone } : undefined}
                  className={cn('shrink-0 rounded-md border px-2.5 py-1 font-semibold', k === 6 && 'ml-2',
                    f.tab === t ? 'text-white' : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground')}>
            {t === 'trading' ? <span aria-hidden className="mr-1 inline-block size-1.5 rounded-full bg-[#26a17b] align-middle" /> : null}
            {TABS[t].label}
          </button>
        ))}
      </div>

      {/* The filters, each group named; on a phone they wrap, and the timeframes scroll inside their own row. */}
      <div className="mb-2 flex flex-wrap items-end gap-x-3 gap-y-2 text-[11.5px]">
        <Field label="Way">
          <div role="group" aria-label="history way" className="inline-flex overflow-hidden rounded-md border border-border">
            {(['all', 'single', 'mtf'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={f.mode === m} onClick={() => set({ mode: m })} className={chip(f.mode === m)}>
                {m === 'all' ? 'Both ways' : m === 'single' ? 'Without TF' : 'With TF'}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Timeframe" grow>
          <div role="group" aria-label="history timeframe" className="flex max-w-full overflow-x-auto rounded-md border border-border [scrollbar-width:none]">
            {(['all', ...TFS] as const).map((t) => (
              <button key={t} type="button" aria-pressed={f.tf === t} onClick={() => set({ tf: t })} className={cn('shrink-0', chip(f.tf === t))}>
                {t === 'all' ? 'All TF' : t}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Range">
          <div role="group" aria-label="history range" className="inline-flex overflow-hidden rounded-md border border-border">
            <button type="button" aria-pressed={f.today} onClick={() => set({ today: true })} className={chip(f.today)}>Today</button>
            <button type="button" aria-pressed={!f.today} onClick={() => set({ today: false })} className={chip(!f.today)}>All days</button>
          </div>
        </Field>
        {f.tab !== DEFAULT.tab || f.mode !== DEFAULT.mode || f.tf !== DEFAULT.tf || f.today !== DEFAULT.today ? (
          <button type="button" onClick={() => set({ tab: DEFAULT.tab, mode: DEFAULT.mode, tf: DEFAULT.tf, today: DEFAULT.today })}
                  className="rounded-md px-2 py-1 font-semibold text-[#3b82f6] hover:bg-muted">
            Clear filters
          </button>
        ) : null}
        {/* Every row the filters match, in this order -- not just the page on screen. */}
        <a href={entrySignalsCsvUrl({ ...query, limit: undefined, offset: undefined } as Omit<SignalFilter, 'limit' | 'offset'>)} download
           aria-label="download for Excel" title={`Every signal these filters match${total ? ` (${total})` : ''}, in this order, as a spreadsheet (CSV, opens in Excel)`}
           className="ml-auto inline-flex items-center gap-1 rounded-md border border-[#26a17b] px-2.5 py-1 font-semibold text-[#26a17b] hover:bg-[#26a17b]/10">
          <Download size={13} aria-hidden /> Excel{total ? ` · ${total}` : ''}
        </a>
      </div>

      {data ? <Summary s={data.summary} /> : null}

      {error && !data ? <p role="alert" className="m-0 text-[var(--down)]">Could not read the history: {error.message}</p> : null}
      {!rows.length ? (
        <p className="m-0 py-3 text-center text-muted-foreground">
          {loading && !data ? 'Reading…' : f.tab === 'trading' ? 'Nothing in play right now -- no TRADE waiting at its zone or filled. Closed ones are under BUY & SELL.' : 'outcome' in TABS[f.tab].q ? `No TRADE ended ${TABS[f.tab].label} for these filters.` : 'No signals for these filters yet. The server keeps every WAIT and TRADE as it forms, once a minute.'}
          {data && f.today ? (
            <> <button type="button" onClick={() => set({ today: false })} className="font-semibold text-[#3b82f6] underline">Show all days</button> -- &quot;Today&quot; starts at 00:00 IST.</>
          ) : null}
        </p>
      ) : (
        <>
          {/* On a phone, a card per signal -- a table there only scrolls sideways. */}
          <ul aria-label="signals as cards" className="m-0 grid list-none gap-1.5 p-0 sm:hidden">
            {rows.map((s) => <Card key={keyOf(s, 'c')} s={s} now={now} />)}
          </ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full border-collapse tabular-nums" aria-label="signals">
              <thead className="text-left text-[10.5px] text-muted-foreground">
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.sort} className={cn('py-1 pr-2 align-bottom', c.cls)} aria-sort={aria(c.sort)} title={c.title}>
                      <button type="button" onClick={() => sortBy(c.sort)}
                              className={cn('inline-flex items-center gap-0.5 font-semibold uppercase hover:text-foreground', f.sort === c.sort && 'text-foreground')}>
                        {c.label}<span aria-hidden className={cn('text-[9px]', f.sort === c.sort ? 'opacity-100' : 'opacity-30')}>{f.sort === c.sort ? (f.asc ? '▲' : '▼') : '↕'}</span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const out = outcomeOf(s);
                  const ex = exitOf(s);
                  const o = s.outcome;
                  const en = exitNote(s);
                  const fn = fillNote(s);
                  return (
                    <tr key={keyOf(s, 'r')} className="border-t border-border align-top"
                        title={`${s.reason}${s.gatesOff.length ? ` -- gates off: ${s.gatesOff.join(', ')}` : ''}`}>
                      <td className="whitespace-nowrap py-1 pr-2"><Times s={s} /></td>
                      <td className="min-w-[110px] pr-2">#{s.n ?? '?'} {s.name}</td>
                      <td className="whitespace-nowrap pr-2 text-muted-foreground">{s.mode === 'mtf' ? 'With TF' : 'Without'} · {s.tf}</td>
                      <td className="whitespace-nowrap pr-2"><SignalTag s={s} /></td>
                      <td className="hidden whitespace-nowrap pr-2 text-muted-foreground lg:table-cell">{fmt(s.ltp)} · {fmt(s.indexPrice)}</td>
                      <td className="whitespace-nowrap pr-2">{s.entryLo === null ? '–' : `${fmt(s.entryLo)}–${fmt(s.entryHi)}`}</td>
                      <td aria-label="SL" className="whitespace-nowrap pr-2" title={s.why?.stop ?? undefined}><StopCell s={s} /></td>
                      {targetsOf(s).map((t) => (
                        <td key={t.n} aria-label={`TGT${t.n}`} className="whitespace-nowrap pr-2" title={t.why ?? undefined}><Target t={t} /></td>
                      ))}
                      <td className="whitespace-nowrap pr-2">
                        {o?.fillPrice != null ? fmt(o.fillPrice) : '–'}
                        {o?.filledAt != null ? (
                          <div className="text-[10.5px] text-muted-foreground" title={fn ? `fill ${fn}` : undefined}>
                            {atText(o.filledAt)}{o.fillBetterPts ? <span className="text-[var(--up)]"> · {fmt(o.fillBetterPts)} better</span> : ' · at edge'}
                          </div>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap pr-2">
                        {ex ? <>{ex.price} <span className={cn('text-[10.5px] font-bold', ex.why === 'TGT' ? 'text-[var(--up)]' : ex.why === 'SL' ? 'text-[var(--down)]' : 'text-muted-foreground')}>{ex.why}</span></> : '–'}
                        {o?.exitAt != null ? (
                          <div className={cn('text-[10.5px]', en?.gap ? 'text-[var(--warn)]' : 'text-muted-foreground')} title={en ? `exit ${en.text}` : undefined}>
                            {atText(o.exitAt)}{en ? ` · ${en.gap ? `${fmt(o.exitPastPts)} past (slipped)` : o.exitWhy === 'time' ? 'on time' : 'at level'}` : ''}
                          </div>
                        ) : null}
                      </td>
                      <td className={cn('whitespace-nowrap pr-2', out.cls)}>
                        {out.text}{ex?.pts != null ? <>{' '}<span className="ml-1 text-[10.5px]">({signedPts(ex.pts)} pts)</span></> : null}
                        <Counter s={s} now={now} />
                      </td>
                      <td className="hidden pr-2 md:table-cell">{s.score ?? '–'}</td>
                      <td className="hidden whitespace-nowrap pr-2 text-muted-foreground xl:table-cell">{stood(s.lastSeen - s.firstSeen)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {total ? (
        <nav aria-label="history pages" className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
          <span className="text-muted-foreground">{from}–{to} of {total}</span>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">rows</span>
            <div role="group" aria-label="rows per page" className="inline-flex overflow-hidden rounded border border-border">
              {PAGE_SIZES.map((n) => (
                <button key={n} type="button" aria-pressed={f.size === n} onClick={() => set({ size: n })} className={chip(f.size === n)}>{n}</button>
              ))}
            </div>
            <button type="button" aria-label="previous page" disabled={page === 0} onClick={() => setPage(page - 1)}
                    className="inline-flex items-center rounded border border-border px-1.5 py-0.5 disabled:opacity-40"><ChevronLeft size={14} aria-hidden /> Prev</button>
            <span>Page {page + 1} of {pages}</span>
            <button type="button" aria-label="next page" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}
                    className="inline-flex items-center rounded border border-border px-1.5 py-0.5 disabled:opacity-40">Next <ChevronRight size={14} aria-hidden /></button>
          </div>
        </nav>
      ) : null}
    </section>
  );
}

const keyOf = (s: EntrySignal, p: string) => `${p}:${s.mode}:${s.tf}:${s.method}:${s.dir}:${s.triggerAt}:${s.state}`;

function SignalTag({ s }: { s: EntrySignal }) {
  const side = s.dir === 1 ? 'BUY' : 'SELL';
  return (
    <>
      <span className={cn('rounded px-1 font-bold', s.state === 'WAIT' ? 'bg-[#b7791f] text-white' : s.dir === 1 ? 'bg-[#26a17b] text-white' : 'bg-[#e2504f] text-white')}>
        {s.state === 'WAIT' ? `WAIT ${side}` : side}
      </span>
      {s.gatesOff.length ? <span className="ml-1 text-[10px] text-[var(--warn)]" title={`gates off: ${s.gatesOff.join(', ')}`}>gates off</span> : null}
    </>
  );
}

/** Over every signal matching the filters, not only this page. */
function Summary({ s }: { s: EntrySignalSummary }) {
  const closed = s.tp1 + s.stops + s.timeouts;
  const cell = (k: string, v: string, sub: string, tone: 'up' | 'down' | 'none') => (
    <div className={cn('rounded-lg border border-border border-l-4 px-2.5 py-1.5',
      tone === 'up' ? 'border-l-[var(--up)] bg-[var(--up-bg)]' : tone === 'down' ? 'border-l-[var(--down)] bg-[var(--down-bg)]' : 'border-l-[var(--dim)] bg-[var(--bg)]')}>
      <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{k}</div>
      <div className={cn('text-[16px] font-bold leading-tight tabular-nums', tone === 'up' ? 'text-[var(--up)]' : tone === 'down' ? 'text-[var(--down)]' : '')}>{v}</div>
      <div className="text-[10.5px] text-muted-foreground tabular-nums">{sub}</div>
    </div>
  );
  return (
    <div aria-label="history totals" className="mb-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6">
      {cell('TRADEs', String(s.trades), `${closed} closed${s.open ? ` · ${s.open} open` : ''}`, 'none')}
      {cell('TGT1 hits', `${s.tp1}`, `${signedPts(s.tp1Pts)} pts`, 'up')}
      {cell('SL hits', `${s.stops}`, `−${fmt(s.slPts)} pts`, 'down')}
      {cell('Timed out', `${s.timeouts}`, `${signedPts(s.timeoutPts)} pts`, 'none')}
      {cell('TGT2 · TGT3', `${s.tp2} · ${s.tp3}`, 'reached by the runner', 'up')}
      {cell('Net pts', signedPts(s.netPts), `= ${signedPts(s.tp1Pts)} − ${fmt(s.slPts)} ${s.timeoutPts < 0 ? '−' : '+'} ${fmt(Math.abs(s.timeoutPts))}`, s.netPts >= 0 ? 'up' : 'down')}
    </div>
  );
}

/**
 * When it was seen, against its trigger bar. Seen within a minute of that
 * bar's close, it is latency ("trigger bar 06:51:00 · seen +3 s"). Later, it
 * is not a delay: the setup is anchored to an older bar (a retest, a gap, an
 * order block) and formed since -- so it says the time, not a lag.
 */
export function seenText(s: Pick<EntrySignal, 'barCloseAt' | 'seenAfterMs' | 'firstSeen'>): string {
  const bar = `trigger bar ${SECS.format(s.barCloseAt * 1000)}`;
  return s.seenAfterMs <= 60_000 ? `${bar} · seen ${lag(s.seenAfterMs)}` : `${bar} · formed ${SECS.format(s.firstSeen)}`;
}

/** When: the signal (seen), the bar it closed on and how soon after it was seen, and the alert if one went. */
function Times({ s }: { s: EntrySignal }) {
  return (
    <>
      <div>{TIME.format(s.firstSeen)}</div>
      <div className="text-[10.5px] text-muted-foreground" title="The trigger bar's close, and how long after it the server saw the signal (it reads each minute + 3 s)">
        {seenText(s)}
      </div>
      {s.alert ? (
        <div className={cn('text-[10.5px]', s.alert.status === 'sent' ? 'text-muted-foreground' : 'text-[var(--down)]')}>
          alert {s.alert.status === 'sent' ? '✓' : '✗'} {SECS.format(s.alert.at)} {lag(s.alert.at - s.barCloseAt * 1000)}
        </div>
      ) : null}
    </>
  );
}

/** Under the prices: when it filled and went out (the 1m bar), and how each stood against the plan. */
function FillExitDetail({ s }: { s: EntrySignal }) {
  const o = s.outcome;
  if (!o || o.filledAt === null) return null;
  const fn = fillNote(s);
  const en = exitNote(s);
  return (
    <div className="text-[10.5px] text-muted-foreground">
      <div title="The 1m bar the fill and the exit came in">in {atText(o.filledAt)}{o.exitAt !== null ? ` → out ${atText(o.exitAt)}` : ''}</div>
      {fn ? <div>fill {fn}</div> : null}
      {en ? <div className={en.gap ? 'text-[var(--warn)]' : undefined}>exit {en.text}</div> : null}
    </div>
  );
}

/** A TRADE still in play: its fill window, or its time in the trade and to the time-out, counting. */
function Counter({ s, now }: { s: EntrySignal; now: number }) {
  const o = s.outcome;
  if (!o || (o.status !== 'open' && o.status !== 'filled' && o.runner !== 'running')) return null;
  const c = clockText(o, now);
  return c ? <div aria-label="counter" className="text-[10.5px] text-foreground">{c.label} <b className="tabular-nums">{c.value}</b></div> : null;
}

function Card({ s, now }: { s: EntrySignal; now: number }) {
  const out = outcomeOf(s);
  const ex = exitOf(s);
  return (
    <li className="rounded-lg border border-border bg-[var(--bg)] p-2 tabular-nums">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">#{s.n ?? '?'} {s.name}</span>
        <span><SignalTag s={s} /></span>
      </div>
      <div className="text-[11px] text-muted-foreground">
        {TIME.format(s.firstSeen)} · {s.mode === 'mtf' ? 'With TF' : 'Without'} · {s.tf} · stood {stood(s.lastSeen - s.firstSeen)}
        {s.ltp !== null ? ` · LTP ${fmt(s.ltp)}` : ''}{s.indexPrice !== null ? ` · index ${fmt(s.indexPrice)}` : ''}
      </div>
      {s.entryLo !== null ? (
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11.5px]">
          <span>Entry {fmt(s.entryLo)}–{fmt(s.entryHi)}</span>
        </div>
      ) : null}
      {s.state === 'TRADE' && s.tp1 !== null ? (
        <div aria-label="targets" className="mt-0.5 grid grid-cols-2 gap-1 text-[11.5px] min-[380px]:grid-cols-4">
          <div className="rounded bg-muted/50 px-1.5 py-0.5"><span className="text-[10px] text-muted-foreground">SL </span><StopCell s={s} /></div>
          {targetsOf(s).map((t) => (
            <div key={t.n} className="rounded bg-muted/50 px-1.5 py-0.5"><span className="text-[10px] text-muted-foreground">TGT{t.n} </span><Target t={t} /></div>
          ))}
        </div>
      ) : null}
      {ex ? <div className="text-[11.5px]">Fill {fmt(s.outcome?.fillPrice)} → exit {ex.price} ({ex.why}){ex.pts !== null ? ` · ${signedPts(ex.pts)} pts` : ''}</div> : null}
      {s.why?.stop ? <div className="text-[10.5px] text-muted-foreground">SL at {s.why.stop}</div> : null}
      <FillExitDetail s={s} />
      <div className="text-[10.5px] text-muted-foreground">
        {seenText(s)}
        {s.alert ? ` · alert ${s.alert.status === 'sent' ? '✓' : '✗'} ${SECS.format(s.alert.at)}` : ''}
      </div>
      <div className={cn('mt-0.5 text-[11.5px] font-semibold', out.cls)}>{out.text}</div>
      <Counter s={s} now={now} />
    </li>
  );
}

/** A named group of filters: its label above it, small. */
function Field({ label, grow = false, children }: { label: string; grow?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', grow && 'max-w-full')}>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** Midnight in IST, as epoch ms: the desk's "today". */
export function startOfIstDay(now: number): number {
  const IST = 5.5 * 3_600_000;
  return Math.floor((now + IST) / 86_400_000) * 86_400_000 - IST;
}
