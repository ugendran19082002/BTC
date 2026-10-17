import { NumberField } from '@/components/ui/number-field';
import { Switch } from '@/components/ui/switch';
import { Segmented } from '@/components/strategy/form-parts';
import { cn } from '@/lib/utils';
import { DEFAULT_DELTA_BY_VOL, type DeltaByVol } from '@/types/strategy';

/**
 * Delta by volatility in the signal strategy form (owner, 17 Oct 2026: "the backtest's logic in the signal strategy
 * form -- by ATR 2h or by ATM IV, one at a time, ATM IV to begin with -- best practice, user friendly").
 *
 * On, each signal's strike is picked with the delta of the level it is at when it fills -- read as the backtest reads
 * it, so a backtest by this strategy is what the desk does. A level that cannot be read keeps the strategy's own
 * delta. Off by default; nothing changes until it is switched on and saved.
 */
const LEVELS = [
  { k: 'low', label: 'Low', hint: 'calm' },
  { k: 'medium', label: 'Normal', hint: 'usual' },
  { k: 'high', label: 'High', hint: 'volatile' },
] as const;
/** The Low delta above which the measuring found the losses began (1-17 Oct 2026, the live strategies). */
const LOW_SAFE_MAX = 0.19;

export function DeltaByVolFields({ value, onChange, ownDelta, byDelta, hasBlocks, buying, live, onPickByDelta, error }: {
  value: DeltaByVol | null | undefined;
  onChange: (v: DeltaByVol) => void;
  /** The strategy's own delta: what an unknown level keeps. Null with no delta rule. */
  ownDelta: number | null;
  /** The strike is picked by delta: what this sets one number of. */
  byDelta: boolean;
  hasBlocks: boolean;
  buying: boolean;
  /** Live orders on: a change reaches real orders from the next signal. */
  live: boolean;
  /** Turn the strike rule to delta, for a strategy picked by something else. */
  onPickByDelta: () => void;
  error?: string | null;
}) {
  const v = value ?? DEFAULT_DELTA_BY_VOL;
  const set = <K extends keyof DeltaByVol>(k: K, x: DeltaByVol[K]) => onChange({ ...v, [k]: x });
  const measured = v.low === DEFAULT_DELTA_BY_VOL.low && v.medium === DEFAULT_DELTA_BY_VOL.medium && v.high === DEFAULT_DELTA_BY_VOL.high;
  const by = v.by === 'atr' ? 'ATR 2h' : 'ATM IV';
  const blocked = buying ? 'For a strategy that sells: a bought option is not picked this way.'
    : !byDelta ? 'It sets the delta, so the strike must be picked by delta.'
      : hasBlocks ? 'It sets the delta for the whole window: the strike blocks would be set aside. Remove them to use it.' : null;
  return (
    <section aria-label="Delta by volatility" className={cn('mt-3 rounded-lg border border-solid px-2.5 py-1.5', v.on ? 'border-[var(--accent)]' : 'border-border')}>
      <Switch
        label="Delta by volatility"
        description={v.on
          ? `On — each signal sells the strike its level allows, read by ${by} when it fills.`
          : 'Off — every signal at the strategy\'s own delta.'}
        checked={v.on}
        onCheckedChange={(on) => set('on', on)}
      />
      {v.on && (
        <div className="grid min-w-0 gap-2.5 pb-2">
          {/* One source at a time: the two read different things, and a strategy is traded by one. */}
          <div>
            <div className="mb-1 text-[12px] text-muted-foreground">Volatility by</div>
            <Segmented label="volatility by" value={v.by} onChange={(x) => set('by', x)}
              options={[
                { v: 'iv', label: 'ATM IV', note: 'What the market prices the move at: the at-the-money implied volatility against the same hour of the five expiry days before (thirds). Did best when measured.' },
                { v: 'atr', label: 'ATR 2h', note: 'How far BTC has moved: the last two hours of 15-minute candles against the five expiry days before (under 0.8× low, over 1.3× high).' },
              ]} />
          </div>
          <div>
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 text-[12px] text-muted-foreground">
              <span>The most delta a strike sold may have</span>
              {!measured && (
                <button type="button" onClick={() => onChange({ ...v, low: DEFAULT_DELTA_BY_VOL.low, medium: DEFAULT_DELTA_BY_VOL.medium, high: DEFAULT_DELTA_BY_VOL.high })}
                  className="m-0 min-h-[32px] appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)]">
                  Use the measured 0.18 / 0.10 / 0.08
                </button>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2 max-[340px]:grid-cols-1">
              {LEVELS.map((l) => (
                <label key={l.k} className="flex min-w-0 flex-col gap-1">
                  <span className="text-[12.5px]"><b className="font-medium">{l.label}</b> <span className="text-muted-foreground">· {l.hint}</span></span>
                  <NumberField label={`delta in ${l.label.toLowerCase()} volatility`} value={v[l.k]} onChange={(n) => set(l.k, n)} unit="Δ" invalid={Boolean(error)} className="w-full" />
                </label>
              ))}
            </div>
          </div>
          <p className="m-0 text-[12px] leading-snug text-muted-foreground">
            Each signal: <b className="font-medium text-foreground">low</b> sells the nearest strike with Δ ≤ {v.low.toFixed(2)}, <b className="font-medium text-foreground">normal</b> ≤ {v.medium.toFixed(2)},{' '}
            <b className="font-medium text-foreground">high</b> ≤ {v.high.toFixed(2)} — read by {by} when it fills, as the backtest reads it.
            {ownDelta !== null ? ` Not readable (no fresh reading): its own Δ ≤ ${ownDelta.toFixed(2)}.` : ''} Its other rules are as set.
          </p>
          {v.low > LOW_SAFE_MAX && (
            <p role="note" className="m-0 rounded-md border border-solid border-[var(--warn)]/40 bg-[var(--warn)]/10 px-2.5 py-2 text-[11.5px] leading-snug text-[var(--warn)]">
              Low over {LOW_SAFE_MAX.toFixed(2)}: in the measuring (1–17 Oct, the live strategies) losing days began at 0.20 — a calm market that breaks catches a strike this near the money.
            </p>
          )}
          {live && (
            <p role="note" className="m-0 rounded-md border border-solid border-[var(--down)]/40 bg-[var(--down)]/10 px-2.5 py-2 text-[11.5px] leading-snug text-foreground">
              Live orders are on: saved, this changes real orders from the next signal. It was measured over 17 days — run it with live orders off first.
            </p>
          )}
          {blocked && (
            <p role="alert" className="m-0 rounded-md border border-solid border-[var(--down)]/40 px-2.5 py-2 text-[12px] leading-snug text-[var(--down)]">
              {blocked}{' '}
              {!buying && !byDelta && (
                <button type="button" onClick={onPickByDelta}
                  className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] underline underline-offset-2">
                  Pick the strike by delta
                </button>
              )}
            </p>
          )}
        </div>
      )}
      {error && !blocked && <p role="alert" className="m-0 pb-1.5 text-[12px] text-[var(--down)]">{error}</p>}
    </section>
  );
}
