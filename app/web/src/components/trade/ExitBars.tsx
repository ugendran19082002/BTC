import { Checkbox } from '@/components/ui/checkbox';
import { NumberField } from '@/components/ui/number-field';
import { price as fmtPrice, inr, usd, usdToInr } from '@/lib/format';
import { exitWords, type ExitLeg } from '@/lib/strategy-exits';
import {
  distanceOf, inputProblem, levelOf, switchMode, valueOf, type ExitInput, type TicketExitMode,
} from '@/lib/exit-input';
import { cn } from '@/lib/utils';

/**
 * The two exits, each behind a tick box, each a number you type.
 *
 * They were sliders, and a slider is the wrong control for a number somebody
 * already has in mind: "stop at 150%" took a dozen nudges, and the stop's bar
 * ended at 300% because a bar has to end somewhere. Now each is a box, read as
 * a percentage or as fixed points from the entry:
 *
 *   target  keep 80% of the premium        | 12 pts under the entry | at 4
 *   stop    buy back 150% above the entry  | 54 pts over it         | at 70
 *
 * The third, Price, is the level itself, read back as the distance it is:
 * "entry 16 + 54 pts (+338%)".
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
  /**
   * Why there is no stop, where the desk refused to place one.
   *
   * A fixed stop the entry overtook would have fired the moment it was placed,
   * so the engine leaves it off and says why. Different from a trade that
   * chose to run unprotected, and it reads differently.
   */
  exitProblem?: string | null;
  /**
   * Before the order fills: the levels are re-read off the price it actually
   * fills at, keeping the distance shown. Said once, under the exits.
   */
  followsFill?: boolean;
};

