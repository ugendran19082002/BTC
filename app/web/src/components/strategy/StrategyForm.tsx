import { useMemo, useRef, useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { saveStrategy } from '@/api/strategy';
import {
  DAY_NAMES, DEFAULT_CONFIG, MAX_STRIKE_STEP, strikeLabel, type Strategy, type StrategyConfig,
} from '@/types/strategy';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { TimePicker } from '@/components/ui/time-picker';
import { describeStrategy, sizingOf } from '@/lib/strategy-preview';
import { exitRules, suggestedFallback, withExitRule } from '@/lib/strategy-exits';
import { nameWarning, stepWarnings } from '@/lib/strategy-checks';
import { ExitRuleEditor } from '@/components/strategy/ExitRuleEditor';
import { NumberField } from '@/components/ui/number-field';
import { problemFor, strategyProblems, type FormField, type FormTab, type Problem } from '@/lib/strategy-rules';
import { SETTLEMENT, hhmmOf, isHhmm, minutesOf, spanLabel, time12, wrapsMidnight } from '@/lib/time';
import { inr, usd } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Everything a strategy is, in words rather than symbols -- in three short tabs.
 *
 * It used to be one column of every setting, each choice a pair of tall cards
 * with a sentence on each, and on a phone that was a long scroll to reach Save
 * past settings that had nothing to do with the one being changed. Now:
 *
 *   When     entry and exit on a clock, and the days
 *   Sell     which legs, which strike, how many lots, and what that ties up
 *   Trade    how the entry is priced and where it exits
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
  const problems = useMemo(() => strategyProblems(c, name), [c, name]);
  const exits = useMemo(() => exitRules(c), [c]);
  /*
   * The entry the exits are shown against, before there is one. Your own price
   * when the entry is set; otherwise the premium rule's number -- where the
   * offer or the bid will be, near enough -- and nothing for a rule that picks
   * the strike by position, whose price is not known until it runs.
   */
  const reference = useMemo((): { price: number | null; label: string } => {
    if (c.entryPrice === 'set' && (c.entryLimit ?? 0) > 0) return { price: c.entryLimit!, label: 'your price' };
    if (c.strikeRule === 'premium' && c.premium.usd > 0) return { price: c.premium.usd, label: c.entryPrice === 'now' ? 'bid ≈' : 'offer ≈' };
    return { price: null, label: '' };
  }, [c.entryPrice, c.entryLimit, c.strikeRule, c.premium.usd]);
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
  // "No days" is a problem now, said under its own field.
  const warnings = sizing.warnings.filter((w) => !/No days/.test(w));

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
        <Warnings items={[nameWarning(name, c.legs)].filter((w): w is string => w !== null)} />

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
              {/*
                What the stop and the target are watched on.
                A wick through a level is not a break, and a thin option's mark
                can print a price nothing traded at -- so a stop on the touch
                exits on noise a close would have ridden out. The other way
                round, waiting for the close gives back the distance between
                the wick and the close when the move is real. Both are right
                sometimes, which is why it is a choice and not a default.
              */}
              <div className="mt-3">
                <div className="mb-1 truncate text-[12px] text-muted-foreground">Trade monitoring</div>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    ['ltp', 'On LTP', '⚡', 'Acts the moment the mark reaches the level — fastest exit, but exits on wicks too.'],
                    ['close', 'On candle close', '🕯', 'Acts only when a bar closes through the level — rides out wicks, gives back a little on the real move.'],
                  ] as const).map(([value, label, icon, desc]) => {
                    const active = (c.monitorOn ?? 'ltp') === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => set('monitorOn', value)}
                        className={cn(
                          'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors duration-150',
                          active
                            ? 'border-[hsl(var(--primary))] bg-muted/50'
                            : 'border-border bg-muted/20 opacity-60 hover:opacity-80',
                        )}
                      >
                        <span className="mt-0.5 text-sm flex-none">{icon}</span>
                        <span className="min-w-0">
                          <span className="block text-[12.5px] font-medium leading-tight text-foreground">
                            {label}
                          </span>
                          <span className="mt-0.5 block text-[10.5px] leading-snug text-muted-foreground">
                            {desc}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

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
              <Warnings items={[nameWarning(name, c.legs)].filter((w): w is string => w !== null)} />

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
              ) : null}

              {/*
                A second number on the same rule, tried only when the first finds
                no strike: "at most $20 -- and if nothing is at or under $20, the
                last strike at or under $50". Off until it is switched on.
              */}
              {c.strikeRule === 'oiWall' ? null : c.strikeRule === 'premium' ? (
                <div className="mt-2">
                  <Switch
                    label={c.premium.mode === 'atMost' ? 'If nothing is at or below it, try a higher cap' : 'If nothing pays it, try a lower floor'}
                    description={c.premium.fallbackUsd != null
                      ? (c.premium.mode === 'atMost'
                        ? `No strike at or below $${c.premium.usd}? Sells the last strike at or below $${c.premium.fallbackUsd}.`
                        : `No strike paying $${c.premium.usd}? Sells the furthest still paying $${c.premium.fallbackUsd}.`)
                      : 'Off — no strike means that leg is not sold today.'}
                    checked={c.premium.fallbackUsd != null}
                    onCheckedChange={(on) => set('premium', { ...c.premium, fallbackUsd: on ? suggestedFallback(c.premium) : null })}
                  />
                  {c.premium.fallbackUsd != null && (
                    <Stack label={c.premium.mode === 'atMost' ? 'Fallback cap' : 'Fallback floor'} error={err('premiumFallback')} className="mt-1 w-40"
                           hint={c.premium.mode === 'atMost' ? `above $${c.premium.usd}` : `below $${c.premium.usd}`}>
                      <NumberField label="premium fallback usd" unitBefore="$" value={c.premium.fallbackUsd}
                                   onChange={(n) => set('premium', { ...c.premium, fallbackUsd: n })} />
                    </Stack>
                  )}
                  {err('premiumFallback') && (
                    <QuickFix onClick={() => set('premium', { ...c.premium, fallbackUsd: suggestedFallback(c.premium) })}>
                      Use ${suggestedFallback(c.premium)}
                    </QuickFix>
                  )}
                </div>
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
                      .
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

              {/*
                The two exits, typed rather than dragged, each as a percentage or
                fixed points, and each able to move on a timetable between the
                entry and the exit. Shown against the premium the rule asks for,
                so "80%" reads as the price it is.
              */}
              <div className="mt-3 flex flex-col gap-2">
                {(['target', 'stop'] as const).map((leg) => (
                  <ExitRuleEditor
                    key={leg}
                    leg={leg}
                    rule={exits[leg]}
                    onChange={(r) => setC((p) => withExitRule(p, leg, r))}
                    onMode={(mode) => setC((p) => (leg === 'target'
                      ? { ...p, targetMode: mode, targetSteps: [] }
                      : { ...p, stopMode: mode, stopSteps: [] }))}
                    entryTime={c.entryTime}
                    exitTime={c.exitTime}
                    samplePrice={reference.price}
                    sampleLabel={reference.label}
                    error={err(leg === 'target' ? 'takeProfitPct' : 'stopLossPct')}
                  />
                ))}
              </div>
              <Warnings items={warnings.filter((w) => /target and no stop/.test(w))} />
              <Warnings items={[...stepWarnings(c, 'target'), ...stepWarnings(c, 'stop')]} />
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
