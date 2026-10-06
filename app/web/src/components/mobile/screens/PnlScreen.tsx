import { useState } from 'react';
import { json } from '@/api/client';
import { getDaysFor, getStats, type StatsGroup } from '@/api/phone';
import type { DayRow, MtmReport } from '@/types/report';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { clock, pct, signedInr, usdToInr } from '@/lib/format';
import { lossBudget } from '@/lib/position-risk';
import { byDay, daysAgoIst, heat, monthsOf, todayIst } from '@/lib/report';
import { cn } from '@/lib/utils';
import { usePhone } from '@/components/mobile/phone-context';
import { AreaChart, Empty, Loading, LossMeter, Panel, Rupees, Segmented, Stat, Stats } from '@/components/mobile/parts';
import { DateRangeSheet } from '@/components/mobile/DateRangeSheet';
import { describeRange, type DateRangeValue } from '@/components/ui/date-range-picker';
import { rangeProblem } from '@/lib/custom-range';

/**
 * P&L (6 Oct 2026): how the money went -- today live, or the last 7, 30 or 90 days -- as one figure and its line,
 * then the closed trades' numbers in one grid (win rate, profit factor, average win and loss, best and worst),
 * then what is working: by strategy, CE or PE, sold or bought, entry method and account. Every figure after
 * charges, from the journal (`/api/report/*`).
 */

type Range = 'today' | '7' | '30' | '90' | 'custom';
const RANGES: { key: Range; label: string; spoken?: string; days: number }[] = [
  // Short on the button so five fit a 360px phone; said in full to a screen reader.
  { key: 'today', label: 'Today', days: 0 },
  { key: '7', label: '7D', spoken: '7 days', days: 6 },
  { key: '30', label: '30D', spoken: '30 days', days: 29 },
  { key: '90', label: '90D', spoken: '90 days', days: 89 },
  // Last, as asked (owner, 6 Oct 2026): any From and To, picked in a sheet.
  { key: 'custom', label: 'Custom', days: -1 },
];

const rs = (usd: number | null | undefined) => (usd === null || usd === undefined ? '—' : signedInr(usdToInr(usd)));
const toneOf = (usd: number | null | undefined): 'up' | 'down' | undefined => (usd == null || usd === 0 ? undefined : usd > 0 ? 'up' : 'down');

