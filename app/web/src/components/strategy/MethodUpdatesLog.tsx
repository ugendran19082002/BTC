import { useMemo, useState } from 'react';
import { getMethodUpdates } from '@/api/strategy';
import { getEntryMethods } from '@/api/entry';
import { getAccounts } from '@/api/accounts';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { dayLabel, moneyText } from '@/lib/market-report';
import { cn } from '@/lib/utils';
import { MethodTimeframes } from '@/components/strategy/MethodTimeframes';
import type { MethodRecordLine, MethodUpdate, MethodUpdateSource } from '@/types/strategy';

/**
 * Every change to the signal strategies' methods (owner, 16 Oct 2026: "the daily methods changes, logged, saved in
 * the db, shown in a logs menu and on the phone's More"; then "today, yesterday, last 7, this month, custom -- and a
 * report of which methods keep coming in and going out, easy to read: a table, a chart, whatever is clearest").
 *
 * Two views over the dates picked. Summary: the totals, a bar a day of methods in and out, every method with how
 * often it came and went and how many strategies have it now, and every strategy with its changes -- a row a tap
 * from its changes. Timeline: each change, newest first, by day, its methods and their records a tap away. Shared
 * by the desk's Logs and the phone's More.
 */
type Show = 'all' | MethodUpdateSource;
const SHOW: { v: Show; label: string }[] = [{ v: 'all', label: 'All changes' }, { v: 'daily', label: 'Daily updates' }, { v: 'manual', label: 'Saved by hand' }];
export type RangeKey = 'today' | 'yesterday' | '7d' | 'month' | 'custom';
const RANGES: { v: RangeKey; label: string }[] = [
  { v: 'today', label: 'Today' }, { v: 'yesterday', label: 'Yesterday' }, { v: '7d', label: 'Last 7 days' }, { v: 'month', label: 'This month' }, { v: 'custom', label: 'Custom' },
];
type View = 'tf' | 'summary' | 'timeline';
const VIEWS: { v: View; label: string }[] = [{ v: 'tf', label: 'By time frame' }, { v: 'summary', label: 'Summary' }, { v: 'timeline', label: 'Timeline' }];
const PAGE = 30;
const DAY_MS = 86_400_000;
const IST_MS = 5.5 * 3_600_000;
const istDay = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istTime = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The IST dates a choice covers, both included. A custom range the wrong way round is put the right way. */
export function rangeOf(key: RangeKey, now: number, custom: { from: string; to: string }): { from: string; to: string } {
  const today = istDay(now);
  if (key === 'today') return { from: today, to: today };
  if (key === 'yesterday') return { from: shift(today, -1), to: shift(today, -1) };
  if (key === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  if (key === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(custom.from) && /^\d{4}-\d{2}-\d{2}$/.test(custom.to)) {
    return custom.from <= custom.to ? custom : { from: custom.to, to: custom.from };
  }
  return { from: shift(today, -6), to: today };
}

/** A record in a few words: "4/5 won (80%) · +₹34". */
export function recordWords(r: MethodRecordLine | undefined): string | null {
  if (!r || r.trades === 0) return null;
  return `${r.wins}/${r.trades} won (${Math.round((r.wins / r.trades) * 100)}%) · ${moneyText(r.net)}`;
}

/** The rule and the days, in a line: "Win ≥75% · 3+ trades · Sat 10 Oct – Fri 16 Oct". */
export function ruleWords(u: Pick<MethodUpdate, 'rule' | 'from' | 'to'>): string | null {
  if (!u.rule) return null;
  const days = u.from && u.to ? ` · ${u.from === u.to ? dayLabel(u.from) : `${dayLabel(u.from)} – ${dayLabel(u.to)}`}` : '';
  return `Win ≥${u.rule.winPct}% · ${u.rule.minTrades}+ trades${days}`;
}

export type MethodRow = { method: string; in: number; out: number; nowIn: number; record: MethodRecordLine | null };
export type StrategyRow = { id: string; name: string; accountId: number | null; changes: number; in: number; out: number; first: number; now: number; last: number };
export type Summary = {
  changes: number; kept: number; daily: number; manual: number; strategies: number; in: number; out: number;
  days: { day: string; in: number; out: number }[];
  methods: MethodRow[]; byStrategy: StrategyRow[];
};

/**
 * The changes added up. "Now in" is how many strategies had the method after their latest change in the range;
 * a method's record is the one its latest daily update read, added up over the strategies -- each strategy's own
 * latest only, so overlapping look-backs are not counted twice.
 */
export function summarize(updates: readonly MethodUpdate[], range: { from: string; to: string }): Summary {
  const asc = [...updates].sort((a, b) => a.at - b.at || a.id - b.id);
  const changed = asc.filter((u) => u.added.length + u.dropped.length > 0);
  const days = new Map<string, { in: number; out: number }>();
  // every day of the range, an empty one too, so the chart reads as a calendar (at most 62)
  for (let d = range.from, i = 0; d <= range.to && i < 62; d = shift(d, 1), i++) days.set(d, { in: 0, out: 0 });
  const methods = new Map<string, MethodRow>();
  const row = (m: string) => methods.get(m) ?? methods.set(m, { method: m, in: 0, out: 0, nowIn: 0, record: null }).get(m)!;
  const strategies = new Map<string, StrategyRow>();
  const latest = new Map<string, MethodUpdate>();
  const latestDaily = new Map<string, MethodUpdate>();
  for (const u of asc) {
    const day = days.get(istDay(u.at)) ?? (days.size < 62 ? days.set(istDay(u.at), { in: 0, out: 0 }).get(istDay(u.at))! : null);
    if (day) { day.in += u.added.length; day.out += u.dropped.length; }
    for (const m of u.added) row(m).in++;
    for (const m of u.dropped) row(m).out++;
    const s = strategies.get(u.strategyId) ?? strategies.set(u.strategyId, { id: u.strategyId, name: u.strategyName, accountId: u.accountId, changes: 0, in: 0, out: 0, first: u.before.length, now: 0, last: 0 }).get(u.strategyId)!;
    if (u.added.length + u.dropped.length > 0) s.changes++;
    s.in += u.added.length; s.out += u.dropped.length; s.now = u.after.length; s.last = u.at; s.name = u.strategyName;
    latest.set(u.strategyId, u);
    if (u.source === 'daily' && u.records.length) latestDaily.set(u.strategyId, u);
  }
  for (const u of latest.values()) for (const m of u.after) row(m).nowIn++;
  for (const u of latestDaily.values()) {
    for (const r of u.records) {
      if (!methods.has(r.method)) continue;
      const x = row(r.method);
      x.record = x.record ? { method: r.method, trades: x.record.trades + r.trades, wins: x.record.wins + r.wins, net: x.record.net + r.net } : { ...r };
    }
  }
  return {
    changes: changed.length, kept: asc.length - changed.length,
    daily: asc.filter((u) => u.source === 'daily').length, manual: asc.filter((u) => u.source === 'manual').length,
    strategies: new Set(changed.map((u) => u.strategyId)).size,
    in: changed.reduce((a, u) => a + u.added.length, 0), out: changed.reduce((a, u) => a + u.dropped.length, 0),
    days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, x]) => ({ day, ...x })),
    methods: [...methods.values()],
    byStrategy: [...strategies.values()].sort((a, b) => b.changes - a.changes || a.name.localeCompare(b.name)),
  };
}

