import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { TimePicker } from '@/components/ui/time-picker';
import { NumberField } from '@/components/ui/number-field';
import { Checkbox } from '@/components/ui/checkbox';
import { DEFAULT_MIN_OTM, MAX_STRIKE_BLOCKS, type StrategyConfig, type StrikeBlock } from '@/types/strategy';
import { FieldError, QuickFix, StrikeStepper, num, type SetField } from '@/components/strategy/form-parts';
import {
  DEFAULT_BLOCK_HOURS, blockRanges, hoursLabel, ownPick, pickWords, splitBlocks, strikeBlockProblems,
} from '@/lib/strategy-blocks';
import { hhmmOf, isHhmm, minutesForward, minutesOf, time12 } from '@/lib/time';
import { cn } from '@/lib/utils';

/**
 * A signal strategy's strike rule over its window (4 Oct 2026).
 *
 * One premium number cannot be right for a whole day of signals: what a strike
 * pays at 6 PM, with the contract ahead of it, is not what it pays an hour
 * before the settlement. So the window is cut into blocks -- every four hours
 * unless another length is typed -- and each block picks its strike by its own
 * rule, by premium or by strike, the same two ways as the rule above it.
 *
 * Block 1 is the rule above, from the start of the window; it is shown here so
 * the list reads as the whole day, and changed up there. Every other block has
 * its start time and its rule on its own row. Off -- the default -- nothing is
 * split and the rule above holds all window, as it always did.
 */