export function PnlScreen() {
  const p = usePhone();
  const [range, setRange] = usePersisted<Range>('m-pnl-range', 'today');
  const r = RANGES.find((x) => x.key === range) ?? RANGES[0]!;
  const isToday = r.key === 'today';
  const today = todayIst(p.now);
  // The custom range, remembered; one that no longer holds (a year passed, a bad value) falls back to the last 7 days.
  const [custom, setCustom] = usePersisted<DateRangeValue>('m-pnl-custom', { from: daysAgoIst(6, p.now), to: today });
  const customOk = rangeProblem(custom, today) === null;
  const [picking, setPicking] = useState(false);
  const to = r.key === 'custom' && customOk ? custom.to : today;
  const from = isToday ? today : r.key === 'custom' ? (customOk ? custom.from : daysAgoIst(6, p.now)) : daysAgoIst(r.days, p.now);
  const stats = usePoll(() => getStats(from, to, p.accountParam), isToday ? 30_000 : 120_000, { deps: [from, to, p.accountParam] });
  const days = usePoll(() => getDaysFor(from, to, p.accountParam), 120_000, { deps: [from, to, p.accountParam], enabled: !isToday });
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

  return (
    <>
      <Segmented label="Range" value={range} options={RANGES} onChange={(k) => (k === 'custom' ? setPicking(true) : setRange(k))} />
      {picking && (
        <DateRangeSheet
          value={customOk ? custom : { from, to }} today={today}
          onApply={(v) => { setCustom(v); setRange('custom'); setPicking(false); }}
          onClose={() => setPicking(false)}
        />
      )}

      <Panel>
        <span className="flex items-baseline justify-between gap-2 text-[13px] text-muted-foreground">
          <span>{isToday ? 'Net P&L, if everything closed now' : `Net P&L, ${describeRange({ from, to }, today)}`}</span>
          {r.key === 'custom' && (
            <button type="button" onClick={() => setPicking(true)} className="shrink-0 border-0 bg-transparent p-0 font-[inherit] text-[13px] text-[var(--accent)]">
              Change
            </button>
          )}
        </span>
        {net !== null ? <Rupees usd={net} signed size="xl" /> : <Loading error={isToday ? null : days.error} what="the money" />}
        {line.length >= 2 && (
          <div className="mt-2">
            <AreaChart values={line} label={isToday ? 'Net today, minute by minute' : 'Running total, day by day'} />
            <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground">
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
        {/* One row of four (owner, 6 Oct 2026): how high, how low, how deep the fall, and the most the day may lose. */}
        {isToday && ((mtm.data && (mtm.data.stats.max || mtm.data.stats.min)) || budget) && (
          <dl className="m-0 mt-3 grid grid-cols-4 gap-1.5">
            <Mark small label="Day high" usd={mtm.data?.stats.max?.netUsd ?? null} when={mtm.data?.stats.max ? clock(mtm.data.stats.max.at) : null} />
            <Mark small label="Day low" usd={mtm.data?.stats.min?.netUsd ?? null} when={mtm.data?.stats.min ? clock(mtm.data.stats.min.at) : null} />
            <Mark small label="Drawdown" usd={mtm.data?.stats.maxDrawdown ? -mtm.data.stats.maxDrawdown.usd : null} when={mtm.data?.stats.maxDrawdown ? clock(mtm.data.stats.maxDrawdown.at) : null} />
            <Mark small label="Max loss" usd={budget ? -budget.limitUsd : null} plain when={budget ? `${pct(1 - budget.usedPct, 0)} left` : null} />
          </dl>
        )}
        {!isToday && days.data && (days.data.totals.best || days.data.totals.worst) && (
          <dl className="m-0 mt-3 grid grid-cols-2 gap-2">
            <Mark label="Best day" usd={days.data.totals.best?.netUsd ?? null} when={days.data.totals.best?.day ?? null} />
            <Mark label="Worst day" usd={days.data.totals.worst?.netUsd ?? null} when={days.data.totals.worst?.day ?? null} />
          </dl>
        )}
        {budget && <LossMeter {...budget} />}
      </Panel>

      <Panel title="Summary">
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
        {!isToday && days.data && <Calendar from={from} to={to} rows={days.data.days} />}
        {!isToday && days.data && (
          <p className="m-0 mt-2 text-[12px] text-muted-foreground">
            {days.data.totals.tradingDays} days traded · {days.data.totals.winDays} up · {days.data.totals.lossDays} down
          </p>
        )}
      </Panel>

      {stats.data && stats.data.overall.trades > 0 ? (
        <>
          <Breakdown title="By strategy" groups={stats.data.byStrategy} />
          <Breakdown title="CE or PE" groups={stats.data.byOption ?? []} />
          <Breakdown title="Sold or bought" groups={stats.data.byAction ?? []} />
          <Breakdown title="By entry method" groups={stats.data.byMethod ?? []} limit={8} />
          {p.shown === 'all' && p.trading.length > 1 && <Breakdown title="By account" groups={stats.data.byAccount} />}
        </>
      ) : stats.data ? <Panel><Empty>No trade closed {isToday ? 'today' : 'in this range'} yet.</Empty></Panel> : null}
    </>
  );
}

/** A figure with when it happened under it: the day's high and low, a best or worst day. */
function Mark({ label, usd, when, small = false, plain = false }: {
  label: string; usd: number | null; when: string | null;
  /** Four to a row: tighter, so a figure fits a quarter of a 360px phone whole. */
  small?: boolean;
  /** A limit, not a result: not coloured as a gain or a loss. */
  plain?: boolean;
}) {
  return (
    <div className={cn('min-w-0 rounded-md bg-muted py-2', small ? 'px-1.5' : 'px-2.5')}>
      <dt className={cn('truncate text-muted-foreground', small ? 'text-[11px]' : 'text-[11.5px]')}>{label}</dt>
      <dd className={cn(
        'm-0 truncate font-semibold tabular-nums',
        small ? 'text-[12.5px] min-[390px]:text-[13.5px]' : 'text-[14px] min-[390px]:text-[15px]',
        !plain && toneOf(usd) === 'up' && 'text-[var(--up)]', !plain && toneOf(usd) === 'down' && 'text-[var(--down)]',
      )}>
        {rs(usd)}
      </dd>
      {when && <dd className="m-0 truncate text-[10.5px] tabular-nums text-muted-foreground">{when}</dd>}
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

/** Each day of the range as a square, green or red by its net, stronger the bigger. */
function Calendar({ from, to, rows }: { from: string; to: string; rows: DayRow[] }) {
  const map = byDay(rows);
  const maxAbs = Math.max(0, ...rows.map((x) => Math.abs(x.netUsd)));
  return (
    <div className="mt-3 flex flex-col gap-3">
      {monthsOf(from, to).map((m) => (
        <div key={m.key}>
          <div className="mb-1 text-[11.5px] font-semibold tracking-[0.5px] text-muted-foreground">{m.label}</div>
          <div className="grid grid-cols-7 gap-1" role="grid" aria-label={m.label}>
            {m.weeks.flat().map((d, i) => {
              const row = d ? map.get(d) : undefined;
              const level = row ? heat(row.netUsd, maxAbs) : 0;
              const up = row ? row.netUsd > 0 : false;
              return (
                <div
                  key={i} role="gridcell"
                  aria-label={d ? `${d}: ${row ? signedInr(usdToInr(row.netUsd)) : 'no trades'}` : undefined}
                  className={cn(
                    'grid aspect-square place-items-center rounded text-[11px] tabular-nums',
                    !d && 'invisible',
                    d && !row && 'bg-muted text-[var(--dim)]',
                    row && level === 0 && 'bg-muted text-muted-foreground',
                    row && up && level === 1 && 'bg-[color-mix(in_srgb,var(--up)_25%,transparent)] text-foreground',
                    row && up && level === 2 && 'bg-[color-mix(in_srgb,var(--up)_50%,transparent)] text-foreground',
                    row && up && level === 3 && 'bg-[var(--up)] text-[var(--bg)]',
                    row && !up && level === 1 && 'bg-[color-mix(in_srgb,var(--down)_25%,transparent)] text-foreground',
                    row && !up && level === 2 && 'bg-[color-mix(in_srgb,var(--down)_50%,transparent)] text-foreground',
                    row && !up && level === 3 && 'bg-[var(--down)] text-[var(--bg)]',
                  )}
                >
                  {d ? Number(d.slice(8)) : ''}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