type MethodSort = 'moves' | 'in' | 'out' | 'now' | 'win';
const METHOD_SORTS: { v: MethodSort; label: string }[] = [
  { v: 'moves', label: 'Most changes' }, { v: 'in', label: 'Came in most' }, { v: 'out', label: 'Went out most' }, { v: 'now', label: 'In most strategies now' }, { v: 'win', label: 'Best win %' },
];
const winOf = (r: MethodRecordLine | null) => (r && r.trades ? r.wins / r.trades : -1);
export function sortMethods(rows: readonly MethodRow[], by: MethodSort): MethodRow[] {
  const key = (r: MethodRow) => (by === 'in' ? r.in : by === 'out' ? r.out : by === 'now' ? r.nowIn : by === 'win' ? winOf(r.record) : r.in + r.out);
  return [...rows].sort((a, b) => key(b) - key(a) || (b.in + b.out) - (a.in + a.out) || a.method.localeCompare(b.method));
}

export function MethodUpdatesLog({ compact = false, now = Date.now() }: { compact?: boolean; now?: number }) {
  const [savedView, setView] = usePersisted<View>('method-log:view', 'tf');
  const view: View = VIEWS.some((x) => x.v === savedView) ? savedView : 'tf';
  const [rangeKey, setRangeKey] = usePersisted<RangeKey>('method-log:range', '7d');
  const [custom, setCustom] = usePersisted<{ from: string; to: string }>('method-log:custom', { from: shift(istDay(now), -6), to: istDay(now) });
  const [show, setShow] = usePersisted<Show>('method-log:show', 'all');
  const [strategy, setStrategy] = useState('');
  const [method, setMethod] = useState('');
  const [methodSort, setMethodSort] = usePersisted<MethodSort>('method-log:sort', 'moves');
  const [shown, setShown] = useState(PAGE);
  const range = rangeOf(RANGES.some((r) => r.v === rangeKey) ? rangeKey : '7d', now, custom);
  const { data, error } = usePoll(() => getMethodUpdates({ source: show === 'all' ? null : show, from: range.from, to: range.to, limit: 1_000 }), 60_000,
    { deps: [show, range.from, range.to] });
  const { data: catalogue } = usePoll(getEntryMethods, 3_600_000);
  const { data: accounts } = usePoll(getAccounts, 3_600_000);
  const nameOf = useMemo(() => {
    const m = new Map((catalogue?.methods ?? []).map((x) => [x.id, `#${x.n} ${x.name}`]));
    return (id: string) => m.get(id) ?? id;
  }, [catalogue]);
  const accountOf = (id: number | null) => (id === null ? null : accounts?.accounts.find((a) => a.id === id)?.name ?? `Account ${id}`);

  const all = data?.updates ?? [];
  const strategies = useMemo(() => [...new Map(all.map((u) => [u.strategyId, u.strategyName])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [all]);
  const picked = strategies.some(([id]) => id === strategy) ? strategy : '';
  const mine = picked ? all.filter((u) => u.strategyId === picked) : all;
  const summary = useMemo(() => summarize(mine, range), [mine, range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = method ? mine.filter((u) => u.added.includes(method) || u.dropped.includes(method)) : mine;
  const days = useMemo(() => {
    const by = new Map<string, MethodUpdate[]>();
    for (const u of list.slice(0, shown)) (by.get(istDay(u.at)) ?? by.set(istDay(u.at), []).get(istDay(u.at))!).push(u);
    return [...by.entries()];
  }, [list, shown]);
  const chip = (on: boolean) => cn('m-0 h-8 appearance-none rounded-md border border-solid px-2.5 font-[inherit] text-[12px]',
    on ? 'border-foreground bg-muted text-foreground' : 'border-border bg-transparent text-muted-foreground');
  const field = 'h-8 min-w-0 rounded-md border border-solid border-border bg-background px-2 text-[12px] text-foreground';
  const openMethod = (m: string) => { setMethod(m); setView('timeline'); setShown(PAGE); };
  const openStrategy = (id: string) => { setStrategy(id); setMethod(''); setView('timeline'); setShown(PAGE); };
  const rangeWords = range.from === range.to ? dayLabel(range.from) : `${dayLabel(range.from)} – ${dayLabel(range.to)}`;

  return (
    <section aria-label="Method updates" className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3', !compact && 'rounded-lg border border-solid border-border bg-[var(--panel)] p-3')}>
      {!compact && (
        <div>
          <h2 className="m-0 text-[15px] font-semibold">Method updates</h2>
          <p className="m-0 mt-0.5 text-[12px] leading-snug text-muted-foreground">
            Every change to a signal strategy&apos;s methods: the daily update (switched on in the strategy&apos;s Signals tab) and saves by hand.
          </p>
        </div>
      )}

      {/* When: the quick picks, or two dates. */}
      <div className="grid min-w-0 gap-1.5">
        <div role="group" aria-label="Dates" className="flex flex-wrap gap-1">
          {RANGES.map((r) => (
            <button key={r.v} type="button" aria-pressed={rangeKey === r.v} onClick={() => { setRangeKey(r.v); setShown(PAGE); }} className={chip(rangeKey === r.v)}>{r.label}</button>
          ))}
        </div>
        {rangeKey === 'custom' && (
          <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
            <input type="date" aria-label="From date" value={custom.from} max={istDay(now)} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className={field} />
            <span>to</span>
            <input type="date" aria-label="To date" value={custom.to} max={istDay(now)} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className={field} />
          </div>
        )}
      </div>

      {/* What: the view, the kind of change, the strategy. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div role="tablist" aria-label="View" className="inline-flex rounded-md border border-solid border-border p-0.5">
          {VIEWS.map(({ v, label }) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
                    className={cn('m-0 h-7 appearance-none rounded border-0 px-2.5 font-[inherit] text-[12px]', view === v ? 'bg-primary font-semibold text-primary-foreground' : 'bg-transparent text-muted-foreground')}>
              {label}
            </button>
          ))}
        </div>
        <select aria-label="Kind of change" value={show} onChange={(e) => { setShow(e.target.value as Show); setShown(PAGE); }} className={field}>
          {SHOW.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}
        </select>
        {strategies.length > 1 && (
          <select aria-label="Strategy" value={picked} onChange={(e) => { setStrategy(e.target.value); setShown(PAGE); }} className={cn(field, 'max-w-full')}>
            <option value="">All strategies</option>
            {strategies.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
      </div>

      {error && <p role="alert" className="m-0 text-[12.5px] text-[var(--down)]">The log could not be read: {error.message}</p>}
      {!data && !error && <p className="m-0 text-[12.5px] text-muted-foreground">Reading the log…</p>}
      {data && mine.length === 0 && (
        <p className="m-0 rounded-md bg-muted p-3 text-[12.5px] leading-snug text-muted-foreground">
          No method changes {rangeWords === dayLabel(istDay(now)) ? 'today' : `from ${rangeWords}`}{show !== 'all' ? ' of this kind' : ''}. Switch on <b className="text-foreground">Auto-update methods</b> in a signal
          strategy&apos;s Signals tab, or change its methods and save: each change is kept here.
        </p>
      )}

      {data && mine.length > 0 && view === 'tf' && (
        <MethodTimeframes updates={mine} range={range} today={istDay(now)} nameOf={nameOf} accountOf={accountOf} onMethod={openMethod} />
      )}

      {data && mine.length > 0 && view === 'summary' && (
        <SummaryView s={summary} rangeWords={rangeWords} nameOf={nameOf} accountOf={accountOf} sort={methodSort} onSort={setMethodSort}
                     onMethod={openMethod} onStrategy={openStrategy} />
      )}

      {data && mine.length > 0 && view === 'timeline' && (
        <>
          {method && (
            <p role="status" className="m-0 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
              <span>The changes of <b className="text-foreground">{nameOf(method)}</b>: {plural(list.length, 'change')}.</span>
              <button type="button" onClick={() => setMethod('')} className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] underline">Show every change</button>
            </p>
          )}
          {days.map(([day, us]) => (
            <div key={day} className="grid min-w-0 gap-1.5">
              <h3 className="m-0 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{dayLabel(day)}</h3>
              <ul aria-label={`Changes on ${dayLabel(day)}`} className="m-0 grid list-none gap-1.5 p-0">
                {us.map((u) => <Entry key={u.id} u={u} nameOf={nameOf} account={accountOf(u.accountId)} />)}
              </ul>
            </div>
          ))}
          {list.length > shown && (
            <button type="button" onClick={() => setShown(shown + PAGE)}
                    className="m-0 h-9 w-full appearance-none rounded-md border border-solid border-border bg-transparent font-[inherit] text-[12.5px] text-foreground sm:w-auto sm:px-4">
              Show {Math.min(PAGE, list.length - shown)} more of {list.length - shown}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function SummaryView({ s, rangeWords, nameOf, accountOf, sort, onSort, onMethod, onStrategy }: {
  s: Summary; rangeWords: string; nameOf: (id: string) => string; accountOf: (id: number | null) => string | null;
  sort: MethodSort; onSort: (s: MethodSort) => void; onMethod: (m: string) => void; onStrategy: (id: string) => void;
}) {
  const max = Math.max(1, ...s.days.map((d) => Math.max(d.in, d.out)));
  // The account under each strategy only where the list holds more than one.
  const manyAccounts = new Set(s.byStrategy.map((r) => r.accountId)).size > 1;
  // A label on a bar while the bars are wide enough to carry one.
  const labelled = s.days.length <= 14;
  const rows = sortMethods(s.methods, sort);
  const th = 'px-1.5 py-1 text-left text-[11px] font-medium text-muted-foreground';
  const td = 'px-1.5 py-1 text-[12px] tabular-nums';
  const link = 'm-0 appearance-none border-0 bg-transparent p-0 text-left font-[inherit] text-[12px] text-foreground underline decoration-[var(--line)] underline-offset-2 hover:decoration-current';
  return (
    <div className="grid min-w-0 gap-3">
      {/* The totals, in words a glance takes in. */}
      <div aria-label="Totals" className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <Tile label="Changes" value={String(s.changes)} hint={`${s.daily} daily · ${s.manual} by hand${s.kept ? ` · ${s.kept} kept` : ''}`} />
        <Tile label="Strategies changed" value={String(s.strategies)} />
        <Tile label="Methods in" value={`+${s.in}`} tone="text-[var(--up)]" />
        <Tile label="Methods out" value={`−${s.out}`} tone="text-[var(--down)]" />
      </div>

      {/* A bar a day: up for the methods that came in, down for the ones that went out. */}
      <div className="min-w-0">
        <p className="m-0 mb-1 text-[12px] font-medium text-foreground">In and out, day by day <span className="font-normal text-muted-foreground">· {rangeWords}</span></p>
        <div role="img" aria-label={s.days.map((d) => `${dayLabel(d.day)}: ${d.in} in, ${d.out} out`).join('; ')}
             className="flex h-36 min-w-0 items-stretch gap-[2px] rounded-md bg-muted px-1 py-1">
          {s.days.map((d) => (
            <div key={d.day} title={`${dayLabel(d.day)}: +${d.in} in, −${d.out} out`} className="flex min-w-0 flex-1 flex-col">
              <div className="flex flex-1 flex-col items-center justify-end">
                {labelled && d.in > 0 && <span className="text-[10px] leading-none tabular-nums text-[var(--up)]">+{d.in}</span>}
                <div className="w-full max-w-[22px] rounded-t-sm bg-[var(--up)]" style={{ height: `${(d.in / max) * 80}%` }} />
              </div>
              <div className="h-px bg-[var(--line)]" />
              <div className="flex flex-1 flex-col items-center justify-start">
                <div className="w-full max-w-[22px] rounded-b-sm bg-[var(--down)]" style={{ height: `${(d.out / max) * 80}%` }} />
                {labelled && d.out > 0 && <span className="text-[10px] leading-none tabular-nums text-[var(--down)]">−{d.out}</span>}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-0.5 flex justify-between text-[10.5px] text-[var(--dim)]">
          <span>{dayLabel(s.days[0]?.day ?? '')}</span>
          <span><span className="text-[var(--up)]">■</span> in · <span className="text-[var(--down)]">■</span> out</span>
          <span>{dayLabel(s.days.at(-1)?.day ?? '')}</span>
        </div>
      </div>

      {/* Every method that came or went: how often, and where it stands now. */}
      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <p className="m-0 text-[12px] font-medium text-foreground">Methods <span className="font-normal text-muted-foreground">· tap one for its changes</span></p>
          <select aria-label="Order the methods" value={sort} onChange={(e) => onSort(e.target.value as MethodSort)}
                  className="h-8 rounded-md border border-solid border-border bg-background px-2 text-[12px] text-foreground">
            {METHOD_SORTS.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}
          </select>
        </div>
        <div className="max-h-[26rem] min-w-0 overflow-auto rounded-md border border-solid border-[var(--line-soft)]">
          <table aria-label="Methods in and out" className="w-full border-collapse">
            <thead className="sticky top-0 bg-[var(--panel)]">
              <tr><th className={th}>Method</th><th className={cn(th, 'text-right')}>In</th><th className={cn(th, 'text-right')}>Out</th><th className={cn(th, 'text-right')} title="Strategies that have it after their latest change">Now</th><th className={cn(th, 'text-right')} title="Its record at the latest daily update: won share, and of how many trades">Win</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.method} className="border-0 border-t border-solid border-[var(--line-soft)]">
                  <td className={cn(td, 'max-w-[11rem] whitespace-normal text-left')}><button type="button" className={link} onClick={() => onMethod(r.method)}>{nameOf(r.method)}</button></td>
                  <td className={cn(td, 'text-right text-[var(--up)]')}>{r.in ? `+${r.in}` : '–'}</td>
                  <td className={cn(td, 'text-right text-[var(--down)]')}>{r.out ? `−${r.out}` : '–'}</td>
                  <td className={cn(td, 'text-right')}>{r.nowIn}</td>
                  <td className={cn(td, 'text-right text-muted-foreground')} title={recordWords(r.record ?? undefined) ?? undefined}>
                    {r.record && r.record.trades
                      ? <>{Math.round((r.record.wins / r.record.trades) * 100)}%<span className="block text-[10.5px] text-[var(--dim)]">{plural(r.record.trades, 'trade')}</span></>
                      : '–'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Every strategy: how many changes, how much moved, and its list now. */}
      <div className="min-w-0">
        <p className="m-0 mb-1 text-[12px] font-medium text-foreground">Strategies <span className="font-normal text-muted-foreground">· tap one for its changes</span></p>
        <div className="min-w-0 overflow-x-auto rounded-md border border-solid border-[var(--line-soft)]">
          <table aria-label="Strategies changed" className="w-full border-collapse">
            <thead><tr><th className={th}>Strategy</th><th className={cn(th, 'text-right')}>Changes</th><th className={cn(th, 'text-right')}>In / out</th><th className={cn(th, 'text-right')}>Methods</th></tr></thead>
            <tbody>
              {s.byStrategy.map((r) => (
                <tr key={r.id} className="border-0 border-t border-solid border-[var(--line-soft)]">
                  <td className={cn(td, 'whitespace-normal text-left')}>
                    <button type="button" className={link} onClick={() => onStrategy(r.id)}>{r.name}</button>
                    {manyAccounts && accountOf(r.accountId) && <span className="block text-[10.5px] text-[var(--dim)]">{accountOf(r.accountId)}</span>}
                  </td>
                  <td className={cn(td, 'text-right')}>{r.changes}</td>
                  <td className={cn(td, 'text-right')}><span className="text-[var(--up)]">+{r.in}</span> <span className="text-[var(--down)]">−{r.out}</span></td>
                  <td className={cn(td, 'text-right')}>{r.first} → <b>{r.now}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-md bg-muted px-2.5 py-2">
      <p className="m-0 text-[11px] text-muted-foreground">{label}</p>
      <p className={cn('m-0 text-[18px] font-semibold tabular-nums', tone ?? 'text-foreground')}>{value}</p>
      {hint && <p className="m-0 text-[10.5px] leading-snug text-[var(--dim)]">{hint}</p>}
    </div>
  );
}

function Entry({ u, nameOf, account }: { u: MethodUpdate; nameOf: (id: string) => string; account: string | null }) {
  const [open, setOpen] = useState(false);
  const rec = new Map(u.records.map((r) => [r.method, r]));
  const kept = u.after.filter((m) => u.before.includes(m));
  const changed = u.added.length + u.dropped.length > 0;
  const rule = ruleWords(u);
  const label = `${istTime(u.at)} ${u.strategyName}: ${changed ? `${u.before.length} to ${u.after.length} methods` : `kept ${u.after.length} methods`}`;
  return (
    <li aria-label={label} className="rounded-md border border-solid border-[var(--line-soft)] p-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
        <span className="tabular-nums text-muted-foreground">{istTime(u.at)}</span>
        <b className="min-w-0 break-words font-semibold text-foreground">{u.strategyName}</b>
        {account && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{account}</span>}
        <span className={cn('rounded px-1.5 py-0.5 text-[11px]', u.source === 'daily' ? 'bg-[var(--chosen)] text-[var(--chosen-ink)]' : 'bg-muted text-muted-foreground')}>
          {u.source === 'daily' ? 'Daily update' : 'Saved by hand'}
        </span>
      </div>
      <p className="m-0 mt-1 text-[13px] text-foreground">
        {changed
          ? <>{u.before.length} → <b>{plural(u.after.length, 'method')}</b> · <span className="text-[var(--up)]">+{u.added.length} new</span> · <span className="text-[var(--down)]">−{u.dropped.length} dropped</span></>
          : <>Kept the {plural(u.after.length, 'method')}</>}
      </p>
      {rule && <p className="m-0 mt-0.5 text-[11.5px] text-muted-foreground">{rule}</p>}
      {u.note && <p className="m-0 mt-0.5 text-[11.5px] text-[var(--warn)]">{u.note}</p>}
      {(changed || u.records.length > 0) && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
                className="m-0 mt-1 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] underline underline-offset-2">
          {open ? 'Hide the methods' : 'Show the methods'}
        </button>
      )}
      {open && (
        <div className="mt-1.5 grid min-w-0 gap-2 sm:grid-cols-3">
          <Group title="New" tone="text-[var(--up)]" ids={u.added} nameOf={nameOf} rec={rec} />
          <Group title="Dropped" tone="text-[var(--down)]" ids={u.dropped} nameOf={nameOf} rec={rec} />
          <Group title="Kept" tone="text-foreground" ids={kept} nameOf={nameOf} rec={rec} />
        </div>
      )}
    </li>
  );
}

function Group({ title, tone, ids, nameOf, rec }: { title: string; tone: string; ids: string[]; nameOf: (id: string) => string; rec: Map<string, MethodRecordLine> }) {
  return (
    <div className="min-w-0">
      <p className={cn('m-0 text-[11.5px] font-semibold', tone)}>{title} · {ids.length}</p>
      {ids.length === 0
        ? <p className="m-0 text-[11.5px] text-[var(--dim)]">none</p>
        : (
          <ul aria-label={`${title} methods`} className="m-0 mt-0.5 grid list-none gap-0.5 p-0">
            {ids.map((id) => {
              const w = recordWords(rec.get(id));
              return (
                <li key={id} className="text-[11.5px] leading-snug">
                  <span className="text-foreground">{nameOf(id)}</span>
                  {w && <span className="block text-[var(--dim)] tabular-nums">{w}</span>}
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}
