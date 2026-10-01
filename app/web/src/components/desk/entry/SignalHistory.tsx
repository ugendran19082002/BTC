import { useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { getEntrySignals, type SignalFilter } from '@/api/entry';
import { cn } from '@/lib/utils';
import type { EntryMode, EntrySignal, EntrySignalSummary, EntryTf } from '@/types/entry';
import { MINS, SECS, clockText, lag, useNow } from './clock';

/**
 * Every signal the server kept (the journal, entry_signals), as a data table:
 * signal tabs (all, BUY & SELL, BUY, SELL, WAIT), way and timeframe filters,
 * today or all days, columns sortable on the server, pages of 25 / 50 / 100 --
 * and over everything matching, the TRADEs, TP1 hits and the points they made,
 * stops and the points they lost, and the net. Each row: when, the price then
 * (LTP and index), the levels, and for a TRADE the fill, the exit and why it
 * exited, in points and R. Refreshed every 15 s; the choices are remembered.
 */

// Not 1m: chart-only without the chain, so it gives no signal and the server keeps none.
const TFS: readonly EntryTf[] = ['3m', '5m', '15m', '30m', '1h', '4h'];
const PAGE_SIZES = [25, 50, 100] as const;
const TIME = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '–' : Math.round(v).toLocaleString('en-US'));
const signedPts = (v: number) => `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v))}`;

/** The signal tabs, and what each asks the server for. */
export const TABS = {
  all: { label: 'All', q: {} },
  // In play now: waiting at the zone or filled, not yet out at TP1, the stop or time.
  trading: { label: 'TRADING', q: { state: 'TRADE', live: true } },
  trades: { label: 'BUY & SELL', q: { state: 'TRADE' } },
  buy: { label: 'BUY', q: { state: 'TRADE', dir: 1 } },
  sell: { label: 'SELL', q: { state: 'TRADE', dir: -1 } },
  wait: { label: 'WAIT', q: { state: 'WAIT' } },
} as const satisfies Record<string, { label: string; q: Pick<SignalFilter, 'state' | 'dir' | 'live'> }>;
type Tab = keyof typeof TABS;

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
  if (o.exitWhy === 'gap') return { text: `${fmt(o.exitPastPts)} pts past ${lvl} ${fmt(o.exitLevel)} -- the minute opened past it (gap)`, gap: true };
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

/** The exit, and why: TGT (TP1), SL, or time. Null until it has exited. */
export function exitOf(s: EntrySignal): { price: string; why: 'TGT' | 'SL' | 'time'; pts: number | null } | null {
  const o = s.outcome;
  if (!o || o.exitPrice === null || !['tp1', 'stop', 'timeout'].includes(o.status)) return null;
  const why = o.status === 'tp1' ? 'TGT' : o.status === 'stop' ? 'SL' : 'time';
  const pts = o.fillPrice === null ? null : (o.exitPrice - o.fillPrice) * s.dir;
  return { price: fmt(o.exitPrice), why, pts };
}

type Filter = { tab: Tab; mode: 'all' | EntryMode; tf: 'all' | EntryTf; today: boolean; size: (typeof PAGE_SIZES)[number]; sort: 'time' | 'score' | 'rr'; asc: boolean };
const DEFAULT: Filter = { tab: 'all', mode: 'all', tf: 'all', today: true, size: 25, sort: 'time', asc: false };

