import {
  asSignalConfig, DEFAULT_CONFIG, DEFAULT_SIGNAL_RULE, MAX_SIGNAL_OPEN, type SignalRule, type Strategy,
} from '@/types/strategy';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { describeStrategy } from '@/lib/strategy-preview';
import { cn } from '@/lib/utils';
import { useStrategyDraft } from '@/components/strategy/useStrategyDraft';
import { SignalRuleEditor } from '@/components/strategy/SignalRuleEditor';
import {
  DaysField, EntryPriceFields, FormFooter, FormTabBar, NameField, OptionExitFields, RuleSentence,
  Segmented, SizeFields, Stack, StrikeFields, TimeWindowFields, type TabDef,
} from '@/components/strategy/form-parts';

/**
 * A signal strategy: the desk's entry signals sold as options. Only what such
 * a strategy has, in the order it is decided:
 *
 *   Signals        which way (with the timeframe chain or without it, on which
 *                  timeframe), and which of the 81 methods -- with each one's
 *                  record, and its signals standing now
 *   Strike & lots  the leg is the signal's (BUY sells the PE, SELL the CE); the
 *                  strike by premium or by strike; lots per signal, 1 to start
 *   Entry & exit   the offer, then the bid after N seconds; the SL and TGT on
 *                  the BTC perp from each signal; the option's own exits as
 *                  the backstop at Delta
 *   When           the window it takes signals in, and the days
 *
 * Live orders is in the footer, on every tab, off until switched on. Built
 * from the same parts as the clock strategy's form (form-parts.tsx), checked
 * and saved the same way (useStrategyDraft).
 */

const TABS: TabDef[] = [
  { id: 'signal', label: 'Signals' },
  { id: 'sell', label: 'Strike & lots' },
  { id: 'trade', label: 'Entry & exit' },
  { id: 'when', label: 'When' },
];

/** The server's SIGNAL_ENTRY_MS: how long a signal's entry rests before it is cancelled. */
const SIGNAL_ENTRY_MIN = 5;

