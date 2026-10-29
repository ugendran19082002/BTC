import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import { usePersisted } from '@/hooks/usePersisted';
import { rangeMs, timeQuickPicks, timeRangeProblem, timeRangeWords, type DateTimeRange } from '@/lib/date-time-range';
import { DateTimeRangeSheet, type RangeBy } from '@/components/mobile/DateTimeRangeSheet';
import { getClosed, type ClosedTrade } from '@/api/phone';
import { usePoll } from '@/hooks/usePoll';
import { clock, contractLabel, duration, pct, price, signedInr, stamp, usdToInr } from '@/lib/format';
import { dayLabel } from '@/lib/market-report';
import { daysAgoIst, todayIst } from '@/lib/report';
import { isLongTrade } from '@/lib/long-exits';
import { cn } from '@/lib/utils';
import { usePhoneData } from '@/components/mobile/phone-context';
import { Chip, Empty, ListButton, Loading, Panel, Pill, Rupees, Segmented, Stat, Stats, When } from '@/components/mobile/parts';
import { StrategyTag, placedBy } from '@/components/mobile/StrategyTag';
import { GroupTag } from '@/components/strategy/GroupTag';

/**
 * Trade history (6 Oct 2026): the closed trades, not the orders -- what each made after charges. Separate from Orders,
 * which is the order's life; this is the trade's end.
 *
 * The range (19 Oct 2026, the owner: "a custom date and time range; a time frame filter -- user friendly, responsive"):
 * Today, 7, 30 or 90 days, as the phone's other screens; or Custom, a From and a To each a date and a time, IST, a trade
 * counted by its entry or its exit -- the desk's own windows (this expiry day, last night) a tap away.
 *
 * Laid out again for a thumb (owner, 29 Oct 2026: "the history screen -- none of it is user friendly, none of it is
 * mobile responsive"): the range, then what the trades shown made -- net, won, the average win and loss, the best and
 * the worst -- then one row of Filters and Sort, the filters in a sheet from the bottom with each choice's count and the
 * ones chosen said over the list, each a tap to take off. The list by day when it is in time order, each day with its
 * count and money; each row its side and contract, how it closed, what it made, its In and its Out, and its strategy
 * and signal on a line that wraps rather than cuts. Every choice is remembered on the phone.
 */

