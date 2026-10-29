import { memo, useEffect, useMemo, useState } from 'react';
import { usePersisted } from '@/hooks/usePersisted';
import { rangeMs, timeQuickPicks, timeRangeProblem, timeRangeWords, type DateTimeRange } from '@/lib/date-time-range';
import { DateTimeRangeSheet, type RangeBy } from '@/components/mobile/DateTimeRangeSheet';
import { getOrders } from '@/api/phone';
import type { OrderRecord } from '@/types/trade';
import { usePoll } from '@/hooks/usePoll';
import { clock, contractLabel, duration, price, signedInr, stamp, usdToInr } from '@/lib/format';
import { daysAgoIst, todayIst } from '@/lib/report';
import { isLongTrade } from '@/lib/long-exits';
import { usePhoneData } from '@/components/mobile/phone-context';
import { Chip, Chips, Empty, ListButton, Loading, Panel, Rupees, Segmented, Select, When } from '@/components/mobile/parts';
import { PlacedLine, placedBy } from '@/components/mobile/StrategyTag';

/**
 * Trade history (6 Oct 2026): the closed trades, not the orders -- what each made after charges -- filtered by
 * result, CE or PE, sold or bought and strategy, with the total of what is shown. Separate from Orders, which is
 * the order's life; this is the trade's end. Each row carries its strategy as a tag (`StrategyTag`), and the
 * strategy filter names them the way the tags do.
 *
 * The range (19 Oct 2026, the owner: "a custom date and time range; a time frame filter -- user friendly, responsive"):
 * Today, 7, 30 or 90 days, as the phone's other screens; or Custom, a From and a To each a date and a time, IST, a trade
 * counted by its entry or its exit -- the desk's own windows (this expiry day, last night) a tap away. And the signal's
 * time frame: one or several of those the trades shown were taken on.
 */

type RangeKey = 'today' | '7' | '30' | '90' | 'custom';
const RANGES: { key: RangeKey; label: string; spoken?: string; days: number }[] = [
  { key: 'today', label: 'Today', days: 0 }, { key: '7', label: '7D', spoken: '7 days', days: 6 }, { key: '30', label: '30D', spoken: '30 days', days: 29 },
  { key: '90', label: '90D', spoken: '90 days', days: 89 }, { key: 'custom', label: 'Custom', days: -1 },
];
/** A trade's signal time frame: its own, `chain` with the timeframe chain; null with no signal. */
const tfOf = (o: OrderRecord): string | null => (o.plan?.signal ? (o.plan.signal.mode === 'mtf' ? 'chain' : o.plan.signal.tf) : null);
const TF_ORDER = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', 'chain'];
const tfName = (k: string) => (k === 'chain' ? 'TF chain' : k);
const entryAt = (o: OrderRecord) => { const ts = o.fills.filter((f) => f.role === 'entry').map((f) => f.ts); return ts.length ? Math.min(...ts) : o.updatedAt; };
const dayShift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
type Result = 'all' | 'win' | 'loss';
type Opt = 'all' | 'CE' | 'PE';
type Act = 'all' | 'sell' | 'buy';

const netOf = (o: OrderRecord) => o.netRealisedUsd ?? o.realisedPnl;
const closedAt = (o: OrderRecord) => Math.max(o.updatedAt, ...o.fills.filter((f) => f.role !== 'entry').map((f) => f.ts));
const heldOf = (o: OrderRecord) => closedAt(o) - entryAt(o);

/**
 * The order of the list (owner, 29 Oct 2026: "trade history -- a sort; in and out both on the row"): by when it
 * closed, the newest first as it always was, or the oldest; by when it was entered; by what it made, most first or
 * the worst first; by how long it was held. Remembered on the phone. The count and the total above are the same in
 * any order.
 */
