import { NumberField } from '@/components/ui/number-field';
import { TimePicker } from '@/components/ui/time-picker';
import { CHASE_DEFAULT, chaseProblems } from '@/lib/backtest-chase';
import { time12 } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { Chase } from '@/types/signal-backtest';

/**
 * The chase guard, in the backtest and a run together (owner, 22 Oct 2026: "B: chase 11:00, 400pt -- in the backtest
 * settings, to test"): from a time of day, a signal that would sell the way BTC has already run since the morning is
 * not taken -- a PE sold after a rise, a CE sold after a fall. A what-if: the live desk takes them. Worked through on
 * an example underneath.
 */
const AFTERS = ['10:00', '11:00', '12:00', '13:00'];
const POINTS = [300, 400, 500];
const chip = (on: boolean) => cn('m-0 h-9 appearance-none rounded-full border border-solid px-3 font-[inherit] text-[12.5px]', on ? 'border-[var(--chosen-line)] bg-[var(--chosen-soft)] text-[var(--chosen-text)]' : 'border-border bg-transparent text-muted-foreground');

export function BacktestChase({ value, onChange, name = 'Chase guard' }: { value: Chase | null; onChange: (c: Chase | null) => void; name?: string }) {
  const on = value !== null;
  const c = value ?? CHASE_DEFAULT;
  const problems = on ? chaseProblems(c) : [];
  return (
    <section aria-label={name} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border border-solid border-border p-2.5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[13.5px] font-medium text-foreground">{name} <span className="font-normal text-muted-foreground">(trend days)</span></span>
          <span className={cn('block text-[12px] leading-snug', on ? 'text-foreground' : 'text-muted-foreground')}>
            {on ? 'From the time below, a signal that sells the way BTC has already run is skipped. The live desk takes these.' : 'Off · every signal is taken, however far BTC has run.'}
          </span>
        </span>
        <button type="button" role="switch" aria-checked={on} aria-label={`${name}, on or off`} onClick={() => onChange(on ? null : c)}
          className="m-0 inline-flex min-h-[44px] flex-none cursor-pointer appearance-none items-center border-0 bg-transparent p-0 pl-2">
          <span className={cn('relative inline-flex h-6 w-11 items-center rounded-full transition-colors', on ? 'bg-[var(--chosen)]' : 'bg-[var(--line)]')}>
            <span className={cn('block h-5 w-5 rounded-full shadow transition-transform', on ? 'translate-x-[22px] bg-[var(--chosen-ink)]' : 'translate-x-0.5 bg-muted-foreground')} />
          </span>
        </button>
      </div>
      {on && <>
        <div className="grid min-w-0 gap-1">
          <span className="text-[12px] text-muted-foreground">Checked from</span>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span role="group" aria-label={`${name}: checked from, presets`} className="flex flex-wrap gap-1">
              {AFTERS.map((t) => <button key={t} type="button" aria-pressed={c.after === t} onClick={() => onChange({ ...c, after: t })} className={chip(c.after === t)}>{time12(t)}</button>)}
            </span>
            <TimePicker label={`${name}: checked from`} value={c.after} invalid={problems.length > 0} className="w-32" onChange={(after) => onChange({ ...c, after })} />
          </div>
        </div>
        <div className="grid min-w-0 gap-1">
          <span className="text-[12px] text-muted-foreground">BTC moved at least, since</span>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="flex flex-nowrap items-center gap-1.5">
              <NumberField label={`${name}: points`} value={c.pts} decimals={0} unit="pts" className="w-28" invalid={problems.length > 0} onChange={(pts) => onChange({ ...c, pts })} />
              <TimePicker label={`${name}: move read from`} value={c.from} invalid={problems.length > 0} className="w-32" onChange={(from) => onChange({ ...c, from })} />
            </span>
            <span role="group" aria-label={`${name}: points, presets`} className="flex flex-wrap gap-1">
              {POINTS.map((p) => <button key={p} type="button" aria-pressed={c.pts === p} onClick={() => onChange({ ...c, pts: p })} className={chip(c.pts === p)}>{p} pts</button>)}
            </span>
          </div>
        </div>
        {problems.map((p) => <p key={p} role="alert" className="m-0 text-[12px] leading-snug text-[var(--down)]">{p}</p>)}
        {!problems.length && (
          <p aria-label={`${name} example`} className="m-0 text-[12px] leading-snug text-muted-foreground">
            BTC at 108,000 at {time12(c.from)} and {(108_000 + c.pts).toLocaleString('en-US')} or more at {time12(c.after)} or later: a buy signal -- a PE sold -- is skipped as <b className="font-medium text-foreground">Chase</b>; a sell signal -- a CE sold, against the run -- is taken. The same the other way on a fall. Before {time12(c.after)}, every signal is taken.
          </p>
        )}
      </>}
    </section>
  );
}
