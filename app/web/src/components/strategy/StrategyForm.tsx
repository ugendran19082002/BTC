import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { saveStrategy, getRebalanceSettings } from '@/api/strategy';
import {
  DAY_NAMES, DEFAULT_ADD_TO_OPPOSITE, DEFAULT_CONFIG, DEFAULT_REBALANCE, MAX_STRIKE_STEP,
  capWords, mostOneSideCanReach, stagePositions, stageThresholds, strikeLabel,
  type RebalanceLimits, type RebalanceRule, type Strategy, type StrategyConfig,
} from '@/types/strategy';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { TimePicker } from '@/components/ui/time-picker';
import { addExamples, describeStrategy, sizingOf } from '@/lib/strategy-preview';
import { problemFor, strategyProblems, type FormField, type FormTab, type Problem } from '@/lib/strategy-rules';
import { SETTLEMENT, defaultAddUntil, hhmmOf, isHhmm, minutesOf, spanLabel, time12, wrapsMidnight } from '@/lib/time';
import { inr, usd } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Everything a strategy is, in words rather than symbols -- in four short tabs.
 *
 * It used to be one column of every setting, each choice a pair of tall cards
 * with a sentence on each, and on a phone that was a long scroll to reach Save
 * past settings that had nothing to do with the one being changed. Now:
 *
 *   When     entry and exit on a clock, and the days
 *   Sell     which legs, which strike, how many lots, and what that ties up
 *   Trade    how the entry is priced and where it exits
 *   Extras   the safety filter, doubling, and adding to the other leg
 *
 * A tab with something wrong in it carries a red dot, the problem is written
 * under the field that has it, and Save says how much is left and takes you
 * there. The server still validates and answers; what it says is shown too.
 * The rule read back as a sentence stays at the top, folded to two lines.
 */

const TABS: { id: FormTab; label: string }[] = [
  { id: 'when', label: 'When' },
  { id: 'sell', label: 'Sell' },
  { id: 'trade', label: 'Entry & exit' },
  { id: 'extras', label: 'Extras' },
];

const num = (v: string, fallback: number) => {
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) ? n : fallback;
};

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];
const LAST_MINUTE = hhmmOf(minutesOf(SETTLEMENT) - 1);

