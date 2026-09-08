import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A number field with the spinner arrows gone.
 *
 * The arrows are a trap on a trading screen: they are one pixel from the field
 * and they change a price by a whole unit per click. Size is stepped with the
 * buttons beside the field instead, where the step is stated.
 */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-md border border-border bg-muted px-2.5 text-[14px] text-foreground',
        'font-[inherit] tabular-nums outline-none transition-colors',
        'placeholder:text-[var(--dim)]',
        'focus-visible:border-[var(--accent)] focus-visible:ring-1 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
