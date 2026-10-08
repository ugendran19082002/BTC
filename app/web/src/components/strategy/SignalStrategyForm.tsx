import {
  actionOf, asSignalConfig, DEFAULT_CONFIG, DEFAULT_SIGNAL_RULE, legOfSignal, MAX_OPEN_PRESETS, MAX_SIGNAL_OPEN, type SignalAction, type SignalRule, type Strategy,
} from '@/types/strategy';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { describeStrategy } from '@/lib/strategy-preview';
import { cn } from '@/lib/utils';
import { useStrategyDraft } from '@/components/strategy/useStrategyDraft';
import { SignalRuleEditor } from '@/components/strategy/SignalRuleEditor';
import { StrikeBlocksEditor } from '@/components/strategy/StrikeBlocksEditor';
import {
  DaysField, EntryPriceFields, num, FormFooter, FormTabBar, MinPremiumField, NameField, OptionExitFields, RuleSentence,
  Segmented, SizeFields, Stack, TimeWindowFields, type TabDef,
} from '@/components/strategy/form-parts';

/**
 * A signal strategy: the desk's entry signals sold as options. Only what such
 * a strategy has, in the order it is decided:
 *
 *   Signals        which way (with the timeframe chain or without it, on which
 *                  timeframe), and which of the 81 methods -- with each one's
 *                  record, and its signals standing now
 *   Strike & lots  the leg is the signal's (BUY sells the PE, SELL the CE); the
 *                  strike by premium or by strike -- one rule all window, or a
 *                  rule per block of hours; lots per signal, 1 to start
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
  // Bought or sold: the leg, the entry and the option's exits all follow it.
  const buying = actionOf(rule) === 'buy';
  const live = Boolean(c.liveOrders);
  const setAction = (a: SignalAction) => d.setC((p) => (actionOf(p.signal) === a ? p : {
    ...p,
    signal: { ...(p.signal ?? DEFAULT_SIGNAL_RULE), action: a },
    // The option's own target and stop mean the opposite thing bought and sold -- a 200% stop is a seller's, a
    // 300% target a buyer's -- so a change of side starts both off (0) rather than carry a number across.
    targetMode: 'pct' as const, takeProfitPct: 0, takeProfitPoints: 0, takeProfitAt: 0, targetSteps: [],
    stopMode: 'pct' as const, stopLossPct: 0, stopLossPoints: 0, stopLossAt: 0, stopSteps: [],
    // Changing side switches live orders off: real orders of the other kind are switched on again on purpose, never carried over.
    liveOrders: false,
  }));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={editing ? `Edit ${editing.name}` : 'New signal strategy'}
        description={`Each TRADE signal of the methods you pick, ${buying ? 'bought' : 'sold'} as one option. Times are IST.`}
        className="sm:w-[min(760px,94vw)]"
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
              errors={{ mode: err('signalMode'), tf: err('signalTf'), methods: err('signalMethods'), slPts: err('signalSlPts') }}
            />
          )}

          {tab === 'sell' && (
            <>
              {/*
                Buy the option or sell it (owner, 5 Oct 2026). Sold is what every strategy did before the choice:
                a BUY signal sells the put, a SELL the call. Bought, a BUY signal buys the call, a SELL the put.
              */}
              <Stack label="Option — buy it or sell it" className="mb-3">
                <div role="radiogroup" aria-label="option buy or sell" className="flex gap-0.5 rounded-lg bg-muted p-0.5">
                  {([['buy', 'BUY'], ['sell', 'SELL']] as const).map(([v, label]) => (
                    <button key={v} type="button" role="radio" aria-checked={actionOf(rule) === v} onClick={() => setAction(v)}
                            className={cn('m-0 h-9 flex-1 appearance-none rounded-md border-0 px-2 font-[inherit] text-[12.5px] font-semibold',
                              actionOf(rule) === v ? 'bg-background shadow-sm' : 'bg-transparent text-muted-foreground',
                              actionOf(rule) === v && (v === 'buy' ? 'text-[var(--up)]' : 'text-[var(--down)]'))}>
                      {label}
                    </button>
                  ))}
                </div>
                {buying && (
                  <p role="note" className="m-0 mt-1.5 rounded-md border border-solid border-border px-2.5 py-2 text-[11.5px] leading-snug text-muted-foreground">
                    Bought at the offer, sold to close. The most it can lose is the premium paid. Its option target and stop are
                    watched by the desk on the bid, so they act while the desk is up — like the perp&apos;s SL and TGT.
                  </p>
                )}
              </Stack>
              <Stack label="Leg — from the signal">
                <div className="grid grid-cols-2 gap-2" aria-label="leg from the signal">
                  <div className="rounded-lg bg-muted px-2.5 py-2 text-[12px]">
                    <span className="font-semibold text-[var(--up)]">BUY</span> signal → {buying ? 'buys' : 'sells'} <b>{legOfSignal('long', actionOf(rule))}</b>
                    <span className="mt-0.5 block text-[10.5px] text-muted-foreground">{buying ? 'wins as BTC rises' : 'wins as BTC rises or holds'}</span>
                  </div>
                  <div className="rounded-lg bg-muted px-2.5 py-2 text-[12px]">
                    <span className="font-semibold text-[var(--down)]">SELL</span> signal → {buying ? 'buys' : 'sells'} <b>{legOfSignal('short', actionOf(rule))}</b>
                    <span className="mt-0.5 block text-[10.5px] text-muted-foreground">{buying ? 'wins as BTC falls' : 'wins as BTC falls or holds'}</span>
                  </div>
                </div>
              </Stack>
              {/* One rule all window, or a rule per block of hours: two tick boxes, each with its own section. */}
              <StrikeBlocksEditor c={c} set={set} err={err} spot={spot} />
              <SizeFields c={c} set={set} err={err} sizing={d.sizing} spot={spot} label="Lots per signal" warnings={d.warnings} />
              {/* Last: a gate on whatever the rules above picked, in whichever block, not one of the rules. */}
              <MinPremiumField c={c} set={set} err={err} />
            </>
          )}

          {tab === 'trade' && (
            <>
              {/*
                When the option is sold. At the zone is what the signal history
                calls "in the trade": a signal the perp never reaches is never
                traded, so the strategy takes the trades the record counts.
              */}
              <Stack label="Enter" className="mb-3">
                <Segmented
                  label="enter on"
                  value={rule.enterOn ?? 'zone'}
                  onChange={(v) => setRule('enterOn', v)}
                  options={[
                    { v: 'zone', label: 'In the trade', note: 'When the BTC perp trades into the signal’s entry zone — the fill the signal history counts. A signal that never fills is never traded. Recommended.' },
                    { v: 'signal', label: 'At the signal', note: 'The moment the signal is written, before the perp reaches the zone — sooner, but it also trades the signals that never fill.' },
                  ]}
                />
              </Stack>
              {buying ? (
                // Bought: a limit at the offer -- it crosses, and pays no more than the price it was judged at. The
                // seller's fields (rest at the offer, then sell at the bid) are not shown as if they applied.
                <div aria-label="entry price for a bought option" className="rounded-lg border border-solid border-border px-2.5 py-2">
                  <div className="text-[12.5px] font-medium text-foreground">Entry price — the offer</div>
                  <p className="m-0 mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
                    A buyer pays the offer: each signal is bought with a limit at the offer of its strike,{' '}
                    {(rule.enterOn ?? 'zone') === 'zone' ? 'when the perp reaches the zone' : 'at the candle that makes the signal'}.
                    Still unfilled {SIGNAL_ENTRY_MIN} minutes later, it is cancelled.
                  </p>
                </div>
              ) : (
                <>
                  <EntryPriceFields c={c} set={set} err={err} allowSet={false} />
                  <p className="m-0 mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
                    Sent once, within a second of {(rule.enterOn ?? 'zone') === 'zone' ? 'the perp reaching the zone' : 'the candle that makes the signal'}.
                    Still unfilled {SIGNAL_ENTRY_MIN} minutes later, it is cancelled — a late fill on a signal is a different trade.
                  </p>
                </>
              )}

              {/*
                The exits that matter: the signal's own SL and TGT on the BTC
                perpetual, made by its method per signal. Only which target, and
                how many at once, are the strategy's to choose.
              */}
              <div className="mt-3 rounded-lg border border-solid border-border px-2.5 py-2" aria-label="exits on the BTC perp">
                <div className="text-[12.5px] font-medium text-foreground">Exits on the BTC perp — from each signal</div>
                <p className="m-0 mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
                  The SL and TGT are the signal&apos;s own levels on the BTC perpetual, made by its method for each signal
                  (SL past the structure by 0.25 ATR). {buying
                    ? 'A bought option would be sold the moment the perp reaches either; its record on the perp is kept the same way.'
                    : 'The desk watches the perp’s last trade and buys the option back the moment either is reached.'}
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
                       hint={`1 to ${MAX_SIGNAL_OPEN}. ${buying ? 'Counts the would-buys still in play.' : 'Live orders off counts the would-sells still in play.'} A signal past this is written down and not taken.`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Input value={String(rule.maxOpen)} aria-label="max open" inputMode="numeric" className="w-20"
                           onChange={(e) => setRule('maxOpen', Math.trunc(num(e.target.value, 0)))} />
                    {MAX_OPEN_PRESETS.map((n) => (
                      <button key={n} type="button" aria-pressed={rule.maxOpen === n} onClick={() => setRule('maxOpen', n)}
                              className={cn('m-0 h-9 min-w-9 appearance-none rounded-md border border-solid px-2 font-[inherit] text-[12.5px] tabular-nums',
                                rule.maxOpen === n ? 'border-foreground bg-muted text-foreground' : 'border-border bg-transparent text-muted-foreground')}>
                        {n}
                      </button>
                    ))}
                  </div>
                </Stack>
              </div>

              {/*
                The order the exits are judged in, said once (owner, 2 Oct 2026: "the perp first, else the
                option"): the desk checks the perp every second; the option's target and stop rest at Delta
                all the while, and work when the desk is down.
              */}
              <ol className="m-0 mt-3 list-decimal space-y-0.5 pl-5 text-[11.5px] leading-snug text-muted-foreground" aria-label="exit order">
                <li><b className="text-foreground">BTC perp SL / TGT</b> — the signal&apos;s levels, checked by the desk every second. Checked first.</li>
                <li><b className="text-foreground">Option TP / SL</b> — only if you set them below (0 = off, nothing placed). Set, they rest at Delta: whichever is reached first closes the trade, and they still work if the desk is down.</li>
              </ol>
              <div className="mt-3 text-[12px] text-muted-foreground">
                {buying
                  ? 'Option TP / SL — optional, 0 is off. Bought: the target is a sale over the entry, with no upper limit; the stop a sale under it, up to 99% — the premium and no more.'
                  : 'Option TP / SL — optional, placed at Delta only when set. Sold: the target is a buy-back under the entry, up to 99%; the stop a buy-back over it, with no upper limit.'}
              </div>
              {/* The "no target and no stop" warning is for a clock strategy; this one always has the perp's SL and TGT. */}
              {/* Both, bought or sold; bought, each is on the other side of the entry (ExitRuleEditor). */}
              <OptionExitFields c={c} setC={d.setC} exits={d.exits} err={err} reference={d.reference} bought={buying}
                                warnings={d.warnings.filter((w) => !/target and no stop/.test(w))} className="mt-1" />
              {!buying && d.exits.stop.value <= 0 && !d.exits.stop.steps.some((st) => st.value > 0) && (
                <p role="note" className="m-0 mt-2 rounded-md border border-solid border-[var(--warn)]/40 bg-[var(--warn)]/10 px-2.5 py-2 text-[11.5px] leading-snug text-[var(--warn)]">
                  Option stop off — nothing is placed on the option. Only the perp SL protects the trade, and only while the desk can see the perp.{' '}
                  <button type="button" onClick={() => d.setC((p) => ({ ...p, stopMode: 'pct', stopLossPct: 2, stopSteps: [] }))}
                          className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[11.5px] text-[var(--accent)] underline underline-offset-2">
                    Add one: +200% (buys back at 3× the entry)
                  </button>
                </p>
              )}
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
                  ? `ON — each signal places a real ${buying ? 'buy' : 'sell'} order at Delta.`
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