export function ExitBars({
  target, stop, onTarget, onStop, entry, size, liquidationPrice, contractValue = 0.001, followsFill = false,
  exitProblem = null,
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
        label={<Head title="Take profit" tone="up" x={target} sign="−" entry={entry} level={targetPrice} />}
      />
      {target.on && (
        <Row
          leg="target"
          x={target}
          entry={entry}
          onChange={onTarget}
          detail={
            valueOf(target) === 0 ? (
              <>{target.mode === 'price' ? 'Type the price to buy back at.' : 'Type how much of the premium to keep.'}</>
            ) : (
              <>
                Buys back at <b className="tabular-nums text-foreground">{fmtPrice(targetPrice)}</b>
                <Distance level={targetPrice} entry={entry} show={target.mode === 'price'} />
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
        label={<Head title="Stop loss" tone="down" x={stop} sign="+" entry={entry} level={stopPrice} />}
      />
      {stop.on ? (
        <Row
          leg="stop"
          x={stop}
          entry={entry}
          onChange={onStop}
          warn={stopPastCloseOut}
          detail={
            valueOf(stop) === 0 ? (
              <>{stop.mode === 'price' ? 'Type the price to stop at.' : 'Type how far it may go against you.'}</>
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
                <Distance level={stopPrice} entry={entry} show={stop.mode === 'price'} />
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
          {/*
            A stop that could not be placed is a different thing from a trade
            that chose to run without one, and it is the operator's to fix: the
            fill overtook the price they fixed, so the desk refused to place a
            "stop" that would have closed the trade a second after opening it.
          */}
          {exitProblem ? (
            <>
              <b className="text-[var(--down)]">No stop — {exitProblem}</b>{' '}
              The desk did not place it: it would have fired at once. Set a new one.
            </>
          ) : liquidationPrice != null ? (
            <>
              No stop — Delta liquidates the position at{' '}
              <b className="tabular-nums text-[var(--down)]">{fmtPrice(liquidationPrice)}</b>.
            </>
          ) : (
            <>No stop — the position runs until Delta liquidates it.</>
          )}
        </p>
      )}
      {followsFill && (target.on || stop.on) && (
        <p className="m-0 mt-1.5 pl-[26px] text-[11px] leading-snug text-[var(--dim)]">
          Shown against {entry !== null ? fmtPrice(entry) : 'the entry'}. If it fills at another price,{' '}
          {[target, stop].some((x) => x.on && x.mode !== 'price') && 'a % or Fixed exit moves with the fill and keeps its distance'}
          {[target, stop].some((x) => x.on && x.mode !== 'price') && [target, stop].some((x) => x.on && x.mode === 'price') && '; '}
          {[target, stop].some((x) => x.on && x.mode === 'price') && 'a Price stays where you typed it, and its balance is re-measured from the fill'}.
        </p>
      )}
    </div>
  );
}

/** "Take profit −80%" / "Stop loss +10 pts" / "Stop loss at 70" beside the box. */
function Head({ title, tone, x, sign, entry, level }: {
  title: string; tone: 'up' | 'down'; x: ExitInput; sign: string; entry: number | null; level: number | null;
}) {
  const v = valueOf(x);
  const d = x.mode === 'price' ? distanceOf(level, entry) : null;
  return (
    <span className="flex items-baseline gap-1.5">
      <span>{title}</span>
      {x.on && v > 0 && (
        <span className={cn('text-[12px] font-semibold tabular-nums', tone === 'up' ? 'text-[var(--up)]' : 'text-[var(--down)]')}>
          {x.mode === 'price' ? `at ${fmtPrice(level)}${d ? ` (${d.points > 0 ? '+' : ''}${d.points} pts)` : ''}` : `${sign}${exitWords(x.mode, v)}`}
        </span>
      )}
    </span>
  );
}

/**
 * "entry 16 → 70 · +54 pts (+338%)": the typed price read back as the
 * distance it is, so a level and a move are never confused.
 */
function Distance({ level, entry, show }: { level: number | null; entry: number | null; show: boolean }) {
  const d = show ? distanceOf(level, entry) : null;
  if (!d || entry === null) return null;
  return (
    <span className="text-[var(--dim)] tabular-nums">
      {' '}· entry {fmtPrice(entry)} {d.points > 0 ? '+' : '−'} {Math.abs(d.points)} pts ({d.pct > 0 ? '+' : ''}{d.pct}%)
    </span>
  );
}

const UNIT: Record<TicketExitMode, { word: string; unit?: string }> = {
  pct: { word: 'percent', unit: '%' },
  points: { word: 'points', unit: 'pts' },
  price: { word: 'price' },
};

function Row({
  leg, x, entry, onChange, detail, warn,
}: {
  leg: ExitLeg;
  x: ExitInput;
  entry: number | null;
  onChange: (patch: Partial<ExitInput>) => void;
  detail: React.ReactNode;
  warn?: boolean;
}) {
  const name = leg === 'target' ? 'target' : 'stop';
  const problem = inputProblem(leg, x, entry);
  const shown = x.mode === 'pct' ? x.pct * 100 : x.mode === 'points' ? x.points : x.price;
  return (
    <div className="pl-[26px]">
      <div className="flex items-center gap-2">
        <NumberField
          label={`${name} ${UNIT[x.mode].word}`}
          value={shown}
          onChange={(n) => onChange(x.mode === 'pct' ? { pct: n / 100 } : x.mode === 'points' ? { points: n } : { price: n })}
          unit={UNIT[x.mode].unit}
          unitBefore={x.mode === 'price' ? '@' : undefined}
          invalid={Boolean(problem)}
          className="w-28 flex-none"
        />
        <ModeSwitch name={name} mode={x.mode} onChange={(mode) => onChange(switchMode(leg, x, mode, entry))} />
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

/** Percent, fixed points, or the price itself; each keeps its own number, so switching back finds it. */
function ModeSwitch({ name, mode, onChange }: { name: string; mode: TicketExitMode; onChange: (m: TicketExitMode) => void }) {
  return (
    <div role="radiogroup" aria-label={`${name} by`} className="flex gap-0.5 rounded-md bg-muted p-0.5">
      {(['pct', 'points', 'price'] as const).map((m) => (
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
          {m === 'pct' ? '%' : m === 'points' ? 'Fixed' : 'Price'}
        </button>
      ))}
    </div>
  );
}
