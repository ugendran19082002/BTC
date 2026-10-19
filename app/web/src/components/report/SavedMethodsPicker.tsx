import { useState } from 'react';
import { getSignalBacktest } from '@/api/signal-backtest';
import { pct } from '@/lib/format';
import { dayLabel, moneyText } from '@/lib/market-report';
import { WIN_AT_LEAST_PCT } from '@/lib/win-line';
import { cn } from '@/lib/utils';
import { usePersisted } from '@/hooks/usePersisted';
import type { BacktestSave } from '@/types/signal-backtest';
import { Chip } from '@/components/mobile/parts';
import { FilterPicker, METHODS } from '@/components/mobile/FilterPicker';
import { Updating, useAnswer } from '@/components/report/Updating';
import { count } from '@/components/report/backtest-parts';

/**
 * A saved backtest's methods picked in the portfolio, by their record (owner, 19 Oct 2026: "in the portfolio, against
 * a saved backtest, pick by win % with a tap -- not Backtest, edit, Win, update, and back"). The saved backtest's own
 * settings and time frames, over the days chosen here: the same method list as the Backtest screen's, its Win ≥ X% tab
 * and "Only the N that won X% or more" included. Update keeps the list on the saved backtest; Cancel changes nothing.
 */
const REPORT_FIRST_DAY = '2026-10-01';
const PERIODS = [{ key: '7', label: 'Last 7 days', days: 7 }, { key: '14', label: 'Last 14 days', days: 14 }, { key: 'all', label: 'Since 1 Oct', days: 0 }] as const;
type Period = (typeof PERIODS)[number]['key'];

/** The last finished expiry day: today's settles at 5:30 PM IST. */
export function lastFinishedDay(now = Date.now()): string {
  const ist = new Date(now + 330 * 60_000);
  const day = ist.toISOString().slice(0, 10);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutes >= 17 * 60 + 30 ? day : new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}
export function periodRange(days: number, now = Date.now()): { from: string; to: string } {
  const to = lastFinishedDay(now);
  const from = days > 0 ? new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10) : REPORT_FIRST_DAY;
  return { from: from < REPORT_FIRST_DAY ? REPORT_FIRST_DAY : from, to };
}

export function SavedMethodsPicker({ save, onUpdate, onClose, busy = false, now = Date.now() }: {
  save: BacktestSave;
  onUpdate: (methods: string[]) => void;
  onClose: () => void;
  busy?: boolean;
  now?: number;
}) {
  const [period, setPeriod] = usePersisted<Period>('savedMethods.period', '14');
  const [winAtLeast, setWinAtLeast] = usePersisted<number>('signalBacktest.winAtLeast', WIN_AT_LEAST_PCT);
  const [draft, setDraft] = useState<string[]>(save.query.methods);
  const days = PERIODS.find((p) => p.key === period)?.days ?? 14;
  const range = periodRange(days, now);
  const ask = { ...range, params: save.query.params, tfs: save.query.tfs, methods: [] as string[], strategy: null };
  const read = useAnswer(JSON.stringify(ask), () => getSignalBacktest(ask), 300_000);
  const options = (read.data?.choices.methods ?? []).map((m) => ({
    key: m.key, name: m.name, tone: m.net > 0 ? 'up' as const : m.net < 0 ? 'down' as const : undefined, value: m.net,
    winRate: m.n > 0 ? m.wins / m.n : undefined, trades: m.n,
    note: m.n > 0 ? `${count(m.n)} trades · ${pct(m.wins / m.n, 0)} won · ${moneyText(m.net)}` : 'no trade',
  }));
  const changed = draft.length !== save.query.methods.length || draft.some((m) => !save.query.methods.includes(m));
  return (
    <section aria-label={`Methods of ${save.name}`} className="mt-1 grid min-w-0 gap-2 rounded-md border border-solid border-border bg-[var(--bg)] p-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold">Methods of {save.name}</span>
        <span className="text-[12px] tabular-nums text-muted-foreground">{draft.length ? `${draft.length} picked` : 'every method'}{save.query.methods.length ? ` · saved ${save.query.methods.length}` : ''}</span>
      </div>
      <div role="group" aria-label="The record of" className="flex flex-wrap gap-1.5">
        {PERIODS.map((p) => <Chip key={p.key} on={period === p.key} onClick={() => setPeriod(p.key)}>{p.label}</Chip>)}
      </div>
      <p className="m-0 text-[11.5px] leading-snug text-muted-foreground">
        Each method&apos;s record by this saved backtest&apos;s own settings and time frames, {dayLabel(range.from)} – {dayLabel(range.to)}.
        {' '}Picked on the days you then run it on, the result looks better than it can be: run the portfolio on later days, or use <b className="font-medium text-foreground">Methods by win %</b> in the run&apos;s settings, which picks on the days before.
      </p>
      {read.error && !read.data && <p role="alert" className="m-0 text-[12px] text-[var(--down)]">The record could not be read: {read.error.message}</p>}
      <Updating busy={!read.data || read.stale} what="the methods' record">
        {options.length > 0
          ? <FilterPicker noun={METHODS} picked={draft} onChange={setDraft} split options={options}
              winAtLeast={typeof winAtLeast === 'number' ? winAtLeast : WIN_AT_LEAST_PCT} onWinAtLeast={setWinAtLeast} />
          : read.data && <p className="m-0 text-[12px] text-muted-foreground">No method traded on these days.</p>}
      </Updating>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!changed || busy} onClick={() => onUpdate(draft)}
          className={cn('m-0 h-9 appearance-none rounded-md border-0 px-3 font-[inherit] text-[12.5px] font-semibold disabled:opacity-40', 'bg-[var(--chosen)] text-[var(--chosen-ink)]')}>
          {busy ? 'Updating…' : draft.length ? `Update its methods (${draft.length})` : 'Update: every method'}
        </button>
        <button type="button" onClick={onClose} className="m-0 h-9 appearance-none rounded-md border border-solid border-border bg-transparent px-3 font-[inherit] text-[12.5px] text-muted-foreground">Cancel</button>
      </div>
    </section>
  );
}
