import { Slider } from '@/components/ui/slider';
import { Checkbox } from '@/components/ui/checkbox';
import { price as fmtPrice, inr, usd, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The two exits, each behind a tick box.
 *
 * Both start off, and while they are off there is no bar at all -- an
 * unticked box takes one line instead of four, which on a phone is the
 * difference between the Sell button being on screen and not. Ticking one
 * opens its bar.
 *
 * The line underneath is the point of the whole control. A percentage is an
 * abstraction; "buys back at 4.50, you keep $22.50" is the trade. So the price
 * and the money move under your thumb as you drag, and the percentage is the
 * small grey number rather than the headline.
 *
 * The two directions are opposite and the colours say so: a short option makes
 * money when it gets cheaper, so the target is green and downward, the stop is
 * red and upward.
 */

export type ExitBarsProps = {
  targetOn: boolean;
  stopOn: boolean;
  onTargetOn: (v: boolean) => void;
  onStopOn: (v: boolean) => void;
  /** The price the position is being opened at. Null before a quote arrives. */
  entry: number | null;
  /** Contracts, for turning a price difference into money. */
  size: number;
  /**
   * BTC per contract. A quoted price is dollars per BTC, so the money is
   * price x contracts x this -- leaving it out reads a thousand times high.
   */
  contractValue?: number;
  targetPct: number;
  stopPct: number;
  onTargetPct: (v: number) => void;
  onStopPct: (v: number) => void;
  /** Where the exchange closes the position out, if it is known. */
  liquidationPrice?: number | null;
};

/** Target: 0 to 99% of the premium decayed away. */
const TARGET_MAX = 0.99;
/** Stop: 0 to 300% above the entry. Beyond that it is not a stop, it is a hope. */
const STOP_MAX = 3;

export function ExitBars({
  entry, size, targetPct, stopPct, onTargetPct, onStopPct, liquidationPrice,
  targetOn, stopOn, onTargetOn, onStopOn, contractValue = 0.001,
}: ExitBarsProps) {
  const targetPrice = entry !== null && targetOn && targetPct > 0 ? entry * (1 - targetPct) : null;
  const stopPrice = entry !== null && stopOn && stopPct > 0 ? entry * (1 + stopPct) : null;

  const keep = entry !== null && targetPrice !== null ? (entry - targetPrice) * size * contractValue : null;
  const lose = entry !== null && stopPrice !== null ? (stopPrice - entry) * size * contractValue : null;

  // A stop the exchange will reach first is not a stop, and the bar should say
  // so while your thumb is still on it rather than after the order is refused.
  const stopPastCloseOut =
    stopPrice !== null && liquidationPrice != null && stopPrice >= liquidationPrice;

  return (
    <div className="flex flex-col">
      <Checkbox
        checked={targetOn}
        onChange={(e) => onTargetOn(e.target.checked)}
        label={
          <span className="flex items-baseline gap-1.5">
            <span>Take profit</span>
            {targetOn && targetPct > 0 && (
              <span className="text-[12px] font-semibold tabular-nums text-[var(--up)]">
                −{Math.round(targetPct * 100)}%
              </span>
            )}
          </span>
        }
      />
      {targetOn && (
        <Bar
          label="target"
          tone="up"
          pct={targetPct}
          max={TARGET_MAX}
          step={0.01}
          onChange={onTargetPct}
          detail={
            targetPct === 0 ? (
              <>Drag to set how much of the premium to keep.</>
            ) : (
              <>
                Buys back at <b className="tabular-nums text-foreground">{fmtPrice(targetPrice)}</b>
                {keep !== null && (
                  <> · you keep <b className="tabular-nums text-[var(--up)]">{inr(usdToInr(keep))}</b>
                    <span className="text-[var(--dim)]"> {usd(keep)}</span></>
                )}
              </>
            )
          }
        />
      )}

      <Checkbox
        checked={stopOn}
        onChange={(e) => onStopOn(e.target.checked)}
        label={
          <span className="flex items-baseline gap-1.5">
            <span>Stop loss</span>
            {stopOn && stopPct > 0 && (
              <span className="text-[12px] font-semibold tabular-nums text-[var(--down)]">
                +{Math.round(stopPct * 100)}%
              </span>
            )}
          </span>
        }
      />
      {stopOn ? (
        <Bar
          label="stop"
          tone="down"
          pct={stopPct}
          max={STOP_MAX}
          step={0.05}
          onChange={onStopPct}
          warn={stopPastCloseOut}
          detail={
            stopPct === 0 ? (
              <>Drag to set how far it may go against you.</>
            ) : stopPastCloseOut ? (
              <>
                <b className="text-[var(--down)]">
                  {fmtPrice(stopPrice)} is past the {fmtPrice(liquidationPrice)} liquidation
                </b>{' '}
                — Delta closes you first, so it would never fire. Drag it lower or use less leverage.
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

function Bar({
  label, tone, pct, max, step, onChange, detail, warn,
}: {
  label: string;
  tone: 'up' | 'down';
  pct: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  detail: React.ReactNode;
  warn?: boolean;
}) {
  return (
    <div className="pl-[26px]">
      <Slider
        aria-label={`${label} percent`}
        tone={tone}
        value={[pct]}
        max={max}
        step={step}
        min={0}
        onValueChange={([v]) => onChange(v ?? 0)}
      />

      <p
        className={cn(
          'm-0 -mt-1 min-h-[2.2em] text-[11.5px] leading-snug',
          warn ? 'text-[var(--down)]' : 'text-muted-foreground',
        )}
      >
        {detail}
      </p>
    </div>
  );
}
