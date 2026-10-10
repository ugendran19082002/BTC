import { memo, useEffect, useState } from 'react';
import { getActivity, getDaySignals, getStats, methodNames } from '@/api/phone';
import type { EntryMethodInfo } from '@/api/entry';
import type { SignalRun, SignalTrade, StrategyRun } from '@/types/strategy';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { clock, pct } from '@/lib/format';
import { daysAgoIst, todayIst } from '@/lib/report';
import { cn } from '@/lib/utils';
import { accountTag, groupSections, onCount } from '@/lib/strategy-groups';
import { usePhoneData } from '@/components/mobile/phone-context';
import { Empty, ListButton, Loading, Panel, Pill, Rupees, Stat, Stats, When } from '@/components/mobile/parts';

/**
 * Strategies (6 Oct 2026, Level 2): what the strategies did today and why. The clock strategies' runs -- placed,
 * refused, failed, and the reason; every signal a signal strategy saw and whether it took it; the entry methods
 * that paid best and worst over 30 days; each strategy's state now. All in the server's own words.
 */

const RUN_TONE: Record<StrategyRun['status'], 'up' | 'down' | 'warn' | 'dim'> = { placed: 'up', refused: 'warn', failed: 'down', skipped: 'dim' };
const SIGNAL_WORD: Record<SignalRun['status'], { word: string; tone: 'up' | 'down' | 'warn' | 'dim' | 'accent' }> = {
  placed: { word: 'TAKEN', tone: 'up' },
  'would-place': { word: 'PAPER', tone: 'accent' },
  claimed: { word: 'TAKING', tone: 'accent' },
  refused: { word: 'REFUSED', tone: 'warn' },
  skipped: { word: 'SKIPPED', tone: 'dim' },
  failed: { word: 'FAILED', tone: 'down' },
};
/** Taken: an order placed, or -- live orders off -- written down as the order it would be. The rest were not taken, with why. */
const taken = (r: Pick<SignalRun, 'status'>) => r.status === 'placed' || r.status === 'would-place' || r.status === 'claimed';

/**
 * The signals' three tabs (owner, 10 Oct 2026: "all count, taken count, not taken count, in tabs, user friendly"):
 * equal tiles, the count over the word, as Positions' -- over the whole IST day, so the counts are the day's.
 */
type Feed = 'all' | 'taken' | 'not';
const FEEDS: { key: Feed; label: string; tone: string; none: string }[] = [
  { key: 'all', label: 'All', tone: 'text-foreground', none: 'No signal today yet.' },
  { key: 'taken', label: 'Taken', tone: 'text-[var(--up)]', none: 'No signal taken today.' },
  { key: 'not', label: 'Not taken', tone: 'text-[var(--warn)]', none: 'Every signal today was taken.' },
];
/** Rows a tab shows at first, and each "Show more" adds. */
const PAGE = 40;

