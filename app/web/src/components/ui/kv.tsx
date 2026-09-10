import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A label on the left, its value on the right. Used inside a <dl>.
 *
 * `hint` becomes a tooltip and underlines the label, so there is a visible
 * sign that it explains itself.
 */
export function KV({ label, children, hint, valueLabel, className }: {
  label: React.ReactNode;
  children: React.ReactNode;
  hint?: string;
  /** An accessible name for the value, for a test or a screen reader. */
  valueLabel?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 items-baseline justify-between gap-3', className)}>
      <dt
        className={cn(
          'm-0 min-w-0 text-[12.5px] text-muted-foreground',
          hint && 'cursor-help underline decoration-dotted underline-offset-2',
        )}
        title={hint}
      >
        {label}
      </dt>
      <dd className="m-0 flex-none text-right text-[13px] tabular-nums text-foreground" aria-label={valueLabel}>
        {children}
      </dd>
    </div>
  );
}
