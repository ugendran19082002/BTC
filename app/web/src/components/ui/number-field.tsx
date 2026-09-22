import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * A number typed, not dragged.
 *
 * Holds its own text while it has focus, so "82." and "0.5" can be typed on
 * the way to 82.5 -- a field that rewrote itself from the number on every
 * keystroke turned "82." straight back into "82" and the decimal could never
 * be typed. The number goes out as soon as the text is one; blank goes out
 * as `empty` (0 unless said otherwise).
 *
 * No `max` of its own: the rules say what is too large, beside the field,
 * where a clamp would have changed the number without a word.
 */
export function NumberField({
  value, onChange, label, unit, unitBefore, empty = 0, decimals = 2, className, invalid, disabled,
}: {
  value: number;
  onChange: (n: number) => void;
  /** Read by screen readers. */
  label: string;
  /** Shown inside the right edge: "%", "pts", "h". */
  unit?: string;
  /** Shown inside the left edge: "$". */
  unitBefore?: string;
  empty?: number;
  decimals?: number;
  className?: string;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const shown = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 10 ** decimals) / 10 ** decimals) : '');
  const [text, setText] = useState(shown(value));
  const focused = useRef(false);

  // Follow the value from outside -- a quick-fix, a mode switch -- but never
  // while it is being typed into.
  useEffect(() => {
    if (!focused.current) setText(shown(value));
  }, [value]);

  return (
    <div className={cn('relative h-9 self-start', className)}>
      {unitBefore && (
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">{unitBefore}</span>
      )}
      <Input
        value={text}
        aria-label={label}
        aria-invalid={invalid || undefined}
        inputMode="decimal"
        disabled={disabled}
        className={cn('w-full tabular-nums', unit && 'pr-9', unitBefore && 'pl-5', invalid && 'border-[var(--down)]')}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; setText(shown(value)); }}
        onChange={(e) => {
          const t = e.target.value.replace(',', '.');
          if (!/^\d*\.?\d*$/.test(t)) return;          // digits and one point, nothing else
          setText(t);
          if (t === '' || t === '.') onChange(empty);
          else onChange(Number(t));
        }}
      />
      {unit && (
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">{unit}</span>
      )}
    </div>
  );
}
