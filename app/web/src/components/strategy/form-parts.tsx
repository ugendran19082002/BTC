import { useState, type RefObject } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  DAY_NAMES, DEFAULT_DELTA, DEFAULT_DISTANCE, DEFAULT_FIXED_DISTANCE_PCT, DEFAULT_MIN_OTM, DELTA_PRESETS, MAX_STRIKE_STEP, PREMIUM_MODE_LABEL,
  distanceNeeded, strikeLabel, type DeltaRule, type DistanceRule, type PremiumRule, type StrategyConfig,
} from '@/types/strategy';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { TimePicker } from '@/components/ui/time-picker';
import { NumberField } from '@/components/ui/number-field';
import { ExitRuleEditor } from '@/components/strategy/ExitRuleEditor';
import { suggestedFallback, withExitRule, type ExitRule } from '@/lib/strategy-exits';
import { stepWarnings } from '@/lib/strategy-checks';
import { STRATEGY_LEVERAGE, heldStopFor, stopHoldNote } from '@/lib/stop-hold';
import { strategyProblems, type FormField, type FormTab, type Problem } from '@/lib/strategy-rules';
import type { Sizing } from '@/lib/strategy-preview';
import { SETTLEMENT, hhmmOf, isHhmm, minutesOf, spanLabel, wrapsMidnight } from '@/lib/time';
import { inr, usd } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The strategy forms' parts: every field group a strategy has, written once.
 *
 * The clock strategy's form (StrategyForm) and the signal strategy's
 * (SignalStrategyForm) differ in which of these they show and in what order --
 * not in how a strike rule, an entry price or an exit is set. One copy of each,
 * so a fix to how a premium rule reads lands on both screens at once.
 */

export type SetField = <K extends keyof StrategyConfig>(k: K, v: StrategyConfig[K]) => void;
export type ErrOf = (f: FormField) => string | null;
export type TabDef = { id: FormTab; label: string };

export const num = (v: string, fallback: number) => {
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) ? n : fallback;
};

export const WEEKDAYS = [1, 2, 3, 4, 5];
export const WEEKEND = [0, 6];
export const LAST_MINUTE = hhmmOf(minutesOf(SETTLEMENT) - 1);

// ------------------------------------------------------------------ the frame

/** The name box, its problem once it has been touched, and anything else worth saying under it. */
export function NameField({ value, onChange, touched, onTouched, problem, inputRef, placeholder, warnings = [] }: {
  value: string; onChange: (v: string) => void; touched: boolean; onTouched: () => void; problem: string | null;
  inputRef: RefObject<HTMLInputElement>; placeholder: string; warnings?: string[];
}) {
  return (
    <>
      <label className="block">
        <span className="sr-only">Name</span>
        <Input ref={inputRef} value={value} aria-label="strategy name" placeholder={placeholder}
               aria-invalid={(touched && Boolean(problem)) || undefined}
               className={cn(touched && problem && 'border-[var(--down)]')}
               onBlur={onTouched}
               onChange={(e) => { onChange(e.target.value); onTouched(); }} />
      </label>
      <FieldError text={touched ? problem : null} />
      <Warnings items={warnings} />
    </>
  );
}

/**
 * The rule read back as a sentence: how a wrong setting gets noticed before it
 * is saved. Two lines unless asked for more, so it does not push the settings
 * off a phone screen.
 */
export function RuleSentence({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setAll((v) => !v)}
      aria-expanded={all}
      className="m-0 mt-2 flex w-full appearance-none items-start gap-1.5 rounded-lg border-0 bg-muted px-2.5 py-2 text-left font-[inherit]"
    >
      <span className={cn('min-w-0 flex-1 text-[12px] leading-relaxed text-foreground', !all && 'line-clamp-2')}>{text}</span>
      <ChevronDown className={cn('mt-0.5 h-3.5 w-3.5 flex-none text-muted-foreground transition-transform', all && 'rotate-180')} />
    </button>
  );
}