export function SignalStrategyForm({ editing, open, onOpenChange, onSaved, balanceUsd, spot }: {
  editing: Strategy | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
  balanceUsd?: number | null;
  spot?: number | null;
}) {
  const d = useStrategyDraft({
    editing,
    initial: asSignalConfig(DEFAULT_CONFIG, true),
    firstTab: 'signal',
    balanceUsd,
    spot,
    onSaved,
    onClose: () => onOpenChange(false),
  });
  const { c, set, err, tab } = d;
  const rule: SignalRule = c.signal ?? DEFAULT_SIGNAL_RULE;
  const setRule = <K extends keyof SignalRule>(k: K, v: SignalRule[K]) =>
    d.setC((p) => ({ ...p, signal: { ...(p.signal ?? DEFAULT_SIGNAL_RULE), [k]: v } }));
  const live = Boolean(c.liveOrders);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={editing ? `Edit ${editing.name}` : 'New signal strategy'}
        description="Each TRADE signal of the methods you pick, sold as one option. Times are IST."
        className="sm:w-[520px]"
      >
        <NameField value={d.name} onChange={d.setName} touched={d.nameTouched} onTouched={() => d.setNameTouched(true)}
                   problem={d.nameProblem} inputRef={d.nameInput} placeholder="Name, e.g. Breakout signals 15m" />
        <RuleSentence text={describeStrategy(c)} />
        <FormTabBar tabs={TABS} tab={tab} onTab={d.setTab} hasProblem={d.tabHasProblem} />

        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="pt-2">
          {tab === 'signal' && (
            <SignalRuleEditor
              rule={rule}
              onChange={(r) => set('signal', r)}
              errors={{ mode: err('signalMode'), tf: err('signalTf'), methods: err('signalMethods') }}
            />
          )}

          {tab === 'sell' && (
            <>
              <Stack label="Leg — from the signal">
                <div className="grid grid-cols-2 gap-2" aria-label="leg from the signal">
                  <div className="rounded-lg bg-muted px-2.5 py-2 text-[12px]">
                    <span className="font-semibold text-[var(--up)]">BUY</span> signal → sells <b>PE</b>
                    <span className="mt-0.5 block text-[10.5px] text-muted-foreground">wins as BTC rises or holds</span>
                  </div>
                  <div className="rounded-lg bg-muted px-2.5 py-2 text-[12px]">
                    <span className="font-semibold text-[var(--down)]">SELL</span> signal → sells <b>CE</b>
                    <span className="mt-0.5 block text-[10.5px] text-muted-foreground">wins as BTC falls or holds</span>
                  </div>
                </div>
              </Stack>
              <StrikeFields c={c} set={set} err={err} allowOiWall={false} />
              <SizeFields c={c} set={set} err={err} sizing={d.sizing} spot={spot} label="Lots per signal" warnings={d.warnings} />
            </>
          )}

          {tab === 'trade' && (
            <>
              <EntryPriceFields c={c} set={set} err={err} allowSet={false} />
              <p className="m-0 mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
                Sent within seconds of the candle that makes the signal, once. Still unfilled {SIGNAL_ENTRY_MIN} minutes
                later, it is cancelled — a late fill on a signal is a different trade.
              </p>

              {/*
                The exits that matter: the signal's own SL and TGT on the BTC
                perpetual, made by its method per signal. Only which target, and
                how many at once, are the strategy's to choose.
              */}
              <div className="mt-3 rounded-lg border border-solid border-border px-2.5 py-2" aria-label="exits on the BTC perp">
                <div className="text-[12.5px] font-medium text-foreground">Exits on the BTC perp — from each signal</div>
                <p className="m-0 mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
                  The SL and TGT are the signal&apos;s own levels on the BTC perpetual, made by its method for each signal
                  (SL past the structure by 0.25 ATR). The desk watches the perp&apos;s last trade and buys the option back
                  the moment either is reached.
                </p>
                <Stack label="Target" error={err('signalTarget')} className="mt-2">
                  <Segmented
                    label="signal target"
                    value={rule.target}
                    onChange={(v) => setRule('target', v)}
                    options={[
                      { v: 'tp1', label: 'TGT1', note: 'The nearest target, within 1–2R — taken most often.' },
                      { v: 'tp2', label: 'TGT2', note: 'Further, where the signal has one; else TGT1.' },
                      { v: 'tp3', label: 'TGT3', note: 'The expected-move edge, where the signal has one; else TGT1.' },
                    ]}
                  />
                </Stack>
                <Stack label="At most open at once" error={err('maxOpen')} className="mt-2"
                       hint="A signal past this is written down and not taken.">
                  <div className="grid grid-cols-5 gap-1" role="radiogroup" aria-label="max open">
                    {Array.from({ length: MAX_SIGNAL_OPEN }, (_, i) => i + 1).map((n) => (
                      <button key={n} type="button" role="radio" aria-checked={rule.maxOpen === n} onClick={() => setRule('maxOpen', n)}
                              className={cn('m-0 h-9 appearance-none rounded-md border border-solid font-[inherit] text-[12.5px]',
                                rule.maxOpen === n ? 'border-foreground bg-muted text-foreground' : 'border-border bg-transparent text-muted-foreground')}>
                        {n}
                      </button>
                    ))}
                  </div>
                </Stack>
              </div>

              <div className="mt-3 text-[12px] text-muted-foreground">
                Backstop on the option at Delta — in case the desk cannot see the perp
              </div>
              <OptionExitFields c={c} setC={d.setC} exits={d.exits} err={err} reference={d.reference} warnings={d.warnings} className="mt-1" />
            </>
          )}

          {tab === 'when' && (
            <>
              <TimeWindowFields c={c} set={set} err={err} name={d.name}
                                labels={{ from: 'Take signals from', until: 'Until — closes what is open', fromPicker: 'Take signals from', untilPicker: 'Signals until' }} />
              <DaysField c={c} set={set} err={err} />
            </>
          )}
        </div>

        <FormFooter
          top={
            /*
              Live orders, on every tab: the one switch that decides whether a
              signal becomes an order at Delta. Off, the default, each signal is
              written down as the order it would have been (decision 0013).
            */
            <div className={cn('rounded-lg border border-solid px-2.5 py-1.5', live ? 'border-[var(--down)] bg-[var(--down)]/10' : 'border-border')}>
              <Switch
                label="Live orders"
                description={live
                  ? 'ON — each signal places a real order at Delta.'
                  : 'Off — each signal is written down as the order it would be. Nothing is sent.'}
                checked={live}
                onCheckedChange={(on) => set('liveOrders', on)}
              />
            </div>
          }
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
