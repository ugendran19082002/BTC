import { Slider } from '@/components/ui/slider';
import { price as fmtPrice, usd } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The two exits, as bars you drag.
 *
 * Both start at 0%, which means off, because a percentage of nothing is nothing
 * and an exit nobody chose is an exit nobody understands. Dragging either one
 * turns it on.
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
  /** The price the position is being opened at. Null before a quote arrives. */
  entry: number | null;
  /** Contracts, for turning a price difference into money. */
  size: number;
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
}: ExitBarsProps) {
  const targetPrice = entry !== null && targetPct > 0 ? entry * (1 - targetPct) : null;
  const stopPrice = entry !== null && stopPct > 0 ? entry * (1 + stopPct) : null;

  const keep = entry !== null && targetPrice !== null ? (entry - targetPrice) * size : null;
  const lose = entry !== null && stopPrice !== null ? (stopPrice - entry) * size : null;

  // A stop the exchange will reach first is not a stop, and the bar should say
  // so while your thumb is still on it rather than after the order is refused.
  const stopPastCloseOut =
    stopPrice !== null && liquidationPrice != null && stopPrice >= liquidationPrice;

  return (
    <div className="flex flex-col gap-1">
      <Bar
        label="target"
        tone="up"
        pct={targetPct}
        max={TARGET_MAX}
        step={0.01}
        onChange={onTargetPct}
        badge={targetPct > 0 ? `−${Math.round(targetPct * 100)}%` : 'off'}
        detail={
          targetPct === 0 ? (
            <>Runs to settlement. A daily option that expires worthless keeps the whole credit.</>
          ) : (
            <>
              buys back at <b className="tabular-nums text-foreground">{fmtPrice(targetPrice)}</b>
              {keep !== null && <> · you keep <b className="tabular-nums text-[var(--up)]">{usd(keep)}</b></>}
            </>
          )
        }
      />

      <Bar
        label="stop"
        tone="down"
        pct={stopPct}
        max={STOP_MAX}
        step={0.05}
        onChange={onStopPct}
        badge={stopPct > 0 ? `+${Math.round(stopPct * 100)}%` : 'off'}
        warn={stopPastCloseOut}
        detail={
          stopPct === 0 ? (
            liquidationPrice != null ? (
              <>
                No stop. The position ends at the exchange&rsquo;s close-out,{' '}
                <b className="tabular-nums text-[var(--down)]">{fmtPrice(liquidationPrice)}</b>.
              </>
            ) : (
              <>No stop. The position runs until the exchange closes it.</>
            )
          ) : stopPastCloseOut ? (
            <>
              <b className="text-[var(--down)]">
                {fmtPrice(stopPrice)} is past the {fmtPrice(liquidationPrice)} close-out
              </b>{' '}
              — it would never fire. Drag it lower, or use less leverage.
            </>
          ) : (
            <>
              buys back at <b className="tabular-nums text-foreground">{fmtPrice(stopPrice)}</b>
              {lose !== null && <> · you lose <b className="tabular-nums text-[var(--down)]">{usd(lose)}</b></>}
            </>
          )
        }
      />
    </div>
  );
}

function Bar({
  label, tone, pct, max, step, onChange, badge, detail, warn,
}: {
  label: string;
  tone: 'up' | 'down';
  pct: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  badge: string;
  detail: React.ReactNode;
  warn?: boolean;
}) {
  const off = pct === 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.6px] text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            'text-[12.5px] font-semibold tabular-nums',
            off ? 'text-[var(--dim)]' : tone === 'up' ? 'text-[var(--up)]' : 'text-[var(--down)]',
          )}
        >
          {badge}
        </span>
      </div>

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