type Sort = 'out-new' | 'out-old' | 'in-new' | 'net-high' | 'net-low' | 'held-long';
const SORTS: { key: Sort; label: string; by: (a: OrderRecord, b: OrderRecord) => number }[] = [
  { key: 'out-new', label: 'Newest exit first', by: (a, b) => closedAt(b) - closedAt(a) },
  { key: 'out-old', label: 'Oldest exit first', by: (a, b) => closedAt(a) - closedAt(b) },
  { key: 'in-new', label: 'Newest entry first', by: (a, b) => entryAt(b) - entryAt(a) },
  { key: 'net-high', label: 'Most made first', by: (a, b) => netOf(b) - netOf(a) || closedAt(b) - closedAt(a) },
  { key: 'net-low', label: 'Most lost first', by: (a, b) => netOf(a) - netOf(b) || closedAt(b) - closedAt(a) },
  { key: 'held-long', label: 'Held longest first', by: (a, b) => heldOf(b) - heldOf(a) || closedAt(b) - closedAt(a) },
];

export function HistoryScreen() {
  const p = usePhoneData();
  const [rangeKey, setRangeKey] = usePersisted<RangeKey>('m-history-range', 'today');
  const [custom, setCustom] = usePersisted<DateTimeRange>('m-history-custom', timeQuickPicks(p.now)[0]!.range);
  const [by, setBy] = usePersisted<RangeBy>('m-history-by', 'entry');
  const [picking, setPicking] = useState(false);
  const [tfs, setTfs] = usePersisted<string[]>('m-history-tfs', []);
  const [result, setResult] = useState<Result>('all');
  const [opt, setOpt] = useState<Opt>('all');
  const [act, setAct] = useState<Act>('all');
  const [strategy, setStrategy] = useState('all');
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
  const orders = usePoll(() => getOrders(from, to, p.accountParam, 'completed'), 60_000, { deps: [from, to, p.accountParam] });

  const closed = useMemo(
    () => (orders.data?.trades ?? []).filter((o) => o.position === 0 && o.exitSize > 0).sort((a, b) => closedAt(b) - closedAt(a)),
    [orders.data],
  );
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
  const shown = inRange.filter((o) =>
    (tfPicked.length === 0 || tfPicked.includes(tfOf(o) ?? ''))
    && (result === 'all' || (result === 'win' ? netOf(o) > 0 : netOf(o) < 0))
    && (opt === 'all' || o.optionSide === opt)
    && (act === 'all' || (act === 'buy') === isLongTrade(o))
    && (strategy === 'all' || placedBy(o.plan).label === strategy))
    .sort(sort.by);
  const total = shown.reduce((n, o) => n + netOf(o), 0);
  // Forty rows at a time (10 Oct 2026): thirty days is a thousand-odd trades, drawn at once on a phone. The count and the total above are of all.
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => { setLimit(PAGE); }, [from, to, win?.from, win?.to, by, tfPicked.join(','), result, opt, act, strategy, sortKey, p.accountParam]); // eslint-disable-line react-hooks/exhaustive-deps
  const wins = shown.filter((o) => netOf(o) > 0).length;

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
      {/* The signal's time frame: one or several, each with its count; none chosen is every one. */}
      {tfCounts.length > 1 && (
        <Chips label="Time frame">
          <Chip on={tfPicked.length === 0} onClick={() => setTfs([])}>All TF</Chip>
          {tfCounts.map(([k, n]) => (
            <Chip key={k} on={tfPicked.includes(k)} onClick={() => setTfs(tfPicked.includes(k) ? tfPicked.filter((x) => x !== k) : [...tfPicked, k])}>
              {tfName(k)} <span className="tabular-nums opacity-70">{n}</span>
            </Chip>
          ))}
        </Chips>
      )}
      <Chips label="Filters">
        <Chip on={result === 'win'} onClick={() => setResult(result === 'win' ? 'all' : 'win')}>Won</Chip>
        <Chip on={result === 'loss'} onClick={() => setResult(result === 'loss' ? 'all' : 'loss')}>Lost</Chip>
        <Chip on={opt === 'CE'} onClick={() => setOpt(opt === 'CE' ? 'all' : 'CE')}>CE</Chip>
        <Chip on={opt === 'PE'} onClick={() => setOpt(opt === 'PE' ? 'all' : 'PE')}>PE</Chip>
        <Chip on={act === 'sell'} onClick={() => setAct(act === 'sell' ? 'all' : 'sell')}>Sold</Chip>
        <Chip on={act === 'buy'} onClick={() => setAct(act === 'buy' ? 'all' : 'buy')}>Bought</Chip>
      </Chips>
      {strategies.length > 1 && (
        <Select label="Strategy" value={strategy} onChange={setStrategy}>
          <option value="all">All strategies</option>
          {strategies.map((x) => <option key={x} value={x}>{x}</option>)}
        </Select>
      )}
      <Select label="Sort" value={sort.key} onChange={(v) => setSortKey(v as Sort)}>
        {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </Select>

      <Panel
        title={orders.data ? `${shown.length} trade${shown.length === 1 ? '' : 's'} · ${wins} won` : 'Closed trades'}
        right={orders.data && shown.length > 0 ? <Rupees usd={total} signed size="sm" /> : undefined}
      >
        {!orders.data ? <Loading error={orders.error} what="the trades" /> : shown.length === 0 ? (
          <Empty>{inRange.length === 0 ? (isCustom ? `No trade ${by === 'entry' ? 'entered' : 'closed'} ${timeRangeWords(custom)}.` : 'No trade closed in this range.') : 'None match these filters.'}</Empty>
        ) : (
          <ul className="m-0 list-none divide-y divide-[var(--line-soft)] p-0" aria-label="Closed trades">
            {shown.slice(0, limit).map((o) => (
              <ClosedRow key={`${o.account?.id ?? ''}-${o.tradeId}`} o={o} today={today} openTrade={p.openTrade} showAccount={p.shown === 'all'} />
            ))}
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

/** A moment on a row: its time on today's IST date, its date and time on any other -- a 30-day list spans many days. */
const whenText = (ms: number, today: string) => (todayIst(ms) === today ? clock(ms) : stamp(ms));

/**
 * One leg of a row, In or Out: when and at what (owner, 29 Oct 2026: "in and out both on the row"). Two of them side
 * by side, each half the row, so a 360px phone reads both without a line wrapping.
 */
function Leg({ label, at, px, today }: { label: string; at: number; px: number | null; today: string }) {
  return (
    <span className="grid min-w-0 gap-px rounded-md bg-muted px-2 py-1.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.6px] text-muted-foreground">{label}</span>
      <When className="truncate text-[12.5px]">{whenText(at, today)}</When>
      <span className="truncate text-[13px] font-medium tabular-nums text-foreground">{price(px)}</span>
    </span>
  );
}

// Memoised (10 Oct 2026): the screen redraws with the shell's clock every 5 s, and its forty rows with it, unchanged.
const ClosedRow = memo(function ClosedRow({ o, today, openTrade, showAccount }: { o: OrderRecord; today: string; openTrade: (tradeId: string) => void; showAccount: boolean }) {
  const net = netOf(o);
  const long = isLongTrade(o);
  return (
    <li>
      <ListButton onClick={() => openTrade(o.tradeId)} label={`${contractLabel(o.symbol)}: open the trade`}>
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-[14.5px] font-semibold">{long ? 'BUY' : 'SELL'} {contractLabel(o.symbol)}</span>
          <span className={net > 0 ? 'font-semibold text-[var(--up)]' : net < 0 ? 'font-semibold text-[var(--down)]' : 'font-semibold'}>{signedInr(usdToInr(net))}</span>
        </span>
        <span className="mt-1 grid grid-cols-2 gap-1.5">
          <Leg label="In" at={entryAt(o)} px={o.entryAvgPrice} today={today} />
          <Leg label="Out" at={closedAt(o)} px={o.exitAvgPrice} today={today} />
        </span>
        <PlacedLine
          plan={o.plan} className="mt-1"
          rest={[`held ${duration(heldOf(o))}`, o.plan?.signal ? `#${o.plan.signal.n} ${o.plan.signal.name} · ${o.plan.signal.tf}` : null, showAccount && o.account ? o.account.name : null]}
        />
      </ListButton>
    </li>
  );
});
