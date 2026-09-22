import { Checkbox } from '@/components/ui/checkbox';
import { NumberField } from '@/components/ui/number-field';
import { price as fmtPrice, inr, usd, usdToInr } from '@/lib/format';
import { exitWords, type ExitLeg } from '@/lib/strategy-exits';
import { inputProblem, levelOf, valueOf, type ExitInput } from '@/lib/exit-input';
import type { ExitMode } from '@/types/strategy';
import { cn } from '@/lib/utils';

/**
 * The two exits, each behind a tick box, each a number you type.
 *
 * They were sliders, and a slider is the wrong control for a number somebody
 * already has in mind: "stop at 150%" took a dozen nudges, and the stop's bar
 * ended at 300% because a bar has to end somewhere. Now each is a box, read as
 * a percentage or as fixed points from the entry:
 *
 *   target  keep 80% of the premium        | or 10 points under the entry
 *   stop    buy back 150% above the entry  | or 10 points over it
 *
 * The target stops at 99% -- 100% is a buy at zero, which no limit rests at.
 * The stop has no ceiling here beyond the 2000% typo guard: a short option can
 * multiply, and a stop at 3x the premium is a real choice.
 *
 * Both start off, and an unticked box takes one line instead of four. The line
 * under a ticked one is the point: "buys back at 4.50, you keep $22.50" is the
 * trade, and the percentage is the small grey number rather than the headline.
 *
 * A short option makes money when it gets cheaper, so the target is green and
 * downward, the stop red and upward.
 */

export type ExitBarsProps = {
  target: ExitInput;
  stop: ExitInput;
  onTarget: (patch: Partial<ExitInput>) => void;
  onStop: (patch: Partial<ExitInput>) => void;
  /** The price the position is being opened at. Null before a quote arrives. */
  entry: number | null;
  /** Contracts, for turning a price difference into money. */
  size: number;
  /**
   * BTC per contract. A quoted price is dollars per BTC, so the money is
   * price x contracts x this -- leaving it out reads a thousand times high.
   */
  contractValue?: number;
  /** Where the exchange closes the position out, if it is known. */
  liquidationPrice?: number | null;
};

export function ExitBars({
  target, stop, onTarget, onStop, entry, size, liquidationPrice, contractValue = 0.001,
}: ExitBarsProps) {
  const targetPrice = levelOf('target', target, entry);
  const stopPrice = levelOf('stop', stop, entry);

  const keep = entry !== null && targetPrice !== null ? (entry - targetPrice) * size * contractValue : null;
  const lose = entry !== null && stopPrice !== null ? (stopPrice - entry) * size * contractValue : null;

  // A stop the exchange will reach first is not a stop, and the box should say
  // so while it is being typed rather than after the order is refused.
  const stopPastCloseOut =
    stopPrice !== null && liquidationPrice != null && stopPrice >= liquidationPrice;

  return (
    <div className="flex flex-col">
      <Checkbox
        checked={target.on}
        onChange={(e) => onTarget({ on: e.target.checked })}
        label={<Head title="Take profit" tone="up" x={target} sign="−" />}
      />
      {target.on && (
        <Row
          leg="target"
          x={target}
          onChange={onTarget}
          detail={
            valueOf(target) === 0 ? (
              <>Type how much of the premium to keep.</>
            ) : (
              <>
                Buys back at <b className="tabular-nums text-foreground">{fmtPrice(targetPrice)}</b>
                {keep !== null && (
                  <> · you keep <b className="tabular-nums text-[var(--up)]">{inr(usdToInr(keep))}</b>
                    <span className="text-[var(--dim)]"> {usd(keep)}</span></>
                )}
                {target.mode === 'points' && entry !== null && target.points >= entry && (
                  <span className="text-[var(--warn)]"> · more than the premium, so it rests at 1% of it</span>
                )}
              </>
            )
          }
        />
      )}

      <Checkbox
        checked={stop.on}
        onChange={(e) => onStop({ on: e.target.checked })}
        label={<Head title="Stop loss" tone="down" x={stop} sign="+" />}
      />
      {stop.on ? (
        <Row
          leg="stop"
          x={stop}
          onChange={onStop}
          warn={stopPastCloseOut}
          detail={
            valueOf(stop) === 0 ? (
              <>Type how far it may go against you.</>
            ) : stopPastCloseOut ? (
              <>
                <b className="text-[var(--down)]">
                  {fmtPrice(stopPrice)} is past the {fmtPrice(liquidationPrice)} liquidation
                </b>{' '}
                — Delta closes you first, so it would never fire. Set it lower or use less leverage.
              </>
            ) : (
              <>
                Buys back at <b className="tabular-nums text-foreground">{fmtPrice(stopPrice)}</b>
                {lose !== null && (
                  <> · you lose <b className="tabular-nums text-[var(--down)]">{inr(usdToInr(lose))}</b>
                    <span className="text-[var(--dim)]"> {usd(lose)}</span></>
                )}
              </>
            )
          }
        />
      ) : (
        <p className="m-0 pl-[26px] text-[11.5px] leading-snug text-muted-foreground">
          {liquidationPrice != null ? (
            <>
              No stop — Delta liquidates the position at{' '}
              <b className="tabular-nums text-[var(--down)]">{fmtPrice(liquidationPrice)}</b>.
            </>
          ) : (
            <>No stop — the position runs until Delta liquidates it.</>
          )}
        </p>
      )}
    </div>
  );
}

