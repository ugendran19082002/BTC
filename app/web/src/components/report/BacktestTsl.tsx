import { Chip, Segmented } from '@/components/mobile/parts';
import { NumberField } from '@/components/ui/number-field';
import { TSL_DEFAULT, tslExample, tslProblems } from '@/lib/backtest-tsl';
import { cn } from '@/lib/utils';
import type { Tsl, TslUnit } from '@/types/signal-backtest';

/**
 * A trailing SL on the option's own stop, in the backtest and a run together (owner, 18 Oct 2026: "TSL settings in
 * the backtest -- points and per cent; as the price moves from the entry, the SL moves -- user friendly"). Every X the
 * premium falls from the price sold, the stop comes down Y; it never goes back up. X and Y are each in premium
 * points or a per cent of the price sold. Worked through on an example premium underneath, so the rule reads as the
 * trader will see it.
 */
const PRESETS: { label: string; tsl: Tsl }[] = [
  { label: '5 pts → 5 pts', tsl: { move: 5, moveUnit: 'pts', by: 5, byUnit: 'pts' } },
  { label: '10 pts → 10 pts', tsl: { move: 10, moveUnit: 'pts', by: 10, byUnit: 'pts' } },
  { label: '10% → 10%', tsl: { move: 10, moveUnit: 'pct', by: 10, byUnit: 'pct' } },
  { label: '20% → 10%', tsl: { move: 20, moveUnit: 'pct', by: 10, byUnit: 'pct' } },
];
const UNITS: readonly { key: TslUnit; label: string; spoken: string }[] = [
  { key: 'pts', label: 'pts', spoken: 'premium points' },
  { key: 'pct', label: '%', spoken: 'per cent of the price sold' },
];
/** The premium the example is worked on. */
const EXAMPLE_ENTRY = 40;
const same = (a: Tsl, b: Tsl) => a.move === b.move && a.moveUnit === b.moveUnit && a.by === b.by && a.byUnit === b.byUnit;
const money = (v: number) => `$${Math.round(v * 100) / 100}`;

export function BacktestTsl({ value, onChange, stopPct, name = 'Trailing SL' }: {
  /** Null: off. */
  value: Tsl | null;
  onChange: (t: Tsl | null) => void;
  /** The option stop it moves, a share over the premium (3 is +300%); 0 is none, and then there is nothing to trail. */
  stopPct: number;
  name?: string;
}) {
  const on = value !== null;
  const t = value ?? TSL_DEFAULT;
  const set = (o: Partial<Tsl>) => onChange({ ...t, ...o });
  const problems = on ? tslProblems(t, stopPct) : [];
  const stop = EXAMPLE_ENTRY * (1 + stopPct);
  const example = on && !problems.length ? tslExample(t, EXAMPLE_ENTRY, stop) : [];
  return (
    <section aria-label={name} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border border-solid border-border p-2.5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[13.5px] font-medium text-foreground">{name} <span className="font-normal text-muted-foreground">(TSL)</span></span>
          <span className={cn('block text-[12px] leading-snug', on ? 'text-foreground' : 'text-muted-foreground')}>
            {on ? 'As the premium falls from the price sold, the option SL comes down after it -- never back up.' : 'Off · the option SL stays where it is set.'}
          </span>
        </span>
        <button type="button" role="switch" aria-checked={on} aria-label={`${name}, on or off`} onClick={() => onChange(on ? null : t)}
          className="m-0 inline-flex min-h-[44px] flex-none cursor-pointer appearance-none items-center border-0 bg-transparent p-0 pl-2">
          <span className={cn('relative inline-flex h-6 w-11 items-center rounded-full transition-colors', on ? 'bg-[var(--chosen)]' : 'bg-[var(--line)]')}>
            <span className={cn('block h-5 w-5 rounded-full shadow transition-transform', on ? 'translate-x-[22px] bg-[var(--chosen-ink)]' : 'translate-x-0.5 bg-muted-foreground')} />
          </span>
        </button>
      </div>
      {on && <>
        <div role="group" aria-label={`${name} presets`} className="flex min-w-0 flex-wrap gap-1.5">
          {PRESETS.map((p) => <Chip key={p.label} on={same(p.tsl, t)} onClick={() => onChange(p.tsl)}>{p.label}</Chip>)}
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="grid min-w-0 gap-1">
            <span className="text-[12px] text-muted-foreground">Every time the premium falls</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <NumberField label={`${name}: price move`} value={t.move} decimals={2} className="w-24" invalid={problems.some((x) => x.startsWith('The price move'))} onChange={(move) => set({ move })} />
              <Segmented dense label={`${name}: price move in`} value={t.moveUnit} options={UNITS} onChange={(moveUnit) => set({ moveUnit })} />
            </span>
          </div>
          <div className="grid min-w-0 gap-1">
            <span className="text-[12px] text-muted-foreground">move the SL down by</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <NumberField label={`${name}: SL move`} value={t.by} decimals={2} className="w-24" invalid={problems.some((x) => x.startsWith('The SL'))} onChange={(by) => set({ by })} />
              <Segmented dense label={`${name}: SL move in`} value={t.byUnit} options={UNITS} onChange={(byUnit) => set({ byUnit })} />
            </span>
          </div>
        </div>
        {problems.map((p) => <p key={p} role="alert" className="m-0 text-[12px] leading-snug text-[var(--down)]">{p}</p>)}
        {example.length > 0 && (
          <p aria-label={`${name} example`} className="m-0 text-[12px] leading-snug text-muted-foreground">
            Sold at {money(EXAMPLE_ENTRY)}, SL {money(stop)}: {example.map((x) => `at ${money(x.premium)} → SL ${money(x.stop)}`).join(' · ')}.
            {' '}% is of the price sold. Judged on the offer, as the stop is; a stop hit after it moved is counted as <b className="font-medium text-foreground">Option TSL</b>.
          </p>
        )}
      </>}
    </section>
  );
}
