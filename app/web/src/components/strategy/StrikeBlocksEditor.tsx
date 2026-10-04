import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { TimePicker } from '@/components/ui/time-picker';
import { NumberField } from '@/components/ui/number-field';
import { MAX_STRIKE_BLOCKS, PREMIUM_MODE_LABEL, elseOtmOf, type StrategyConfig, type StrikeBlock } from '@/types/strategy';
import {
  FieldError, MinOtmFields, QuickFix, StrikeFields, StrikeStepper, num, type ErrOf, type SetField,
} from '@/components/strategy/form-parts';
import {
  DEFAULT_BLOCK_HOURS, blockRanges, hoursLabel, ownPick, splitBlocks, strikeBlockProblems, type BlockRange,
} from '@/lib/strategy-blocks';
import { hhmmOf, isHhmm, minutesForward, minutesOf, time12 } from '@/lib/time';
import { cn } from '@/lib/utils';

/**
 * A signal strategy's strike rule, over its window (4 Oct 2026).
 *
 * Two tick boxes, one always ticked, each with its own section under it:
 *
 *   Same strike rule all the time          the default. One rule for the whole
 *                                          window, set with the same fields every
 *                                          strategy has -- by premium or by strike.
 *   Different strike rule by time of day   the window cut into blocks -- every
 *                                          four hours unless another length is
 *                                          typed -- each block with its own rule.
 *
 * One premium number cannot be right for a whole day of signals: what a strike
 * pays at 6 PM, with the contract ahead of it, is not what it pays an hour
 * before the settlement. Block 1 starts with the window and is the strategy's
 * own rule (`strikeRule`, `strikeStep`, `premium`), so going back to one rule
 * keeps it; the rest are `strikeBlocks`. Every block's row has the whole rule:
 * the premium, its "if none" number, and the distance rule with its else strike.
 */
