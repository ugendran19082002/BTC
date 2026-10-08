import { json } from '@/api/client';
import { getDaysFor, getStats, type StatsGroup } from '@/api/phone';
import type { MtmReport } from '@/types/report';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { clock, pct, signedInr, usdToInr } from '@/lib/format';
import { lossBudget } from '@/lib/position-risk';
import { cn } from '@/lib/utils';
import { usePhone } from '@/components/mobile/phone-context';
import { AreaChart, Empty, Loading, LossMeter, Panel, Rupees, Stat, Stats } from '@/components/mobile/parts';
import { describeRange } from '@/components/ui/date-range-picker';
import { useDayRange } from '@/components/mobile/useDayRange';
import { pairsOfStats, splitPairs } from '@/lib/method-pairs';
import { PairList } from '@/components/mobile/PairList';
import { DayCalendar } from '@/components/mobile/DayCalendar';
import { FilterPicker, METHODS, STRATEGIES, type FilterOption } from '@/components/mobile/FilterPicker';

/**
 * P&L (6 Oct 2026): how the money went -- today live, or the last 7, 30 or 90 days -- as one figure and its line,
 * then the closed trades' numbers in one grid (win rate, profit factor, average win and loss, best and worst)
 * and, over days, a calendar with each day's figure in its square (`DayCalendar`),
 * then what is working: the best and the worst pairs of entry method and timeframe (owner, 6 Oct 2026, in place
 * of the lists by strategy and by entry method), CE or PE, sold or bought, and account. Every figure after
 * charges, from the journal (`/api/report/*`), for the range chosen at the top.
 *
 * Under the range, two filters of the same kind (owner, 8 Oct 2026): by strategy and by entry method. Tick one or
 * several in either and every figure of the closed trades -- the numbers, the calendar, the pairs -- is of those
 * trades alone; both at once is both. Each list offers what the other choice leaves. Today's live figure and its
 * line are the account's, which no strategy or method owns a share of, and the screen says so.
 */

const rs = (usd: number | null | undefined) => (usd === null || usd === undefined ? '—' : signedInr(usdToInr(usd)));
/** The same, short enough for a quarter of a phone: "₹42.5K" from ten thousand up, "₹1.25L" from a lakh. */
const rsShort = (usd: number | null | undefined) => {
  if (usd === null || usd === undefined) return '—';
  const inr = usdToInr(usd);
  if (inr === null) return '—';
  const abs = Math.abs(inr);
  const sign = inr === 0 ? '' : inr > 0 ? '+' : '−';
  if (abs >= 100_000) return `${sign}₹${(abs / 100_000).toFixed(2)}L`;
  if (abs >= 10_000) return `${sign}₹${(abs / 1_000).toFixed(1)}K`;
  return `${sign}₹${abs >= 100 ? Math.round(abs).toLocaleString('en-IN') : abs.toFixed(2)}`;
};
const toneOf = (usd: number | null | undefined): 'up' | 'down' | undefined => (usd == null || usd === 0 ? undefined : usd > 0 ? 'up' : 'down');