export function StrategyForm({ editing, open, onOpenChange, onSaved, balanceUsd, spot }: {
  editing: Strategy | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
  balanceUsd?: number | null;
  spot?: number | null;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [c, setC] = useState<StrategyConfig>(editing?.config ?? DEFAULT_CONFIG);
  const [tab, setTab] = useState<FormTab>('when');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string[]>([]);
  const [readAll, setReadAll] = useState(false);
  // An empty name on a form just opened is not a mistake yet. It is said once
  // the name has been touched, or Save has been pressed.
  const [nameTouched, setNameTouched] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  const set = <K extends keyof StrategyConfig>(k: K, v: StrategyConfig[K]) =>
    setC((p) => ({ ...p, [k]: v }));
  /*
   * The desk's own defaults and limits, not numbers in this file: a desk that
   * runs five stages at 40/25 types it once, in Settings, and every new rule
   * starts there. Until they arrive the built-in defaults stand in.
   */
  const [rebalanceDefaults, setRebalanceDefaults] = useState<RebalanceRule>(DEFAULT_REBALANCE);
  const [rebalanceLimits, setRebalanceLimits] = useState<RebalanceLimits>({
    maxSteps: 20, maxLotsPerStep: 10_000, maxUpPct: 500, maxDownPct: 99,
    maxIncrementPct: 500, maxConfirmTicks: 10, maxLotsPerSide: 100_000,
  });
  useEffect(() => {
    getRebalanceSettings()
      .then((r) => { setRebalanceDefaults(r.defaults); setRebalanceLimits(r.limits); })
      .catch(() => {});
  }, []);

  const setReb = (patch: Partial<NonNullable<StrategyConfig['rebalance']>>) =>
    setC((p) => (p.rebalance ? { ...p, rebalance: { ...p.rebalance, ...patch } } : p));
  const setAdd = (patch: Partial<NonNullable<StrategyConfig['addToOpposite']>>) =>
    setC((p) => (p.addToOpposite ? { ...p, addToOpposite: { ...p.addToOpposite, ...patch } } : p));

  // Blank means "the entry's own seconds": null on the rule, not a zero.
  const addCross = c.addToOpposite?.crossAfterSec ?? null;
  const rebCross = c.rebalance?.crossAfterSec ?? null;
  /*
   * The cap the rule can actually reach, and the words for a cap that is under
   * it. Recomputed on every render, so changing 3 stages to 5 moves an
   * automatic cap with it rather than quietly refusing the last two.
   */
  const autoCap = c.rebalance ? mostOneSideCanReach(c.rebalance, c.lots) : 0;
  const capBlock = c.rebalance?.enabled ? capWords(c.rebalance, c.lots) : null;

  useEffect(() => {
    if (!c.rebalance?.enabled || !c.rebalance.capAuto) return;
    if (c.rebalance.maxLotsPerSide === autoCap) return;
    setReb({ maxLotsPerSide: autoCap });
  }, [autoCap, c.rebalance?.enabled, c.rebalance?.capAuto, c.rebalance?.maxLotsPerSide]);

  const problems = useMemo(() => strategyProblems(c, name), [c, name]);
  /*
   * The name box sits above the tabs, so its problem belongs to no tab. It used
   * to count for When: a new strategy opened with a red dot on When and "1 thing
   * to fix on When", and nothing on When was wrong.
   */
  const nameProblem = problemFor(problems, 'name');
  const tabProblems = problems.filter((p) => p.field !== 'name');
  const tabHasProblem = (t: FormTab) => tabProblems.some((p) => p.tab === t);
  const shownCount = tabProblems.length + (nameTouched && nameProblem ? 1 : 0);
  const sizing = sizingOf(c, balanceUsd ?? null, spot ?? null);
  // Doubling and "no days" are problems now, said under their own fields.
  const warnings = sizing.warnings.filter((w) => !/Doubling|No days/.test(w));

  const toggleDay = (d: number) =>
    set('weekdays', c.weekdays.includes(d) ? c.weekdays.filter((x) => x !== d) : [...c.weekdays, d].sort());

  const save = async () => {
    if (problems.length) {
      setNameTouched(true);
      if (tabProblems.length) setTab(tabProblems[0]!.tab);
      else nameInput.current?.focus();
      return;
    }
    setBusy(true);
    setRefused([]);
    try {
      await saveStrategy({ id: editing?.id, name: name.trim(), config: c });
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setRefused((e as Error).message.split(/(?<=\.)\s+/).filter(Boolean));
    } finally {
      setBusy(false);
    }
  };

  const err = (f: FormField) => problemFor(problems, f);
  const entryPlusOne = isHhmm(c.entryTime) ? hhmmOf(minutesOf(c.entryTime) + 1) : null;
  const daytime = isHhmm(c.entryTime) && minutesOf(c.entryTime) < minutesOf(SETTLEMENT);
  const exitMinusOne = isHhmm(c.exitTime) ? hhmmOf(minutesOf(c.exitTime) - 1) : null;
  // An exit earlier on the clock than the entry: 11:30 PM to 5:30 AM.
  const overnight = wrapsMidnight(c.entryTime, c.exitTime);
  // Offered whenever 5:29 PM would actually settle the objection, rather than
  // only on a daytime entry -- an overnight window can be fixed by it too.
  const lastMinuteFixes = Boolean(err('exitTime'))
    && !strategyProblems({ ...c, exitTime: LAST_MINUTE }, name).some((p) => p.field === 'exitTime');

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={editing ? `Edit ${editing.name}` : 'New strategy'}
        description="Times are IST. Nothing runs until this strategy and auto-trading are both on."
        className="sm:w-[480px]"
      >
        <label className="block">
          <span className="sr-only">Name</span>
          <Input ref={nameInput} value={name} aria-label="strategy name" placeholder="Name, e.g. Double one-sided"
                 aria-invalid={(nameTouched && Boolean(nameProblem)) || undefined}
                 className={cn(nameTouched && nameProblem && 'border-[var(--down)]')}
                 onBlur={() => setNameTouched(true)}
                 onChange={(e) => { setName(e.target.value); setNameTouched(true); }} />
        </label>
        <FieldError text={nameTouched ? nameProblem : null} />

        {/*
          The rule read back as a sentence: how a wrong setting gets noticed
          before it is saved. Two lines unless asked for more, so it does not
          push the settings off a phone screen.
        */}
        <button
          type="button"
          onClick={() => setReadAll((v) => !v)}
          aria-expanded={readAll}
          className="m-0 mt-2 flex w-full appearance-none items-start gap-1.5 rounded-lg border-0 bg-muted px-2.5 py-2 text-left font-[inherit]"
        >
          <span className={cn('min-w-0 flex-1 text-[12px] leading-relaxed text-foreground', !readAll && 'line-clamp-2')}>
            {describeStrategy(c)}
          </span>
          <ChevronDown className={cn('mt-0.5 h-3.5 w-3.5 flex-none text-muted-foreground transition-transform', readAll && 'rotate-180')} />
        </button>

        {/* The tabs stay in reach while a tab scrolls. */}
        <div
          role="tablist"
          aria-label="strategy settings"
          className="sticky top-0 z-10 -mx-4 mt-2 flex gap-1 border-b border-border bg-background px-4 pb-2 pt-1"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            const i = TABS.findIndex((t) => t.id === tab);
            const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
            setTab(next.id);
            document.getElementById(`tab-${next.id}`)?.focus();
          }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              className={cn(
                'relative m-0 h-9 flex-1 appearance-none whitespace-nowrap rounded-md border-0 px-1 font-[inherit] text-[12.5px] font-medium',
                tab === t.id ? 'bg-muted text-foreground' : 'bg-transparent text-muted-foreground',
              )}
            >
              {t.label}
              {tabHasProblem(t.id) && (
                <span aria-label="has a problem" className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[var(--down)]" />
              )}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="pt-2">
          {tab === 'when' && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Stack label="Entry time" error={err('entryTime')}>
                  <TimePicker
                    label="Entry time"
                    value={c.entryTime}
                    onChange={(v) => set('entryTime', v)}
                    invalid={Boolean(err('entryTime'))}
                    presets={[{ label: '5:30 AM · contract opens', value: '05:30' }]}
                    className="w-full"
                  />
                </Stack>
                <Stack label="Exit time" error={err('exitTime')}>
                  <TimePicker
                    label="Exit time"
                    value={c.exitTime}
                    onChange={(v) => set('exitTime', v)}
                    min={entryPlusOne}
                    max={LAST_MINUTE}
                    invalid={Boolean(err('exitTime'))}
                    presets={[{ label: '5:29 PM · last minute', value: LAST_MINUTE }]}
                    className="w-full"
                  />
                </Stack>
              </div>
              {lastMinuteFixes && (
                <QuickFix onClick={() => set('exitTime', LAST_MINUTE)}>Set exit to 5:29 PM</QuickFix>
              )}
              <p className="m-0 mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
                {!err('exitTime') && spanLabel(c.entryTime, c.exitTime)
                  ? `Runs ${spanLabel(c.entryTime, c.exitTime)}${overnight ? ', into the next day' : ''}. `
                  : ''}
                {overnight
                  ? 'An exit earlier on the clock than the entry means the next day.'
                  : daytime
                    ? 'The contract settles at 5:30 PM, so 5:29 PM is the last exit.'
                    : 'An evening entry holds tomorrow’s contract.'}
              </p>

              {/*
                Which day a tick means is not obvious once a strategy runs past
                midnight: a Saturday 11:30 PM entry finishes on Sunday, and the
                Sunday box has nothing to do with it. Say which end is meant.
              */}
              <Stack
                label="Days"
                error={err('weekdays')}
                className="mt-3"
                hint={overnight ? 'The day the entry starts — this one finishes the next day.' : undefined}
              >
                <div className="grid grid-cols-7 gap-1">
                  {DAY_NAMES.map((d, i) => {
                    const on = c.weekdays.includes(i);
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-label={d}
                        aria-pressed={on}
                        onClick={() => toggleDay(i)}
                        className={cn('m-0 h-10 appearance-none rounded-md border border-solid font-[inherit] text-[12px] font-medium',
                          on ? 'border-[var(--warn)] bg-[var(--warn)] text-black' : 'border-[var(--line)] bg-transparent text-[var(--dim)]')}
                      >
                        {d}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-1.5 flex gap-3 text-[12px]">
                  {([['Every day', [0, 1, 2, 3, 4, 5, 6]], ['Weekdays', WEEKDAYS], ['Weekends', WEEKEND]] as const).map(([label, days]) => (
                    <button key={label} type="button" onClick={() => set('weekdays', [...days])}
                            className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-muted-foreground underline underline-offset-2">
                      {label}
                    </button>
                  ))}
                </div>
              </Stack>

              {/*
                How late is too late.
                It was one constant for the whole desk -- sixty minutes, raised
                from thirty when a restart cost a day -- and invisible, so a
                strategy that quietly did not run at 07:00 looked broken rather
                than late. It belongs to the strategy: an hour into a
                twelve-hour contract is nothing, ten minutes into a signal is
                everything.
              */}
              <Stack
                label="Still enter if late by"
                error={err('graceMin')}
                className="mt-3"
                hint={`Up to ${c.graceMin} minute${c.graceMin === 1 ? '' : 's'} after ${time12(c.entryTime)} the desk still takes the entry — a restart or a slow feed should not cost the day. After that the day is skipped and you are told.`}
              >
                <div className="flex items-end gap-2">
                  <Affix after="min">
                    <Input
                      aria-label="late entry window"
                      inputMode="numeric"
                      className="pr-10"
                      value={String(c.graceMin)}
                      onChange={(e) => set('graceMin', Math.trunc(num(e.target.value, 0)))}
                    />
                  </Affix>
                  <div className="flex flex-wrap gap-1.5">
                    {([['5m', 5], ['15m', 15], ['1h', 60], ['4h', 240]] as const).map(([label, n]) => (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={c.graceMin === n}
                        className={cn(
                          'h-9 rounded-md border border-solid px-2.5 text-[12px]',
                          c.graceMin === n
                            ? 'border-foreground bg-muted text-foreground'
                            : 'border-border bg-transparent text-muted-foreground',
                        )}
                        onClick={() => set('graceMin', n)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </Stack>
            </>
          )}

          {tab === 'sell' && (
            <>
              <Stack label="Legs">
                <Segmented
                  label="legs"
                  value={c.legs}
                  onChange={(v) => set('legs', v)}
                  options={[
                    { v: 'both', label: 'CE + PE', note: 'Both sides — the tested strategy.' },
                    { v: 'CE', label: 'CE only', note: 'Profits if BTC does not rise much.' },
                    { v: 'PE', label: 'PE only', note: 'Profits if BTC does not fall much.' },
                  ]}
                />
              </Stack>

              <Stack label="How to pick the strike" className="mt-3">
                <Segmented
                  label="strike rule"
                  value={c.strikeRule}
                  onChange={(v) => set('strikeRule', v)}
                  options={[
                    { v: 'premium', label: 'By premium', note: 'Whichever strike pays what you ask — the tested rule.' },
                    { v: 'strict', label: 'By strike', note: 'The strike you name — ATM, OTM 1, ITM 2 — whatever it pays.' },
                    {
                      v: 'oiWall',
                      label: 'By open interest',
                      note: 'The heaviest strike out of the money — the wall. Untested: open interest was measured as a trading rule and did not hold up across 2024, 2025 and 2026.',
                    },
                  ]}
                />
              </Stack>

              {/*
                The wall asks for nothing.
                It is picked from the board at the moment the strategy runs --
                whatever spot is then, whichever strike carries the most open
                interest out from it -- so there is no strike to name and no
                premium to ask for. The form showed the strike stepper here,
                because it was written as premium-or-strict and the wall fell
                into the second branch.
              */}
              {c.strikeRule === 'oiWall' && (
                <div className="mt-3">
                  <p className="m-0 text-[11.5px] leading-snug text-muted-foreground">
                    Picked when the strategy runs, from wherever BTC is then: the call leg
                    takes the heaviest call strike above the price, the put leg the heaviest
                    put strike below it — the same walls the Live screen draws as support and
                    resistance, looked for within the level band set on Settings, and only
                    where the strike still pays at least ${c.premium.usd}. The heaviest open
                    interest on the whole board sits at far strikes that pay nothing; those are
                    levels, not trades, and are never picked.
                  </p>
                  <p className="m-0 mt-2 text-[11.5px] leading-snug text-[var(--warn)]">
                    This one is a claim, not a record: that the strike carrying the most open
                    interest is a better one to sell. The desk shows the walls because traders
                    watch them, and every attempt to <i>trade</i> them failed the cross-period
                    screen. The premium rule is the one with 733 days behind it.
                  </p>
                </div>
              )}

              {c.strikeRule === 'oiWall' ? null : c.strikeRule === 'premium' ? (
                <Stack label="Premium rule" error={err('premium')} className="mt-3">
                  <div className="flex items-stretch gap-2">
                    <Segmented
                      label="premium rule"
                      value={c.premium.mode}
                      onChange={(v) => set('premium', { ...c.premium, mode: v })}
                      className="flex-1"
                      options={[
                        { v: 'atLeast', label: 'At least', note: 'Furthest strike still paying this — more premium, more risk.' },
                        { v: 'atMost', label: 'At most', note: 'Best strike paying up to this — less premium, less risk.' },
                      ]}
                    />
                    <Affix before="$">
                      <Input value={String(c.premium.usd)} aria-label="premium usd" inputMode="decimal" className="w-20 pl-5"
                             onChange={(e) => set('premium', { ...c.premium, usd: num(e.target.value, 0) })} />
                    </Affix>
                  </div>
                </Stack>
              ) : (
                <Stack
                  label="Which strike"
                  error={err('strikeStep')}
                  className="mt-3"
                  hint="counted over the strikes Delta has listed, out from the money"
                >
                  <StrikeStepper value={c.strikeStep} onChange={(v) => set('strikeStep', v)} />
                  {c.strikeStep <= 0 && (
                    <p className="m-0 mt-1.5 text-[11.5px] leading-snug text-[var(--warn)]">
                      {c.strikeStep < 0
                        ? 'In the money — it starts with intrinsic value against it'
                        : 'At the money — the richest premium and the most risk'}
                      {c.probGate !== null && ', and the safety filter will refuse it on almost every day'}.
                    </p>
                  )}
                </Stack>
              )}

              <div className="mt-3 grid grid-cols-2 gap-2">
                <Stack label="Lots per leg" error={err('lots')} hint="1 lot = 0.001 BTC">
                  <Input value={String(c.lots)} aria-label="lots" inputMode="numeric"
                         onChange={(e) => set('lots', Math.floor(num(e.target.value, 0)))} />
                </Stack>
                <div className="rounded-lg bg-muted px-2.5 py-2 text-[11.5px] leading-relaxed">
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Max at once</span>
                    <span className="tabular-nums text-foreground">{sizing.maxContracts}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Margin</span>
                    <span className="tabular-nums text-foreground">{spot ? inr(sizing.marginInr) : '—'}</span>
                  </div>
                  {sizing.shareOfAccount !== null && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground" title="Measured against free margin.">Of free</span>
                      <span className={cn('tabular-nums', sizing.shareOfAccount > 0.5 ? 'text-[var(--down)]' : 'text-foreground')}>
                        {Math.round(sizing.shareOfAccount * 100)}%
                      </span>
                    </div>
                  )}
                </div>
              </div>
              {spot ? <p className="m-0 mt-1 text-right text-[11px] text-[var(--dim)]">{usd(sizing.marginUsd)} at 200x</p> : null}
              <Warnings items={warnings.filter((w) => /margin|account|funded/i.test(w))} />
            </>
          )}

          {tab === 'trade' && (
            <>
              <Stack label="Entry price">
                <Segmented
                  label="entry price"
                  value={c.entryPrice}
                  onChange={(v) => set('entryPrice', v)}
                  options={[
                    { v: 'offer', label: 'Offer', note: 'Rests at the offer — a better price if someone takes it.' },
                    { v: 'now', label: 'Bid now', note: 'Sells at the bid at once — fills, at a lower price.' },
                    { v: 'set', label: 'My price', note: 'Waits at your price until it fills.' },
                  ]}
                />
              </Stack>

              {c.entryPrice === 'set' && (
                <Stack label="Limit price" error={err('entryLimit')} className="mt-3">
                  <Input value={String(c.entryLimit ?? '')} aria-label="entry limit" inputMode="decimal" className="w-32"
                         onChange={(e) => set('entryLimit', num(e.target.value, 0))} />
                </Stack>
              )}
              {c.entryPrice === 'offer' && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Stack label="Bid after" error={err('crossAfterSec')}
                         hint={c.crossAfterSec > 0 ? 'then sells at the bid' : '0 waits until filled'}>
                    <Affix after="sec">
                      <Input value={String(c.crossAfterSec)} aria-label="cross after seconds" inputMode="numeric" className="pr-9"
                             onChange={(e) => set('crossAfterSec', Math.floor(num(e.target.value, 0)))} />
                    </Affix>
                  </Stack>
                  {c.crossAfterSec > 0 && (
                    <Stack label="Max spread" error={err('maxCrossSpreadPct')} hint="wider than this waits at the mid">
                      <Affix after="%">
                        <Input value={String(Math.round((c.maxCrossSpreadPct ?? 0.15) * 100))} aria-label="max spread to sell at bid pct"
                               inputMode="numeric" className="pr-7"
                               onChange={(e) => set('maxCrossSpreadPct', Math.min(100, Math.max(1, num(e.target.value, 15))) / 100)} />
                      </Affix>
                    </Stack>
                  )}
                </div>
              )}

              <div className="mt-3 grid grid-cols-2 gap-2">
                <Stack label="Take profit" error={err('takeProfitPct')} hint={c.takeProfitPct > 0 ? 'of the premium earned' : '0 holds to expiry'}>
                  <Affix after="%">
                    <Input value={String(Math.round(c.takeProfitPct * 100))} aria-label="take profit pct" inputMode="numeric" className="pr-7"
                           onChange={(e) => set('takeProfitPct', num(e.target.value, 0) / 100)} />
                  </Affix>
                </Stack>
                <Stack label="Stop loss" error={err('stopLossPct')} hint={c.stopLossPct > 0 ? 'above the entry price' : '0 means no stop'}>
                  <Affix after="%">
                    <Input value={String(Math.round(c.stopLossPct * 100))} aria-label="stop loss pct" inputMode="numeric" className="pr-7"
                           onChange={(e) => set('stopLossPct', num(e.target.value, 0) / 100)} />
                  </Affix>
                </Stack>
              </div>
              <Warnings items={warnings.filter((w) => /target and no stop/.test(w))} />
            </>
          )}

          {tab === 'extras' && (
            <>
              <Switch
                label="Skip a leg that is not safe enough"
                description={c.probGate !== null ? 'A leg below your safety % is not sold.' : 'Off — both legs are always sold.'}
                checked={c.probGate !== null}
                onCheckedChange={(on) => set('probGate', on ? 0.95 : null)}
              />
              {c.probGate !== null && (
                <Stack label="Safety" error={err('probGate')} hint="chance to expire worthless" className="mb-1 w-40">
                  <Affix after="%">
                    <Input value={String(Math.round(c.probGate * 1000) / 10)} aria-label="prob gate pct" inputMode="decimal" className="pr-7"
                           onChange={(e) => set('probGate', num(e.target.value, 0) / 100)} />
                  </Affix>
                </Stack>
              )}

              {/*
                Two bars read off the same screen the person is looking at: the
                strike's own sell score, and the sudden-move risk. Each does
                nothing until it is switched on, and switching it on is what
                puts the number on the form -- an input for a rule that is not
                running is a setting that looks live and is not.
              */}
              <div className="border-t border-border">
                <Switch
                  label="Skip a strike that scores too low"
                  description={c.minSellScore != null
                    ? `Only sells a strike scoring ${c.minSellScore}/100 or better. Below it the leg is stood down for the day.`
                    : 'Off — whatever the rule picks is sold, whatever it scores.'}
                  checked={c.minSellScore != null}
                  onCheckedChange={(on) => set('minSellScore', on ? 65 : null)}
                />
                {c.minSellScore != null && (
                  <Stack
                    label="Sell score at least"
                    error={err('minSellScore')}
                    hint="the board's own 0-100 score · 80 strong, 65 candidate, 50 watch"
                    className="mb-1 w-44"
                  >
                    <Affix after="/100">
                      <Input
                        value={String(c.minSellScore)} aria-label="minimum sell score"
                        inputMode="numeric" className="pr-12"
                        onChange={(e) => set('minSellScore', Math.trunc(num(e.target.value, 0)))}
                      />
                    </Affix>
                  </Stack>
                )}
              </div>

              <div className="border-t border-border">
                <Switch
                  label="Wait while a sudden move is under way"
                  description={c.maxShockScore != null
                    ? `Enters only while sudden-move risk is ${c.maxShockScore}/100 or less. Above it the desk waits and looks again, until the entry window closes.`
                    : 'Off — it enters at its time whatever the tape is doing.'}
                  checked={c.maxShockScore != null}
                  onCheckedChange={(on) => set('maxShockScore', on ? 25 : null)}
                />
                {c.maxShockScore != null && (
                  <Stack
                    label="Sudden-move risk at most"
                    error={err('maxShockScore')}
                    hint="the live screen's 5-minute reading · 30 watch, 50 high, 70 sudden"
                    className="mb-1 w-44"
                  >
                    <Affix after="/100">
                      <Input
                        value={String(c.maxShockScore)} aria-label="maximum sudden move score"
                        inputMode="numeric" className="pr-12"
                        onChange={(e) => set('maxShockScore', Math.trunc(num(e.target.value, 0)))}
                      />
                    </Affix>
                  </Stack>
                )}
              </div>

              <div className="border-t border-border">
                <Switch
                  label="Double the other leg"
                  description={c.doubleWhenOneSided
                    ? 'If one leg does not go — no strike, a gate, a score, or the desk refusing the order — sell double on the one that does.'
                    : 'Off — the same lots on each leg, and a one-sided day sells half the usual size.'}
                  checked={c.doubleWhenOneSided}
                  onCheckedChange={(on) => set('doubleWhenOneSided', on)}
                />
                <FieldError text={err('doubleWhenOneSided')} />
              </div>

              <div className="border-t border-border">
                <Switch
                  label="Add to the other leg after a target"
                  description={c.addToOpposite
                    ? 'CE target buys back 425 → sell 425 more PE, while the PE still pays enough.'
                    : 'Off — a target closes its leg and nothing else happens.'}
                  checked={Boolean(c.addToOpposite)}
                  onCheckedChange={(on) => set('addToOpposite', on
                    ? (c.addToOpposite ?? { ...DEFAULT_ADD_TO_OPPOSITE, addUntil: defaultAddUntil(c.exitTime) })
                    : null)}
                />
                <FieldError text={err('add')} />
              </div>

              {c.addToOpposite && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <Stack label="Min bid" error={err('addMinPrice')} hint="only adds at or above; never sells below">
                      <Affix before="$">
                        <Input value={String(c.addToOpposite.minPriceUsd)} aria-label="add minimum price" inputMode="decimal" className="pl-5"
                               onChange={(e) => setAdd({ minPriceUsd: num(e.target.value, 0) })} />
                      </Affix>
                    </Stack>
                    <Stack label="Max rise" error={err('addMultiple')} hint="not once it is this × its first sale">
                      <Affix after="×">
                        <Input value={String(c.addToOpposite.maxMultiple)} aria-label="add maximum multiple" inputMode="decimal" className="pr-7"
                               onChange={(e) => setAdd({ maxMultiple: num(e.target.value, 0) })} />
                      </Affix>
                    </Stack>
                  </div>

                  <Stack label="Latest time to add" error={err('addUntil')} className="mt-2"
                         hint={`between ${time12(c.entryTime)} and ${time12(c.exitTime)}`}>
                    <TimePicker
                      label="Latest time to add"
                      value={c.addToOpposite.addUntil}
                      onChange={(v) => setAdd({ addUntil: v })}
                      min={entryPlusOne}
                      max={exitMinusOne}
                      invalid={Boolean(err('addUntil'))}
                      presets={isHhmm(c.exitTime) ? [{ label: '30 min before exit', value: defaultAddUntil(c.exitTime) }] : []}
                      className="w-full"
                    />
                  </Stack>
                  {err('addUntil') && isHhmm(c.exitTime) && (
                    <QuickFix onClick={() => setAdd({ addUntil: defaultAddUntil(c.exitTime) })}>
                      Use {time12(defaultAddUntil(c.exitTime))} (30 min before exit)
                    </QuickFix>
                  )}

                  {/*
                    The add rests at the other leg's offer with nobody watching
                    it at 11 in the morning, so it carries the same control the
                    order ticket and the add-lots sheet do -- its own seconds,
                    not the morning entry's. Blank keeps the entry's, which is
                    what every strategy saved before this did.
                  */}
                  <Stack
                    label="If not filled, sell at bid after"
                    error={err('addCrossAfterSec')}
                    className="mt-2"
                    hint={addCross === null
                      ? `blank — the entry's ${c.crossAfterSec} sec`
                      : addCross === 0 ? 'rests at the offer; the add window still ends it' : 'then sells at the bid, never under the min bid'}
                  >
                    <Affix after="sec">
                      <Input
                        value={addCross === null ? '' : String(addCross)}
                        aria-label="add cross after seconds"
                        inputMode="numeric"
                        placeholder={String(c.crossAfterSec)}
                        className="pr-9"
                        onChange={(e) => setAdd({
                          crossAfterSec: e.target.value.trim() === '' ? null : Math.floor(num(e.target.value, 0)),
                        })}
                      />
                    </Affix>
                  </Stack>

                  <details className="mt-2 rounded-lg bg-muted px-2.5 py-2 text-[11.5px] leading-relaxed">
                    <summary className="cursor-pointer text-muted-foreground">Try it on prices</summary>
                    <div aria-label="add examples" className="mt-1">
                      <p className="m-0 mb-1 text-muted-foreground">CE target buys back 425; PE was sold at $15. PE bid now:</p>
                      {addExamples(c.addToOpposite).map((x) => (
                        <div key={x.bid} className="flex justify-between gap-3">
                          <span className="tabular-nums text-foreground">${x.bid.toFixed(2)}</span>
                          <span className={x.adds ? 'text-[var(--up)]' : 'text-[var(--dim)]'}>
                            {x.adds ? `adds — ${x.why}` : `no — ${x.why}`}
                          </span>
                        </div>
                      ))}
                      <p className="m-0 mt-1 text-[var(--dim)]">
                        Added to the PE itself: its own target and stop cover all of it. Not on a one-sided day,
                        not after {time12(c.addToOpposite.addUntil)}, and never twice for the same contracts.
                      </p>
                    </div>
                  </details>
                </>
              )}

              {/*
                Dynamic one-sided rebalance.
                Buy back part of the side that fell, sell the same number again
                on the side that rose, stage by stage. Every number is typed
                here -- the stages are "…n", and the table under them shows
                exactly what each one would mean in money and in lots.
              */}
              <div className="mt-4 border-t border-border pt-3">
                <Switch
                  label="Rebalance one side into the other"
                  description={c.rebalance?.enabled
                    ? `When one side rises ${c.rebalance.upStartPct}% and the other falls ${c.rebalance.downStartPct}%, buy back ${c.rebalance.lotsPerStep} lots of the fallen side and sell ${c.rebalance.lotsPerStep} more of the risen one.`
                    : 'Off — both sides are left as they were sold.'}
                  checked={Boolean(c.rebalance?.enabled)}
                  onCheckedChange={(on) => set('rebalance', on
                    ? (() => {
                        const rule = { ...(c.rebalance ?? rebalanceDefaults), enabled: true };
                        /*
                          A cap under the lots the strategy opens with blocks
                          every stage before it starts -- the desk's default cap
                          is 200 and this strategy sells 700 a side. Start it at
                          the most the rule can actually reach, which the person
                          can then lower on purpose rather than by accident.
                        */
                        const reach = mostOneSideCanReach(rule, c.lots);
                        return rule.maxLotsPerSide !== null && (rule.capAuto || rule.maxLotsPerSide < reach)
                          ? { ...rule, maxLotsPerSide: reach }
                          : rule;
                      })()
                    : (c.rebalance ? { ...c.rebalance, enabled: false } : null))}
                />
                <FieldError text={err('rebalance')} />
              </div>

              {c.rebalance?.enabled && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <Stack label="Lots each stage" error={err('rebalanceLots')} hint="bought back, and sold again">
                      <Input value={String(c.rebalance.lotsPerStep)} aria-label="rebalance lots per stage" inputMode="numeric"
                             onChange={(e) => setReb({ lotsPerStep: Math.floor(num(e.target.value, 0)) })} />
                    </Stack>
                    <Stack label="Stages" error={err('rebalanceSteps')} hint={`up to ${rebalanceLimits.maxSteps}`}>
                      <Input value={String(c.rebalance.steps)} aria-label="rebalance stages" inputMode="numeric"
                             onChange={(e) => setReb({ steps: Math.floor(num(e.target.value, 0)) })} />
                    </Stack>
                  </div>

                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <Stack label="Up move" error={err('rebalanceUp')} hint="stage 1">
                      <Affix after="%">
                        <Input value={String(c.rebalance.upStartPct)} aria-label="rebalance up start percent" inputMode="numeric" className="pr-7"
                               onChange={(e) => setReb({ upStartPct: Math.floor(num(e.target.value, 0)) })} />
                      </Affix>
                    </Stack>
                    <Stack label="Down move" error={err('rebalanceDown')} hint="stage 1">
                      <Affix after="%">
                        <Input value={String(c.rebalance.downStartPct)} aria-label="rebalance down start percent" inputMode="numeric" className="pr-7"
                               onChange={(e) => setReb({ downStartPct: Math.floor(num(e.target.value, 0)) })} />
                      </Affix>
                    </Stack>
                    <Stack label="Step" error={err('rebalanceIncrement')} hint="added each stage">
                      <Affix after="%">
                        <Input value={String(c.rebalance.incrementPct)} aria-label="rebalance increment percent" inputMode="numeric" className="pr-7"
                               onChange={(e) => setReb({ incrementPct: Math.floor(num(e.target.value, 0)) })} />
                      </Affix>
                    </Stack>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <Stack label="Confirm readings" error={err('rebalanceConfirm')} hint="a single print is a quote, not a move">
                      <Input value={String(c.rebalance.confirmTicks)} aria-label="rebalance confirm ticks" inputMode="numeric"
                             onChange={(e) => setReb({ confirmTicks: Math.floor(num(e.target.value, 1)) })} />
                    </Stack>
                    {/*
                      The cap works itself out from the lots, the step and the
                      stages, and follows them while it is on: a desk default of
                      200 on a strategy selling 700 a side refused every stage
                      before it began. Typed by hand it stays where it is put,
                      and the line under it says which stages that blocks.
                    */}
                    <Stack
                      label="Cap each side"
                      error={err('rebalanceCap')}
                      hint={c.rebalance.capAuto
                        ? `worked out: ${autoCap} lots, the most this rule reaches`
                        : c.rebalance.maxLotsPerSide === null
                          ? 'no cap: a side grows as far as the stages take it'
                          : `set by hand — this rule reaches ${autoCap}`}
                    >
                      <div className="flex items-center gap-1.5">
                        <Input
                          value={c.rebalance.capAuto
                            ? String(autoCap)
                            : c.rebalance.maxLotsPerSide === null ? '' : String(c.rebalance.maxLotsPerSide)}
                          aria-label="rebalance cap per side"
                          inputMode="numeric"
                          placeholder="none"
                          disabled={c.rebalance.capAuto}
                          className={c.rebalance.capAuto ? 'opacity-70' : undefined}
                          onChange={(e) => setReb({
                            maxLotsPerSide: e.target.value.trim() === '' ? null : Math.floor(num(e.target.value, 0)),
                          })}
                        />
                        <button
                          type="button"
                          aria-label={c.rebalance.capAuto ? 'set the cap by hand' : 'work the cap out again'}
                          className="h-9 flex-none cursor-pointer rounded-md border border-solid border-border bg-transparent px-2 font-[inherit] text-[11px] text-muted-foreground"
                          onClick={() => setReb(c.rebalance!.capAuto
                            ? { capAuto: false, maxLotsPerSide: autoCap }
                            : { capAuto: true, maxLotsPerSide: autoCap })}
                        >
                          {c.rebalance.capAuto ? 'Auto' : 'Edit'}
                        </button>
                      </div>
                    </Stack>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {/*
                      The sell rests at the risen side's offer and the buy-back
                      has already happened, so a sell nobody is watching leaves
                      the stage half done. Blank keeps the strategy's entry
                      seconds, which is what a rule saved before this used.
                    */}
                    <Stack
                      label="If not filled, sell at bid after"
                      error={err('rebalanceCross')}
                      hint={rebCross === null
                        ? `blank — the entry's ${c.crossAfterSec} sec`
                        : rebCross === 0 ? 'rests at the offer; the window ends it' : 'then sells at the bid'}
                    >
                      <Affix after="sec">
                        <Input
                          value={rebCross === null ? '' : String(rebCross)}
                          aria-label="rebalance cross after seconds"
                          inputMode="numeric"
                          placeholder={String(c.crossAfterSec)}
                          className="pr-9"
                          onChange={(e) => setReb({
                            crossAfterSec: e.target.value.trim() === '' ? null : Math.floor(num(e.target.value, 0)),
                          })}
                        />
                      </Affix>
                    </Stack>
                    <Stack label="Widest spread to cross" error={err('rebalanceSpread')}
                           hint="wider than this waits rather than crossing">
                      <Affix after="%">
                        <Input
                          value={c.rebalance.maxSpreadPct === null ? '' : String(Math.round(c.rebalance.maxSpreadPct * 100))}
                          aria-label="rebalance max spread percent"
                          inputMode="numeric"
                          placeholder="none"
                          className="pr-7"
                          onChange={(e) => setReb({
                            maxSpreadPct: e.target.value.trim() === ''
                              ? null
                              : Math.min(100, Math.max(1, num(e.target.value, 15))) / 100,
                          })}
                        />
                      </Affix>
                    </Stack>
                  </div>

                  <Stack label="Rebalance until" error={err('rebalanceEnd')} className="mt-2"
                         hint={`between ${time12(c.entryTime)} and ${time12(c.exitTime)}; the exit still runs after it`}>
                    <TimePicker
                      label="Rebalance until"
                      value={c.rebalance.endTime}
                      onChange={(v) => setReb({ endTime: v })}
                      min={entryPlusOne}
                      max={exitMinusOne}
                      invalid={Boolean(err('rebalanceEnd'))}
                      className="w-full"
                    />
                  </Stack>

                  <label className="mt-2 flex items-center gap-2 text-[12px] text-muted-foreground">
                    <input
                      type="checkbox"
                      aria-label="keep the first stage's direction"
                      checked={c.rebalance.lockDirection}
                      onChange={(e) => setReb({ lockDirection: e.target.checked })}
                    />
                    Keep the first stage’s direction — a later stage that wants the other side is refused
                  </label>
                  <label className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground">
                    <input
                      type="checkbox"
                      aria-label="use what is left on the last stage"
                      checked={c.rebalance.allowPartial}
                      onChange={(e) => setReb({ allowPartial: e.target.checked })}
                    />
                    On the last stage, use whatever lots are left rather than nothing
                  </label>

                  {/* Exactly what each stage means, in percent, in money and in lots. */}
                  <div className="mt-3 rounded-lg bg-muted px-2.5 py-2" aria-label="rebalance stage table">
                    <div className="mb-1 flex items-baseline justify-between text-[11px] text-muted-foreground">
                      <span>Stages, from a sale at ${c.premium.usd}</span>
                      <span>{c.lots} + {c.lots} lots to start</span>
                    </div>
                    {capBlock && (
                      <p className="m-0 mb-1.5 text-[11.5px] leading-snug text-[var(--warn)]" role="status">
                        {capBlock}
                      </p>
                    )}
                    <table className="w-full text-[11.5px] tabular-nums">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-wide text-[var(--dim)]">
                          <th className="py-0.5 text-left font-normal">Stage</th>
                          <th className="py-0.5 text-right font-normal">Up side</th>
                          <th className="py-0.5 text-right font-normal">Down side</th>
                          <th className="py-0.5 text-right font-normal">After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stageThresholds(c.rebalance, c.premium.usd).map((t, i) => {
                          const after = stagePositions(c.rebalance!, c.lots)[i]!;
                          return (
                            <tr key={t.stage} className="border-t border-[#ffffff08]">
                              <td className="py-1 text-left text-foreground">{t.stage}</td>
                              <td className="py-1 text-right text-[var(--up)]">
                                +{t.upPct}% <span className="text-[var(--dim)]">${t.upPrice?.toFixed(2)}</span>
                              </td>
                              <td className="py-1 text-right text-[var(--down)]">
                                −{t.downPct}% <span className="text-[var(--dim)]">${t.downPrice?.toFixed(2)}</span>
                              </td>
                              <td className={cn('py-1 text-right', after.blocked ? 'text-[var(--warn)]' : 'text-muted-foreground')}>
                                {after.up} / {after.down}
                                {after.blocked && <span className="ml-1 text-[10px]">capped</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <p className="m-0 mt-1.5 text-[11px] leading-snug text-[var(--dim)]">
                      Each stage buys back the fallen side and sells the same number again on the risen one, so the
                      position gets more one-sided as it goes. Both conditions must hold in the same reading,
                      {' '}{c.rebalance.confirmTicks} times in a row, and each stage happens once.
                      {c.rebalance.maxLotsPerSide !== null && !capBlock && (
                        <> The cap stops it: neither side passes {c.rebalance.maxLotsPerSide} lots, whatever the premiums do.</>
                      )}
                    </p>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <SheetFooter className="flex-col gap-2">
          {refused.map((p) => (
            <p key={p} className="m-0 text-[11.5px] leading-snug text-[var(--down)]">{p}</p>
          ))}
          {(tabProblems.length > 0 || (nameTouched && nameProblem)) && (
            <LeftToFix
              problems={tabProblems}
              needsName={nameTouched && Boolean(nameProblem)}
              onName={() => nameInput.current?.focus()}
              onGo={setTab}
            />
          )}
          <div className="flex gap-2">
            <Button variant="outline" className="h-11 flex-none px-4" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button className="h-11 flex-1" disabled={busy} onClick={() => void save()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {shownCount ? `Fix ${shownCount} to save` : 'Save'}
            </Button>
          </div>
          {!editing && problems.length === 0 && (
            <p className="m-0 text-center text-[11px] text-[var(--dim)]">Saved switched off. Turn it on from the list.</p>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/**
 * ATM, OTM 1..n, ITM 1..n — one strike at a time, with the name read back.
 *
 * A stepper rather than a number box: the useful range is small, the sign
 * carries the meaning, and "-2" typed into a box is not something anybody
 * should have to translate into "two strikes in the money".
 */
function StrikeStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const go = (by: number) => onChange(Math.max(-MAX_STRIKE_STEP, Math.min(MAX_STRIKE_STEP, value + by)));
  const btn = 'm-0 h-11 w-12 flex-none appearance-none rounded-md border border-solid border-border bg-muted '
    + 'font-[inherit] text-[18px] text-foreground disabled:opacity-35';
  return (
    <div className="flex items-center gap-2">
      <button type="button" aria-label="one strike nearer the money" className={btn}
              disabled={value <= -MAX_STRIKE_STEP} onClick={() => go(-1)}>−</button>
      <div
        role="status"
        aria-label="which strike"
        className="flex h-11 flex-1 items-center justify-center rounded-md border border-solid border-border bg-muted text-[15px] font-semibold text-foreground"
      >
        {strikeLabel(value)}
      </div>
      <button type="button" aria-label="one strike further out" className={btn}
              disabled={value >= MAX_STRIKE_STEP} onClick={() => go(1)}>+</button>
    </div>
  );
}

/** A label over its control, with the control's problem under it. */
function Stack({ label, hint, error, className, children }: {
  label: string; hint?: string; error?: string | null; className?: string; children: React.ReactNode;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="mb-1 truncate text-[12px] text-muted-foreground">{label}</div>
      {children}
      {/* under the field, where it can wrap -- beside a label on a phone it was cut off */}
      {hint && !error && <div className="mt-0.5 text-[10.5px] leading-snug text-[var(--dim)]">{hint}</div>}
      <FieldError text={error ?? null} />
    </div>
  );
}

function FieldError({ text }: { text: string | null }) {
  if (!text) return null;
  return <p role="alert" className="m-0 mt-1 text-[11.5px] leading-snug text-[var(--down)]">{text}</p>;
}

function Warnings({ items }: { items: string[] }) {
  return (
    <>
      {items.map((w) => <p key={w} className="m-0 mt-2 text-[11.5px] leading-snug text-[var(--warn)]">{w}</p>)}
    </>
  );
}

function QuickFix({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
            className="m-0 mt-1 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] underline underline-offset-2">
      {children}
    </button>
  );
}

/** A unit inside the field, so "$" and "%" do not need a row of their own. */
function Affix({ before, after, children }: { before?: string; after?: string; children: React.ReactNode }) {
  return (
    <div className="relative h-9 self-start">
      {before && <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">{before}</span>}
      {children}
      {after && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">{after}</span>}
    </div>
  );
}

/** Two or three choices on one line; only the chosen one's sentence is shown. */
function Segmented<T extends string>({ label, value, options, onChange, className }: {
  label: string;
  value: T;
  options: { v: T; label: string; note: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  const chosen = options.find((o) => o.v === value);
  return (
    <div className={cn('min-w-0', className)}>
      <div role="radiogroup" aria-label={label} className="flex gap-0.5 rounded-lg bg-muted p-0.5">
        {options.map((o) => (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={value === o.v}
            onClick={() => onChange(o.v)}
            className={cn(
              'm-0 h-9 flex-1 appearance-none whitespace-nowrap rounded-md border-0 px-2 font-[inherit] text-[12.5px] font-medium',
              value === o.v ? 'bg-background text-foreground shadow-sm' : 'bg-transparent text-muted-foreground',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {chosen && <p className="m-0 mt-1 text-[11.5px] leading-snug text-muted-foreground">{chosen.note}</p>}
    </div>
  );
}

/** What stops the save, and a way to each thing: the name box, and each tab with a problem. */
function LeftToFix({ problems, needsName, onName, onGo }: {
  problems: Problem[]; needsName: boolean; onName: () => void; onGo: (t: FormTab) => void;
}) {
  const tabs = TABS.filter((t) => problems.some((p) => p.tab === t.id));
  const count = problems.length + (needsName ? 1 : 0);
  const link = 'm-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--down)] underline underline-offset-2';
  return (
    <p className="m-0 text-[12px] leading-snug text-[var(--down)]" aria-live="polite">
      {count === 1 ? '1 thing to fix' : `${count} things to fix`}:{' '}
      {needsName && (
        <button type="button" onClick={onName} className={link}>Name</button>
      )}
      {needsName && tabs.length > 0 && ', '}
      {tabs.map((t, i) => (
        <span key={t.id}>
          {i > 0 && ', '}
          <button type="button" onClick={() => onGo(t.id)} className={link}>
            {t.label}
          </button>
        </span>
      ))}
    </p>
  );
}
