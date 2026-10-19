import { useState } from 'react';
import { getBacktestSaves, saveBacktest } from '@/api/backtest-saves';
import { dayLabel } from '@/lib/market-report';
import type { BacktestPortfolioResult } from '@/types/signal-backtest';
import { Panel } from '@/components/mobile/parts';

/**
 * What "Methods by win %" gave each saved backtest of a run (19 Oct 2026): its pick, by name, and a tap to keep the
 * pick on the saved backtest itself -- the step that took the Backtest screen, an edit, the Win tab and an update.
 */
export function WinPickResult({ pick, members, nameOf }: {
  pick: NonNullable<BacktestPortfolioResult['winPick']>;
  members: readonly { id: string; name: string; problem: string | null }[];
  nameOf: (method: string) => string;
}) {
  const [kept, setKept] = useState<Record<string, 'busy' | 'done' | string>>({});
  const keep = async (id: string, methods: string[]) => {
    setKept((k) => ({ ...k, [id]: 'busy' }));
    try {
      const save = (await getBacktestSaves()).saves.find((s) => s.id === id);
      if (!save) throw new Error('It is gone: it may have been deleted.');
      await saveBacktest({ id: save.id, name: save.name, query: { ...save.query, methods } });
      setKept((k) => ({ ...k, [id]: 'done' }));
    } catch (e) {
      setKept((k) => ({ ...k, [id]: e instanceof Error ? e.message : String(e) }));
    }
  };
  const days = pick.from === pick.to ? dayLabel(pick.from) : `${dayLabel(pick.from)} – ${dayLabel(pick.to)}`;
  const ran = pick.run ? (pick.run.from === pick.run.to ? dayLabel(pick.run.from) : `${dayLabel(pick.run.from)} – ${dayLabel(pick.run.to)}`) : null;
  return (
    <Panel title="Methods by win %">
      <p className={pick.on === 'same' ? 'm-0 text-[12.5px] leading-snug text-[var(--warn)]' : 'm-0 text-[12.5px] leading-snug text-muted-foreground'}>
        Won {pick.pct}% or more of {pick.minTrades}+ trades, on {days}
        {pick.on === 'before' ? ': the days before the run, so it is run on days that took no part in picking.'
          : pick.on === 'first' ? `: the run's first days -- and run on ${ran ?? 'the days after them'}, days that took no part in picking.`
            : ': the run\'s own days -- picked knowing how they did, so the result looks better than it can be.'}
      </p>
      <ul aria-label="Each one's pick" className="m-0 mt-2 grid list-none gap-2 p-0">
        {members.map((m) => {
          const ids = pick.picked[m.id];
          const state = kept[m.id];
          return (
            <li key={m.id} className="min-w-0 border-0 border-t border-solid border-[var(--line-soft)] pt-2 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold">{m.name}</span>
                {ids === undefined
                  ? <span className="text-[12px] text-muted-foreground">{pick.own.includes(m.id) ? "by a strategy: its own methods" : '—'}</span>
                  : <span className="text-[12px] tabular-nums text-muted-foreground">{ids.length ? `${ids.length} method${ids.length === 1 ? '' : 's'}` : 'none passed'}</span>}
              </div>
              {ids && ids.length > 0 && (
                <>
                  <p className="m-0 mt-0.5 text-[11.5px] leading-snug text-[var(--dim)] [overflow-wrap:anywhere]">{ids.map(nameOf).join(', ')}</p>
                  <button type="button" disabled={state === 'busy' || state === 'done'} onClick={() => void keep(m.id, ids)}
                    className="m-0 mt-1 min-h-[32px] appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12.5px] text-[var(--accent)] underline underline-offset-2 disabled:no-underline disabled:opacity-60">
                    {state === 'done' ? 'Kept on it' : state === 'busy' ? 'Keeping…' : `Keep these ${ids.length} on it`}
                  </button>
                  {state && state !== 'busy' && state !== 'done' && <p role="alert" className="m-0 text-[12px] text-[var(--down)]">{state}</p>}
                </>
              )}
              {ids && ids.length === 0 && m.problem && <p className="m-0 mt-0.5 text-[11.5px] text-[var(--warn)]">{m.problem}</p>}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
