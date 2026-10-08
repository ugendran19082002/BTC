import { useState } from 'react';
import { CopyCheck, Plus, Undo2, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { TimePicker } from '@/components/ui/time-picker';
import { NumberField } from '@/components/ui/number-field';
import {
  DEFAULT_DELTA, DEFAULT_DISTANCE, DEFAULT_FIXED_DISTANCE_PCT, MAX_STRIKE_BLOCKS, PREMIUM_MODE_LABEL, distanceNeeded, elseOtmOf,
  type StrategyConfig, type StrikeBlock,
} from '@/types/strategy';
import {
  FieldError, MinOtmFields, QuickFix, StrikeFields, StrikeStepper, num, type ErrOf, type SetField,
} from '@/components/strategy/form-parts';
import {
  appliedWords, applyToAllBlocks, blockHoursOf, blockRanges, hoursLabel, ownPick, splitBlocks, strikeBlockProblems, type BlockRange,
  type BlockRules,
} from '@/lib/strategy-blocks';
import { hhmmOf, isHhmm, minutesForward, minutesOf, minutesToSettlement, time12 } from '@/lib/time';
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
 *
 * Every block also has "Apply to all blocks" (owner, 8 Oct 2026): one click copies that block's premium and its
 * "if none" onto every block, says what it did, and offers to undo it -- a number worked out once is not typed
 * six times. Each block's time and distance rule stay its own (`applyToAllBlocks`).
 *
 * A block may also pick by delta or by distance from BTC (8 Oct 2026): one number each, with what a distance comes
 * to over that block's own hours said under it. `spot`, where the form has it, says the distance in points too.
 */
export function StrikeBlocksEditor({ c, set, err, spot }: { c: StrategyConfig; set: SetField; err: ErrOf; spot?: number | null }) {
  const blocks = c.strikeBlocks ?? [];
  const on = blocks.length > 0;
  // Starts at the length the saved blocks were cut at, so a strategy split every 3 hours reopens saying 3.
  const [hours, setHours] = useState(() => blockHoursOf(c));
  const everyMin = Math.round(hours * 60);

  const windowOk = isHhmm(c.entryTime) && isHhmm(c.exitTime);
  const entry = windowOk ? minutesOf(c.entryTime) : 0;
  const span = windowOk ? minutesForward(entry, minutesOf(c.exitTime)) : 0;
  const firstAt = windowOk ? hhmmOf(entry + 1) : null;
  const lastAt = windowOk ? hhmmOf(entry + span - 1) : null;

  // "Apply to all blocks": what was copied, from where, and the rules as they stood, for the undo.
  const [applied, setApplied] = useState<{ from: number; words: string; kept: string; before: BlockRules } | null>(null);

  const ranges = blockRanges(c);
  const problems = strikeBlockProblems(c.strikeBlocks, c.entryTime, c.exitTime);
  const problemsOf = (i: number) => problems.filter((p) => p.index === i).map((p) => p.message).join(' ') || null;
  // Block 1 is the strategy's own rule, so its problems are the rule's own.
  const firstBad = [err('strikeStep'), err('premium'), err('premiumFallback'), err('premiumMinOtm'), err('delta'), err('distance')].filter(Boolean).join(' ') || null;

  // Any edit of the blocks ends the offer to undo a copy: undoing would take the edit with it.
  const put = (next: StrikeBlock[]) => { setApplied(null); set('strikeBlocks', next); };
  const patch = (i: number, over: Partial<BlockRule>) => put(blocks.map((b, j) => (j === i ? { ...b, ...over } : b)));
  /** Block 1's rule is the strategy's own fields. */
  const patchFirst = (over: Partial<BlockRule>) => {
    setApplied(null);
    if (over.strikeRule !== undefined) set('strikeRule', over.strikeRule);
    if (over.strikeStep !== undefined) set('strikeStep', over.strikeStep);
    if (over.premium !== undefined) set('premium', over.premium);
    if (over.delta !== undefined) set('delta', over.delta);
    if (over.distance !== undefined) set('distance', over.distance);
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

  const putRules = (r: BlockRules) => {
    set('strikeRule', r.strikeRule); set('strikeStep', r.strikeStep); set('premium', r.premium); set('strikeBlocks', r.strikeBlocks ?? []);
    set('delta', r.delta); set('distance', r.distance);
  };
  const applyAll = (from: number) => {
    const next = applyToAllBlocks(c, from);
    if (!next) return;
    const src = from === 0 ? ownPick(c) : blocks[from - 1]!;
    setApplied({
      from, words: appliedWords(src),
      // A premium's "at least OTM" part is set per block on purpose and is not copied; the other rules are one number, copied whole.
      kept: src.strikeRule === 'premium' ? 'time and distance rule' : 'time',
      before: { strikeRule: c.strikeRule, strikeStep: c.strikeStep, premium: c.premium, delta: c.delta, distance: c.distance, strikeBlocks: blocks },
    });
    putRules(next);
  };
  const undoApply = () => { if (applied) { putRules(applied.before); setApplied(null); } };
  const canApply = (from: number) => applyToAllBlocks(c, from) !== null;

  // What the button did, said once in the block it was clicked on -- where the eye already is -- with the way back.
  const appliedNote = applied && (
    <div role="status" className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-solid border-[var(--up)]/50 bg-[var(--up-bg)] px-2.5 py-1.5 text-[12px] text-foreground">
      <span className="min-w-0 flex-1 basis-[14rem]">
        Block {applied.from + 1}&apos;s rule, <b className="font-semibold">{applied.words}</b>, is now on all {blocks.length + 1} blocks. Each block kept its own {applied.kept}.
      </span>
      <button type="button" onClick={undoApply}
              className="m-0 inline-flex h-8 flex-none appearance-none items-center gap-1 rounded-md border border-solid border-border bg-background px-2.5 font-[inherit] text-[12px] font-medium text-foreground">
        <Undo2 className="h-3.5 w-3.5" aria-hidden /> Undo
      </button>
    </div>
  );

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
            <StrikeFields c={c} set={set} err={err} allowOiWall={false} minPremium={false} spot={spot} />
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
            Off — tick to cut the window into blocks of hours, each with its own rule: premium, strike, delta or distance.
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
                  <ApplyAll n={1} of={blocks.length + 1} enabled={canApply(0)} onClick={() => applyAll(0)} />
                </div>
                <RuleFields n={1} rule={ownPick(c)} onChange={patchFirst} start={undefined} range={ranges[0] ?? null} spot={spot} />
                <FieldError text={firstBad} />
                {applied?.from === 0 && appliedNote}
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
                      {/*
                        On a phone the block's hours and "Apply to all blocks" go on a line of their own, under the
                        time: beside it they squeezed the time to two lines (measured 67px at 390 wide). The empty
                        full-width span is the line break; from `sm` up everything is one row again.
                      */}
                      <span aria-hidden className="order-last basis-full sm:hidden" />
                      <RangeWords range={ranges[i + 1] ?? null} className="order-last sm:order-none" />
                      <ApplyAll n={n} of={blocks.length + 1} enabled={canApply(n - 1)} onClick={() => applyAll(n - 1)} />
                      <button
                        type="button"
                        aria-label={`remove block ${n}`}
                        onClick={() => put(blocks.filter((_, j) => j !== i))}
                        className="m-0 grid h-8 w-8 flex-none appearance-none place-items-center rounded-md border-0 bg-transparent p-0 text-muted-foreground"
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </button>
                    </div>
                    <RuleFields n={n} rule={b} onChange={(over) => patch(i, over)} start={start} range={ranges[i + 1] ?? null} spot={spot} />
                    <FieldError text={bad} />
                    {applied?.from === n - 1 && appliedNote}
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

/**
 * "Apply to all blocks", on a block's own line: copies its premium and "if none" (or its strike) onto every block.
 * Greyed where the block's own rule is not yet a usable one -- a mistake is not spread across the day.
 */
function ApplyAll({ n, of, enabled, onClick }: { n: number; of: number; enabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button" onClick={onClick} disabled={!enabled}
      aria-label={`apply block ${n} to all ${of} blocks`}
      title={enabled ? `Copy block ${n}'s premium and its "if none" — or its strike, delta or distance — to all ${of} blocks` : `Finish block ${n}'s own rule first`}
      className="order-last m-0 ml-auto inline-flex h-8 flex-none appearance-none items-center gap-1 whitespace-nowrap rounded-md border border-solid border-[var(--accent)]/60 sm:order-none bg-transparent px-2 font-[inherit] text-[12px] font-medium text-[var(--accent)] disabled:border-border disabled:text-[var(--dim)] disabled:opacity-60"
    >
      <CopyCheck className="h-3.5 w-3.5" aria-hidden /> Apply to all blocks
    </button>
  );
}

/** A block's rule: what `StrikeBlock` carries besides its time, and what block 1 reads from the strategy. */
type BlockRule = Omit<StrikeBlock, 'at'> & { at?: string };

/** "→ 1:35 AM · 4 h": until when a block runs, and for how long. */
function RangeWords({ range, className }: { range: BlockRange | null; className?: string }) {
  if (!range) return null;
  return <span className={cn('tabular-nums text-muted-foreground', className)}>→ {time12(range.until)} · {hoursLabel(range.minutes)}</span>;
}

/** Hours from a time of day (IST "HH:MM") to the 5:30 PM settlement of the contract traded then. */
const hoursLeftAt = (hhmm: string): number => minutesToSettlement(minutesOf(hhmm)) / 60;

/** "2.01%", and with BTC known "2.01% (≈ 1,710 pts)". */
function farSaid(pct: number | null, spot: number | null | undefined): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  return `${pct.toFixed(2)}%${spot && spot > 0 ? ` (≈ ${Math.round((spot * pct) / 100).toLocaleString('en-US')} pts)` : ''}`;
}

/**
 * One block's rule, the same fields on every block: by premium (≥ or ≤, its
 * number, its "if none" number, and the distance rule with its else strike), by
 * strike, by delta, or by distance from BTC -- with what that distance comes to
 * over the block's own hours said under it.
 */
function RuleFields({ n, rule, onChange, start, range, spot }: {
  n: number;
  rule: Omit<StrikeBlock, 'at'>;
  onChange: (over: Partial<BlockRule>) => void;
  start: { minOtm: number; elseOtm: number } | undefined;
  range: BlockRange | null;
  spot?: number | null;
}) {
  const p = rule.premium;
  const delta = rule.delta ?? DEFAULT_DELTA;
  const far = rule.distance ?? DEFAULT_DISTANCE;
  return (
    <>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Pills
          label={`block ${n} strike rule`}
          value={rule.strikeRule}
          // A rule switched to for the first time starts from the figure that was measured, not from nothing.
          onChange={(v) => onChange({
            strikeRule: v,
            ...(v === 'delta' && !rule.delta ? { delta: { ...DEFAULT_DELTA } } : {}),
            ...(v === 'distance' && !rule.distance ? { distance: { ...DEFAULT_DISTANCE } } : {}),
          })}
          options={[{ v: 'premium', lead: 'By ', label: 'premium' }, { v: 'strict', lead: 'By ', label: 'strike' }, { v: 'delta', lead: 'By ', label: 'delta' }, { v: 'distance', lead: 'By ', label: 'distance' }]}
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
        {rule.strikeRule === 'delta' && (
          // One piece, so on a phone the number wraps to the next line with its words, not away from them.
          <span className="inline-flex flex-none items-center gap-1.5">
            <span className="text-[11.5px] text-muted-foreground">delta ≤</span>
            <NumberField label={`block ${n} delta`} value={delta.max} onChange={(v) => onChange({ delta: { max: v } })} className="w-[4.5rem] flex-none" />
          </span>
        )}
        {rule.strikeRule === 'distance' && (
          <>
            <span className="inline-flex flex-none items-center gap-1.5">
              <span className="text-[11.5px] text-muted-foreground">at least</span>
              <NumberField label={`block ${n} distance percent`} unit="%" value={far.pct} onChange={(v) => onChange({ distance: { ...far, pct: v } })} className="w-[5.5rem] flex-none" />
            </span>
            {/* The two read the number differently, so a switch starts the other from its own usual figure (form-parts `DistanceFields`). */}
            <Pills
              label={`block ${n} distance kind`}
              value={far.scale}
              onChange={(v) => { if (v !== far.scale) onChange({ distance: { scale: v, pct: v === 'time' ? DEFAULT_DISTANCE.pct : DEFAULT_FIXED_DISTANCE_PCT } }); }}
              options={[{ v: 'time', label: '× √hours left' }, { v: 'fixed', label: 'Fixed' }]}
            />
          </>
        )}
      </div>
      {rule.strikeRule === 'delta' && (
        <p className="m-0 mt-1 text-[11px] leading-snug text-[var(--dim)]">
          The strike nearest BTC with a delta of {Number.isFinite(delta.max) ? delta.max.toFixed(2) : '—'} or lower.
        </p>
      )}
      {rule.strikeRule === 'distance' && (
        <p className="m-0 mt-1 text-[11px] leading-snug text-[var(--dim)]" aria-label={`block ${n} distance worked out`}>
          {far.scale === 'time' && range
            ? <>From BTC: {farSaid(distanceNeeded(far, hoursLeftAt(range.from)), spot)} at {time12(range.from)}, down to {farSaid(distanceNeeded(far, hoursLeftAt(range.until)), spot)} by {time12(range.until)}.</>
            : far.scale === 'time'
              ? <>The number × the square root of the hours left to the 5:30 PM settlement.</>
              : <>The strike nearest BTC at least {farSaid(far.pct, spot)} away, all block.</>}
        </p>
      )}
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

/**
 * A few choices on one short line: the form's Segmented, without the sentence under it. A choice with a `lead`
 * ("By ") drops it on a phone, where four of them -- By premium, By strike, By delta, By distance -- would not fit
 * one line of a block: there they read Premium, Strike, Delta, Distance.
 */
function Pills<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { v: T; label: string; lead?: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex max-w-full flex-wrap gap-0.5 rounded-md bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          // The whole name, whichever width hides the lead: "By premium" to a screen reader on a phone too.
          aria-label={o.lead ? `${o.lead}${o.label}` : undefined}
          onClick={() => onChange(o.v)}
          className={cn(
            'm-0 h-7 appearance-none whitespace-nowrap rounded border-0 px-2 font-[inherit] text-[12px] font-medium',
            value === o.v ? 'bg-background text-foreground shadow-sm' : 'bg-transparent text-muted-foreground',
          )}
        >
          {o.lead && <span className="hidden sm:inline">{o.lead}</span>}
          <span className={o.lead ? 'capitalize sm:normal-case' : undefined}>{o.label}</span>
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