type RangeKey = 'today' | '7' | '30' | '90' | 'custom';
const RANGES: { key: RangeKey; label: string; spoken?: string; days: number }[] = [
  { key: 'today', label: 'Today', days: 0 }, { key: '7', label: '7D', spoken: '7 days', days: 6 }, { key: '30', label: '30D', spoken: '30 days', days: 29 },
  { key: '90', label: '90D', spoken: '90 days', days: 89 }, { key: 'custom', label: 'Custom', days: -1 },
];
const RANGE_WORDS: Record<Exclude<RangeKey, 'custom'>, string> = { today: 'Today', 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days' };
/** A trade's signal time frame: its own, `chain` with the timeframe chain; null with no signal. */
const tfOf = (o: ClosedTrade): string | null => (o.plan?.signal ? (o.plan.signal.mode === 'mtf' ? 'chain' : o.plan.signal.tf) : null);
const TF_ORDER = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', 'chain'];
const tfName = (k: string) => (k === 'chain' ? 'TF chain' : k);
const entryAt = (o: ClosedTrade) => { const ts = o.fills.filter((f) => f.role === 'entry').map((f) => f.ts); return ts.length ? Math.min(...ts) : o.updatedAt; };
const dayShift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
type Result = 'all' | 'win' | 'loss';
type Opt = 'all' | 'CE' | 'PE';
type Act = 'all' | 'sell' | 'buy';

const netOf = (o: ClosedTrade) => o.netRealisedUsd ?? o.realisedPnl;
const closedAt = (o: ClosedTrade) => Math.max(o.updatedAt, ...o.fills.filter((f) => f.role !== 'entry').map((f) => f.ts));
const heldOf = (o: ClosedTrade) => closedAt(o) - entryAt(o);

/** How a trade closed (the server's `exitBy`), in a word and a colour: a target green, a stop red, the rest grey. */
type ExitKind = NonNullable<ClosedTrade['exitBy']>;
const EXITS: { key: ExitKind; word: string; tone: 'up' | 'down' | 'dim' }[] = [
  { key: 'option-tgt', word: 'TGT', tone: 'up' }, { key: 'perp-tgt', word: 'Perp TGT', tone: 'up' },
  { key: 'option-sl', word: 'SL', tone: 'down' }, { key: 'perp-sl', word: 'Perp SL', tone: 'down' },
  { key: 'window-end', word: 'Time exit', tone: 'dim' }, { key: 'manual', word: 'By hand', tone: 'dim' },
];
const exitOf = (o: ClosedTrade) => EXITS.find((x) => x.key === o.exitBy) ?? null;

/**
 * The order of the list (owner, 29 Oct 2026: "trade history -- a sort; in and out both on the row"): by when it
 * closed, the newest first as it always was, or the oldest; by when it was entered; by what it made, most first or
 * the worst first; by how long it was held. The ones by time are listed under their days.
 */
type Sort = 'out-new' | 'out-old' | 'in-new' | 'net-high' | 'net-low' | 'held-long';
const SORTS: { key: Sort; label: string; by: (a: ClosedTrade, b: ClosedTrade) => number; dayOf?: (o: ClosedTrade) => number }[] = [
  { key: 'out-new', label: 'Newest exit', by: (a, b) => closedAt(b) - closedAt(a), dayOf: closedAt },
  { key: 'out-old', label: 'Oldest exit', by: (a, b) => closedAt(a) - closedAt(b), dayOf: closedAt },
  { key: 'in-new', label: 'Newest entry', by: (a, b) => entryAt(b) - entryAt(a), dayOf: entryAt },
  { key: 'net-high', label: 'Most made', by: (a, b) => netOf(b) - netOf(a) || closedAt(b) - closedAt(a) },
  { key: 'net-low', label: 'Most lost', by: (a, b) => netOf(a) - netOf(b) || closedAt(b) - closedAt(a) },
  { key: 'held-long', label: 'Held longest', by: (a, b) => heldOf(b) - heldOf(a) || closedAt(b) - closedAt(a) },
];

/** What the sheet chooses: kept together, so one key holds them and Clear all is one write. */
type Filters = { result: Result; opt: Opt; act: Act; strategy: string; exit: ExitKind | 'all' };
const NO_FILTERS: Filters = { result: 'all', opt: 'all', act: 'all', strategy: 'all', exit: 'all' };

export function HistoryScreen() {
  const p = usePhoneData();
  const [rangeKey, setRangeKey] = usePersisted<RangeKey>('m-history-range', 'today');
  const [custom, setCustom] = usePersisted<DateTimeRange>('m-history-custom', timeQuickPicks(p.now)[0]!.range);
  const [by, setBy] = usePersisted<RangeBy>('m-history-by', 'entry');
  const [picking, setPicking] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [tfs, setTfs] = usePersisted<string[]>('m-history-tfs', []);
  const [kept, setKept] = usePersisted<Filters>('m-history-filters', NO_FILTERS);
  const f: Filters = { ...NO_FILTERS, ...kept };
  const set = (patch: Partial<Filters>) => setKept({ ...f, ...patch });
  const [sortKey, setSortKey] = usePersisted<Sort>('m-history-sort', 'out-new');
  const sort = SORTS.find((s) => s.key === sortKey) ?? SORTS[0]!;
  const today = todayIst(p.now);
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[0]!;
  // A custom range that no longer holds (a bad value kept) is this expiry day's, said so by the sheet when opened.
  const customOk = timeRangeProblem(custom, p.now) === null;
  const isCustom = range.key === 'custom' && customOk;
  const win = isCustom ? rangeMs(custom) : null;
  // The days asked of the server: a custom range's, a day either side -- a trade entered in it may close after it.
  const from = isCustom ? dayShift(custom.from, -1) : range.days === 0 ? today : daysAgoIst(range.days, p.now);
  const to = isCustom ? (dayShift(custom.to, 1) > today ? today : dayShift(custom.to, 1)) : today;
  // Every closed trade of the days asked, not the newest 500 of any kind (29 Oct 2026: the totals were of what was left).
  const orders = usePoll(() => getClosed(from, to, p.accountParam), 60_000, { deps: [from, to, p.accountParam] });
  const rangeWords = isCustom ? `${timeRangeWords(custom)} · by ${by === 'entry' ? 'entry' : 'exit'} time` : RANGE_WORDS[range.key === 'custom' ? 'today' : range.key];

  const closed = useMemo(() => (orders.data?.trades ?? []).filter((o) => o.position === 0 && o.exitSize > 0), [orders.data]);
  // In the custom window, by the time asked: when it was entered, or when it closed.
  const inRange = useMemo(() => (win ? closed.filter((o) => { const t = by === 'entry' ? entryAt(o) : closedAt(o); return t >= win.from && t <= win.to; }) : closed),
    [closed, win?.from, win?.to, by]); // eslint-disable-line react-hooks/exhaustive-deps
  const strategies = useMemo(() => [...new Set(inRange.map((o) => placedBy(o.plan).label))].sort(), [inRange]);
  // The time frames the trades in range were taken on, each with how many, in the desk's order.
  const tfCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of inRange) { const k = tfOf(o); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m].sort((a, b) => TF_ORDER.indexOf(a[0]) - TF_ORDER.indexOf(b[0]));
  }, [inRange]);
  const tfPicked = tfs.filter((k) => tfCounts.some(([x]) => x === k));
  // A strategy remembered that has no trade in this range is no choice at all.
  const strategy = f.strategy !== 'all' && strategies.includes(f.strategy) ? f.strategy : 'all';
  const shown = inRange.filter((o) =>
    (tfPicked.length === 0 || tfPicked.includes(tfOf(o) ?? ''))
    && (f.result === 'all' || (f.result === 'win' ? netOf(o) > 0 : netOf(o) < 0))
    && (f.opt === 'all' || o.optionSide === f.opt)
    && (f.act === 'all' || (f.act === 'buy') === isLongTrade(o))
    && (strategy === 'all' || placedBy(o.plan).label === strategy)
    && (f.exit === 'all' || o.exitBy === f.exit))
    .sort(sort.by);
  const total = shown.reduce((n, o) => n + netOf(o), 0);
  // Forty rows at a time (10 Oct 2026): thirty days is a thousand-odd trades, drawn at once on a phone. The count and the total above are of all.
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => { setLimit(PAGE); }, [from, to, win?.from, win?.to, by, tfPicked.join(','), f.result, f.opt, f.act, strategy, f.exit, sortKey, p.accountParam]); // eslint-disable-line react-hooks/exhaustive-deps
  const wins = shown.filter((o) => netOf(o) > 0).length;

  // The choices in force, each a chip to take it off -- said over the list, so a short list is never a mystery.
  const chosen: { key: string; label: string; off: () => void }[] = [
    ...tfPicked.map((k) => ({ key: `tf-${k}`, label: tfName(k), off: () => setTfs(tfPicked.filter((x) => x !== k)) })),
    ...(f.result !== 'all' ? [{ key: 'result', label: f.result === 'win' ? 'Won' : 'Lost', off: () => set({ result: 'all' }) }] : []),
    ...(f.opt !== 'all' ? [{ key: 'opt', label: f.opt, off: () => set({ opt: 'all' }) }] : []),
    ...(f.act !== 'all' ? [{ key: 'act', label: f.act === 'sell' ? 'Sold' : 'Bought', off: () => set({ act: 'all' }) }] : []),
    ...(f.exit !== 'all' ? [{ key: 'exit', label: EXITS.find((x) => x.key === f.exit)?.word ?? f.exit, off: () => set({ exit: 'all' }) }] : []),
    ...(strategy !== 'all' ? [{ key: 'strategy', label: strategy, off: () => set({ strategy: 'all' }) }] : []),
  ];
  const clearAll = () => { setTfs([]); setKept(NO_FILTERS); };

  // By day when the list is in time order: each day once, with how many it holds and what they made.
  const page = shown.slice(0, limit);
  const days = useMemo(() => {
    if (!sort.dayOf) return null;
    const all = new Map<string, { n: number; net: number }>();
    for (const o of shown) { const d = todayIst(sort.dayOf(o)); const x = all.get(d) ?? { n: 0, net: 0 }; x.n += 1; x.net += netOf(o); all.set(d, x); }
    return all;
  }, [shown, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Segmented label="Range" value={isCustom ? 'custom' : range.key === 'custom' ? 'today' : range.key} options={RANGES}
        onChange={(k) => (k === 'custom' ? setPicking(true) : setRangeKey(k))} />
      {isCustom && (
        <p aria-label="Custom range" className="m-0 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 text-[13px] text-muted-foreground">
          <span><span className="font-medium text-foreground">{timeRangeWords(custom)}</span> · by {by === 'entry' ? 'entry' : 'exit'} time</span>
          <button type="button" onClick={() => setPicking(true)} className="m-0 min-h-[40px] appearance-none border-0 bg-transparent p-0 font-[inherit] text-[13.5px] font-semibold text-[var(--up)]">Change</button>
        </p>
      )}
      {picking && (
        <DateTimeRangeSheet value={customOk ? custom : timeQuickPicks(p.now)[0]!.range} by={by} now={p.now}
          onApply={(v, b) => { setCustom(v); setBy(b); setRangeKey('custom'); setPicking(false); }}
          onClose={() => setPicking(false)} />
      )}

      {orders.data && <Summary trades={shown} words={rangeWords} filtered={chosen.length > 0} />}

      {/* One row: Filters and Sort, each a thumb's height and half the width. */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button" onClick={() => setFiltering(true)} aria-label={`Filters${chosen.length ? `, ${chosen.length} on` : ''}`}
          className={cn('flex h-11 min-w-0 items-center justify-center gap-2 rounded-lg border border-solid px-3 font-[inherit] text-[14px] font-medium',
            chosen.length ? 'border-[var(--chosen-line)] bg-[var(--chosen-soft)] text-[var(--chosen-text)]' : 'border-border bg-muted text-foreground')}
        >
          <SlidersHorizontal className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">Filters</span>
          {chosen.length > 0 && <span className="grid h-5 min-w-[20px] place-items-center rounded-full bg-[var(--chosen-text)] px-1 text-[11.5px] font-semibold text-[var(--bg)]">{chosen.length}</span>}
        </button>
        <span className="relative min-w-0">
          <select
            aria-label="Sort" value={sort.key} onChange={(e) => setSortKey(e.target.value as Sort)}
            className="h-11 w-full min-w-0 appearance-none truncate rounded-lg border border-solid border-border bg-muted pl-3 pr-8 font-[inherit] text-[14px] font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-[var(--up)]"
          >
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </span>
      </div>
      {chosen.length > 0 && (
        <div role="group" aria-label="Filters on" className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1">
          {chosen.map((c) => (
            <button
              key={c.key} type="button" onClick={c.off} aria-label={`Take off ${c.label}`}
              className="inline-flex h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-solid border-[var(--chosen-line)] bg-[var(--chosen-soft)] pl-3 pr-2 font-[inherit] text-[13px] font-medium text-[var(--chosen-text)]"
            >
              {c.label} <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ))}
          <button type="button" onClick={clearAll} className="h-9 shrink-0 whitespace-nowrap border-0 bg-transparent px-1 font-[inherit] text-[13px] text-[var(--accent)]">Clear all</button>
        </div>
      )}
      {filtering && (
        <FilterSheet
          trades={inRange} tfCounts={tfCounts} tfPicked={tfPicked} onTfs={setTfs} f={{ ...f, strategy }} strategies={strategies} onSet={set}
          onClear={clearAll} shown={shown.length} onClose={() => setFiltering(false)}
        />
      )}

      <Panel
        title={orders.data ? `${shown.length} trade${shown.length === 1 ? '' : 's'} · ${wins} won` : 'Closed trades'}
        right={orders.data && shown.length > 0 ? <Rupees usd={total} signed size="sm" /> : undefined}
      >
        {!orders.data ? <Loading error={orders.error} what="the trades" /> : shown.length === 0 ? (
          <Empty>{inRange.length === 0 ? (isCustom ? `No trade ${by === 'entry' ? 'entered' : 'closed'} ${timeRangeWords(custom)}.` : 'No trade closed in this range.') : 'None match these filters.'}</Empty>
        ) : (
          <ul className="m-0 list-none p-0" aria-label="Closed trades">
            {page.map((o, i) => {
              const day = sort.dayOf ? todayIst(sort.dayOf(o)) : null;
              const head = day !== null && (i === 0 || todayIst(sort.dayOf!(page[i - 1]!)) !== day);
              return (
                <li key={`${o.account?.id ?? ''}-${o.tradeId}`} className={cn(!head && i > 0 && 'border-t border-solid border-x-0 border-b-0 border-[var(--line-soft)]')}>
                  {head && <DayHead day={day!} today={today} n={days?.get(day!)?.n ?? 0} net={days?.get(day!)?.net ?? 0} first={i === 0} />}
                  <ClosedRow o={o} today={day ?? today} openTrade={p.openTrade} showAccount={p.shown === 'all'} />
                </li>
              );
            })}
          </ul>
        )}
        {shown.length > limit && (
          <button
            type="button" onClick={() => setLimit((l) => l + PAGE)}
            className="m-0 mt-2 flex h-11 w-full appearance-none items-center justify-center rounded-lg border border-solid border-border bg-transparent font-[inherit] text-[13.5px] text-foreground"
          >
            Show {Math.min(PAGE, shown.length - limit)} more · {limit} of {shown.length}
          </button>
        )}
      </Panel>
    </>
  );
}

/** Rows drawn at first, and each "Show more" adds. */
const PAGE = 40;

/**
 * What the trades shown made, on top: the net after charges, how many and how many won, the average win and loss, the
 * best and the worst. Of the trades the filters leave, said so when they leave fewer than the range holds.
 */
function Summary({ trades, words, filtered }: { trades: readonly ClosedTrade[]; words: string; filtered: boolean }) {
  const nets = trades.map(netOf);
  const net = nets.reduce((a, n) => a + n, 0);
  const won = nets.filter((n) => n > 0), lost = nets.filter((n) => n < 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, n) => a + n, 0) / xs.length : null);
  const money = (usd: number | null) => (usd === null ? '—' : signedInr(usdToInr(usd)));
  const tone = (usd: number | null) => (usd === null ? undefined : usd > 0 ? 'up' as const : usd < 0 ? 'down' as const : undefined);
  const best = nets.length ? Math.max(...nets) : null, worst = nets.length ? Math.min(...nets) : null;
  return (
    <Panel>
      <section aria-label="What these trades made">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
          <span className="text-[13px] text-muted-foreground">Net after charges</span>
          <span className="text-[11.5px] text-muted-foreground">{words}{filtered ? ' · filtered' : ''}</span>
        </div>
        <Rupees usd={trades.length ? net : null} signed size="xl" />
        <p className="m-0 mb-2 text-[12.5px] tabular-nums text-muted-foreground">
          {trades.length} trade{trades.length === 1 ? '' : 's'}{trades.length ? ` · ${pct(won.length / trades.length, 0)} won` : ''}
        </p>
        <Stats>
          <Stat label="Avg win" tone={won.length ? 'up' : undefined}>{money(avg(won))}</Stat>
          <Stat label="Avg loss" tone={lost.length ? 'down' : undefined}>{money(avg(lost))}</Stat>
          <Stat label="Best" tone={tone(best)}>{money(best)}</Stat>
          <Stat label="Worst" tone={tone(worst)}>{money(worst)}</Stat>
        </Stats>
      </section>
    </Panel>
  );
}

