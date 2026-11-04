import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Download, RefreshCw } from 'lucide-react';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { DateRangePicker, describeRange, type DateRangeValue } from '@/components/ui/date-range-picker';
import { Money } from '@/components/ui/money';
import { NumberField } from '@/components/ui/number-field';
import { Switch } from '@/components/ui/switch';
import { useTimeWindow } from '@/components/report/TimeWindow';
import { REPLAY_DEFAULT_LOTS, REPLAY_DEFAULT_MAX_OPEN, REPLAY_LOTS_MOST, REPLAY_MAX_OPEN_MOST, getOptionReplay, optionReplayCsvUrl, type OptionReplayQuery } from '@/api/option-replay';
import { usePoll } from '@/hooks/usePoll';
import { useSynced } from '@/hooks/useSynced';
import { compactInr, contractLabel, inr, signedInr, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';
import { downloadHeatTable, type HeatCell } from '@/lib/heat-table-image';
import type { ActualExit, OptionReplay, OptionReplayRow, ReplayExit, ReplayGroup, ReplayRules, ReplayShow, ReplaySide, ReplaySource } from '@/types/option-replay';

/**
 * The option history (owner, 3 Nov 2026: "in the Methods menu, like the signal history, an option history -- the
 * option taken against each signal; skip perp SL and skip perp TGT, the option's SL and TGT, the time range, the date
 * range and the timeframe editable, user friendly -- to see whether it would have made a profit or a loss").
 *
 * Each line is a trade the desk really made: the option it really sold against a signal, at the price it really got.
 * Its exit is worked again by the server on that contract's recorded prices under the rules set here, and set beside
 * what really happened -- so a rule is judged on the desk's own trades, not on a backtest's guesses. Every choice is
 * remembered (`useSynced`); a rule typed is asked for half a second after the last key, and a rule that cannot be
 * replayed says why instead of asking.
 */

/** What the desk runs today: the perp's levels left out, a 250% option SL, a 90% option TGT (server: `LIVE_RULES`). */
export const LIVE_RULES: ReplayRules = { skipPerpSl: true, skipPerpTgt: true, stopPct: 2.5, targetPct: 0.9 };
export const TF_CHOICES: readonly { key: string; name: string }[] = [
  { key: '3m', name: '3m' }, { key: '5m', name: '5m' }, { key: '15m', name: '15m' }, { key: '30m', name: '30m' },
  { key: '1h', name: '1h' }, { key: '2h', name: '2h' }, { key: '4h', name: '4h' }, { key: 'chain', name: 'Chain' },
];
/** The server's limits (`REPLAY_MAX_DAYS`, `MAX_STOP_PCT`, `MAX_TARGET_PCT`), said before asking. */
const MAX_DAYS = 366;
const MAX_SL_PCT = 2_000;
const MAX_TGT_PCT = 99;
const DEBOUNCE_MS = 500;
/** Trades on one page of the list; the server holds the rest (`?offset=`). */
const PAGE = 200;

export const REPLAY_EXIT_NAMES: Record<ReplayExit, string> = {
  'option-tgt': 'Option TGT', 'option-sl': 'Option SL', 'perp-sl': 'Perp SL', 'perp-tgt': 'Perp TGT', close: 'Held to 5:29 PM',
};
const ACTUAL_EXIT_NAMES: Record<ActualExit, string> = { 'option-tgt': 'Option TGT', 'option-sl': 'Option SL', desk: 'Desk close', other: 'Other' };

/** The expiry day running now: from 5:30 PM IST it is tomorrow's (the server's `sessionDayOf`). */
export const expiryDayNow = (now = Date.now()) => new Date(now + 12 * 3_600_000).toISOString().slice(0, 10);
const dayBefore = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const daysIn = (r: DateRangeValue) => Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000) + 1;

/** What is wrong with the rules as typed, in words; null when they can be asked for. */
export function rulesProblem(r: ReplayRules): string | null {
  if (!Number.isFinite(r.stopPct) || r.stopPct < 0 || r.stopPct * 100 > MAX_SL_PCT) return `Option SL must be 0 (none) to ${MAX_SL_PCT.toLocaleString('en-US')}%.`;
  if (!Number.isFinite(r.targetPct) || r.targetPct < 0 || r.targetPct * 100 > MAX_TGT_PCT) return `Option TGT must be 0 (none) to ${MAX_TGT_PCT}%.`;
  return null;
}

const sameRules = (a: ReplayRules, b: ReplayRules) =>
  a.skipPerpSl === b.skipPerpSl && a.skipPerpTgt === b.skipPerpTgt && a.stopPct === b.stopPct && a.targetPct === b.targetPct;
