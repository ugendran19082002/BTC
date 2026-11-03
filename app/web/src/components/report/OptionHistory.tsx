import { useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { DateRangePicker, describeRange, type DateRangeValue } from '@/components/ui/date-range-picker';
import { Money } from '@/components/ui/money';
import { NumberField } from '@/components/ui/number-field';
import { Switch } from '@/components/ui/switch';
import { useTimeWindow } from '@/components/report/TimeWindow';
import { getOptionReplay, optionReplayCsvUrl, type OptionReplayQuery } from '@/api/option-replay';
import { usePoll } from '@/hooks/usePoll';
import { useSynced } from '@/hooks/useSynced';
import { contractLabel, inr, signedInr, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';
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
const MAX_DAYS = 31;
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

type GroupTab = 'days' | 'hours' | 'slots' | 'timeframes' | 'methods' | 'accounts';
/** Each list, and the line under its tabs saying what it is for. */
const GROUP_TABS: readonly { id: GroupTab; name: string; what: string }[] = [
  { id: 'days', name: 'Days', what: 'Each expiry day. Tap one to see its trades.' },
  { id: 'hours', name: 'Hours', what: 'By the hour the trade was entered (IST), over every day chosen.' },
  { id: 'slots', name: 'Method × hour', what: 'Each method in each hour, over every day chosen: which lose again and again, which keep making money. Loss days and profit days count how often.' },
  { id: 'methods', name: 'Methods', what: 'Each method, over every day chosen.' },
  { id: 'timeframes', name: 'Timeframes', what: 'Each timeframe, the chain as Chain.' },
  { id: 'accounts', name: 'Accounts', what: 'Each broker account.' },
];
const GROUP_HEAD: Record<GroupTab, string> = { days: 'Expiry day', hours: 'Hour', slots: 'Method · hour', methods: 'Method', timeframes: 'Timeframe', accounts: 'Account' };

export function OptionHistory() {
  // Null: the last seven expiry days, rolling -- so the card never opens on a stale week.
  const [range, setRange] = useSynced<DateRangeValue | null>('optionHistory.range', null);
  const [tfs, setTfs] = useSynced<string[]>('optionHistory.tfs', []);
  const [rules, setRules] = useSynced<ReplayRules>('optionHistory.rules', LIVE_RULES);
  const [tab, setTab] = useSynced<GroupTab>('optionHistory.tab', 'days');
  const [show, setShow] = useSynced<Show>('optionHistory.show', 'all');
  const [sortBy, setSortBy] = useSynced<GroupSort>('optionHistory.sort', 'net');
  /*
   * Every signal of the signal history, always (owner, 3 Nov 2026: "not by the accounts' rules -- by the signal history,
   * with only the option history's settings"; then "every signal based"). The desk's own orders are the server's other
   * source (`?source=orders`), not offered here: they stand beside each signal instead.
   */
  const { window: hours, whole, control: hoursControl } = useTimeWindow('optionHistory');
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
  const spanProblem = daysIn(span) > MAX_DAYS ? `At most ${MAX_DAYS} days at a time: pick a shorter range.` : null;
  const base = useMemo(() => ({
    from: span.from, to: span.to, hours: whole ? null : hours, tfs: tfs ?? [], rules: rules ?? LIVE_RULES, oneContract: true, source: 'signals' as ReplaySource,
  }), [span.from, span.to, whole, hours.from, hours.to, (tfs ?? []).join(','), JSON.stringify(rules)]); // eslint-disable-line react-hooks/exhaustive-deps
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
        <p className="m-0 text-[12px] leading-snug text-muted-foreground">
          Every signal of the signal history that filled -- no account&apos;s rules: no max open, no method list, no strategy
          skip or refusal. One contract of the strike the strategies pick (nearest the money with delta ≤ 0.10, bid ≥ $13) at
          the first price after the fill, sold at its bid; the desk&apos;s real order beside it where there was one.
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
            tab={tab === 'accounts' && data.source === 'signals' ? 'days' : tab ?? 'days'} onTab={setTab} show={show ?? 'all'} onShow={(v) => { setShow(v); setOffset(0); }}
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
  const groups = rankGroups(data[tab] ?? [], sort).filter((g) => needle === '' || g.name.toLowerCase().includes(needle));
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
        <GroupTable groups={groups} tab={tab} day={day} onDay={onDay} ranked={sort !== 'date'} />
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
