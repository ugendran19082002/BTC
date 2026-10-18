import { useMemo, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import type { EntryMethodInfo } from '@/api/entry';
import { usePersisted } from '@/hooks/usePersisted';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { WIN_AT_LEAST_PCT, asPct, wonAtLeast } from '@/lib/win-line';
import { SortRow, WinLine, sortOptions, type FilterSort } from '@/components/mobile/FilterPicker';
import type { SignalTf } from '@/types/strategy';

/**
 * The 81 methods as a list to tick, each with its record: searched, by family, by result, by order side and sorted.
 * The signal strategy's methods are ticked on it, and the methods its daily update excludes (owner, 18 Oct 2026:
 * "the methods list below, copied -- reuse it"; "the same filter and sort for exclude") -- one list, so the two
 * read the same and a fix to one is a fix to both.
 */

const GROUPS = [
  { id: 'all', label: 'All' },
  { id: 'breakout', label: 'Breakout' },
  { id: 'pullback', label: 'Pullback' },
  { id: 'reversal', label: 'Reversal' },
  { id: 'flow', label: 'Flow' },
] as const;
type GroupFilter = (typeof GROUPS)[number]['id'];

/** A method's record in its basis's own unit: dollars after charges as options, BTC points on the perp. */
export type MethodRecord = { trades: number; wins: number; winPct: number | null; net: number };

type ResultFilter = 'all' | 'profit' | 'loss' | 'none' | 'win';
const RESULTS: { id: ResultFilter; label: string; tone: string; test: (r: MethodRecord | undefined) => boolean }[] = [
  { id: 'all', label: 'All', tone: '', test: () => true },
  { id: 'profit', label: 'Profit', tone: 'text-[var(--up)]', test: (r) => Boolean(r && r.trades > 0 && r.net > 0) },
  { id: 'loss', label: 'Loss', tone: 'text-[var(--down)]', test: (r) => Boolean(r && r.trades > 0 && r.net < 0) },
  { id: 'none', label: 'No trades', tone: 'text-[var(--dim)]', test: (r) => !r || r.trades === 0 },
];

/**
 * Won at least a line (owner, 14 Oct 2026: "the Backtest methods' win filter, copied here -- the one here is wrong"):
 * the same rule and the same box as the Backtest's methods dropdown (`lib/win-line`), 30% to begin with, at or over.
 * It replaced 50 / 75 / 90 / Custom over the "profitable" minimum of trades, which counted differently from the
 * Backtest and started at Any.
 */
const winShare = (r: Pick<MethodRecord, 'trades' | 'wins'> | undefined): number | null => (r && r.trades > 0 ? r.wins / r.trades : null);

/** By the method's order side in the owner's list (5 Oct 2026): both, the BUY ones, the SELL ones. */
type SideFilter = 'both' | 'BUY' | 'SELL';
const SIDES: { id: SideFilter; label: string; tone: string }[] = [
  { id: 'both', label: 'Both', tone: '' },
  { id: 'BUY', label: 'Buy', tone: 'text-[var(--up)]' },
  { id: 'SELL', label: 'Sell', tone: 'text-[var(--down)]' },
];
const onSide = (m: EntryMethodInfo, side: SideFilter) => side === 'both' || m.orderSide === side;

export function MethodList({
  name, methods, value, onChange, recordOf, byTf, netWords, minTrades, overTfs, keys, tagOf, onPickOnly,
  afterGroups, links, beforeList,
}: {
  /** What the list is for, in its labels: none for the strategy's own methods ("methods"), "exclude" for the other ("methods (exclude)"). */
  name?: string;
  /** The catalogue. */
  methods: readonly EntryMethodInfo[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
  recordOf: ReadonlyMap<string, MethodRecord>;
  /** Each method's record on each timeframe, where there is more than one. */
  byTf: ReadonlyMap<string, { tf: SignalTf; row: MethodRecord | undefined }[]>;
  /** A net in the record's own words: dollars as options, points on the perp. */
  netWords: (n: number, unit?: boolean) => string;
  /** The trades a record needs before "profitable" means anything: a profitable one on fewer is marked. */
  minTrades: number;
  /** "15m + 1h": the timeframes a record is added up over, said on its win rate. */
  overTfs?: string | null;
  /** Where the result tab, the Win line and the sort are kept in this browser: each list its own. */
  keys: { result: string; win: string; sort: string };
  /** A word beside a method's name: why it matters to the other list. */
  tagOf?: (id: string) => string | null;
  /** "Pick only these": said by the caller (to be undone); else the list simply becomes the one shown. */
  onPickOnly?: (ids: string[]) => void;
  afterGroups?: ReactNode;
  /** More links beside "Pick all shown". */
  links?: ReactNode;
  beforeList?: ReactNode;
}) {
  const label = (s: string) => (name ? `${s} (${name})` : s);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<GroupFilter>('all');
  // By record: everything, the ones up, the ones down, the ones with no trade -- over the timeframes picked.
  const [result, setResult] = usePersisted<ResultFilter>(keys.result, 'all');
  // By order side. Not remembered: a list quietly missing half its methods next time is a list misread.
  const [side, setSide] = useState<SideFilter>('both');

  // Search and family first; the result and order-side filters on top, so each one's counts follow the rest.
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return methods.filter((m) => (group === 'all' || m.group === group)
      && (!q || String(m.n) === q || m.name.toLowerCase().includes(q) || m.summary.toLowerCase().includes(q)));
  }, [methods, query, group]);
  // The Win tab's line, kept in this browser like the rest (`lib/win-line`).
  const [winAtLeast, setWinAtLeast] = usePersisted<number>(keys.win, WIN_AT_LEAST_PCT);
  const line = asPct(typeof winAtLeast === 'number' ? winAtLeast : WIN_AT_LEAST_PCT);
  const tabs = [...RESULTS, {
    id: 'win' as const, label: `Win ≥${line}%`, tone: 'text-[var(--up)]',
    test: (r: MethodRecord | undefined) => wonAtLeast(winShare(r), line),
  }];
  const resultTab = tabs.find((x) => x.id === result) ?? tabs[0]!;
  const passes = (m: EntryMethodInfo, o: { side?: SideFilter; result?: (typeof tabs)[number] } = {}) => {
    const rec = recordOf.get(m.id);
    return onSide(m, o.side ?? side) && (o.result ?? resultTab).test(rec);
  };
  // The list's order, the same as the Backtest's method lists keep (owner, 15 Oct 2026: "a sort row in the form too").
  const [sort, setSort] = usePersisted<FilterSort>(keys.sort, 'default');
  const shown = useMemo(() => {
    const kept = searched.filter((m) => passes(m));
    const rec = (m: EntryMethodInfo) => { const r = recordOf.get(m.id); return r && r.trades > 0 ? { value: r.net, trades: r.trades, winRate: r.wins / r.trades } : {}; };
    return sortOptions(kept.map((m) => ({ m, ...rec(m) })), sort).map((x) => x.m);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searched, resultTab, recordOf, side, line, sort]);
  const picked = new Set(value);
  const toggle = (id: string) => onChange(picked.has(id) ? value.filter((x) => x !== id) : [...value, id]);
  const addAll = (ids: string[]) => onChange([...new Set([...value, ...ids])]);
  const chip = (on: boolean) => cn(
    'm-0 h-8 appearance-none rounded-md border border-solid px-2.5 font-[inherit] text-[12px]',
    on ? 'border-foreground bg-muted text-foreground' : 'border-border bg-transparent text-muted-foreground',
  );
  const link = 'm-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] underline underline-offset-2 disabled:opacity-40 disabled:no-underline';

  return (
    <>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} aria-label={label('search methods')}
               placeholder="Search by number or name" className="pl-7" />
      </div>
      <div role={name ? 'group' : undefined} aria-label={name ? label('families of methods') : undefined} className="mt-1.5 flex flex-wrap gap-1">
        {GROUPS.map((g) => (
          <button key={g.id} type="button" aria-pressed={group === g.id} onClick={() => setGroup(g.id)} className={chip(group === g.id)}>
            {g.label}
          </button>
        ))}
      </div>
      {afterGroups}
      {/* By record, with counts: the profitable ones, the losing ones, the ones with nothing yet. */}
      <div role="group" aria-label={label('methods by result')} className="mt-1.5 flex flex-wrap gap-1">
        {tabs.map((x) => (
          <button key={x.id} type="button" aria-pressed={resultTab.id === x.id} onClick={() => setResult(x.id)} className={chip(resultTab.id === x.id)}>
            <span className={x.tone}>{x.label}</span>{' '}
            <span className="tabular-nums text-[var(--dim)]">{searched.filter((m) => passes(m, { result: x })).length}</span>
          </button>
        ))}
      </div>
      {/* The Win tab's line, under the tabs while it is the one chosen: typed, or five at a time. */}
      {resultTab.id === 'win' && (
        <>
          <WinLine pct={line} onChange={setWinAtLeast} name={name ? label('win rate at least, percent') : undefined} className="mt-1.5 flex max-w-[22rem] items-center gap-2" />
          <p className="m-0 mt-1 text-[11px] leading-snug text-[var(--dim)]">
            Won {line}% or more of their trades, as on the Backtest&apos;s Method list. A method with no trade is not shown.
          </p>
        </>
      )}
      {/* By order side, under the record: the methods marked BUY, the ones marked SELL, or both. */}
      <div role="group" aria-label={label('methods by order side')} className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[11.5px] text-muted-foreground">Order side</span>
        {SIDES.map((x) => (
          <button key={x.id} type="button" aria-pressed={side === x.id} onClick={() => setSide(x.id)} className={chip(side === x.id)}>
            <span className={x.tone}>{x.label}</span>{' '}
            <span className="tabular-nums text-[var(--dim)]">{searched.filter((m) => passes(m, { side: x.id })).length}</span>
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
        <button type="button" className={link} disabled={!shown.length} onClick={() => addAll(shown.map((m) => m.id))}>
          Pick all shown ({shown.length})
        </button>
        {/* Exactly the list shown: the ones not on it are unticked too. */}
        <button type="button" className={link} disabled={!shown.length || (shown.length === value.length && shown.every((m) => picked.has(m.id)))}
                title="Tick exactly the methods shown and untick every other: the pick becomes this list"
                onClick={() => (onPickOnly ?? onChange)(shown.map((m) => m.id))}>
          Pick only these ({shown.length})
        </button>
        {links}
        <button type="button" className={link} disabled={!value.length} onClick={() => onChange([])}>
          Clear
        </button>
      </div>
      {beforeList}

      {recordOf.size > 0 && <SortRow value={sort} onChange={setSort} label={name ? label('Sort') : undefined} className="mt-1.5 pb-0.5" />}
      <ul aria-label={label('methods')} className="m-0 mt-1.5 max-h-[26rem] list-none overflow-y-auto rounded-lg border border-solid border-border p-0">
        {shown.map((m) => {
          const rec = recordOf.get(m.id);
          const on = picked.has(m.id);
          const tag = tagOf?.(m.id) ?? null;
          return (
            <li key={m.id} className="border-0 border-b border-solid border-border last:border-b-0">
              <label className={cn('flex cursor-pointer items-start gap-2 px-2.5 py-2', on && 'bg-muted/60')}>
                <input type="checkbox" checked={on} onChange={() => toggle(m.id)} aria-label={name ? `${name}: #${m.n} ${m.name}` : `#${m.n} ${m.name}`}
                       className="mt-0.5 h-4 w-4 flex-none accent-[var(--warn)]" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[12.5px] font-medium text-foreground">
                      <span className="tabular-nums text-muted-foreground">#{m.n}</span> {m.name}
                      {m.orderSide && (
                        <span aria-label={`#${m.n} order side`} className={cn('ml-1.5 text-[10px] font-semibold', m.orderSide === 'BUY' ? 'text-[var(--up)]' : 'text-[var(--down)]')}>
                          {m.orderSide}
                        </span>
                      )}
                      {tag && <span className="ml-1.5 text-[10px] font-normal text-[var(--warn)]">{tag}</span>}
                    </span>
                    <span className="flex-none text-[11px] tabular-nums text-muted-foreground">
                      {rec && rec.trades > 0
                        ? (
                          <>
                            <span title={overTfs ? `Over ${overTfs} together` : undefined}>
                              {Math.round(rec.winPct ?? 0)}% win
                            </span> · {rec.trades}t ·{' '}
                            <span className={rec.net > 0 ? 'text-[var(--up)]' : rec.net < 0 ? 'text-[var(--down)]' : ''}>
                              {netWords(rec.net)}
                            </span>
                            {rec.net > 0 && rec.trades < minTrades && (
                              <span className="ml-1 text-[var(--warn)]" title={`Profitable, but on ${rec.trades} of the ${minTrades} trades "Pick profitable" asks for`}>
                                · {rec.trades} of {minTrades} trades
                              </span>
                            )}
                          </>
                        )
                        : 'no trades yet'}
                    </span>
                  </span>
                  {byTf.has(m.id) && (
                    <span className="mt-0.5 block text-[10.5px] tabular-nums text-muted-foreground" aria-label={`#${m.n} by timeframe`}>
                      {byTf.get(m.id)!.map(({ tf, row }, i) => (
                        <span key={tf}>
                          {i > 0 && ' · '}
                          {tf}{' '}
                          {row && row.trades > 0
                            ? (
                              <>
                                <span className="text-foreground">{Math.round((row.wins / row.trades) * 100)}%</span>{' '}
                                <span className={row.net > 0 ? 'text-[var(--up)]' : row.net < 0 ? 'text-[var(--down)]' : ''}>{netWords(row.net, false)}</span>
                                {' '}({row.trades}t)
                              </>
                            )
                            : <span className="text-[var(--dim)]">—</span>}
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="mt-0.5 block text-[10.5px] leading-snug text-[var(--dim)]">{m.summary} · SL: {m.sl}</span>
                </span>
              </label>
            </li>
          );
        })}
        {methods.length > 0 && !shown.length && (
          <li className="px-2.5 py-3 text-center text-[12px] text-muted-foreground">
            {query.trim() ? `No method matches “${query}”.` : 'No method under these filters.'}
          </li>
        )}
      </ul>
    </>
  );
}