const winText = (s: ReplaySide) => (s.trades ? `${((100 * s.wins) / s.trades).toFixed(1)}%` : '—');
const toneOf = (usd: number) => (usd > 0 ? 'text-[var(--up)]' : usd < 0 ? 'text-[var(--down)]' : 'text-muted-foreground');
const rupees = (usd: number) => signedInr(usdToInr(usd));
const ist = (ms: number) => new Date(ms + 5.5 * 3_600_000);
const when = (ms: number | null) => {
  if (ms === null) return '—';
  const d = ist(ms);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const price = (n: number | null) => (n === null ? '—' : n.toFixed(n >= 100 ? 0 : 1));

/** Which trades the list shows, by what they make under the rules set: all, those in profit, those in loss -- or those the rules made better or worse. */
export type Show = ReplayShow;
const BADGE_TONE: Record<Show, string> = {
  all: 'bg-[var(--line)] text-foreground', profit: 'bg-[var(--up)] text-background', loss: 'bg-[var(--down)] text-background',
  better: 'bg-[var(--up)] text-background', worse: 'bg-[var(--down)] text-background',
};
const SHOWS: readonly { id: Show; name: string }[] = [
  { id: 'all', name: 'All' }, { id: 'profit', name: 'Profit' }, { id: 'loss', name: 'Loss' }, { id: 'better', name: 'Better' }, { id: 'worse', name: 'Worse' },
];
/**
 * How a group's list is ranked (owner, 3 Nov 2026: "worse / better repeat count; count-wise, rank-wise list, user
 * friendly"): by what it makes under the rules, by the change from the real orders, by how many trades the rules made
 * better or worse, by the trades -- each best first; the days also by date, newest first. The rank is the line's place.
 */
export type GroupSort = 'date' | 'net' | 'change' | 'wins' | 'losses' | 'daysUp' | 'daysDown' | 'better' | 'worse' | 'trades';
const GROUP_SORTS: readonly { id: GroupSort; name: string }[] = [
  { id: 'date', name: 'Date' }, { id: 'net', name: 'With rules' }, { id: 'change', name: 'Change' },
  { id: 'wins', name: 'Most in profit' }, { id: 'losses', name: 'Most in loss' },
  { id: 'daysUp', name: 'Most profit days' }, { id: 'daysDown', name: 'Most loss days' },
  { id: 'better', name: 'Most better' }, { id: 'worse', name: 'Most worse' }, { id: 'trades', name: 'Most trades' },
];
/** What a count badge ranks the groups by when it is tapped (owner, 3 Nov 2026: "overall worst / better counts like a notification; rank by it"). */
export const SORT_OF_SHOW: Record<Show, GroupSort> = { all: 'trades', profit: 'wins', loss: 'losses', better: 'better', worse: 'worse' };
const changeOf = (g: ReplayGroup) => g.replay.netUsd - g.actual.netUsd;
/** The groups in rank order. A day with no trade is always last but by date. */
export function rankGroups(groups: readonly ReplayGroup[], by: GroupSort): ReplayGroup[] {
  if (by === 'date') return [...groups];
  const val = (g: ReplayGroup) => (by === 'net' ? g.replay.netUsd : by === 'change' ? changeOf(g) : by === 'wins' ? g.replay.wins : by === 'losses' ? g.replay.losses
    : by === 'daysUp' ? g.daysUp : by === 'daysDown' ? g.daysDown
    : by === 'better' ? g.better : by === 'worse' ? g.worse : g.trades);
  return [...groups].sort((a, b) => ((a.trades === 0) !== (b.trades === 0) ? (a.trades === 0 ? 1 : -1) : val(b) - val(a)));
}

type GroupTab = 'grid' | 'days' | 'hours' | 'slots' | 'timeframes' | 'methods' | 'accounts';
/** Each list, and the line under its tabs saying what it is for. */
const GROUP_TABS: readonly { id: GroupTab; name: string; what: string }[] = [
  { id: 'grid', name: 'Method × timeframe', what: 'Every method on every timeframe: green makes money with these rules, red loses. Methods ranked; tap a square for its figures.' },
  { id: 'days', name: 'Days', what: 'Each expiry day. Tap one to see its trades.' },
  { id: 'hours', name: 'Hours', what: 'By the hour the trade was entered (IST), over every day chosen.' },
  { id: 'slots', name: 'Method × hour', what: 'Each method in each hour, over every day chosen: which lose again and again, which keep making money. Loss days and profit days count how often.' },
  { id: 'methods', name: 'Methods', what: 'Each method, over every day chosen.' },
  { id: 'timeframes', name: 'Timeframes', what: 'Each timeframe, the chain as Chain.' },
  { id: 'accounts', name: 'Accounts', what: 'Each broker account.' },
];
const GROUP_HEAD: Record<GroupTab, string> = { grid: 'Method', days: 'Expiry day', hours: 'Hour', slots: 'Method · hour', methods: 'Method', timeframes: 'Timeframe', accounts: 'Account' };

export function OptionHistory() {
  // Null: the last seven expiry days, rolling -- so the card never opens on a stale week.
  const [range, setRange] = useSynced<DateRangeValue | null>('optionHistory.range', null);
  const [tfs, setTfs] = useSynced<string[]>('optionHistory.tfs', []);
  const [rules, setRules] = useSynced<ReplayRules>('optionHistory.rules', LIVE_RULES);
  // The method × timeframe grid first: what the card is for (owner, 3 Nov 2026).
  const [tab, setTab] = useSynced<GroupTab>('optionHistory.tab', 'grid');
  const [show, setShow] = useSynced<Show>('optionHistory.show', 'all');
  const [sortBy, setSortBy] = useSynced<GroupSort>('optionHistory.sort', 'net');
  /*
   * Every signal of the signal history, always (owner, 3 Nov 2026: "not by the accounts' rules -- by the signal history,
   * with only the option history's settings"; then "every signal based"). The desk's own orders are the server's other
   * source (`?source=orders`), not offered here: they stand beside each signal instead.
   */
  const { window: hours, whole, control: hoursControl } = useTimeWindow('optionHistory');
  /*
   * As the desk would have taken them (owner, 4 Nov 2026: "at most open varunum, default 250, and lot, default 1"; "signal
   * against elam option history trades correct real time maari edukunum"): each signal in the order it filled, at most
   * this many open at once, each this many lots. Asked half a second after the last change, as the rules are.
   */
  const [maxOpen, setMaxOpen] = useSynced<number>('optionHistory.maxOpen', REPLAY_DEFAULT_MAX_OPEN);
  const [lots, setLots] = useSynced<number>('optionHistory.lots', REPLAY_DEFAULT_LOTS);
  const [sizing, setSizing] = useState({ maxOpen: maxOpen ?? REPLAY_DEFAULT_MAX_OPEN, lots: lots ?? REPLAY_DEFAULT_LOTS });
  useEffect(() => { setSizing({ maxOpen: maxOpen ?? REPLAY_DEFAULT_MAX_OPEN, lots: lots ?? REPLAY_DEFAULT_LOTS }); }, [maxOpen, lots]);
  const sizingProblem = !Number.isInteger(sizing.maxOpen) || sizing.maxOpen < 1 || sizing.maxOpen > REPLAY_MAX_OPEN_MOST
    ? `At most open must be a whole number from 1 to ${REPLAY_MAX_OPEN_MOST.toLocaleString('en-US')}.`
    : !Number.isInteger(sizing.lots) || sizing.lots < 1 || sizing.lots > REPLAY_LOTS_MOST ? `Lots must be a whole number from 1 to ${REPLAY_LOTS_MOST.toLocaleString('en-US')}.` : null;
  useEffect(() => {
    if (sizingProblem || (sizing.maxOpen === maxOpen && sizing.lots === lots)) return;
    const t = setTimeout(() => { setMaxOpen(sizing.maxOpen); setLots(sizing.lots); }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [sizing.maxOpen, sizing.lots, sizingProblem]); // eslint-disable-line react-hooks/exhaustive-deps
  const [day, setDay] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  // The rules as typed, and the ones asked for half a second after the last change.
  const [draft, setDraft] = useState<ReplayRules>(rules ?? LIVE_RULES);
  useEffect(() => { setDraft(rules ?? LIVE_RULES); }, [rules?.skipPerpSl, rules?.skipPerpTgt, rules?.stopPct, rules?.targetPct]); // eslint-disable-line react-hooks/exhaustive-deps
  const draftProblem = rulesProblem(draft);
  useEffect(() => {
    if (draftProblem || (rules && sameRules(draft, rules))) return;
    const t = setTimeout(() => setRules(draft), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft, draftProblem]); // eslint-disable-line react-hooks/exhaustive-deps

  const today = expiryDayNow();
  const span: DateRangeValue = range ?? { from: dayBefore(today, 6), to: today };
  const spanProblem = daysIn(span) > MAX_DAYS ? `At most ${MAX_DAYS} days -- a year -- at a time: pick a shorter range.` : null;
  const shownMax = maxOpen ?? REPLAY_DEFAULT_MAX_OPEN, shownLots = lots ?? REPLAY_DEFAULT_LOTS;
  const base = useMemo(() => ({
    from: span.from, to: span.to, hours: whole ? null : hours, tfs: tfs ?? [], rules: rules ?? LIVE_RULES, oneContract: true, source: 'signals' as ReplaySource,
    maxOpen: shownMax, lots: shownLots,
  }), [span.from, span.to, whole, hours.from, hours.to, (tfs ?? []).join(','), JSON.stringify(rules), shownMax, shownLots]); // eslint-disable-line react-hooks/exhaustive-deps
  const baseKey = JSON.stringify(base);
  // A new question starts the list again from its first page, of every day.
  useEffect(() => { setDay(null); setOffset(0); }, [baseKey]);
  // No day tapped, no trades listed: the answer's figures alone (one line, the least a page can be).
  const asked: OptionReplayQuery = { ...base, list: { day, show: show ?? 'all', offset: day ? offset : 0, limit: day ? PAGE : 1 } };
  const key = JSON.stringify(asked);
  const { data, error, loading, refresh } = usePoll(() => getOptionReplay(asked), 5 * 60_000, { deps: [key], enabled: spanProblem === null });


  const toggleTf = (k: string) => {
    const now = tfs ?? [];
    setTfs(now.includes(k) ? now.filter((x) => x !== k) : TF_CHOICES.map((c) => c.key).filter((c) => c === k || now.includes(c)));
  };
  const asLive = sameRules(draft, LIVE_RULES);
  const period = `${range ? describeRange(span) : 'Last 7 days'}${whole ? '' : ` · ${hours.from}–${hours.to}`}`;

  const chip = (on: boolean, label: string, onClick: () => void, title?: string) => (
    <button
      key={label} type="button" aria-pressed={on} onClick={onClick} title={title}
      className={cn(
        'h-9 min-w-[44px] rounded-md border border-solid px-2.5 font-[inherit] text-[13px]',
        on ? 'border-[var(--accent)] bg-[var(--accent-fill)] font-semibold text-foreground' : 'border-border bg-transparent text-muted-foreground',
      )}
    >
      {label}
    </button>
  );

  const settings = (
    <div className="grid min-w-0 gap-3 lg:grid-cols-2">
      <section aria-label="Which trades" className="grid min-w-0 content-start gap-2 rounded-lg border border-solid border-border px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] font-medium">Expiry days</span>
          <span className="flex items-center gap-2">
            <DateRangePicker value={span} onChange={(v: DateRangeValue | null) => setRange(v)} />
            {range && (
              <button type="button" onClick={() => setRange(null)} className="min-h-[36px] border-0 bg-transparent p-0 font-[inherit] text-[13px] text-[var(--accent)]">
                Last 7 days
              </button>
            )}
          </span>
        </div>
        {spanProblem && <p role="alert" className="m-0 text-[12px] text-[var(--down)]">{spanProblem}</p>}
        <div className="grid gap-1.5">
          <span className="text-[13px] font-medium">Timeframes <span className="font-normal text-muted-foreground">· none chosen is all</span></span>
          <div role="group" aria-label="Timeframes" className="flex flex-wrap gap-1.5">
            {chip((tfs ?? []).length === 0, 'All', () => setTfs([]))}
            {TF_CHOICES.map((c) => chip((tfs ?? []).includes(c.key), c.name, () => toggleTf(c.key), c.key === 'chain' ? 'The timeframe chain (the "all time" strategies)' : undefined))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid min-w-0 gap-1 text-[12px] text-muted-foreground">
            At most open
            <NumberField label="At most open at once" decimals={0} invalid={sizingProblem?.startsWith('At most') ?? false}
                         value={sizing.maxOpen} onChange={(n) => setSizing((x) => ({ ...x, maxOpen: n }))} />
          </label>
          <label className="grid min-w-0 gap-1 text-[12px] text-muted-foreground">
            Lots each
            <NumberField label="Lots each trade" decimals={0} invalid={sizingProblem?.startsWith('Lots') ?? false}
                         value={sizing.lots} onChange={(n) => setSizing((x) => ({ ...x, lots: n }))} />
          </label>
        </div>
        {sizingProblem && <p role="alert" className="m-0 text-[12px] text-[var(--down)]">{sizingProblem}</p>}
        <p className="m-0 text-[12px] leading-snug text-muted-foreground">
          Every signal of the signal history that filled, taken as it filled, as the desk would: at most{' '}
          {sizing.maxOpen.toLocaleString('en-US')} open at once -- one out frees its place -- {sizing.lots} lot{sizing.lots === 1 ? '' : 's'} each.
          No account&apos;s other rules: no method list, no strategy skip or refusal. The strike the strategies pick (nearest the
          money with delta ≤ 0.10, bid ≥ $13) at the first price after the fill, sold at its bid; the desk&apos;s real order
          beside it where there was one.
        </p>
        {hoursControl}
      </section>

      <section aria-label="Exit rules" className="grid min-w-0 content-start gap-1 rounded-lg border border-solid border-border px-3 py-2.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="text-[13px] font-medium">Exit rules <span className="font-normal text-muted-foreground">· worked again on each trade</span></span>
          {!asLive && (
            <button type="button" onClick={() => setDraft(LIVE_RULES)} className="min-h-[36px] shrink-0 border-0 bg-transparent p-0 font-[inherit] text-[13px] text-[var(--accent)]">
              As live
            </button>
          )}
        </div>
        <Switch
          label="Skip perp SL" checked={draft.skipPerpSl} onCheckedChange={(v) => setDraft((d) => ({ ...d, skipPerpSl: v }))}
          description={draft.skipPerpSl ? 'The perp reaching the signal\'s SL does not close the trade.' : 'The perp reaching the signal\'s SL buys the option back at once.'}
        />
        <Switch
          label="Skip perp TGT" checked={draft.skipPerpTgt} onCheckedChange={(v) => setDraft((d) => ({ ...d, skipPerpTgt: v }))}
          description={draft.skipPerpTgt ? 'The perp reaching the signal\'s TGT does not close the trade.' : 'The perp reaching the signal\'s TGT buys the option back at once.'}
        />
        <div className="grid grid-cols-2 gap-2 pt-1">
          <label className="grid min-w-0 gap-1 text-[12px] text-muted-foreground">
            Option SL
            <NumberField
              label="Option SL, per cent of the price sold" unit="%" decimals={1} invalid={draftProblem?.startsWith('Option SL') ?? false}
              value={Math.round(draft.stopPct * 1_000) / 10} onChange={(n) => setDraft((d) => ({ ...d, stopPct: n / 100 }))}
            />
          </label>
          <label className="grid min-w-0 gap-1 text-[12px] text-muted-foreground">
            Option TGT
            <NumberField
              label="Option TGT, per cent of the price sold" unit="%" decimals={1} invalid={draftProblem?.startsWith('Option TGT') ?? false}
              value={Math.round(draft.targetPct * 1_000) / 10} onChange={(n) => setDraft((d) => ({ ...d, targetPct: n / 100 }))}
            />
          </label>
        </div>
        <p role={draftProblem ? 'alert' : undefined} className={cn('m-0 text-[12px] leading-snug', draftProblem ? 'text-[var(--down)]' : 'text-muted-foreground')}>
          {draftProblem ?? (
            <>
              {draft.stopPct > 0 ? `Bought back if the option rises ${Math.round(draft.stopPct * 100)}% (sold at 10, out at ${(10 * (1 + draft.stopPct)).toFixed(1)})` : 'No option SL'}
              {'; '}
              {draft.targetPct > 0 ? `bought back once ${Math.round(draft.targetPct * 100)}% has decayed (sold at 10, out at ${(10 * (1 - draft.targetPct)).toFixed(1)})` : 'no option TGT'}
              . Otherwise held to 5:29 PM. 0 is none.
            </>
          )}
        </p>
      </section>
    </div>
  );

  return (
    <section aria-label="Option history">
      <CollapsibleCard id="option-history" title="Option history" right={
        <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {period}{data ? ` · ${data.replay.trades.toLocaleString('en-US')} ${data.source === 'signals' ? 'signals' : 'trades'}` : ''}
          <button type="button" aria-label="Refresh" onClick={() => void refresh()} className="grid h-8 w-8 place-items-center rounded-md border-0 bg-transparent text-muted-foreground">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
          </button>
        </span>
      }>
        <p className="mb-3 mt-0 text-[12.5px] leading-snug text-muted-foreground">
          The options the desk really sold against each signal, at the prices it really got. Each exit is worked again on
          that contract&apos;s recorded prices with the rules below, beside what really happened. After charges.
        </p>
        {settings}
        {error && !data && <p role="alert" className="mt-3 text-[13px] text-[var(--down)]">Could not load the option history: {error.message}</p>}
        {!data && !error && spanProblem === null && (
          <p className="mt-3 text-[13px] text-muted-foreground">
            Working every signal again… A long range takes up to a minute the first time; each day is kept after that.
          </p>
        )}
        {data && (
          <Results
            data={data} sortBy={sortBy ?? 'net'} onSort={setSortBy} csvUrl={optionReplayCsvUrl(asked)}
            tab={(tab === 'accounts' && data.source === 'signals') || !GROUP_TABS.some((t) => t.id === tab) ? 'grid' : tab!} onTab={setTab} show={show ?? 'all'} onShow={(v) => { setShow(v); setOffset(0); }}
            day={day} onDay={(d) => { setDay(d); setOffset(0); }} onPage={setOffset} stale={loading}
          />
        )}
      </CollapsibleCard>
    </section>
  );
}

function Results({ data, sortBy, onSort, csvUrl, tab, onTab, show, onShow, day, onDay, onPage, stale }: {
  data: OptionReplay; sortBy: GroupSort; onSort: (s: GroupSort) => void; csvUrl: string; tab: GroupTab; onTab: (t: GroupTab) => void; show: Show; onShow: (s: Show) => void;
  day: string | null; onDay: (d: string | null) => void; onPage: (offset: number) => void; stale: boolean;
}) {
  const { actual: a, replay: r } = data;
  const change = r.netUsd - a.netUsd;
  const signals = data.source === 'signals';
  const sort = sortBy === 'date' && tab !== 'days' ? 'net' : sortBy;
  const [find, setFind] = useState('');
  const needle = find.trim().toLowerCase();
  // The grid's rows are the methods, ranked as the methods' list is.
  const groups = rankGroups((tab === 'grid' ? data.methods : data[tab]) ?? [], sort).filter((g) => needle === '' || g.name.toLowerCase().includes(needle));
  // The server filters and pages the list (`list`): every trade is one page away, however many there are.
  const rows = data.rows;
  const { offset, limit } = data.list;
  const page = (to: number) => onPage(Math.max(0, Math.min(to, Math.max(0, data.rowsTotal - 1))));
  // The badges: of the day tapped, or of everything.
  const scope = day ? data.days.find((g) => g.key === day) : null;
  const counts: Record<Show, number> = scope
    ? { all: scope.trades, profit: scope.replay.wins, loss: scope.replay.losses, better: scope.better, worse: scope.worse }
    : { all: r.trades, profit: r.wins, loss: r.losses, better: data.better, worse: data.worse };
  const left = [
    data.noPrices > 0 && `${data.noPrices.toLocaleString('en-US')} without recorded prices`,
    data.noStrike > 0 && `${data.noStrike.toLocaleString('en-US')} signals with no strike inside the rule`,
    (data.full ?? 0) > 0 && `${data.full!.toLocaleString('en-US')} not taken, ${(data.maxOpen ?? 0).toLocaleString('en-US')} already open`,
    data.open > 0 && `${data.open.toLocaleString('en-US')} still open`,
  ].filter(Boolean);

  const side = (label: string, s: ReplaySide, strong: boolean) => (
    <div className={cn('grid min-w-0 gap-1 rounded-md border border-solid px-3 py-2', strong ? 'border-[var(--accent)]' : 'border-border')}>
      <span className="text-[10.5px] uppercase tracking-[0.6px] text-muted-foreground">{label}</span>
      <Money value={s.netUsd} signed strong />
      <span className="text-[12px] tabular-nums text-muted-foreground">
        <span className="text-[var(--up)]">{s.wins}</span> won · <span className="text-[var(--down)]">{s.losses}</span> lost · {winText(s)}
      </span>
      <span className="text-[12px] tabular-nums text-muted-foreground">
        Profit <span className="text-[var(--up)]">{rupees(s.profitUsd)}</span> · Loss <span className="text-[var(--down)]">{rupees(-s.lossUsd)}</span>
      </span>
    </div>
  );

  return (
    <div className={cn('mt-3 grid min-w-0 gap-3', stale && 'opacity-70')} aria-busy={stale}>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
        {side(signals ? `Desk's real orders · ${data.traded.toLocaleString('en-US')} of ${r.trades.toLocaleString('en-US')}` : 'As traded', a, false)}
        {side('With these rules', r, true)}
        <div className="grid min-w-0 content-start gap-1 rounded-md border border-solid border-border px-3 py-2">
          <span className="text-[10.5px] uppercase tracking-[0.6px] text-muted-foreground">Change</span>
          <span className={cn('text-[15px] font-semibold tabular-nums', toneOf(change))}>{rupees(change)}</span>
          <span className="text-[12px] tabular-nums text-muted-foreground">
            {r.lossUsd === a.lossUsd ? 'Loss the same' : `Loss ${inr(usdToInr(Math.abs(a.lossUsd - r.lossUsd)))} ${r.lossUsd < a.lossUsd ? 'smaller' : 'bigger'}`}
            {' · '}Profit {r.profitUsd === a.profitUsd ? 'the same' : `${inr(usdToInr(Math.abs(r.profitUsd - a.profitUsd)))} ${r.profitUsd > a.profitUsd ? 'bigger' : 'smaller'}`}
          </span>
          <span className="text-[12px] tabular-nums text-muted-foreground">
            <span className="font-semibold text-[var(--up)]">{data.better.toLocaleString('en-US')}</span> trades better ·{' '}
            <span className="font-semibold text-[var(--down)]">{data.worse.toLocaleString('en-US')}</span> worse
            {signals ? ` · of the ${data.traded.toLocaleString('en-US')} the desk traded` : ''}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 text-[12px]" aria-label="How the replay closed them">
        {(Object.keys(REPLAY_EXIT_NAMES) as ReplayExit[]).filter((k) => data.exits[k] > 0).map((k) => (
          <span key={k} className="rounded-md border border-solid border-border px-2 py-1 tabular-nums text-muted-foreground">
            {REPLAY_EXIT_NAMES[k]} <span className="font-semibold text-foreground">{data.exits[k].toLocaleString('en-US')}</span>
          </span>
        ))}
        {left.length > 0 && <span className="px-1 py-1 text-muted-foreground">Left out: {left.join(', ')}.</span>}
      </div>

      <div className="min-w-0">
        {/* The counts, overall or of the day tapped, each a badge; a tap ranks the lists below by it and filters the day's trades. */}
        <div role="group" aria-label="Show trades" className="mb-2 flex flex-wrap gap-1.5">
          {SHOWS.map((x) => {
            const n = counts[x.id];
            return (
              <button
                key={x.id} type="button" aria-pressed={show === x.id} onClick={() => { onShow(x.id); onSort(SORT_OF_SHOW[x.id]); }}
                className={cn('inline-flex h-9 items-center gap-1.5 rounded-md border border-solid px-3 font-[inherit] text-[13px]', show === x.id ? 'border-[var(--accent)] font-semibold text-foreground' : 'border-border bg-transparent text-muted-foreground')}
              >
                {x.name}
                <span className={cn('min-w-[22px] rounded-full px-1.5 py-px text-center text-[11.5px] font-semibold tabular-nums', BADGE_TONE[x.id])}>{n.toLocaleString('en-US')}</span>
              </button>
            );
          })}
          <span className="self-center px-1 text-[12px] text-muted-foreground">{day ? `on ${day}` : 'overall'}</span>
        </div>
        <div role="tablist" aria-label="Group by" className="mb-2 flex flex-wrap gap-1.5">
          {GROUP_TABS.filter((t) => !(signals && t.id === 'accounts')).map((t) => (
            <button
              key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => onTab(t.id)}
              className={cn('h-9 rounded-md border border-solid px-3 font-[inherit] text-[13px]', tab === t.id ? 'border-[var(--accent)] font-semibold text-foreground' : 'border-border bg-transparent text-muted-foreground')}
            >
              {t.name}
            </button>
          ))}
        </div>
        <p className="mb-2 mt-0 text-[12px] leading-snug text-muted-foreground">{GROUP_TABS.find((t) => t.id === tab)?.what}</p>
        <div className="mb-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          Rank by
          <select
            value={sort} onChange={(e) => onSort(e.target.value as GroupSort)} aria-label="Rank by"
            className="h-9 min-w-0 rounded-md border border-solid border-border bg-background px-2 font-[inherit] text-[13px] text-foreground"
          >
            {GROUP_SORTS.filter((g) => g.id !== 'date' || tab === 'days').map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        {tab !== 'days' && (
          <input
            type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder={tab === 'slots' ? 'Find a method or an hour' : 'Find'}
            aria-label="Find in the list"
            className="h-9 min-w-0 flex-1 rounded-md border border-solid border-border bg-background px-2 font-[inherit] text-[13px] text-foreground sm:max-w-[260px]"
          />
        )}
        </div>
        {tab === 'grid'
          ? <MethodGrid rows={groups} cells={data.grid ?? []} columns={data.timeframes} caption={gridCaption(data)} />
          : <GroupTable groups={groups} tab={tab} day={day} onDay={onDay} ranked={sort !== 'date'} />}
      </div>

      {/* The trades themselves only for a day tapped (owner, 3 Nov 2026: "not every date at once -- the date clicked"). */}
      {day ? (
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-medium">Trades of {day}{show !== 'all' ? ` · ${SHOWS.find((x) => x.id === show)!.name.toLowerCase()}` : ''}</span>
            <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <button type="button" onClick={() => onDay(null)} className="min-h-[36px] border-0 bg-transparent p-0 font-[inherit] text-[13px] text-[var(--accent)]">
                Close {day} ✕
              </button>
              <a
                href={csvUrl} download title="Every trade of this day the list holds, not only this page"
                className="inline-flex h-9 items-center gap-1.5 rounded-md border border-solid border-border bg-transparent px-2.5 text-[13px] text-foreground no-underline"
              >
                <Download className="h-3.5 w-3.5" aria-hidden /> CSV
              </a>
            </span>
          </div>
          <Pager offset={offset} limit={limit} total={data.rowsTotal} onPage={page} />
          <TradeTable rows={rows} />
          {data.rowsTotal > limit && <div className="mt-2"><Pager offset={offset} limit={limit} total={data.rowsTotal} onPage={page} /></div>}
        </div>
      ) : (
        <p className="m-0 rounded-md border border-dashed border-border px-3 py-3 text-center text-[13px] text-muted-foreground">
          Tap a day in the Days list to see its trades.
        </p>
      )}
    </div>
  );
}

/** The range and the rules the grid was worked on, for its picture: "4 Oct – 3 Nov · 8,442 trades", "Option SL 250% · TGT 90%". */
const gridCaption = (d: OptionReplay): string[] => [
  `Expiry days ${d.from} – ${d.to}`,
  [
    // Kept as fractions (2.5 is 250%), as the form keeps them.
    `Option SL ${d.rules.stopPct > 0 ? `${Math.round(d.rules.stopPct * 100)}%` : 'none'}`, `Option TGT ${d.rules.targetPct > 0 ? `${Math.round(d.rules.targetPct * 100)}%` : 'none'}`,
    d.rules.skipPerpSl ? 'perp SL skipped' : 'perp SL on', d.rules.skipPerpTgt ? 'perp TGT skipped' : 'perp TGT on',
  ].join(' · '),
];

/** What a square of the grid shows. */
type Measure = 'net' | 'win' | 'days';
const MEASURES: readonly { id: Measure; name: string }[] = [{ id: 'net', name: 'Net ₹' }, { id: 'win', name: 'Win %' }, { id: 'days', name: 'Profit / loss days' }];
/** A column the grid is sorted on -- a timeframe, `all`, or `name` -- and which way: `desc` the most first. Null: the Rank by order. */
export type GridSort = { col: string; dir: 'desc' | 'asc' } | null;
/** What a square is sorted by: the measure it shows -- net, win share, or profit days less loss days. */
export const sortValue = (g: ReplayGroup, m: Measure): number =>
  (m === 'net' ? g.replay.netUsd : m === 'win' ? (g.trades ? g.replay.wins / g.trades : 0) : g.daysUp - g.daysDown);
/**
 * The rows in a column's order (owner, 3 Nov 2026: "header sort, high profit, high low"): by the square of that column as
 * the squares show it, a row with no square there always last; by the method's name, A to Z or back. Null: as given.
 */
export function sortGridRows(rows: readonly ReplayGroup[], cellOf: (row: ReplayGroup, col: string) => ReplayGroup | undefined, sort: GridSort, m: Measure): ReplayGroup[] {
  if (!sort) return [...rows];
  const sign = sort.dir === 'desc' ? -1 : 1;
  if (sort.col === 'name') return [...rows].sort((a, b) => sign * -a.name.localeCompare(b.name, 'en', { numeric: true }));
  return [...rows].sort((a, b) => {
    const x = cellOf(a, sort.col), y = cellOf(b, sort.col);
    if (!x || !y) return x ? -1 : y ? 1 : 0;
    return sign * (sortValue(x, m) - sortValue(y, m));
  });
}

/**
 * Every method on every timeframe (owner, 3 Nov 2026: "an option on every signal -- on which timeframe which methods
 * lose, which make money; user friendly"). A row a method, ranked as asked, its total last; a column a timeframe, its
 * total underneath. Each square green as far as it makes money under the rules and red as far as it loses, the
 * strongest the darkest; it says the net, the win % or its profit and loss days, and a tap gives all its figures.
 */
export function MethodGrid({ rows, cells, columns, caption = [] }: {
  rows: readonly ReplayGroup[]; cells: readonly ReplayGroup[]; columns: readonly ReplayGroup[];
  /** Said under the picture's title: the range and the rules it was worked on (3 Nov 2026). */
  caption?: readonly string[];
}) {
  const [measure, setMeasure] = useSynced<Measure>('optionHistory.measure', 'net');
  const [saving, setSaving] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [picked, setPicked] = useState<string | null>(null);
  // Sorted by a header, and the timeframes on view: the view's own, remembered; nothing asked of the server again.
  const [sortStored, setSort] = useSynced<GridSort>('optionHistory.gridSort', null);
  const [hiddenStored, setHidden] = useSynced<string[]>('optionHistory.gridHidden', []);
  const hidden = Array.isArray(hiddenStored) ? hiddenStored : [];
  const at = useMemo(() => new Map(cells.map((c) => [c.key, c])), [cells]);
  const allTfs = columns.map((c) => c.key);
  const tfs = allTfs.filter((k) => !hidden.includes(k));
  const showAll = !hidden.includes('all');
  const shownColumns = columns.filter((c) => !hidden.includes(c.key));
  const cellAt = (r: ReplayGroup, col: string) => (col === 'all' ? r : at.get(`${r.key}|${col}`));
  // A sort on a column now hidden, or one an older build kept, reads as none.
  const sort: GridSort = sortStored && (sortStored.col === 'name' || (sortStored.col === 'all' ? showAll : tfs.includes(sortStored.col))) ? sortStored : null;
  const ordered = sortGridRows(rows, cellAt, sort, measure ?? 'net');
  // A header's tap: the most first, then the least first, then back to the Rank by order.
  const onHead = (col: string) => setSort(sort?.col !== col ? { col, dir: col === 'name' ? 'asc' : 'desc' } : sort.dir === (col === 'name' ? 'asc' : 'desc') ? { col, dir: col === 'name' ? 'desc' : 'asc' } : null);
  const toggleCol = (k: string) => setHidden(hidden.includes(k) ? hidden.filter((x) => x !== k) : [...hidden, k]);
  const most = Math.max(1e-9, ...cells.map((c) => Math.abs(c.replay.netUsd)));
  const shade = (usd: number) => {
    const p = Math.round(12 + 48 * Math.min(1, Math.abs(usd) / most));
    return usd > 0 ? `color-mix(in srgb, var(--up) ${p}%, transparent)` : usd < 0 ? `color-mix(in srgb, var(--down) ${p}%, transparent)` : undefined;
  };
  const say = (g: ReplayGroup) => (measure === 'net' ? compactInr(usdToInr(g.replay.netUsd)) : measure === 'win' ? winText(g.replay) : `+${g.daysUp} / −${g.daysDown}`);
  const tfName = (k: string) => (k === 'chain' ? 'Chain' : k);
  const square = (g: ReplayGroup | undefined, key: string, total = false) => (
    <td key={key} className={cn('border border-solid border-[var(--line-soft)] p-0 text-center', total && 'font-semibold')}>
      {g ? (
        <button
          type="button" onClick={() => setPicked(picked === key ? null : key)} aria-pressed={picked === key}
          title={`${g.trades} trades · won ${g.replay.wins}, lost ${g.replay.losses} · ${rupees(g.replay.netUsd)} · profit days ${g.daysUp}, loss days ${g.daysDown}`}
          style={{ background: shade(g.replay.netUsd) }}
          className={cn('block h-full min-h-[40px] w-full min-w-[64px] border-0 px-1.5 py-1 font-[inherit] text-[12px] tabular-nums text-foreground', picked === key && 'outline outline-2 outline-[var(--accent)]')}
        >
          <span className="block leading-tight">{say(g)}</span>
          <span className="block text-[10.5px] leading-tight text-muted-foreground">{g.trades.toLocaleString('en-US')}</span>
        </button>
      ) : <span className="text-[var(--dim)]">·</span>}
    </td>
  );
  // The grid as a picture (owner, 3 Nov 2026: "image download vai click pana apidy image download aakunum"): every row,
  // not only those in view, each square as it is shaded and says here.
  const shadeOf = (usd: number) => (12 + 48 * Math.min(1, Math.abs(usd) / most)) / 100;
  const cellOf = (g: ReplayGroup | undefined): HeatCell => (g ? { main: say(g), sub: g.trades.toLocaleString('en-US'), value: g.replay.netUsd, shade: shadeOf(g.replay.netUsd) } : null);
  const saveImage = async () => {
    setSaving('busy');
    try {
      const ok = await downloadHeatTable({
        title: 'Option history · method × timeframe',
        lines: [...caption, `Squares: ${MEASURES.find((m) => m.id === measure)!.name} · the small number is the trades · green makes money, red loses`],
        columns: [...tfs.map(tfName), ...(showAll ? ['All'] : [])],
        rows: ordered.map((r, i) => ({ rank: String(i + 1), label: r.name, cells: [...tfs.map((k) => cellOf(at.get(`${r.key}|${k}`))), ...(showAll ? [cellOf(r)] : [])] })),
        footer: { label: 'Every method', cells: [...shownColumns.map((c) => cellOf(c)), ...(showAll ? [{ main: '', value: 0, shade: 0 }] : [])] },
      }, `option-history-method-timeframe-${measure}-${new Date().toISOString().slice(0, 10)}`);
      setSaving(ok ? 'idle' : 'failed');
    } catch {
      setSaving('failed');
    }
  };
  const head = (col: string, label: string, extra = 'text-center') => {
    const on = sort?.col === col;
    const Icon = !on ? ArrowUpDown : sort!.dir === 'desc' ? ArrowDown : ArrowUp;
    return (
      <th key={col} aria-sort={on ? (sort!.dir === 'desc' ? 'descending' : 'ascending') : 'none'} className={cn('p-0 text-[11px] font-medium', extra)}>
        <button
          type="button" onClick={() => onHead(col)} title={`Sort by ${label}`}
          className={cn('inline-flex w-full items-center gap-1 border-0 bg-transparent px-2 py-1.5 font-[inherit] text-[11px] uppercase', extra.includes('text-left') ? 'justify-start' : 'justify-center', on ? 'font-semibold text-foreground' : 'text-muted-foreground')}
        >
          {label}<Icon className={cn('h-3 w-3', !on && 'opacity-40')} aria-hidden="true" />
        </button>
      </th>
    );
  };
  const chosen = picked ? at.get(picked) ?? rows.find((r) => `${r.key}|total` === picked) ?? columns.find((c) => `total|${c.key}` === picked) : undefined;
  return (
    <div className="grid min-w-0 gap-2">
      <div role="group" aria-label="Squares show" className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground">
        Squares show
        {MEASURES.map((m) => (
          <button
            key={m.id} type="button" aria-pressed={measure === m.id} onClick={() => setMeasure(m.id)}
            className={cn('h-8 rounded-md border border-solid px-2.5 font-[inherit] text-[12.5px]', measure === m.id ? 'border-[var(--accent)] font-semibold text-foreground' : 'border-border bg-transparent text-muted-foreground')}
          >
            {m.name}
          </button>
        ))}
        <span className="text-[11.5px]">· the small number is the trades</span>
        <button
          type="button" onClick={() => void saveImage()} disabled={saving === 'busy' || rows.length === 0}
          title="Every row of the grid, as the squares show now, saved as a PNG"
          className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-solid border-border bg-transparent px-2.5 font-[inherit] text-[12.5px] text-foreground disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />{saving === 'busy' ? 'Saving…' : 'Download image'}
        </button>
        {saving === 'failed' && <span role="alert" className="text-[11.5px] text-[var(--down)]">The picture could not be made in this browser.</span>}
      </div>
      <div role="group" aria-label="Columns" className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground">
        Columns
        {[...allTfs, 'all'].map((k) => {
          const on = k === 'all' ? showAll : tfs.includes(k);
          return (
            <button
              key={k} type="button" aria-pressed={on} onClick={() => toggleCol(k)} title={on ? `Hide ${k === 'all' ? 'All' : tfName(k)}` : `Show ${k === 'all' ? 'All' : tfName(k)}`}
              className={cn('h-8 min-w-[40px] rounded-md border border-solid px-2 font-[inherit] text-[12.5px]', on ? 'border-[var(--accent)] font-semibold text-foreground' : 'border-border bg-transparent text-muted-foreground line-through')}
            >
              {k === 'all' ? 'All' : tfName(k)}
            </button>
          );
        })}
        {(hidden.length > 0 || sort) && (
          <button
            type="button" onClick={() => { setHidden([]); setSort(null); }}
            className="min-h-[32px] border-0 bg-transparent p-0 font-[inherit] text-[12.5px] text-[var(--accent)]"
          >
            Reset view
          </button>
        )}
        <span className="text-[11.5px]">· tap a heading to sort: most first, then least, then back</span>
      </div>
      {chosen && (
        <p role="status" className="m-0 rounded-md border border-solid border-[var(--accent)] px-3 py-2 text-[12.5px] leading-snug">
          <span className="font-semibold">{picked!.endsWith('|total') ? `${chosen.name} · every timeframe` : picked!.startsWith('total|') ? `${tfName(chosen.key)} · every method` : `${chosen.name} · ${tfName(picked!.split('|')[1]!)}`}</span>
          {' — '}{chosen.trades.toLocaleString('en-US')} trades · won <span className="text-[var(--up)]">{chosen.replay.wins}</span>, lost <span className="text-[var(--down)]">{chosen.replay.losses}</span> ({winText(chosen.replay)})
          {' · '}<span className={toneOf(chosen.replay.netUsd)}>{rupees(chosen.replay.netUsd)}</span> with these rules
          {chosen.traded > 0 && <> against <span className={toneOf(chosen.actual.netUsd)}>{rupees(chosen.actual.netUsd)}</span> on the {chosen.traded.toLocaleString('en-US')} the desk traded</>}
          {' · '}profit days <span className="text-[var(--up)]">{chosen.daysUp}</span>, loss days <span className="text-[var(--down)]">{chosen.daysDown}</span>
        </p>
      )}
      <div className="max-h-[70vh] overflow-auto rounded-md border border-solid border-border">
        <table aria-label="Method by timeframe" className="w-max min-w-full border-collapse text-[12.5px]">
          <thead className="sticky top-0 z-[1] bg-[var(--panel)]">
            <tr>
              <th className="sticky left-0 z-[2] bg-[var(--panel)] px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground">#</th>
              {head('name', 'Method', 'sticky left-[28px] z-[2] bg-[var(--panel)] text-left')}
              {tfs.map((k) => head(k, tfName(k)))}
              {showAll && head('all', 'All')}
            </tr>
          </thead>
          <tbody>
            {ordered.map((r, i) => (
              <tr key={r.key}>
                <td className="sticky left-0 bg-[var(--panel)] px-2 py-1 text-right tabular-nums text-muted-foreground">{i + 1}</td>
                <td className="sticky left-[28px] max-w-[14rem] truncate bg-[var(--panel)] px-2 py-1 text-left" title={r.name}>{r.name}</td>
                {tfs.map((k) => square(at.get(`${r.key}|${k}`), `${r.key}|${k}`))}
                {showAll && square(r, `${r.key}|total`, true)}
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={tfs.length + 2 + (showAll ? 1 : 0)} className="px-2 py-3 text-center text-muted-foreground">No trades here.</td></tr>}
          </tbody>
          <tfoot>
            <tr>
              <td className="sticky left-0 bg-[var(--panel)]" />
              <td className="sticky left-[28px] bg-[var(--panel)] px-2 py-1 text-left font-semibold">Every method</td>
              {shownColumns.map((c) => square(c, `total|${c.key}`, true))}
              {showAll && <td />}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/** Where the page is in the list, and the way to the next, the one before, the first and the last. */
function Pager({ offset, limit, total, onPage }: { offset: number; limit: number; total: number; onPage: (offset: number) => void }) {
  const btn = (label: string, to: number, off: boolean) => (
    <button
      type="button" disabled={off} onClick={() => onPage(to)}
      className="h-9 min-w-[44px] rounded-md border border-solid border-border bg-transparent px-2.5 font-[inherit] text-[13px] text-foreground disabled:opacity-40"
    >
      {label}
    </button>
  );
  const last = Math.max(0, Math.floor((total - 1) / limit) * limit);
  return (
    <nav aria-label="Pages" className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-muted-foreground">
      <span className="tabular-nums">
        {total === 0 ? 'No trades' : `${(offset + 1).toLocaleString('en-US')}–${Math.min(total, offset + limit).toLocaleString('en-US')} of ${total.toLocaleString('en-US')} trades`}
      </span>
      {total > limit && (
        <span className="flex gap-1.5">
          {btn('First', 0, offset === 0)}{btn('Previous', offset - limit, offset === 0)}{btn('Next', offset + limit, offset + limit >= total)}{btn('Last', last, offset >= last)}
        </span>
      )}
    </nav>
  );
}

function GroupTable({ groups, tab, day, onDay, ranked }: { groups: readonly ReplayGroup[]; tab: GroupTab; day: string | null; onDay: (d: string | null) => void; ranked: boolean }) {
  const head = (s: string, left = false) => <th className={cn('whitespace-nowrap px-2 py-1.5 text-[11px] font-medium text-muted-foreground', left ? 'text-left' : 'text-right')}>{s}</th>;
  const total = groups.reduce((t, g) => ({ trades: t.trades + g.trades, better: t.better + g.better, worse: t.worse + g.worse, a: t.a + g.actual.netUsd, r: t.r + g.replay.netUsd }), { trades: 0, better: 0, worse: 0, a: 0, r: 0 });
  let rank = 0;
  return (
    <div className="max-h-[50vh] overflow-auto rounded-md border border-solid border-border">
      <table aria-label={`By ${tab}`} className="w-full min-w-[720px] border-collapse text-[12.5px]">
        <thead className="sticky top-0 bg-[var(--panel)]">
          <tr>
            {ranked && head('#')}{head(GROUP_HEAD[tab], true)}
            {head('Trades')}{tab !== 'days' && head('Profit days')}{tab !== 'days' && head('Loss days')}{head('Better')}{head('Worse')}{head('Win % traded → rules')}{head('As traded')}{head('With rules')}{head('Change')}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const c = g.replay.netUsd - g.actual.netUsd;
            const pick = tab === 'days';
            const none = g.trades === 0;
            if (!none) rank++;
            return (
              <tr
                key={g.key} onClick={pick ? () => onDay(day === g.key ? null : g.key) : undefined}
                className={cn('border-t border-border', pick && 'cursor-pointer hover:bg-[var(--panel)]', pick && day === g.key && 'bg-[var(--panel)] font-semibold')}
                aria-selected={pick ? day === g.key : undefined}
              >
                {ranked && <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{none ? '' : rank}</td>}
                <td className="max-w-[16rem] truncate px-2 py-1 text-left" title={g.name}>{g.name}</td>
                {none ? (
                  <td colSpan={tab === 'days' ? 7 : 9} className="px-2 py-1 text-left text-muted-foreground">
                    No trades{g.open > 0 ? ` · ${g.open} still open` : ''}
                  </td>
                ) : (
                  <>
                    <td className="px-2 py-1 text-right tabular-nums">{g.trades.toLocaleString('en-US')}{g.open > 0 && <span className="text-muted-foreground"> +{g.open} open</span>}</td>
                    {tab !== 'days' && <td className="px-2 py-1 text-right tabular-nums text-[var(--up)]">{g.daysUp}</td>}
                    {tab !== 'days' && <td className="px-2 py-1 text-right tabular-nums text-[var(--down)]">{g.daysDown}</td>}
                    <td className="px-2 py-1 text-right tabular-nums text-[var(--up)]">{g.better.toLocaleString('en-US')}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-[var(--down)]">{g.worse.toLocaleString('en-US')}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{winText(g.actual)} → {winText(g.replay)}</td>
                    <td className={cn('px-2 py-1 text-right tabular-nums', toneOf(g.actual.netUsd))}>{g.traded ? rupees(g.actual.netUsd) : '—'}</td>
                    <td className={cn('px-2 py-1 text-right tabular-nums', toneOf(g.replay.netUsd))}>{rupees(g.replay.netUsd)}</td>
                    <td className={cn('px-2 py-1 text-right font-semibold tabular-nums', toneOf(c))}>{g.traded ? rupees(c) : '—'}</td>
                  </>
                )}
              </tr>
            );
          })}
          {groups.length === 0 && <tr><td colSpan={(ranked ? 9 : 8) + (tab === 'days' ? 0 : 2)} className="px-2 py-3 text-center text-muted-foreground">No trades here.</td></tr>}
        </tbody>
        <tfoot className="bg-[var(--panel)] font-semibold">
          <tr className="border-t border-border">
            {ranked && <td />}
            <td className="px-2 py-1 text-left">Total</td>
            <td className="px-2 py-1 text-right tabular-nums">{total.trades.toLocaleString('en-US')}</td>
            {tab !== 'days' && <><td /><td /></>}
            <td className="px-2 py-1 text-right tabular-nums text-[var(--up)]">{total.better.toLocaleString('en-US')}</td>
            <td className="px-2 py-1 text-right tabular-nums text-[var(--down)]">{total.worse.toLocaleString('en-US')}</td>
            <td />
            <td className={cn('px-2 py-1 text-right tabular-nums', toneOf(total.a))}>{rupees(total.a)}</td>
            <td className={cn('px-2 py-1 text-right tabular-nums', toneOf(total.r))}>{rupees(total.r)}</td>
            <td className={cn('px-2 py-1 text-right tabular-nums', toneOf(total.r - total.a))}>{rupees(total.r - total.a)}</td>
          </tr>
        </tfoot>
      </table>
      {tab === 'days' && groups.length > 0 && <p className="m-0 border-t border-border px-2 py-1.5 text-[11.5px] text-muted-foreground">Tap a day to list its trades.</p>}
    </div>
  );
}

function TradeTable({ rows }: { rows: readonly OptionReplayRow[] }) {
  const head = (s: string, left = false) => <th className={cn('whitespace-nowrap px-2 py-1.5 text-[11px] font-medium text-muted-foreground', left ? 'text-left' : 'text-right')}>{s}</th>;
  return (
    <div className="max-h-[70vh] overflow-auto rounded-md border border-solid border-border">
      <table aria-label="Trades" className="w-full min-w-[900px] border-collapse text-[12.5px]">
        <thead className="sticky top-0 bg-[var(--panel)]">
          <tr>
            {head('Entered', true)}{head('TF', true)}{head('Method', true)}{head('Option', true)}{head('Sold at')}
            {head('As traded', true)}{head('Net')}{head('With rules', true)}{head('Net')}{head('Change')}
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => {
            const c = x.actual ? x.replay.netUsd - x.actual.netUsd : null;
            return (
              <tr key={x.tradeId} className="border-t border-border">
                <td className="whitespace-nowrap px-2 py-1 text-left tabular-nums">{when(x.enteredAt)}</td>
                <td className="px-2 py-1 text-left">{x.tf === 'chain' ? 'Chain' : x.tf}</td>
                <td className="max-w-[12rem] truncate px-2 py-1 text-left" title={x.strategyName ? `${x.methodName} · ${x.strategyName}` : x.methodName}>{x.methodName}</td>
                <td className="whitespace-nowrap px-2 py-1 text-left">
                  <span className={x.side === 'CE' ? 'text-[var(--down)]' : 'text-[var(--up)]'}>{contractLabel(x.symbol)}</span>
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{price(x.entry)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-left text-muted-foreground">{x.actual ? `${ACTUAL_EXIT_NAMES[x.actual.why]} · ${price(x.actual.exit)}` : 'Not traded'}</td>
                <td className={cn('px-2 py-1 text-right tabular-nums', x.actual && toneOf(x.actual.netUsd))}>{x.actual ? rupees(x.actual.netUsd) : '—'}</td>
                <td className="whitespace-nowrap px-2 py-1 text-left" title={`Out ${when(x.replay.exitAt)}`}>{REPLAY_EXIT_NAMES[x.replay.why]} · {price(x.replay.exit)}</td>
                <td className={cn('px-2 py-1 text-right tabular-nums', toneOf(x.replay.netUsd))}>{rupees(x.replay.netUsd)}</td>
                <td className={cn('px-2 py-1 text-right font-semibold tabular-nums', c !== null && toneOf(c))}>{c === null || Math.abs(c) < 1e-9 ? '—' : rupees(c)}</td>
              </tr>
            );
          })}
          {rows.length === 0 && <tr><td colSpan={10} className="px-2 py-3 text-center text-muted-foreground">No trades match.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