export function StrategiesScreen() {
  const p = usePhoneData();
  const act = usePoll(() => getActivity(p.accountParam), 20_000, { deps: [p.accountParam] });
  const month = usePoll(() => getStats(daysAgoIst(29, p.now), todayIst(p.now), p.accountParam), 300_000, { deps: [p.accountParam] });
  // The day's whole signal journal: `getActivity` carries only the latest sixty, any day -- too few to count by.
  const day = todayIst(p.now);
  const daySignals = usePoll(() => getDaySignals(day, p.accountParam), 20_000, { deps: [day, p.accountParam] });
  const [names, setNames] = useState<Map<string, EntryMethodInfo> | null>(null);
  useEffect(() => { methodNames().then(setNames).catch(() => setNames(new Map())); }, []);
  const [feed, setFeed] = usePersisted<Feed>('m-strategies-feed', 'all');
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => { setLimit(PAGE); }, [feed]);

  const a = act.data;
  const today = a?.today ?? day;
  const nameOf = (id: string) => a?.strategies.find((x) => x.id === id)?.name ?? id;
  const methodOf = (id: string) => { const m = names?.get(id); return m ? `#${m.n} ${m.name}` : id; };
  const runs = (a?.runs ?? []).filter((r) => r.runDate === today);
  const all = daySignals.data?.trades ?? null;
  const tab = FEEDS.some((f) => f.key === feed) ? feed : 'all';
  const takenN = all ? all.filter(taken).length : 0;
  const count: Record<Feed, number> = { all: all?.length ?? 0, taken: takenN, not: (all?.length ?? 0) - takenN };
  const inTab = (all ?? []).filter((r) => (tab === 'all' ? true : tab === 'taken' ? taken(r) : !taken(r)));
  const signals = inTab.slice(0, limit);
  // Under Taken, how many were real orders; under Not taken, why -- each a count.
  const real = (all ?? []).filter((r) => r.status === 'placed').length;
  const why = (['skipped', 'refused', 'failed'] as const).map((s) => [s, (all ?? []).filter((r) => r.status === s).length] as const).filter(([, n]) => n > 0);
  const tradesToday = runs.filter((r) => r.status === 'placed').length + real;
  const methods = month.data?.byMethod ?? [];

  if (!a) return <Panel><Loading error={act.error} what="the strategies" /></Panel>;
  return (
    <>
      <Stats cols={3}>
        <Stat label="Active">{a.strategies.filter((s) => s.enabled).length} of {a.strategies.length}</Stat>
        <Stat label="Signals">{all ? all.length : '…'}</Stat>
        <Stat label="Trades today">{tradesToday}</Stat>
      </Stats>
      {!a.schedulerOn && <p className="m-0 rounded-md bg-[var(--warn-bg)] px-3 py-2 text-[13.5px] text-[var(--warn)]">The scheduler is off: no strategy enters or exits on its own.</p>}

      <Panel title="Today's runs">
        {runs.length === 0 ? <Empty>No scheduled run today yet.</Empty> : (
          <ul className="m-0 list-none divide-y divide-[var(--line-soft)] p-0">
            {runs.map((r) => (
              <li key={r.id} className="py-2">
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-[14.5px] font-medium">{nameOf(r.strategyId)}</span>
                  <Pill tone={RUN_TONE[r.status]}>{r.status.toUpperCase()}</Pill>
                </span>
                <span className="block text-[12.5px] leading-snug text-muted-foreground"><When>{clock(r.at)}</When> · {r.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Signals today">
        <div role="group" aria-label="Which signals" className="grid grid-cols-3 gap-1.5">
          {FEEDS.map((f) => {
            const on = tab === f.key;
            const n = count[f.key];
            return (
              <button
                key={f.key} type="button" aria-pressed={on} aria-label={`${f.label} ${all ? n : 'reading'}`} onClick={() => setFeed(f.key)}
                className={cn('flex h-14 min-w-0 flex-col items-center justify-center rounded-lg border border-solid px-1 font-[inherit]',
                  on ? 'border-foreground/60 bg-muted' : 'border-border bg-transparent')}
              >
                <span className={cn('text-[17px] font-semibold leading-tight tabular-nums', !all || n === 0 ? 'text-muted-foreground' : f.tone)}>{all ? n : '…'}</span>
                <span className={cn('max-w-full truncate text-[12px]', on ? 'text-foreground' : 'text-muted-foreground')}>{f.label}</span>
              </button>
            );
          })}
        </div>
        {all && tab === 'taken' && takenN > 0 && (
          <p className="m-0 mt-2 text-[12.5px] text-muted-foreground">{real} real order{real === 1 ? '' : 's'} · {takenN - real} paper (live orders off)</p>
        )}
        {all && tab === 'not' && why.length > 0 && (
          <p className="m-0 mt-2 text-[12.5px] text-muted-foreground">{why.map(([s, n]) => `${n} ${s}`).join(' · ')} — the reason is on each row</p>
        )}
        {!all ? <Loading error={daySignals.error} what="today's signals" /> : signals.length === 0 ? <Empty>{FEEDS.find((f) => f.key === tab)!.none}</Empty> : (
          <ul className="m-0 mt-1 list-none divide-y divide-[var(--line-soft)] p-0" aria-label="Signals">
            {signals.map((r) => (
              <SignalRow key={r.id} r={r} method={methodOf(r.method)} strategy={nameOf(r.strategyId)} openTrade={p.openTrade} />
            ))}
          </ul>
        )}
        {/* Said, not cut off: how many of the tab are showing, and the rest a tap away. */}
        {inTab.length > signals.length && (
          <button
            type="button" onClick={() => setLimit((l) => l + PAGE)}
            className="m-0 mt-2 flex h-11 w-full appearance-none items-center justify-center rounded-lg border border-solid border-border bg-transparent font-[inherit] text-[13.5px] text-foreground"
          >
            Show {Math.min(PAGE, inTab.length - signals.length)} more · {signals.length} of {inTab.length}
          </button>
        )}
      </Panel>

      {methods.length > 0 && (
        <Panel title="Methods, 30 days" right={<span className="whitespace-nowrap text-[11.5px] text-muted-foreground">after charges</span>}>
          <ul className="m-0 list-none divide-y divide-[var(--line-soft)] p-0">
            {[...methods.slice(0, 3), ...(methods.length > 3 ? methods.slice(-Math.min(3, methods.length - 3)) : [])].map((g, i) => (
              <li key={g.key} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-medium">{i < 3 ? '▲' : '▼'} {g.name ?? methodOf(g.key)}</span>
                  <span className="block text-[12px] text-muted-foreground">{g.trades} trades · win {g.winRate !== null ? pct(g.winRate, 0) : '—'}</span>
                </span>
                <Rupees usd={g.netUsd} signed size="sm" />
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/*
        Listed by group (owner, 10 Oct 2026), as on the desk: each group with how many are on, its strategies under
        it, then those in none. Read only here -- groups are made, switched and cloned on the desk. A server from
        before groups sends none, and the list is the one list it was.
      */}
      <Panel title="Each strategy now">
        {groupSections(a.strategies, a.groups ?? []).map((sec) => {
          const n = onCount(sec.strategies);
          return (
            <section key={sec.group?.id ?? 'no-group'} aria-label={sec.group ? `group ${sec.group.name}` : 'not in a group'}>
              {(a.groups?.length ?? 0) > 0 && (
                <h3 className="m-0 mt-2 flex items-center justify-between gap-2 border-b border-solid border-[var(--line)] pb-1 text-[13px] font-semibold first:mt-0">
                  <span className="min-w-0 truncate">
                    {sec.group ? sec.group.name : 'Not in a group'}
                    {sec.group && p.accountParam === null && accountTag(sec.group) && (
                      <span className="ml-1.5 text-[11.5px] font-normal text-muted-foreground">{accountTag(sec.group)}</span>
                    )}
                  </span>
                  <span className={cn('flex-none text-[12px] font-normal tabular-nums', n.on > 0 ? 'text-[var(--up)]' : 'text-muted-foreground')}>
                    {n.of === 0 ? 'empty' : `${n.on} of ${n.of} on`}
                  </span>
                </h3>
              )}
              <ul className="m-0 list-none divide-y divide-[var(--line-soft)] p-0">
                {sec.strategies.map((s) => (
                  <li key={s.id} className="py-2">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-[14.5px] font-medium">{s.name}</span>
                      {s.enabled ? <Pill tone="up">ON</Pill> : <Pill tone="dim">OFF</Pill>}
                    </span>
                    <span className="block text-[12.5px] leading-snug text-muted-foreground">
                      {s.config.trigger === 'signal' ? 'Signals' : `Clock ${s.config.entryTime}`}
                      {s.open ? ` · ${s.open.trades} open` : ''} · {s.status}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </Panel>
    </>
  );
}

/** One signal: what, when, which strategy, and what became of it. Memoised: the list redraws with the clock, unchanged. */
const SignalRow = memo(function SignalRow({ r, method, strategy, openTrade }: {
  r: SignalTrade; method: string; strategy: string; openTrade: (tradeId: string) => void;
}) {
  const w = SIGNAL_WORD[r.status];
  const body = (
    <>
      <span className="flex items-center justify-between gap-2">
        <span className="truncate text-[14px] font-medium">
          <span className={r.dir === 1 ? 'text-[var(--up)]' : 'text-[var(--down)]'}>{r.dir === 1 ? '▲ BUY' : '▼ SELL'}</span> {method}
        </span>
        <Pill tone={w.tone}>{w.word}</Pill>
      </span>
      <span className="block text-[12.5px] leading-snug text-muted-foreground"><When>{clock(r.at)}</When> · {r.tf} · {strategy} · {r.detail}</span>
    </>
  );
  return (
    <li>
      {r.tradeId
        ? <ListButton onClick={() => openTrade(r.tradeId!)} label={`Signal ${method}: open its trade`}>{body}</ListButton>
        : <div className="py-2.5">{body}</div>}
    </li>
  );
});
