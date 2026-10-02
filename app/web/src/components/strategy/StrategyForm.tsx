import type { Strategy } from '@/types/strategy';
import { DEFAULT_CONFIG } from '@/types/strategy';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { describeStrategy } from '@/lib/strategy-preview';
import { nameWarning } from '@/lib/strategy-checks';
import { time12 } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useStrategyDraft } from '@/components/strategy/useStrategyDraft';
import {
  Affix, DaysField, EntryPriceFields, FormFooter, FormTabBar, NameField, OptionExitFields, RuleSentence,
  Segmented, SizeFields, Stack, StrikeFields, TimeWindowFields, Warnings, num, type TabDef,
} from '@/components/strategy/form-parts';

/**
 * A clock strategy -- everything it is, in words rather than symbols, in three
 * short tabs:
 *
 *   When     entry and exit on a clock, and the days
 *   Sell     which legs, which strike, how many lots, and what that ties up
 *   Trade    how the entry is priced and where it exits
 *
 * A tab with something wrong in it carries a red dot, the problem is written
 * under the field that has it, and Save says how much is left and takes you
 * there. The server still validates and answers; what it says is shown too.
 * The rule read back as a sentence stays at the top, folded to two lines.
 *
 * A signal strategy has a form of its own (SignalStrategyForm), made of the
 * same parts (form-parts.tsx); one opened here for editing is passed to it.
 */

const TABS: TabDef[] = [
  { id: 'when', label: 'When' },
  { id: 'sell', label: 'Sell' },
  { id: 'trade', label: 'Entry & exit' },
];

export function StrategyForm({ editing, open, onOpenChange, onSaved, balanceUsd, spot }: {
  editing: Strategy | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
  balanceUsd?: number | null;
  spot?: number | null;
}) {
  const d = useStrategyDraft({
    editing, initial: DEFAULT_CONFIG, firstTab: 'when', balanceUsd, spot, onSaved, onClose: () => onOpenChange(false),
  });
  const { c, set, err, tab } = d;
  const nameWarnings = [nameWarning(d.name, c.legs)].filter((w): w is string => w !== null);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={editing ? `Edit ${editing.name}` : 'New strategy'}
        description="Times are IST. Nothing runs until this strategy and auto-trading are both on."
        className="sm:w-[480px]"
      >
        <NameField value={d.name} onChange={d.setName} touched={d.nameTouched} onTouched={() => d.setNameTouched(true)}
                   problem={d.nameProblem} inputRef={d.nameInput} placeholder="Name, e.g. Double one-sided" warnings={nameWarnings} />
        <RuleSentence text={describeStrategy(c)} />
        <FormTabBar tabs={TABS} tab={tab} onTab={d.setTab} hasProblem={d.tabHasProblem} />

        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="pt-2">
          {tab === 'when' && (
            <>
              <TimeWindowFields c={c} set={set} err={err} name={d.name}
                                labels={{ from: 'Entry time', until: 'Exit time', fromPicker: 'Entry time', untilPicker: 'Exit time' }} />
              <DaysField c={c} set={set} err={err} />

              {/*
                What the stop and the target are watched on. A wick through a
                level is not a break, and a thin option's mark can print a price
                nothing traded at -- so a stop on the touch exits on noise a
                close would have ridden out. The other way round, waiting for the
                close gives back the distance between the wick and the close
                when the move is real. Both are right sometimes.
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
                        <span className="mt-0.5 flex-none text-sm">{icon}</span>
                        <span className="min-w-0">
                          <span className="block text-[12.5px] font-medium leading-tight text-foreground">{label}</span>
                          <span className="mt-0.5 block text-[10.5px] leading-snug text-muted-foreground">{desc}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/*
                How late is too late. It belongs to the strategy: an hour into a
                twelve-hour contract is nothing, ten minutes into a move is
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
              <Warnings items={nameWarnings} />
              <StrikeFields c={c} set={set} err={err} />
              <SizeFields c={c} set={set} err={err} sizing={d.sizing} spot={spot} label="Lots per leg" warnings={d.warnings} />
            </>
          )}

          {tab === 'trade' && (
            <>
              <EntryPriceFields c={c} set={set} err={err} />
              <OptionExitFields c={c} setC={d.setC} exits={d.exits} err={err} reference={d.reference} warnings={d.warnings} className="mt-3" />
            </>
          )}
        </div>

        <FormFooter
          refused={d.refused}
          tabs={TABS}
          tabProblems={d.tabProblems}
          needsName={d.nameTouched && Boolean(d.nameProblem)}
          onName={() => d.nameInput.current?.focus()}
          onGo={d.setTab}
          busy={d.busy}
          shownCount={d.shownCount}
          onCancel={() => onOpenChange(false)}
          onSave={() => void d.save()}
          note={!editing && d.problems.length === 0 ? 'Saved switched off. Turn it on from the list.' : null}
        />
      </SheetContent>
    </Sheet>
  );
}