export function StrikeBlocksEditor({ c, set, err }: { c: StrategyConfig; set: SetField; err: ErrOf }) {
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
  // Block 1 is the strategy's own rule, so its problems are the rule's own.
  const firstBad = [err('strikeStep'), err('premium'), err('premiumFallback'), err('premiumMinOtm')].filter(Boolean).join(' ') || null;

  const put = (next: StrikeBlock[]) => set('strikeBlocks', next);
  const patch = (i: number, over: Partial<BlockRule>) => put(blocks.map((b, j) => (j === i ? { ...b, ...over } : b)));
  /** Block 1's rule is three of the strategy's own fields. */
  const patchFirst = (over: Partial<BlockRule>) => {
    if (over.strikeRule !== undefined) set('strikeRule', over.strikeRule);
    if (over.strikeStep !== undefined) set('strikeStep', over.strikeStep);
    if (over.premium !== undefined) set('premium', over.premium);
  };
  const split = () => put(splitBlocks(c, everyMin));
  /*
   * By time of day: the window cut at the length shown. A window shorter than
   * one length cannot be cut that way, so it is cut in half instead -- there
   * must be something on the screen to edit.
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
  // What a block's distance rule starts from when it is switched on: block 1's, where it has one.
  const start = c.strikeRule === 'premium' && c.premium.minOtm != null
    ? { minOtm: c.premium.minOtm, elseOtm: elseOtmOf(c.premium)! }
    : undefined;

  return (
    <section aria-label="strike rule over the window" className="mt-3 flex flex-col gap-2">
      <div className={cn('rounded-lg border border-solid px-2.5 py-1.5', on ? 'border-border' : 'border-[var(--accent)]/60')}>
        <Checkbox
          label="Same strike rule all the time"
          checked={!on}
          onChange={() => { if (on) put([]); }}
          className="text-[13px] font-medium text-foreground"
        />
        {!on ? (
          <div role="group" aria-label="same strike rule all the time" className="pb-1">
            <p className="m-0 text-[11.5px] leading-snug text-muted-foreground">One rule for every signal, from the start of the window to its end.</p>
            <StrikeFields c={c} set={set} err={err} allowOiWall={false} minPremium={false} />
          </div>
        ) : (
          <p className="m-0 pb-1 text-[11.5px] leading-snug text-[var(--dim)]">Off — the rule changes through the window, below.</p>
        )}
      </div>

      <div className={cn('rounded-lg border border-solid px-2.5 py-1.5', on ? 'border-[var(--accent)]/60' : 'border-border')}>
        <Checkbox
          label="Different strike rule by time of day"
          checked={on}
          onChange={() => { if (!on) turnOn(); }}
          className="text-[13px] font-medium text-foreground"
        />
        {!on ? (
          <p className="m-0 pb-1 text-[11.5px] leading-snug text-[var(--dim)]">
            Off — tick to cut the window into blocks of hours, each with its own premium or strike.
          </p>
        ) : (
          <div role="group" aria-label="different strike rule by time of day">
            <p className="m-0 text-[11.5px] leading-snug text-muted-foreground">
              {blocks.length + 1} blocks from {windowOk ? time12(c.entryTime) : 'entry'} to {windowOk ? time12(c.exitTime) : 'exit'} — each signal is sold under the block it arrives in.
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md bg-muted p-2 text-[12px]">
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
              <li aria-label="block 1"
                  className={cn('rounded-md border border-solid px-2 py-1.5', firstBad ? 'border-[var(--down)]' : 'border-border')}>
                <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                  <span className="w-14 flex-none font-medium text-foreground">Block 1</span>
                  <span className="tabular-nums text-foreground">{windowOk ? time12(c.entryTime) : 'the start'}</span>
                  <span className="text-[10.5px] text-[var(--dim)]">the start of the window</span>
                  <RangeWords range={ranges[0] ?? null} />
                </div>
                <RuleFields n={1} rule={ownPick(c)} onChange={patchFirst} start={undefined} />
                <FieldError text={firstBad} />
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
                      <RangeWords range={ranges[i + 1] ?? null} className="order-last basis-full sm:order-none sm:basis-auto" />
                      <button
                        type="button"
                        aria-label={`remove block ${n}`}
                        onClick={() => put(blocks.filter((_, j) => j !== i))}
                        className="m-0 ml-auto grid h-8 w-8 flex-none appearance-none place-items-center rounded-md border-0 bg-transparent p-0 text-muted-foreground"
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </button>
                    </div>
                    <RuleFields n={n} rule={b} onChange={(over) => patch(i, over)} start={start} />
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
          </div>
        )}
      </div>
    </section>
  );
}

/** A block's rule: what `StrikeBlock` carries besides its time, and what block 1 reads from the strategy. */
type BlockRule = Omit<StrikeBlock, 'at'> & { at?: string };

/** "→ 1:35 AM · 4 h": until when a block runs, and for how long. */
function RangeWords({ range, className }: { range: BlockRange | null; className?: string }) {
  if (!range) return null;
  return <span className={cn('tabular-nums text-muted-foreground', className)}>→ {time12(range.until)} · {hoursLabel(range.minutes)}</span>;
}

/**
 * One block's rule, the same fields on every block: by premium (≥ or ≤, its
 * number, its "if none" number, and the distance rule with its else strike) or
 * by strike.
 */
function RuleFields({ n, rule, onChange, start }: {
  n: number;
  rule: Omit<StrikeBlock, 'at'>;
  onChange: (over: Partial<BlockRule>) => void;
  start: { minOtm: number; elseOtm: number } | undefined;
}) {
  const p = rule.premium;
  return (
    <>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Pills
          label={`block ${n} strike rule`}
          value={rule.strikeRule}
          onChange={(v) => onChange({ strikeRule: v })}
          options={[{ v: 'premium', label: 'By premium' }, { v: 'strict', label: 'By strike' }]}
        />
        {rule.strikeRule === 'premium' && (
          <>
            <Pills
              label={`block ${n} premium rule`}
              value={p.mode}
              onChange={(v) => onChange({ premium: { ...p, mode: v } })}
              options={[{ v: 'atLeast', label: PREMIUM_MODE_LABEL.atLeast }, { v: 'atMost', label: PREMIUM_MODE_LABEL.atMost }]}
            />
            <Money label={`block ${n} premium usd`} value={String(p.usd)}
                   onChange={(t) => onChange({ premium: { ...p, usd: num(t, 0) } })} />
            {/* "if none", not "else": else is the else strike's word, below. */}
            <span className="text-[11.5px] text-muted-foreground">if none</span>
            <Money label={`block ${n} fallback usd`} placeholder="none"
                   value={p.fallbackUsd === null || p.fallbackUsd === undefined ? '' : String(p.fallbackUsd)}
                   onChange={(t) => onChange({ premium: { ...p, fallbackUsd: t.trim() === '' ? null : num(t, 0) } })} />
          </>
        )}
      </div>
      {/* The distance rule and its else strike, per block: the same part the one-rule section has. */}
      {rule.strikeRule === 'premium' && (
        <MinOtmFields premium={p} onChange={(next) => onChange({ premium: next })} scope={`block ${n}`} start={start} />
      )}
      {rule.strikeRule === 'strict' && (
        <div className="mt-1.5">
          <StrikeStepper value={rule.strikeStep} onChange={(v) => onChange({ strikeStep: v })} />
        </div>
      )}
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