export function SignalHistory() {
  const [saved, setF] = usePersisted<Filter>('entry:history-table', DEFAULT);
  const f = { ...DEFAULT, ...saved };
  const [page, setPage] = usePersisted<number>('entry:history-page', 0);
  const since = f.today ? startOfIstDay(Date.now()) : undefined;
  const query: SignalFilter = {
    ...TABS[f.tab].q, mode: f.mode === 'all' ? undefined : f.mode, tf: f.tf === 'all' ? undefined : f.tf, since,
    limit: f.size, offset: page * f.size, sort: f.sort, asc: f.asc || undefined,
  };
  const { data, loading, error } = usePoll(() => getEntrySignals(query), 15_000,
    { deps: [f.tab, f.mode, f.tf, f.today, f.size, f.sort, f.asc, page] });
  const rows = data?.signals ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / f.size));
  // A filter that shrinks the list must not leave the page past its end.
  useEffect(() => { if (data && page > 0 && page >= pages) setPage(pages - 1); }, [data, page, pages, setPage]);
  const set = (next: Partial<Filter>) => { setF((cur) => ({ ...DEFAULT, ...cur, ...next })); setPage(0); };
  const sortBy = (col: Filter['sort']) => set(f.sort === col ? { asc: !f.asc } : { sort: col, asc: false });
  const chip = (on: boolean) => cn('px-2 py-0.5', on ? 'bg-[#2563eb] text-white' : 'text-muted-foreground');
  const sortMark = (col: Filter['sort']) => (f.sort === col ? (f.asc ? ' ▲' : ' ▼') : '');
  const aria = (col: Filter['sort']) => (f.sort === col ? (f.asc ? 'ascending' : 'descending') : 'none');
  const from = total ? page * f.size + 1 : 0;
  const to = Math.min(total, (page + 1) * f.size);
  // Counters tick only while a row on this page is still in play.
  const now = useNow(rows.some((s) => s.outcome?.status === 'open' || s.outcome?.status === 'filled'));

  return (
    <section aria-label="signal history" className="mt-3 rounded-xl border border-border p-2.5 text-[12px]">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="m-0 text-[13px] font-bold">Signal history</h3>
          <p className="m-0 text-[11px] text-muted-foreground">Every signal the server kept, whichever chart was on screen</p>
        </div>
        <div role="tablist" aria-label="signal tabs" className="inline-flex overflow-hidden rounded-md border border-border text-[12px]">
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={f.tab === t} onClick={() => set({ tab: t })}
                    title={t === 'trading' ? 'In play now: waiting at the zone or filled, not yet out at TP1, the stop or time' : undefined}
                    className={cn('px-2.5 py-1 font-semibold', f.tab === t
                      ? t === 'buy' ? 'bg-[#26a17b] text-white' : t === 'sell' ? 'bg-[#e2504f] text-white' : t === 'wait' ? 'bg-[#b7791f] text-white' : 'bg-[#2563eb] text-white'
                      : 'text-muted-foreground')}>
              {t === 'trading' ? <span aria-hidden className="mr-1 inline-block size-1.5 rounded-full bg-[#26a17b] align-middle" /> : null}
              {TABS[t].label}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        <div role="group" aria-label="history way" className="inline-flex overflow-hidden rounded border border-border">
          {(['all', 'single', 'mtf'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={f.mode === m} onClick={() => set({ mode: m })} className={chip(f.mode === m)}>
              {m === 'all' ? 'Both ways' : m === 'single' ? 'Without TF' : 'With TF'}
            </button>
          ))}
        </div>
        <div role="group" aria-label="history timeframe" className="inline-flex overflow-hidden rounded border border-border">
          {(['all', ...TFS] as const).map((t) => (
            <button key={t} type="button" aria-pressed={f.tf === t} onClick={() => set({ tf: t })} className={chip(f.tf === t)}>
              {t === 'all' ? 'All TF' : t}
            </button>
          ))}
        </div>
        <button type="button" aria-pressed={f.today} onClick={() => set({ today: !f.today })} className={cn('rounded border border-border', chip(f.today))}>
          {f.today ? 'Today' : 'All days'}
        </button>
      </div>

      {data ? <Summary s={data.summary} /> : null}

      {error && !data ? <p role="alert" className="m-0 text-[var(--down)]">Could not read the history: {error.message}</p> : null}
      {!rows.length ? (
        <p className="m-0 py-3 text-center text-muted-foreground">
          {loading && !data ? 'Reading…' : f.tab === 'trading' ? 'Nothing in play right now -- no TRADE waiting at its zone or filled. Closed ones are under BUY & SELL.' : 'No signals for these filters yet. The server keeps every WAIT and TRADE as it forms, once a minute.'}
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
                  <th className="py-1 pr-2" aria-sort={aria('time')}>
                    <button type="button" onClick={() => sortBy('time')} className="font-semibold uppercase">Time (IST){sortMark('time')}</button>
                  </th>
                  <th className="pr-2">Method</th>
                  <th className="pr-2">Way · TF</th>
                  <th className="pr-2">Signal</th>
                  <th className="hidden pr-2 lg:table-cell" title="The market when the signal appeared: the perpetual's last trade, and Delta's BTC index">LTP · Index</th>
                  <th className="pr-2">Entry</th>
                  <th className="pr-2">SL</th>
                  <th className="pr-2">TP1</th>
                  <th className="pr-2" title="Where and when it filled, where and when it went out (the 1m bar), and how the exit stood against its level">Fill → Exit</th>
                  <th className="pr-2">Result</th>
                  <th className="hidden pr-2 md:table-cell" aria-sort={aria('rr')}>
                    <button type="button" onClick={() => sortBy('rr')} className="font-semibold uppercase">R:R{sortMark('rr')}</button>
                  </th>
                  <th className="hidden pr-2 md:table-cell" aria-sort={aria('score')}>
                    <button type="button" onClick={() => sortBy('score')} className="font-semibold uppercase">Quality{sortMark('score')}</button>
                  </th>
                  <th className="hidden pr-2 xl:table-cell">Stood</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const out = outcomeOf(s);
                  const ex = exitOf(s);
                  return (
                    <tr key={keyOf(s, 'r')} className="border-t border-border align-top"
                        title={`${s.reason}${s.gatesOff.length ? ` -- gates off: ${s.gatesOff.join(', ')}` : ''}`}>
                      <td className="whitespace-nowrap py-1 pr-2"><Times s={s} /></td>
                      <td className="pr-2">#{s.n ?? '?'} {s.name}</td>
                      <td className="whitespace-nowrap pr-2 text-muted-foreground">{s.mode === 'mtf' ? 'With TF' : 'Without'} · {s.tf}</td>
                      <td className="whitespace-nowrap pr-2"><SignalTag s={s} /></td>
                      <td className="hidden whitespace-nowrap pr-2 text-muted-foreground lg:table-cell">{fmt(s.ltp)} · {fmt(s.indexPrice)}</td>
                      <td className="whitespace-nowrap pr-2">{s.entryLo === null ? '–' : `${fmt(s.entryLo)}–${fmt(s.entryHi)}`}</td>
                      <td className="whitespace-nowrap pr-2 text-[var(--down)]">{fmt(s.stop)}</td>
                      <td className="whitespace-nowrap pr-2 text-[var(--up)]">{fmt(s.tp1)}</td>
                      <td className="whitespace-nowrap pr-2">
                        {s.outcome?.fillPrice != null ? fmt(s.outcome.fillPrice) : '–'}
                        {ex ? <> → {ex.price} <span className={cn('text-[10.5px] font-bold', ex.why === 'TGT' ? 'text-[var(--up)]' : ex.why === 'SL' ? 'text-[var(--down)]' : 'text-muted-foreground')}>{ex.why}</span></> : null}
                        <FillExitDetail s={s} />
                      </td>
                      <td className={cn('whitespace-nowrap pr-2', out.cls)}>
                        {out.text}{ex?.pts != null ? <>{' '}<span className="ml-1 text-[10.5px]">({signedPts(ex.pts)} pts)</span></> : null}
                        <Counter s={s} now={now} />
                      </td>
                      <td className="hidden pr-2 md:table-cell">{s.rr === null ? '–' : s.rr.toFixed(2)}</td>
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
  const cell = (k: string, v: string, cls = '') => (
    <div className="rounded bg-muted px-2 py-1">
      <div className="text-[10px] text-muted-foreground">{k}</div>
      <div className={cn('text-[13px] font-bold tabular-nums', cls)}>{v}</div>
    </div>
  );
  return (
    <div aria-label="history totals" className="mb-2 grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-6">
      {cell('TRADEs', `${s.trades}${s.open ? ` · ${s.open} open` : ''}`)}
      {cell('TP1 hits · target pts', `${s.tp1} · ${signedPts(s.tp1Pts)}`, 'text-[var(--up)]')}
      {cell('Stops · SL pts', `${s.stops} · −${fmt(s.slPts)}`, 'text-[var(--down)]')}
      {cell('Timed out', String(s.timeouts))}
      {cell('Net pts', signedPts(s.netPts), s.netPts >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]')}
      {cell('Net R', `${s.netR >= 0 ? '+' : '−'}${Math.abs(s.netR).toFixed(2)}R`, s.netR >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]')}
    </div>
  );
}

/** When: the signal (seen), the bar it closed on and how soon after it was seen, and the alert if one went. */
function Times({ s }: { s: EntrySignal }) {
  return (
    <>
      <div>{TIME.format(s.firstSeen)}</div>
      <div className="text-[10.5px] text-muted-foreground" title="The trigger bar's close, and how long after it the server saw the signal (it reads each minute + 3 s)">
        bar {SECS.format(s.barCloseAt * 1000)} · seen {lag(s.seenAfterMs)}
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
      <div title="The 1m bar the fill and the exit came in">in ~{MINS.format(o.filledAt * 1000)}{o.exitAt !== null ? ` → out ~${MINS.format(o.exitAt * 1000)}` : ''}</div>
      {fn ? <div>fill {fn}</div> : null}
      {en ? <div className={en.gap ? 'text-[var(--warn)]' : undefined}>exit {en.text}</div> : null}
    </div>
  );
}

/** A TRADE still in play: its fill window, or its time in the trade and to the time-out, counting. */
function Counter({ s, now }: { s: EntrySignal; now: number }) {
  const o = s.outcome;
  if (!o || (o.status !== 'open' && o.status !== 'filled')) return null;
  const c = clockText(o, now);
  return c ? <div aria-label="counter" className="text-[10.5px] text-foreground">{c.label} <b className="tabular-nums">{c.value}</b></div> : null;
}

function Card({ s, now }: { s: EntrySignal; now: number }) {
  const out = outcomeOf(s);
  const ex = exitOf(s);
  return (
    <li className="rounded-lg border border-border p-2 tabular-nums">
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
          <span className="text-[var(--down)]">SL {fmt(s.stop)}</span>
          <span className="text-[var(--up)]">TP1 {fmt(s.tp1)}</span>
          {s.rr !== null ? <span className="text-muted-foreground">R:R {s.rr.toFixed(2)}</span> : null}
        </div>
      ) : null}
      {ex ? <div className="text-[11.5px]">Fill {fmt(s.outcome?.fillPrice)} → exit {ex.price} ({ex.why}){ex.pts !== null ? ` · ${signedPts(ex.pts)} pts` : ''}</div> : null}
      <FillExitDetail s={s} />
      <div className="text-[10.5px] text-muted-foreground">
        bar {SECS.format(s.barCloseAt * 1000)} · seen {lag(s.seenAfterMs)}
        {s.alert ? ` · alert ${s.alert.status === 'sent' ? '✓' : '✗'} ${SECS.format(s.alert.at)}` : ''}
      </div>
      <div className={cn('mt-0.5 text-[11.5px] font-semibold', out.cls)}>{out.text}</div>
      <Counter s={s} now={now} />
    </li>
  );
}

/** Midnight in IST, as epoch ms: the desk's "today". */
export function startOfIstDay(now: number): number {
  const IST = 5.5 * 3_600_000;
  return Math.floor((now + IST) / 86_400_000) * 86_400_000 - IST;
}