/** "Take profit −80%" / "Stop loss +10 pts" beside the box. */
function Head({ title, tone, x, sign }: { title: string; tone: 'up' | 'down'; x: ExitInput; sign: string }) {
  const v = valueOf(x);
  return (
    <span className="flex items-baseline gap-1.5">
      <span>{title}</span>
      {x.on && v > 0 && (
        <span className={cn('text-[12px] font-semibold tabular-nums', tone === 'up' ? 'text-[var(--up)]' : 'text-[var(--down)]')}>
          {sign}{exitWords(x.mode, v)}
        </span>
      )}
    </span>
  );
}

function Row({
  leg, x, onChange, detail, warn,
}: {
  leg: ExitLeg;
  x: ExitInput;
  onChange: (patch: Partial<ExitInput>) => void;
  detail: React.ReactNode;
  warn?: boolean;
}) {
  const name = leg === 'target' ? 'target' : 'stop';
  const pct = x.mode === 'pct';
  const problem = inputProblem(leg, x);
  return (
    <div className="pl-[26px]">
      <div className="flex items-center gap-2">
        <NumberField
          label={`${name} ${pct ? 'percent' : 'points'}`}
          value={pct ? x.pct * 100 : x.points}
          onChange={(n) => onChange(pct ? { pct: n / 100 } : { points: n })}
          unit={pct ? '%' : 'pts'}
          invalid={Boolean(problem)}
          className="w-28 flex-none"
        />
        <ModeSwitch name={name} mode={x.mode} onChange={(mode) => onChange({ mode })} />
      </div>
      {problem ? (
        <p role="alert" className="m-0 mt-1 min-h-[2.2em] text-[11.5px] leading-snug text-[var(--down)]">{problem}</p>
      ) : (
        <p className={cn('m-0 mt-1 min-h-[2.2em] text-[11.5px] leading-snug', warn ? 'text-[var(--down)]' : 'text-muted-foreground')}>
          {detail}
        </p>
      )}
    </div>
  );
}

/** Percent or fixed points; each keeps its own number, so switching back finds it. */
function ModeSwitch({ name, mode, onChange }: { name: string; mode: ExitMode; onChange: (m: ExitMode) => void }) {
  return (
    <div role="radiogroup" aria-label={`${name} by`} className="flex gap-0.5 rounded-md bg-muted p-0.5">
      {(['pct', 'points'] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          onClick={() => onChange(m)}
          className={cn(
            'm-0 h-7 appearance-none rounded border-0 px-2.5 font-[inherit] text-[12px] font-medium',
            mode === m ? 'bg-background text-foreground shadow-sm' : 'bg-transparent text-muted-foreground',
          )}
        >
          {m === 'pct' ? '%' : 'Fixed'}
        </button>
      ))}
    </div>
  );
}
