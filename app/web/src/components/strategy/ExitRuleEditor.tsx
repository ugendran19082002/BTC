import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { ExitMode } from '@/types/strategy';
import { NumberField } from '@/components/ui/number-field';
import { TimePicker } from '@/components/ui/time-picker';
import {
  exitPrice, exitWords, fillSteps, MAX_EXIT_STEPS, type ExitLeg, type ExitRule,
} from '@/lib/strategy-exits';
import { hhmmOf, isHhmm, minutesForward, minutesOf, time12 } from '@/lib/time';
import { price as fmtPrice } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * One exit of a strategy -- the target or the stop -- typed, not dragged.
 *
 *   [ % | Fixed ]   80 %      sold at 15 → buys back at 3.00
 *   From 7:30 AM    85 %      ✕
 *   From 9:30 AM    90 %      ✕
 *   + Add a step    Fill: every 2 h, +5 %
 *
 * Percent or fixed points, and either can move through the day. Every step is
 * held between the entry and the exit on the picker itself, and anything still
 * wrong is said under the box by the form's rules -- the same words the server
 * answers with.
 *
 * A short option makes money as it gets cheaper, so the two exits run opposite
 * ways and the colours say so: the target green and under the entry, the stop
 * red and over it. The stop may be far above 100%; the target stops at 99%.
 */
