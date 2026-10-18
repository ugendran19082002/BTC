import { Chip, Segmented } from '@/components/mobile/parts';
import type { WidenMode } from '@/types/signal-backtest';
import { NumberField } from '@/components/ui/number-field';
import { WIDEN_ATR_MAX } from '@/lib/backtest-tsl';
import { cn } from '@/lib/utils';

/**
 * The perp's SL and TGT widened with volatility, in the backtest and a run together (owner, 18 Oct 2026: "when the
 * signal comes, its PERP SL and PERP TGT are the least; as volatility rises the SL and TGT widen -- checked at every
 * 1m candle close"; asked, "stay at the widest so far"). After each closed 1m candle, each level is at least k ATR(14)s
 * of the 1m candles from the perp entry: never nearer than the signal's own, never brought back in. A touch inside a
 * minute is a hit then, at the level in force.
 *
 * When volatility falls again, kept at the widest (the default), or back to the signal's own once the 1m ATR is at or
 * under its level at the fill (owner, 18 Oct 2026: the two side by side in the report, `WidenCompare`).
 */
const PRESETS = [5, 10, 20, 30] as const;
/** The example: a BUY at 84,000 with the signal's SL 300 and TGT 500 away, the 1m ATR in a quiet hour and a busy one. */
const EX = { entry: 84_000, sl: 300, tgt: 500, quiet: 20, busy: 45 };
const px = (n: number) => Math.round(n).toLocaleString('en-US');

function Row({ label, value, onChange, name }: { label: string; value: number; onChange: (v: number) => void; name: string }) {
  const bad = !(value >= 0 && value <= WIDEN_ATR_MAX);
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <div role="group" aria-label={name} className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Chip on={value === 0} onClick={() => onChange(0)}>Signal&apos;s own</Chip>
        {PRESETS.map((k) => <Chip key={k} on={value === k} onClick={() => onChange(k)}>{k}× ATR</Chip>)}
        <NumberField label={`${name}, ATRs`} value={value} unit="× ATR" decimals={2} className="w-28" invalid={bad} onChange={onChange} />
      </div>
      {bad && <p role="alert" className="m-0 text-[12px] text-[var(--down)]">Widening with volatility is from 0 (off) to {WIDEN_ATR_MAX} ATRs.</p>}
    </div>
  );
}

export function BacktestPerpWiden({ sl, tgt, mode = 'widest', onChange, name = 'Perp SL & TGT by volatility' }: {
  sl: number; tgt: number; mode?: WidenMode;
  onChange: (v: { widenSlAtr: number; widenTgtAtr: number; widenMode: WidenMode }) => void;
  name?: string;
}) {
  const on = sl > 0 || tgt > 0;
  const put = (o: Partial<{ widenSlAtr: number; widenTgtAtr: number; widenMode: WidenMode }>) => onChange({ widenSlAtr: sl, widenTgtAtr: tgt, widenMode: mode, ...o });
  // The rule worked through: the level at each ATR -- the larger of the signal's distance and k ATRs.
  const at = (k: number, own: number, atr: number) => Math.max(own, k * atr);
  return (
    <section aria-label={name} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border border-solid border-border p-2.5">
      <span className="min-w-0">
        <span className="block text-[13.5px] font-medium text-foreground">{name}</span>
        <span className={cn('block text-[12px] leading-snug', on ? 'text-foreground' : 'text-muted-foreground')}>
          {on
            ? "The signal's own SL and TGT are the least. After each closed 1m candle, by its ATR(14): widened when volatility rises, kept at the widest when it falls. A touch inside a minute is a hit then -- it does not wait for the close."
            : "Off · the perp SL and TGT stay the signal's own."}
        </span>
      </span>
      <Row label="Perp SL at least, from the entry" name={`${name}: SL`} value={sl} onChange={(v) => put({ widenSlAtr: v })} />
      <Row label="Perp TGT at least, from the entry" name={`${name}: TGT`} value={tgt} onChange={(v) => put({ widenTgtAtr: v })} />
      {on && (
        <Segmented dense label={`${name}: when volatility falls again`} value={mode} onChange={(m) => put({ widenMode: m })}
          options={[
            { key: 'widest', label: 'Keep widest', spoken: 'Kept at the widest so far' },
            { key: 'calm', label: "Back to signal's own", spoken: "Back to the signal's own once the 1m ATR is at or under its level at the fill" },
          ]} />
      )}
      {on && (
        <p aria-label={`${name} example`} className="m-0 text-[11.5px] leading-snug text-muted-foreground">
          A BUY at {px(EX.entry)}, the signal&apos;s SL {px(EX.entry - EX.sl)} and TGT {px(EX.entry + EX.tgt)}.
          {' '}Quiet, 1m ATR {EX.quiet}: SL {px(EX.entry - (sl > 0 ? at(sl, EX.sl, EX.quiet) : EX.sl))}, TGT {px(EX.entry + (tgt > 0 ? at(tgt, EX.tgt, EX.quiet) : EX.tgt))}.
          {' '}Busy, ATR {EX.busy}: SL {px(EX.entry - (sl > 0 ? at(sl, EX.sl, EX.busy) : EX.sl))}, TGT {px(EX.entry + (tgt > 0 ? at(tgt, EX.tgt, EX.busy) : EX.tgt))}
          {mode === 'calm'
            ? <> -- and once the ATR is back to {EX.quiet}, its level at the fill, SL {px(EX.entry - EX.sl)} and TGT {px(EX.entry + EX.tgt)} again.</>
            : ' -- and there they stay when it calms.'}
        </p>
      )}
    </section>
  );
}
