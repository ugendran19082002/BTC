import { useEffect, useState } from 'react';
import { getActivity, getStats, methodNames } from '@/api/phone';
import type { EntryMethodInfo } from '@/api/entry';
import type { SignalRun, StrategyRun } from '@/types/strategy';
import { usePoll } from '@/hooks/usePoll';
import { clock, pct } from '@/lib/format';
import { daysAgoIst, todayIst } from '@/lib/report';
import { usePhone } from '@/components/mobile/phone-context';
import { Chip, Chips, Empty, ListButton, Loading, Panel, Pill, Rupees, Stat, Stats } from '@/components/mobile/parts';

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
const taken = (r: SignalRun) => r.status === 'placed' || r.status === 'would-place' || r.status === 'claimed';

export function StrategiesScreen() {
  const p = usePhone();
  const act = usePoll(() => getActivity(p.accountParam), 20_000, { deps: [p.accountParam] });
  const month = usePoll(() => getStats(daysAgoIst(29, p.now), todayIst(p.now), p.accountParam), 300_000, { deps: [p.accountParam] });
  const [names, setNames] = useState<Map<string, EntryMethodInfo> | null>(null);
  useEffect(() => { methodNames().then(setNames).catch(() => setNames(new Map())); }, []);
  const [feed, setFeed] = useState<'all' | 'taken' | 'not'>('all');

  const a = act.data;
  const today = a?.today ?? todayIst(p.now);
  const nameOf = (id: string) => a?.strategies.find((x) => x.id === id)?.name ?? id;
  const methodOf = (id: string) => { const m = names?.get(id); return m ? `#${m.n} ${m.name}` : id; };
  const runs = (a?.runs ?? []).filter((r) => r.runDate === today);
  const startOfToday = Date.parse(`${today}T00:00:00+05:30`);
  const signalsToday = (a?.signalRuns ?? []).filter((r) => r.at >= startOfToday);
  const signals = (a?.signalRuns ?? []).filter((r) => (feed === 'all' ? true : feed === 'taken' ? taken(r) : !taken(r))).slice(0, 40);
  const tradesToday = runs.filter((r) => r.status === 'placed').length + signalsToday.filter((r) => r.status === 'placed').length;
  const methods = month.data?.byMethod ?? [];

  if (!a) return <Panel><Loading error={act.error} what="the strategies" /></Panel>;
  return (
    <>
      <Stats cols={3}>
        <Stat label="Active">{a.strategies.filter((s) => s.enabled).length} of {a.strategies.length}</Stat>
        <Stat label="Signals">{signalsToday.length}</Stat>
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
                <span className="block text-[12.5px] leading-snug text-muted-foreground">{clock(r.at)} · {r.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Signals">
        <Chips label="Which signals">
          <Chip on={feed === 'all'} onClick={() => setFeed('all')}>All</Chip>
          <Chip on={feed === 'taken'} onClick={() => setFeed('taken')}>Taken</Chip>
          <Chip on={feed === 'not'} onClick={() => setFeed('not')}>Not taken</Chip>
        </Chips>
        {signals.length === 0 ? <Empty>No signal here yet.</Empty> : (
          <ul className="m-0 mt-1 list-none divide-y divide-[var(--line-soft)] p-0" aria-label="Signals">
            {signals.map((r) => {
              const w = SIGNAL_WORD[r.status];
              const body = (
                <>
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-[14px] font-medium">
                      <span className={r.dir === 1 ? 'text-[var(--up)]' : 'text-[var(--down)]'}>{r.dir === 1 ? '▲ BUY' : '▼ SELL'}</span> {methodOf(r.method)}
                    </span>
                    <Pill tone={w.tone}>{w.word}</Pill>
                  </span>
                  <span className="block text-[12.5px] leading-snug text-muted-foreground">{clock(r.at)} · {r.tf} · {nameOf(r.strategyId)} · {r.detail}</span>
                </>
              );
              return (
                <li key={r.id}>
                  {r.tradeId
                    ? <ListButton onClick={() => p.openTrade(r.tradeId!)} label={`Signal ${methodOf(r.method)}: open its trade`}>{body}</ListButton>
                    : <div className="py-2.5">{body}</div>}
                </li>
              );
            })}
          </ul>
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

      <Panel title="Each strategy now">
        <ul className="m-0 list-none divide-y divide-[var(--line-soft)] p-0">
          {a.strategies.map((s) => (
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
      </Panel>
    </>
  );
}