export function ExitRuleEditor({
  leg, rule, onChange, onMode, entryTime, exitTime, samplePrice, error,
}: {
  leg: ExitLeg;
  rule: ExitRule;
  onChange: (r: ExitRule) => void;
  /**
   * Switch between percent and fixed. The form keeps each mode's value in its
   * own field, so switching back finds 80% where it was left; the steps go,
   * because they are written in the old units.
   */
  onMode: (mode: ExitMode) => void;
  entryTime: string;
  exitTime: string;
  /** A premium to show the level against -- the rule's own number, when it has one. */
  samplePrice: number | null;
  error?: string | null;
}) {
  const target = leg === 'target';
  const title = target ? 'Take profit' : 'Stop loss';
  const tone = target ? 'text-[var(--up)]' : 'text-[var(--down)]';
  const pct = rule.mode === 'pct';
  // Percent is shown as a percent and kept as a fraction: 80 on screen is 0.8 in the rule.
  const toShown = (v: number) => (pct ? v * 100 : v);
  const fromShown = (n: number) => (pct ? n / 100 : n);
  const unit = pct ? '%' : 'pts';

  const windowOk = isHhmm(entryTime) && isHhmm(exitTime);
  const firstAt = windowOk ? hhmmOf(minutesOf(entryTime) + 1) : null;
  const lastAt = windowOk ? hhmmOf(minutesOf(exitTime) - 1) : null;

  const setMode = (mode: ExitMode) => { if (mode !== rule.mode) onMode(mode); };
  const setStep = (i: number, patch: Partial<ExitRule['steps'][number]>) =>
    onChange({ ...rule, steps: rule.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const removeStep = (i: number) => onChange({ ...rule, steps: rule.steps.filter((_, j) => j !== i) });
  const addStep = () => {
    if (!windowOk) return;
    // An hour after the last step (or the entry), inside the window, carrying the last value on.
    const entry = minutesOf(entryTime);
    const span = minutesForward(entry, minutesOf(exitTime));
    const lastStep = rule.steps.at(-1);
    const from = lastStep && isHhmm(lastStep.at) ? minutesForward(entry, minutesOf(lastStep.at)) : 0;
    const at = Math.min(from + 60, span - 1);
    onChange({ ...rule, steps: [...rule.steps, { at: hhmmOf(entry + at), value: lastStep?.value ?? rule.value }] });
  };

  const [fillOpen, setFillOpen] = useState(false);
  const [everyHours, setEveryHours] = useState(2);
  const [by, setBy] = useState(5);
  const fill = () => {
    onChange({
      ...rule,
      steps: fillSteps({
        leg, mode: rule.mode, entryTime, exitTime, start: rule.value,
        everyMin: Math.round(everyHours * 60), by: fromShown(by),
      }),
    });
    setFillOpen(false);
  };

  const level = exitPrice(leg, rule.mode, rule.value, samplePrice);

  return (
    <section aria-label={title} className="rounded-lg border border-[var(--line)] p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className={cn('text-[13px] font-semibold', tone)}>{title}</span>
        <div role="radiogroup" aria-label={`${title} by`} className="flex gap-0.5 rounded-md bg-muted p-0.5">
          {(['pct', 'points'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={rule.mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'm-0 h-7 appearance-none rounded border-0 px-2.5 font-[inherit] text-[12px] font-medium',
                rule.mode === m ? 'bg-background text-foreground shadow-sm' : 'bg-transparent text-muted-foreground',
              )}
            >
              {m === 'pct' ? '%' : 'Fixed'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-start gap-2">
        <NumberField
          label={`${title} ${pct ? 'percent' : 'points'}`}
          value={toShown(rule.value)}
          onChange={(n) => onChange({ ...rule, value: fromShown(n) })}
          unit={unit}
          invalid={Boolean(error)}
          className="w-28 flex-none"
        />
        <p className="m-0 min-w-0 pt-1 text-[11.5px] leading-snug text-muted-foreground">
          {!(rule.value > 0)
            ? (target ? 'Off — holds to expiry.' : 'Off — no stop.')
            : target
              ? pct ? <>keeps {exitWords('pct', rule.value)} of the premium</> : <>buys back {rule.value} pts under the entry</>
              : pct ? <>buys back {exitWords('pct', rule.value)} above the entry</> : <>buys back {rule.value} pts above the entry</>}
          {level !== null && samplePrice !== null && (
            <> · sold at {fmtPrice(samplePrice)} → <b className={cn('tabular-nums', tone)}>{fmtPrice(level)}</b></>
          )}
        </p>
      </div>

      {rule.steps.length > 0 && (
        <ol className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0" aria-label={`${title} steps`}>
          {rule.steps.map((st, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-10 flex-none text-[11.5px] text-muted-foreground">From</span>
              <TimePicker
                label={`${title} step ${i + 1} time`}
                value={st.at}
                onChange={(v) => setStep(i, { at: v })}
                min={firstAt}
                max={lastAt}
                className="min-w-0 flex-1"
              />
              <NumberField
                label={`${title} step ${i + 1} ${pct ? 'percent' : 'points'}`}
                value={toShown(st.value)}
                onChange={(n) => setStep(i, { value: fromShown(n) })}
                unit={unit}
                className="w-24 flex-none"
              />
              <button
                type="button"
                aria-label={`remove ${title.toLowerCase()} step ${i + 1}`}
                onClick={() => removeStep(i)}
                className="m-0 grid h-8 w-8 flex-none appearance-none place-items-center rounded-md border-0 bg-transparent p-0 text-muted-foreground"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={addStep}
          disabled={!windowOk || rule.steps.length >= MAX_EXIT_STEPS}
          className="m-0 inline-flex appearance-none items-center gap-1 border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add a time step
        </button>
        <button
          type="button"
          onClick={() => setFillOpen((v) => !v)}
          disabled={!windowOk}
          aria-expanded={fillOpen}
          className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] underline underline-offset-2 disabled:opacity-40"
        >
          Fill steps…
        </button>
        {rule.steps.length > 0 && (
          <button
            type="button"
            onClick={() => onChange({ ...rule, steps: [] })}
            className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-muted-foreground underline underline-offset-2"
          >
            Clear steps
          </button>
        )}
      </div>

      {fillOpen && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-muted p-2 text-[12px]">
          <span>Every</span>
          <NumberField label={`${title} fill every hours`} value={everyHours} onChange={setEveryHours} unit="h" decimals={2} className="w-20" />
          <span>from {windowOk ? time12(entryTime) : 'entry'}, change by</span>
          <NumberField label={`${title} fill change by`} value={by} onChange={setBy} unit={unit} className="w-20" />
          <button
            type="button"
            onClick={fill}
            disabled={!(everyHours > 0)}
            className="m-0 h-8 appearance-none rounded-md border-0 bg-[var(--accent)] px-3 font-[inherit] text-[12px] font-medium text-white disabled:opacity-40"
          >
            Fill
          </button>
          <span className="w-full text-[11px] text-[var(--dim)]">Replaces the steps, up to the {windowOk ? time12(exitTime) : ''} exit.</span>
        </div>
      )}

      {rule.steps.length === 0 && (
        <p className="m-0 mt-1 text-[10.5px] leading-snug text-[var(--dim)]">
          The same all day. Add steps to move it as the day goes on — each from its time until the next.
        </p>
      )}
      {error && <p role="alert" className="m-0 mt-1.5 text-[11.5px] leading-snug text-[var(--down)]">{error}</p>}
    </section>
  );
}
