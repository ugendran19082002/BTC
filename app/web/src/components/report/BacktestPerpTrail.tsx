import { Chip } from '@/components/mobile/parts';
import { NumberField } from '@/components/ui/number-field';
import { cn } from '@/lib/utils';

/**
 * The perp's own SL and target trailed by volatility, in the backtest and a run together (owner, 18 Oct 2026:
 * "trailing perp SL ATR multiplier and trailing perp TGT ATR multiplier -- on the 1m candle close and ATR(14); never
 * loosen the SL; a hit does not wait for the candle close"). After each closed 1m candle: the SL k ATRs behind the
 * close where that is tighter, the target k ATRs beyond it where that is further. Between closes the levels stand,
 * and a touch inside a minute is a hit then.
 */
const PRESETS = [1, 2, 3, 5] as const;
export const TRAIL_ATR_MAX = 20;

function Row({ label, value, onChange, name }: { label: string; value: number; onChange: (v: number) => void; name: string }) {
  const bad = !(value >= 0 && value <= TRAIL_ATR_MAX);
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <div role="group" aria-label={name} className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Chip on={value === 0} onClick={() => onChange(0)}>Off</Chip>
        {PRESETS.map((k) => <Chip key={k} on={value === k} onClick={() => onChange(k)}>{k}× ATR</Chip>)}
        <NumberField label={`${name}, ATRs`} value={value} unit="× ATR" decimals={2} className="w-28" invalid={bad} onChange={onChange} />
      </div>
      {bad && <p role="alert" className="m-0 text-[12px] text-[var(--down)]">A perp trail is from 0 (off) to {TRAIL_ATR_MAX} ATRs.</p>}
    </div>
  );
}

export function BacktestPerpTrail({ sl, tgt, onChange, name = 'Perp trail' }: {
  sl: number; tgt: number;
  onChange: (v: { trailSlAtr: number; trailTgtAtr: number }) => void;
  name?: string;
}) {
  const on = sl > 0 || tgt > 0;
  return (
    <section aria-label={name} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border border-solid border-border p-2.5">
      <span className="min-w-0">
        <span className="block text-[13.5px] font-medium text-foreground">{name} <span className="font-normal text-muted-foreground">(by ATR)</span></span>
        <span className={cn('block text-[12px] leading-snug', on ? 'text-foreground' : 'text-muted-foreground')}>
          {on
            ? 'After each closed 1m candle, by its ATR(14): the perp SL only ever tightened, the TGT only ever moved further. A touch inside a minute is a hit then -- it does not wait for the close.'
            : "Off · the perp SL and TGT stay the signal's own."}
        </span>
      </span>
      <Row label="Trail the perp SL, behind the close" name={`${name}: SL`} value={sl} onChange={(v) => onChange({ trailSlAtr: v, trailTgtAtr: tgt })} />
      <Row label="Trail the perp TGT, beyond the close" name={`${name}: TGT`} value={tgt} onChange={(v) => onChange({ trailSlAtr: sl, trailTgtAtr: v })} />
      {tgt > 0 && sl === 0 && (
        <p className="m-0 text-[12px] leading-snug text-[var(--warn)]">A target that keeps moving with no trailing SL can give a whole run back: the signal&apos;s own SL is the only stop.</p>
      )}
      {on && <p className="m-0 text-[11.5px] leading-snug text-[var(--dim)]">An SL hit after it moved is counted as <b className="font-medium text-foreground">Perp TSL</b>; the trade list shows where each level ended.</p>}
    </section>
  );
}