/** The tabs, in reach while a tab scrolls; a red dot on each with a problem; arrow keys move between them. */
export function FormTabBar({ tabs, tab, onTab, hasProblem }: {
  tabs: TabDef[]; tab: FormTab; onTab: (t: FormTab) => void; hasProblem: (t: FormTab) => boolean;
}) {
  return (
    <div
      role="tablist"
      aria-label="strategy settings"
      className="sticky top-0 z-10 -mx-4 mt-2 flex gap-1 border-b border-border bg-background px-4 pb-2 pt-1"
      onKeyDown={(e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const i = tabs.findIndex((t) => t.id === tab);
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
        onTab(next.id);
        document.getElementById(`tab-${next.id}`)?.focus();
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          id={`tab-${t.id}`}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={tab === t.id ? 0 : -1}
          onClick={() => onTab(t.id)}
          className={cn(
            'relative m-0 h-9 flex-1 appearance-none whitespace-nowrap rounded-md border-0 px-1 font-[inherit] text-[12.5px] font-medium',
            tab === t.id ? 'bg-muted text-foreground' : 'bg-transparent text-muted-foreground',
          )}
        >
          {t.label}
          {hasProblem(t.id) && (
            <span aria-label="has a problem" className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[var(--down)]" />
          )}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ when

/**
 * The two times. For a clock strategy, the entry and the exit; for a signal
 * strategy, the window it takes signals in -- `labels` says which.
 */
export function TimeWindowFields({ c, set, err, name, labels }: {
  c: StrategyConfig; set: SetField; err: ErrOf; name: string;
  labels: { from: string; until: string; fromPicker: string; untilPicker: string };
}) {
  const entryPlusOne = isHhmm(c.entryTime) ? hhmmOf(minutesOf(c.entryTime) + 1) : null;
  const daytime = isHhmm(c.entryTime) && minutesOf(c.entryTime) < minutesOf(SETTLEMENT);
  // An exit earlier on the clock than the entry: 11:30 PM to 5:30 AM.
  const overnight = wrapsMidnight(c.entryTime, c.exitTime);
  // Offered whenever 5:29 PM would actually settle the objection, rather than
  // only on a daytime entry -- an overnight window can be fixed by it too.
  const lastMinuteFixes = Boolean(err('exitTime'))
    && !strategyProblems({ ...c, exitTime: LAST_MINUTE }, name).some((p) => p.field === 'exitTime');
  return (
    <>
      {/* items-end: a label that wraps to two lines keeps both pickers on one line. */}
      <div className="grid grid-cols-2 items-end gap-2">
        <Stack label={labels.from} error={err('entryTime')}>
          <TimePicker
            label={labels.fromPicker}
            value={c.entryTime}
            onChange={(v) => set('entryTime', v)}
            invalid={Boolean(err('entryTime'))}
            presets={[{ label: '5:30 AM · contract opens', value: '05:30' }]}
            className="w-full"
          />
        </Stack>
        <Stack label={labels.until} error={err('exitTime')}>
          <TimePicker
            label={labels.untilPicker}
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
    </>
  );
}

/**
 * The days. Which day a tick means is not obvious once a strategy runs past
 * midnight: a Saturday 11:30 PM entry finishes on Sunday, and the Sunday box
 * has nothing to do with it. Said which end is meant.
 */
export function DaysField({ c, set, err }: { c: StrategyConfig; set: SetField; err: ErrOf }) {
  const overnight = wrapsMidnight(c.entryTime, c.exitTime);
  const toggle = (d: number) =>
    set('weekdays', c.weekdays.includes(d) ? c.weekdays.filter((x) => x !== d) : [...c.weekdays, d].sort());
  return (
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
              onClick={() => toggle(i)}
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
  );
}

// ------------------------------------------------------------------ the strike and the size

/**
 * How the strike is picked: by premium (at least / at most, with a fallback),
 * by strike (ATM ± n), by delta, by distance from BTC, and -- where offered --
 * at the open-interest wall; then the strategy's own premium floor.
 */
export function StrikeFields({ c, set, err, allowOiWall = true, minPremium = true, spot }: {
  c: StrategyConfig; set: SetField; err: ErrOf; allowOiWall?: boolean;
  /** False where the form places the minimum premium itself, further down (`MinPremiumField`). */
  minPremium?: boolean;
  /** BTC now, where the form has it: a distance is then said in points as well as percent. */
  spot?: number | null;
}) {
  return (
    <>
      <Stack label="How to pick the strike" className="mt-3">
        <Segmented
          label="strike rule"
          value={c.strikeRule}
          wrap
          onChange={(v) => {
            set('strikeRule', v);
            // A rule switched to for the first time starts from the figure that was measured, not from nothing.
            if (v === 'delta' && !c.delta) set('delta', { ...DEFAULT_DELTA });
            if (v === 'distance' && !c.distance) set('distance', { ...DEFAULT_DISTANCE });
          }}
          options={[
            { v: 'premium', label: 'By premium', note: 'Whichever strike pays what you ask — the tested rule.' },
            { v: 'strict', label: 'By strike', note: 'The strike you name — ATM, OTM 1, ITM 2 — whatever it pays.' },
            { v: 'delta', label: 'By delta', note: 'The nearest strike at or under a delta you name — one number that fits every hour of the day.' },
            { v: 'distance', label: 'By distance', note: 'The nearest strike at least this far from BTC — the same all day, or nearer as the contract runs out.' },
            ...(allowOiWall ? [{
              v: 'oiWall' as const,
              label: 'By open interest',
              note: 'The heaviest strike out of the money — the wall. Untested: open interest was measured as a trading rule and did not hold up across 2024, 2025 and 2026.',
            }] : []),
          ]}
        />
      </Stack>

      {/*
        The wall asks for nothing. It is picked from the board at the moment the
        strategy runs, so there is no strike to name and no premium to ask for.
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

      {c.strikeRule === 'premium' && (
        <Stack label="Premium rule" error={err('premium')} className="mt-3">
          {/* The two choices the full width on a phone, the price under them; one row from sm up. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
            <Segmented
              label="premium rule"
              value={c.premium.mode}
              onChange={(v) => set('premium', { ...c.premium, mode: v })}
              className="flex-1"
              options={[
                { v: 'atLeast', label: PREMIUM_MODE_LABEL.atLeast, note: 'Pays this much or more: the furthest strike still paying it — more premium, more risk.' },
                { v: 'atMost', label: PREMIUM_MODE_LABEL.atMost, note: 'Pays this much or less: the best strike under it — less premium, less risk.' },
              ]}
            />
            <Affix before="$">
              <Input value={String(c.premium.usd)} aria-label="premium usd" inputMode="decimal" className="w-20 pl-5"
                     onChange={(e) => set('premium', { ...c.premium, usd: num(e.target.value, 0) })} />
            </Affix>
          </div>
        </Stack>
      )}

      {/*
        A second number on the same rule, tried only when the first finds no
        strike: "at most $20 -- and if nothing is at or under $20, the last
        strike at or under $50". Off until it is switched on.
      */}
      {c.strikeRule === 'premium' && (
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
      )}

      {/*
        A floor on distance, beside the premium (4 Oct 2026). A premium number says
        what a strike pays, not how far it sits: on a rich board "at most $50" can
        land two strikes from the money. On, the premium's pick stands only at
        OTM n or further out; nearer than that, OTM n itself is sold.
      */}
      {c.strikeRule === 'premium' && (
        <MinOtmFields premium={c.premium} onChange={(p) => set('premium', p)} error={err('premiumMinOtm')} />
      )}

      {c.strikeRule === 'strict' && (
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

      {c.strikeRule === 'delta' && (
        <DeltaFields rule={c.delta ?? DEFAULT_DELTA} onChange={(d) => set('delta', d)} error={err('delta')} />
      )}
      {c.strikeRule === 'distance' && (
        <DistanceFields rule={c.distance ?? DEFAULT_DISTANCE} onChange={(d) => set('distance', d)} error={err('distance')} spot={spot} />
      )}

      {minPremium && <MinPremiumField c={c} set={set} err={err} />}
    </>
  );
}

/** What the two newer rules rest on, said where they are set -- the same way the wall says what it rests on. */
function MeasuredNote() {
  return (
    <p className="m-0 mt-1.5 text-[11.5px] leading-snug text-[var(--dim)]">
      Measured on a week of real orders (to 8 Oct 2026) and three months of block entries: against the premium rule this
      lost less, and did not make more. The minimum premium still applies — a strike paying under it is not sold.
    </p>
  );
}

/**
 * A delta rule (8 Oct 2026): one number, with the usual ones a tap away. The strike nearest BTC whose delta is at
 * or under it is sold, read from the live board when the signal arrives.
 */
export function DeltaFields({ rule, onChange, error }: { rule: DeltaRule; onChange: (d: DeltaRule) => void; error?: string | null }) {
  const said = Number.isFinite(rule.max) ? rule.max.toFixed(2) : 'the number';
  return (
    <Stack label="Delta — at or under" error={error} className="mt-3" hint="lower is further from BTC: less premium, less risk">
      <div className="flex flex-wrap items-center gap-2">
        <NumberField label="delta" value={rule.max} onChange={(n) => onChange({ max: n })} invalid={Boolean(error)} className="w-24" />
        <div role="group" aria-label="delta quick picks" className="flex gap-1">
          {DELTA_PRESETS.map((d) => (
            <button
              key={d} type="button" aria-pressed={rule.max === d} onClick={() => onChange({ max: d })}
              className={cn('m-0 h-9 min-w-[2.75rem] appearance-none rounded-md border border-solid px-2 font-[inherit] text-[12px] font-medium tabular-nums',
                rule.max === d ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--line)] bg-transparent text-muted-foreground')}
            >
              {d.toFixed(2)}
            </button>
          ))}
        </div>
      </div>
      <p className="m-0 mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
        Sells the strike nearest BTC whose delta is {said} or lower. Delta already moves with the time left and with how
        the day is priced, so one number names a strike of about the same risk at 9 PM and at 3 PM.
      </p>
      <MeasuredNote />
    </Stack>
  );
}

/** "2.01%", and with BTC known "2.01% (≈ 1,710 pts)". */
function distanceSaid(pct: number | null, spot: number | null | undefined): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  const pts = spot && spot > 0 ? ` (≈ ${Math.round((spot * pct) / 100).toLocaleString('en-US')} pts)` : '';
  return `${pct.toFixed(2)}%${pts}`;
}

/** The hours a shrinking distance is shown at: the start of a day's window, its middle, and its last hours. */
const DISTANCE_EXAMPLE_HOURS = [20, 12, 6, 2] as const;

/**
 * A distance rule (8 Oct 2026): how far from BTC, and whether that holds all day or shrinks as the contract runs
 * out. What the number means is worked out under it -- a percentage times a root is not something to do by eye.
 */
export function DistanceFields({ rule, onChange, error, spot }: {
  rule: DistanceRule; onChange: (d: DistanceRule) => void; error?: string | null; spot?: number | null;
}) {
  const time = rule.scale === 'time';
  return (
    <Stack label="Distance from BTC — at least" error={error} className="mt-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        <Segmented
          label="distance kind"
          value={rule.scale}
          className="flex-1"
          /*
           * The two read the number differently -- 0.45 fixed is a strike beside the money, 1.5 times a root is one
           * off the board -- so a switch starts the other from its own usual figure rather than carry the number over.
           */
          onChange={(v) => { if (v !== rule.scale) onChange({ scale: v, pct: v === 'time' ? DEFAULT_DISTANCE.pct : DEFAULT_FIXED_DISTANCE_PCT }); }}
          options={[
            { v: 'time', label: 'Shrinks with time left', note: 'The number × the square root of the hours left to the 5:30 PM settlement: far out in the evening, nearer in the last hours.' },
            { v: 'fixed', label: 'Fixed all day', note: 'The same percentage of BTC at every hour.' },
          ]}
        />
        <NumberField label="distance percent" unit={time ? '% ×√h' : '%'} value={rule.pct} onChange={(n) => onChange({ ...rule, pct: n })}
                     invalid={Boolean(error)} className={time ? 'w-32' : 'w-24'} />
      </div>
      <p className="m-0 mt-1.5 text-[11.5px] leading-snug text-muted-foreground" aria-label="distance worked out">
        {time
          ? <>Asks for: {DISTANCE_EXAMPLE_HOURS.map((h) => `${h} h left ${distanceSaid(distanceNeeded(rule, h), spot)}`).join(' · ')}. In the last minutes it asks for almost nothing — the minimum premium is the guard there.</>
          : <>Sells the strike nearest BTC that is at least {distanceSaid(rule.pct, spot)} away, at every hour.</>}
      </p>
      <MeasuredNote />
    </Stack>
  );
}

/**
 * The strategy's own premium floor. Off, the desk's $5 applies, as it does to
 * every order. Its own part, so a form can put it last: it is a gate on
 * whatever the rules above picked, not one of the rules.
 */
export function MinPremiumField({ c, set, err }: { c: StrategyConfig; set: SetField; err: ErrOf }) {
  return (
    <div className="mt-3">
      <Switch
        label="Its own minimum premium"
        description={c.minPremiumUsd != null
          ? `Sells down to $${c.minPremiumUsd} instead of the desk's $5.`
          : "Off — the desk's $5 minimum applies."}
        checked={c.minPremiumUsd != null}
        onCheckedChange={(on) => set('minPremiumUsd', on ? 1 : null)}
      />
      {c.minPremiumUsd != null && (
        <Stack label="Minimum premium" error={err('minPremium')} className="mt-1 w-40" hint="at least $0.10">
          <NumberField label="minimum premium usd" unitBefore="$" value={c.minPremiumUsd}
                       onChange={(n) => set('minPremiumUsd', n)} />
        </Stack>
      )}
    </div>
  );
}

/**
 * A premium rule's condition on distance, and its else -- the same part on the
 * strategy's own rule and on every block of the day.
 *
 * Two strikes, each picked the way a by-strike rule picks one. The **rule**:
 * the premium's strike is sold only at this strike or further out. The
 * **else**: the strike sold when the premium's sits nearer than that, or the
 * premium finds none. They may be the same strike or different ones -- "at
 * least OTM 6, else OTM 8" steps further out on a rich board.
 */
export function MinOtmFields({ premium, onChange, error, scope = '', start }: {
  premium: PremiumRule;
  onChange: (p: PremiumRule) => void;
  error?: string | null;
  /** "block 2": told apart from the rule's own by a screen reader, and by a test. */
  scope?: string;
  /** What switching it on starts from: the rule's own strikes for a block, OTM 6 otherwise. */
  start?: { minOtm: number; elseOtm: number };
}) {
  const on = premium.minOtm != null;
  const min = premium.minOtm ?? DEFAULT_MIN_OTM;
  const other = premium.elseOtm ?? min;
  const named = (what: string) => (scope ? `${scope} ${what}` : what);
  const first = start ?? { minOtm: DEFAULT_MIN_OTM, elseOtm: DEFAULT_MIN_OTM };
  return (
    <div className="mt-2">
      <Switch
        label="Keep it at least this far out of the money"
        description={on
          ? `The premium's strike is sold only at ${strikeLabel(min)} or further out — ${strikeLabel(min + 1)} stays ${strikeLabel(min + 1)}. Else — nearer than that, or none found — sells ${strikeLabel(other)}.`
          : 'Off — whichever strike the premium picks, however near the money.'}
        checked={on}
        onCheckedChange={(v) => onChange({ ...premium, minOtm: v ? first.minOtm : null, elseOtm: v ? first.elseOtm : null })}
      />
      {on && (
        <div className="mt-1 grid gap-2 sm:grid-cols-2">
          <Stack label="Rule — the premium's strike at least" hint="counted over the strikes Delta has listed, out from the money">
            <StrikeStepper value={min} min={1} label={named('rule strike')}
                           onChange={(v) => onChange({ ...premium, minOtm: v, elseOtm: other })} />
          </Stack>
          <Stack label="Else — sell this strike" hint="the same strike as the rule, or a different one">
            <StrikeStepper value={other} min={1} label={named('else strike')}
                           onChange={(v) => onChange({ ...premium, minOtm: min, elseOtm: v })} />
          </Stack>
        </div>
      )}
      <FieldError text={error ?? null} />
    </div>
  );
}

/** Lots, and what they tie up: the most on the book at once, the margin, the share of free margin. */
export function SizeFields({ c, set, err, sizing, spot, label, warnings }: {
  c: StrategyConfig; set: SetField; err: ErrOf; sizing: Sizing; spot: number | null | undefined; label: string; warnings: string[];
}) {
  return (
    <>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Stack label={label} error={err('lots')} hint="1 lot = 0.001 BTC">
          <Input value={String(c.lots)} aria-label="lots" inputMode="numeric"
                 onChange={(e) => set('lots', Math.floor(num(e.target.value, 0)))} />
        </Stack>
        <div className="rounded-lg bg-muted px-2.5 py-2 text-[11.5px] leading-relaxed">
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Max at once</span>
            <span className="tabular-nums text-foreground">{sizing.maxContracts}</span>
          </div>
          <div className="flex justify-between gap-2">
            {/* Sold: margin at 200x. Bought: the premium, paid in full -- no margin. */}
            <span className="text-muted-foreground">{sizing.basis === 'premium' ? 'Premium, at most' : 'Margin'}</span>
            <span className="tabular-nums text-foreground">
              {sizing.basis === 'premium' ? (sizing.priced ? inr(sizing.marginInr) : 'set by the strike') : spot ? inr(sizing.marginInr) : '—'}
            </span>
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
      {sizing.basis === 'premium'
        ? <p className="m-0 mt-1 text-right text-[11px] text-[var(--dim)]">{sizing.priced ? `${usd(sizing.marginUsd)} premium, no margin` : 'no margin: the premium is paid in full'}</p>
        : spot ? <p className="m-0 mt-1 text-right text-[11px] text-[var(--dim)]">{usd(sizing.marginUsd)} at 200x</p> : null}
      <Warnings items={warnings.filter((w) => /margin|account|funded|premium/i.test(w))} />
    </>
  );
}

// ------------------------------------------------------------------ the entry and the exits

/** How the entry is priced: at the offer then the bid after N seconds, at the bid now, or -- where offered -- your price. */
export function EntryPriceFields({ c, set, err, allowSet = true }: {
  c: StrategyConfig; set: SetField; err: ErrOf; allowSet?: boolean;
}) {
  return (
    <>
      <Stack label="Entry price">
        <Segmented
          label="entry price"
          value={c.entryPrice}
          onChange={(v) => set('entryPrice', v)}
          options={[
            { v: 'offer', label: 'Offer', note: 'Rests at the offer — a better price if someone takes it.' },
            { v: 'now', label: 'Bid now', note: 'Sells at the bid at once — fills, at a lower price.' },
            ...(allowSet ? [{ v: 'set' as const, label: 'My price', note: 'Waits at your price until it fills.' }] : []),
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
    </>
  );
}

/**
 * The option's two exits, typed rather than dragged, each as a percentage,
 * fixed points or a price, and each able to move on a timetable. Shown against
 * the premium the rule asks for, so "80%" reads as the price it is.
 *
 * Under a sold option's stop, where it can sit (8 Oct 2026): at 200x the exchange closes a short out a fixed
 * distance over its entry, and a share past that is held just inside it. Said here, with the premium up to which
 * the stop stands as asked, so a trade showing 251% under a 300% setting is not read as a mistake (`stopHoldNote`).
 */
export function OptionExitFields({ c, setC, exits, err, reference, warnings, className, legs = ['target', 'stop'], bought = false, spot }: {
  /** BTC now, where the form has it: what the close-out's room is worked out from. */
  spot?: number | null;
  /** The option is bought, not sold: its stop is under the entry (ExitRuleEditor). */
  bought?: boolean;
  /** Which of the two to offer: both, or the stop alone (a bought option has no target limit of its own). */
  legs?: readonly ('target' | 'stop')[];
  c: StrategyConfig;
  setC: (f: (p: StrategyConfig) => StrategyConfig) => void;
  exits: { target: ExitRule; stop: ExitRule };
  err: ErrOf;
  reference: { price: number | null; label: string };
  warnings: string[];
  className?: string;
}) {
  return (
    <>
      <div className={cn('flex flex-col gap-2', className)}>
        {legs.map((leg) => (
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
            sampleLabel={bought ? 'bought at' : reference.label}
            bought={bought}
            error={err(leg === 'target' ? 'takeProfitPct' : 'stopLossPct')}
          />
        ))}
      </div>
      {!bought && legs.includes('stop') && <StopHoldNote rule={exits.stop} spot={spot} />}
      <Warnings items={warnings.filter((w) => /target and no stop/.test(w))} />
      <Warnings items={[...stepWarnings(c, 'target'), ...stepWarnings(c, 'stop')]} />
    </>
  );
}

/** Where a sold strategy's stop can sit at 200x, and what happens to one asked for past it. Nothing for no stop, or one typed as a price. */
function StopHoldNote({ rule, spot }: { rule: ExitRule; spot?: number | null }) {
  const n = stopHoldNote(rule, spot);
  if (!n || !spot) return null;
  const usd = (v: number) => `$${v.toFixed(v % 1 === 0 ? 0 : 1)}`;
  // A worked entry a little past the line, so the held stop is seen as a price and as a share.
  const eg = n.fitsUpTo !== null ? heldStopFor(Math.ceil(n.fitsUpTo * 1.2), rule, spot) : null;
  const egEntry = n.fitsUpTo !== null ? Math.ceil(n.fitsUpTo * 1.2) : 0;
  return (
    <p role="note" aria-label="where the stop can sit" className="m-0 mt-2 rounded-md bg-muted px-2.5 py-2 text-[11.5px] leading-snug text-muted-foreground">
      At {STRATEGY_LEVERAGE}x the exchange closes a sold option out <b className="text-foreground">{usd(Math.round(n.room))}</b> above its entry, whatever it was sold for.{' '}
      {n.fitsUpTo !== null ? (
        <>
          This stop stands as set on an entry up to <b className="text-foreground">{usd(n.fitsUpTo)}</b>. On a richer one it is held at entry + {usd(n.hold)}, just inside the close-out
          {eg?.held && <> — sold at {usd(egEntry)}, the stop is <b className="text-foreground">{eg.stop}</b> ({Math.round((eg.stop / egEntry - 1) * 100)}%), not {Math.round(eg.asked)}</>}.
          The trade's line says so when it happens.
        </>
      ) : n.alwaysHeld ? (
        <>This stop is past that on every entry, so it is held at entry + {usd(n.hold)}, just inside the close-out.</>
      ) : (
        <>This stop is inside that, and stands as set.</>
      )}
    </p>
  );
}

// ------------------------------------------------------------------ the footer

/**
 * Save, Cancel, what the server refused, and what is left to fix -- with
 * anything a form wants always in reach above them (`top`).
 */
export function FormFooter({ top, refused, tabs, tabProblems, needsName, onName, onGo, busy, shownCount, onCancel, onSave, note }: {
  top?: React.ReactNode; refused: string[]; tabs: TabDef[]; tabProblems: Problem[]; needsName: boolean;
  onName: () => void; onGo: (t: FormTab) => void; busy: boolean; shownCount: number;
  onCancel: () => void; onSave: () => void; note?: string | null;
}) {
  return (
    <SheetFooter className="flex-col gap-2">
      {top}
      {refused.map((p) => (
        <p key={p} className="m-0 text-[11.5px] leading-snug text-[var(--down)]">{p}</p>
      ))}
      {(tabProblems.length > 0 || needsName) && (
        <LeftToFix tabs={tabs} problems={tabProblems} needsName={needsName} onName={onName} onGo={onGo} />
      )}
      <div className="flex gap-2">
        <Button variant="outline" className="h-11 flex-none px-4" onClick={onCancel}>
          Cancel
        </Button>
        <Button className="h-11 flex-1" disabled={busy} onClick={onSave}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {shownCount ? `Fix ${shownCount} to save` : 'Save'}
        </Button>
      </div>
      {note && <p className="m-0 text-center text-[11px] text-[var(--dim)]">{note}</p>}
    </SheetFooter>
  );
}

/** What stops the save, and a way to each thing: the name box, and each tab with a problem. */
export function LeftToFix({ tabs: all, problems, needsName, onName, onGo }: {
  tabs: TabDef[]; problems: Problem[]; needsName: boolean; onName: () => void; onGo: (t: FormTab) => void;
}) {
  const tabs = all.filter((t) => problems.some((p) => p.tab === t.id));
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

// ------------------------------------------------------------------ the small pieces

/**
 * ATM, OTM 1..n, ITM 1..n — one strike at a time, with the name read back.
 *
 * A stepper rather than a number box: the useful range is small, the sign
 * carries the meaning, and "-2" typed into a box is not something anybody
 * should have to translate into "two strikes in the money".
 */
export function StrikeStepper({ value, onChange, min = -MAX_STRIKE_STEP, label = 'which strike' }: {
  value: number; onChange: (v: number) => void;
  /** The nearest it may go: 1 for a floor that must stay out of the money. */
  min?: number;
  label?: string;
}) {
  const go = (by: number) => onChange(Math.max(min, Math.min(MAX_STRIKE_STEP, value + by)));
  // One stepper on a form is "the strike"; two side by side each say which they move.
  const own = label === 'which strike' ? 'one strike' : `${label}:`;
  const btn = 'm-0 h-11 w-12 flex-none appearance-none rounded-md border border-solid border-border bg-muted '
    + 'font-[inherit] text-[18px] text-foreground disabled:opacity-35';
  return (
    <div className="flex items-center gap-2">
      <button type="button" aria-label={`${own} nearer the money`} className={btn}
              disabled={value <= min} onClick={() => go(-1)}>−</button>
      <div
        role="status"
        aria-label={label}
        className="flex h-11 flex-1 items-center justify-center rounded-md border border-solid border-border bg-muted text-[15px] font-semibold text-foreground"
      >
        {strikeLabel(value)}
      </div>
      <button type="button" aria-label={`${own} further out`} className={btn}
              disabled={value >= MAX_STRIKE_STEP} onClick={() => go(1)}>+</button>
    </div>
  );
}

/** A label over its control, with the control's problem under it. */
export function Stack({ label, hint, error, className, children }: {
  label: string; hint?: string; error?: string | null; className?: string; children: React.ReactNode;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      {/* Wraps rather than truncates: "Until — closes what is open" was cut to "Until — closes what is o…" on a phone. */}
      <div className="mb-1 text-[12px] leading-snug text-muted-foreground">{label}</div>
      {children}
      {/* under the field, where it can wrap -- beside a label on a phone it was cut off */}
      {hint && !error && <div className="mt-0.5 text-[10.5px] leading-snug text-[var(--dim)]">{hint}</div>}
      <FieldError text={error ?? null} />
    </div>
  );
}

export function FieldError({ text }: { text: string | null }) {
  if (!text) return null;
  return <p role="alert" className="m-0 mt-1 text-[11.5px] leading-snug text-[var(--down)]">{text}</p>;
}

export function Warnings({ items }: { items: string[] }) {
  return (
    <>
      {items.map((w) => <p key={w} className="m-0 mt-2 text-[11.5px] leading-snug text-[var(--warn)]">{w}</p>)}
    </>
  );
}

export function QuickFix({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
            className="m-0 mt-1 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] underline underline-offset-2">
      {children}
    </button>
  );
}

/** A unit inside the field, so "$" and "%" do not need a row of their own. */
export function Affix({ before, after, children }: { before?: string; after?: string; children: React.ReactNode }) {
  return (
    <div className="relative h-9 self-start">
      {before && <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">{before}</span>}
      {children}
      {after && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">{after}</span>}
    </div>
  );
}

/** Two or three choices on one line; only the chosen one's sentence is shown. */
export function Segmented<T extends string>({ label, value, options, onChange, className, wrap }: {
  label: string;
  value: T;
  options: { v: T; label: string; note: string }[];
  onChange: (v: T) => void;
  className?: string;
  /** For four choices or more: two to a row on a phone, where one row would cut their names. The important gap is for the desk's own `.grid` rule. */
  wrap?: boolean;
}) {
  const chosen = options.find((o) => o.v === value);
  return (
    <div className={cn('min-w-0', className)}>
      <div role="radiogroup" aria-label={label} className={cn('rounded-lg bg-muted p-0.5', wrap ? 'grid grid-cols-2 !gap-0.5 sm:flex sm:flex-wrap' : 'flex gap-0.5')}>
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
