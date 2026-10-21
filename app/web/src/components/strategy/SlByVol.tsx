import { NumberField } from '@/components/ui/number-field';
import { Switch } from '@/components/ui/switch';
import { Segmented } from '@/components/strategy/form-parts';
import { cn } from '@/lib/utils';
import { DEFAULT_SL_BY_VOL, type SlByVol } from '@/types/strategy';

/**
 * SL by volatility in the signal strategy form (owner, 17 Oct 2026: "SL by volatility in the strategy form, as delta
 * -- Entry & exit"). On, each trade's option SL is the one of the level it is at when its signal fills, read as the
 * backtest reads it, and kept to its exit; a level that cannot be read keeps the strategy's own SL. With delta by
 * volatility on too, both read one source: one reading a signal, never "low" for the delta and "high" for the SL.
 */
const LEVELS = [
  { k: 'low', label: 'Low', hint: 'calm' },
  { k: 'medium', label: 'Normal', hint: 'usual' },
  { k: 'high', label: 'High', hint: 'volatile' },
] as const;
const pct = (share: number) => `+${Math.round(share * 100)}%`;

export function SlByVolFields({ value, onChange, ownStopPct, byPct, hasSteps, live, sharedWithDelta, onStopByPct, onDropSteps, error }: {
  value: SlByVol | null | undefined;
  onChange: (v: SlByVol) => void;
  /** The strategy's own SL as a share (0: none): what an unknown level keeps. */
  ownStopPct: number;
  /** The option SL is set by %: what this sets per level. */
  byPct: boolean;
  /** The SL has time steps: a trade's SL would move by the clock, and this holds one. */
  hasSteps: boolean;
  live: boolean;
  /** Delta by volatility is on: both read the one source, and a change of it here changes it there. */
  sharedWithDelta: boolean;
  onStopByPct: () => void;
  onDropSteps: () => void;
  error?: string | null;
}) {
  const v = value ?? DEFAULT_SL_BY_VOL;
  const set = <K extends keyof SlByVol>(k: K, x: SlByVol[K]) => onChange({ ...v, [k]: x });
  const by = v.by === 'atr' ? 'ATR 2h' : 'ATM IV';
  const defaults = v.low === DEFAULT_SL_BY_VOL.low && v.medium === DEFAULT_SL_BY_VOL.medium && v.high === DEFAULT_SL_BY_VOL.high;
  const blocked = !byPct ? 'It sets the option SL as a per cent of the premium: the SL is set in points or as a price now.'
      : hasSteps ? 'It holds one SL a trade, set at its signal: the SL\'s time steps would move it.' : null;
  return (
    <section aria-label="SL by volatility" className={cn('mt-3 rounded-lg border border-solid px-2.5 py-1.5', v.on ? 'border-[var(--accent)]' : 'border-border')}>
      <Switch
        label="SL by volatility"
        description={v.on
          ? `On — each trade gets the option SL of its level, read by ${by} when its signal fills, and keeps it to its exit.`
          : `Off — every trade at the strategy's own SL${ownStopPct > 0 ? ` (${pct(ownStopPct)})` : ''}.`}
        checked={v.on}
        onCheckedChange={(on) => set('on', on)}
      />
      {v.on && (
        <div className="grid min-w-0 gap-2.5 pb-2">
          <div>
            <div className="mb-1 text-[12px] text-muted-foreground">Volatility by{sharedWithDelta ? ' — the same as the delta by volatility' : ''}</div>
            <Segmented label="SL volatility by" value={v.by} onChange={(x) => set('by', x)}
              options={[
                { v: 'iv', label: 'ATM IV', note: 'What the market prices the move at: the at-the-money implied volatility against the same hour of the five expiry days before (thirds).' },
                { v: 'atr', label: 'ATR 2h', note: 'How far BTC has moved: the last two hours of 15-minute candles against the five expiry days before (under 0.8× low, over 1.3× high).' },
              ]} />
            {sharedWithDelta && <p className="m-0 mt-1 text-[11.5px] text-muted-foreground">One reading a signal sets both the delta and the SL: changing it here changes it for the delta too.</p>}
          </div>
          <div>
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 text-[12px] text-muted-foreground">
              <span>The option SL, over the premium sold</span>
              {!defaults && (
                <button type="button" onClick={() => onChange({ ...v, low: DEFAULT_SL_BY_VOL.low, medium: DEFAULT_SL_BY_VOL.medium, high: DEFAULT_SL_BY_VOL.high })}
                  className="m-0 min-h-[32px] appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)]">
                  Use +250% / +200% / +150%
                </button>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2 max-[340px]:grid-cols-1">
              {LEVELS.map((l) => (
                <label key={l.k} className="flex min-w-0 flex-col gap-1">
                  <span className="text-[12.5px]"><b className="font-medium">{l.label}</b> <span className="text-muted-foreground">· {l.hint}</span></span>
                  <NumberField label={`SL in ${l.label.toLowerCase()} volatility, per cent`} value={Math.round(v[l.k] * 100)} decimals={0}
                    onChange={(n) => set(l.k, Math.round(n) / 100)} unitBefore="+" unit="%" invalid={Boolean(error)} className="w-full" />
                </label>
              ))}
            </div>
          </div>
          <p className="m-0 text-[12px] leading-snug text-muted-foreground">
            Each trade: <b className="font-medium text-foreground">low</b> buys back at {pct(v.low)} over the entry, <b className="font-medium text-foreground">normal</b> {pct(v.medium)},{' '}
            <b className="font-medium text-foreground">high</b> {pct(v.high)} — decided by {by} when its signal fills, as the backtest decides it, and kept to its exit.
            {` Not readable (no fresh reading): its own SL${ownStopPct > 0 ? `, ${pct(ownStopPct)}` : ' — none'}.`} The backstop at Delta and the desk&apos;s stop watch follow it.
          </p>
          {v.high > v.low && (
            <p role="note" className="m-0 rounded-md border border-solid border-[var(--warn)]/40 bg-[var(--warn)]/10 px-2.5 py-2 text-[11.5px] leading-snug text-[var(--warn)]">
              The high SL is wider than the low: over two years of settled chains the other way round did better — a leg that doubles on a volatile day goes on far more often (decision 0019).
            </p>
          )}
          {live && (
            <p role="note" className="m-0 rounded-md border border-solid border-[var(--down)]/40 bg-[var(--down)]/10 px-2.5 py-2 text-[11.5px] leading-snug text-foreground">
              Live orders are on: saved, this changes the SL of real orders from the next signal (trades open now keep theirs). Run it with live orders off first.
            </p>
          )}
          {blocked && (
            <p role="alert" className="m-0 rounded-md border border-solid border-[var(--down)]/40 px-2.5 py-2 text-[12px] leading-snug text-[var(--down)]">
              {blocked}{' '}
              {!byPct && (
                <button type="button" onClick={onStopByPct} className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] underline underline-offset-2">Set the SL by %</button>
              )}
              {byPct && hasSteps && (
                <button type="button" onClick={onDropSteps} className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] underline underline-offset-2">Remove the SL time steps</button>
              )}
            </p>
          )}
        </div>
      )}
      {error && !blocked && <p role="alert" className="m-0 pb-1.5 text-[12px] text-[var(--down)]">{error}</p>}
    </section>
  );
}
