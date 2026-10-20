import { NumberField } from '@/components/ui/number-field';
import { BREAK_EVEN_DEFAULT, breakEvenProblems } from '@/lib/backtest-tsl';
import { cn } from '@/lib/utils';
import { UnitToggle } from '@/components/report/BacktestTsl';
import type { BreakEven } from '@/types/signal-backtest';

/**
 * The option's stop to the price sold, in the backtest and a run together (owner, 18 Oct 2026: "SL move to the entry
 * price -- a new option, pts and %"): once the premium has fallen X from the price sold -- in points, or a per cent of
 * it -- the stop is the price sold, and stays there or tighter. With no stop set before, it is the stop from then on;
 * beside a trailing SL, the tighter of the two. Worked through on an example premium underneath.
 */
const PRESETS: BreakEven[] = [{ move: 10, unit: 'pts' }, { move: 25, unit: 'pct' }, { move: 50, unit: 'pct' }];
const EXAMPLE = 40;
const money = (v: number) => `$${Math.round(v * 100) / 100}`;

export function BacktestBreakEven({ value, onChange, name = 'SL to entry' }: { value: BreakEven | null; onChange: (b: BreakEven | null) => void; name?: string }) {
  const on = value !== null;
  const b = value ?? BREAK_EVEN_DEFAULT;
  const problems = on ? breakEvenProblems(b) : [];
  const at = b.unit === 'pts' ? EXAMPLE - b.move : EXAMPLE * (1 - b.move / 100);
  return (
    <section aria-label={name} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border border-solid border-border p-2.5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[13.5px] font-medium text-foreground">{name} <span className="font-normal text-muted-foreground">(break-even)</span></span>
          <span className={cn('block text-[12px] leading-snug', on ? 'text-foreground' : 'text-muted-foreground')}>
            {on ? 'Once the premium has fallen this far from the price sold, the option SL goes to the price sold -- never back up.' : 'Off · the option SL is never moved to the entry.'}
          </span>
        </span>
        <button type="button" role="switch" aria-checked={on} aria-label={`${name}, on or off`} onClick={() => onChange(on ? null : b)}
          className="m-0 inline-flex min-h-[44px] flex-none cursor-pointer appearance-none items-center border-0 bg-transparent p-0 pl-2">
          <span className={cn('relative inline-flex h-6 w-11 items-center rounded-full transition-colors', on ? 'bg-[var(--chosen)]' : 'bg-[var(--line)]')}>
            <span className={cn('block h-5 w-5 rounded-full shadow transition-transform', on ? 'translate-x-[22px] bg-[var(--chosen-ink)]' : 'translate-x-0.5 bg-muted-foreground')} />
          </span>
        </button>
      </div>
      {on && <>
        <div className="grid min-w-0 gap-1">
          <span className="text-[12px] text-muted-foreground">Move the SL to the entry once the premium has fallen</span>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="flex flex-nowrap items-center gap-1.5">
              <NumberField label={`${name}: premium fall`} value={b.move} decimals={2} className="w-24" invalid={problems.length > 0} onChange={(move) => onChange({ ...b, move })} />
              <UnitToggle label={`${name}: premium fall in`} value={b.unit} onChange={(unit) => onChange({ ...b, unit })} />
            </span>
            <span role="group" aria-label={`${name} presets`} className="flex flex-wrap gap-1">
              {PRESETS.map((p) => {
                const chosen = p.move === b.move && p.unit === b.unit;
                return (
                  <button key={`${p.move}${p.unit}`} type="button" aria-pressed={chosen} onClick={() => onChange(p)}
                    className={cn('m-0 h-9 appearance-none rounded-full border border-solid px-3 font-[inherit] text-[12.5px]', chosen ? 'border-[var(--chosen-line)] bg-[var(--chosen-soft)] text-[var(--chosen-text)]' : 'border-border bg-transparent text-muted-foreground')}>
                    {p.unit === 'pts' ? `${p.move} pts` : `${p.move}%`}
                  </button>
                );
              })}
            </span>
          </div>
        </div>
        {problems.map((p) => <p key={p} role="alert" className="m-0 text-[12px] leading-snug text-[var(--down)]">{p}</p>)}
        {!problems.length && at > 0 && (
          <p aria-label={`${name} example`} className="m-0 text-[12px] leading-snug text-muted-foreground">
            Sold at {money(EXAMPLE)}: once offered at {money(at)} or less, the SL is {money(EXAMPLE)}. If the premium comes back up to it, the trade is bought back about where it was sold -- counted as <b className="font-medium text-foreground">Option SL at entry</b>.
          </p>
        )}
      </>}
    </section>
  );
}
