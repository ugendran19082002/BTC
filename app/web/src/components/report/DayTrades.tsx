import { useEffect, useMemo, useState } from 'react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Loading } from '@/components/mobile/parts';
import { count, netClass } from '@/components/report/backtest-parts';
import { dayLabel, moneyText, ptsText, timeIst } from '@/lib/market-report';
import { pct } from '@/lib/format';
import { cn } from '@/lib/utils';
import { FilterBar, FilterPicker, METHODS, SortRow, STRATEGIES, sortOptions, type FilterOption, type FilterSort } from '@/components/mobile/FilterPicker';
import { usePersisted } from '@/hooks/usePersisted';
import { WIN_AT_LEAST_PCT } from '@/lib/win-line';
import type { BtDayTrades, BtExit, BtTradeRow, VolStudyLevel } from '@/types/signal-backtest';

/**
 * One expiry day of a backtest, trade by trade (owner, 14 Oct 2026: "tap the count -- each trade's entry, exit, SL,
 * TGT, points and money, user friendly"). Opened from a day's trade count; read when opened, as the backtest worked
 * that day out. Each trade a card: what was sold on which signal, in and out with the times, why it closed, the
 * perp's levels and the option's own, the points and the money. Narrowed by result or by exit, sorted by time or
 * by money, fifty at a time.
 *
 * And by method (15 Oct 2026, owner: "tab-based P&L, a methods filter, each method's P&L and win %"): every tab says
 * what its trades made; the methods are a pick of several with each one's trades, win % and money -- the same
 * dropdown as the Backtest's own Method list, its Win tab with it -- and a table of them, the best first, a row a
 * tap away from its trades. In a run together, whose trades they are is a pick of its own.
 */

/** Trades added up: how many, how many made money, and what they came to. */
type Sum = { n: number; won: number; net: number };
const sumOf = (xs: readonly BtTradeRow[]): Sum => xs.reduce((a, t) => ({ n: a.n + 1, won: a.won + (t.netUsd > 0 ? 1 : 0), net: a.net + t.netUsd }), { n: 0, won: 0, net: 0 });
/** "22 trades · 64% won · +₹40.12" */
const sumWords = (x: Sum) => `${count(x.n)} trade${x.n === 1 ? '' : 's'} · ${pct(x.n ? x.won / x.n : null, 0)} won · ${moneyText(x.net)}`;

const EXIT_WORDS: Record<BtExit, string> = {
  'perp-tgt': 'Perp TGT', 'perp-sl': 'Perp SL', 'option-tgt': 'Option TGT', 'option-sl': 'Option SL', 'option-tsl': 'Option TSL', 'option-be': 'Option SL at entry', 'window-end': 'Window end',
};
const PAGE = 50;
/** A trade's volatility level, as the study's list says it (17 Oct 2026). */
const LEVEL_WORDS: Record<VolStudyLevel, string> = { low: 'Low', medium: 'Normal', high: 'High', unknown: 'Unknown' };
const LEVEL_ORDER: VolStudyLevel[] = ['low', 'medium', 'high', 'unknown'];
/** An option price to the cent, with at least one decimal: 43.0, 73.13, 9.91. */
const opt = (v: number) => { const r = Math.round(v * 100) / 100; return Number.isInteger(r) ? r.toFixed(1) : String(r); };
const perp = (v: number) => Math.round(v).toLocaleString('en-US');

type Only = 'all' | 'won' | 'lost' | BtExit;
type Order = 'time' | 'best' | 'worst';