export function StrikeBlocksEditor({ c, set }: { c: StrategyConfig; set: SetField }) {
  const blocks = c.strikeBlocks ?? [];
  const on = blocks.length > 0;
  const [hours, setHours] = useState(DEFAULT_BLOCK_HOURS);
  const everyMin = Math.round(hours * 60);

  const windowOk = isHhmm(c.entryTime) && isHhmm(c.exitTime);
  const entry = windowOk ? minutesOf(c.entryTime) : 0;
  const span = windowOk ? minutesForward(entry, minutesOf(c.exitTime)) : 0;
  const firstAt = windowOk ? hhmmOf(entry + 1) : null;
  const lastAt = windowOk ? hhmmOf(entry + span - 1) : null;

  const ranges = blockRanges(c);
  const problems = strikeBlockProblems(c.strikeBlocks, c.entryTime, c.exitTime);
  const problemsOf = (i: number) => problems.filter((p) => p.index === i).map((p) => p.message).join(' ') || null;

  const put = (next: StrikeBlock[]) => set('strikeBlocks', next);
  const patch = (i: number, over: Partial<StrikeBlock>) => put(blocks.map((b, j) => (j === i ? { ...b, ...over } : b)));
  const split = () => put(splitBlocks(c, everyMin));
  /*
   * Switched on: the window cut at the length shown. A window shorter than one
   * length cannot be cut that way, so it is cut in half instead -- on must
   * leave something on the screen to edit.
   */
  const turnOn = () => {
    const cut = splitBlocks(c, everyMin);
    put(cut.length || span < 2 ? cut : [{ at: hhmmOf(entry + Math.floor(span / 2)), ...ownPick(c) }]);
  };
  /** One length after the last block, inside the window, carrying its rule on. */
  const add = () => {
    const prev = blocks.at(-1);
    const from = prev && isHhmm(prev.at) ? minutesForward(entry, minutesOf(prev.at)) : 0;
    const at = Math.min(from + Math.max(everyMin, 1), span - 1);
    const { at: _at, ...rule } = prev ?? { at: '', ...ownPick(c) };
    put([...blocks, { ...rule, premium: { ...rule.premium }, at: hhmmOf(entry + at) }]);
  };

  const wouldMake = windowOk && everyMin >= 1 ? splitBlocks({ ...c, strikeBlocks: [] }, everyMin).length + 1 : 0;

  return (
    <section aria-label="strike rule by time" className="mt-3 rounded-lg border border-solid border-border px-2.5 py-1.5">
      <Switch
        label="Different strike rule by time of day"
        description={on
          ? `${blocks.length + 1} blocks from ${windowOk ? time12(c.entryTime) : 'entry'} to ${windowOk ? time12(c.exitTime) : 'exit'} — each signal is sold under the block it arrives in.`
          : 'Off — the rule above for the whole window.'}
        checked={on}
        onCheckedChange={(v) => (v ? turnOn() : put([]))}
      />

      {on && (
        <>
          <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md bg-muted p-2 text-[12px]">
            <span>Split every</span>
            <NumberField label="block hours" value={hours} onChange={setHours} unit="h" className="w-20" />
            <button
              type="button"
              onClick={split}
              disabled={!windowOk || !(everyMin >= 1)}
              className="m-0 h-8 appearance-none rounded-md border-0 bg-[var(--accent)] px-3 font-[inherit] text-[12px] font-medium text-white disabled:opacity-40"
            >
              Split
            </button>
            {windowOk && wouldMake > 0 && (
              <span className="w-full text-[11px] text-[var(--dim)]">
                {time12(c.entryTime)} → {time12(c.exitTime)} is {hoursLabel(span)}: {wouldMake} block{wouldMake === 1 ? '' : 's'} of {hoursLabel(everyMin)}
                {span % everyMin !== 0 && wouldMake > 1 ? `, the last ${hoursLabel(span % everyMin)}` : ''}. Split keeps each block&apos;s rule where its time still falls.
              </span>
            )}
          </div>

          <ol className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0" aria-label="strike blocks">
            <li aria-label="block 1" className="rounded-md bg-muted px-2 py-1.5 text-[12px]">
              <BlockHead n={1} range={ranges[0] ?? null} />
              <span className="text-muted-foreground"> — the rule above: </span>
              <b className="text-foreground">{pickWords(ownPick(c))}</b>
            </li>
            {blocks.map((b, i) => {
              const n = i + 2;
              const bad = problemsOf(i);
              return (
                <li key={i} aria-label={`block ${n}`}
                    className={cn('rounded-md border border-solid px-2 py-1.5', bad ? 'border-[var(--down)]' : 'border-border')}>
                  <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                    <span className="w-14 flex-none font-medium text-foreground">Block {n}</span>
                    <TimePicker
                      label={`Block ${n} starts`}
                      value={b.at}
                      onChange={(v) => patch(i, { at: v })}
                      min={firstAt}
                      max={lastAt}
                      invalid={Boolean(bad)}
                      className="min-w-[7.5rem] flex-1"
                    />
                    {/* Under the time on a phone, where beside it would push the remove button onto a row of its own. */}
                    <span className="order-last basis-full tabular-nums text-muted-foreground sm:order-none sm:basis-auto">
                      {ranges[i + 1] ? <>→ {time12(ranges[i + 1]!.until)} · {hoursLabel(ranges[i + 1]!.minutes)}</> : null}
                    </span>
                    <button
                      type="button"
                      aria-label={`remove block ${n}`}
                      onClick={() => put(blocks.filter((_, j) => j !== i))}
                      className="m-0 ml-auto grid h-8 w-8 flex-none appearance-none place-items-center rounded-md border-0 bg-transparent p-0 text-muted-foreground"
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </button>
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <Pills
                      label={`block ${n} strike rule`}
                      value={b.strikeRule}
                      onChange={(v) => patch(i, { strikeRule: v })}
                      options={[{ v: 'premium', label: 'By premium' }, { v: 'strict', label: 'By strike' }]}
                    />
                    {b.strikeRule === 'premium' && (
                      <>
                        <Pills
                          label={`block ${n} premium rule`}
                          value={b.premium.mode}
                          onChange={(v) => patch(i, { premium: { ...b.premium, mode: v } })}
                          options={[{ v: 'atLeast', label: 'At least' }, { v: 'atMost', label: 'At most' }]}
                        />
                        <Money label={`block ${n} premium usd`} value={String(b.premium.usd)}
                               onChange={(t) => patch(i, { premium: { ...b.premium, usd: num(t, 0) } })} />
                        <span className="text-[11.5px] text-muted-foreground">else</span>
                        <Money label={`block ${n} fallback usd`} placeholder="none"
                               value={b.premium.fallbackUsd === null || b.premium.fallbackUsd === undefined ? '' : String(b.premium.fallbackUsd)}
                               onChange={(t) => patch(i, { premium: { ...b.premium, fallbackUsd: t.trim() === '' ? null : num(t, 0) } })} />
                        {/* The floor on distance, per block: ticked, the premium's strike is sold only at OTM n or further. */}
                        <Checkbox
                          label="at least OTM"
                          aria-label={`block ${n} at least otm`}
                          checked={b.premium.minOtm != null}
                          onChange={(e) => patch(i, { premium: { ...b.premium, minOtm: e.target.checked ? (c.premium.minOtm ?? DEFAULT_MIN_OTM) : null } })}
                          className="flex-none text-[11.5px] text-muted-foreground"
                        />
                        {b.premium.minOtm != null && (
                          <Input value={String(b.premium.minOtm)} aria-label={`block ${n} nearest otm`} inputMode="numeric" className="h-8 w-12 flex-none px-2 text-center"
                                 onChange={(e) => patch(i, { premium: { ...b.premium, minOtm: Math.trunc(num(e.target.value, 0)) } })} />
                        )}
                      </>
                    )}
                  </div>
                  {b.strikeRule === 'strict' && (
                    <div className="mt-1.5">
                      <StrikeStepper value={b.strikeStep} onChange={(v) => patch(i, { strikeStep: v })} />
                    </div>
                  )}
                  <FieldError text={bad} />
                </li>
              );
            })}
          </ol>
          <FieldError text={problemsOf(-1)} />

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pb-1">
            <button
              type="button"
              onClick={add}
              disabled={!windowOk || blocks.length >= MAX_STRIKE_BLOCKS || span < 2}
              className="m-0 inline-flex appearance-none items-center gap-1 border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden /> Add a block
            </button>
            {problems.some((p) => /must start after/.test(p.message)) && (
              <QuickFix onClick={split}>Split again every {hoursLabel(Math.max(everyMin, 1))}</QuickFix>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** "Block 1 · 5:35 PM → 9:35 PM · 4 h". */
function BlockHead({ n, range }: { n: number; range: { from: string; until: string; minutes: number } | null }) {
  return (
    <>
      <span className="font-medium text-foreground">Block {n}</span>
      {range && <span className="tabular-nums text-muted-foreground"> · {time12(range.from)} → {time12(range.until)} · {hoursLabel(range.minutes)}</span>}
    </>
  );
}

/** Two choices on one short line: the form's Segmented, without the sentence under it. */
function Pills<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { v: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-none gap-0.5 rounded-md bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          onClick={() => onChange(o.v)}
          className={cn(
            'm-0 h-7 appearance-none whitespace-nowrap rounded border-0 px-2 font-[inherit] text-[12px] font-medium',
            value === o.v ? 'bg-background text-foreground shadow-sm' : 'bg-transparent text-muted-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A dollar amount typed; blank is passed on as blank, for a fallback that may be none. */
function Money({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (text: string) => void; placeholder?: string;
}) {
  return (
    <div className="relative h-8 flex-none">
      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">$</span>
      <Input value={value} aria-label={label} inputMode="decimal" placeholder={placeholder} className="h-8 w-[4.5rem] pl-5"
             onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
