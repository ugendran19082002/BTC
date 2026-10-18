import { cn } from '@/lib/utils';

/**
 * The perp's own SL and TGT left out, in the backtest and a run together (owner, 18 Oct 2026: "skip perp SL, skip perp
 * TGT -- enable, disable"): a trade is then not closed when the perp reaches that level -- only by the option's own
 * target and stop, the exit time or the day's end. What-if research: the desk always closes on the perp's levels.
 */
function Switch({ on, label, words, onClick }: { on: boolean; label: string; words: string; onClick: () => void }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-foreground">{label}</span>
        <span className={cn('block text-[12px] leading-snug', on ? 'text-[var(--warn)]' : 'text-muted-foreground')}>{words}</span>
      </span>
      <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick}
        className="m-0 inline-flex min-h-[44px] flex-none cursor-pointer appearance-none items-center border-0 bg-transparent p-0 pl-2">
        <span className={cn('relative inline-flex h-6 w-11 items-center rounded-full transition-colors', on ? 'bg-[var(--chosen)]' : 'bg-[var(--line)]')}>
          <span className={cn('block h-5 w-5 rounded-full shadow transition-transform', on ? 'translate-x-[22px] bg-[var(--chosen-ink)]' : 'translate-x-0.5 bg-muted-foreground')} />
        </span>
      </button>
    </div>
  );
}

export function BacktestSkipPerp({ sl, tgt, onChange, optionStop, optionTarget, name = 'Perp SL and TGT' }: {
  sl: boolean; tgt: boolean;
  onChange: (v: { skipPerpSl: boolean; skipPerpTgt: boolean }) => void;
  /** Whether the option's own stop and target are set: with the perp's left out, they are what is left. */
  optionStop: boolean; optionTarget: boolean;
  name?: string;
}) {
  return (
    <section aria-label={name} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 rounded-lg border border-solid border-border p-2.5">
      <Switch on={sl} label="Skip perp SL" onClick={() => onChange({ skipPerpSl: !sl, skipPerpTgt: tgt })}
        words={sl ? "Left out: the perp reaching the signal's SL closes nothing." : "Used: the perp at the signal's SL closes the trade, as on the desk."} />
      <Switch on={tgt} label="Skip perp TGT" onClick={() => onChange({ skipPerpSl: sl, skipPerpTgt: !tgt })}
        words={tgt ? "Left out: the perp reaching the signal's TGT closes nothing." : "Used: the perp at the signal's TGT closes the trade, as on the desk."} />
      {sl && !optionStop && (
        <p role="note" className="m-0 mt-1 text-[12px] leading-snug text-[var(--warn)]">With the perp SL skipped and no option stop, nothing closes a losing trade before the exit time or the day&apos;s end.</p>
      )}
      {tgt && !optionTarget && !sl && (
        <p role="note" className="m-0 mt-1 text-[12px] leading-snug text-muted-foreground">With the perp TGT skipped and no option target, a winner runs until the perp SL, the exit time or the day&apos;s end.</p>
      )}
      {(sl || tgt) && <p className="m-0 mt-1 text-[11px] leading-snug text-[var(--dim)]">A what-if: the live desk always closes on the perp&apos;s levels.</p>}
    </section>
  );
}