/** A day over its trades: "Today", "Yesterday" or the date, with how many and what they made. */
function DayHead({ day, today, n, net, first }: { day: string; today: string; n: number; net: number; first: boolean }) {
  const name = day === today ? 'Today' : day === dayShift(today, -1) ? 'Yesterday' : dayLabel(day);
  return (
    <div className={cn('flex items-baseline justify-between gap-2 border-b border-solid border-x-0 border-t-0 border-[var(--line)] pb-1', first ? 'mt-0' : 'mt-3')}>
      <h3 className="m-0 text-[12px] font-semibold uppercase tracking-[0.6px] text-muted-foreground">{name}</h3>
      <span className="text-[12px] tabular-nums text-muted-foreground">
        {n} trade{n === 1 ? '' : 's'} · <span className={net > 0 ? 'text-[var(--up)]' : net < 0 ? 'text-[var(--down)]' : ''}>{signedInr(usdToInr(net))}</span>
      </span>
    </div>
  );
}

/** One group of choices in the sheet: a heading over chips that wrap. */
function Choices({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-1.5 p-0 text-[13px] font-medium text-muted-foreground">{label}</legend>
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

/**
 * Every filter in one sheet from the bottom of the screen, each choice with how many of the range's trades it holds;
 * a choice takes effect at once, the list behind it, and the button says how many are left to see.
 */
function FilterSheet({ trades, tfCounts, tfPicked, onTfs, f, strategies, onSet, onClear, shown, onClose }: {
  trades: readonly ClosedTrade[]; tfCounts: [string, number][]; tfPicked: string[]; onTfs: (v: string[]) => void;
  f: Filters; strategies: string[]; onSet: (p: Partial<Filters>) => void; onClear: () => void; shown: number; onClose: () => void;
}) {
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => { document.body.style.overflow = before; window.removeEventListener('keydown', esc); };
  }, [onClose]);
  const count = (test: (o: ClosedTrade) => boolean) => trades.filter(test).length;
  const n = (k: number) => <span className="tabular-nums opacity-70">{k}</span>;
  const exits = EXITS.map((x) => [x, count((o) => o.exitBy === x.key)] as const).filter(([, k]) => k > 0);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center" role="presentation">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 border-0 bg-black/60 p-0" tabIndex={-1} />
      <div role="dialog" aria-modal="true" aria-labelledby="history-filters-title"
        className="relative max-h-[88vh] w-full max-w-[560px] overflow-y-auto rounded-t-2xl border-t border-border bg-background px-4 pb-[env(safe-area-inset-bottom)] pt-2">
        <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-[var(--line)]" />
        <div className="flex items-center justify-between">
          <h2 id="history-filters-title" className="m-0 text-[17px] font-semibold">Filters</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="-mr-2 grid h-11 w-11 place-items-center rounded-md border-0 bg-transparent text-muted-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-2 grid gap-4">
          <Choices label="Result">
            <Chip on={f.result === 'all'} onClick={() => onSet({ result: 'all' })}>All {n(trades.length)}</Chip>
            <Chip on={f.result === 'win'} onClick={() => onSet({ result: 'win' })}>Won {n(count((o) => netOf(o) > 0))}</Chip>
            <Chip on={f.result === 'loss'} onClick={() => onSet({ result: 'loss' })}>Lost {n(count((o) => netOf(o) < 0))}</Chip>
          </Choices>
          <Choices label="Option">
            <Chip on={f.opt === 'all'} onClick={() => onSet({ opt: 'all' })}>Both</Chip>
            <Chip on={f.opt === 'CE'} onClick={() => onSet({ opt: 'CE' })}>CE {n(count((o) => o.optionSide === 'CE'))}</Chip>
            <Chip on={f.opt === 'PE'} onClick={() => onSet({ opt: 'PE' })}>PE {n(count((o) => o.optionSide === 'PE'))}</Chip>
          </Choices>
          <Choices label="Side">
            <Chip on={f.act === 'all'} onClick={() => onSet({ act: 'all' })}>Both</Chip>
            <Chip on={f.act === 'sell'} onClick={() => onSet({ act: 'sell' })}>Sold {n(count((o) => !isLongTrade(o)))}</Chip>
            <Chip on={f.act === 'buy'} onClick={() => onSet({ act: 'buy' })}>Bought {n(count((o) => isLongTrade(o)))}</Chip>
          </Choices>
          {exits.length > 0 && (
            <Choices label="How it closed">
              <Chip on={f.exit === 'all'} onClick={() => onSet({ exit: 'all' })}>Any</Chip>
              {exits.map(([x, k]) => <Chip key={x.key} on={f.exit === x.key} onClick={() => onSet({ exit: f.exit === x.key ? 'all' : x.key })}>{x.word} {n(k)}</Chip>)}
            </Choices>
          )}
          {/* The signal's time frame: one or several, each with its count; none chosen is every one. */}
          {tfCounts.length > 1 && (
            <Choices label="Time frame">
              <Chip on={tfPicked.length === 0} onClick={() => onTfs([])}>All TF</Chip>
              {tfCounts.map(([k, c]) => (
                <Chip key={k} on={tfPicked.includes(k)} onClick={() => onTfs(tfPicked.includes(k) ? tfPicked.filter((x) => x !== k) : [...tfPicked, k])}>
                  {tfName(k)} {n(c)}
                </Chip>
              ))}
            </Choices>
          )}
          {strategies.length > 1 && (
            <Choices label="Strategy">
              <Chip on={f.strategy === 'all'} onClick={() => onSet({ strategy: 'all' })}>All</Chip>
              {strategies.map((s) => <Chip key={s} on={f.strategy === s} onClick={() => onSet({ strategy: f.strategy === s ? 'all' : s })}>{s} {n(count((o) => placedBy(o.plan).label === s))}</Chip>)}
            </Choices>
          )}
        </div>
        {/* Held at the foot of the sheet however far it is scrolled: the way out is always a thumb away. */}
        <div className="sticky bottom-0 -mx-4 mt-4 grid grid-cols-2 gap-3 border-t border-solid border-x-0 border-b-0 border-[var(--line-soft)] bg-background px-4 pb-3 pt-3">
          <button type="button" onClick={onClear} className="h-12 rounded-lg border border-solid border-border bg-transparent font-[inherit] text-[15px] text-foreground">Clear all</button>
          <button type="button" onClick={onClose} className="h-12 whitespace-nowrap rounded-lg border-0 bg-[var(--up)] px-2 font-[inherit] text-[14px] font-semibold text-[var(--bg)]">
            Show {shown} trade{shown === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A moment on a row: its time on the row's own day, its date and time on any other. */
const whenText = (ms: number, day: string) => (todayIst(ms) === day ? clock(ms) : stamp(ms));

/**
 * One leg of a row, In or Out: when and at what (owner, 29 Oct 2026: "in and out both on the row"). Two of them side
 * by side, each half the row, so a 320px phone reads both without a line wrapping.
 */
function Leg({ label, at, px, day }: { label: string; at: number; px: number | null; day: string }) {
  // The price beside its word, the moment on a line of its own: "28 Oct, 17:24" has the box's whole width at 320px.
  return (
    <span className="grid min-w-0 gap-0.5 rounded-md bg-muted px-2 py-1.5 leading-tight">
      <span className="flex min-w-0 items-baseline justify-between gap-1.5">
        <span className="shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.6px] text-muted-foreground">{label}</span>
        <span className="min-w-0 truncate text-[14px] font-semibold tabular-nums text-foreground">{price(px)}</span>
      </span>
      <When className="truncate text-[12px]">{whenText(at, day)}</When>
    </span>
  );
}

// Memoised (10 Oct 2026): the screen redraws with the shell's clock every 5 s, and its forty rows with it, unchanged.
const ClosedRow = memo(function ClosedRow({ o, today, openTrade, showAccount }: { o: ClosedTrade; today: string; openTrade: (tradeId: string) => void; showAccount: boolean }) {
  const net = netOf(o);
  const long = isLongTrade(o);
  const exit = exitOf(o);
  const words = [`held ${duration(heldOf(o))}`, o.plan?.signal ? `#${o.plan.signal.n} ${o.plan.signal.name} · ${o.plan.signal.tf}` : null, showAccount && o.account ? o.account.name : null].filter(Boolean).join(' · ');
  return (
    <ListButton onClick={() => openTrade(o.tradeId)} label={`${contractLabel(o.symbol)}: open the trade`}>
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn('shrink-0 text-[12px] font-bold', long ? 'text-[var(--buy)]' : 'text-[var(--down)]')}>{long ? 'BUY' : 'SELL'}</span>
          <span className="truncate text-[14.5px] font-semibold">{contractLabel(o.symbol)}</span>
        </span>
        <span className={cn('shrink-0 text-[15px] font-semibold tabular-nums', net > 0 ? 'text-[var(--up)]' : net < 0 ? 'text-[var(--down)]' : '')}>{signedInr(usdToInr(net))}</span>
      </span>
      <span className="mt-1.5 grid grid-cols-2 gap-1.5">
        <Leg label="In" at={entryAt(o)} px={o.entryAvgPrice} day={today} />
        <Leg label="Out" at={closedAt(o)} px={o.exitAvgPrice} day={today} />
      </span>
      {/* Wraps rather than cuts (29 Oct 2026: at 320px the strategy and the signal were each an ellipsis). */}
      {/* How it closed leads the line, where the contract above keeps its room; a tag shortens only past a whole line. */}
      <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
        {exit && <Pill tone={exit.tone}>{exit.word}</Pill>}
        {/* Here a name longer than the line wraps onto a second one; elsewhere the tag keeps its one line. */}
        <StrategyTag plan={o.plan} className="max-w-full shrink-0 [&>span]:whitespace-normal [&>span]:break-words" />
        <GroupTag strategyId={o.plan?.strategyId} className="max-w-full shrink-0" />
        <span className="min-w-0 text-[12px] leading-snug text-muted-foreground">{words}</span>
      </span>
    </ListButton>
  );
});