export function DayTradesSheet({ day, title, read, onClose }: {
  /** What is open -- an expiry day, or a key of the caller's own (a session, a method in one) -- or null: closed. */
  day: string | null;
  /** The sheet's title; an expiry day's by default. */
  title?: string;
  read: (day: string) => Promise<BtDayTrades>;
  onClose: () => void;
}) {
  const [got, setGot] = useState<{ day: string; data: BtDayTrades | null; error: Error | null } | null>(null);
  const [only, setOnly] = useState<Only>('all');
  const [order, setOrder] = useState<Order>('time');
  const [shown, setShown] = useState(PAGE);
  const [methods, setMethods] = useState<string[]>([]);
  const [members, setMembers] = useState<string[]>([]);
  // The volatility study's list: one level, or all (null).
  const [level, setLevel] = useState<VolStudyLevel | null>(null);
  // The Win tab's line in the method pick, the same one the Backtest's Method list keeps.
  const [winAtLeast, setWinAtLeast] = usePersisted<number>('signalBacktest.winAtLeast', WIN_AT_LEAST_PCT);
  const [methodSort, setMethodSort] = usePersisted<FilterSort>('methods.sort', 'default');
  useEffect(() => {
    if (!day) return;
    let live = true;
    setGot({ day, data: null, error: null }); setOnly('all'); setOrder('time'); setShown(PAGE); setMethods([]); setMembers([]); setLevel(null);
    read(day).then((data) => { if (live) setGot({ day, data, error: null }); }, (error: Error) => { if (live) setGot({ day, data: null, error }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  const data = got?.day === day ? got.data : null;
  const trades = data?.trades ?? [];
  // The method and member picks first; the tabs, their counts and their money are of what those leave.
  const base = useMemo(() => trades.filter((t) => (!methods.length || methods.includes(t.method)) && (!members.length || members.includes(t.member ?? '')) && (level === null || t.level === level)), [trades, methods, members, level]);
  // Each level there is, with what its trades made: the study's list only.
  const levels = useMemo(() => LEVEL_ORDER.filter((l) => trades.some((t) => t.level === l)).map((l) => ({ l, sum: sumOf(trades.filter((t) => t.level === l)) })), [trades]);
  const tabOf = (k: Only) => (t: BtTradeRow) => k === 'all' || (k === 'won' ? t.netUsd > 0 : k === 'lost' ? t.netUsd <= 0 : t.by === k);
  const tabs = useMemo(() => {
    const exits = (Object.keys(EXIT_WORDS) as BtExit[]).filter((k) => trades.some((t) => t.by === k));
    return ([['all', 'All'], ['won', 'Won'], ['lost', 'Lost'], ...exits.map((k) => [k, EXIT_WORDS[k]])] as [Only, string][])
      .map(([k, label]) => ({ k, label, sum: sumOf(base.filter(tabOf(k))) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades, base]);
  const list = useMemo(() => {
    const xs = base.filter(tabOf(only));
    return order === 'time' ? xs : [...xs].sort((a, b) => (order === 'best' ? b.netUsd - a.netUsd : a.netUsd - b.netUsd));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, only, order]);
  const day$ = sumOf(trades), shown$ = sumOf(list);
  // Each method on the day, by what it made: for the pick (with its record) and for the table.
  const byMethod = useMemo(() => {
    const m = new Map<string, { key: string; name: string; xs: BtTradeRow[] }>();
    for (const t of trades.filter((x) => !members.length || members.includes(x.member ?? ''))) {
      const g = m.get(t.method) ?? { key: t.method, name: t.name, xs: [] };
      g.xs.push(t); m.set(t.method, g);
    }
    return [...m.values()].map((g) => ({ key: g.key, name: g.name, ...sumOf(g.xs) })).sort((a, b) => b.net - a.net || b.n - a.n);
  }, [trades, members]);
  const memberList = useMemo(() => [...new Set(trades.map((t) => t.member).filter((x): x is string => !!x))].map((name) => ({ name, ...sumOf(trades.filter((t) => t.member === name)) })), [trades]);
  const optionOf = (x: Sum & { key: string; name: string }): FilterOption => ({
    key: x.key, name: x.name, tone: x.net > 0 ? 'up' : x.net < 0 ? 'down' : undefined, value: x.net, winRate: x.n ? x.won / x.n : undefined, trades: x.n, note: sumWords(x),
  });
  const pick = (k: Only) => { setOnly(k); setShown(PAGE); };
  const chip = (on: boolean) => cn('m-0 flex min-h-[44px] shrink-0 appearance-none flex-col items-center justify-center whitespace-nowrap rounded-xl border border-solid px-3 py-1 font-[inherit] leading-tight',
    on ? 'border-[var(--chosen-line)] bg-[var(--chosen-soft)] text-[var(--chosen-text)]' : 'border-border bg-transparent text-foreground');

  return (
    <Sheet open={day !== null} onOpenChange={(v) => { if (!v) onClose(); }}>
      {day && (
        <SheetContent className="sm:w-[min(960px,94vw)] sm:max-h-[88vh]" title={title ?? `${dayLabel(day)} · trade by trade`}
          description={data ? `${count(data.total)} trades · ${pct(day$.n ? day$.won / day$.n : null, 0)} won · ${moneyText(day$.net)} after charges` : undefined}>
          {!data ? <Loading error={got?.error ?? null} what="the day's trades (the day is played again: a moment)" /> : (
            <div className="grid min-w-0 gap-2">
              {/* Which trades: by method (and, in a run together, by whose), each with its record. */}
              {(byMethod.length > 1 || memberList.length > 1) && (
                <FilterBar onClear={methods.length || members.length ? () => { setMethods([]); setMembers([]); setShown(PAGE); } : null}>
                  {memberList.length > 1 && (
                    <FilterPicker noun={STRATEGIES} picked={members} onChange={(x) => { setMembers(x); setShown(PAGE); }}
                      options={memberList.map((x) => optionOf({ ...x, key: x.name }))} split />
                  )}
                  {byMethod.length > 1 && (
                    <FilterPicker noun={METHODS} picked={methods} onChange={(x) => { setMethods(x); setShown(PAGE); }} split
                      winAtLeast={typeof winAtLeast === 'number' ? winAtLeast : WIN_AT_LEAST_PCT} onWinAtLeast={setWinAtLeast}
                      sort={methodSort} onSort={setMethodSort}
                      options={byMethod.map(optionOf)} />
                  )}
                </FilterBar>
              )}
              {/* The volatility study's list: by the level at each fill (17 Oct 2026). */}
              {levels.length > 0 && (
                <div role="group" aria-label="Volatility level" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1">
                  {[{ l: null as VolStudyLevel | null, sum: sumOf(trades) }, ...levels].map((x) => (
                    <button key={x.l ?? 'all'} type="button" aria-pressed={level === x.l} aria-label={`${x.l ? LEVEL_WORDS[x.l] : 'Every level'} ${count(x.sum.n)}: ${moneyText(x.sum.net)}`}
                      className={chip(level === x.l)} onClick={() => { setLevel(x.l); setShown(PAGE); }}>
                      <span className="text-[13px] font-medium">{x.l ? LEVEL_WORDS[x.l] : 'Every level'} {count(x.sum.n)}</span>
                      <span className={cn('text-[11.5px] font-semibold tabular-nums', x.sum.n ? netClass(x.sum.net) : 'text-muted-foreground')}>{x.sum.n ? moneyText(x.sum.net) : '—'}</span>
                    </button>
                  ))}
                </div>
              )}
              {/* Each tab with what its trades made: the count, and the money under it. */}
              <div role="group" aria-label="Show" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1">
                {tabs.map((x) => (
                  <button key={x.k} type="button" aria-pressed={only === x.k} aria-label={`${x.label} ${count(x.sum.n)}: ${moneyText(x.sum.net)}`}
                    className={chip(only === x.k)} onClick={() => pick(x.k)}>
                    <span className="text-[13px] font-medium">{x.label} {count(x.sum.n)}</span>
                    <span className={cn('text-[11.5px] font-semibold tabular-nums', x.sum.n ? netClass(x.sum.net) : 'text-muted-foreground')}>{x.sum.n ? moneyText(x.sum.net) : '—'}</span>
                  </button>
                ))}
              </div>
              <p aria-label="What is shown" className="m-0 text-[13px]">
                <span className="text-muted-foreground">Showing </span>
                <span className="tabular-nums">{count(shown$.n)} trade{shown$.n === 1 ? '' : 's'} · {pct(shown$.n ? shown$.won / shown$.n : null, 0)} won · </span>
                <b className={cn('font-semibold tabular-nums', netClass(shown$.net))}>{moneyText(shown$.net)}</b>
              </p>
              <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                Order
                <select aria-label="Order the trades" value={order} onChange={(e) => setOrder(e.target.value as Order)}
                  className="h-9 rounded-md border border-solid border-border bg-background px-2 font-[inherit] text-[13px] text-foreground">
                  <option value="time">By time</option>
                  <option value="best">Most made first</option>
                  <option value="worst">Most lost first</option>
                </select>
              </label>
              {data.total > trades.length && (
                <p className="m-0 text-[12px] text-[var(--warn)]">The first {count(trades.length)} of {count(data.total)} trades, by time: narrow the backtest by time frame or method to see the rest.</p>
              )}
              {list.length === 0 ? <p className="m-0 py-2 text-[13px] text-muted-foreground">No trade of this kind on the day.</p> : (
                <ul aria-label="Trades" className="m-0 grid list-none gap-2 p-0 lg:grid-cols-2">
                  {list.slice(0, shown).map((t, i) => <TradeCard key={`${t.at}-${t.method}-${t.member ?? ''}-${i}`} t={t} />)}
                </ul>
              )}
              {list.length > shown && (
                <button type="button" onClick={() => setShown((n) => n + PAGE)}
                  className="m-0 min-h-[44px] w-full appearance-none rounded-md border border-solid border-border bg-transparent font-[inherit] text-[13.5px] font-medium text-foreground">
                  Show {count(Math.min(PAGE, list.length - shown))} more of {count(list.length - shown)}
                </button>
              )}
              {byMethod.length > 1 && (
                <MethodTable rows={sortOptions(byMethod.map((x) => ({ ...x, value: x.net, trades: x.n, winRate: x.n ? x.won / x.n : undefined })), methodSort === 'default' ? 'pnl-high' : methodSort)}
                  sort={methodSort} onSort={setMethodSort} picked={methods} onPick={(key) => { setMethods([key]); setOnly('all'); setShown(PAGE); }} />
              )}
            </div>
          )}
        </SheetContent>
      )}
    </Sheet>
  );
}

/**
 * The day's methods -- the best first, or as the sort row orders them -- with trades, win %, and the money: a row a
 * tap away from its own trades, which the method pick above then holds.
 */
function MethodTable({ rows, sort, onSort, picked, onPick }: {
  rows: readonly (Sum & { key: string; name: string })[]; sort: FilterSort; onSort: (s: FilterSort) => void; picked: readonly string[]; onPick: (key: string) => void;
}) {
  return (
    <section aria-label="By method" className="mt-1 grid gap-1">
      <h3 className="m-0 text-[12.5px] font-semibold text-muted-foreground">By method · {count(rows.length)}</h3>
      {/* The same order as the method pick keeps; its default here is the best first. */}
      <SortRow value={sort} onChange={onSort} className="-mx-4 px-4 pb-0.5" />
      <table className="w-full table-fixed border-collapse text-[13px]">
        <caption className="sr-only">The day's trades by method</caption>
        <colgroup><col /><col className="w-[4.5rem]" /><col className="w-[3.5rem]" /><col className="w-[6.5rem]" /></colgroup>
        <thead>
          <tr className="text-[11px] uppercase tracking-[0.4px] text-muted-foreground">
            <th scope="col" className="py-1 text-left font-medium">Method</th>
            <th scope="col" className="py-1 text-right font-medium">Trades</th>
            <th scope="col" className="py-1 text-right font-medium">Won</th>
            <th scope="col" className="py-1 text-right font-medium">Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={cn('border-0 border-t border-solid border-[var(--line-soft)]', picked.length === 1 && picked[0] === r.key && 'bg-[var(--chosen-soft)]')}>
              <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                <button type="button" onClick={() => onPick(r.key)} aria-label={`Only ${r.name}`}
                  className="m-0 min-h-[32px] w-full appearance-none border-0 bg-transparent p-0 text-left font-[inherit] text-[13px] text-foreground [overflow-wrap:anywhere]">{r.name}</button>
              </th>
              <td className="py-1.5 text-right tabular-nums">{count(r.n)}</td>
              <td className="py-1.5 text-right tabular-nums">{pct(r.n ? r.won / r.n : null, 0)}</td>
              <td className={cn('py-1.5 text-right font-semibold tabular-nums', netClass(r.net))}>{moneyText(r.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** One trade: the signal and the option, in and out, why it closed, its levels, and what it came to. */
export function TradeCard({ t }: { t: BtTradeRow }) {
  const side = t.dir === 1 ? 'BUY' : 'SELL';
  const leg = `${t.cp === 'P' ? 'PE' : 'CE'} ${t.strike.toLocaleString('en-US')}`;
  const row = 'flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5';
  return (
    <li aria-label={`${timeIst(t.at)} ${t.name} ${side}: ${moneyText(t.netUsd)}`} className="grid min-w-0 gap-1.5 rounded-lg border border-solid border-[var(--line-soft)] p-3">
      <div className={row}>
        <span className="min-w-0 text-[13.5px] font-semibold [overflow-wrap:anywhere]">
          <span className="tabular-nums text-[var(--time)]">{timeIst(t.at)}</span> · {t.name}
        </span>
        <span className={cn('text-[16px] font-semibold tabular-nums', netClass(t.netUsd))}>{moneyText(t.netUsd)}</span>
      </div>
      <p className="m-0 text-[12.5px] text-muted-foreground">
        {t.level ? <><span className={cn('font-medium', t.level === 'high' ? 'text-[var(--down)]' : t.level === 'low' ? 'text-[var(--up)]' : 'text-foreground')}>{LEVEL_WORDS[t.level]} volatility</span> · </> : null}
        {t.member ? <>{t.member} · </> : null}{t.tf === 'chain' ? 'TF chain' : t.tf} · <span className={t.dir === 1 ? 'text-[var(--up)]' : 'text-[var(--down)]'}>{side}</span> · sold {leg} × {count(t.lots)}
        {t.fwdFrom != null && <> · <span className="text-[var(--warn)]">forwarded from {t.cp === 'P' ? 'PE' : 'CE'} {t.fwdFrom.toLocaleString('en-US')}</span>, its strike full</>}
      </p>
      <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1 text-[12.5px] sm:grid-cols-4">
        <div><dt className="text-muted-foreground">Entry</dt><dd className="m-0 tabular-nums">{opt(t.entry)} <span className="text-muted-foreground">at {timeIst(t.entryAt)}</span></dd></div>
        <div><dt className="text-muted-foreground">Exit</dt><dd className="m-0 tabular-nums">{opt(t.exit)} <span className="text-muted-foreground">at {timeIst(t.exitAt)}</span></dd></div>
        <div><dt className="text-muted-foreground">Closed by</dt><dd className="m-0">{EXIT_WORDS[t.by]}</dd></div>
        <div><dt className="text-muted-foreground">Perp pts</dt><dd className={cn('m-0 tabular-nums', netClass(t.perpPts))}>{ptsText(t.perpPts)}</dd></div>
        <div><dt className="text-muted-foreground">Perp entry</dt><dd className="m-0 tabular-nums">{perp(t.perpEntry)}</dd></div>
        <div><dt className="text-muted-foreground">Perp SL · TGT</dt><dd className="m-0 tabular-nums"><span className="text-[var(--down)]">{perp(t.perpSl)}{t.perpStopEnd != null && <> → {perp(t.perpStopEnd)}</>}</span> · <span className="text-[var(--up)]">{perp(t.perpTgt)}{t.perpTgtEnd != null && <> → {perp(t.perpTgtEnd)}</>}</span>{(t.perpStopEnd != null || t.perpTgtEnd != null) && <span className="text-muted-foreground"> (widened)</span>}</dd></div>
        <div><dt className="text-muted-foreground">Option SL · TGT</dt><dd className="m-0 tabular-nums">{t.optStop !== null || t.optStopEnd != null ? <span className="text-[var(--down)]">{t.optStop !== null ? opt(t.optStop) : 'none'}{t.optStopEnd != null && <> → {opt(t.optStopEnd)} <span className="text-muted-foreground">({t.by === 'option-be' || t.optStopEnd === t.entry ? 'at entry' : 'trailed'})</span></>}</span> : 'none'} · {t.optTgt !== null ? <span className="text-[var(--up)]">{opt(t.optTgt)}</span> : 'none'}</dd></div>
        <div><dt className="text-muted-foreground">Charges</dt><dd className="m-0 tabular-nums">{moneyText(-t.chargesUsd)}</dd></div>
      </dl>
    </li>
  );
}