export function PnlScreen() {
  const p = usePhone();
  // The same filter as every other screen that reads days (`useDayRange`), remembered as P&L's own.
  const range = useDayRange('m-pnl', p.now);
  const { isToday, from, to, today } = range;
  // The strategies and the entry methods kept; none of either is all of them. Asked of the server, which reads the trades: the phone only names them.
  const [strategies, setStrategies] = usePersisted<string[]>('m-pnl-strategies', []);
  const [methods, setMethods] = usePersisted<string[]>('m-pnl-methods', []);
  const asked = `${strategies.join(',')}|${methods.join(',')}`;
  const stats = usePoll(() => getStats(from, to, p.accountParam, { strategies, methods }), isToday ? 30_000 : 120_000, { deps: [from, to, p.accountParam, asked] });
  const days = usePoll(() => getDaysFor(from, to, p.accountParam, { strategies, methods }), 120_000, { deps: [from, to, p.accountParam, asked], enabled: !isToday });
  const mtm = usePoll(
    () => json<MtmReport>(p.accountParam === null ? '/api/report/mtm' : `/api/report/mtm?account=${p.accountParam}`),
    60_000, { deps: [p.accountParam], enabled: isToday },
  );

  const s = p.status;
  const t = s?.today;
  const net = isToday ? (s ? (t?.netUsd ?? (s.realisedTodayUsd ?? 0) + (s.unrealisedPnlUsd ?? 0)) : null) : days.data?.totals.netUsd ?? null;
  const samples = mtm.data?.samples ?? [];
  const line = isToday ? samples.map((x) => x.netUsd) : (days.data?.days ?? []).map((d) => d.cumulativeUsd);
  const budget = isToday && s ? lossBudget(s) : null;
  const o = stats.data?.overall;
  const pairs = stats.data?.byPair ? splitPairs(pairsOfStats(stats.data.byPair)) : null;
  const inRange = isToday ? 'today' : 'in this range';
  // The lists to choose from are the server's: every strategy, and every entry method, with a trade closed in the range -- and any chosen that has none.
  const choice = (g: { key: string; name: string; trades: number; netUsd: number }): FilterOption => ({
    key: g.key, name: g.name,
    note: g.trades ? `${g.trades} trade${g.trades === 1 ? '' : 's'} · ${rs(g.netUsd)}` : `no trade closed ${inRange}`,
    tone: toneOf(g.netUsd),
  });
  const options = (stats.data?.strategies ?? []).map(choice);
  const methodOptions = (stats.data?.methods ?? []).map(choice);
  const chosen = options.filter((x) => strategies.includes(x.key));
  const chosenMethods = methodOptions.filter((x) => methods.includes(x.key));
  // Whose figures these are, in a few words: " · 1h time", " · 2 strategies · 3 methods".
  const said = (v: readonly FilterOption[], many: string) => (v.length === 0 ? null : v.length === 1 ? v[0]!.name : `${v.length} ${many}`);
  const whose = [said(chosen, 'strategies'), said(chosenMethods, 'methods')].filter((x): x is string => x !== null);
  const ofChosen = whose.map((w) => ` · ${w}`).join('');
  const narrowed = whose.length > 0;

  return (
    <>
      {range.bar}
      {/* Each offered once there is something to choose between -- or a choice to take off. */}
      {(options.length > 1 || chosen.length > 0) && <FilterPicker noun={STRATEGIES} options={options} picked={strategies} onChange={setStrategies} />}
      {(methodOptions.length > 1 || chosenMethods.length > 0) && <FilterPicker noun={METHODS} options={methodOptions} picked={methods} onChange={setMethods} />}

      <Panel>
        <span className="flex items-baseline justify-between gap-2 text-[13px] text-muted-foreground">
          <span>{isToday ? 'Net P&L, if everything closed now' : `Net P&L, ${describeRange({ from, to }, today)}${ofChosen}`}</span>
          {range.isCustom && (
            <button type="button" onClick={range.pick} className="shrink-0 border-0 bg-transparent p-0 font-[inherit] text-[13px] text-[var(--accent)]">
              Change
            </button>
          )}
        </span>
        {net !== null ? <Rupees usd={net} signed size="xl" /> : <Loading error={isToday ? null : days.error} what="the money" />}
        {line.length >= 2 && (
          <div className="mt-2">
            <AreaChart values={line} label={isToday ? 'Net today, minute by minute' : 'Running total, day by day'} />
            <div className="mt-1 flex justify-between text-[11px] tabular-nums text-[var(--time)]">
              {isToday
                ? <><span>{clock(samples[0]!.at)}</span><span>{clock(samples[samples.length - 1]!.at)}</span></>
                : <><span>{days.data!.days[0]!.day}</span><span>{days.data!.days[days.data!.days.length - 1]!.day}</span></>}
            </div>
          </div>
        )}
        {isToday && samples.length < 2 && <p className="m-0 mt-2 text-[12.5px] text-muted-foreground">The day's line starts with the first minute the desk records.</p>}
        {isToday && p.shown === 'all' && p.trading.length > 1 && samples.length >= 2 && (
          <p className="m-0 mt-1.5 text-[12px] text-muted-foreground">The line is the default account's: two accounts' lines do not add up to one.</p>
        )}
        {/* The day's high, low and deepest fall, minute by minute; over days, the best and the worst (owner, 6 Oct 2026). */}
        {/* One row of four (owner, 6 Oct 2026): how high, how low, how deep the fall, and what the day has lost. */}
        {isToday && ((mtm.data && (mtm.data.stats.max || mtm.data.stats.min)) || t) && (
          <dl className="m-0 mt-3 grid grid-cols-4 !gap-1">
            <Mark small label="Day high" usd={mtm.data?.stats.max?.netUsd ?? null} when={mtm.data?.stats.max ? clock(mtm.data.stats.max.at) : null} />
            <Mark small label="Day low" usd={mtm.data?.stats.min?.netUsd ?? null} when={mtm.data?.stats.min ? clock(mtm.data.stats.min.at) : null} />
            <Mark small label="Drawdown" usd={mtm.data?.stats.maxDrawdown ? -mtm.data.stats.maxDrawdown.usd : null} when={mtm.data?.stats.maxDrawdown ? clock(mtm.data.stats.maxDrawdown.at) : null} />
            <Mark small label="Day loss" usd={t?.lossUsd != null ? -t.lossUsd : s?.lossTodayUsd != null ? -s.lossTodayUsd : null} when="booked" />
          </dl>
        )}
        {!isToday && days.data && (days.data.totals.best || days.data.totals.worst || days.data.days.length > 0) && (
          <dl className="m-0 mt-3 grid grid-cols-3 !gap-1.5">
            <Mark label="Best day" usd={days.data.totals.best?.netUsd ?? null} when={days.data.totals.best?.day.slice(5) ?? null} />
            <Mark label="Worst day" usd={days.data.totals.worst?.netUsd ?? null} when={days.data.totals.worst?.day.slice(5) ?? null} />
            {/* The losses booked over the range chosen, a fill at a time, as each day's own loss is counted. */}
            <Mark label="Loss" usd={-days.data.days.reduce((n, d) => n + (d.lossUsd ?? 0), 0)} when={`${days.data.totals.lossDays} day${days.data.totals.lossDays === 1 ? '' : 's'} down`} />
          </dl>
        )}
        {budget && <LossMeter {...budget} />}
        {isToday && narrowed && (
          <p className="m-0 mt-2 text-[12px] text-muted-foreground">
            This figure and its line are the whole account&apos;s: open positions are not split by strategy or method. The trades, the win rate and the pairs below are of {whose.join(', ')}.
          </p>
        )}
      </Panel>

      <Panel title={narrowed ? `Summary${ofChosen}` : 'Summary'}>
        <Stats cols={3}>
          {isToday ? (
            <>
              <Stat label="Booked" tone={toneOf(t?.realisedUsd)}>{rs(t?.realisedUsd)}</Stat>
              <Stat label="Open" tone={toneOf(t?.unrealisedUsd)}>{rs(t?.unrealisedUsd)}</Stat>
              <Stat label="Charges" tone={t?.chargesUsd ? 'down' : undefined}>{rs(t ? -t.chargesUsd : null)}</Stat>
            </>
          ) : (
            <>
              <Stat label="Gross" tone={toneOf(days.data?.totals.realisedUsd)}>{rs(days.data?.totals.realisedUsd)}</Stat>
              <Stat label="Charges" tone={days.data?.totals.chargesUsd ? 'down' : undefined}>{rs(days.data ? -days.data.totals.chargesUsd : null)}</Stat>
              <Stat label="Net" tone={toneOf(days.data?.totals.netUsd)}>{rs(days.data?.totals.netUsd)}</Stat>
            </>
          )}
          <Stat label="Trades">{o ? o.trades : '…'}</Stat>
          <Stat label="Winners" tone={o?.wins ? 'up' : undefined}>{o ? o.wins : '…'}</Stat>
          <Stat label="Losers" tone={o?.losses ? 'down' : undefined}>{o ? o.losses : '…'}</Stat>
          <Stat label="Win rate">{o?.winRate != null ? pct(o.winRate, 1) : '—'}</Stat>
          <Stat label="Avg win" tone={o?.avgWinUsd ? 'up' : undefined}>{rs(o?.avgWinUsd)}</Stat>
          <Stat label="Avg loss" tone={o?.avgLossUsd ? 'down' : undefined}>{rs(o?.avgLossUsd != null ? -o.avgLossUsd : null)}</Stat>
          <Stat label="Profit factor">{o?.profitFactor != null ? o.profitFactor.toFixed(2) : o?.wins ? 'no loss' : '—'}</Stat>
          <Stat label="Best trade" tone={toneOf(o?.bestUsd)}>{rs(o?.bestUsd)}</Stat>
          <Stat label="Worst trade" tone={toneOf(o?.worstUsd)}>{rs(o?.worstUsd)}</Stat>
        </Stats>
        {!stats.data && stats.error && <Loading error={stats.error} what="the trades" />}
        {!isToday && days.data && <DayCalendar from={from} to={to} rows={days.data.days} today={today} />}
        {!isToday && days.data && (
          <p className="m-0 mt-2 text-[12px] text-muted-foreground">
            {days.data.totals.tradingDays} days traded · {days.data.totals.winDays} up · {days.data.totals.lossDays} down
          </p>
        )}
      </Panel>

      {stats.data && stats.data.overall.trades > 0 ? (
        <>
          {pairs && pairs.trades > 0 ? (
            <>
              <PairList title="Best pairs" tone="up" pairs={pairs.best} amount={(g) => rs(g.net)} empty={`No method and time frame is in profit ${inRange}.`} />
              <PairList title="Worst pairs" tone="down" pairs={pairs.worst} amount={(g) => rs(g.net)} empty={`No method and time frame is in loss ${inRange}.`} />
              <p className="m-0 px-1 text-[12px] text-muted-foreground">
                A pair is one entry method on one time frame, over the {pairs.trades} signal trade{pairs.trades === 1 ? '' : 's'} closed {inRange}, after charges.
                {stats.data.overall.trades > pairs.trades && ` ${stats.data.overall.trades - pairs.trades} more had no signal and are in neither list.`}
              </p>
            </>
          ) : !pairs ? (
            // A server from before the pairs: the methods alone, as this screen showed them.
            <Breakdown title="By entry method" groups={stats.data.byMethod ?? []} limit={8} />
          ) : null}
          <Breakdown title="CE or PE" groups={stats.data.byOption ?? []} />
          <Breakdown title="Sold or bought" groups={stats.data.byAction ?? []} />
          {p.shown === 'all' && p.trading.length > 1 && <Breakdown title="By account" groups={stats.data.byAccount} />}
        </>
      ) : stats.data ? (
        <Panel><Empty>{narrowed ? `No trade of ${whose.join(', ')} closed ${inRange}.` : `No trade closed ${inRange} yet.`}</Empty></Panel>
      ) : null}
    </>
  );
}

/** A figure with when it happened under it: the day's high and low, a best or worst day. */
function Mark({ label, usd, when, small = false }: {
  label: string; usd: number | null; when: string | null;
  /** Four to a row: tighter, so a figure fits a quarter of a 360px phone whole. */
  small?: boolean;
}) {
  return (
    <div className={cn('min-w-0 rounded-md bg-muted py-2', small ? 'px-1 text-center min-[390px]:px-1.5' : 'px-2.5')}>
      <dt className={cn('truncate text-muted-foreground', small ? 'text-[11px]' : 'text-[11.5px]')}>{label}</dt>
      <dd className={cn(
        'm-0 truncate font-semibold tabular-nums',
        small ? 'text-[12px] min-[390px]:text-[13px]' : 'text-[14px] min-[390px]:text-[15px]',
        toneOf(usd) === 'up' && 'text-[var(--up)]', toneOf(usd) === 'down' && 'text-[var(--down)]',
      )}>
        {small ? rsShort(usd) : rs(usd)}
      </dd>
      {when && <dd className={cn('m-0 truncate text-[11px] tabular-nums', /\d/.test(when) && !/day/.test(when) ? 'text-[var(--time)]' : 'text-muted-foreground')}>{when}</dd>}
    </div>
  );
}

/** One way of splitting the trades: a row each, the best first, with its count, win rate and net. */
function Breakdown({ title, groups, limit }: { title: string; groups: StatsGroup[]; limit?: number }) {
  if (groups.length === 0) return null;
  const cut = limit !== undefined && groups.length > limit;
  const shown = cut ? [...groups.slice(0, Math.ceil(limit / 2)), ...groups.slice(-Math.floor(limit / 2))] : groups;
  return (
    <Panel title={title} right={cut ? <span className="text-[11.5px] text-muted-foreground">best and worst {limit} of {groups.length}</span> : undefined}>
      <ul className="m-0 list-none divide-y divide-[var(--line-soft)] p-0">
        {shown.map((g) => (
          <li key={g.key} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0">
              <span className="block truncate text-[14px] font-medium">{g.name ?? g.key}</span>
              <span className="block text-[12px] text-muted-foreground">
                {g.trades} trade{g.trades === 1 ? '' : 's'} · win {g.winRate !== null ? pct(g.winRate, 0) : '—'}{g.profitFactor !== null ? ` · PF ${g.profitFactor.toFixed(2)}` : ''}
              </span>
            </span>
            <Rupees usd={g.netUsd} signed size="sm" />
          </li>
        ))}
      </ul>
    </Panel>
  );
}
